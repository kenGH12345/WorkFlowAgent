/**
 * Workflow Commands – Core workflow lifecycle commands.
 *
 * Commands:
 *   /ask-workflow-agent  – Start or resume a workflow (sequential)
 *   /wf                  – Smart workflow entry (supports --auto, --sequential, --parallel, init)
 *   /wf-tasks            – Run a goal via parallel task-based execution
 *   /workflow-status     – Show current workflow state
 *   /workflow-reset      – Delete manifest and start fresh
 *   /workflow-artifacts  – List all produced artifacts
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../core/constants');

/**
 * Registers workflow commands into the shared command registry.
 *
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerWorkflowCommands(registerCommand) {

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
    'Smart workflow entry: defaults to full sequential pipeline. Supports --auto, --sequential, --parallel [--concurrency <n>], and "init" sub-command.',
    async (args, context) => {
      if (!args) {
        return [
          `Usage:`,
          `  /wf <requirement>                         – Run full sequential pipeline (default)`,
          `  /wf <requirement> --auto                  – Smart auto-dispatch (LLM decides seq vs parallel)`,
          `  /wf <requirement> --sequential            – Force sequential mode (same as default)`,
          `  /wf <requirement> --parallel              – Force parallel (LLM decomposes tasks)`,
          `  /wf <requirement> --parallel --concurrency <n>  – Parallel with custom concurrency`,
          `  /wf init [--path <dir>]                   – Initialise the workflow for a project`,
          `  /wf 初始化工作流 [--path <dir>]           – Same as above (Chinese alias)`,
          `  /wf analyze [--no-lsp] [--max-files <N>]   – Re-analyze project architecture (standalone)`,
          ``,
          `Default behaviour:`,
  `  • /wf <requirement> runs the FULL sequential pipeline: ANALYSE → ARCHITECT → PLAN → CODE → TEST`,
          `  • Use --auto to let the LLM decide whether to run sequentially or in parallel`,
          `  • Use --parallel to force parallel task-based execution`,
          ``,
          `Examples:`,
          `  /wf Build a REST API for user management`,
          `  /wf Build a user module and a payment module --auto`,
          `  /wf Refactor the auth service --parallel`,
          `  /wf init`,
          `  /wf init --path D:\\MyProject`,
          `  /wf analyze`,
          `  /wf analyze --no-lsp`,
          `  /wf analyze --max-files 200`,
        ].join('\n');
      }

      // ── Analyze sub-command ────────────────────────────────────────────────
      const trimmedArgs = args.trim();
      const isAnalyzeCmd = /^analyze(\s|$)/i.test(trimmedArgs);

      if (isAnalyzeCmd) {
        // Delegate to the /analyze command, stripping the 'analyze' prefix
        const analyzeArgs = trimmedArgs.replace(/^analyze\s*/i, '').trim();
        const { dispatch } = require('./command-router');
        return dispatch(`/analyze ${analyzeArgs}`, context);
      }

      // ── Init sub-command ──────────────────────────────────────────────────
      const isInitCmd = /^(init|初始化工作流)(\s|$)/i.test(trimmedArgs);

      if (isInitCmd) {
        // Extract optional --path argument
        const pathMatch = trimmedArgs.match(/--path\s+(\S+)/);
        const dryRun    = trimmedArgs.includes('--dry-run');
        const validate  = trimmedArgs.includes('--validate');

        // Resolve the target project root:
        //   1. Explicit --path takes priority
        //   2. orchestrator.projectRoot (when running inside a workflow session)
        //   3. No fallback – require the user to specify --path explicitly
        const targetRoot = pathMatch
          ? path.resolve(pathMatch[1])
          : (context.orchestrator?.projectRoot || null);

        if (!targetRoot) {
          return [
            `❌ Cannot determine target project root.`,
            ``,
            `No --path argument provided and no active orchestrator session.`,
            `Please specify the project path explicitly:`,
            ``,
            `  /wf init --path <project-directory>`,
            ``,
            `Example:`,
            `  /wf init --path D:\\MyProject`,
          ].join('\n');
        }

        const { spawn } = require('child_process');
        const scriptPath = path.join(__dirname, '..', 'init-project.js');

        if (!fs.existsSync(scriptPath)) {
          return `❌ init-project.js not found at: ${scriptPath}`;
        }

        // Always pass --path explicitly to ensure init-project.js uses the
        // correct projectRoot (not its own cwd, which could be the workflow/ dir).
        const spawnArgs = [scriptPath, '--path', targetRoot];
        if (dryRun)     spawnArgs.push('--dry-run');
        if (validate)   spawnArgs.push('--validate');

        console.log(`[wf init] Running: node ${scriptPath} ${spawnArgs.slice(1).join(' ')}`);

        return new Promise((resolve) => {
          const chunks = [];
          const child = spawn(process.execPath, spawnArgs, {
            cwd: targetRoot,
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

      // ── Input length guard ────────────────────────────────────────────────
      // Prevent excessively long requirements from blowing up the LLM token budget.
      // 8000 chars ≈ ~2000 tokens, which is a reasonable upper bound for a requirement.
      const MAX_REQUIREMENT_CHARS = 8000;
      if (trimmedArgs.length > MAX_REQUIREMENT_CHARS) {
        return [
          `❌ Requirement too long (${trimmedArgs.length} chars, max ${MAX_REQUIREMENT_CHARS}).`,
          ``,
          `Please shorten your requirement to under ${MAX_REQUIREMENT_CHARS} characters.`,
          `Tip: Focus on the core feature. Detailed specs can go in AGENTS.md or a separate file.`,
        ].join('\n');
      }

      // ── Debug: log raw args for diagnosing @ file reference format ──────
      console.log(`[wf] Raw args received from IDE:\n---\n${args}\n---`);
      console.log(`[wf] Args length: ${args.length} chars`);

      // Support --parallel / --auto flags to control execution mode
      // --sequential is accepted but redundant (sequential is the default).
      const forceParallel   = trimmedArgs.includes('--parallel');
      const forceAuto       = trimmedArgs.includes('--auto');
      const concurrencyMatch = trimmedArgs.match(/--concurrency\s+(\d+)/);
      const concurrency = concurrencyMatch ? parseInt(concurrencyMatch[1], 10) : 3;

      // Strip mode flags from the requirement text
      const requirement = args
        .replace(/--sequential/g, '')
        .replace(/--parallel/g, '')
        .replace(/--auto/g, '')
        .replace(/--concurrency\s+\d+/g, '')
        .trim();

      if (!requirement) {
        return [
          `Usage:`,
          `  /wf <your requirement>                    – Run full sequential pipeline (default)`,
          `  /wf <requirement> --auto                  – Smart auto-dispatch (LLM decides)`,
          `  /wf <requirement> --sequential            – Force sequential mode (same as default)`,
          `  /wf <requirement> --parallel              – Force parallel mode (LLM decomposes tasks)`,
          `  /wf <requirement> --parallel --concurrency <n>  – Parallel with custom concurrency`,
          `  /wf init [--path <dir>]                   – Initialise the workflow for a project`,
          `  /wf analyze [--no-lsp] [--max-files <N>]  – Re-analyze project architecture`,
          ``,
          `Examples:`,
          `  /wf Build a REST API for user management`,
          `  /wf Build a user module and a payment module --auto`,
          `  /wf Refactor the auth service --parallel`,
          `  /wf analyze`,
          `  /wf analyze --no-lsp`,
        ].join('\n');
      }

      if (forceParallel) {
        // Force parallel: use runAuto but hint the LLM to prefer parallel decomposition
        console.log(`[wf] Force parallel mode. Auto-decomposing: "${requirement}"`);
        await context.orchestrator.runAuto(requirement, concurrency);
        return `✅ Workflow complete (parallel). Requirement: "${requirement}"`;
      }

      if (forceAuto) {
        // Explicit auto-dispatch: LLM decides sequential vs parallel
        console.log(`[wf] Auto-dispatch mode. Analysing requirement: "${requirement}"`);
        await context.orchestrator.runAuto(requirement, concurrency);
        return `✅ Workflow complete (auto). Requirement: "${requirement}"`;
      }

      // Default: full sequential pipeline (ANALYSE → ARCHITECT → PLAN → CODE → TEST)
      // This is the most predictable and reliable mode – always produces
      // requirement.md, architecture.md, code diff, and test report.
      console.log(`[wf] Sequential mode (default). Starting full pipeline: "${requirement}"`);
      await context.orchestrator.run(requirement);
      return `✅ Workflow complete (sequential). Requirement: "${requirement}"`;
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
      // R4-4 audit: the original regex /--tasks\s+"([^"]+)"/ would truncate if any
      // task title contained a literal " character. Improved to also match single-quoted
      // tasks string as an alternative, and greedily match to the LAST quote.
      const tasksMatch = args.match(/--tasks\s+"([^"]+)"/) || args.match(/--tasks\s+'([^']+)'/);
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

}

module.exports = { registerWorkflowCommands };
