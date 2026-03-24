/**
 * Analyze Commands – Standalone project architecture analysis.
 *
 * Commands:
 *   /analyze  – Run ProjectProfiler (deep architecture analysis) independently.
 *               Supports incremental re-analysis without full /wf init.
 *
 * Usage:
 *   /analyze                        – Full analysis (baseline + LSP enhancement)
 *   /analyze --no-lsp               – Baseline only (skip LSP, fastest)
 *   /analyze --max-files <N>        – Override max files for LSP analysis (default: 80)
 *   /analyze --path <dir>           – Analyze a specific project directory
 *   /analyze --dry-run              – Preview without writing any files
 *   /analyze --verbose              – Show detailed detection logs
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Registers analyze commands into the shared command registry.
 *
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerAnalyzeCommands(registerCommand) {

  registerCommand(
    'analyze',
    'Run ProjectProfiler to (re-)analyze project architecture. Usage: /analyze [--no-lsp] [--max-files <N>] [--path <dir>] [--dry-run] [--verbose]',
    async (args, context) => {
      const startTime = Date.now();
      const flags = (args || '').trim();

      // ── Parse flags ──────────────────────────────────────────────────────
      const noLsp      = flags.includes('--no-lsp');
      const dryRun     = flags.includes('--dry-run');
      const verbose    = flags.includes('--verbose');
      const pathMatch  = flags.match(/--path\s+(\S+)/);
      const maxFilesMatch = flags.match(/--max-files\s+(\d+)/);

      const maxFiles = maxFilesMatch ? parseInt(maxFilesMatch[1], 10) : null;

      // ── Resolve project root ─────────────────────────────────────────────
      const projectRoot = pathMatch
        ? path.resolve(pathMatch[1])
        : (context.orchestrator?.projectRoot || process.cwd());

      if (!fs.existsSync(projectRoot)) {
        return `❌ Project root not found: \`${projectRoot}\``;
      }

      // ── Load existing config (if any) ────────────────────────────────────
      let config = null;
      let configFilePath = null;
      try {
        const { getConfig, getConfigPath, clearConfigCache } = require('../core/config-loader');
        clearConfigCache();
        config = getConfig(projectRoot, true);
        configFilePath = getConfigPath();
      } catch (_) {
        // No config available – that's OK, we can still analyze
      }

      const ignoreDirs = (config && config.ignoreDirs) || [];

      // ── Build LSP config ─────────────────────────────────────────────────
      const lspConfig = {};
      if (config && config.mcp && config.mcp.lsp && typeof config.mcp.lsp === 'object') {
        Object.assign(lspConfig, config.mcp.lsp);
      }
      if (maxFiles) {
        lspConfig.maxFiles = maxFiles;
      }

      // ── Summary header ───────────────────────────────────────────────────
      const lines = [
        `## 🔬 Project Architecture Analysis${dryRun ? ' (Dry Run)' : ''}`,
        ``,
        `**Project**: \`${projectRoot}\``,
        `**Mode**: ${noLsp ? '📄 Baseline only (--no-lsp)' : '🔬 Baseline + LSP Enhancement'}`,
        maxFiles ? `**Max Files (LSP)**: ${maxFiles}` : '',
        ``,
      ].filter(Boolean);

      if (dryRun) {
        lines.push(`> 💡 Dry run mode: no files will be written. Remove \`--dry-run\` to persist results.`);
        lines.push(``);
        lines.push(`### What would happen:`);
        lines.push(`1. Run ProjectProfiler baseline analysis (file detection + config parsing)`);
        if (!noLsp) {
          lines.push(`2. Attempt LSP enhancement (symbol analysis, decorator detection, diagnostics)`);
        }
        lines.push(`${noLsp ? '2' : '3'}. Write results to \`output/project-profile.md\``);
        lines.push(`${noLsp ? '3' : '4'}. Persist \`projectProfile\` into \`workflow.config.js\``);
        return lines.join('\n');
      }

      // ── Run analysis ─────────────────────────────────────────────────────
      const { ProjectProfiler, renderCompactProfileSummary } = require('../core/project-profiler');
      // P2-3: Pass user-defined custom detection rules if configured
      const customRules = (config && config.customDetectionRules) || {};
      const profiler = new ProjectProfiler(projectRoot, {
        ignoreDirs,
        customFrameworkRules: customRules.frameworks,
        customDataLayerRules: customRules.dataLayer,
        customTestRules:      customRules.testFrameworks,
      });

      let projectProfile;
      let profileMdPath;
      let lspUsed = false;

      if (noLsp) {
        // Baseline only
        if (verbose) console.log(`[analyze] Running baseline-only analysis...`);
        const result = profiler.analyzeAndWrite();
        projectProfile = result.profile;
        profileMdPath  = result.mdPath;
      } else {
        // Baseline + LSP
        try {
          if (verbose) console.log(`[analyze] Running baseline + LSP analysis...`);
          const result = await profiler.analyzeWithLSP(undefined, lspConfig);
          projectProfile = result.profile;
          profileMdPath  = result.mdPath;
          lspUsed = !!projectProfile.lspEnhanced;
        } catch (lspErr) {
          if (verbose) console.log(`[analyze] LSP not available (${lspErr.message}). Falling back to baseline.`);
          const result = profiler.analyzeAndWrite();
          projectProfile = result.profile;
          profileMdPath  = result.mdPath;
        }
      }

      // ── Persist to workflow.config.js ────────────────────────────────────
      let configPersisted = false;
      if (configFilePath && fs.existsSync(configFilePath)) {
        try {
          let configContent = fs.readFileSync(configFilePath, 'utf-8');

          // Strategy: Replace existing projectProfile block or the null placeholder
          const profileJson = JSON.stringify(projectProfile, null, 4)
            .split('\n').map((line, i) => i === 0 ? line : '  ' + line).join('\n');

          if (configContent.includes('projectProfile: null')) {
            // First time: replace null placeholder
            configContent = configContent.replace(
              'projectProfile: null,',
              `projectProfile: ${profileJson},`
            );
            fs.writeFileSync(configFilePath, configContent, 'utf-8');
            configPersisted = true;
          } else if (configContent.includes('projectProfile:')) {
            // Subsequent runs: replace existing profile block
            // Use regex to match the projectProfile key and its JSON value
            const profileRegex = /projectProfile:\s*(\{[\s\S]*?\n\s*\}),/;
            if (profileRegex.test(configContent)) {
              configContent = configContent.replace(
                profileRegex,
                `projectProfile: ${profileJson},`
              );
              fs.writeFileSync(configFilePath, configContent, 'utf-8');
              configPersisted = true;
            }
          }
        } catch (err) {
          if (verbose) console.warn(`[analyze] Could not persist to config: ${err.message}`);
        }
      }

      // ── Inject into running orchestrator config ──────────────────────────
      if (context.orchestrator && context.orchestrator._config) {
        context.orchestrator._config.projectProfile = projectProfile;
      }

      // ── Build result output ──────────────────────────────────────────────
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Frameworks
      if (projectProfile.frameworks.length > 0) {
        const byCategory = {};
        for (const f of projectProfile.frameworks) {
          if (!byCategory[f.category]) byCategory[f.category] = [];
          byCategory[f.category].push(f.name);
        }
        lines.push(`### 📦 Frameworks`);
        lines.push(``);
        for (const [cat, names] of Object.entries(byCategory)) {
          lines.push(`- **${cat}**: ${names.join(', ')}`);
        }
        lines.push(``);
      }

      // Architecture
      if (projectProfile.architecture) {
        const arch = projectProfile.architecture;
        lines.push(`### 🏗️ Architecture`);
        lines.push(``);
        if (arch.pattern) lines.push(`- **Pattern**: ${arch.pattern}`);
        if (arch.layers && arch.layers.length > 0) {
          lines.push(`- **Layers**: ${arch.layers.join(' → ')}`);
        }
        if (arch.moduleStructure) lines.push(`- **Module Structure**: ${arch.moduleStructure}`);
        if (arch.confidence) lines.push(`- **Confidence**: ${(arch.confidence * 100).toFixed(0)}%`);
        lines.push(``);
      }

      // Data Layer
      if (projectProfile.dataLayer && (projectProfile.dataLayer.orm.length > 0 || projectProfile.dataLayer.databases.length > 0)) {
        lines.push(`### 💾 Data Layer`);
        lines.push(``);
        if (projectProfile.dataLayer.orm.length > 0) {
          lines.push(`- **ORM/Query Builder**: ${projectProfile.dataLayer.orm.join(', ')}`);
        }
        if (projectProfile.dataLayer.databases.length > 0) {
          lines.push(`- **Databases**: ${projectProfile.dataLayer.databases.join(', ')}`);
        }
        lines.push(``);
      }

      // Communication
      if (projectProfile.communication && projectProfile.communication.length > 0) {
        lines.push(`### 🔗 Communication`);
        lines.push(``);
        for (const p of projectProfile.communication) {
          lines.push(`- ${p}`);
        }
        lines.push(``);
      }

      // Testing
      if (projectProfile.testing && projectProfile.testing.frameworks.length > 0) {
        lines.push(`### 🧪 Testing`);
        lines.push(``);
        lines.push(`- **Frameworks**: ${projectProfile.testing.frameworks.join(', ')}`);
        lines.push(``);
      }

      // Infrastructure
      if (projectProfile.infrastructure && Object.keys(projectProfile.infrastructure).length > 0) {
        lines.push(`### 🐳 Infrastructure`);
        lines.push(``);
        const infra = projectProfile.infrastructure;
        if (infra.containerized) lines.push(`- **Container**: Docker`);
        if (infra.orchestration) lines.push(`- **Orchestration**: ${infra.orchestration}`);
        if (infra.ci) lines.push(`- **CI/CD**: ${infra.ci}`);
        if (infra.iac) lines.push(`- **IaC**: ${infra.iac}`);
        lines.push(``);
      }

      // Monorepo
      if (projectProfile.monorepo && projectProfile.monorepo.isMonorepo) {
        lines.push(`### 📦 Monorepo`);
        lines.push(``);
        lines.push(`- **Tool**: ${projectProfile.monorepo.tool}`);
        if (projectProfile.monorepo.packages.length > 0) {
          lines.push(`- **Packages** (${projectProfile.monorepo.packages.length}): ${projectProfile.monorepo.packages.slice(0, 10).join(', ')}${projectProfile.monorepo.packages.length > 10 ? '...' : ''}`);
        }
        lines.push(``);
      }

      // Entry Points
      if (projectProfile.entryPoints && projectProfile.entryPoints.length > 0) {
        lines.push(`### 🚪 Entry Points`);
        lines.push(``);
        for (const ep of projectProfile.entryPoints) {
          lines.push(`- \`${ep}\``);
        }
        lines.push(``);
      }

      // LSP Enhancement section
      if (projectProfile.lspEnhanced) {
        const stats = projectProfile.lspStats || {};
        lines.push(`### 🔬 LSP Enhancement`);
        lines.push(``);
        lines.push(`- **Server**: ${projectProfile.lspServerName || 'auto'}`);
        lines.push(`- **Files Analyzed**: ${stats.filesAnalyzed || 0}`);
        lines.push(`- **Symbols Collected**: ${stats.symbolsCollected || 0}`);
        lines.push(`- **Hover Probes**: ${stats.hoverProbes || 0}`);
        lines.push(`- **LSP Time**: ${stats.timeTakenMs || 0}ms`);
        lines.push(``);

        // Symbol Inventory
        if (projectProfile.architecture && projectProfile.architecture.symbolInventory) {
          const inv = projectProfile.architecture.symbolInventory;
          const entries = Object.entries(inv).sort((a, b) => b[1] - a[1]);
          if (entries.length > 0) {
            lines.push(`**Symbol Inventory**: ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
            lines.push(``);
          }
        }

        // Decorator Patterns
        if (projectProfile.architecture && projectProfile.architecture.decoratorPatterns) {
          const decs = projectProfile.architecture.decoratorPatterns;
          if (Object.keys(decs).length > 0) {
            lines.push(`**Decorator Patterns**: ${Object.entries(decs).map(([l, ds]) => `${l}(${ds.join(', ')})`).join(' | ')}`);
            lines.push(``);
          }
        }

        // Diagnostics
        if (projectProfile.diagnostics) {
          const diag = projectProfile.diagnostics;
          lines.push(`**Compiler Diagnostics**: ${diag.errors} error(s), ${diag.warnings} warning(s)`);
          if (diag.errorFiles && diag.errorFiles.length > 0) {
            for (const ef of diag.errorFiles.slice(0, 5)) {
              lines.push(`  - \`${ef.file}\` (${ef.errors} errors)`);
            }
          }
          lines.push(``);
        }
      }

      // Footer
      lines.push(`---`);
      lines.push(``);
      lines.push(`| Detail | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| ⏱️ Duration | ${elapsed}s |`);
      lines.push(`| 📄 Profile Report | \`${profileMdPath}\` |`);
      lines.push(`| 💾 Config Persisted | ${configPersisted ? '✅ workflow.config.js updated' : '⚠️ Not persisted (no config found or first run with /wf init)'} |`);
      lines.push(`| 🔬 LSP Used | ${lspUsed ? `✅ ${projectProfile.lspServerName || 'auto'}` : noLsp ? '⏭️ Skipped (--no-lsp)' : '❌ Not available (fallback to baseline)'} |`);

      if (!configPersisted && !configFilePath) {
        lines.push(``);
        lines.push(`> 💡 No \`workflow.config.js\` found. Run \`/wf init\` first to create one, then \`/analyze\` to update.`);
      }

      return lines.join('\n');
    }
  );

}

module.exports = { registerAnalyzeCommands };
