# Architecture Constraints

> These constraints are enforced for all code changes in this project.
> Violations must be fixed before a task is considered done.

## File Size Limits

| File Type | Max Lines | Action if Exceeded |
|-----------|-----------|-------------------|
| `index.js` (orchestrator) | 600 lines | Extract to core/ module |
| `core/*.js` | 400 lines | Split by responsibility |
| `agents/*.js` | 300 lines | Extract helper functions |
| `commands/command-router.js` | 100 lines | Hub only; delegate to sub-routers |
| `commands/commands-*.js` | 500 lines | Split by command domain |

## Module Boundaries

```
Types → Constants → Core → Agents → Commands → Index
```

- `types.js` has NO imports from other workflow modules
- `constants.js` imports ONLY from `types.js`
- `core/*.js` imports from `types.js` and `constants.js` only
- `agents/*.js` imports from `core/` but NOT from other agents
- `commands/` imports from `agents/` and `core/`
- `index.js` is the only file that orchestrates everything

## Naming Conventions

- Agent classes: `XxxAgent` (e.g., `AnalystAgent`, `DeveloperAgent`)
- Core services: `XxxManager`, `XxxEngine`, `XxxStore`
- Output files: always written to `output/` directory
- Skill files: `kebab-case.md` in `skills/`

## Communication Protocol

- Agents NEVER pass raw content to each other
- All inter-agent communication uses **file path references only**
- Raw content is read by each agent from its own input file

## State Management

- All state transitions write to `manifest.json`
- State machine is the single source of truth for workflow phase
- No agent modifies `manifest.json` directly — only `state-machine.js`
- `manifest.json` reads/writes are protected by `FileLockManager` (optimistic locking)
- State transitions (`transition`, `rollback`, `jumpTo`) are mutex-guarded against reentrancy

## Command Router Architecture

```
command-router.js  (hub: registry + dispatch, ~80 lines)
  ├── commands-workflow.js      (wf, wf-tasks, workflow-status, etc.)
  ├── commands-agentflow.js     (task-list, experience-*, complaint-*, etc.)
  ├── commands-devtools.js      (gc, ci, graph, evolve, deep-audit, etc.)
  ├── commands-doctor.js        (workflow-doctor: environment health check)
  └── commands-marketplace.js   (skill-export, skill-import, help)
```

- Each sub-router exports a single `registerXxxCommands(registerCommand)` function
- Sub-routers NEVER call `dispatch()` directly
- The `/help` command must be registered last (in marketplace) to see all commands

## Structured Logging (P1-4)

- `core/logger.js` provides a structured JSON Lines logger
- In CI environments, set `CODEXFORGE_LOG_FORMAT=json` for machine-parseable output
- Logger auto-writes to `output/workflow.log.jsonl` when outputDir is available
- All new code SHOULD use `logger.info/warn/error()` instead of raw `console.log()`

## Manifest Version Migration (P1-5)

- `core/manifest-migration.js` provides forward-only schema migration
- Current manifest schema version: defined in `CURRENT_VERSION`
- Migrations are applied automatically in `StateMachine._readManifest()`
- Original manifest is backed up before migration (`manifest.json.backup-v1.0.0`)
- Each migration is a pure function: `(manifest) => manifest`

## Agent Negotiation Protocol (P1-2, ADR-40)

- `core/negotiation-engine.js` provides structured inter-agent negotiation
- Downstream agents raise concerns via `HOOK_EVENTS.NEGOTIATE_REQUEST`
- Orchestrator mediates: auto-approve / targeted-rollback / human-review
- Max 2 negotiation rounds per stage pair; falls back to rollback after
- Negotiation log persisted to `output/negotiation-log.json`

## Expert Review Panel (Deep Audit)

- Fixed expert panel defined in `core/deep-audit-orchestrator.js` → `EXPERT_PANEL`
- Panel: Karpathy (chair), Fowler, Hightower, Ghemawat, Verou
- Each expert assigned specific audit dimensions matching their expertise
- `buildExpertReviewPrompt(finding)` generates expert-persona LLM prompts

## TypeScript Support (P1-6)

- `workflow/index.d.ts` provides type declarations for the public API
- Covers: Orchestrator, StateMachine, HookSystem, LlmRouter, CommandRouter, Logger
- TypeScript users get IntelliSense and type checking without migrating to TS

## Cross-Project Experience Router (P2-1)

- `core/experience-router.js` provides intelligent cross-project experience migration
- Shared registry: `~/.codexforge/experience-registry.json` (file-based, zero network)
- Auto-import at workflow start: `ExperienceRouter.autoImport()` pre-loads relevant experiences
- Publish at workflow completion: `ExperienceRouter.publish()` exports high-value experiences
- Relevance scoring: tech stack overlap (50%) × quality (30%) × recency (20%)
- Max 100 projects in registry, max 20 auto-imported experiences per run

## Stage Context Store LRU (P2-2)

- `StageContextStore` constructor accepts `maxEntries` (default 20) and `maxTotalChars` (default 50K)
- LRU eviction triggered after every `set()` — least-recently-accessed entries evicted first
- Access tracking: every `get()` and `set()` updates access timestamp
- `getLruStats()` returns current size, total chars, and limits
- Prevents unbounded memory growth in long-running service mode or many-stage workflows

## Workflow Server (P2-3)

- `core/workflow-server.js` provides long-running HTTP service mode
- Zero new dependencies (built-in Node.js `http` module)
- Endpoints: `/healthz` (liveness), `/readyz` (readiness), `/status` (detailed), `POST /workflow` (trigger)
- Graceful shutdown: SIGTERM/SIGINT → finish in-flight workflow → close
- Rejects new workflows while one is running (single-tenant queue)

## Core Module Contracts (P2-4)

- `core/contracts.js` defines explicit interface specifications for 9 core modules
- Contracts: IStateMachine, IHookSystem, IExperienceStore, IStageRunner, IMCPAdapter, ILogger, IStageContextStore, INegotiationEngine, IExperienceRouter
- `assertContract(contract, instance)` validates at registration time (not call time)
- Checks method existence, arity, and required properties
- Use in ServiceContainer registration: `assertContract(IStateMachine, sm, { strict: true })`

## Dual-Path Unification Rule (run / runTaskBased)

> **Mandatory**: Any module added or updated in `index.js` MUST be integrated
> into **both** execution paths (`run()` and `runTaskBased()`) using the same
> shared implementation. Duplicating logic between the two paths is forbidden.

### Shared Entry/Exit Points

| Phase | Shared Method | What it covers |
|-------|--------------|----------------|
| Startup | `_initWorkflow()` | StateMachine.init, memory.buildGlobalContext, memory.startWatching, AGENTS.md cache (`this._agentsMdContent`), complaint pre-check |
| Teardown | `_finalizeWorkflow()` | bus.saveLog, memory.stopWatching, obs.printDashboard, getRisks summary, stateMachine.flushRisks, WORKFLOW_COMPLETE emit, SelfReflection validateRun + auditHealth, obs.flushPromptTraces, complaint→troubleshooting export |

### Per-Module Integration Rules

| Module | run() trigger | runTaskBased() trigger | Shared impl |
|--------|--------------|----------------------|-------------|
| `EntropyGC` | Inside `_runTester()` + FINISHED fallback | After all tasks complete | `obs.recordEntropyResult()` |
| `CodeGraph` | `_rebuildCodeGraphAsync()` post-developer + FINISHED | After all tasks complete | `obs.recordCodeGraphResult()` |
| `CIIntegration` | Inside `_runTester()` post-test | After all tasks complete | `obs.recordCIResult()` |
| `SocraticEngine` | ANALYSE / ARCHITECT / TEST phase gates | N/A (no phase boundaries in parallel mode) | Decision helper methods |
| `SelfReflection` | `_finalizeWorkflow()` (validateRun + auditHealth) | `_finalizeWorkflow()` (same) | Gating results → obs.recordReflectionGating(), summary → prompt injection |
| `PromptTracing` | `recordLlmCall()` (every LLM call) | `recordLlmCall()` (every LLM call) | Digests → obs.flushPromptTraces() → prompt-traces.jsonl, summary → run-metrics.json |
| `MemoryManager` | `_initWorkflow()` | `_initWorkflow()` | Injected via `this._agentsMdContent` |
| `DecompositionValidation` | N/A (sequential has no decomposition) | `runAuto()` pre-dispatch | `_validateDecomposition()` — pure logic, 0 tokens |
| `CrossTaskCoherence` | N/A (single pipeline, no cross-task) | `runTaskBased()` post-CI | `_checkCrossTaskCoherence()` — 1 LLM call, ~2K tokens |
| `RequirementCoverage` | N/A (CoverageChecker in ARCHITECT stage) | `runTaskBased()` post-CI | `_checkRequirementCoverage()` — pure logic, 0 tokens |
| `GoalAwareExecution` | N/A (sequential mode has natural context flow) | `_executeTask()` + `_evaluateReplan()` | Injects `_currentRequirement` as global goal context, ~50 tokens/task |

### Cached Resources — Never Re-Read Inside Loops

The following resources are loaded **once** in `_initWorkflow()` and cached on
`this`. All methods (including `_executeTask()`) MUST use the cached value:

| Resource | Cache field | Loaded in |
|----------|------------|-----------|
| AGENTS.md content | `this._agentsMdContent` | `_initWorkflow()` |

### Checklist for Adding a New Module

1. Implement the core logic as a standalone method or class in `core/`.
2. Call it from `_initWorkflow()` (startup) or `_finalizeWorkflow()` (teardown)
   if it applies to both paths.
3. If it is phase-specific, add it to **both** `run()` and `runTaskBased()` at
   the equivalent lifecycle point.
4. Record the module in the table above.
5. Add an `obs.recordXxxResult()` call so the dashboard reflects the result.
