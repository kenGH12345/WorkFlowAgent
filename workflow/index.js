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
const { buildAgentPrompt, setPromptSlotManager, getPromptSlotManager } = require('./core/prompt-builder');
const { PromptSlotManager } = require('./core/prompt-slot-manager');
const { WorkflowState, AgentRole, STATE_ORDER } = require('./core/types');
const { PATHS, HOOK_EVENTS } = require('./core/constants');
// AgentFlow modules
const { TaskManager, TaskStatus } = require('./core/task-manager');
const { ExperienceStore, ExperienceType, ExperienceCategory } = require('./core/experience-store');
const { ComplaintWall, ComplaintSeverity, ComplaintTarget, ComplaintStatus, RootCause } = require('./core/complaint-wall');
const { SkillEvolutionEngine } = require('./core/skill-evolution');
const { getConfig } = require('./core/config-loader');
const { SelfCorrectionEngine, formatClarificationReport } = require('./core/clarification-engine');
const { RequirementClarifier } = require('./core/requirement-clarifier');
const { CoverageChecker } = require('./core/coverage-checker');
const { CodeReviewAgent, REVIEW_DIMENSIONS, ITEM_TO_DIMENSION } = require('./core/code-review-agent');
const { ArchitectureReviewAgent } = require('./core/architecture-review-agent');
const { TestRunner } = require('./core/test-runner');
const { Observability } = require('./core/observability');
const { EntropyGC } = require('./core/entropy-gc');
const { CIIntegration } = require('./core/ci-integration');
const { CodeGraph } = require('./core/code-graph');
const { GitIntegration } = require('./core/git-integration');
const { DryRunSandbox } = require('./core/sandbox');
const _git       = require('./core/orchestrator-git');
const _stages    = require('./core/orchestrator-stages');
const _helpers   = require('./core/orchestrator-helpers');
const _lifecycle = require('./core/orchestrator-lifecycle');
const _task      = require('./core/orchestrator-task');
const { StageContextStore } = require('./core/stage-context-store');
// P0/P1 optimisation: ServiceContainer (DI), StageRunner (stage interface), StageRegistry (stage registration)
const { ServiceContainer } = require('./core/service-container');
const { StageRunner, StageRegistry } = require('./core/stage-runner');
const { AnalystStage, ArchitectStage, DeveloperStage, TesterStage } = require('./core/stages');
// P3 optimisation: multi-model routing support
const { LlmRouter } = require('./core/llm-router');
// MCP (Model Context Protocol) adapters: pluggable external system integration
const { MCPRegistry, TAPDAdapter, DevToolsAdapter } = require('./hooks/mcp-adapter');

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
   * @param {Object<string, Function>} [options.llmRoutes] - P3: Per-role LLM model overrides.
   *   Keys are role names (e.g. 'ANALYST', 'ARCHITECT', 'DEVELOPER', 'TESTER').
   *   Values are async (prompt: string) => string functions.
   *   When specified, each role uses its own LLM model instead of the shared llmCall.
   *   Roles without an explicit override fall back to the default llmCall.
   *   Example: { ARCHITECT: claudeOpusCall, DEVELOPER: gpt4oCall }
   */
  constructor({ projectId, llmCall, projectRoot = null, askUser = null, dryRun = false, git = {}, outputDir = null, llmRoutes = {} }) {
    this.projectId = projectId;
    this.projectRoot = projectRoot || path.resolve(__dirname, '..');

    // P1-D fix: support per-instance outputDir so multiple Orchestrator instances
    // (e.g. one per task in a multi-project setup) can write to isolated directories
    // without conflicting on shared files like stage-context.json, architecture.md, etc.
    //
    // Previously StageContextStore (and several helpers) always used the global
    // PATHS.OUTPUT_DIR constant, which is a single shared directory. If two Orchestrator
    // instances ran concurrently (or sequentially in the same process), their output
    // files would overwrite each other.
    //
    // Fix: accept an optional outputDir constructor argument. If not provided, fall back
    // to the global PATHS.OUTPUT_DIR (backward-compatible). Store as this._outputDir so
    // all instance methods (StageContextStore, buildDeveloperContextBlock, etc.) can use
    // it instead of the global constant.
    this._outputDir = outputDir || PATHS.OUTPUT_DIR;
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
    this.stateMachine = new StateMachine(projectId, this.hooks.getEmitter(), {
      manifestPath: path.join(this._outputDir, 'manifest.json'),
    });
    this.memory = new MemoryManager(this.projectRoot);
    this.socratic = new SocraticEngine();

    // Initialise AgentFlow subsystems
    this.taskManager = new TaskManager();
    this.experienceStore = new ExperienceStore();
    // Purge expired experiences at startup to keep the store lean.
    // Negative experiences expire after 90 days, positive after 365 days (configurable via ttlDays).
    this.experienceStore.purgeExpired();
    this.complaintWall = new ComplaintWall();

    // ── Defect F fix: Bidirectional sync between ExperienceStore and ComplaintWall ──
    // Previously these two systems were isolated information silos:
    //   - Resolving a complaint didn't create a positive experience (knowledge lost)
    //   - Recording a negative experience didn't file a complaint (problem untracked)
    // Now they cross-reference each other:
    //   ComplaintWall.resolve() → auto-creates POSITIVE experience (solution capture)
    //   ExperienceStore.record(NEGATIVE) → auto-files complaint (problem tracking)
    this.experienceStore.setComplaintWall(this.complaintWall);
    this.complaintWall.setExperienceStore(this.experienceStore);
    console.log(`[Orchestrator] 🔗 ExperienceStore ↔ ComplaintWall bidirectional sync established.`);

    this.skillEvolution = new SkillEvolutionEngine();

    // ── StageContextStore: cross-stage semantic context propagation ──────────
    // P2-A fix: initialise StageContextStore eagerly in the constructor instead of
    // lazily in _runAnalyst. The lazy pattern had two problems:
    //   1. If _runAnalyst is skipped (e.g. direct call to _runArchitect or checkpoint
    //      resume past ANALYSE), stageCtx is never initialised and downstream helpers
    //      (buildArchitectUpstreamCtx, storeArchitectContext, etc.) throw TypeError.
    //   2. Hiding a side-effect (this.stageCtx = ...) inside a "pure" stage runner
    //      violates the single-responsibility principle and makes the code harder to test.
    // The store is always fresh per Orchestrator instance (one instance = one workflow run).
    //
    // P1-D fix: use this._outputDir instead of the global PATHS.OUTPUT_DIR constant.
    // If multiple Orchestrator instances run concurrently (e.g. one per project in a
    // multi-project setup), each instance now writes stage-context.json to its own
    // isolated output directory, preventing file conflicts.
    this.stageCtx = new StageContextStore({
      outputDir: this._outputDir,
      verbose: false,
    });
    console.log(`[Orchestrator] 🔗 StageContextStore initialised for cross-stage context propagation.`);

    // Register built-in skills
    this._registerBuiltinSkills();

    // Wrap llmCall with prompt builder
    // P1-NEW-4 fix: wrap _rawLlmCall itself with a token-metering layer so that ALL
    // LLM calls (SelfCorrectionEngine, _runRealTestLoop, runAuto, translateMdFile, etc.)
    // are counted – not just the ones that go through wrappedLlm.
    // Previously ~60% of token consumption from these "hidden" callers was invisible
    // to the Observability module. The wrapper is transparent: it estimates tokens from
    // the prompt length, records the call under the special role '__internal', and
    // returns the response unchanged.
    const _originalLlmCall = llmCall;

    // ── P3: LlmRouter (multi-model routing) ──────────────────────────────────
    // When llmRoutes is provided, different agent roles can use different LLM models.
    // This enables cost optimisation (cheap model for requirement analysis, strong model
    // for architecture design) and quality tuning (best coding model for development).
    // The router maintains a Map<role, llmCall> with a default fallback.
    this.llmRouter = new LlmRouter(_originalLlmCall, llmRoutes);
    if (Object.keys(llmRoutes).length > 0) {
      console.log(`[Orchestrator] 🔀 LlmRouter configured with ${Object.keys(llmRoutes).length} role-specific route(s): [${Object.keys(llmRoutes).join(', ')}]`);
    }
    this._rawLlmCall = async (prompt) => {
      try {
        // Estimate tokens from prompt length (char / 4 heuristic, same as buildAgentPrompt)
        const promptStr = Array.isArray(prompt)
          ? prompt.map(m => (typeof m === 'object' ? (m.content || '') : String(m))).join(' ')
          : String(prompt || '');
        const estimatedTokens = Math.ceil(promptStr.length / 4);
        this.obs.recordLlmCall('__internal', estimatedTokens);
      } catch (_) { /* metering must never break the call */ }

      // P1-A fix: when prompt is a multi-turn conversation array, try to pass it
      // directly to _originalLlmCall first (works if the caller's llmCall supports
      // the OpenAI messages array format). If _originalLlmCall throws a TypeError
      // (e.g. it only accepts strings), fall back to serialising the history into a
      // single string so the multi-turn context is not silently lost.
      //
      // Serialisation format:
      //   [User]: <content>
      //   [Assistant]: <content>
      //   ...
      // This is readable by any LLM and preserves the full reasoning chain.
      let response;
      if (Array.isArray(prompt)) {
        try {
          response = await _originalLlmCall(prompt);
        } catch (arrayErr) {
          // _originalLlmCall does not support array input – serialise to string
          console.warn(`[Orchestrator] ⚠️  _rawLlmCall: llmCall does not support message arrays (${arrayErr.message}). Serialising conversation history to string.`);
          const serialised = prompt
            .map(m => {
              const role = (m && m.role) ? m.role : 'user';
              const content = (m && m.content) ? String(m.content) : String(m);
              return `[${role.charAt(0).toUpperCase() + role.slice(1)}]: ${content}`;
            })
            .join('\n\n');
          response = await _originalLlmCall(serialised);
        }
      } else {
        response = await _originalLlmCall(prompt);
      }
      try {
        const actualTokens = (response && typeof response === 'object')
          ? (response.usage?.total_tokens ?? response.usage?.input_tokens ?? null)
          : null;
        if (actualTokens != null) {
          this.obs.recordActualTokens('__internal', actualTokens);
        }
      } catch (_) { /* metering must never break the call */ }
      return response;
    };

    // ── LLM Query Expansion: inject LLM into ExperienceStore ─────────────────
    // The experience store uses LLM-based query expansion to semantically expand
    // search keywords with synonyms, abbreviations, and related terms. This bridges
    // the vocabulary gap between how experiences are stored and how they are searched.
    // Uses the metered _rawLlmCall so expansion calls are tracked by Observability.
    this.experienceStore.setLlmCall(this._rawLlmCall);

    // P1-NEW-3 fix: independent rollback counter Map, keyed by stage name.
    // Using stageCtx.meta for rollback counting is unsafe because RollbackCoordinator
    // calls stageCtx.delete(stage) during rollback, which resets the counter to 0
    // and can cause infinite recursion (_runTester → rollback → _runDeveloper → _runTester).
    // This Map lives on the Orchestrator instance and is never cleared by rollback logic.
    this._rollbackCounters = new Map();

    // ── Observability: session-level metrics collector ──────────────────────
    this.obs = new Observability(PATHS.OUTPUT_DIR, projectId);

    // ── Adaptive Strategy: derive from cross-session history ────────────────
    // Reads metrics-history.jsonl (if it exists) and adjusts retry/review counts
    // based on recent failure patterns. Falls back to config defaults if no history.
    const cfgAutoFix = (this._config && this._config.autoFixLoop) || {};
    this._adaptiveStrategy = Observability.deriveStrategy(PATHS.OUTPUT_DIR, {
      maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
      maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
      maxExpInjected:  cfgAutoFix.maxExpInjected  ?? 5,
      projectId:       projectId,
    });
    if (this._adaptiveStrategy.source !== 'defaults') {
      console.log(`[Orchestrator] 📈 Adaptive strategy loaded from ${this._adaptiveStrategy.source}:`);
      console.log(`[Orchestrator]    maxFixRounds=${this._adaptiveStrategy.maxFixRounds} | maxReviewRounds=${this._adaptiveStrategy.maxReviewRounds} | skipEntropyOnClean=${this._adaptiveStrategy.skipEntropyOnClean} | maxExpInjected=${this._adaptiveStrategy.maxExpInjected}`);
      if (this._adaptiveStrategy._debug) {
        const d = this._adaptiveStrategy._debug;
        console.log(`[Orchestrator]    (testFailRate=${d.testFailRate}, errorTrend=${d.errorTrend}, sessions=${d.sessionCount}, expHitRate=${d.expHitRate})`);
      }
    }

    // ── PromptSlotManager: Prefix-Level A/B testing ─────────────────────────
    // Manages prompt variant selection and auto-promotion for agent fixed prefixes.
    // If prompt-variants.json exists, buildAgentPrompt() will resolve prefixes from
    // the variant registry instead of using hardcoded AGENT_FIXED_PREFIXES.
    this.promptSlotManager = new PromptSlotManager(
      PATHS.PROMPT_VARIANTS_JSON,
      this.hooks.getEmitter()
    );
    // Inject into prompt-builder module so buildAgentPrompt() can access it
    setPromptSlotManager(this.promptSlotManager);

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
    // P1-NEW-4: wrappedLlm calls _originalLlmCall directly (not _rawLlmCall) to avoid
    // double-counting: wrappedLlm already records the call under the agent role, and
    // _rawLlmCall's metering wrapper would add a second '__internal' entry for the same call.
    const wrappedLlm = (role) => async (prompt) => {
      // N72 fix: wrap buildAgentPrompt in try/catch so an unknown role does not
      // crash the entire task worker – fall back to the raw prompt instead.
      let optimisedPrompt = prompt;
      try {
        const result = buildAgentPrompt(role, prompt);
        optimisedPrompt = result.prompt;
        console.log(`[Orchestrator] LLM call for ${role}: ~${result.meta.estimatedTokens} tokens`);
        this.obs.recordLlmCall(role, result.meta.estimatedTokens || 0);
      } catch (err) {
        console.warn(`[Orchestrator] buildAgentPrompt failed for role "${role}": ${err.message}. Using raw prompt.`);
        this.obs.recordLlmCall(role, 0);
      }
      // P2-A fix: extract actual token usage from LLM response (if the LLM client
      // attaches a .usage object to the response string, e.g. via a custom wrapper).
      // Standard OpenAI/Anthropic SDKs return usage in the response object; if the
      // caller wraps the response as a plain string, actual tokens remain null and
      // we fall back to the estimated count. No error is thrown either way.
      // P3: use LlmRouter to get the role-specific LLM function.
      // If llmRoutes was configured with a per-role override (e.g. ARCHITECT → Claude Opus),
      // that function is used instead of the default _originalLlmCall.
      const roleLlm = this.llmRouter.getRawForRole(role);
      const rawResponse = await roleLlm(optimisedPrompt);
      const actualTokens = (rawResponse && typeof rawResponse === 'object')
        ? (rawResponse.usage?.total_tokens ?? rawResponse.usage?.input_tokens ?? null)
        : null;
      if (actualTokens != null) {
        this.obs.recordActualTokens(role, actualTokens);
        console.log(`[Orchestrator] 📊 Token usage for ${role}: ${actualTokens} actual tokens`);
      }
      return (typeof rawResponse === 'object' && rawResponse !== null && 'text' in rawResponse)
        ? rawResponse.text
        : rawResponse;
    };

    // P2-b: pass instance-level outputDir so agents write to the correct directory
    const agentOpts = { outputDir: this._outputDir };
    this.agents = {
      [AgentRole.ANALYST]:   new AnalystAgent(wrappedLlm(AgentRole.ANALYST), emitter, agentOpts),
      [AgentRole.ARCHITECT]: new ArchitectAgent(wrappedLlm(AgentRole.ARCHITECT), emitter, agentOpts),
      [AgentRole.DEVELOPER]: new DeveloperAgent(wrappedLlm(AgentRole.DEVELOPER), emitter, agentOpts),
      [AgentRole.TESTER]:    new TesterAgent(wrappedLlm(AgentRole.TESTER), emitter, agentOpts),
    };

    // ── P1-a: ServiceContainer (Dependency Injection) ────────────────────────
    // Instead of Orchestrator directly instantiating 20+ subsystems, the
    // ServiceContainer provides lazy initialisation, testability (mock injection),
    // and replaceability (swap subsystems at runtime via register with force=true).
    //
    // For backward compatibility, we register all existing subsystem instances
    // that were already created above. New code should use
    // this.services.resolve('name') instead of direct property access.
    this.services = new ServiceContainer();
    this.services.registerValue('projectId', this.projectId);
    this.services.registerValue('projectRoot', this.projectRoot);
    this.services.registerValue('outputDir', this._outputDir);
    this.services.registerValue('config', this._config);
    this.services.registerValue('hooks', this.hooks);
    this.services.registerValue('bus', this.bus);
    this.services.registerValue('stateMachine', this.stateMachine);
    this.services.registerValue('memory', this.memory);
    this.services.registerValue('socratic', this.socratic);
    this.services.registerValue('taskManager', this.taskManager);
    this.services.registerValue('experienceStore', this.experienceStore);
    this.services.registerValue('complaintWall', this.complaintWall);
    this.services.registerValue('skillEvolution', this.skillEvolution);
    this.services.registerValue('stageCtx', this.stageCtx);
    this.services.registerValue('obs', this.obs);
    this.services.registerValue('entropyGC', this.entropyGC);
    this.services.registerValue('ci', this.ci);
    this.services.registerValue('codeGraph', this.codeGraph);
    this.services.registerValue('git', this.git);
    this.services.registerValue('sandbox', this.sandbox);
    this.services.registerValue('agents', this.agents);
    this.services.registerValue('rawLlmCall', this._rawLlmCall);
    this.services.registerValue('adaptiveStrategy', this._adaptiveStrategy);
    this.services.registerValue('llmRouter', this.llmRouter);
    console.log(`[Orchestrator] 🏗️  ServiceContainer initialised with ${this.services.getRegisteredNames().length} service(s).`);

    // ── P0/P1-b: StageRegistry (stage registration) ─────────────────────────
    // Replaces the hardcoded _runStage switch pattern. New stages can be added by:
    //   1. Creating a class that extends StageRunner
    //   2. Calling orchestrator.registerStage(name, runner)
    // Built-in stages are registered in order: ANALYSE → ARCHITECT → CODE → TEST
    this.stageRegistry = new StageRegistry();
    this.stageRegistry.register(new AnalystStage());
    this.stageRegistry.register(new ArchitectStage());
    this.stageRegistry.register(new DeveloperStage());
    this.stageRegistry.register(new TesterStage());
    console.log(`[Orchestrator] 🔧 StageRegistry initialised: [${this.stageRegistry.getOrder().join(' → ')}]`);

    // ── MCP (Model Context Protocol) Integration ──────────────────────────────
    // Initialise MCPRegistry and auto-register adapters from workflow.config.js.
    // Previously mcp-adapter.js was a fully-implemented but completely orphaned
    // module – defined, exported, documented in README, but never require()'d by
    // any runtime code. This bridges the gap.
    //
    // The registry is wired into HookSystem so WORKFLOW_COMPLETE / WORKFLOW_ERROR
    // events are automatically broadcast to all connected MCP adapters (TAPD,
    // DevTools, etc.), enabling zero-config external system notifications.
    this.mcpRegistry = new MCPRegistry();
    const cfgMcp = (this._config && this._config.mcp) || {};
    if (cfgMcp.tapd) {
      this.mcpRegistry.register(new TAPDAdapter(cfgMcp.tapd));
    }
    if (cfgMcp.devtools) {
      this.mcpRegistry.register(new DevToolsAdapter(cfgMcp.devtools));
    }
    // Wire MCP into HookSystem: broadcast lifecycle events to all connected adapters
    this.hooks.on(HOOK_EVENTS.WORKFLOW_COMPLETE, async (payload) => {
      await this.mcpRegistry.broadcastNotify('workflow_complete', payload).catch(() => {});
    });
    this.hooks.on(HOOK_EVENTS.WORKFLOW_ERROR, async (payload) => {
      await this.mcpRegistry.broadcastNotify('workflow_error', {
        error: payload.error?.message ?? String(payload.error),
        state: payload.state,
      }).catch(() => {});
    });
    // Register in ServiceContainer for DI access
    this.services.registerValue('mcpRegistry', this.mcpRegistry);
    if (cfgMcp.tapd || cfgMcp.devtools) {
      console.log(`[Orchestrator] 🔌 MCPRegistry initialised with ${cfgMcp.tapd ? 'TAPD' : ''}${cfgMcp.tapd && cfgMcp.devtools ? ' + ' : ''}${cfgMcp.devtools ? 'DevTools' : ''} adapter(s).`);
    }
  }

  // ─── _initWorkflow and _finalizeWorkflow: see orchestrator-lifecycle.js ───

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
    //
    // P2-E fix: inject AGENTS.md into the decomposition prompt.
    //
    // Previous problem: runAuto() called _rawLlmCall() BEFORE _initWorkflow(), so
    // this._agentsMdContent was always undefined at this point. The task decomposition
    // LLM had no knowledge of the project's tech stack, constraints, or conventions,
    // and could produce task plans that were inappropriate for the current project
    // (e.g. suggesting Java tasks for a Node.js project, or ignoring existing modules).
    //
    // Fix: eagerly read AGENTS.md here if it hasn't been loaded yet by _initWorkflow().
    // We use the cached value if available (set by _initWorkflow in run()/runTaskBased()),
    // or read it directly from disk if runAuto() is the entry point (most common case).
    // This is safe: AGENTS.md is a read-only file at this point; no write has happened yet.
    // _initWorkflow() will re-read and cache it later – that's fine (idempotent).
    let agentsMdForDecomposition = this._agentsMdContent;
    if (!agentsMdForDecomposition) {
      try {
        agentsMdForDecomposition = fs.existsSync(PATHS.AGENTS_MD)
          ? fs.readFileSync(PATHS.AGENTS_MD, 'utf-8')
          : '';
        if (agentsMdForDecomposition) {
          console.log(`[Orchestrator] 📋 AGENTS.md pre-loaded for task decomposition (${agentsMdForDecomposition.length} chars).`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  Could not pre-load AGENTS.md for task decomposition: ${err.message}`);
        agentsMdForDecomposition = '';
      }
    }

    const decompositionPrompt = [
      `You are a **Task Decomposition Analyst**. Analyse the following software requirement and decide whether it should be executed as:`,
      `  A) A single sequential workflow (ANALYSE → ARCHITECT → CODE → TEST)`,
      `  B) Multiple parallel tasks with dependencies`,
      ``,
      // P2-E fix: inject AGENTS.md so the LLM knows the project's tech stack,
      // constraints, and conventions when deciding how to decompose the requirement.
      agentsMdForDecomposition
        ? `## Project Context (AGENTS.md)\n${agentsMdForDecomposition.slice(0, 3000)}${agentsMdForDecomposition.length > 3000 ? '\n... (truncated for decomposition)' : ''}`
        : '',
      agentsMdForDecomposition ? `` : '',
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

    // ── Enhancement 1: Task Decomposition Self-Validation ─────────────────────
    // After LLM decomposes the requirement, run a lightweight self-validation pass
    // to catch structural issues BEFORE committing to parallel execution.
    // This is a pure-logic check (no LLM call, 0 extra tokens, <1ms).
    // If validation fails, fall back to sequential mode (safer).
    const validationResult = this._validateDecomposition(taskDefs, rawRequirement);
    if (!validationResult.valid) {
      console.warn(`[Orchestrator] ⚠️  Task decomposition self-validation FAILED:`);
      for (const issue of validationResult.issues) {
        console.warn(`  • ${issue}`);
      }
      console.log(`[Orchestrator] ▶️  Falling back to sequential mode due to decomposition quality issues.`);
      if (this.stateMachine && this.stateMachine.manifest) {
        this.stateMachine.recordRisk('medium', `[DecompositionValidation] Parallel plan rejected: ${validationResult.issues.join('; ')}`);
      }
      return this.run(rawRequirement);
    }
    if (validationResult.warnings.length > 0) {
      console.log(`[Orchestrator] ⚠️  Decomposition validation warnings:`);
      for (const w of validationResult.warnings) {
        console.warn(`  • ${w}`);
        if (this.stateMachine && this.stateMachine.manifest) {
          this.stateMachine.recordRisk('low', `[DecompositionValidation] ${w}`);
        }
      }
    }
    console.log(`[Orchestrator] ✅ Task decomposition validated: ${taskDefs.length} tasks, coverage=${validationResult.coverageRate}%`);

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
      // P2-3 fix: before truncating, collect the titles of tasks that WILL be kept
      // so we can later validate that no kept task depends on a truncated task.
      // Previously, truncation was silent – if task 10 depended on task 13 (truncated),
      // the dependency was silently dropped, causing incorrect execution order.
      const keptTitles = new Set(
        taskLines.slice(0, 12).map(l => l.slice(2).replace(/\[deps:[^\]]*\]/i, '').trim())
      );
      const droppedTitles = new Set(
        taskLines.slice(12).map(l => l.slice(2).replace(/\[deps:[^\]]*\]/i, '').trim())
      );
      taskLines.splice(12);
      // Warn if any kept task depends on a dropped task
      for (const line of taskLines) {
        const depsMatch = line.match(/\[deps:\s*([^\]]+)\]/i);
        if (depsMatch && depsMatch[1].trim().toLowerCase() !== 'none') {
          const depTitles = depsMatch[1].split(',').map(d => d.trim());
          for (const depTitle of depTitles) {
            if (droppedTitles.has(depTitle)) {
              console.warn(`[Orchestrator] ⚠️  P2-3: Task depends on truncated task "${depTitle}". Dependency will be dropped – execution order may be incorrect.`);
            }
          }
        }
      }
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
    console.log(`  ⚒  CODEX FORGE — Multi-Agent Runtime`);
    console.log(`  Project: ${this.projectId}`);
    console.log(`${'='.repeat(60)}\n`);

    // P1-NEW-2: store current requirement so stage functions can pass it to
    // getContextBlock() for task-relevance scoring (instead of global hitCount).
    this._currentRequirement = rawRequirement;

    // 1–3. Shared startup: StateMachine init + memory + AGENTS.md + complaints
    const resumeState = await this._initWorkflow();

    try {
      // 4. Execute stages via StageRegistry (P0/P1-b: replaces hardcoded stage calls).
      //
      // The StageRegistry contains all pipeline stages in order (e.g. ANALYSE → ARCHITECT → CODE → TEST).
      // Each stage is a StageRunner subclass that implements execute(context).
      // Custom stages can be inserted via orchestrator.registerStage(runner, { before/after }).
      //
      // STATE_ORDER is still used by StateMachine for state transition validation.
      // The StageRegistry provides the execution order and the runner implementations.
      // The two must be kept in sync – a registered stage name must have a corresponding
      // WorkflowState entry for StateMachine.transition() to work.
      //
      // For built-in stages, the mapping is:
      //   ANALYSE   → INIT      → ANALYSE
      //   ARCHITECT → ANALYSE   → ARCHITECT
      //   CODE      → ARCHITECT → CODE
      //   TEST      → CODE      → TEST
      //   (FINISHED is implicit – no runner needed)

      const stages = this.stageRegistry.getStages();
      // Build the fromState/toState pairs for each registered stage.
      // The first stage transitions from INIT to its name; subsequent stages
      // transition from the previous stage name to their own name.
      // The last stage's output transitions to FINISHED.
      const stateOrder = [WorkflowState.INIT, ...stages.map(s => s.name), WorkflowState.FINISHED];

      for (let i = 0; i < stages.length; i++) {
        const { name, runner } = stages[i];
        const fromState = stateOrder[i];     // e.g. INIT for first stage
        const toState   = stateOrder[i + 1]; // e.g. ANALYSE for first stage

        await this._runStage(fromState, toState, async () => {
          const stageContext = {
            rawRequirement,
            orchestrator: this,
            services: this.services,
          };
          const result = await runner.execute(stageContext);

          // Special handling: CODE stage triggers incremental code graph update
          if (name === 'CODE') {
            this._rebuildCodeGraphAsync('post-developer');
          }

          return result;
        }, resumeState);
      }

      // Final transition: last registered stage → FINISHED
      await this._runStage(stateOrder[stateOrder.length - 2], WorkflowState.FINISHED, async () => {
        return null; // No agent for FINISHED – just transition
      }, resumeState);

    } catch (err) {
      await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: err, state: this.stateMachine.getState() });

      // Best-effort teardown: even when the workflow fails, commit whatever
      // artifacts were produced so far.  _finalizeWorkflow is wrapped in its
      // own try/catch so a teardown failure cannot mask the original error.
      try {
        await this._finalizeWorkflow('sequential', { requirement: rawRequirement, error: err.message });
      } catch (teardownErr) {
        console.warn(`[Orchestrator] ⚠️  Post-error teardown failed (non-fatal): ${teardownErr.message}`);
      }

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

  // ─── AgentFlow: Task-based methods → see orchestrator-task.js ──────────────
  // runTaskBased(), _runAgentWorker(), _executeTask(), _evaluateReplan(),
  // _validateDecomposition(), _checkCrossTaskCoherence(), _checkRequirementCoverage()


  // ─── Lifecycle + public API methods → see orchestrator-lifecycle.js ─────────
  // ─── Task-based execution methods → see orchestrator-task.js ───────────────
}


module.exports = { Orchestrator, ServiceContainer, StageRunner, StageRegistry, LlmRouter };

//  Mixin: attach extracted methods to Orchestrator.prototype 
// This keeps index.js slim while preserving the same public/private API surface.
Object.assign(Orchestrator.prototype, _git);
Object.assign(Orchestrator.prototype, _stages);
Object.assign(Orchestrator.prototype, _helpers);
Object.assign(Orchestrator.prototype, _lifecycle);
Object.assign(Orchestrator.prototype, _task);