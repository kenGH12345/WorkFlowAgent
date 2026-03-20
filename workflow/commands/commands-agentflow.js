/**
 * AgentFlow Commands – Task, experience, skill, and complaint management.
 *
 * Commands:
 *   /agentflow-status   – Show AgentFlow system status
 *   /task-list           – List all tasks with status
 *   /experience-list     – List accumulated experiences
 *   /record-experience   – Record a new experience
 *   /file-complaint      – File a complaint
 *   /skill-list          – List all registered skills
 *   /complaint-list      – List open complaints
 *   /experience-scan     – Scan project code to populate experience store
 *   /experience-search   – Search experiences with query expansion
 *   /experience-synonyms – Manage synonym table
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ExperienceType, ExperienceCategory } = require('../core/experience-store');
const { ComplaintTarget, ComplaintSeverity } = require('../core/complaint-wall');

/**
 * Registers AgentFlow commands into the shared command registry.
 *
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerAgentFlowCommands(registerCommand) {

  registerCommand(
    'agentflow-status',
    'Show AgentFlow system status: tasks, experiences, skills, complaints',
    async (_args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      return context.orchestrator.getSystemStatus();
    }
  );

  registerCommand(
    'task-list',
    'List all tasks with their current status',
    async (_args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      const tasks = context.orchestrator.taskManager.getAllTasks();
      if (tasks.length === 0) return `No tasks registered yet.`;
      const lines = [`## Task List (${tasks.length} tasks)\n`];
      for (const t of tasks) {
        const icon = { done: '✅', running: '🔄', pending: '⏳', blocked: '🔒', failed: '❌', interrupted: '⚡', exhausted: '💀' }[t.status] || '?';
        lines.push(`${icon} **[${t.id}]** ${t.title} \`${t.status}\``);
        if (t.deps.length > 0) lines.push(`   ↳ depends on: ${t.deps.join(', ')}`);
      }
      return lines.join('\n');
    }
  );

  registerCommand(
    'experience-list',
    'List accumulated experiences [--type positive|negative] [--skill <name>]',
    async (args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      const typeMatch = args.match(/--type\s+(\w+)/);
      const skillMatch = args.match(/--skill\s+(\S+)/);
      const exps = context.orchestrator.experienceStore.search({
        type: typeMatch ? typeMatch[1] : null,
        skill: skillMatch ? skillMatch[1] : null,
        limit: 20,
      });
      if (exps.length === 0) return `No experiences found.`;
      const stats = context.orchestrator.experienceStore.getStats();
      const lines = [
        `## Experience Store (${stats.total} total: ✅${stats.positive} / ❌${stats.negative})\n`,
      ];
      for (const e of exps) {
        const icon = e.type === 'positive' ? '✅' : '❌';
        lines.push(`${icon} **[${e.category}]** ${e.title} *(used ${e.hitCount}x)*`);
      }
      return lines.join('\n');
    }
  );

  registerCommand(
    'record-experience',
    'Record a new experience: --type positive|negative --title "..." --content "..." [--skill <name>]',
    async (args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      const typeMatch = args.match(/--type\s+(\w+)/);
      const titleMatch = args.match(/--title\s+"([^"]+)"/);
      const contentMatch = args.match(/--content\s+"([^"]+)"/);
      const skillMatch = args.match(/--skill\s+(\S+)/);
      const categoryMatch = args.match(/--category\s+(\S+)/);

      if (!typeMatch || !titleMatch || !contentMatch) {
        return `Usage: /record-experience --type positive|negative --title "..." --content "..." [--skill <name>] [--category <cat>]`;
      }

      const exp = context.orchestrator.recordExperience({
        type: typeMatch[1] === 'positive' ? ExperienceType.POSITIVE : ExperienceType.NEGATIVE,
        category: categoryMatch ? categoryMatch[1] : ExperienceCategory.STABLE_PATTERN,
        title: titleMatch[1],
        content: contentMatch[1],
        skill: skillMatch ? skillMatch[1] : null,
      });
      return `✅ Experience recorded: **${exp.id}** – "${exp.title}"`;
    }
  );

  registerCommand(
    'file-complaint',
    'File a complaint: --target experience|skill|workflow|tool --id <targetId> --severity frustrating|annoying|minor --desc "..." --fix "..."',
    async (args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      const targetMatch = args.match(/--target\s+(\w+)/);
      const idMatch = args.match(/--id\s+(\S+)/);
      const severityMatch = args.match(/--severity\s+(\w+)/);
      const descMatch = args.match(/--desc\s+"([^"]+)"/);
      const fixMatch = args.match(/--fix\s+"([^"]+)"/);

      if (!targetMatch || !idMatch || !severityMatch || !descMatch || !fixMatch) {
        return `Usage: /file-complaint --target experience|skill|workflow|tool --id <id> --severity frustrating|annoying|minor --desc "..." --fix "..."`;
      }

      const complaint = context.orchestrator.fileComplaint({
        targetType: targetMatch[1],
        targetId: idMatch[1],
        severity: severityMatch[1],
        description: descMatch[1],
        suggestion: fixMatch[1],
      });
      return `🗣️ Complaint filed: **${complaint.id}** [${complaint.severity}] – "${complaint.description}"`;
    }
  );

  registerCommand(
    'skill-list',
    'List all registered skills with evolution counts',
    async (_args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      const skills = context.orchestrator.skillEvolution.listSkills();
      if (skills.length === 0) return `No skills registered yet.`;
      const lines = [`## Skills (${skills.length} total)\n`];
      for (const s of skills) {
        lines.push(`- **${s.name}** v${s.version} | evolved ×${s.evolutionCount} | ${s.description}`);
      }
      return lines.join('\n');
    }
  );

  registerCommand(
    'complaint-list',
    'List open complaints sorted by severity',
    async (_args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      return context.orchestrator.complaintWall.getSummaryText();
    }
  );

  registerCommand(
    'experience-scan',
    'Scan project code and populate experience store [--path <dir>] [--ext .js,.ts,...] [--dry-run]',
    async (args, context) => {
      const pathMatch = args.match(/--path\s+(\S+)/);
      const extMatch  = args.match(/--ext\s+(\S+)/);
      const maxMatch  = args.match(/--max-files\s+(\d+)/);
      const dryRun    = args.includes('--dry-run');

      const { spawn } = require('child_process');
      const scriptPath = path.join(__dirname, '..', 'gen-experiences.js');

      if (!fs.existsSync(scriptPath)) {
        return `❌ gen-experiences.js not found at: ${scriptPath}`;
      }

      const spawnArgs = [scriptPath];
      if (pathMatch) spawnArgs.push('--path', pathMatch[1]);
      if (extMatch)  spawnArgs.push('--ext', extMatch[1]);
      if (maxMatch)  spawnArgs.push('--max-files', maxMatch[1]);
      if (dryRun)    spawnArgs.push('--dry-run');

      return new Promise((resolve) => {
        const chunks = [];
        const child = spawn(process.execPath, spawnArgs, {
          cwd: path.dirname(scriptPath),
          timeout: 60000,
        });

        child.stdout.on('data', (d) => chunks.push(d.toString()));
        child.stderr.on('data', (d) => chunks.push(d.toString()));

        child.on('close', (code) => {
          const output = chunks.join('');
          if (code === 0) {
            resolve(`✅ Experience scan complete:\n\`\`\`\n${output.slice(-1500)}\n\`\`\``);
          } else {
            resolve(`❌ Experience scan failed (exit ${code}):\n${output.slice(-800)}`);
          }
        });

        child.on('error', (err) => {
          resolve(`❌ Experience scan error: ${err.message}`);
        });
      });
    }
  );

  registerCommand(
    'experience-search',
    'Search experiences: --keyword <text> [--category <cat>] [--skill <name>] [--type positive|negative] [--expand]',
    async (args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      const kwMatch  = args.match(/--keyword\s+"([^"]+)"/);
      const catMatch = args.match(/--category\s+(\S+)/);
      const skillMatch = args.match(/--skill\s+(\S+)/);
      const typeMatch  = args.match(/--type\s+(\S+)/);
      const expandFlag = /--expand/.test(args);

      if (!kwMatch && !catMatch && !skillMatch && !typeMatch) {
        return `Usage: /experience-search --keyword "event system" [--category event_system] [--skill unity-csharp] [--type positive] [--expand]`;
      }

      // Query Expansion: when --expand flag is set, expand the keyword using
      // the persistent synonym table (instant) or LLM fallback (1-3s).
      let searchKeyword = kwMatch ? kwMatch[1] : null;
      let expandedTerms = null;
      if (expandFlag && searchKeyword) {
        const { extractKeywords } = require('../core/experience-store');
        const baseKeywords = extractKeywords(searchKeyword, 10);
        if (baseKeywords.length > 0) {
          const expanded = await context.orchestrator.experienceStore._expandKeywordsWithLlm(
            baseKeywords, skillMatch ? skillMatch[1] : null
          );
          expandedTerms = expanded.filter(t => !baseKeywords.includes(t));
          searchKeyword = expanded.join(' ');
        }
      }

      const results = context.orchestrator.experienceStore.search({
        keyword:  searchKeyword,
        category: catMatch ? catMatch[1] : null,
        skill:    skillMatch ? skillMatch[1] : null,
        type:     typeMatch  ? typeMatch[1]  : null,
        limit: 15,
        scoreSort: true,
      });

      if (results.length === 0) {
        const expandInfo = expandedTerms && expandedTerms.length > 0
          ? `\n🧠 Expanded terms: ${expandedTerms.join(', ')}`
          : '';
        return `No experiences found for your query.${expandInfo}`;
      }

      const lines = [`## Search Results (${results.length} found)\n`];
      if (expandedTerms && expandedTerms.length > 0) {
        lines.push(`🧠 **Query Expansion**: +${expandedTerms.length} terms: [${expandedTerms.join(', ')}]\n`);
      }
      for (const e of results) {
        const icon = e.type === 'positive' ? '✅' : '❌';
        lines.push(`${icon} **[${e.category}]** ${e.title}`);
        if (e.sourceFile) lines.push(`   📄 \`${e.sourceFile}\``);
        lines.push(`   Tags: ${e.tags.join(', ')} | Used: ${e.hitCount}x`);
        lines.push('');
      }
      return lines.join('\n');
    }
  );

  registerCommand(
    'experience-synonyms',
    'Manage synonym table: --stats | --import <path> | --list [--top N] | --clear',
    async (args, context) => {
      if (!context.orchestrator) return `[Error] No orchestrator in context.`;
      const store = context.orchestrator.experienceStore;

      // --stats: show synonym table statistics
      if (/--stats/.test(args)) {
        const stats = store.getSynonymStats();
        const lines = [
          `## 📖 Synonym Table Statistics\n`,
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Total Entries | ${stats.entryCount} |`,
          `| Total Hits | ${stats.totalHits} |`,
          `| Cold Start % | ${stats.coldStartPct}% (entries never reused) |`,
          ``,
        ];
        if (stats.topEntries.length > 0) {
          lines.push(`### Top ${stats.topEntries.length} Most-Used Expansions\n`);
          for (const e of stats.topEntries) {
            lines.push(`- **[${e.keywords.join(', ')}]** → [${e.expandedTerms.join(', ')}] (${e.hitCount} hits, skill: ${e.skill || 'any'})`);
          }
        }
        return lines.join('\n');
      }

      // --import <path>: import synonym table from another project
      const importMatch = args.match(/--import\s+(\S+)/);
      if (importMatch) {
        const fs = require('fs');
        const importPath = importMatch[1];
        try {
          if (!fs.existsSync(importPath)) {
            return `[Error] File not found: ${importPath}`;
          }
          const externalTable = JSON.parse(fs.readFileSync(importPath, 'utf-8'));
          const result = store.importSynonymTable(externalTable);
          return `✅ Synonym table import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.total} total entries.`;
        } catch (err) {
          return `[Error] Failed to import synonym table: ${err.message}`;
        }
      }

      // --list [--top N]: list synonym entries
      const topMatch = args.match(/--top\s+(\d+)/);
      const topN = topMatch ? parseInt(topMatch[1], 10) : 20;
      if (/--list/.test(args)) {
        const entries = Object.entries(store._synonymTable);
        if (entries.length === 0) return `Synonym table is empty. Run workflows to auto-populate it.`;
        const sorted = entries.sort((a, b) => (b[1].hitCount || 0) - (a[1].hitCount || 0)).slice(0, topN);
        const lines = [`## 📖 Synonym Table (top ${topN} of ${entries.length})\n`];
        for (const [key, val] of sorted) {
          const keywords = key.split('|');
          lines.push(`- **[${keywords.join(', ')}]** → [${val.expandedTerms.join(', ')}] (${val.hitCount || 0} hits)`);
        }
        return lines.join('\n');
      }

      // --clear: clear synonym table
      if (/--clear/.test(args)) {
        store._synonymTable = {};
        store._synonymTableDirty = true;
        store._saveSynonymTable();
        return `✅ Synonym table cleared.`;
      }

      return `Usage: /experience-synonyms --stats | --import <path> | --list [--top N] | --clear`;
    }
  );

}

module.exports = { registerAgentFlowCommands };
