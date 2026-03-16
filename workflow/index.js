/**
 * Orchestrator – Main workflow entry point
 *
 * Wires together all components:
 *  - StateMachine (state management + checkpoint)
 *  - FileRefBus (file-reference communication protocol)
 *  - HookSystem (lifecycle events + human review)
 *  - SocraticEngine (structured decision making)
 *  - MemoryManager (context memory)
 *  - All four Agents (Analyst, Architect, Developer, Tester)
 *  - PromptBuilder (KV-cache optimised prompts)
 *  - TaskManager (AgentFlow: task decomposition + dependency orchestration)
 *  - ExperienceStore (AgentFlow: persistent experience accumulation)
 *  - ComplaintWall (AgentFlow: error correction feedback loop)
 *  - SkillEvolutionEngine (AgentFlow: skill auto-evolution)
 *
 * Usage:
 *   const orchestrator = new Orchestrator({ projectId: 'my-project', llmCall });
 *   await orchestrator.run('Build a REST API for user management');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { StateMachine } = require('./core/state-machine');
const { FileRefBus } = require('./core/file-ref-bus');
const { MemoryManager } = require('./core/memory-manager');
const { SocraticEngine, DECISION_QUESTIONS } = require('./core/socratic-engine');
const { HookSystem } = require('./hooks/hook-system');
const { AnalystAgent } = require('./agents/analyst-agent');
const { ArchitectAgent } = require('./agents/architect-agent');
const { DeveloperAgent } = require('./agents/developer-agent');
const { TesterAgent } = require('./agents/tester-agent');
const { buildAgentPrompt } = require('./core/prompt-builder');
const { WorkflowState, AgentRole, STATE_ORDER } = require('./core/types');
const { PATHS, HOOK_EVENTS } = require('./core/constants');
// AgentFlow modules
const { TaskManager, TaskStatus } = require('./core/task-manager');
const { ExperienceStore, ExperienceType, ExperienceCategory } = require('./core/experience-store');
const { ComplaintWall, ComplaintSeverity, ComplaintTarget } = require('./core/complaint-wall');
const { SkillEvolutionEngine } = require('./core/skill-evolution');
const { getConfig } = require('./core/config-loader');
const { SelfCorrectionEngine, formatClarificationReport } = require('./core/clarification-engine');
const { RequirementClarifier } = require('./core/requirement-clarifier');
const { CoverageChecker } = require('./core/coverage-checker');
const { CodeReviewAgent } = require('./core/code-review-agent');
const { ArchitectureReviewAgent } = require('./core/architecture-review-agent');
const { TestRunner } = require('./core/test-runner');
const { Observability } = require('./core/observability');
const { EntropyGC } = require('./core/entropy-gc');
const { CIIntegration } = require('./core/ci-integration');
const { CodeGraph } = require('./core/code-graph');
const { GitIntegration } = require('./core/git-integration');
const { DryRunSandbox } = require('./core/sandbox');
const _git     = require('./core/orchestrator-git');
const _stages  = require('./core/orchestrator-stages');
const _helpers = require('./core/orchestrator-helpers');
const { StageContextStore } = require('./core/stage-context-store');

class Orchestrator {
  /**
   * @param {object} options
   * @param {string}   options.projectId    - Unique project identifier
   * @param {Function} options.llmCall      - async (prompt: string) => string
   * @param {string}   [options.projectRoot]  - Root dir for memory scanning
   * @param {Function} [options.askUser]      - async (questions: string[]) => string[]
   * @param {boolean}  [options.dryRun=false] - Dry-run mode: intercept all file writes,
   *                                            record as pending ops, never touch real FS.
   *                                            Call orchestrator.sandbox.apply() to commit.
   * @param {object}   [options.git]          - Git PR workflow options
   * @param {boolean}  [options.git.enabled=false]      - Auto-create feature branch + PR on completion
   * @param {string}   [options.git.baseBranch='main']  - Target branch for the PR
   * @param {string}   [options.git.branchType='feat']  - Branch prefix: feat|fix|chore|refactor
   * @param {boolean}  [options.git.autoPush=false]     - Push branch to remote before creating PR
   * @param {boolean}  [options.git.draft=false]        - Create PR as draft
   * @param {string[]} [options.git.labels=[]]          - Labels to apply to the PR
   * @param {string[]} [options.git.reviewers=[]]       - Reviewer usernames
   */
  constructor({ projectId, llmCall, projectRoot = null, askUser = null, dryRun = false, git = {} }) {
    this.projectId = projectId;
    this.projectRoot = projectRoot || path.resolve(__dirname, '..');
    // N4 fix (revised): per-stage source-file cache for investigation tools.
    // Each stage (Architecture / Code / Test) reads a different set of files and
    // reads them at a different point in time (architecture.md doesn't exist yet
    // when ARCHITECT runs; code.diff doesn't exist yet when CODE runs).
    // Using a single shared cache would cause later stages to reuse stale content
    // from an earlier stage (e.g. CODE stage seeing the pre-review architecture.md).
    // A Map keyed by stageLabel gives each stage its own isolated cache entry.
    /** @type {Map<string, string|null>} stageLabel → cached source content */
    this._investigationSourceCacheMap = new Map();
    // askUser: async (questions: string[]) => string[]
    // Provide this callback to enable interactive requirement clarification.
    // If null, clarification is skipped (non-interactive / CI mode).
    this.askUser = askUser || null;

    // ── Dry-run / Sandbox mode ───────────────────────────────────────────────
    // When dryRun=true, all file-system writes are intercepted by DryRunSandbox.
    // The real FS is never touched until sandbox.apply() is called explicitly.
    this.dryRun = dryRun === true;
    this.sandbox = new DryRunSandbox({
      projectRoot: this.projectRoot,
      outputDir:   PATHS.OUTPUT_DIR,
      verbose:     true,
    });
    if (this.dryRun) {
      console.log(`[Orchestrator] 🧪 DRY-RUN MODE ENABLED – file writes will be intercepted.`);
      console.log(`[Orchestrator]    Call orchestrator.sandbox.apply() to commit changes.`);
    }

    // ── Git PR workflow options ──────────────────────────────────────────────
    this._gitOptions = {
      enabled:    git.enabled    ?? false,
      baseBranch: git.baseBranch ?? 'main',
      branchType: git.branchType ?? 'feat',
      autoPush:   git.autoPush   ?? false,
      draft:      git.draft      ?? false,
      labels:     git.labels     ?? [],
      reviewers:  git.reviewers  ?? [],
    };
    this.git = new GitIntegration(this.projectRoot);

    // Load project config (workflow.config.js) for this project root.
    // N46 fix: do NOT call clearConfigCache() here. N43 fix made getConfig(projectRoot)
    // bypass the module-level cache when projectRoot is provided, so clearConfigCache()
    // is redundant and harmful – it would wipe the cache entry written by MemoryManager
    // (or vice versa), breaking the "first caller writes, others reuse" invariant.
    this._config = getConfig(this.projectRoot);

    // Merge workflow.config.js git/sandbox settings as defaults (constructor args take priority)
    const cfgGit     = (this._config && this._config.git)     || {};
    const cfgSandbox = (this._config && this._config.sandbox) || {};

    // Re-apply git options with config fallback (constructor args already set above,
    // but if git={} was passed (default), config values should win)
    if (!git || Object.keys(git).length === 0) {
      this._gitOptions = {
        enabled:    cfgGit.enabled    ?? false,
        baseBranch: cfgGit.baseBranch ?? 'main',
        branchType: cfgGit.branchType ?? 'feat',
        autoPush:   cfgGit.autoPush   ?? false,
        draft:      cfgGit.draft      ?? false,
        labels:     cfgGit.labels     ?? [],
        reviewers:  cfgGit.reviewers  ?? [],
      };
    }

    // Re-apply dryRun with config fallback
    if (!dryRun && cfgSandbox.dryRun) {
      this.dryRun = true;
      console.log(`[Orchestrator] 🧪 DRY-RUN MODE ENABLED (from workflow.config.js) – file writes will be intercepted.`);
      console.log(`[Orchestrator]    Call orchestrator.sandbox.apply() to commit changes.`);
    }

    // Initialise core subsystems
    this.hooks = new HookSystem();
    this.bus = new FileRefBus();
    this.stateMachine = new StateMachine(projectId, this.hooks.getEmitter());
    this.memory = new MemoryManager(this.projectRoot);
    this.socratic = new SocraticEngine();

    // Initialise AgentFlow subsystems
    this.taskManager = new TaskManager();
    this.experienceStore = new ExperienceStore();
    // Purge expired experiences at startup to keep the store lean.
    // Negative experiences expire after 90 days, positive after 365 days (configurable via ttlDays).
    this.experienceStore.purgeExpired();
    this.complaintWall = new ComplaintWall();
    this.skillEvolution = new SkillEvolutionEngine();

    // ── StageContextStore: cross-stage semantic context propagation ──────────
    // Lazily initialised in _runAnalyst (first stage) so it's always fresh
    // for each workflow run. Exposed here so _buildInvestigationTools can
    // access it via this.stageCtx.
    this.stageCtx = null;

    // Register built-in skills
    this._registerBuiltinSkills();

    // Wrap llmCall with prompt builder
    this._rawLlmCall = llmCall;

    // ── Observability: session-level metrics collector ──────────────────────
    this.obs = new Observability(PATHS.OUTPUT_DIR, projectId);

    // ── Adaptive Strategy: derive from cross-session history ────────────────
    // Reads metrics-history.jsonl (if it exists) and adjusts retry/review counts
    // based on recent failure patterns. Falls back to config defaults if no history.
    const cfgAutoFix = (this._config && this._config.autoFixLoop) || {};
    this._adaptiveStrategy = Observability.deriveStrategy(PATHS.OUTPUT_DIR, {
      maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
      maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
      projectId:       projectId,
    });
    if (this._adaptiveStrategy.source !== 'defaults') {
      console.log(`[Orchestrator] 📈 Adaptive strategy loaded from ${this._adaptiveStrategy.source}:`);
      console.log(`[Orchestrator]    maxFixRounds=${this._adaptiveStrategy.maxFixRounds} | maxReviewRounds=${this._adaptiveStrategy.maxReviewRounds} | skipEntropyOnClean=${this._adaptiveStrategy.skipEntropyOnClean}`);
      if (this._adaptiveStrategy._debug) {
        const d = this._adaptiveStrategy._debug;
        console.log(`[Orchestrator]    (testFailRate=${d.testFailRate}, errorTrend=${d.errorTrend}, sessions=${d.sessionCount})`);
      }
    }

    // ── EntropyGC: architectural drift scanner ──────────────────────────────
    const cfg = this._config || {};
    this.entropyGC = new EntropyGC({
      projectRoot:  this.projectRoot,
      outputDir:    PATHS.OUTPUT_DIR,
      extensions:   cfg.sourceExtensions,
      ignoreDirs:   cfg.ignoreDirs,
      maxLines:     cfg.maxLines,
      docPaths:     cfg.docPaths || [],
      lintCommand:  cfg.lintCommand || null,
      llmCall:      this._rawLlmCall,
    });

    // ── CIIntegration: pipeline validation bridge ───────────────────────────
    this.ci = new CIIntegration({
      projectRoot:  this.projectRoot,
      lintCommand:  cfg.lintCommand || null,
      testCommand:  cfg.testCommand || null,
    });

    // ── CodeGraph: structured code index ───────────────────────────────────
    this.codeGraph = new CodeGraph({
      projectRoot:  this.projectRoot,
      outputDir:    PATHS.OUTPUT_DIR,
      extensions:   cfg.sourceExtensions,
      ignoreDirs:   cfg.ignoreDirs,
      llmCall:      this._rawLlmCall,
    });

    // Create agents with hook emitter
    const emitter = this.hooks.getEmitter();
    const wrappedLlm = (role) => async (prompt) => {
      // N72 fix: wrap buildAgentPrompt in try/catch so an unknown role does not
      // crash the entire task worker – fall back to the raw prompt instead.
      let optimisedPrompt = prompt;
      try {
        const result = buildAgentPrompt(role, prompt);
        optimisedPrompt = result.prompt;
        console.log(`[Orchestrator] LLM call for ${role}: ~${result.meta.estimatedTokens} tokens`);
        // Observability: record LLM call with token estimate
        this.obs.recordLlmCall(role, result.meta.estimatedTokens || 0);
      } catch (err) {
        console.warn(`[Orchestrator] buildAgentPrompt failed for role "${role}": ${err.message}. Using raw prompt.`);
        this.obs.recordLlmCall(role, 0);
      }
      return this._rawLlmCall(optimisedPrompt);
    };

    this.agents = {
      [AgentRole.ANALYST]:   new AnalystAgent(wrappedLlm(AgentRole.ANALYST), emitter),
      [AgentRole.ARCHITECT]: new ArchitectAgent(wrappedLlm(AgentRole.ARCHITECT), emitter),
      [AgentRole.DEVELOPER]: new DeveloperAgent(wrappedLlm(AgentRole.DEVELOPER), emitter),
      [AgentRole.TESTER]:    new TesterAgent(wrappedLlm(AgentRole.TESTER), emitter),
    };
  }

  // ─── Shared Workflow Lifecycle Helpers ───────────────────────────────────────

  /**
   * Shared startup sequence used by both run() and runTaskBased().
   * Initialises StateMachine, builds memory context, loads AGENTS.md, and
   * prints any open complaints so agents are aware before execution begins.
   *
   * @returns {string} resumeState – the state to resume from (from StateMachine)
   */
  async _initWorkflow() {
    // 1. Initialise state machine (handles checkpoint resume)
    const resumeState = await this.stateMachine.init();
    console.log(`[Orchestrator] StateMachine initialised. Resume state: ${resumeState}`);

    // 2. Build global memory context and cache content for Agent injection
    await this.memory.buildGlobalContext().catch(err =>
      console.warn(`[Orchestrator] Memory build warning: ${err.message}`)
    );
    // Start file watcher so AGENTS.md auto-syncs when project files change during the run.
    this.memory.startWatching();
    // Read AGENTS.md content once and cache it for all Agent stages
    this._agentsMdContent = fs.existsSync(PATHS.AGENTS_MD)
      ? fs.readFileSync(PATHS.AGENTS_MD, 'utf-8')
      : '';
    if (this._agentsMdContent) {
      console.log(`[Orchestrator] 📋 AGENTS.md loaded (${this._agentsMdContent.length} chars) – will be injected into all Agent prompts.`);
    }

    // 3. Print open complaints before starting (awareness check)
    const openComplaints = this.complaintWall.getOpenComplaints();
    if (openComplaints.length > 0) {
      console.warn(`[Orchestrator] ⚠️  ${openComplaints.length} open complaint(s) need attention:`);
      for (const c of openComplaints.slice(0, 3)) {
        console.warn(`  [${c.severity}] ${c.description}`);
      }
    }

    return resumeState;
  }

  /**
   * Shared teardown sequence used by both run() and runTaskBased().
   * Flushes risks, saves the bus log, emits WORKFLOW_COMPLETE, stops the file
   * watcher, prints the Observability dashboard, and prints the risk summary.
   *
   * @param {string} mode   - 'sequential' | 'task-based' (for WORKFLOW_COMPLETE payload)
   * @param {object} [extra] - Additional fields merged into the WORKFLOW_COMPLETE payload
   */
  async _finalizeWorkflow(mode, extra = {}) {
    // Flush all in-memory risk entries to the manifest checkpoint
    if (this.stateMachine.flushRisks) {
      this.stateMachine.flushRisks();
    }

    // Persist the inter-agent communication log
    this.bus.saveLog();

    // Emit WORKFLOW_COMPLETE so HookSystem handlers (e.g. notifications) are triggered
    await this.hooks.emit(HOOK_EVENTS.WORKFLOW_COMPLETE, {
      mode,
      projectId: this.projectId,
      ...extra,
    });

    // Stop file watcher – no more changes expected
    this.memory.stopWatching();

    // Print Observability dashboard (session metrics summary)
    this.obs.printDashboard();

    // Print accumulated risk summary
    const risks = this.stateMachine.getRisks ? this.stateMachine.getRisks() : [];
    if (risks.length > 0) {
      console.warn(`\n${'─'.repeat(60)}`);
      console.warn(`  ⚠️  RISK SUMMARY (${risks.length} item(s))`);
      console.warn(`${'─'.repeat(60)}`);
      for (const r of risks) {
        console.warn(`  [${r.severity?.toUpperCase() ?? 'UNKNOWN'}] ${r.description}`);
      }
      console.warn(`${'─'.repeat(60)}\n`);
    }

    // ── Dry-run: save report and print summary ───────────────────────────────
    if (this.dryRun && this.sandbox.pendingCount > 0) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  🧪 DRY-RUN SUMMARY: ${this.sandbox.pendingCount} pending operation(s)`);
      console.log(`${'─'.repeat(60)}`);
      const reportPath = this.sandbox.saveReport();
      console.log(`  Report saved to: ${reportPath}`);
      console.log(`  To apply changes: await orchestrator.sandbox.apply()`);
      console.log(`${'─'.repeat(60)}\n`);
      await this.hooks.emit(HOOK_EVENTS.DRYRUN_REPORT_SAVED, {
        reportPath,
        pendingCount: this.sandbox.pendingCount,
        ops: this.sandbox.getPendingOps().map(op => ({ type: op.type, path: op.relPath })),
      });
    }

    // ── Git PR workflow ──────────────────────────────────────────────────────
    // Runs after all other teardown so the PR captures the final committed state.
    // Skipped in dry-run mode (no real changes were written to FS).
    if (this._gitOptions.enabled && !this.dryRun) {
      await this._runGitPRWorkflow(mode, extra);
    }
  }

  /**
   * Smart entry point: automatically decides whether to run sequentially (run())
   * or in parallel task-based mode (runTaskBased()) based on LLM analysis of the
   * requirement.
   *
   * Decision logic:
   *   1. Ask LLM to analyse the requirement and produce a task decomposition plan.
   *   2. If the LLM returns ≥2 tasks with clear dependency structure → runTaskBased()
   *   3. If the LLM returns a single task or signals "sequential" → run()
   *   4. If LLM call fails or returns unparseable output → fall back to run()
   *
   * @param {string} rawRequirement - The user's raw requirement text
   * @param {number} [concurrency=3] - Max parallel workers (only used in task-based mode)
   */
  async runAuto(rawRequirement, concurrency = 3) {
    console.log(`\n[Orchestrator] 🤖 Auto-dispatch: analysing requirement for task decomposition...`);

    // ── Step 1: Ask LLM to decompose the requirement into tasks ──────────────
    const decompositionPrompt = [
      `You are a **Task Decomposition Analyst**. Analyse the following software requirement and decide whether it should be executed as:`,
      `  A) A single sequential workflow (ANALYSE → ARCHITECT → CODE → TEST)`,
      `  B) Multiple parallel tasks with dependencies`,
      ``,
      `## Requirement`,
      rawRequirement,
      ``,
      `## Decision Rules`,
      `- Choose **sequential** if the requirement is a single cohesive feature that naturally flows through analysis → architecture → implementation → testing.`,
      `- Choose **parallel** if the requirement contains 2 or more clearly separable sub-features or modules that can be designed/implemented independently (e.g. "Build a user module AND a payment module AND an email service").`,
      `- Parallel tasks MUST have explicit dependency relationships (e.g. "implement X" depends on "design X interface").`,
      `- Minimum 3 tasks, maximum 12 tasks for parallel mode.`,
      ``,
      `## Output Format`,
      `Respond with EXACTLY one of the following formats (no extra text):`,
      ``,
      `**If sequential:**`,
      `SEQUENTIAL`,
      ``,
      `**If parallel:**`,
      `PARALLEL`,
      `TASKS:`,
      `- <task title> [deps: none]`,
      `- <task title> [deps: <dep title 1>, <dep title 2>]`,
      `- <task title> [deps: <dep title 1>]`,
      ``,
      `Rules for TASKS:`,
      `- Each line starts with "- "`,
      `- Title must be concise (≤60 chars)`,
      `- [deps: none] means no dependencies`,
      `- [deps: X, Y] means this task depends on tasks titled X and Y`,
      `- Dependency titles must exactly match a previous task title`,
      `- Tasks must be ordered so dependencies always appear before dependents`,
    ].join('\n');

    let decompositionResult = null;
    try {
      // ── Timeout protection: LLM decomposition call capped at 30s ─────────────
      // Without this, a hung LLM service would block runAuto() indefinitely.
      // On timeout, we fall back to sequential mode gracefully.
      const DECOMPOSITION_TIMEOUT_MS = 30_000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`LLM decomposition timed out after ${DECOMPOSITION_TIMEOUT_MS}ms`)), DECOMPOSITION_TIMEOUT_MS)
      );
      const llmResponse = await Promise.race([this._rawLlmCall(decompositionPrompt), timeoutPromise]);
      decompositionResult = this._parseDecompositionResponse(llmResponse, rawRequirement);
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Task decomposition LLM call failed: ${err.message}. Falling back to sequential.`);
    }

    // ── Step 2: Dispatch based on decomposition result ────────────────────────
    if (!decompositionResult || decompositionResult.mode === 'sequential') {
      console.log(`[Orchestrator] ▶️  Auto-dispatch → sequential mode (run())`);
      return this.run(rawRequirement);
    }

    // Parallel mode
    const { taskDefs } = decompositionResult;
    console.log(`[Orchestrator] ⚡ Auto-dispatch → parallel task-based mode (${taskDefs.length} tasks, concurrency=${concurrency})`);
    console.log(`[Orchestrator] 📋 Auto-generated task plan:`);
    for (const t of taskDefs) {
      const depStr = t.deps.length > 0 ? ` (deps: ${t.deps.join(', ')})` : '';
      console.log(`  [${t.id}] ${t.title}${depStr}`);
    }

    return this.runTaskBased(rawRequirement, taskDefs, concurrency);
  }

  /**
   * Parses the LLM decomposition response into a structured result.
   * Returns { mode: 'sequential' } or { mode: 'parallel', taskDefs: [...] }.
   * Falls back to sequential on any parse error.
   *
   * @param {string} llmResponse
   * @param {string} rawRequirement - Used for fallback single-task creation
   * @returns {{ mode: string, taskDefs?: object[] }}
   */
  _parseDecompositionResponse(llmResponse, rawRequirement) {
    if (!llmResponse || !llmResponse.trim()) {
      console.warn(`[Orchestrator] Empty decomposition response. Falling back to sequential.`);
      return { mode: 'sequential' };
    }

    const text = llmResponse.trim();

    // Check for SEQUENTIAL signal
    if (/^SEQUENTIAL/m.test(text)) {
      console.log(`[Orchestrator] 📊 Decomposition result: SEQUENTIAL`);
      return { mode: 'sequential' };
    }

    // Check for PARALLEL signal
    if (!/^PARALLEL/m.test(text)) {
      console.warn(`[Orchestrator] Decomposition response did not contain SEQUENTIAL or PARALLEL. Falling back to sequential.`);
      console.warn(`[Orchestrator] Response preview: "${text.slice(0, 200)}"`);
      return { mode: 'sequential' };
    }

    // Parse TASKS: block
    const tasksBlockMatch = text.match(/^TASKS:\s*\n([\s\S]+)/m);
    if (!tasksBlockMatch) {
      console.warn(`[Orchestrator] PARALLEL declared but no TASKS: block found. Falling back to sequential.`);
      return { mode: 'sequential' };
    }

    const taskLines = tasksBlockMatch[1]
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '));

    if (taskLines.length < 2) {
      console.warn(`[Orchestrator] PARALLEL mode requires ≥2 tasks, got ${taskLines.length}. Falling back to sequential.`);
      return { mode: 'sequential' };
    }

    if (taskLines.length > 12) {
      console.warn(`[Orchestrator] PARALLEL mode has ${taskLines.length} tasks (max 12). Truncating to 12.`);
      taskLines.splice(12);
    }

    // Build title → id map
    const titleToId = {};
    const parsedTasks = [];

    for (let i = 0; i < taskLines.length; i++) {
      const line = taskLines[i].slice(2).trim(); // Remove "- " prefix
      // Extract [deps: ...] block
      const depsMatch = line.match(/\[deps:\s*([^\]]+)\]/i);
      const title = line.replace(/\[deps:[^\]]*\]/i, '').trim();
      const id = `task-${i + 1}`;

      if (!title) {
        console.warn(`[Orchestrator] Empty task title on line ${i + 1}. Skipping.`);
        continue;
      }

      titleToId[title] = id;
      parsedTasks.push({ id, title, rawDeps: depsMatch ? depsMatch[1] : 'none' });
    }

    if (parsedTasks.length < 2) {
      console.warn(`[Orchestrator] After parsing, only ${parsedTasks.length} valid task(s). Falling back to sequential.`);
      return { mode: 'sequential' };
    }

    // Resolve dependency titles → ids
    const taskDefs = parsedTasks.map(t => {
      let deps = [];
      if (t.rawDeps && t.rawDeps.trim().toLowerCase() !== 'none') {
        deps = t.rawDeps.split(',').map(d => {
          const depTitle = d.trim();
          const depId = titleToId[depTitle];
          if (!depId) {
            console.warn(`[Orchestrator] Dependency "${depTitle}" not found in task list. Skipping.`);
          }
          return depId;
        }).filter(Boolean);
      }
      return { id: t.id, title: t.title, deps };
    });

    console.log(`[Orchestrator] 📊 Decomposition result: PARALLEL (${taskDefs.length} tasks)`);
    return { mode: 'parallel', taskDefs };
  }

  // ─── Main Entry Point ─────────────────────────────────────────────────────────

  /**
   * Runs the full workflow from the given requirement string.
   * Supports checkpoint resume: if manifest.json exists, resumes from last state.
   *
   * @param {string} rawRequirement - The user's raw requirement text
   */
  async run(rawRequirement) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  CodeBuddy Multi-Agent Workflow`);
    console.log(`  Project: ${this.projectId}`);
    console.log(`${'='.repeat(60)}\n`);

    // 1–3. Shared startup: StateMachine init + memory + AGENTS.md + complaints
    const resumeState = await this._initWorkflow();

    try {
      // 4. Execute stages sequentially, skipping already-completed ones
      await this._runStage(WorkflowState.INIT, WorkflowState.ANALYSE, async () => {
        return this._runAnalyst(rawRequirement);
      }, resumeState);

      await this._runStage(WorkflowState.ANALYSE, WorkflowState.ARCHITECT, async () => {
        return this._runArchitect();
      }, resumeState);

      await this._runStage(WorkflowState.ARCHITECT, WorkflowState.CODE, async () => {
        const artifactPath = await this._runDeveloper();
        // Incremental code graph update after developer stage completes
        // (captures all new/modified code before the test stage runs)
        this._rebuildCodeGraphAsync('post-developer');
        return artifactPath;
      }, resumeState);

      await this._runStage(WorkflowState.CODE, WorkflowState.TEST, async () => {
        return this._runTester();
      }, resumeState);

      await this._runStage(WorkflowState.TEST, WorkflowState.FINISHED, async () => {
        return null; // No agent for FINISHED – just transition
      }, resumeState);

    } catch (err) {
      await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: err, state: this.stateMachine.getState() });
      throw err;
    }

    console.log(`\n[Orchestrator] Workflow complete! All artifacts in: ${PATHS.OUTPUT_DIR}`);

    // 5. Entropy GC – already ran at end of Tester stage (post-test scan).
    //    Run a final full-rebuild here only if the Tester stage was skipped
    //    (e.g. checkpoint resume that jumped past TEST) AND was NOT explicitly
    //    skipped by adaptive strategy (obs._entropySkipped flag).
    if (!this.obs._entropyResult && !this.obs._entropySkipped) {
      try {
        const gcResult = await this.entropyGC.run();
        this.obs.recordEntropyResult(gcResult);
      } catch (err) {
        console.warn(`[Orchestrator] EntropyGC scan failed (non-fatal): ${err.message}`);
      }
    } else if (this.obs._entropySkipped) {
      console.log(`[Orchestrator] ⏭️  Entropy scan already skipped by adaptive strategy – not re-running in FINISHED stage.`);
    }

    // 6. Code Graph – full rebuild at FINISHED (captures all final artifacts)
    try {
      const graphResult = await this.codeGraph.build();
      this.obs.recordCodeGraphResult(graphResult);
    } catch (err) {
      console.warn(`[Orchestrator] CodeGraph build failed (non-fatal): ${err.message}`);
    }

    // 7. Shared teardown: flushRisks + saveLog + WORKFLOW_COMPLETE + dashboard + risk summary
    await this._finalizeWorkflow('sequential', { requirement: rawRequirement });
  }

  // ─── AgentFlow: Task-based Parallel Execution ─────────────────────────────────

  /**
   * Runs a goal using AgentFlow-style task decomposition and parallel execution.
   * Tasks are decomposed, dependencies resolved, and agents claim tasks concurrently.
   *
   * @param {string} goal - High-level goal description
   * @param {object[]} taskDefs - Array of task definitions with deps
   * @param {number} [concurrency=3] - Max parallel agents
   */
  async runTaskBased(goal, taskDefs, concurrency = 3) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  AgentFlow Task-Based Execution`);
    console.log(`  Goal: ${goal}`);
    console.log(`  Tasks: ${taskDefs.length} | Concurrency: ${concurrency}`);
    console.log(`${'='.repeat(60)}\n`);

    // 1–3. Shared startup: StateMachine init + memory + AGENTS.md + complaints
    await this._initWorkflow();

    // Register all tasks
    for (const def of taskDefs) {
      this.taskManager.addTask(def);
    }

    // Reuse the adaptive strategy already derived in the constructor (this._adaptiveStrategy).
    // No need to call deriveStrategy() again – it reads the same metrics-history.jsonl file.
    const tbAdaptive = this._adaptiveStrategy;

    // Run parallel agent workers – each worker fetches fresh experience context per task
    // Wrap in try/catch so WORKFLOW_ERROR is emitted on unexpected failures (mirrors run())
    const workers = Array.from({ length: concurrency }, (_, i) =>
      this._runAgentWorker(`agent-${i + 1}`)
    );

    try {
      // ── Observability: track overall task-based execution as a single stage ──
      this.obs.stageStart('task-based-execution');
      await Promise.all(workers);
      this.obs.stageEnd('task-based-execution', 'ok');
    } catch (err) {
      this.obs.stageEnd('task-based-execution', 'error');
      this.obs.recordError('task-based-execution', err.message);
      await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: err, state: 'task-based' });
      throw err;
    }

    // ── EntropyGC: scan after all tasks complete ────────────────────────────
    if (tbAdaptive.skipEntropyOnClean) {
      console.log(`[Orchestrator] ⏭️  Entropy scan skipped (adaptive strategy – recent sessions clean).`);
    } else {
      try {
        console.log(`\n[Orchestrator] 🔍 Running entropy scan after task-based execution...`);
        const gcResult = await this.entropyGC.run();
        this.obs.recordEntropyResult(gcResult);
        if (gcResult.violations > 0) {
          console.warn(`[Orchestrator] ⚠️  EntropyGC: ${gcResult.violations} violation(s) found.`);
        } else {
          console.log(`[Orchestrator] ✅ Entropy scan: no violations found.`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] EntropyGC scan failed (non-fatal): ${err.message}`);
      }
    }

    // ── CodeGraph: full rebuild after all tasks complete ─────────────────────
    try {
      console.log(`[Orchestrator] 🗺️  Rebuilding code graph after task-based execution...`);
      const graphResult = await this.codeGraph.build();
      this.obs.recordCodeGraphResult(graphResult);
      console.log(`[Orchestrator] ✅ Code graph built: ${graphResult.symbolCount} symbols, ${graphResult.edgeCount} edges`);
    } catch (err) {
      console.warn(`[Orchestrator] CodeGraph build failed (non-fatal): ${err.message}`);
    }

    // ── CIIntegration: local pipeline validation ─────────────────────────────
    try {
      console.log(`[Orchestrator] 🚀 Running CI pipeline validation (post task-based execution)...`);
      await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_STARTED, { command: this._config.testCommand || null });
      const ciResult = await this.ci.runLocalPipeline({
        skipEntropy: tbAdaptive.skipEntropyOnClean,
      });
      this.obs.recordCIResult(ciResult);
      if (ciResult.status === 'success') {
        console.log(`[Orchestrator] ✅ CI pipeline passed: ${ciResult.message}`);
        await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_COMPLETE, { result: ciResult });
      } else {
        console.warn(`[Orchestrator] ⚠️  CI pipeline ${ciResult.status}: ${ciResult.message}`);
        await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_FAILED, { result: ciResult });
      }
    } catch (err) {
      console.warn(`[Orchestrator] CI pipeline validation failed (non-fatal): ${err.message}`);
    }

    // Print task-based specific summary before shared teardown
    const summary = this.taskManager.getSummary();
    const expStats = this.experienceStore.getStats();
    const skillStats = this.skillEvolution.getStats();
    const complaintStats = this.complaintWall.getStats();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  AgentFlow Execution Complete`);
    console.log(`  Tasks: ${summary.byStatus.done || 0} done / ${summary.byStatus.failed || 0} failed / ${summary.total} total`);
    console.log(`  Experiences: ${expStats.positive} positive / ${expStats.negative} negative`);
    console.log(`  Skill evolutions: ${skillStats.totalEvolutions}`);
    console.log(`  Complaints: ${complaintStats.open} open / ${complaintStats.total} total`);
    console.log(`${'='.repeat(60)}\n`);

    // Shared teardown: flushRisks + saveLog + WORKFLOW_COMPLETE + dashboard + risk summary
    await this._finalizeWorkflow('task-based', { taskCount: taskDefs.length, goal });
  }

  /**
   * A single agent worker that continuously claims and executes tasks.
   *
   * @param {string} agentId
   * @param {string} expContext - Experience context to inject into prompts
   */
  async _runAgentWorker(agentId) {
    console.log(`[AgentWorker:${agentId}] Started`);
    let idleCount = 0;
    const MAX_IDLE = 8; // N32 fix: increased from 3 to 8 to tolerate longer dependency waits

    while (idleCount < MAX_IDLE) {
      // Check if all tasks are terminal (done/exhausted/failed-no-retry) before idling
      const summary = this.taskManager.getSummary();
      const activeStatuses = ['pending', 'running', 'blocked', 'interrupted', 'failed'];
      const hasActive = activeStatuses.some(s => (summary.byStatus[s] || 0) > 0);
      if (!hasActive) break; // All tasks are terminal, no point waiting

      const task = this.taskManager.claimNextTask(agentId);
      if (!task) {
        // N32 fix: if there are running tasks (other workers are making progress),
        // don't count this as an idle cycle – just wait without incrementing idleCount.
        // Only increment idleCount when truly nothing is happening (no running tasks).
        const hasRunning = (summary.byStatus['running'] || 0) > 0;
        if (!hasRunning) {
          idleCount++;
        }
        // N51 fix: when hasRunning=true (other workers are active), use a fixed short
        // wait (500ms) instead of the exponential backoff formula. The formula
        // Math.pow(2, idleCount - 1) produces 0.5 when idleCount=0 (2^-1 = 0.5),
        // which is an unintended fractional exponent. Exponential backoff only makes
        // sense when truly idle (no running tasks) – use it only in that case.
        const waitMs = hasRunning
          ? 500
          : Math.min(1000 * Math.pow(2, idleCount - 1), 10000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      idleCount = 0;

      await this.hooks.emit(HOOK_EVENTS.TASK_CLAIMED, { agentId, taskId: task.id });

      try {
        // Load relevant skill if specified
        let skillContent = '';
        if (task.skill) {
          skillContent = this.skillEvolution.readSkill(task.skill) || '';
        }

        // Fetch fresh experience context at task execution time (not startup snapshot)
        const expContext = this.experienceStore.getContextBlock(task.skill || null);

        // Execute task (in real usage, this calls the appropriate agent)
        console.log(`[AgentWorker:${agentId}] Executing task: ${task.id} – "${task.title}"`);
        const result = await this._executeTask(task, expContext, skillContent);

        this.taskManager.completeTask(task.id, result);
        await this.hooks.emit(HOOK_EVENTS.TASK_COMPLETED, { agentId, taskId: task.id, result });

        // Record positive experience from successful task
        if (result && result.experience) {
          const expTitle = result.experience.title || `Task ${task.id} solution`;
          // recordIfAbsent is atomic: concurrent workers cannot both pass the
          // findByTitle check and both call record() for the same title.
          const exp = this.experienceStore.recordIfAbsent(expTitle, {
              type: ExperienceType.POSITIVE,
              category: result.experience.category || ExperienceCategory.STABLE_PATTERN,
              title: expTitle,
              content: result.experience.content || result.summary || '',
              taskId: task.id,
              skill: task.skill,
              tags: result.experience.tags || [],
              codeExample: result.experience.codeExample || null,
            });

          // Check if this experience should trigger skill evolution
          if (exp) {
            const shouldEvolve = this.experienceStore.markUsed(exp.id);
            if (shouldEvolve && task.skill) {
              this.skillEvolution.evolve(task.skill, {
                section: 'Best Practices',
                title: exp.title,
                content: exp.content,
                sourceExpId: exp.id,
                reason: `High-frequency pattern from task ${task.id}`,
              });
              await this.hooks.emit(HOOK_EVENTS.SKILL_EVOLVED, { skillName: task.skill, expId: exp.id });
            }
          }
        }

      } catch (err) {
        console.error(`[AgentWorker:${agentId}] Task failed: ${task.id} – ${err.message}`);
        this.taskManager.failTask(task.id, err.message);
        await this.hooks.emit(HOOK_EVENTS.TASK_FAILED, { agentId, taskId: task.id, error: err.message });

        // Architecture Risk Fix 1: record task failure into StateMachine so it appears
        // in the risk summary and is persisted to the manifest checkpoint.
        this.stateMachine.recordRisk('high', `[TaskFailed:${task.id}] ${err.message}`);

        // Record negative experience from failure.
        // Use a stable title (task title + error prefix); append if already exists.
        // N11 fix: task.title may be undefined if task data was corrupted during _load()
        const negTitle = `Task failure: ${(task.title ?? 'unknown').slice(0, 50)}`;
        const negContent = `Task "${task.title}" failed with: ${err.message}`;
        if (!this.experienceStore.appendByTitle(negTitle, negContent)) {
          this.experienceStore.record({
            type: ExperienceType.NEGATIVE,
            category: ExperienceCategory.PITFALL,
            title: negTitle,
            content: negContent,
            taskId: task.id,
            skill: task.skill,
            tags: ['failure', 'pitfall'],
          });
        }
      }
    }

    console.log(`[AgentWorker:${agentId}] No more tasks. Worker exiting.`);
  }

  /**
   * Executes a single task using the appropriate agent.
   * Uses PromptBuilder (KV-Cache optimised) + wrappedLlm (token logging).
   * Injects both MemoryManager context (AGENTS.md) and ExperienceStore context.
   *
   * @param {Task} task
   * @param {string} expContext  - Experience context block from ExperienceStore
   * @param {string} skillContent - Skill SOP content from SkillEvolutionEngine
   * @returns {object} result
   */
  async _executeTask(task, expContext, skillContent) {
    // Choose agent role: use task.agentRole if explicitly specified.
    // Otherwise, infer from task title/description keywords so tasks can benefit
    // from the specialised system prompts of AnalystAgent / ArchitectAgent / TesterAgent
    // instead of always falling back to DeveloperAgent.
    // N5 fix: the old logic defaulted ALL unspecified tasks to DEVELOPER, which meant
    // analysis and architecture tasks got the wrong system prompt and missed domain-
    // specific experience context.
    let role = AgentRole.DEVELOPER; // safe default
    if (task.agentRole && this.agents[task.agentRole]) {
      role = task.agentRole;
    } else {
      // Keyword-based inference (title + description, case-insensitive)
      const hint = `${task.title ?? ''} ${task.description ?? ''}`.toLowerCase();
      if (/\b(analys[ei]s|requirement|clarif|research|investig|survey|feasib)/i.test(hint)) {
        role = AgentRole.ANALYST;
      } else if (/\b(architect|design|schema|diagram|structure|module|component|interface|api\s+design)/i.test(hint)) {
        role = AgentRole.ARCHITECT;
      } else if (/\b(test|spec|qa|quality|coverage|assert|verif|validat)/i.test(hint)) {
        role = AgentRole.TESTER;
      }
      // else: keep DEVELOPER as default for implementation tasks
      if (role !== AgentRole.DEVELOPER) {
        console.log(`[Orchestrator] 🤖 Auto-inferred agent role "${role}" for task "${task.id}" based on title/description keywords.`);
      }
    }

    // Build unified dynamic input: skill + experience + AGENTS.md + cross-stage context + task
    // Use the cached content from _initWorkflow() — do NOT re-read the file here.
    const agentsMdContent = this._agentsMdContent ?? '';

    // ── Cross-stage context injection (Defect #9 fix) ─────────────────────────
    // Task-based workers also benefit from upstream stage summaries.
    // If stageCtx is available (e.g. after a sequential pre-pass), inject it.
    const crossStageCtx = this.stageCtx ? this.stageCtx.getAll([], 1200) : '';

    // ── CodeGraph: on-demand symbol lookup for ARCHITECT and DEVELOPER tasks ──
    // Mirrors the logic in _runDeveloper() so task-based paths also benefit from
    // the code graph context (previously missing from runTaskBased path).
    let codeGraphContext = '';
    if (role === AgentRole.DEVELOPER || role === AgentRole.ARCHITECT) {
      try {
        const taskHint = `${task.title ?? ''} ${task.description ?? ''}`;
        // Extract PascalCase / camelCase identifiers from the task description
        const identifiers = [...new Set(
          (taskHint.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [])
            .filter(id => id.length >= 3 && id.length <= 40)
            .slice(0, 15)
        )];
        if (identifiers.length > 0) {
          const graphMd = this.codeGraph.querySymbolsAsMarkdown(identifiers);
          if (graphMd && !graphMd.includes('_Code graph not available') && !graphMd.includes('_No matching')) {
            codeGraphContext = graphMd;
            console.log(`[Orchestrator] 🗺️  Code graph: queried ${identifiers.length} symbol(s) for task "${task.id}"`);
          }
        }
      } catch (err) {
        console.warn(`[Orchestrator] Code graph query failed for task "${task.id}" (non-fatal): ${err.message}`);
      }
    }

    const dynamicInput = [
      skillContent    ? `## Skill Context\n${skillContent}` : '',
      expContext      ? `## Experience Context\n${expContext}` : '',
      agentsMdContent ? `## Project Context (AGENTS.md)\n${agentsMdContent}` : '',
      crossStageCtx   ? crossStageCtx : '',
      codeGraphContext ? `## Code Graph Context\n${codeGraphContext}` : '',
      `## Task\n**${task.title}**\n\n${task.description}`,
    ].filter(Boolean).join('\n\n');

    // Use PromptBuilder + wrappedLlm (KV-Cache optimised, token logged)
    // N72 fix: wrap buildAgentPrompt in try/catch so an unknown role does not
    // crash the task worker – fall back to the raw dynamicInput instead.
    let optimisedPrompt = dynamicInput;
    try {
      const result = buildAgentPrompt(role, dynamicInput);
      optimisedPrompt = result.prompt;
      console.log(`[Orchestrator] LLM call for ${role} (task: ${task.id}): ~${result.meta.estimatedTokens} tokens`);
    } catch (err) {
      console.warn(`[Orchestrator] buildAgentPrompt failed for role "${role}" (task: ${task.id}): ${err.message}. Using raw prompt.`);
    }
    const output = await this._rawLlmCall(optimisedPrompt);

    // ── Parallel mode quality gate: run lightweight review for ARCHITECT/DEVELOPER ──
    // This mirrors the sequential mode's CodeReviewAgent / ArchitectureReviewAgent
    // so parallel tasks get the same quality checks as sequential ones.
    // Reviews are capped at 1 round (vs 2 in sequential) to keep parallel fast.
    let reviewRiskNotes = [];
    if (role === AgentRole.ARCHITECT && output && output.length > 200) {
      try {
        const { ArchitectureReviewAgent } = require('./core/architecture-review-agent');
        // ── UUID-named temp file to avoid parallel worker file conflicts ─────────
        // Previously used task.id which could collide if two workers process tasks
        // with the same id simultaneously. crypto.randomUUID() guarantees uniqueness.
        const uid = require('crypto').randomUUID();
        const tmpPath = require('path').join(PATHS.OUTPUT_DIR, `arch-task-${uid}.tmp.md`);
        require('fs').writeFileSync(tmpPath, output, 'utf-8');
        const reviewer = new ArchitectureReviewAgent(this._rawLlmCall, { maxRounds: 1, verbose: false, outputDir: PATHS.OUTPUT_DIR });
        const reviewResult = await reviewer.review(tmpPath, null);
        reviewRiskNotes = reviewResult.riskNotes || [];
        if (reviewRiskNotes.length > 0) {
          console.warn(`[Orchestrator] ⚠️  Parallel arch review (task ${task.id}): ${reviewRiskNotes.length} issue(s) found.`);
          for (const note of reviewRiskNotes) {
            this.stateMachine.recordRisk(note.includes('(high)') ? 'high' : 'medium', `[ParallelArch:${task.id}] ${note}`, false);
          }
          this.stateMachine.flushRisks();
        }
        try { require('fs').unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Orchestrator] Parallel arch review failed for task "${task.id}" (non-fatal): ${err.message}`);
      }
    } else if (role === AgentRole.DEVELOPER && output && output.length > 200) {
      try {
        const { CodeReviewAgent } = require('./core/code-review-agent');
        const uid = require('crypto').randomUUID();
        const tmpPath = require('path').join(PATHS.OUTPUT_DIR, `code-task-${uid}.tmp.md`);
        require('fs').writeFileSync(tmpPath, output, 'utf-8');
        const reviewer = new CodeReviewAgent(this._rawLlmCall, { maxRounds: 1, verbose: false, outputDir: PATHS.OUTPUT_DIR });
        const reviewResult = await reviewer.review(tmpPath, null);
        reviewRiskNotes = reviewResult.riskNotes || [];
        if (reviewRiskNotes.length > 0) {
          console.warn(`[Orchestrator] ⚠️  Parallel code review (task ${task.id}): ${reviewRiskNotes.length} issue(s) found.`);
          for (const note of reviewRiskNotes) {
            this.stateMachine.recordRisk(note.includes('(high)') ? 'high' : 'medium', `[ParallelCode:${task.id}] ${note}`, false);
          }
          this.stateMachine.flushRisks();
        }
        try { require('fs').unlinkSync(tmpPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[Orchestrator] Parallel code review failed for task "${task.id}" (non-fatal): ${err.message}`);
      }
    }
    // _runAgentWorker checks result.experience; without this field the experience
    // recording block is never entered (the field is always undefined).
    // We synthesise a minimal experience entry from the task metadata so that
    // successful task completions are captured in the ExperienceStore.
    const experience = {
      title: `Task completed: ${(task.title ?? 'unknown').slice(0, 60)}`,
      content: `Task "${task.title}" completed successfully. Output summary: ${(output ?? '').slice(0, 300)}`,
      category: role === AgentRole.ARCHITECT ? 'ARCHITECTURE'
               : role === AgentRole.TESTER   ? 'STABLE_PATTERN'
               : 'STABLE_PATTERN',
      tags: [role.toLowerCase(), 'task-based', 'completed'],
      codeExample: null,
    };

    return { summary: output, raw: output, experience };
  }

  // ─── AgentFlow: Experience & Skill Management ─────────────────────────────────

  /**
   * Records an experience manually (e.g. from a human observation).
   *
   * @param {object} options - Same as ExperienceStore.record()
   * @returns {Experience}
   */
  recordExperience(options) {
    const exp = this.experienceStore.record(options);
    this.hooks.emit(HOOK_EVENTS.EXPERIENCE_RECORDED, { expId: exp.id });
    return exp;
  }

  /**
   * Files a complaint about an incorrect experience, skill, or workflow rule.
   *
   * @param {object} options - Same as ComplaintWall.file()
   * @returns {Complaint}
   */
  fileComplaint(options) {
    const complaint = this.complaintWall.file(options);
    this.hooks.emit(HOOK_EVENTS.COMPLAINT_FILED, { complaintId: complaint.id });
    return complaint;
  }

  /**
   * Resolves a complaint and optionally evolves the related skill.
   *
   * @param {string} complaintId
   * @param {string} resolution
   * @param {object} [skillEvolution] - If provided, evolves the related skill
   */
  resolveComplaint(complaintId, resolution, skillEvolution = null) {
    this.complaintWall.resolve(complaintId, resolution);
    this.hooks.emit(HOOK_EVENTS.COMPLAINT_RESOLVED, { complaintId });

    if (skillEvolution) {
      this.skillEvolution.evolve(skillEvolution.skillName, skillEvolution);
    }
  }

  /**
   * Returns a full system status report.
   *
   * @returns {string} Markdown-formatted status
   */
  getSystemStatus() {
    const taskSummary = this.taskManager.getSummary();
    const expStats = this.experienceStore.getStats();
    const skillStats = this.skillEvolution.getStats();
    const complaintStats = this.complaintWall.getStats();

    const lines = [
      `# AgentFlow System Status`,
      ``,
      `## Tasks`,
      `- Total: ${taskSummary.total}`,
      ...Object.entries(taskSummary.byStatus).map(([s, n]) => `- ${s}: ${n}`),
      ``,
      `## Experience Store`,
      `- Total: ${expStats.total} (✅ ${expStats.positive} positive / ❌ ${expStats.negative} negative)`,
      `- Total evolutions triggered: ${expStats.totalEvolutions}`,
      ``,
      `## Skills`,
      `- Total skills: ${skillStats.totalSkills}`,
      `- Total evolutions: ${skillStats.totalEvolutions}`,
      skillStats.mostEvolved.length > 0
        ? `- Most evolved: ${skillStats.mostEvolved.map(s => `${s.name} (×${s.evolutionCount})`).join(', ')}`
        : '',
      ``,
      this.complaintWall.getSummaryText(),
    ];

    return lines.filter(l => l !== '').join('\n');
  }

  // ─── Stage Runners ────────────────────────────────────────────────────────────

  /**
   * Runs a single stage if not already completed.
   * Skips the stage if the current state is already past it.
   */
  async _runStage(fromState, toState, stageRunner, resumeState) {
    const resumeIdx = STATE_ORDER.indexOf(resumeState);
    const fromIdx = STATE_ORDER.indexOf(fromState);

    // Skip if already past this stage
    if (resumeIdx > fromIdx) {
      console.log(`[Orchestrator] Skipping stage ${fromState} → ${toState} (already completed)`);
      return;
    }

    // Observability: track stage timing
    const stageLabel = `${fromState}→${toState}`;
    this.obs.stageStart(stageLabel);
    let stageStatus = 'ok';
    try {
      const artifactPath = await stageRunner();
      await this.stateMachine.transition(artifactPath, `Stage ${fromState} → ${toState} completed`);
    } catch (err) {
      stageStatus = 'error';
      this.obs.recordError(stageLabel, err.message);
      throw err;
    } finally {
      this.obs.stageEnd(stageLabel, stageStatus);
    }
  }

  /**
   * Rebuilds the code graph asynchronously (fire-and-forget).
   * Called after the developer stage to capture newly written code.
   * Non-blocking: errors are logged but do not affect the workflow.
   *
   * @param {string} trigger - Label for logging (e.g. 'post-developer')
   */
  _rebuildCodeGraphAsync(trigger = 'manual') {
    // Use setImmediate to avoid blocking the current event loop tick
    setImmediate(async () => {
      try {
        console.log(`[Orchestrator] 🔄 Code graph update triggered (${trigger})...`);
        const result = await this.codeGraph.build();
        console.log(`[Orchestrator] ✅ Code graph updated: ${result.symbolCount} symbols, ${result.edgeCount} edges`);
        this.obs.recordCodeGraphResult(result);
      } catch (err) {
        console.warn(`[Orchestrator] Code graph update failed (non-fatal): ${err.message}`);
      }
    });
  }
}

module.exports = { Orchestrator };

//  Mixin: attach extracted methods to Orchestrator.prototype 
// This keeps index.js slim while preserving the same public/private API surface.
Object.assign(Orchestrator.prototype, _git);
Object.assign(Orchestrator.prototype, _stages);
Object.assign(Orchestrator.prototype, _helpers);