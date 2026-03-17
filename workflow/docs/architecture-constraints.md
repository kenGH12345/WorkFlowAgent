# Architecture Constraints

> These constraints are enforced for all code changes in this project.
> Violations must be fixed before a task is considered done.

## File Size Limits

| File Type | Max Lines | Action if Exceeded |
|-----------|-----------|-------------------|
| `index.js` (orchestrator) | 600 lines | Extract to core/ module |
| `core/*.js` | 400 lines | Split by responsibility |
| `agents/*.js` | 300 lines | Extract helper functions |
| `commands/command-router.js` | 300 lines | Group commands into sub-routers |

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

## Dual-Path Unification Rule (run / runTaskBased)

> **Mandatory**: Any module added or updated in `index.js` MUST be integrated
> into **both** execution paths (`run()` and `runTaskBased()`) using the same
> shared implementation. Duplicating logic between the two paths is forbidden.

### Shared Entry/Exit Points

| Phase | Shared Method | What it covers |
|-------|--------------|----------------|
| Startup | `_initWorkflow()` | StateMachine.init, memory.buildGlobalContext, memory.startWatching, AGENTS.md cache (`this._agentsMdContent`), complaint pre-check |
| Teardown | `_finalizeWorkflow()` | bus.saveLog, memory.stopWatching, obs.printDashboard, getRisks summary, stateMachine.flushRisks, WORKFLOW_COMPLETE emit |

### Per-Module Integration Rules

| Module | run() trigger | runTaskBased() trigger | Shared impl |
|--------|--------------|----------------------|-------------|
| `EntropyGC` | Inside `_runTester()` + FINISHED fallback | After all tasks complete | `obs.recordEntropyResult()` |
| `CodeGraph` | `_rebuildCodeGraphAsync()` post-developer + FINISHED | After all tasks complete | `obs.recordCodeGraphResult()` |
| `CIIntegration` | Inside `_runTester()` post-test | After all tasks complete | `obs.recordCIResult()` |
| `SocraticEngine` | ANALYSE / ARCHITECT / TEST phase gates | N/A (no phase boundaries in parallel mode) | Decision helper methods |
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
