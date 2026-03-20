/**
 * DevTools Commands – Development, CI, analysis, and evolution tools.
 *
 * Commands:
 *   /gc              – Run entropy GC scan
 *   /metrics         – Show workflow session metrics
 *   /ci              – Run local CI pipeline or poll remote CI
 *   /graph           – Build or query the structured code graph
 *   /trends          – Show cross-session metrics trends
 *   /skill-enrich    – Enrich a skill with external knowledge
 *   /skill-enrich-all – Batch-enrich all (or hollow-only) skills
 *   /report          – Generate HTML session report
 *   /article-scout   – Search, evaluate, and extract knowledge from articles
 *   /deep-audit      – Run comprehensive deep audit
 *   /evolve          – One-click self-evolution
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../core/constants');

/**
 * Registers devtools commands into the shared command registry.
 *
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerDevToolsCommands(registerCommand) {

registerCommand(
  'gc',
  'Run entropy GC scan: detect architectural drift, oversized files, stale docs. [--path <dir>]',
  async (args, context) => {
    const { EntropyGC } = require('../core/entropy-gc');
    const { PATHS }     = require('../core/constants');

    // Allow --path override for scanning a different project root
    const pathMatch  = args.match(/--path\s+(\S+)/);
    const projectRoot = pathMatch
      ? path.resolve(pathMatch[1])
      : (context.orchestrator?.projectRoot || path.resolve(__dirname, '..', '..'));

    // Inherit config from orchestrator if available
    const cfg = context.orchestrator?._config || {};

    const gc = new EntropyGC({
      projectRoot,
      outputDir:  PATHS.OUTPUT_DIR,
      extensions: cfg.sourceExtensions,
      ignoreDirs: cfg.ignoreDirs,
      maxLines:   cfg.maxLines,
      docPaths:   cfg.docPaths || [],
    });

    try {
      const result = await gc.run();
      const icon   = result.violations === 0 ? '✅' : result.details?.high > 0 ? '🔴' : '🟡';
      return [
        `${icon} **Entropy GC Scan Complete**`,
        ``,
        `- Files scanned: **${result.filesScanned}**`,
        `- Violations: **${result.violations}** total`,
        `  - 🔴 High: ${result.details?.high || 0}`,
        `  - 🟡 Medium: ${result.details?.medium || 0}`,
        `  - 🟢 Low: ${result.details?.low || 0}`,
        ``,
        result.reportPath ? `📄 Full report: \`${result.reportPath}\`` : '',
        ``,
        result.violations > 0
          ? `> Run \`/gc\` again after fixing violations to verify clean state.`
          : `> Codebase is clean. No architectural drift detected.`,
      ].filter(l => l !== undefined).join('\n');
    } catch (err) {
      return `❌ Entropy GC failed: ${err.message}`;
    }
  }
);

registerCommand(
  'metrics',
  'Show the last workflow session metrics from output/run-metrics.json',
  async (_args, context) => {
    const { PATHS } = require('../core/constants');
    const metricsPath = path.join(PATHS.OUTPUT_DIR, 'run-metrics.json');

    if (!fs.existsSync(metricsPath)) {
      return `No metrics found. Run a workflow first to generate \`output/run-metrics.json\`.`;
    }

    let m;
    try {
      m = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
    } catch (err) {
      return `❌ Failed to read metrics: ${err.message}`;
    }

    const lines = [
      `## 📊 Last Workflow Session Metrics`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Session | \`${m.sessionId}\` |`,
      `| Started | ${m.startedAt} |`,
      `| Duration | ${((m.totalDurationMs || 0) / 1000).toFixed(1)}s |`,
      `| LLM Calls | ${m.llm?.totalCalls || 0} |`,
      `| Tokens (est.) | ~${(m.llm?.totalTokensEst || 0).toLocaleString()} |`,
      `| Errors | ${m.errors?.count || 0} |`,
      ``,
    ];

    // Stage breakdown
    if (m.stages?.length > 0) {
      lines.push(`### Stage Timings`);
      lines.push(`| Stage | Duration | Status |`);
      lines.push(`|-------|----------|--------|`);
      for (const s of m.stages) {
        const dur  = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
        const icon = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️';
        lines.push(`| ${s.name} | ${dur} | ${icon} ${s.status} |`);
      }
      lines.push(``);
    }

    // Test result
    if (m.testResult) {
      const t    = m.testResult;
      const icon = t.failed === 0 ? '✅' : '❌';
      lines.push(`### Test Results`);
      lines.push(`${icon} ${t.passed} passed / ${t.failed} failed / ${t.skipped} skipped (${t.rounds} round(s))`);
      lines.push(``);
    }

    // Entropy result
    if (m.entropyResult) {
      const e    = m.entropyResult;
      const icon = e.violations === 0 ? '✅' : '⚠️';
      lines.push(`### Entropy GC`);
      lines.push(`${icon} ${e.violations} violation(s) in ${e.filesScanned} files scanned`);
      lines.push(``);
    }

    return lines.join('\n');
  }
);

registerCommand(
  'ci',
  'Run local CI pipeline (lint + test + entropy) or poll remote CI status. [--wait] [--lint-only] [--poll]',
  async (args, context) => {
    const { CIIntegration } = require('../core/ci-integration');
    const cfg = context.orchestrator?._config || {};
    const projectRoot = context.orchestrator?.projectRoot || path.resolve(__dirname, '..', '..');

    const ci = new CIIntegration({
      projectRoot,
      lintCommand: cfg.lintCommand || null,
      testCommand: cfg.testCommand || null,
    });

    // --poll: check remote CI status
    if (args.includes('--poll')) {
      const wait   = args.includes('--wait');
      const result = await ci.poll({ wait });
      const icon   = result.status === 'success' ? '✅' : result.status === 'failed' ? '❌' : '🔄';
      return [
        `${icon} **CI Status [${result.provider || ci._provider}]**: ${result.status}`,
        ``,
        result.message,
        result.runUrl   ? `🔗 [View Run](${result.runUrl})` : '',
        result.commitSha ? `📌 Commit: \`${result.commitSha}\`` : '',
      ].filter(Boolean).join('\n');
    }

    // Default: run local pipeline
    const skipLint = args.includes('--skip-lint');
    const skipTest = args.includes('--skip-test');
    const result   = await ci.runLocalPipeline({ skipLint, skipTest });

    const icon = result.status === 'success' ? '✅' : '❌';
    const lines = [
      `${icon} **Local CI Pipeline**: ${result.status}`,
      ``,
      `| Step | Status | Duration | Output |`,
      `|------|--------|----------|--------|`,
    ];
    for (const s of result.steps) {
      const sIcon = s.passed ? '✅' : '❌';
      const dur   = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
      lines.push(`| ${s.name} | ${sIcon} | ${dur} | ${(s.output || '').slice(0, 60).replace(/\n/g, ' ')} |`);
    }
    lines.push('');
    lines.push(result.message);
    return lines.join('\n');
  }
);

registerCommand(
  'graph',
  'Build or query the structured code graph. Usage: /graph [build] [search <keyword>] [file <path>] [calls <symbol>] [hotspot [N]] [reusable]',
  async (args, context) => {
    const { CodeGraph } = require('../core/code-graph');
    const { PATHS }     = require('../core/constants');
    const projectRoot   = context.orchestrator?.projectRoot || path.resolve(__dirname, '..', '..');
    const cfg           = context.orchestrator?._config || {};

    // P0 optimisation: reuse the orchestrator's shared CodeGraph instance for queries.
    // Only create a new instance for build commands (which need fresh config).
    const graph = context.orchestrator?.codeGraph || new CodeGraph({
      projectRoot,
      outputDir:      PATHS.OUTPUT_DIR,
      extensions:     cfg.sourceExtensions,
      ignoreDirs:     cfg.ignoreDirs,
      scopeDirs:      cfg.codeGraph?.scopeDirs,
    });

    // /graph build – rebuild the index (supports --force for full rebuild)
    if (!args || args.trim() === '' || args.includes('build')) {
      const forceRebuild = args && args.includes('--force');
      const result = await graph.build({ incremental: !forceRebuild, force: forceRebuild });
      const modeLabel = result.incremental
        ? `🔄 Incremental (${result.changedFiles} changed)`
        : '🔨 Full rebuild';
      return [
        `✅ **Code Graph Built**`,
        ``,
        `- Mode:            **${modeLabel}**`,
        `- Symbols indexed: **${result.symbolCount}**`,
        `- Files scanned:   **${result.fileCount}**`,
        `- Call edges:      **${result.edgeCount}**`,
        ``,
        `📄 Index: \`output/code-graph.json\``,
        `📄 Summary: \`output/code-graph.md\``,
        ``,
        `> Use \`/graph search <keyword>\` to query the index.`,
        `> Use \`/graph hotspot\` to view hotspot analysis.`,
        `> Use \`/graph reusable\` to see recommended reusable symbols.`,
        `> Use \`/graph build --force\` to force a full rebuild.`,
      ].join('\n');
    }

    // Load existing graph from disk for queries.
    // P1 optimisation: use _loadFromDisk() which benefits from process-level cache,
    // instead of manually reading and parsing the JSON file (which bypassed the cache).
    const loadGraph = () => {
      if (graph._symbols.size > 0) return true;  // Already loaded (e.g. from orchestrator instance)
      graph._loadFromDisk();
      return graph._symbols.size > 0 ? true : null;
    };

    // /graph search <keyword>
    const searchMatch = args.match(/search\s+(.+)/);
    if (searchMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const results = graph.search(searchMatch[1].trim(), { limit: 15 });
      if (results.length === 0) return `No symbols found matching "${searchMatch[1]}".`;
      const lines = [`## 🔍 Code Graph Search: "${searchMatch[1]}" (${results.length} results)\n`];
      for (const s of results) {
        // search() now auto-enriches results (P2 hardening), no manual call needed
        // P1: Check LSP cache for compiler-accurate type info
        const lspData = graph._lspCache?.get(s.id);
        const calls = (graph._callEdges.get(s.id) || []).length;
        const sig = s.signature ? ` \`${s.signature}\`` : '';
        const ctorSig = s._constructorSignature ? ` 🔨 \`${s._constructorSignature}\`` : '';
        const ext = s._extends && s._extends.length > 0 ? ` ← ${s._extends.join(', ')}` : '';
        const summary = s.summary ? `\n  > ${s.summary}` : (s._inferredSummary ? `\n  > _${s._inferredSummary}_` : '');
        const lspType = lspData?.typeInfo ? `\n  > 🔬 **LSP**: \`${lspData.typeInfo}\`` : '';
        // P0: Show importance weight badge for highly-referenced symbols
        const iw = graph.getImportanceWeight ? graph.getImportanceWeight(s.id) : 0;
        const iwBadge = iw > 0.3 ? ` ⭐${Math.round(iw * 100)}%` : '';
        lines.push(`- \`${s.kind}\` **${s.name}**${sig}${ctorSig} in \`${s.file}\`:${s.line}${ext}${iwBadge}${calls ? ` → ${calls} call(s)` : ''}${summary}${lspType}`);
      }
      return lines.join('\n');
    }

    // /graph file <path>
    const fileMatch = args.match(/file\s+(.+)/);
    if (fileMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const results = graph.getFileSymbols(fileMatch[1].trim());
      if (results.length === 0) return `No symbols found in files matching "${fileMatch[1]}".`;
      const lines = [`## 📄 Symbols in \`${fileMatch[1]}\` (${results.length})\n`];
      for (const s of results) {
        lines.push(`- \`${s.kind}\` **${s.name}**${s.signature ? `(${s.signature})` : ''} :${s.line}${s.summary ? ` // ${s.summary}` : ''}`);
      }
      return lines.join('\n');
    }

    // /graph calls <symbol>
    const callsMatch = args.match(/calls\s+(.+)/);
    if (callsMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const { calls, calledBy } = graph.getCallGraph(callsMatch[1].trim());
      const lines = [`## 📞 Call Graph: \`${callsMatch[1]}\`\n`];
      lines.push(`**Calls** (${calls.length}): ${calls.length ? calls.join(', ') : '_none_'}`);
      lines.push(`**Called by** (${calledBy.length}): ${calledBy.length ? calledBy.join(', ') : '_none_'}`);
      return lines.join('\n');
    }

    // /graph hotspot [N] – show hotspot analysis (top referenced symbols)
    const hotspotMatch = args.match(/hotspot(?:\s+(\d+))?/);
    if (hotspotMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const topN = hotspotMatch[1] ? parseInt(hotspotMatch[1], 10) : 20;
      return graph.hotspotsAsMarkdown(topN);
    }

    // /graph reusable – show reusable symbol recommendations
    const reusableMatch = args.match(/reusable|reuse/);
    if (reusableMatch) {
      const data = loadGraph();
      if (!data) return '❌ No code graph found. Run `/graph build` first.';
      const digest = graph.getReusableSymbolsDigest({ maxItems: 20 });
      if (!digest) return '_No reusable symbols found. Build the graph with more files._';
      return digest;
    }

    return `Usage: \`/graph build\` | \`/graph search <keyword>\` | \`/graph file <path>\` | \`/graph calls <symbol>\` | \`/graph hotspot [N]\` | \`/graph reusable\``;
  }
);

registerCommand(
  'trends',
  'Show cross-session metrics trends from metrics-history.jsonl',
  async (_args, _context) => {
    const { Observability } = require('../core/observability');
    const { PATHS }         = require('../core/constants');

    const history = Observability.loadHistory(PATHS.OUTPUT_DIR);
    if (history.length === 0) {
      return `No history found. Run at least one workflow session to generate \`output/metrics-history.jsonl\`.`;
    }

    const trends = Observability.computeTrends(history);
    const trendIcon = (t) => t === 'increasing' ? '📈' : t === 'decreasing' ? '📉' : '➡️ ';

    const lines = [
      `## 📊 Cross-Session Metrics Trends`,
      ``,
      `> Based on **${trends.sessionCount}** sessions | Last: ${trends.lastSession?.slice(0, 10) || '–'}`,
      ``,
      `| Metric | Average | Trend |`,
      `|--------|---------|-------|`,
      `| Duration | ${(trends.avgDurationMs / 1000).toFixed(1)}s | ${trendIcon(trends.durationTrend)} ${trends.durationTrend} |`,
      `| Tokens (est.) | ~${trends.avgTokensEst.toLocaleString()} | ${trendIcon(trends.tokenTrend)} ${trends.tokenTrend} |`,
      `| Errors | ${trends.avgErrorCount} | ${trendIcon(trends.errorTrend)} ${trends.errorTrend} |`,
      `| Entropy violations | ${trends.avgEntropyViolations} | ${trendIcon(trends.entropyTrend)} ${trends.entropyTrend} |`,
    ];

    if (trends.ciSuccessRate != null) {
      lines.push(`| CI Success Rate | ${(trends.ciSuccessRate * 100).toFixed(0)}% | – |`);
    }

    lines.push('');
    lines.push(`### Recent Sessions (last 5)`);
    lines.push(`| Session | Date | Duration | Tokens | Errors | CI |`);
    lines.push(`|---------|------|----------|--------|--------|----|`);
    for (const h of history.slice(0, 5)) {
      const dur = h.totalDurationMs ? `${(h.totalDurationMs / 1000).toFixed(1)}s` : '–';
      const ci  = h.ciStatus ? (h.ciStatus === 'success' ? '✅' : '❌') : '–';
      lines.push(`| \`${h.sessionId?.slice(-12) || '?'}\` | ${h.startedAt?.slice(0, 10) || '–'} | ${dur} | ~${(h.tokensEst || 0).toLocaleString()} | ${h.errorCount || 0} | ${ci} |`);
    }

    return lines.join('\n');
  }
);

registerCommand(
  'skill-enrich',
  'Enrich a skill with external knowledge (web search → LLM analysis → native skill content). Usage: /skill-enrich <skill-name> [--dry-run]',
  async (args, context) => {
    if (!args || !args.trim()) {
      // List skills that are candidates for enrichment (placeholder/empty)
      const { SkillEvolutionEngine } = require('../core/skill-evolution');
      const skillsDir = PATHS.SKILLS_DIR;
      const registryPath = path.join(PATHS.OUTPUT_DIR, 'skill-registry.json');

      let engine;
      if (context.orchestrator && context.orchestrator.services && context.orchestrator.services.has('skillEvolution')) {
        engine = context.orchestrator.services.resolve('skillEvolution');
      } else {
        engine = new SkillEvolutionEngine(skillsDir, registryPath);
      }

      const skills = engine.listSkills();
      const candidates = [];
      for (const s of skills) {
        if (s.retiredAt) continue;
        if (fs.existsSync(s.filePath)) {
          const content = fs.readFileSync(s.filePath, 'utf-8');
          const lines = content.split('\n');
          const bodyLines = lines.filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|') && !l.startsWith('---') && !l.includes('_No '));
          const bodyWords = bodyLines.join(' ').split(/\s+/).filter(w => w.length > 0).length;

          // ADR-30 P2: Multi-dimensional hollow skill detection
          // Instead of relying solely on word count, use section fill-rate as primary indicator.
          // A skill file has expected sections: Rules, Anti-Patterns, Gotchas, Best Practices, Context Hints.
          const expectedSections = ['Rules', 'Anti-Patterns', 'Gotchas', 'Best Practices', 'Context Hints'];
          let filledSections = 0;
          for (const sec of expectedSections) {
            const secRegex = new RegExp(`^##\\s+.*${sec.replace(/-/g, '[- ]')}`, 'im');
            const secMatch = content.match(secRegex);
            if (secMatch) {
              // Check if the section has actual content (not just a header + placeholder)
              const secIdx = content.indexOf(secMatch[0]);
              const afterHeader = content.slice(secIdx + secMatch[0].length, secIdx + secMatch[0].length + 200);
              const sectionContent = afterHeader.split(/^##\s/m)[0].trim();
              const sectionWords = sectionContent.split(/\s+/).filter(w => w.length > 1 && !w.startsWith('_No')).length;
              if (sectionWords >= 10) filledSections++;
            }
          }
          const fillRate = filledSections / expectedSections.length;

          // Candidate if: low word count OR low section fill-rate
          const isHollow = bodyWords < 30 || fillRate < 0.4;
          if (isHollow) {
            candidates.push({
              name: s.name,
              words: bodyWords,
              fillRate: Math.round(fillRate * 100),
              filledSections,
              domains: (s.domains || []).join(', '),
            });
          }
        }
      }

      const lines = [
        `## 🌐 Skill Enrichment`,
        ``,
        `Usage: \`/skill-enrich <skill-name>\` — Enriches a skill with external knowledge`,
        `       \`/skill-enrich <skill-name> --dry-run\` — Preview without writing`,
        ``,
      ];

      if (candidates.length > 0) {
        lines.push(`### Enrichment Candidates (${candidates.length} skills with thin content):`);
        lines.push(`| Skill | Words | Fill Rate | Sections | Domains |`);
        lines.push(`|-------|-------|-----------|----------|---------|`);
        for (const c of candidates.sort((a, b) => a.fillRate - b.fillRate || a.words - b.words)) {
          lines.push(`| ${c.name} | ${c.words} | ${c.fillRate}% | ${c.filledSections}/5 | ${c.domains || 'general'} |`);
        }
      } else {
        lines.push(`✅ All skills have substantial content. No enrichment candidates found.`);
      }
      return lines.join('\n');
    }

    // Parse arguments
    const parts = args.trim().split(/\s+/);
    const skillName = parts[0];
    const dryRun = parts.includes('--dry-run');

    if (!context.orchestrator) {
      return `❌ No orchestrator in context. Cannot perform enrichment (needs WebSearch + LLM).`;
    }

    const { enrichSkillFromExternalKnowledge } = require('../core/context-budget-manager');

    const result = await enrichSkillFromExternalKnowledge(context.orchestrator, skillName, { dryRun });

    if (!result.success) {
      return `❌ Enrichment failed for "${skillName}": ${result.error}`;
    }

    const lines = [
      `## 🌐 Skill Enrichment ${dryRun ? '(Dry Run)' : 'Complete'}`,
      ``,
      `**Skill**: ${skillName}`,
      `**Entries added**: ${result.sectionsAdded}`,
      `**Sources**: ${(result.sources || []).length} web page(s)`,
      ``,
    ];

    if (result.sources && result.sources.length > 0) {
      lines.push(`### Sources:`);
      for (const src of result.sources) {
        lines.push(`- ${src}`);
      }
    }

    if (dryRun) {
      lines.push(``, `> 💡 This was a dry run. Run \`/skill-enrich ${skillName}\` (without --dry-run) to apply.`);
    } else {
      lines.push(``, `> ✅ Knowledge has been persisted to \`skills/${skillName}.md\`. Capsule Inheritance prevents duplicates.`);
    }

    return lines.join('\n');
  }
);

// ── Batch Skill Enrichment ───────────────────────────────────────────────────
registerCommand(
  'skill-enrich-all',
  'Batch-enrich ALL skills (or optionally only hollow/thin ones). Usage: /skill-enrich-all [--hollow-only] [--dry-run] [--concurrency=N]',
  async (args, context) => {
    if (!context.orchestrator) {
      return `❌ No orchestrator in context. Cannot perform enrichment (needs WebSearch + LLM).`;
    }

    const flags = (args || '').trim().split(/\s+/);
    const hollowOnly = flags.includes('--hollow-only');
    const dryRun = flags.includes('--dry-run');
    const concurrencyFlag = flags.find(f => f.startsWith('--concurrency='));
    const concurrency = concurrencyFlag ? parseInt(concurrencyFlag.split('=')[1], 10) || 2 : 2;

    // Get skill list via SkillEvolutionEngine
    const { SkillEvolutionEngine } = require('../core/skill-evolution');
    const skillsDir = PATHS.SKILLS_DIR;
    const registryPath = path.join(PATHS.OUTPUT_DIR, 'skill-registry.json');

    let engine;
    if (context.orchestrator.services && context.orchestrator.services.has('skillEvolution')) {
      engine = context.orchestrator.services.resolve('skillEvolution');
    } else {
      engine = new SkillEvolutionEngine(skillsDir, registryPath);
    }

    const allSkills = engine.listSkills().filter(s => !s.retiredAt);

    // Filter to hollow skills if requested
    let targetSkills = allSkills;
    if (hollowOnly) {
      targetSkills = allSkills.filter(s => {
        if (!fs.existsSync(s.filePath)) return false;
        const content = fs.readFileSync(s.filePath, 'utf-8');
        const expectedSections = ['Rules', 'Anti-Patterns', 'Gotchas', 'Best Practices', 'Context Hints', 'SOP', 'Checklist'];
        let filledSections = 0;
        for (const sec of expectedSections) {
          const secRegex = new RegExp(`^##\\s+.*${sec.replace(/-/g, '[- ]')}`, 'im');
          const secMatch = content.match(secRegex);
          if (secMatch) {
            const secIdx = content.indexOf(secMatch[0]);
            const afterHeader = content.slice(secIdx + secMatch[0].length, secIdx + secMatch[0].length + 200);
            const sectionContent = afterHeader.split(/^##\s/m)[0].trim();
            const sectionWords = sectionContent.split(/\s+/).filter(w => w.length > 1 && !w.startsWith('_No')).length;
            if (sectionWords >= 10) filledSections++;
          }
        }
        const fillRate = filledSections / expectedSections.length;
        return fillRate < 0.6; // Hollow if < 60% sections filled
      });
    }

    if (targetSkills.length === 0) {
      return `✅ No skills to enrich. All skills are well-populated.`;
    }

    const skillNames = targetSkills.map(s => s.name);
    const lines = [
      `## 🌐 Batch Skill Enrichment ${dryRun ? '(Dry Run Preview)' : 'Started'}`,
      ``,
      `- **Target skills**: ${skillNames.length}`,
      `- **Mode**: ${hollowOnly ? 'Hollow/thin only' : 'ALL skills'}`,
      `- **Concurrency**: ${concurrency} (enrichment pipeline rate-limited)`,
      `- **Dry run**: ${dryRun ? 'Yes (no files will be modified)' : 'No (skills will be updated)'}`,
      ``,
    ];

    if (dryRun) {
      lines.push(`### Skills that would be enriched:`);
      for (const name of skillNames) {
        lines.push(`- \`${name}\``);
      }
      lines.push(``, `> 💡 Run \`/skill-enrich-all${hollowOnly ? ' --hollow-only' : ''}\` (without --dry-run) to execute.`);
      return lines.join('\n');
    }

    // Execute enrichment in batches to respect rate limits
    const { enrichSkillFromExternalKnowledge } = require('../core/context-budget-manager');

    lines.push(`### Progress:`);
    lines.push(`| # | Skill | Status | Entries | Sources | Time |`);
    lines.push(`|---|-------|--------|---------|---------|------|`);

    const results = [];
    const startTime = Date.now();

    // Process skills in batches of `concurrency`
    for (let i = 0; i < skillNames.length; i += concurrency) {
      const batch = skillNames.slice(i, i + concurrency);
      const batchPromises = batch.map(async (name) => {
        const t0 = Date.now();
        try {
          const result = await enrichSkillFromExternalKnowledge(context.orchestrator, name, {});
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          return {
            name,
            success: result.success,
            sectionsAdded: result.sectionsAdded || 0,
            sources: (result.sources || []).length,
            elapsed,
            error: result.error || null,
          };
        } catch (err) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          return { name, success: false, sectionsAdded: 0, sources: 0, elapsed, error: err.message };
        }
      });
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Log progress
      for (const r of batchResults) {
        const status = r.success ? '✅' : '❌';
        console.log(`[SkillEnrichAll] ${status} ${r.name}: ${r.sectionsAdded} entries, ${r.sources} sources, ${r.elapsed}s${r.error ? ` (${r.error})` : ''}`);
      }
    }

    // Build result table
    for (let idx = 0; idx < results.length; idx++) {
      const r = results[idx];
      const status = r.success ? '✅ OK' : `❌ ${(r.error || 'failed').slice(0, 30)}`;
      lines.push(`| ${idx + 1} | ${r.name} | ${status} | ${r.sectionsAdded} | ${r.sources} | ${r.elapsed}s |`);
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    const totalEntries = results.reduce((sum, r) => sum + r.sectionsAdded, 0);

    lines.push(``);
    lines.push(`### Summary`);
    lines.push(`- ✅ **Succeeded**: ${successCount}/${results.length}`);
    lines.push(`- ❌ **Failed**: ${failCount}`);
    lines.push(`- 📝 **Total entries added**: ${totalEntries}`);
    lines.push(`- ⏱️ **Total time**: ${totalElapsed}s`);

    if (failCount > 0) {
      lines.push(``);
      lines.push(`### Failed Skills:`);
      for (const r of results.filter(r => !r.success)) {
        lines.push(`- \`${r.name}\`: ${r.error}`);
      }
    }

    return lines.join('\n');
  }
);

registerCommand(
  'report',
  'Generate an interactive HTML session report from the last workflow run',
  async (_args, _context) => {
    const { Observability } = require('../core/observability');
    const { PATHS }         = require('../core/constants');
    const metricsPath = path.join(PATHS.OUTPUT_DIR, 'run-metrics.json');

    if (!fs.existsSync(metricsPath)) {
      return `No metrics found. Run a workflow first to generate \`output/run-metrics.json\`.`;
    }

    let m;
    try {
      m = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
    } catch (err) {
      return `❌ Failed to read metrics: ${err.message}`;
    }

    // Create a temporary Observability instance to generate the report
    const obs = new Observability(PATHS.OUTPUT_DIR, m.projectId || 'unknown');

    // Hydrate from saved metrics for HTML generation
    obs._sessionId  = m.sessionId;
    obs._startedAt  = new Date(m.startedAt).getTime();
    obs._testResult     = m.testResult;
    obs._entropyResult  = m.entropyResult;
    obs._ciResult       = m.ciResult;
    obs._codeGraphResult = m.codeGraphResult;
    obs._taskComplexity = m.taskComplexity;
    obs._clarificationQuality = m.clarificationQuality;

    // Reconstruct internal state for flush() to produce correct output
    for (const s of (m.stages || [])) {
      obs._stages.set(s.name, { start: new Date(m.startedAt).getTime(), end: new Date(m.startedAt).getTime() + (s.durationMs || 0), status: s.status, durationMs: s.durationMs });
    }
    for (const e of (m.errors?.details || [])) {
      obs._errors.push(e);
    }

    const reportPath = obs.generateHTMLReport({ metrics: m });
    return `## 📊 HTML Report Generated\n\nReport saved to: \`${reportPath}\`\n\nOpen in any browser to view the interactive session visualisation.`;
  }
);

registerCommand(
  'article-scout',
  'Search, evaluate, and extract knowledge from AI/Agent articles. Usage: /article-scout [--topic <custom topic>] [--dry-run] [--verbose]',
  async (args, context) => {
    const { ArticleScout } = require('../core/article-scout');

    // Parse arguments
    const parts = (args || '').trim().split(/\\s+/).filter(Boolean);
    const verbose = parts.includes('--verbose');
    const dryRun = parts.includes('--dry-run');

    let customTopics = null;
    const topicIdx = parts.indexOf('--topic');
    if (topicIdx !== -1) {
      const topicQuery = parts.slice(topicIdx + 1).filter(p => !p.startsWith('--')).join(' ');
      if (topicQuery) {
        customTopics = [{ query: topicQuery, label: `Custom: ${topicQuery.slice(0, 50)}` }];
      }
    }

    const orchestrator = context.orchestrator || null;
    const scout = new ArticleScout({ orchestrator, verbose });

    const scoutOpts = { dryRun };
    if (customTopics) scoutOpts.topics = customTopics;

    const result = await scout.run(scoutOpts);

    const lines = [
      `## 🔍 Article Scout Report`,
      ``,
      `**Duration**: ${(result.elapsedMs / 1000).toFixed(1)}s`,
      `**Articles evaluated**: ${result.evaluations.length}`,
      `**High-value articles**: ${result.highValueCount}`,
      `**Knowledge entries injected**: ${result.injectedCount}${dryRun ? ' (dry run)' : ''}`,
      ``,
    ];

    if (result.evaluations.length > 0) {
      lines.push(`| Article | Score | Relevance | Novelty | Actionability | System Fit | Cost |`);
      lines.push(`|---------|-------|-----------|---------|---------------|------------|------|`);
      for (const e of result.evaluations.sort((a, b) => b.compositeScore - a.compositeScore)) {
        const flag = e.compositeScore >= 0.55 ? '⭐' : '⚪';
        lines.push(`| ${flag} ${e.title.slice(0, 40)} | **${e.compositeScore.toFixed(2)}** | ${e.scores.relevance} | ${e.scores.novelty} | ${e.scores.actionability} | ${e.scores.systemFit} | ${e.implementationCost} |`);
      }
      lines.push(``);

      // Show recommendations from high-value articles
      const highValue = result.evaluations.filter(e => e.compositeScore >= 0.55);
      if (highValue.length > 0 && highValue[0].summary) {
        lines.push(`### Top Article Summary`);
        lines.push(`> ${highValue[0].summary}`);
        lines.push(``);
        if (highValue[0].crossDomainValue) {
          lines.push(`**Cross-domain value**: ${highValue[0].crossDomainValue}`);
        }
        if (highValue[0].riskAssessment) {
          lines.push(`**Risk**: ${highValue[0].riskAssessment}`);
        }
        lines.push(``);
      }
    } else {
      lines.push(`### ℹ️ No Articles Found`);
      lines.push(`No articles retrieved. This may be due to API rate limiting or network issues.`);
    }

    lines.push(`> 📄 Full report: \`output/article-scout-report.md\``);
    if (dryRun) {
      lines.push(`> 💡 This was a dry run. Run \`/article-scout\` without --dry-run to inject knowledge.`);
    }

    return lines.join('\n');
  }
);

registerCommand(
  'deep-audit',
  'Run a comprehensive deep audit across all system dimensions (logic, config, architecture, coupling, knowledge, performance). Usage: /deep-audit [--dimension <name>] [--verbose]',
  async (args, context) => {
    const { DeepAuditOrchestrator, AuditCategory } = require('../core/deep-audit-orchestrator');

    // Parse arguments
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);
    const verbose = parts.includes('--verbose');
    let dimensions = null;

    const dimIdx = parts.indexOf('--dimension');
    if (dimIdx !== -1 && parts[dimIdx + 1]) {
      const dimName = parts[dimIdx + 1].toLowerCase().replace(/-/g, '_');
      const dimMap = {
        'logic': AuditCategory.LOGIC,
        'config': AuditCategory.CONFIG,
        'function': AuditCategory.FUNCTION,
        'coupling': AuditCategory.COUPLING,
        'architecture': AuditCategory.ARCHITECTURE,
        'performance': AuditCategory.PERFORMANCE,
        'knowledge': AuditCategory.KNOWLEDGE,
      };
      if (dimMap[dimName]) {
        dimensions = [dimMap[dimName]];
      } else {
        return `❌ Unknown dimension: "${parts[dimIdx + 1]}". Available: ${Object.keys(dimMap).join(', ')}`;
      }
    }

    const orchestrator = context.orchestrator || null;
    const audit = new DeepAuditOrchestrator({
      orchestrator,
      verbose,
    });

    const result = await audit.run({ dimensions: dimensions || undefined });

    const lines = [
      `## 🔍 Deep Audit Report`,
      ``,
      `**Duration**: ${(result.elapsedMs / 1000).toFixed(1)}s`,
      `**Total findings**: ${result.findings.length}`,
      ``,
      `| Severity | Count |`,
      `|----------|-------|`,
      `| 🔴 Critical | ${result.stats.critical} |`,
      `| 🟠 High | ${result.stats.high} |`,
      `| 🟡 Medium | ${result.stats.medium} |`,
      `| 🟢 Low | ${result.stats.low} |`,
      `| ℹ️ Info | ${result.stats.info} |`,
      ``,
    ];

    if (result.findings.length > 0) {
      // Show top priority findings inline
      const topPriority = result.findings.filter(f =>
        f.severity === 'critical' || f.severity === 'high'
      );
      if (topPriority.length > 0) {
        lines.push(`### 🔴 Top Priority`);
        lines.push(``);
        for (const f of topPriority) {
          lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title}`);
          lines.push(`  ${f.description.slice(0, 200)}${f.description.length > 200 ? '...' : ''}`);
          if (f.suggestion) lines.push(`  > 💡 ${f.suggestion}`);
          lines.push(``);
        }
      }

      // Summary of other findings
      const others = result.findings.filter(f =>
        f.severity !== 'critical' && f.severity !== 'high'
      );
      if (others.length > 0) {
        lines.push(`### Other Findings (${others.length})`);
        lines.push(``);
        for (const f of others.slice(0, 10)) {
          lines.push(`- **[${f.severity}]** ${f.title}`);
        }
        if (others.length > 10) {
          lines.push(`- ... and ${others.length - 10} more (see full report)`);
        }
      }

      lines.push(``, `> 📄 Full report: \`output/deep-audit-report.md\``);
      lines.push(`> 📊 Machine-readable: \`output/deep-audit-report.json\``);
    } else {
      lines.push(`### ✅ All Clear`, ``, `No issues found across all audit dimensions. System health is excellent!`);
    }

    return lines.join('\n');
  }
);

registerCommand(
  'evolve',
  'One-click self-evolution: runs DeepAudit + Stale Skill Refresh + ArticleScout + Health Audit + Auto-Deploy. Usage: /evolve [--quick] [--dry-run] [--verbose]',
  async (args, context) => {
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);
    const quick   = parts.includes('--quick');
    const dryRun  = parts.includes('--dry-run');
    const verbose = parts.includes('--verbose');

    if (!context.orchestrator) {
      return `❌ No orchestrator in context. Cannot run evolution (needs LLM + services).`;
    }

    const orch = context.orchestrator;
    const startTime = Date.now();
    const report = {
      steps: [],
      totalFindings: 0,
      staleSkillsRefreshed: 0,
      articlesEvaluated: 0,
      knowledgeInjected: 0,
      healthFindings: 0,
    };

    const log = (msg) => {
      console.log(`[Evolve] ${msg}`);
    };

    // ── P2b: Capture baseline BEFORE any evolution steps ──────────────────
    let baseline = null;
    let regressionGuard = null;
    try {
      const { RegressionGuard } = require('../core/regression-guard');
      regressionGuard = new RegressionGuard({ outputDir: PATHS.OUTPUT_DIR, verbose });
      baseline = regressionGuard.captureBaseline();
      log(`📸 Baseline captured: ${Object.keys(baseline.metrics).length} metrics, ${Object.keys(baseline.skillVersions).length} skills`);
    } catch (err) {
      log(`⚠️ Baseline capture failed (non-fatal): ${err.message}`);
    }

    log(`🧬 Self-evolution started ${quick ? '(quick mode)' : '(full mode)'}${dryRun ? ' [DRY RUN]' : ''}`);

    // ── P3d: Incremental Mode — only full-audit changed files ─────────────
    const lastRunPath = path.join(PATHS.OUTPUT_DIR, 'evolve-last-run.json');
    let lastEvolveTime = 0;
    let incrementalMode = false;
    try {
      if (fs.existsSync(lastRunPath)) {
        const lastRun = JSON.parse(fs.readFileSync(lastRunPath, 'utf-8'));
        lastEvolveTime = new Date(lastRun.timestamp).getTime() || 0;
      }
    } catch (_) { /* first run */ }

    // Check if any core files changed since last evolve
    let changedCoreFiles = 0;
    if (lastEvolveTime > 0) {
      const coreDirs = [
        path.join(orch?.projectRoot || process.cwd(), 'workflow', 'core'),
        path.join(orch?.projectRoot || process.cwd(), 'workflow', 'skills'),
        path.join(orch?.projectRoot || process.cwd(), 'workflow', 'commands'),
      ];
      for (const dir of coreDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          const files = fs.readdirSync(dir);
          for (const f of files) {
            const fullPath = path.join(dir, f);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isFile() && stat.mtimeMs > lastEvolveTime) {
                changedCoreFiles++;
              }
            } catch (_) { /* skip */ }
          }
        } catch (_) { /* skip */ }
      }
      incrementalMode = changedCoreFiles === 0;
      if (incrementalMode) {
        log(`⚡ Incremental mode: 0 core files changed since last evolve — skipping Deep Audit`);
      } else {
        log(`📝 ${changedCoreFiles} core file(s) changed since last evolve — full audit`);
      }
    }


    // ── P2a: MAPE Closed-Loop Analysis ────────────────────────────────────
    let mapeReport = null;
    try {
      const { MAPEEngine } = require('../core/mape-engine');
      const mape = new MAPEEngine({ orchestrator: orch, verbose });
      mapeReport = await mape.runCycle({ dryRun, maxActions: 5 });

      report.steps.push({
        name: 'MAPE Analysis',
        icon: mapeReport.phases.plan.actionCount > 0 ? '🔄' : '✅',
        status: 'done',
        summary: `${mapeReport.phases.monitor.signalCount} signals → ${mapeReport.phases.analyze.rootCauses} root causes → ${mapeReport.phases.plan.actionCount} actions (ROI: ${mapeReport.phases.plan.estimatedROI})`,
        mape: mapeReport,
      });
      log(`🔄 MAPE: ${mapeReport.phases.monitor.signalCount} signals, ${mapeReport.phases.plan.actionCount} planned actions`);
    } catch (err) {
      report.steps.push({ name: 'MAPE Analysis', icon: '⚠️', status: 'error', summary: err.message });
      log(`⚠️ MAPE analysis failed (non-fatal): ${err.message}`);
    }


    // ── Step 1: Deep Audit (skip in incremental mode if no changes) ─────
    const totalSteps = quick ? 4 : 5;
    if (incrementalMode) {
      report.steps.push({
        name: 'Deep Audit',
        icon: '⚡',
        status: 'skipped-incremental',
        summary: 'Skipped (no core files changed since last evolve)',
      });
      log(`Step 1/${totalSteps}: ⚡ Deep Audit skipped (incremental — 0 changes)`);
    } else {
      log(`Step 1/${totalSteps}: 🔬 Deep Audit...`);
    try {
      const { DeepAuditOrchestrator } = require('../core/deep-audit-orchestrator');
      const audit = new DeepAuditOrchestrator({ orchestrator: orch, verbose });
      const auditResult = await audit.run();
      const critical = auditResult.stats.critical || 0;
      const high     = auditResult.stats.high || 0;
      const medium   = auditResult.stats.medium || 0;
      const low      = auditResult.stats.low || 0;
      const info     = auditResult.stats.info || 0;
      const total    = auditResult.findings.length;
      report.totalFindings += total;

      report.steps.push({
        name: 'Deep Audit',
        icon: critical > 0 ? '🔴' : high > 0 ? '🟠' : '✅',
        status: 'done',
        summary: `${total} findings (🔴${critical} 🟠${high} 🟡${medium} 🟢${low} ℹ️${info})`,
        details: auditResult.findings.filter(f => f.severity === 'critical' || f.severity === 'high'),
      });
      log(`  → ${total} findings`);
    } catch (err) {
      report.steps.push({ name: 'Deep Audit', icon: '❌', status: 'error', summary: err.message });
      log(`  → Error: ${err.message}`);
    }
    } // end: incremental mode else

    // ── Step 2 + 3: Parallel Execution (P3c) ──────────────────────────────
    // Step 2 (Skill Refresh) and Step 3 (Article Scout) are independent —
    // they don't share mutable state, so run them in parallel for ~50% speedup.
    log(`Step 2-3/${totalSteps}: 📦🌐 Stale Skill Refresh + Article Scout (parallel)...`);

    const step2Promise = (async () => {
      try {
        const STALE_DAYS = 90;
        const now = Date.now();
        const refreshCandidates = [];
        const staleDetails = [];

        if (orch.skillEvolution) {
          for (const meta of orch.skillEvolution.registry.values()) {
            if (meta.retiredAt) continue;
            const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
            const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
            const latestActivity = Math.max(lastEvolved, created);
            const daysSince = latestActivity > 0 ? (now - latestActivity) / (24 * 60 * 60 * 1000) : Infinity;

            if (daysSince > STALE_DAYS) {
              refreshCandidates.push(meta.name);
              staleDetails.push({ name: meta.name, daysSince: Math.round(daysSince), usageCount: meta.usageCount || 0 });
            }
          }
        }

        // Also detect hollow skills (low fill-rate)
        const { SkillEvolutionEngine } = require('../core/skill-evolution');
        const skillsDir = PATHS.SKILLS_DIR;
        const hollowSkills = [];
        const skills = orch.skillEvolution ? orch.skillEvolution.listSkills() : [];
        for (const s of skills) {
          if (s.retiredAt) continue;
          if (fs.existsSync(s.filePath)) {
            const content = fs.readFileSync(s.filePath, 'utf-8');
            const expectedSections = ['Rules', 'Anti-Patterns', 'Gotchas', 'Best Practices', 'Context Hints'];
            let filled = 0;
            for (const sec of expectedSections) {
              const secRegex = new RegExp(`^##\\s+.*${sec.replace(/-/g, '[- ]')}`, 'im');
              const secMatch = content.match(secRegex);
              if (secMatch) {
                const secIdx = content.indexOf(secMatch[0]);
                const afterHeader = content.slice(secIdx + secMatch[0].length, secIdx + secMatch[0].length + 200);
                const sectionContent = afterHeader.split(/^##\s/m)[0].trim();
                const sectionWords = sectionContent.split(/\s+/).filter(w => w.length > 1 && !w.startsWith('_No')).length;
                if (sectionWords >= 10) filled++;
              }
            }
            const fillRate = filled / expectedSections.length;
            if (fillRate < 0.4) {
              hollowSkills.push({ name: s.name, fillRate: Math.round(fillRate * 100) });
              if (!refreshCandidates.includes(s.name)) refreshCandidates.push(s.name);
            }
          }
        }

        // Refresh (up to 5 in evolve mode, more than the default 3)
        const maxRefresh = quick ? 3 : 5;
        const toRefresh = refreshCandidates.slice(0, maxRefresh);
        const refreshResults = [];

        if (toRefresh.length > 0 && !dryRun) {
          const { enrichSkillFromExternalKnowledge } = require('../core/context-budget-manager');
          for (const skillName of toRefresh) {
            try {
              const r = await enrichSkillFromExternalKnowledge(orch, skillName, {
                maxSearchResults: 3,
                maxFetchPages: 2,
                dryRun,
              });
              if (r.success) {
                refreshResults.push({ name: skillName, sectionsAdded: r.sectionsAdded });
                report.staleSkillsRefreshed++;
              }
            } catch (_) { /* non-fatal */ }
          }
        }

        report.steps.push({
          name: 'Stale Skill Refresh',
          icon: refreshCandidates.length > 0 ? '🔄' : '✅',
          status: 'done',
          summary: `${refreshCandidates.length} stale/hollow skill(s) found, ${dryRun ? '0 (dry run)' : refreshResults.length} refreshed`,
          staleDetails,
          hollowSkills,
          refreshResults,
        });
        log(`  → [Step 2] ${refreshCandidates.length} stale, ${refreshResults.length} refreshed`);
      } catch (err) {
        report.steps.push({ name: 'Stale Skill Refresh', icon: '❌', status: 'error', summary: err.message });
        log(`  → [Step 2] Error: ${err.message}`);
      }
    })();

    const step3Promise = (async () => {
      if (!quick) {
        try {
          const { ArticleScout } = require('../core/article-scout');
          const scout = new ArticleScout({ orchestrator: orch, verbose });
          const scoutResult = await scout.run({ dryRun });

          report.articlesEvaluated = scoutResult.evaluations.length;
          report.knowledgeInjected = scoutResult.injectedCount || 0;

          const highValue = scoutResult.evaluations.filter(e => e.compositeScore >= 0.55);
          report.steps.push({
            name: 'Article Scout',
            icon: highValue.length > 0 ? '⭐' : 'ℹ️',
            status: 'done',
            summary: `${scoutResult.evaluations.length} articles evaluated, ${highValue.length} high-value, ${scoutResult.injectedCount || 0} knowledge entries${dryRun ? ' (dry run)' : ''}`,
            highValue: highValue.map(e => ({ title: e.title, score: e.compositeScore })),
          });
          log(`  → [Step 3] ${scoutResult.evaluations.length} articles, ${highValue.length} high-value`);
        } catch (err) {
          report.steps.push({ name: 'Article Scout', icon: '❌', status: 'error', summary: err.message });
          log(`  → [Step 3] Error: ${err.message}`);
        }
      } else {
        report.steps.push({ name: 'Article Scout', icon: '⏭️', status: 'skipped', summary: 'Skipped (quick mode)' });
        log(`  → [Step 3] Article Scout skipped (quick mode)`);
      }
    })();

    // Wait for both to complete (parallel execution)
    await Promise.all([step2Promise, step3Promise]);

    // ── Step 4: Self-Reflection Health Audit ──────────────────────────────
    log(`Step 4/${totalSteps}: 🩺 Self-Reflection Health Audit...`);
    try {
      if (orch._selfReflection) {
        const auditResult = orch._selfReflection.auditHealth();
        report.healthFindings = auditResult.findings ? auditResult.findings.length : 0;

        report.steps.push({
          name: 'Health Audit',
          icon: report.healthFindings === 0 ? '✅' : '🟡',
          status: 'done',
          summary: `${report.healthFindings} finding(s) from ${auditResult.sessionCount || 0} session(s)`,
          findings: (auditResult.findings || []).slice(0, 5),
        });
        log(`  → ${report.healthFindings} findings`);
      } else {
        report.steps.push({ name: 'Health Audit', icon: '⚠️', status: 'skipped', summary: 'SelfReflectionEngine not available' });
        log('  → SelfReflectionEngine not available, skipped');
      }
    } catch (err) {
      report.steps.push({ name: 'Health Audit', icon: '❌', status: 'error', summary: err.message });
      log(`  → Error: ${err.message}`);
    }

    // ── Step 5: Staged Auto-Deploy (P1 ADR-34) ───────────────────────────
    log(`Step 5/${totalSteps}: 🚀 Staged Auto-Deploy...`);
    let deployReport = null;
    try {
      if (orch.autoDeployer) {
        // Collect GREEN changes from previous steps
        const greenChanges = [];
        if (report.staleSkillsRefreshed > 0) {
          greenChanges.push({
            type: 'skill-content-update',
            description: `Refreshed ${report.staleSkillsRefreshed} stale skill(s)`,
          });
        }
        if (report.knowledgeInjected > 0) {
          greenChanges.push({
            type: 'experience-store-update',
            description: `Injected ${report.knowledgeInjected} knowledge entries from article scout`,
          });
        }

        // Get adaptive strategy for YELLOW tier
        const Obs = require('../core/observability');
        const cfgAutoFix = (orch._config && orch._config.autoFixLoop) || {};
        const strategy = Obs.deriveStrategy(PATHS.OUTPUT_DIR, {
          maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
          maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
          maxExpInjected:  cfgAutoFix.maxExpInjected  ?? 5,
          projectId:       orch.projectId,
        });

        // Get audit findings for RED tier
        const auditStep = report.steps.find(s => s.name === 'Deep Audit');
        const auditFindings = auditStep && auditStep.status === 'done'
          ? { findings: auditStep.details || [] }
          : null;

        deployReport = await orch.autoDeployer.runFullDeploy({
          adaptiveStrategy: strategy,
          greenChanges,
          auditFindings,
          dryRun,
        });

        const totalChanges = deployReport.green.count + deployReport.yellow.count;
        const statusIcon = deployReport.red.prGenerated ? '🔴' : totalChanges > 0 ? '🟡' : '✅';
        const summary = [
          `🟢${deployReport.green.count} GREEN`,
          `🟡${deployReport.yellow.count} YELLOW${deployReport.yellow.applied ? ' (applied)' : ''}`,
          `🔴${deployReport.red.count} RED${deployReport.red.prGenerated ? ' (PR generated)' : ''}`,
        ].join(', ');

        report.steps.push({
          name: 'Auto-Deploy',
          icon: statusIcon,
          status: 'done',
          summary,
          deploy: deployReport,
        });
        log(`  → ${summary}`);
      } else {
        report.steps.push({ name: 'Auto-Deploy', icon: '⚠️', status: 'skipped', summary: 'AutoDeployer not available' });
        log('  → AutoDeployer not available, skipped');
      }
    } catch (err) {
      report.steps.push({ name: 'Auto-Deploy', icon: '❌', status: 'error', summary: err.message });
      log(`  → Error: ${err.message}`);
    }

    // ── Generate unified evolution report ─────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`🧬 Self-evolution complete in ${elapsed}s`);

    // Save JSON report
    try {
      const reportPath = path.join(PATHS.OUTPUT_DIR, 'evolve-report.json');
      if (!fs.existsSync(PATHS.OUTPUT_DIR)) {
        fs.mkdirSync(PATHS.OUTPUT_DIR, { recursive: true });
      }
      fs.writeFileSync(reportPath, JSON.stringify({ ...report, elapsed, timestamp: new Date().toISOString() }, null, 2));
    } catch (_) { /* non-fatal */ }

    // ── P2b: Compare with baseline (Before/After) ─────────────────────────
    let comparison = null;
    if (regressionGuard && baseline) {
      try {
        comparison = regressionGuard.compareWithBaseline();
        // Record the evolution outcome for long-term trend analysis
        regressionGuard.recordOutcome(report, comparison, mapeReport);
        log(`📊 Before/After: ${comparison.improved.length} improved, ${comparison.degraded.length} degraded, ${comparison.regressions.length} regression(s)`);
      } catch (err) {
        log(`⚠️ Regression comparison failed (non-fatal): ${err.message}`);
      }
    }

    // ── P3d: Save evolve timestamp for incremental mode ─────────────────
    if (!dryRun) {
      try {
        fs.writeFileSync(lastRunPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          changedCoreFiles,
          incrementalMode,
          stepsRun: report.steps.map(s => s.name),
        }, null, 2), 'utf-8');
      } catch (_) { /* non-fatal */ }
    }

    // Build markdown output
    const lines = [
      `## 🧬 Self-Evolution Report${dryRun ? ' (Dry Run)' : ''}`,
      ``,
      `**Mode**: ${quick ? '⚡ Quick' : '🔬 Full'}${incrementalMode ? ' ⚡ Incremental' : ''} | **Duration**: ${elapsed}s`,
      ``,
      `### Pipeline Summary`,
      ``,
      `| Step | Status | Summary |`,
      `|------|--------|---------|`,
    ];

    for (const step of report.steps) {
      lines.push(`| ${step.icon} ${step.name} | ${step.status} | ${step.summary} |`);
    }
    lines.push(``);

    // Deep Audit highlights
    const auditStep = report.steps.find(s => s.name === 'Deep Audit');
    if (auditStep && auditStep.details && auditStep.details.length > 0) {
      lines.push(`### 🔴 Critical / High Priority Findings`);
      lines.push(``);
      for (const f of auditStep.details.slice(0, 5)) {
        lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title}`);
        if (f.suggestion) lines.push(`  > 💡 ${f.suggestion}`);
      }
      lines.push(``);
    }

    // Stale skill details
    const staleStep = report.steps.find(s => s.name === 'Stale Skill Refresh');
    if (staleStep && staleStep.staleDetails && staleStep.staleDetails.length > 0) {
      lines.push(`### 📦 Stale Skills`);
      lines.push(`| Skill | Days Since Update | Usage Count |`);
      lines.push(`|-------|-------------------|-------------|`);
      for (const s of staleStep.staleDetails.slice(0, 10)) {
        lines.push(`| ${s.name} | ${s.daysSince}d | ${s.usageCount} |`);
      }
      if (staleStep.hollowSkills && staleStep.hollowSkills.length > 0) {
        lines.push(``);
        lines.push(`**Hollow Skills** (low fill-rate):`);
        for (const h of staleStep.hollowSkills) {
          lines.push(`- ${h.name}: ${h.fillRate}% filled`);
        }
      }
      if (staleStep.refreshResults && staleStep.refreshResults.length > 0) {
        lines.push(``);
        lines.push(`**Refreshed**:`);
        for (const r of staleStep.refreshResults) {
          lines.push(`- ✅ ${r.name}: +${r.sectionsAdded} entries`);
        }
      }
      lines.push(``);
    }

    // Article Scout highlights
    const scoutStep = report.steps.find(s => s.name === 'Article Scout');
    if (scoutStep && scoutStep.highValue && scoutStep.highValue.length > 0) {
      lines.push(`### ⭐ High-Value Articles`);
      for (const a of scoutStep.highValue.slice(0, 3)) {
        lines.push(`- **${a.title}** (score: ${a.score.toFixed(2)})`);
      }
      lines.push(``);
    }

    // Health audit highlights
    const healthStep = report.steps.find(s => s.name === 'Health Audit');
    if (healthStep && healthStep.findings && healthStep.findings.length > 0) {
      lines.push(`### 🩺 Health Findings`);
      for (const f of healthStep.findings) {
        lines.push(`- **[${f.severity || 'info'}]** ${f.title || f.message || JSON.stringify(f).slice(0, 100)}`);
      }
      lines.push(``);
    }

    // Auto-Deploy details
    const deployStep = report.steps.find(s => s.name === 'Auto-Deploy');
    if (deployStep && deployStep.deploy) {
      const d = deployStep.deploy;
      lines.push(`### 🚀 Auto-Deploy (ADR-34)`);
      lines.push(``);
      if (d.green.count > 0) {
        lines.push(`**🟢 GREEN** (${d.green.count} change(s) recorded):`);
        for (const desc of d.green.changes) {
          lines.push(`- ${desc}`);
        }
        lines.push(``);
      }
      if (d.yellow.count > 0) {
        lines.push(`**🟡 YELLOW** (${d.yellow.count} config param(s)${d.yellow.applied ? ' — auto-applied' : ' — recommended'}):`);
        for (const c of d.yellow.changes) {
          lines.push(`- \`${c.param}\`: ${c.oldValue} → ${c.newValue} _(${c.reason})_`);
        }
        lines.push(``);
      }
      if (d.red.prGenerated) {
        lines.push(`**🔴 RED** (${d.red.count} structural change(s) — PR generated):`);
        if (d.red.prFile) lines.push(`- PR description: \`${d.red.prFile}\``);
        lines.push(``);
      }
    }

    // MAPE Analysis highlights (P2a)
    const mapeStep = report.steps.find(s => s.name === 'MAPE Analysis');
    if (mapeStep && mapeStep.mape) {
      const m = mapeStep.mape;
      lines.push(`### 🔄 MAPE Closed-Loop Analysis (P2a)`);
      lines.push(``);
      lines.push(`| Phase | Result |`);
      lines.push(`|-------|--------|`);
      lines.push(`| Monitor | ${m.phases.monitor.signalCount} signal(s) collected |`);
      lines.push(`| Analyze | ${m.phases.analyze.rootCauses} root cause(s), ${m.phases.analyze.correlations} correlation(s) |`);
      lines.push(`| Plan | ${m.phases.plan.actionCount} action(s), est. ROI: ${m.phases.plan.estimatedROI} |`);
      lines.push(`| Execute | ${m.phases.execute.executed} executed, ${m.phases.execute.skipped} skipped |`);
      lines.push(``);

      if (m.phases.plan.plan && m.phases.plan.plan.actions.length > 0) {
        lines.push(`**Planned Actions:**`);
        for (const a of m.phases.plan.plan.actions.slice(0, 5)) {
          const prioLabel = ['🔴 CRITICAL', '🟠 HIGH', '🟡 MEDIUM', '🟢 LOW'][a.priority] || '⚪';
          lines.push(`- ${prioLabel}: ${a.title} _(effort: ${a.estimatedEffort}, impact: ${a.estimatedImpact})_`);
        }
        lines.push(``);
      }
    }

    // Before/After comparison (P2b + P2d)
    if (comparison && !comparison.error) {
      lines.push(`### 📊 Evolution Effectiveness (Before/After)`);
      lines.push(``);

      if (Object.keys(comparison.delta).length > 0) {
        lines.push(`| Metric | Before | After | Δ | Status |`);
        lines.push(`|--------|--------|-------|---|--------|`);
        for (const [key, d] of Object.entries(comparison.delta)) {
          const icon = comparison.improved.includes(key) ? '✅' :
                       comparison.degraded.includes(key)  ? '❌' : '➖';
          const sign = d.diff > 0 ? '+' : '';
          lines.push(`| ${key} | ${d.before} | ${d.after} | ${sign}${d.diff} (${sign}${d.pctChange}%) | ${icon} |`);
        }
        lines.push(``);
      }

      if (comparison.regressions.length > 0) {
        lines.push(`**⚠️ Skill Regressions Detected:**`);
        for (const r of comparison.regressions) {
          lines.push(`- \`${r.skillName}\`: ${r.reason} (action: ${r.action})`);
        }
        lines.push(``);
      }

      // P2d: Evolution ROI from history
      if (regressionGuard) {
        try {
          const trend = regressionGuard.getTrend();
          if (trend.cycles > 0) {
            lines.push(`**Evolution Trend:** ${trend.cycles} cycle(s) | Avg ROI: ${trend.avgROI} | Direction: ${trend.trend === 'improving' ? '📈 Improving' : trend.trend === 'degrading' ? '📉 Degrading' : '➡️ Stable'}`);
            if (trend.recentROI.length > 0) {
              lines.push(`Recent ROI: ${trend.recentROI.map(r => r.toFixed(1)).join(' → ')}`);
            }
            lines.push(``);
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    // Footer
    lines.push(`---`);
    lines.push(`📄 Full report: \`output/evolve-report.json\``);
    if (dryRun) {
      lines.push(`> 💡 This was a dry run. Run \`/evolve\` without --dry-run to apply changes.`);
    } else {
      lines.push(`> 🔄 Next evolution: run \`/evolve\` again anytime, or it auto-triggers via \`_finalizeWorkflow()\` on each workflow run.`);
    }

    return lines.join('\n');
  }
);

}

module.exports = { registerDevToolsCommands };