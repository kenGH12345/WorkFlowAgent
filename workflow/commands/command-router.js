/**
 * Command Router – /ask-workflow-agent and other slash commands
 *
 * Provides high-frequency operation entry points (Requirement 6.3).
 * Parses command strings and routes them to the appropriate handler.
 *
 * Supported commands:
 *   /ask-workflow-agent <requirement>  – Start or resume a workflow (sequential)
 *   /wf <requirement>                  – Smart auto-dispatch: sequential or parallel
 *   /wf <requirement> --sequential     – Force sequential mode
 *   /wf <requirement> --parallel       – Force parallel (LLM auto-decomposes tasks)
 *   /wf-tasks <goal> --tasks "..."     – Run a goal via parallel task-based execution
 *   /workflow-status                   – Show current workflow state
 *   /workflow-reset                    – Delete manifest and start fresh
 *   /workflow-artifacts                – List all produced artifacts
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../core/constants');
const { ExperienceType, ExperienceCategory } = require('../core/experience-store');
const { ComplaintTarget, ComplaintSeverity } = require('../core/complaint-wall');

// ─── Command Registry ─────────────────────────────────────────────────────────

const COMMANDS = {};

/**
 * Registers a command handler.
 *
 * @param {string}   name    - Command name without leading slash (e.g. 'ask-workflow-agent')
 * @param {string}   description
 * @param {Function} handler - async (args: string, context: object) => string (output message)
 */
function registerCommand(name, description, handler) {
  COMMANDS[name] = { name, description, handler };
}

/**
 * Parses and dispatches a slash command string.
 *
 * @param {string} input   - Full command string (e.g. '/ask-workflow-agent Build a todo app')
 * @param {object} context - Runtime context passed to handlers (orchestrator, stateMachine, etc.)
 * @returns {Promise<string>} Output message from the handler
 */
async function dispatch(input, context = {}) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(`[CommandRouter] Not a command: "${trimmed}". Commands must start with /`);
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const commandName = parts[0];
  const args = parts.slice(1).join(' ');

  const command = COMMANDS[commandName];
  if (!command) {
    const available = Object.keys(COMMANDS).map(c => `/${c}`).join(', ');
    throw new Error(`[CommandRouter] Unknown command: "/${commandName}". Available: ${available}`);
  }

  console.log(`[CommandRouter] Dispatching: /${commandName} ${args ? `"${args}"` : ''}`);
  return command.handler(args, context);
}

// ─── Built-in Commands ────────────────────────────────────────────────────────

registerCommand(
  'ask-workflow-agent',
  'Start or resume a multi-agent workflow with the given requirement',
  async (args, context) => {
    if (!args) {
      return `Usage: /ask-workflow-agent <your requirement>\nExample: /ask-workflow-agent Build a REST API for user management`;
    }
    if (!context.orchestrator) {
      return `[Error] No orchestrator in context. Cannot start workflow.`;
    }
    console.log(`[ask-workflow-agent] Starting workflow with requirement: "${args}"`);
    await context.orchestrator.run(args);
    return `✅ Workflow started. Requirement: "${args}"`;
  }
);

// Alias: /wf → /ask-workflow-agent，支持 init / 初始化工作流 子命令
registerCommand(
  'wf',
  'Smart workflow entry: auto-detects sequential vs parallel execution. Supports --sequential, --parallel [--concurrency <n>], and "init" sub-command.',
  async (args, context) => {
    if (!args) {
      return [
        `Usage:`,
        `  /wf <requirement>                         – Auto-detect sequential vs parallel`,
        `  /wf <requirement> --sequential            – Force sequential mode`,
        `  /wf <requirement> --parallel              – Force parallel (LLM decomposes tasks)`,
        `  /wf <requirement> --parallel --concurrency <n>  – Parallel with custom concurrency`,
        `  /wf init [--path <dir>]                   – Initialise the workflow for a project`,
        `  /wf 初始化工作流 [--path <dir>]           – Same as above (Chinese alias)`,
        ``,
        `Auto-dispatch logic:`,
        `  • Single cohesive feature → sequential (ANALYSE → ARCHITECT → CODE → TEST)`,
        `  • Multiple separable modules/features → parallel task-based execution`,
        ``,
        `Examples:`,
        `  /wf Build a REST API for user management`,
        `  /wf Build a user module and a payment module and an email service`,
        `  /wf Refactor the auth service --sequential`,
        `  /wf init`,
        `  /wf init --path D:\\MyProject`,
      ].join('\n');
    }

    // ── Init sub-command ──────────────────────────────────────────────────
    const trimmedArgs = args.trim();
    const isInitCmd = /^(init|初始化工作流)(\s|$)/i.test(trimmedArgs);

    if (isInitCmd) {
      // Extract optional --path argument
      const pathMatch = trimmedArgs.match(/--path\s+(\S+)/);
      const dryRun    = trimmedArgs.includes('--dry-run');
      const validate  = trimmedArgs.includes('--validate');

      const { spawn } = require('child_process');
      const scriptPath = path.join(__dirname, '..', 'init-project.js');

      if (!fs.existsSync(scriptPath)) {
        return `❌ init-project.js not found at: ${scriptPath}`;
      }

      const spawnArgs = [scriptPath];
      if (pathMatch)  spawnArgs.push('--path', pathMatch[1]);
      if (dryRun)     spawnArgs.push('--dry-run');
      if (validate)   spawnArgs.push('--validate');

      console.log(`[wf init] Running: node ${scriptPath} ${spawnArgs.slice(1).join(' ')}`);

      return new Promise((resolve) => {
        const chunks = [];
        const child = spawn(process.execPath, spawnArgs, {
          cwd: pathMatch ? pathMatch[1] : path.dirname(scriptPath),
          timeout: 120000,
        });

        child.stdout.on('data', (d) => { process.stdout.write(d); chunks.push(d.toString()); });
        child.stderr.on('data', (d) => { process.stderr.write(d); chunks.push(d.toString()); });

        child.on('close', (code) => {
          const output = chunks.join('');
          if (code === 0) {
            resolve(`✅ Workflow initialisation complete.\n\`\`\`\n${output.slice(-2000)}\n\`\`\``);
          } else {
            resolve(`❌ Workflow initialisation failed (exit ${code}):\n${output.slice(-1000)}`);
          }
        });

        child.on('error', (err) => {
          resolve(`❌ Failed to run init-project.js: ${err.message}`);
        });
      });
    }

    // ── Normal workflow start (auto-dispatch) ────────────────────────────
    if (!context.orchestrator) {
      return `[Error] No orchestrator in context. Cannot start workflow.`;
    }

    // Support --sequential / --parallel flags to force a specific mode
    const forceSequential = trimmedArgs.includes('--sequential');
    const forceParallel   = trimmedArgs.includes('--parallel');
    const concurrencyMatch = trimmedArgs.match(/--concurrency\s+(\d+)/);
    const concurrency = concurrencyMatch ? parseInt(concurrencyMatch[1], 10) : 3;

    // Strip mode flags from the requirement text
    const requirement = args
      .replace(/--sequential/g, '')
      .replace(/--parallel/g, '')
      .replace(/--concurrency\s+\d+/g, '')
      .trim();

    if (!requirement) {
      return [
        `Usage:`,
        `  /wf <your requirement>                    – Auto-detect sequential vs parallel`,
        `  /wf <requirement> --sequential            – Force sequential mode`,
        `  /wf <requirement> --parallel              – Force parallel mode (LLM decomposes tasks)`,
        `  /wf <requirement> --parallel --concurrency <n>  – Parallel with custom concurrency`,
        `  /wf init [--path <dir>]                   – Initialise the workflow for a project`,
        ``,
        `Examples:`,
        `  /wf Build a REST API for user management`,
        `  /wf Build a user module and a payment module --parallel`,
        `  /wf Refactor the auth service --sequential`,
      ].join('\n');
    }

    if (forceSequential) {
      console.log(`[wf] Force sequential mode. Starting workflow: "${requirement}"`);
      await context.orchestrator.run(requirement);
      return `✅ Workflow complete (sequential). Requirement: "${requirement}"`;
    }

    if (forceParallel) {
      // Force parallel: use runAuto but hint the LLM to prefer parallel decomposition
      console.log(`[wf] Force parallel mode. Auto-decomposing: "${requirement}"`);
      await context.orchestrator.runAuto(requirement, concurrency);
      return `✅ Workflow complete (parallel). Requirement: "${requirement}"`;
    }

    // Default: smart auto-dispatch
    console.log(`[wf] Auto-dispatch mode. Analysing requirement: "${requirement}"`);
    await context.orchestrator.runAuto(requirement, concurrency);
    return `✅ Workflow complete. Requirement: "${requirement}"`;
  }
);

// ─── /wf-tasks ────────────────────────────────────────────────────────────────
// Triggers runTaskBased() from the command line.
//
// Syntax:
//   /wf-tasks <goal> --tasks "<title1>|<title2>[dep:<title1>]|<title3>[dep:<title1>,<title2>]" [--concurrency <n>]
//
// Task format (pipe-separated):
//   <title>                          – no dependencies
//   <title>[dep:<dep1>,<dep2>]       – depends on tasks with those titles
//
// Example:
//   /wf-tasks Refactor user module --tasks "Analyse existing structure|Design new interface[dep:Analyse existing structure]|Implement UserService[dep:Design new interface]|Write unit tests[dep:Implement UserService]" --concurrency 2
registerCommand(
  'wf-tasks',
  'Run a goal using parallel task-based execution. Usage: /wf-tasks <goal> --tasks "<t1>|<t2>[dep:<t1>]|..." [--concurrency <n>]',
  async (args, context) => {
    if (!args || !args.includes('--tasks')) {
      return [
        `Usage:`,
        `  /wf-tasks <goal> --tasks "<tasks>" [--concurrency <n>]`,
        ``,
        `Task format (pipe-separated, each task optionally has [dep:...]):`,
        `  <title>                         – no dependencies`,
        `  <title>[dep:<dep1>,<dep2>]      – depends on other task titles`,
        ``,
        `Examples:`,
        `  /wf-tasks "Refactor user module" --tasks "Analyse structure|Design interface[dep:Analyse structure]|Implement service[dep:Design interface]|Write tests[dep:Implement service]"`,
        `  /wf-tasks "Build REST API" --tasks "Design schema|Implement endpoints[dep:Design schema]|Write tests[dep:Implement endpoints]" --concurrency 2`,
      ].join('\n');
    }

    if (!context.orchestrator) {
      return `[Error] No orchestrator in context. Cannot start task-based workflow.`;
    }

    // ── Parse --tasks ──────────────────────────────────────────────────────
    const tasksMatch = args.match(/--tasks\s+"([^"]+)"/);
    if (!tasksMatch) {
      return `❌ Could not parse --tasks. Make sure to wrap the task list in double quotes.\n\nExample: --tasks "Task A|Task B[dep:Task A]|Task C[dep:Task A,Task B]"`;
    }

    // ── Parse --concurrency ────────────────────────────────────────────────
    const concurrencyMatch = args.match(/--concurrency\s+(\d+)/);
    const concurrency = concurrencyMatch ? parseInt(concurrencyMatch[1], 10) : 3;

    // ── Parse goal (everything before the first --flag) ────────────────────
    const goal = args.replace(/--tasks\s+"[^"]+"/, '').replace(/--concurrency\s+\d+/, '').trim();
    if (!goal) {
      return `❌ Missing goal. Provide a goal description before the --tasks flag.\n\nExample: /wf-tasks "Refactor user module" --tasks "..."`;
    }

    // ── Build taskDefs from pipe-separated task string ─────────────────────
    // Format: "Title A|Title B[dep:Title A]|Title C[dep:Title A,Title B]"
    const rawTasks = tasksMatch[1].split('|').map(s => s.trim()).filter(Boolean);
    if (rawTasks.length === 0) {
      return `❌ No tasks found in --tasks value. Use pipe (|) to separate tasks.`;
    }

    // Build a title → id map first (id = task-1, task-2, ...)
    const titleToId = {};
    rawTasks.forEach((raw, i) => {
      const title = raw.replace(/\[dep:[^\]]*\]/g, '').trim();
      titleToId[title] = `task-${i + 1}`;
    });

    const taskDefs = rawTasks.map((raw, i) => {
      // Extract optional [dep:...] block
      const depMatch = raw.match(/\[dep:([^\]]+)\]/);
      const title = raw.replace(/\[dep:[^\]]*\]/g, '').trim();
      const id = `task-${i + 1}`;

      let deps = [];
      if (depMatch) {
        deps = depMatch[1].split(',').map(d => {
          const depTitle = d.trim();
          const depId = titleToId[depTitle];
          if (!depId) {
            console.warn(`[wf-tasks] Warning: dependency "${depTitle}" not found in task list. Skipping.`);
          }
          return depId;
        }).filter(Boolean);
      }

      return { id, title, deps };
    });

    // ── Summary before execution ───────────────────────────────────────────
    const taskSummary = taskDefs.map((t, i) =>
      `  ${i + 1}. [${t.id}] ${t.title}${t.deps.length ? ` (deps: ${t.deps.join(', ')})` : ''}`
    ).join('\n');

    console.log(`[wf-tasks] Starting task-based workflow:`);
    console.log(`  Goal: "${goal}"`);
    console.log(`  Tasks (${taskDefs.length}):\n${taskSummary}`);
    console.log(`  Concurrency: ${concurrency}`);

    await context.orchestrator.runTaskBased(goal, taskDefs, concurrency);

    return [
      `✅ Task-based workflow complete.`,
      ``,
      `**Goal**: ${goal}`,
      `**Tasks**: ${taskDefs.length} | **Concurrency**: ${concurrency}`,
      ``,
      taskDefs.map((t, i) => `${i + 1}. ${t.title}${t.deps.length ? ` ← ${t.deps.join(', ')}` : ''}`).join('\n'),
    ].join('\n');
  }
);

registerCommand(
  'workflow-status',
  'Show the current state of the workflow',
  async (_args, context) => {
    if (!fs.existsSync(PATHS.MANIFEST)) {
      return `No active workflow found. Start one with: /ask-workflow-agent <requirement>`;
    }
    const manifest = JSON.parse(fs.readFileSync(PATHS.MANIFEST, 'utf-8'));
    const lines = [
      `## Workflow Status`,
      `- **Project ID**: ${manifest.projectId}`,
      `- **Current State**: ${manifest.currentState}`,
      `- **Created**: ${manifest.createdAt}`,
      `- **Last Updated**: ${manifest.updatedAt}`,
      `- **History**: ${manifest.history.length} transitions`,
      ``,
      `### Artifacts`,
      ...Object.entries(manifest.artifacts).map(([k, v]) => `- ${k}: ${v || '_not yet produced_'}`),
      ``,
      `### Risks`,
      manifest.risks.length === 0
        ? '- No risks recorded'
        : manifest.risks.map(r => `- [${r.level.toUpperCase()}] ${r.message}`).join('\n'),
    ];
    return lines.join('\n');
  }
);

registerCommand(
  'workflow-reset',
  'Delete the current manifest and start fresh',
  async (_args, _context) => {
    if (fs.existsSync(PATHS.MANIFEST)) {
      fs.unlinkSync(PATHS.MANIFEST);
      return `✅ Workflow reset. manifest.json deleted. Run /ask-workflow-agent to start a new workflow.`;
    }
    return `No manifest.json found. Nothing to reset.`;
  }
);

registerCommand(
  'workflow-artifacts',
  'List all artifact files produced by the current workflow',
  async (_args, _context) => {
    if (!fs.existsSync(PATHS.OUTPUT_DIR)) {
      return `No output directory found. No artifacts produced yet.`;
    }
    const files = fs.readdirSync(PATHS.OUTPUT_DIR);
    if (files.length === 0) {
      return `Output directory is empty. No artifacts produced yet.`;
    }
    const lines = [`## Workflow Artifacts (${files.length} files)\n`];
    for (const file of files) {
      const fullPath = path.join(PATHS.OUTPUT_DIR, file);
      const stat = fs.statSync(fullPath);
      lines.push(`- **${file}** (${stat.size} bytes, modified: ${stat.mtime.toISOString()})`);
    }
    return lines.join('\n');
  }
);

// ─── AgentFlow Commands ───────────────────────────────────────────────────────

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
  'Scan project code and populate experience store [--path <dir>] [--ext .cs,.lua] [--dry-run]',
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
  'Search experiences: --keyword <text> [--category <cat>] [--skill <name>] [--type positive|negative]',
  async (args, context) => {
    if (!context.orchestrator) return `[Error] No orchestrator in context.`;
    const kwMatch  = args.match(/--keyword\s+"([^"]+)"/);
    const catMatch = args.match(/--category\s+(\S+)/);
    const skillMatch = args.match(/--skill\s+(\S+)/);
    const typeMatch  = args.match(/--type\s+(\S+)/);

    if (!kwMatch && !catMatch && !skillMatch && !typeMatch) {
      return `Usage: /experience-search --keyword "event system" [--category event_system] [--skill unity-csharp] [--type positive]`;
    }

    const results = context.orchestrator.experienceStore.search({
      keyword:  kwMatch  ? kwMatch[1]  : null,
      category: catMatch ? catMatch[1] : null,
      skill:    skillMatch ? skillMatch[1] : null,
      type:     typeMatch  ? typeMatch[1]  : null,
      limit: 15,
      scoreSort: true,
    });

    if (results.length === 0) return `No experiences found for your query.`;

    const lines = [`## Search Results (${results.length} found)\n`];
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
  'Build or query the structured code graph. Usage: /graph [build] [search <keyword>] [file <path>] [calls <symbol>]',
  async (args, context) => {
    const { CodeGraph } = require('../core/code-graph');
    const { PATHS }     = require('../core/constants');
    const projectRoot   = context.orchestrator?.projectRoot || path.resolve(__dirname, '..', '..');
    const cfg           = context.orchestrator?._config || {};

    const graph = new CodeGraph({
      projectRoot,
      outputDir:  PATHS.OUTPUT_DIR,
      extensions: cfg.sourceExtensions,
      ignoreDirs: cfg.ignoreDirs,
    });

    // /graph build – rebuild the index
    if (!args || args.trim() === '' || args.includes('build')) {
      const result = await graph.build();
      return [
        `✅ **Code Graph Built**`,
        ``,
        `- Symbols indexed: **${result.symbolCount}**`,
        `- Files scanned:   **${result.fileCount}**`,
        `- Call edges:      **${result.edgeCount}**`,
        ``,
        `📄 Index: \`output/code-graph.json\``,
        `📄 Summary: \`output/code-graph.md\``,
        ``,
        `> Use \`/graph search <keyword>\` to query the index.`,
      ].join('\n');
    }

    // Load existing graph from disk for queries
    const loadGraph = () => {
      const jsonPath = path.join(PATHS.OUTPUT_DIR, 'code-graph.json');
      if (!fs.existsSync(jsonPath)) return null;
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        // Restore symbols map
        for (const sym of data.symbols || []) graph._symbols.set(sym.id, sym);
        for (const [k, v] of Object.entries(data.callEdges || {})) graph._callEdges.set(k, v);
        return data;
      } catch (_) { return null; }
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
        const calls = (graph._callEdges.get(s.id) || []).length;
        lines.push(`- \`${s.kind}\` **${s.name}** in \`${s.file}\`:${s.line}${calls ? ` → ${calls} call(s)` : ''}${s.summary ? `\n  > ${s.summary}` : ''}`);
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

    return `Usage: \`/graph build\` | \`/graph search <keyword>\` | \`/graph file <path>\` | \`/graph calls <symbol>\``;
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
  'help',
  'List all available commands with descriptions',
  async () => {
    const lines = [`## Available Commands\n`];
    for (const [name, cmd] of Object.entries(COMMANDS)) {
      lines.push(`- **/${name}** – ${cmd.description}`);
    }
    return lines.join('\n');
  }
);

module.exports = { dispatch, registerCommand, COMMANDS };
