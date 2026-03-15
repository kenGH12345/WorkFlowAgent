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
    this.complaintWall = new ComplaintWall();
    this.skillEvolution = new SkillEvolutionEngine();

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
   * Executes the Git PR workflow after a successful run:
   *   1. Create a feature branch (if not already on one)
   *   2. Commit all pending changes
   *   3. Push branch to remote (if autoPush: true)
   *   4. Create PR/MR description (and invoke gh/glab CLI if available)
   *
   * @param {string} mode  - 'sequential' | 'task-based'
   * @param {object} extra - Extra context from _finalizeWorkflow
   * @private
   */
  async _runGitPRWorkflow(mode, extra = {}) {
    console.log(`\n[Orchestrator] 🔀 Git PR workflow starting...`);

    if (!this.git.isGitRepo()) {
      console.warn(`[Orchestrator] ⚠️  Git PR workflow skipped: not a git repository.`);
      return;
    }

    const opts = this._gitOptions;

    try {
      // ── 1. Determine branch name ─────────────────────────────────────────
      const currentBranch = this.git.getCurrentBranch();
      let featureBranch = currentBranch;

      // Only create a new branch if we're currently on the base branch
      if (currentBranch === opts.baseBranch || currentBranch === 'main' || currentBranch === 'master') {
        const branchTitle = extra.requirement || extra.goal || `workflow-${this.projectId}`;
        featureBranch = this.git.generateBranchName(branchTitle, opts.branchType);
        const branchResult = this.git.createBranch(featureBranch, opts.baseBranch);
        if (branchResult.success) {
          console.log(`[Orchestrator] ✅ Feature branch created: ${featureBranch}`);
          await this.hooks.emit(HOOK_EVENTS.GIT_BRANCH_CREATED, { branch: featureBranch, base: opts.baseBranch });
        } else {
          console.warn(`[Orchestrator] ⚠️  Could not create branch: ${branchResult.message}. Using current branch.`);
          featureBranch = currentBranch;
        }
      } else {
        console.log(`[Orchestrator] ℹ️  Already on feature branch: ${currentBranch}`);
      }

      // ── 2. Commit all workflow artifacts ─────────────────────────────────
      const commitResult = this.git.commitProgress({
        summary: `feat(workflow): complete ${mode} workflow run for ${this.projectId}`,
        type: 'feat',
        scope: this.projectId,
        sessionId: this.projectId,
        verificationNote: `Workflow mode: ${mode}. Tasks: ${extra.taskCount || 1}.`,
      });
      if (commitResult.success && commitResult.commitHash) {
        console.log(`[Orchestrator] ✅ Committed: ${commitResult.commitHash}`);
      }

      // ── 3. Push branch to remote ──────────────────────────────────────────
      if (opts.autoPush) {
        const pushResult = this.git.pushBranch(featureBranch);
        if (pushResult.success) {
          console.log(`[Orchestrator] ✅ Branch pushed: ${featureBranch}`);
          await this.hooks.emit(HOOK_EVENTS.GIT_BRANCH_PUSHED, { branch: featureBranch });
        } else {
          console.warn(`[Orchestrator] ⚠️  Push failed: ${pushResult.message}`);
        }
      }

      // ── 4. Create PR description (+ invoke CLI if available) ─────────────
      const prTitle = `[WorkFlowAgent] ${extra.requirement || extra.goal || `${mode} workflow: ${this.projectId}`}`;
      const prBody = this._buildPRBody(mode, extra);

      const prResult = this.git.createPR({
        title: prTitle,
        body: prBody,
        baseBranch: opts.baseBranch,
        headBranch: featureBranch,
        labels: opts.labels,
        reviewers: opts.reviewers,
        draft: opts.draft,
        outputDir: PATHS.OUTPUT_DIR,
      });

      await this.hooks.emit(HOOK_EVENTS.GIT_PR_CREATED, {
        title: prTitle,
        branch: featureBranch,
        base: opts.baseBranch,
        prUrl: prResult.prUrl,
        prFile: prResult.prFile,
      });

      console.log(`[Orchestrator] ✅ Git PR workflow complete.`);
      if (prResult.prUrl) {
        console.log(`[Orchestrator]    PR URL: ${prResult.prUrl}`);
      } else {
        console.log(`[Orchestrator]    PR description: ${prResult.prFile}`);
      }

    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Git PR workflow failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Builds the PR body markdown from workflow artifacts.
   *
   * @private
   */
  _buildPRBody(mode, extra = {}) {
    const lines = [
      `## Workflow Summary`,
      '',
      `- **Mode:** ${mode}`,
      `- **Project:** ${this.projectId}`,
      `- **Timestamp:** ${new Date().toISOString()}`,
    ];

    if (extra.taskCount) {
      lines.push(`- **Tasks:** ${extra.taskCount}`);
    }

    // Attach requirement summary if available
    const reqPath = require('path').join(PATHS.OUTPUT_DIR, 'requirement.md');
    if (require('fs').existsSync(reqPath)) {
      const reqContent = require('fs').readFileSync(reqPath, 'utf-8');
      const firstSection = reqContent.split('\n').slice(0, 20).join('\n');
      lines.push('', '## Requirement (excerpt)', '', '```markdown', firstSection, '```');
    }

    // Attach architecture summary if available
    const archPath = require('path').join(PATHS.OUTPUT_DIR, 'architecture.md');
    if (require('fs').existsSync(archPath)) {
      const archContent = require('fs').readFileSync(archPath, 'utf-8');
      const firstSection = archContent.split('\n').slice(0, 20).join('\n');
      lines.push('', '## Architecture (excerpt)', '', '```markdown', firstSection, '```');
    }

    lines.push('', '---', '*Generated by WorkFlowAgent*');
    return lines.join('\n');
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
      const llmResponse = await this._rawLlmCall(decompositionPrompt);
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

    // Build unified dynamic input: skill + experience + AGENTS.md + task
    // Use the cached content from _initWorkflow() — do NOT re-read the file here.
    const agentsMdContent = this._agentsMdContent ?? '';

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
      skillContent   ? `## Skill Context\n${skillContent}` : '',
      expContext     ? `## Experience Context\n${expContext}` : '',
      agentsMdContent ? `## Project Context (AGENTS.md)\n${agentsMdContent}` : '',
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

    // Auto-generate experience metadata so _runAgentWorker can record it.
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

  async _runAnalyst(rawRequirement) {
    console.log(`\n[Orchestrator] Stage: ANALYSE (AnalystAgent)`);

    // ── Step 1: Requirement Clarification (ask human before generating requirement.md) ──
    const clarifier = new RequirementClarifier({
      askUser: this.askUser,
      maxRounds: 2,
      verbose: true,
      llmCall: this._rawLlmCall,   // Enable LLM semantic detection for human requirements
    });
    const clarResult = await clarifier.clarify(rawRequirement);

    // ── SocraticEngine: ask user to clarify scope if requirement is ambiguous ──
    // Triggered when RequirementClarifier detects unresolved ambiguity signals.
    if (clarResult.riskNotes && clarResult.riskNotes.length > 0) {
      try {
        const scopeDecision = await this.socratic.ask(DECISION_QUESTIONS.SCOPE_CLARIFICATION);
        console.log(`[Orchestrator] 🤔 Scope clarification decision: "${scopeDecision.optionText}"`);
        // Inject the scope decision into the enriched requirement so AnalystAgent is aware
        if (scopeDecision.optionIndex === 0) {
          clarResult.enrichedRequirement = `[Scope: Minimal – implement only the core feature]\n\n${clarResult.enrichedRequirement}`;
        } else if (scopeDecision.optionIndex === 1) {
          clarResult.enrichedRequirement = `[Scope: Full – implement all mentioned features]\n\n${clarResult.enrichedRequirement}`;
        }
        // optionIndex === 2: let Analyst decide – no prefix needed
      } catch (err) {
        console.warn(`[Orchestrator] SocraticEngine scope clarification failed (non-fatal): ${err.message}`);
      }
    }

    // Record unresolved requirement signals as risks
    for (const note of clarResult.riskNotes) {
      this.stateMachine.recordRisk('medium', note);
    }

    if (!clarResult.skipped && clarResult.rounds > 0) {
      console.log(`[Orchestrator] ✅ Requirement clarified in ${clarResult.rounds} round(s). Proceeding to analysis.`);
    }

    // ── Step 2: AnalystAgent generates requirement.md from enriched requirement ──
    const outputPath = await this.agents[AgentRole.ANALYST].run(null, clarResult.enrichedRequirement);
    // Carry clarification summary meta so ArchitectAgent knows what was clarified.
    this.bus.publish(AgentRole.ANALYST, AgentRole.ARCHITECT, outputPath, {
      clarificationRounds: clarResult.rounds ?? 0,
      signalCount:         clarResult.allSignals?.length ?? 0,
      riskNotes:           clarResult.riskNotes ?? [],
      skipped:             clarResult.skipped ?? false,
    });
    return outputPath;
  }

  async _runArchitect() {
    console.log(`\n[Orchestrator] Stage: ARCHITECT (ArchitectAgent)`);
    const inputPath = this.bus.consume(AgentRole.ARCHITECT);

    // ── SocraticEngine: ask user for technology stack preference before architecture ──
    // This externalises the implicit tech-stack assumption so the ArchitectAgent
    // receives an explicit directive rather than guessing from the requirement text.
    let techStackPrefix = '';
    try {
      const techDecision = await this.socratic.ask(DECISION_QUESTIONS.TECH_STACK_PREFERENCE);
      console.log(`[Orchestrator] 🤔 Tech stack preference: "${techDecision.optionText}"`);
      if (techDecision.optionIndex === 1) {
        techStackPrefix = '[Tech Stack: Minimal/Lightweight – prefer simple, low-dependency solutions]\n\n';
      } else if (techDecision.optionIndex === 2) {
        techStackPrefix = '[Tech Stack: Enterprise-grade – include full observability, logging, and monitoring]\n\n';
      }
      // optionIndex === 0: follow architecture doc recommendation – no prefix needed
    } catch (err) {
      console.warn(`[Orchestrator] SocraticEngine tech stack preference failed (non-fatal): ${err.message}`);
    }

    // Log requirement clarification summary so architect is aware of upstream enrichments.
    const analystMeta = this.bus.getMeta(AgentRole.ARCHITECT);
    if (analystMeta && !analystMeta.skipped && analystMeta.clarificationRounds > 0) {
      console.log(`[Orchestrator] ℹ️  Requirement was clarified in ${analystMeta.clarificationRounds} round(s) (${analystMeta.signalCount} signal(s) resolved). Architect should read requirements.md carefully.`);
    }

    // Inject AGENTS.md project context into ArchitectAgent
    const agentsMdForArch = this._agentsMdContent || '';
    if (agentsMdForArch) {
      console.log(`[Orchestrator] 📋 AGENTS.md injected into ArchitectAgent context.`);
    }

    // Inject experience context: proven architecture patterns + known pitfalls
    const archExpContext = this.experienceStore.getContextBlock('architecture-design');
    console.log(`[Orchestrator] 📚 Experience context injected for ArchitectAgent (${archExpContext.length} chars)`);

    // Architecture Risk Fix 3: inject open complaints relevant to architecture stage
    // so the Agent is aware of known issues and avoids repeating past mistakes.
    const archComplaints = this.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'architecture-design');
    const archComplaintBlock = archComplaints.length > 0
      ? `\n\n## Known Issues (Open Complaints)\n${archComplaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
      : '';
    const archExpContextWithComplaints = [
      techStackPrefix ? techStackPrefix.trim() : '',
      agentsMdForArch ? `## Project Context (AGENTS.md)\n${agentsMdForArch}` : '',
      archExpContext,
      archComplaintBlock,
    ].filter(Boolean).join('\n\n');
    if (archComplaints.length > 0) {
      console.log(`[Orchestrator] ⚠️  ${archComplaints.length} open complaint(s) injected into ArchitectAgent context.`);
    }

    const outputPath = await this.agents[AgentRole.ARCHITECT].run(inputPath, null, archExpContextWithComplaints);

    // ── Coverage Check: verify architecture covers all requirements ──
    const requirementPath = path.join(PATHS.OUTPUT_DIR, 'requirements.md');
    const coverageChecker = new CoverageChecker(this._rawLlmCall, { verbose: true });
    const coverageResult = await coverageChecker.check(requirementPath, outputPath);

    // Append coverage report to architecture.md
    if (!coverageResult.skipped) {
      const coverageReport = coverageChecker.formatReport(coverageResult);
      fs.appendFileSync(outputPath, `\n\n---\n${coverageReport}`, 'utf-8');
      // N49 fix: log denominator must match the report's "Coverage Rate (of evaluated)".
      // coverageResult.total includes unchecked items (LLM parse errors), but coverageRate
      // is calculated over evaluatedItems (covered + uncovered) only. Use evaluatedItems
      // as the denominator in the log so the log and report are internally consistent.
      const evaluatedItems = coverageResult.covered + coverageResult.uncovered;
      console.log(`[Orchestrator] 📊 Coverage: ${coverageResult.covered}/${evaluatedItems} evaluated (${coverageResult.coverageRate}%) | total parsed: ${coverageResult.total}`);
    }

    // Record uncovered requirements as risks (batch, flush once at end)
    for (const note of coverageResult.riskNotes) {
      this.stateMachine.recordRisk('high', note, false);
      console.warn(`[Orchestrator] ⚠️  ${note}`);
    }

    // ── Architecture Review: checklist-based review (judges correctness, not just wording) ──
    // Architecture Risk Fix 2: pass investigationTools so ArchitectureReviewAgent can
    // query ExperienceStore and source artifacts during self-correction, same as TestReport.
    const archReviewer = new ArchitectureReviewAgent(
      this._rawLlmCall,
      {
        maxRounds: 2,
        verbose: true,
        outputDir: PATHS.OUTPUT_DIR,
        investigationTools: this._buildInvestigationTools('Architecture'),
      }
    );
    const archReviewResult = await archReviewer.review(outputPath, requirementPath);

    // Record architecture review failures as risks (batch, flush once at end)
    for (const note of archReviewResult.riskNotes) {
      const severity = note.includes('(high)') ? 'high' : 'medium';
      this.stateMachine.recordRisk(severity, note, false);
    }
    // Flush all risk entries accumulated in this stage with a single disk write
    this.stateMachine.flushRisks();

    // ── SocraticEngine: ask user to approve architecture before code generation ──
    // Only ask if the architecture review passed or had only minor issues.
    // If high-severity issues remain, skip the question (already recorded as risk).
    if (archReviewResult.failed === 0 || !archReviewResult.needsHumanReview) {
      try {
        const archDecision = await this.socratic.ask(DECISION_QUESTIONS.ARCHITECTURE_APPROVAL);
        if (archDecision.optionIndex === 1) {
          // User rejected the architecture – record as high risk and abort
          const abortMsg = '[SocraticEngine] User rejected architecture. Workflow aborted by user decision.';
          this.stateMachine.recordRisk('high', abortMsg);
          throw new Error(abortMsg);
        } else if (archDecision.optionIndex === 2) {
          // User has reservations – record as medium risk and continue
          this.stateMachine.recordRisk('medium', '[SocraticEngine] User approved architecture with reservations. Proceeding to code generation.');
          console.log(`[Orchestrator] ⚠️  Architecture approved with reservations. Proceeding.`);
        } else {
          console.log(`[Orchestrator] ✅ Architecture approved by user. Proceeding to code generation.`);
        }
      } catch (err) {
        if (err.message.includes('User rejected architecture')) throw err;
        console.warn(`[Orchestrator] SocraticEngine architecture approval failed (non-fatal): ${err.message}`);
      }
    }

    if (archReviewResult.failed === 0) {
      console.log(`[Orchestrator] ✅ Architecture review passed.`);
      // P2: Record positive experience – architecture passed review cleanly.
      // Use a stable (date-free) title so this experience is written only once globally.
      const archPassTitle = 'Architecture design passed all checklist items';
      this.experienceStore.recordIfAbsent(archPassTitle, {
        type: ExperienceType.POSITIVE,
        category: ExperienceCategory.ARCHITECTURE,
        title: archPassTitle,
        content: `Architecture passed all ${archReviewResult.total ?? 'N/A'} checklist items with full requirement coverage. All requirements were addressed and no high-severity issues were found.`,
        skill: 'architecture-design',
        tags: ['architecture-review', 'passed', 'stable'],
      });
    } else if (archReviewResult.needsHumanReview) {
      console.warn(`[Orchestrator] ⚠️  ${archReviewResult.failed} high-severity architecture issue(s) remain. Recorded as risks.`);
      // P2: Record/update negative experience – high-severity issues persisted after self-correction.
      // Use a stable title; if already exists, append new failure context instead of duplicating.
      const archFailTitle = 'Architecture review: high-severity issues unresolved after self-correction';
      const failedNotes = archReviewResult.riskNotes.slice(0, 3).join('; ');
      const failContent = `After ${archReviewResult.rounds ?? 'N/A'} self-correction round(s), ${archReviewResult.failed} high-severity issue(s) remained. Issues: ${failedNotes}`;
      if (!this.experienceStore.appendByTitle(archFailTitle, failContent)) {
        this.experienceStore.record({
          type: ExperienceType.NEGATIVE,
          category: ExperienceCategory.PITFALL,
          title: archFailTitle,
          content: failContent,
          skill: 'architecture-design',
          tags: ['architecture-review', 'failed', 'pitfall'],
        });
      }
    } else {
      console.log(`[Orchestrator] ℹ️  ${archReviewResult.failed} minor architecture issue(s) remain. Proceeding automatically.`);
    }

    // NOTE: SelfCorrectionEngine is intentionally NOT run here.
    // ArchitectureReviewAgent already performs checklist-based review + self-correction.
    // Running SelfCorrectionEngine afterwards would cause double-correction conflicts
    // (both modify architecture.md independently, potentially overwriting each other's fixes).
    // SelfCorrectionEngine is reserved for the Test stage where no checklist reviewer exists.

    // Carry change summary meta so DeveloperAgent knows what the architect changed.
    // This is consumed via bus.getMeta(AgentRole.DEVELOPER) in _runDeveloper.
    this.bus.publish(AgentRole.ARCHITECT, AgentRole.DEVELOPER, outputPath, {
      reviewRounds: archReviewResult.rounds ?? 0,
      failedItems:  archReviewResult.failed ?? 0,
      riskNotes:    archReviewResult.riskNotes ?? [],
    });
    return outputPath;
  }

  async _runDeveloper() {
    console.log(`\n[Orchestrator] Stage: CODE (DeveloperAgent)`);
    const inputPath = this.bus.consume(AgentRole.DEVELOPER);

    // Log architecture change summary so developer is aware of upstream modifications.
    const archMeta = this.bus.getMeta(AgentRole.DEVELOPER);
    if (archMeta && archMeta.reviewRounds > 0) {
      console.log(`[Orchestrator] ℹ️  Architecture was self-corrected in ${archMeta.reviewRounds} round(s) (${archMeta.failedItems} issue(s) fixed). Developer should review architecture.md carefully.`);
    }

    // Inject AGENTS.md project context into DeveloperAgent
    const agentsMdForDev = this._agentsMdContent || '';
    if (agentsMdForDev) {
      console.log(`[Orchestrator] 📋 AGENTS.md injected into DeveloperAgent context.`);
    }

    // Inject experience context: proven coding patterns + known pitfalls
    const devExpContext = this.experienceStore.getContextBlock('code-development');
    console.log(`[Orchestrator] 📚 Experience context injected for DeveloperAgent (${devExpContext.length} chars)`);

    // ── Code Graph: inject on-demand symbol lookup into developer context ────
    // Extract symbol names mentioned in the architecture doc and inject their
    // full graph details (file location, signature, callers, callees) so the
    // Developer doesn't need to re-discover existing code structure.
    let codeGraphContext = '';
    try {
      const archPath = path.join(PATHS.OUTPUT_DIR, 'architecture.md');
      if (fs.existsSync(archPath)) {
        const archContent = fs.readFileSync(archPath, 'utf-8');
        // Extract PascalCase / camelCase identifiers from architecture doc as candidate symbols
        const identifiers = [...new Set(
          (archContent.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [])
            .filter(id => id.length >= 3 && id.length <= 40)
            .slice(0, 20)
        )];
        if (identifiers.length > 0) {
          const graphMd = this.codeGraph.querySymbolsAsMarkdown(identifiers);
          if (graphMd && !graphMd.includes('_Code graph not available') && !graphMd.includes('_No matching')) {
            codeGraphContext = graphMd;
            console.log(`[Orchestrator] 🗺️  Code graph: queried ${identifiers.length} symbol(s) from architecture doc`);
          }
        }
      }
    } catch (err) {
      console.warn(`[Orchestrator] Code graph query failed (non-fatal): ${err.message}`);
    }

    // Architecture Risk Fix 3: inject open complaints relevant to code stage
    // so the Agent is aware of known issues and avoids repeating past mistakes.
    const devComplaints = this.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'code-development');
    const devComplaintBlock = devComplaints.length > 0
      ? `\n\n## Known Issues (Open Complaints)\n${devComplaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
      : '';
    const devExpContextWithComplaints = [
      agentsMdForDev ? `## Project Context (AGENTS.md)\n${agentsMdForDev}` : '',
      devExpContext,
      devComplaintBlock,
      codeGraphContext ? `\n\n${codeGraphContext}` : '',
    ].filter(Boolean).join('\n\n');
    if (devComplaints.length > 0) {
      console.log(`[Orchestrator] ⚠️  ${devComplaints.length} open complaint(s) injected into DeveloperAgent context.`);
    }

    const outputPath = await this.agents[AgentRole.DEVELOPER].run(inputPath, null, devExpContextWithComplaints);

    // ── Code Review: checklist-based review + self-correction ──
    // Architecture Risk Fix 2: pass investigationTools so CodeReviewAgent can
    // query ExperienceStore and source artifacts during self-correction.
    const requirementPath = path.join(PATHS.OUTPUT_DIR, 'requirements.md');
    const reviewer = new CodeReviewAgent(
      this._rawLlmCall,
      {
        maxRounds: 2,
        verbose: true,
        outputDir: PATHS.OUTPUT_DIR,
        investigationTools: this._buildInvestigationTools('Code'),
      }
    );
    const reviewResult = await reviewer.review(outputPath, requirementPath);

    // Record remaining failures as risks (batch, flush once at end)
    for (const note of reviewResult.riskNotes) {
      const severity = note.includes('(high)') ? 'high' : 'medium';
      this.stateMachine.recordRisk(severity, note, false);
    }
    // Flush all risk entries accumulated in this stage with a single disk write
    this.stateMachine.flushRisks();

    if (reviewResult.failed === 0) {
      console.log(`[Orchestrator] ✅ Code review passed. Proceeding automatically.`);
      // P2: Record positive experience – code passed review cleanly.
      // Use a stable (date-free) title so this experience is written only once globally.
      const codePassTitle = 'Code development passed all checklist items';
      this.experienceStore.recordIfAbsent(codePassTitle, {
        type: ExperienceType.POSITIVE,
        category: ExperienceCategory.STABLE_PATTERN,
        title: codePassTitle,
        content: `Code passed all ${reviewResult.total ?? 'N/A'} checklist items. Architecture was faithfully implemented with no high-severity issues.`,
        skill: 'code-development',
        tags: ['code-review', 'passed', 'stable'],
      });
    } else if (reviewResult.needsHumanReview) {
      console.warn(`[Orchestrator] ⚠️  ${reviewResult.failed} high-severity code issue(s) remain. Recorded as risks.`);
      // P2: Record/update negative experience – high-severity issues persisted after self-correction.
      // Use a stable title; if already exists, append new failure context instead of duplicating.
      const codeFailTitle = 'Code review: high-severity issues unresolved after self-correction';
      const failedNotes = reviewResult.riskNotes.slice(0, 3).join('; ');
      const failContent = `After ${reviewResult.rounds ?? 'N/A'} self-correction round(s), ${reviewResult.failed} high-severity issue(s) remained. Issues: ${failedNotes}`;
      if (!this.experienceStore.appendByTitle(codeFailTitle, failContent)) {
        this.experienceStore.record({
          type: ExperienceType.NEGATIVE,
          category: ExperienceCategory.PITFALL,
          title: codeFailTitle,
          content: failContent,
          skill: 'code-development',
          tags: ['code-review', 'failed', 'pitfall'],
        });
      }
    } else {
      console.log(`[Orchestrator] ℹ️  ${reviewResult.failed} minor code issue(s) remain. Proceeding automatically.`);
    }

    // Carry change summary meta so TesterAgent knows what the developer changed.
    this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, outputPath, {
      reviewRounds: reviewResult.rounds ?? 0,
      failedItems:  reviewResult.failed ?? 0,
      riskNotes:    reviewResult.riskNotes ?? [],
    });
    return outputPath;
  }

  async _runTester() {
    console.log(`\n[Orchestrator] Stage: TEST (TesterAgent)`);
    const inputPath = this.bus.consume(AgentRole.TESTER);

    // Log code change summary so tester is aware of upstream modifications.
    const devMeta = this.bus.getMeta(AgentRole.TESTER);
    if (devMeta && devMeta.reviewRounds > 0) {
      console.log(`[Orchestrator] ℹ️  Code was self-corrected in ${devMeta.reviewRounds} round(s) (${devMeta.failedItems} issue(s) fixed). Tester should pay attention to corrected areas.`);
    }

    // Inject AGENTS.md project context into TesterAgent
    const agentsMdForTest = this._agentsMdContent || '';
    if (agentsMdForTest) {
      console.log(`[Orchestrator] 📋 AGENTS.md injected into TesterAgent context.`);
    }

    // Inject experience context: proven test patterns + known pitfalls
    const testExpContext = this.experienceStore.getContextBlock('test-report');
    console.log(`[Orchestrator] 📚 Experience context injected for TesterAgent (${testExpContext.length} chars)`);

    // Architecture Risk Fix 3: inject open complaints relevant to test stage
    // so the Agent is aware of known issues and avoids repeating past mistakes.
    const testComplaints = this.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'test-report');
    const testComplaintBlock = testComplaints.length > 0
      ? `\n\n## Known Issues (Open Complaints)\n${testComplaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
      : '';
    const testExpContextWithComplaints = [
      agentsMdForTest ? `## Project Context (AGENTS.md)\n${agentsMdForTest}` : '',
      testExpContext,
      testComplaintBlock,
    ].filter(Boolean).join('\n\n');
    if (testComplaints.length > 0) {
      console.log(`[Orchestrator] ⚠️  ${testComplaints.length} open complaint(s) injected into TesterAgent context.`);
    }

    const outputPath = await this.agents[AgentRole.TESTER].run(inputPath, null, testExpContextWithComplaints);

    // Self-correction: let the TesterAgent refine its own report
    let testContent = fs.existsSync(outputPath)
      ? fs.readFileSync(outputPath, 'utf-8')
      : '';
    if (!testContent) {
      console.warn(`[Orchestrator] ⚠️  TesterAgent produced an empty test report at: ${outputPath}. Skipping self-correction.`);
      this.stateMachine.recordRisk('high', '[TestReport] TesterAgent produced an empty test report – self-correction skipped.');
    } else {
      const corrector = new SelfCorrectionEngine(
        this._rawLlmCall,
        {
          maxRounds: 2,
          verbose: true,
          semanticMode: true,
          investigationTools: this._buildInvestigationTools('TestReport'),
        }
      );
      const corrResult = await corrector.correct(testContent, 'Test Report');

      if (corrResult.rounds > 0) {
        // N85 fix: use atomic write (tmp → rename) to prevent file corruption if the
        // process crashes mid-write. A plain writeFileSync would leave a truncated file.
        const tmpPath = outputPath + '.tmp';
        fs.writeFileSync(tmpPath, corrResult.content, 'utf-8');
        fs.renameSync(tmpPath, outputPath);
        console.log(`[Orchestrator] Test report self-corrected in ${corrResult.rounds} round(s).`);
      }

      const report = formatClarificationReport(corrResult);
      if (report) {
        fs.appendFileSync(outputPath, `\n\n---\n${report}`, 'utf-8');
      }

      // Always proceed automatically; record high-severity issues as risks for final summary
      if (corrResult.needsHumanReview) {
        const riskMsg = `[TestReport] ${corrResult.signals.filter(s => s.severity === 'high').map(s => s.label).join(', ')} – unresolved after self-correction.`;
        this.stateMachine.recordRisk('high', riskMsg);
        console.warn(`[Orchestrator] ⚠️  High-severity issues recorded as risks. Proceeding automatically.`);
        // ── SocraticEngine: ask user how to handle test defects ──────────────
        try {
          const defectDecision = await this.socratic.ask(DECISION_QUESTIONS.TEST_DEFECTS_ACTION);
          console.log(`[Orchestrator] 🤔 Defect handling decision: "${defectDecision.optionText}"`);
          // Record the decision as a risk note for traceability
          this.stateMachine.recordRisk('low', `[SocraticEngine] Defect handling: ${defectDecision.optionText}`);
        } catch (err) {
          console.warn(`[Orchestrator] SocraticEngine defect decision failed (non-fatal): ${err.message}`);
        }
        // P3: Record/update negative experience – high-severity test issues persisted.
        // Use a stable title; if already exists, append new failure context instead of duplicating.
        const testFailTitle = 'Test report: high-severity issues unresolved after self-correction';
        const failContent = `Unresolved high-severity signals after ${corrResult.rounds} self-correction round(s): ${riskMsg}`;
        if (!this.experienceStore.appendByTitle(testFailTitle, failContent)) {
          this.experienceStore.record({
            type: ExperienceType.NEGATIVE,
            category: ExperienceCategory.PITFALL,
            title: testFailTitle,
            content: failContent,
            skill: 'test-report',
            tags: ['test-report', 'failed', 'pitfall'],
          });
        }
      } else {
        console.log(`[Orchestrator] ✅ Test report passed self-correction. Workflow proceeding.`);
        // P3: Record positive experience – test report passed self-correction cleanly.
        // Use a stable (date-free) title so this experience is written only once globally.
        const testPassTitle = 'Test report passed self-correction with no high-severity issues';
        this.experienceStore.recordIfAbsent(testPassTitle, {
          type: ExperienceType.POSITIVE,
          category: ExperienceCategory.STABLE_PATTERN,
          title: testPassTitle,
          content: `Test report passed self-correction with no high-severity issues remaining. Self-correction loop is effective for test quality assurance.`,
          skill: 'test-report',
          tags: ['test-report', 'passed', 'stable'],
        });
      }
    }

    // ── Real Test Execution + Auto-Fix Loop ──────────────────────────────────
    // After the AI test report is generated, run the project's actual test suite.
    // If tests fail, invoke DeveloperAgent to fix them and re-run (up to maxFixRounds).
    const testCommand = this._config.testCommand || null;
    const autoFixCfg = this._config.autoFixLoop || {};
    const autoFixEnabled = autoFixCfg.enabled !== false && !!testCommand;
    // Use adaptive strategy: history-derived maxFixRounds overrides config default
    const maxFixRounds = this._adaptiveStrategy.maxFixRounds ?? autoFixCfg.maxFixRounds ?? 2;
    const failOnUnfixed = autoFixCfg.failOnUnfixed ?? false;

    if (maxFixRounds !== (autoFixCfg.maxFixRounds ?? 2)) {
      console.log(`[Orchestrator] 📈 Adaptive maxFixRounds: ${maxFixRounds} (history-adjusted from default ${autoFixCfg.maxFixRounds ?? 2})`);
    }

    if (!testCommand) {
      console.log(`[Orchestrator] ℹ️  No testCommand configured – skipping real test execution.`);
      console.log(`[Orchestrator] 💡 Set testCommand in workflow.config.js to enable automated verification.`);
    } else {
      await this._runRealTestLoop({
        testCommand,
        autoFixEnabled,
        maxFixRounds,
        failOnUnfixed,
        testReportPath: outputPath,
      });
    }

    // ── CIIntegration: run local pipeline after Tester stage completes ────────
    // Validates that lint + test + entropy pass in a CI-like environment.
    // Non-blocking: failures are recorded as risks but do not abort the workflow.
    try {
      console.log(`\n[Orchestrator] 🚀 Running CI pipeline validation (post-test)...`);
      await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_STARTED, { command: this._config.testCommand || null });
      const ciResult = await this.ci.runLocalPipeline({
        skipEntropy: this._adaptiveStrategy.skipEntropyOnClean,
      });
      this.obs.recordCIResult(ciResult);
      await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_COMPLETE, { result: ciResult });
      if (ciResult.status === 'success') {
        console.log(`[Orchestrator] ✅ CI pipeline passed: ${ciResult.message}`);
      } else {
        const ciMsg = `[CIIntegration] Pipeline ${ciResult.status}: ${ciResult.message}`;
        console.warn(`[Orchestrator] ⚠️  ${ciMsg}`);
        this.stateMachine.recordRisk('medium', ciMsg);
        await this.hooks.emit(HOOK_EVENTS.CI_PIPELINE_FAILED, { result: ciResult });
      }
    } catch (err) {
      console.warn(`[Orchestrator] CI pipeline validation failed (non-fatal): ${err.message}`);
    }

    // ── Entropy GC: auto-scan after Tester stage completes ───────────────────
    // Runs synchronously here (before FINISHED) so violations are visible in the
    // test report and can be acted on in the same session.
    // Skip if adaptive strategy indicates recent sessions were all clean.
    if (this._adaptiveStrategy.skipEntropyOnClean) {
      console.log(`[Orchestrator] ⏭️  Entropy scan skipped (last 3 sessions had 0 violations – adaptive strategy).`);
      // Mark as explicitly skipped so FINISHED stage does not re-run it
      this.obs._entropySkipped = true;
    } else {
      console.log(`\n[Orchestrator] 🔍 Running entropy scan after Tester stage...`);
      try {
        const gcResult = await this.entropyGC.run();
        this.obs.recordEntropyResult(gcResult);
        if (gcResult.violations > 0) {
          const gcMsg = `[EntropyGC] ${gcResult.violations} violation(s) found after Tester stage (${gcResult.details?.high ?? 0} high / ${gcResult.details?.medium ?? 0} medium / ${gcResult.details?.low ?? 0} low). See output/entropy-report.md.`;
          console.warn(`[Orchestrator] ⚠️  ${gcMsg}`);
          // Record high-severity entropy violations as workflow risks
          if ((gcResult.details?.high ?? 0) > 0) {
            this.stateMachine.recordRisk('medium', gcMsg);
          }
          // Append entropy summary to test report for traceability
          if (fs.existsSync(outputPath)) {
            const entropyNote = [
              ``,
              `---`,
              ``,
              `## 🔍 Entropy GC Scan (post-test)`,
              ``,
              `> Scanned ${gcResult.filesScanned} files | Found **${gcResult.violations}** violation(s)`,
              `> High: ${gcResult.details?.high ?? 0} | Medium: ${gcResult.details?.medium ?? 0} | Low: ${gcResult.details?.low ?? 0}`,
              `> Full report: \`output/entropy-report.md\``,
            ].join('\n');
            fs.appendFileSync(outputPath, entropyNote, 'utf-8');
          }
        } else {
          console.log(`[Orchestrator] ✅ Entropy scan: no violations found.`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] EntropyGC scan failed (non-fatal): ${err.message}`);
      }
    }

    return outputPath;
  }

  /**
   * Runs the real test command, and if tests fail, invokes DeveloperAgent to fix
   * them and re-runs tests. Repeats up to maxFixRounds times.
   *
   * @param {object} opts
   * @param {string}  opts.testCommand     - Shell command to run tests
   * @param {boolean} opts.autoFixEnabled  - Whether to attempt auto-fix on failure
   * @param {number}  opts.maxFixRounds    - Max fix-and-retest cycles
   * @param {boolean} opts.failOnUnfixed   - Throw if tests still fail after all rounds
   * @param {string}  opts.testReportPath  - Path to the AI-generated test report
   */
  async _runRealTestLoop({ testCommand, autoFixEnabled, maxFixRounds, failOnUnfixed, testReportPath }) {
    const runner = new TestRunner({
      projectRoot: this.projectRoot,
      testCommand,
      timeoutMs: 180_000,
      verbose: true,
    });

    console.log(`\n[Orchestrator] 🔬 Running real test suite: ${testCommand}`);
    let result = runner.run();

    // Append real test result to the AI test report
    const realResultMd = TestRunner.formatResultAsMarkdown(result);
    if (fs.existsSync(testReportPath)) {
      fs.appendFileSync(testReportPath, `\n\n---\n\n${realResultMd}`, 'utf-8');
    }

    if (result.passed) {
      console.log(`[Orchestrator] ✅ Real tests PASSED on first run.`);
      // Record test result into observability so metrics-history.jsonl is populated
      this.obs.recordTestResult({ passed: result.passed ? 1 : 0, failed: 0, skipped: 0, rounds: 1 });
      this.experienceStore.record({
        type: ExperienceType.POSITIVE,
        category: ExperienceCategory.STABLE_PATTERN,
        title: `Real tests passed: ${testCommand}`,
        content: `All tests passed on first run. Command: ${testCommand}. Duration: ${result.durationMs}ms.`,
        skill: 'test-report',
        tags: ['real-test', 'passed', 'first-run'],
      });
      return;
    }

    // Tests failed
    console.warn(`[Orchestrator] ❌ Real tests FAILED (exit ${result.exitCode}).`);
    if (!autoFixEnabled) {
      const msg = `[RealTest] Tests failed (exit ${result.exitCode}). Auto-fix disabled. Manual fix required.`;
      this.stateMachine.recordRisk('high', msg);
      console.warn(`[Orchestrator] ⚠️  Auto-fix disabled. Recorded as risk.`);
      if (failOnUnfixed) throw new Error(msg);
      return;
    }

    // Auto-fix loop
    let fixRound = 0;
    while (!result.passed && fixRound < maxFixRounds) {
      fixRound++;
      console.log(`\n[Orchestrator] 🔧 Auto-fix round ${fixRound}/${maxFixRounds}...`);

      // Build a fix prompt with the failure details
      const failureContext = TestRunner.formatResultAsMarkdown(result);
      const codeDiffPath = path.join(PATHS.OUTPUT_DIR, 'code.diff');
      const existingDiff = fs.existsSync(codeDiffPath)
        ? fs.readFileSync(codeDiffPath, 'utf-8')
        : '(no previous diff)';

      const fixPrompt = [
        `You are a **Code Fix Agent**. The project's test suite has failed.`,
        `Your task: produce REPLACE_IN_FILE blocks that fix ALL failing tests.`,
        ``,
        `## Previous Code (for context)`,
        `\`\`\`diff`,
        existingDiff.slice(0, 4000),
        `\`\`\``,
        ``,
        failureContext,
        ``,
        `## Output Format`,
        `For each file you need to change, output one or more blocks in this EXACT format:`,
        ``,
        `[REPLACE_IN_FILE]`,
        `file: relative/path/to/file.js`,
        `find: |`,
        `  <exact code to find, including indentation>`,
        `replace: |`,
        `  <new code to replace it with>`,
        `[/REPLACE_IN_FILE]`,
        ``,
        `## Rules`,
        `1. Analyse the failure output above and identify the root cause of each failing test.`,
        `2. Output ONLY [REPLACE_IN_FILE] blocks – no explanations, no markdown prose.`,
        `3. The "find:" block MUST be an exact substring of the current file (copy-paste it).`,
        `4. Only change what is necessary to fix the failures.`,
        `5. Do NOT change test files unless the test itself is clearly wrong.`,
        `6. File paths are relative to the project root: ${this.projectRoot}`,
      ].join('\n');

      console.log(`[Orchestrator] 🤖 Invoking Code Fix Agent for fix round ${fixRound}...`);
      let fixResponse;
      try {
        fixResponse = await this._rawLlmCall(fixPrompt);
      } catch (err) {
        console.error(`[Orchestrator] ❌ LLM call failed during fix round ${fixRound}: ${err.message}`);
        break;
      }

      if (!fixResponse || !fixResponse.trim()) {
        console.warn(`[Orchestrator] ⚠️  Code Fix Agent returned empty response in fix round ${fixRound}. Stopping.`);
        break;
      }

      // Save the raw LLM response for traceability
      const fixedDiffPath = path.join(PATHS.OUTPUT_DIR, `code-fix-round${fixRound}.txt`);
      fs.writeFileSync(fixedDiffPath, fixResponse, 'utf-8');
      console.log(`[Orchestrator] 📝 Fix response saved to: ${fixedDiffPath}`);

      // Apply the REPLACE_IN_FILE blocks to actual source files
      const applyResult = this._applyFileReplacements(fixResponse);
      console.log(`[Orchestrator] 🔧 Applied ${applyResult.applied} replacement(s), ${applyResult.failed} failed.`);
      if (applyResult.failed > 0) {
        console.warn(`[Orchestrator] ⚠️  Some replacements failed:\n${applyResult.errors.join('\n')}`);
      }
      if (applyResult.applied === 0) {
        console.warn(`[Orchestrator] ⚠️  No replacements were applied. Stopping fix loop.`);
        break;
      }

      // Re-run tests
      console.log(`[Orchestrator] 🔬 Re-running tests after fix round ${fixRound}...`);
      result = runner.run();

      // Append this round's result to the test report
      const roundMd = `\n\n---\n\n## Auto-Fix Round ${fixRound} Result\n\n` + TestRunner.formatResultAsMarkdown(result);
      if (fs.existsSync(testReportPath)) {
        fs.appendFileSync(testReportPath, roundMd, 'utf-8');
      }

      if (result.passed) {
        console.log(`[Orchestrator] ✅ Tests PASSED after fix round ${fixRound}.`);
        // Record test result into observability so metrics-history.jsonl is populated
        this.obs.recordTestResult({ passed: 1, failed: 0, skipped: 0, rounds: fixRound });
        this.experienceStore.record({
          type: ExperienceType.POSITIVE,
          category: ExperienceCategory.STABLE_PATTERN,
          title: `Real tests passed after ${fixRound} auto-fix round(s)`,
          content: `Tests passed after ${fixRound} fix round(s). Command: ${testCommand}. Failure summary: ${result.failureSummary.slice(0, 3).join('; ')}.`,
          skill: 'test-report',
          tags: ['real-test', 'auto-fix', 'passed'],
        });
        return;
      }

      console.warn(`[Orchestrator] ❌ Tests still failing after fix round ${fixRound}.`);
    }

    // All fix rounds exhausted, tests still failing
    const failMsg = `[RealTest] Tests still failing after ${fixRound} auto-fix round(s). Exit code: ${result.exitCode}. Failures: ${result.failureSummary.slice(0, 3).join('; ')}`;
    this.stateMachine.recordRisk('high', failMsg);
    // Record test result into observability so metrics-history.jsonl is populated
    this.obs.recordTestResult({ passed: 0, failed: result.failureSummary.length || 1, skipped: 0, rounds: fixRound });
    this.experienceStore.record({
      type: ExperienceType.NEGATIVE,
      category: ExperienceCategory.PITFALL,
      title: `Real tests failed after ${fixRound} auto-fix rounds`,
      content: failMsg,
      skill: 'test-report',
      tags: ['real-test', 'auto-fix', 'failed'],
    });
    console.warn(`[Orchestrator] ⚠️  Tests still failing after all fix rounds. Recorded as high-risk.`);
    if (failOnUnfixed) {
      throw new Error(failMsg);
    }
  }

  /**
   * Parses and applies [REPLACE_IN_FILE] blocks from an LLM response.
   *
   * Block format:
   *   [REPLACE_IN_FILE]
   *   file: relative/path/to/file.js
   *   find: |
   *     <exact code to find>
   *   replace: |
   *     <new code>
   *   [/REPLACE_IN_FILE]
   *
   * @param {string} llmResponse - Raw LLM output containing one or more blocks
   * @returns {{ applied: number, failed: number, errors: string[] }}
   */
  _applyFileReplacements(llmResponse) {
    let applied = 0;
    let failed = 0;
    const errors = [];

    // Extract all [REPLACE_IN_FILE]...[/REPLACE_IN_FILE] blocks
    const blockRegex = /\[REPLACE_IN_FILE\]([\s\S]*?)\[\/REPLACE_IN_FILE\]/g;
    let match;

    while ((match = blockRegex.exec(llmResponse)) !== null) {
      const blockContent = match[1];

      try {
        // Parse "file:" field
        const fileMatch = blockContent.match(/^[ \t]*file:\s*(.+)$/m);
        if (!fileMatch) {
          errors.push(`Block missing "file:" field`);
          failed++;
          continue;
        }
        const relPath = fileMatch[1].trim();
        const absPath = path.isAbsolute(relPath)
          ? relPath
          : path.join(this.projectRoot, relPath);

        if (!fs.existsSync(absPath)) {
          errors.push(`File not found: ${absPath}`);
          failed++;
          continue;
        }

        // Parse "find: |" block – everything indented after "find: |" until "replace: |"
        const findMatch = blockContent.match(/^[ \t]*find:\s*\|\s*\n([\s\S]*?)^[ \t]*replace:\s*\|/m);
        if (!findMatch) {
          errors.push(`Block for "${relPath}" missing "find: |" section`);
          failed++;
          continue;
        }

        // Parse "replace: |" block – everything indented after "replace: |" until end of block
        const replaceMatch = blockContent.match(/^[ \t]*replace:\s*\|\s*\n([\s\S]*)$/m);
        if (!replaceMatch) {
          errors.push(`Block for "${relPath}" missing "replace: |" section`);
          failed++;
          continue;
        }

        // Strip the common leading indentation (the "  " prefix added by the LLM)
        const stripIndent = (text) => {
          const lines = text.split('\n');
          // Find minimum indentation (ignoring empty lines)
          const nonEmpty = lines.filter(l => l.trim().length > 0);
          if (nonEmpty.length === 0) return text;
          const minIndent = Math.min(...nonEmpty.map(l => l.match(/^(\s*)/)[1].length));
          return lines.map(l => l.slice(minIndent)).join('\n');
        };

        const findText = stripIndent(findMatch[1]);
        const replaceText = stripIndent(replaceMatch[1]);

        // Remove trailing newline added by the block parser
        const findStr = findText.replace(/\n$/, '');
        const replaceStr = replaceText.replace(/\n$/, '');

        // Read the file and apply the replacement
        // In dry-run mode, read from virtual FS first (may have prior sandbox patches)
        const original = this.dryRun
          ? (this.sandbox.readFile(absPath) || fs.readFileSync(absPath, 'utf-8'))
          : fs.readFileSync(absPath, 'utf-8');

        if (!original.includes(findStr)) {
          errors.push(`"find:" text not found in ${relPath}. First 80 chars: "${findStr.slice(0, 80).replace(/\n/g, '↵')}"`);
          failed++;
          continue;
        }

        if (this.dryRun) {
          // Dry-run: record as a sandbox patch operation, do NOT touch real FS
          this.sandbox.patchFile(absPath, findStr, replaceStr);
          console.log(`[Orchestrator] 🧪 [DryRun] Would patch: ${relPath}`);
        } else {
          // Replace only the FIRST occurrence (same as replace_in_file tool behaviour)
          const updated = original.replace(findStr, replaceStr);
          fs.writeFileSync(absPath, updated, 'utf-8');
          console.log(`[Orchestrator] ✏️  Patched: ${relPath}`);
        }
        applied++;

      } catch (err) {
        errors.push(`Error processing block: ${err.message}`);
        failed++;
      }
    }

    if (applied === 0 && failed === 0) {
      errors.push('No [REPLACE_IN_FILE] blocks found in LLM response');
      failed++;
    }

    return { applied, failed, errors };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Builds investigation tools for SelfCorrectionEngine deep investigation.
   * Wires up: search (ExperienceStore keyword search), readSource (fs scan),
   * queryExperience (ExperienceStore context block).
   *
   * @param {string} stageLabel - e.g. 'Architecture' | 'TestReport'
   * @returns {object} investigationTools
   */
  _buildInvestigationTools(stageLabel) {
    const self = this;

    // N4 fix (revised): per-stage cache keyed by stageLabel.
    // Each stage reads a different set of files at a different point in time:
    //   Architecture → requirements.md (architecture.md may not exist yet)
    //   Code         → requirements.md + architecture.md (post-review version)
    //   TestReport   → requirements.md + architecture.md + code.diff
    // Caching per-stage ensures each stage sees the correct, up-to-date files
    // without paying repeated I/O cost within the same stage's investigation loop.
    const _getSourceCache = () => {
      if (self._investigationSourceCacheMap.has(stageLabel)) {
        return self._investigationSourceCacheMap.get(stageLabel);
      }

      // Determine which files to read based on the current stage
      const filesToRead = [
        PATHS.AGENTS_MD,
        path.join(PATHS.OUTPUT_DIR, 'requirements.md'),
      ];
      if (stageLabel === 'Code' || stageLabel === 'TestReport') {
        // architecture.md is finalised (post-review) by the time CODE/TEST stages run
        filesToRead.push(path.join(PATHS.OUTPUT_DIR, 'architecture.md'));
      }
      if (stageLabel === 'TestReport') {
        // code.diff is available by the time TEST stage runs
        filesToRead.push(path.join(PATHS.OUTPUT_DIR, 'code.diff'));
      }

      const parts = [];
      for (const filePath of filesToRead) {
        if (fs.existsSync(filePath)) {
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const excerpt = raw.slice(0, 800);
            parts.push(`**${path.basename(filePath)}** (excerpt):\n${excerpt}`);
            console.log(`  [Investigation:readSource] Read ${path.basename(filePath)} (${raw.length} chars).`);
          } catch (err) {
            console.warn(`  [Investigation:readSource] Failed to read ${filePath}: ${err.message}`);
          }
        }
      }
      const result = parts.length > 0 ? parts.join('\n\n---\n\n') : null;
      self._investigationSourceCacheMap.set(stageLabel, result);
      return result;
    };

    return {
      /**
       * Search: query ExperienceStore for related positive/negative experiences
       * by keyword, then ask LLM to summarise findings.
       */
      search: async (query) => {
        console.log(`  [Investigation:search] Querying experience store for: "${query}"`);
        const results = self.experienceStore.search({ keyword: query, limit: 5, scoreSort: true });
        if (!results || results.length === 0) {
          console.log(`  [Investigation:search] No experience records found.`);
          return null;
        }
        const snippets = results.slice(0, 5).map((r, i) =>
          `${i + 1}. [${r.type}] ${r.title}\n   ${r.content?.slice(0, 200) ?? ''}`
        ).join('\n\n');
        console.log(`  [Investigation:search] Found ${results.length} record(s). Using top ${Math.min(results.length, 5)}.`);
        return snippets;
      },

      /**
       * Read source: scan output artifacts and AGENTS.md for relevant context.
       * Uses a session-level cache so multiple signals share one file read (N7 fix).
       */
      readSource: async (signalType, _content) => {
        const cached = _getSourceCache();
        if (!cached) {
          console.log(`  [Investigation:readSource] No source files found.`);
        }
        return cached;
      },

      /**
       * Query experience: get the full experience context block for the stage's skill domain.
       * The skill domain is determined entirely by stageLabel – signal type is irrelevant
       * because all signals within a stage share the same skill domain.
       * (N28 fix: the old skillMap was dead code – every key mapped to the same value as
       * defaultSkill, so skillMap[signalType] always equalled defaultSkill anyway.)
       */
      queryExperience: async (signalType) => {
        const skillName = stageLabel === 'Architecture' ? 'architecture-design'
                        : stageLabel === 'Code'         ? 'code-development'
                        : 'test-report';
        const contextBlock = self.experienceStore.getContextBlock(skillName);
        if (!contextBlock) {
          console.log(`  [Investigation:queryExperience] No experience context for signal type "${signalType}".`);
          return null;
        }
        console.log(`  [Investigation:queryExperience] Retrieved experience context (${contextBlock.length} chars).`);
        return contextBlock;
      },

      /**
       * Query code graph: look up symbol details by name.
       * Available for Code and TestReport stages where symbol-level context is useful.
       */
      queryGraph: async (symbolName) => {
        if (stageLabel !== 'Code' && stageLabel !== 'TestReport') return null;
        console.log(`  [Investigation:queryGraph] Looking up symbol: "${symbolName}"`);
        try {
          const md = self.codeGraph.querySymbolsAsMarkdown([symbolName]);
          if (!md || md.includes('_No matching') || md.includes('_Code graph not')) return null;
          console.log(`  [Investigation:queryGraph] Found symbol info for "${symbolName}".`);
          return md;
        } catch (err) {
          console.warn(`  [Investigation:queryGraph] Failed: ${err.message}`);
          return null;
        }
      },
    };
  }

  /**
   * Registers built-in skills for common development domains.
   */
  _registerBuiltinSkills() {
    // Load skills from workflow.config.js; fall back to a minimal built-in set
    const configSkills = (this._config && this._config.builtinSkills) || [];
    const builtins = configSkills.length > 0 ? configSkills : [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'architecture-design',    description: 'Architecture design patterns, principles and best practices', domains: ['architecture', 'design'] },
      { name: 'code-development',       description: 'Code development patterns, coding standards and best practices', domains: ['development', 'coding'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'api-design',             description: 'REST/RPC API design rules and patterns', domains: ['backend', 'api'] },
      { name: 'test-report',            description: 'Test report writing standards and quality assurance patterns', domains: ['testing', 'qa'] },
    ];

    if (configSkills.length > 0) {
      console.log(`[Orchestrator] Registering ${builtins.length} skills from workflow.config.js`);
    } else {
      console.log(`[Orchestrator] No workflow.config.js found. Using minimal built-in skills.`);
    }

    for (const skill of builtins) {
      try {
        this.skillEvolution.registerSkill(skill);
      } catch (err) {
        // Only swallow "already registered" errors; re-throw unexpected ones
        if (!err.message.includes('already registered') && !err.message.includes('already exists')) {
          console.warn(`[Orchestrator] Failed to register built-in skill "${skill.name}": ${err.message}`);
        }
      }
    }
  }
}

module.exports = { Orchestrator };
