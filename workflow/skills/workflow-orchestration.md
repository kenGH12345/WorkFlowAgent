---
name: workflow-orchestration
version: 2.0.0
type: domain-skill
domains: [workflow, orchestration]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [workflow, orchestrat, agent, pipeline, stage]
  roles: [analyst, architect, planner, developer, tester, coding-agent]
description: "Multi-agent workflow orchestration SOP"
---
# Skill: Full Workflow Orchestration SOP

> **Type**: Workflow Skill  
> **Version**: 1.0.0  
> **Trigger**: `/ask-workflow-agent` or programmatic call  
> **Description**: Standard Operating Procedure for running the complete multi-agent development workflow from raw requirement to delivered code.

---

## Overview
<!-- PURPOSE: High-level summary of the 7-stage pipeline (INIT→ANALYSE→ARCHITECT→PLAN→CODE→TEST→FINISHED) and inter-agent communication model. -->

This skill orchestrates the full 7-stage pipeline:

```
INIT �?ANALYSE �?ARCHITECT �?PLAN �?CODE �?TEST �?FINISHED
```

Each stage is handled by a dedicated agent with strict role boundaries.  
All inter-agent communication uses **file path references only** (never raw content).

---

## Pre-conditions
<!-- PURPOSE: Prerequisites that must be satisfied before the workflow can start (manifest, user requirement, writable output dir, LLM availability). -->

- [ ] `manifest.json` does not exist (fresh run) OR exists with a resumable state (checkpoint resume)
- [ ] User has provided a raw requirement string
- [ ] `workflow/output/` directory is writable
- [ ] LLM adapter is configured and reachable

---

## Steps
<!-- PURPOSE: Detailed step-by-step SOP for each stage: actor, inputs, actions, outputs, hooks, and state transitions. -->

### Step 1 → INIT
**Actor**: Orchestrator (or AI Agent via terminal)  
**Action**:
1. Check if `manifest.json` exists
   - If YES → load state, skip to the recorded `currentState`
   - If NO → create fresh manifest, set state to `INIT`
2. **Run `node workflow/init-project.js --path <project-root>`** in terminal to:
   - Auto-detect tech stack and generate `workflow.config.js` (if missing)
   - Run ProjectProfiler (deep architecture analysis → `output/project-profile.md`)
   - Build AGENTS.md (global project context)
   - Generate experience store from source files
   - Register built-in skills
   - **Build code-graph** (symbol index + call graph → `output/code-graph.json`, `output/code-graph.md`)
3. Emit `HOOK_EVENTS.AFTER_STATE_TRANSITION` with state `INIT`

> ⚠️ **CRITICAL**: The AI Agent MUST execute `init-project.js` via terminal command,
> NOT attempt to manually replicate its steps. The script handles code-graph construction,
> tech detection, and all 6 initialisation phases automatically.

**Output**: `manifest.json` created/loaded, `output/code-graph.json`, `output/project-profile.md`

---

### Step 2 �?ANALYSE
**Actor**: AnalystAgent  
**Input**: Raw user requirement string  
**Action**:
1. Call `AnalystAgent.run(null, rawRequirement)`
2. Agent writes `output/requirement.md`
3. Orchestrator calls `FileRefBus.publish('analyst', 'architect', requirementMdPath)`
4. State machine transitions: `INIT �?ANALYSE`
5. Record artifact path in manifest

**Output**: `output/requirement.md`  
**Hook**: `HOOK_EVENTS.AFTER_STATE_TRANSITION`

---

### Step 3 �?ARCHITECT
**Actor**: ArchitectAgent  
**Input**: `output/requirement.md` (via FileRefBus)  
**Action**:
1. Orchestrator calls `FileRefBus.consume('architect')` �?gets `requirementMdPath`
2. Call `ArchitectAgent.run(requirementMdPath)`
3. Agent reads file, writes `output/architecture.md`
4. **Human review hook**: emit `HOOK_EVENTS.HUMAN_REVIEW_REQUIRED` with architecture.md path
5. Wait for human confirmation (Socratic question: "Does this architecture meet your expectations?")
6. State machine transitions: `ANALYSE �?ARCHITECT`
7. `FileRefBus.publish('architect', 'planner', architectureMdPath)`

**Output**: `output/architecture.md`  
**Hook**: `HOOK_EVENTS.HUMAN_REVIEW_REQUIRED` (blocks until confirmed)

---

### Step 3.5 �?PLAN
**Actor**: PlannerAgent (Kent Beck �?XP creator, TDD pioneer)  
**Input**: `output/architecture.md` (via FileRefBus)  
**Action**:
1. Orchestrator calls `FileRefBus.consume('planner')` �?gets `architectureMdPath`
2. Inject upstream context (ANALYSE + ARCHITECT summaries) + experience context
3. Call `PlannerAgent.run(architectureMdPath)` �?decomposes architecture into vertical-slice implementation tasks
4. Agent reads architecture, writes `output/execution-plan.md` with:
   - Implementation phases (vertical slices, not horizontal layers)
   - File/function-level task breakdown with acceptance criteria (TDD mindset)
   - Dependency graph (Mermaid)
   - Complexity estimates and risk assessment
5. **SocraticEngine checkpoint**: User reviews and approves/rejects the execution plan
6. State machine transitions: `ARCHITECT �?PLAN`
7. `FileRefBus.publish('planner', 'developer', architectureMdPath, { executionPlanPath })`

**Output**: `output/execution-plan.md`  
**Hook**: SocraticEngine approval (approve / reject / approve with reservations)

---

### Step 4 �?CODE
**Actor**: DeveloperAgent  
**Input**: `output/architecture.md` + `output/execution-plan.md` (via FileRefBus metadata)  
**Action**:
1. Orchestrator calls `FileRefBus.consume('developer')` �?gets `architectureMdPath`
2. Read execution plan from bus metadata (`executionPlanPath`)
3. Call `DeveloperAgent.run(architectureMdPath)` �?follows execution plan task order
4. Agent reads architecture + plan, writes `output/code.diff`
5. State machine transitions: `PLAN �?CODE`

**Output**: `output/code.diff`

---

### Step 5 �?TEST
**Actor**: TesterAgent  
**Input**: `output/code.diff` (via FileRefBus)  
**Action**:
1. Orchestrator calls `FileRefBus.consume('tester')` �?gets `codeDiffPath`
2. Call `TesterAgent.run(codeDiffPath)`
3. Agent reads diff, writes `output/test-report.md`
4. State machine transitions: `CODE �?TEST`
5. Check test report for Critical/High defects
   - If defects found �?emit `HOOK_EVENTS.HUMAN_REVIEW_REQUIRED`
   - If clean �?proceed to FINISHED

**Output**: `output/test-report.md`

---

### Step 6 �?FINISHED
**Actor**: Orchestrator  
**Action**:
1. State machine transitions: `TEST �?FINISHED`
2. Save `FileRefBus` communication log to `output/communication-log.json`
3. Emit `HOOK_EVENTS.WORKFLOW_COMPLETE`
4. Print summary of all artifacts

**Output**: All artifacts in `output/` directory

---

## Coding Principles
<!-- PURPOSE: 7 coding principles that all code produced by agents must follow: no over-engineering, reuse, minimal change, incremental delivery, study first, pragmatic, clear intent. -->

These principles apply to all code produced by the DeveloperAgent and any human contributor:

| # | Principle | Guidance |
|---|-----------|----------|
| 1 | **No over-engineering** | Keep code simple, readable, and practical. Avoid abstractions that aren't needed yet. |
| 2 | **Reuse over reinvention** | Prefer existing utilities, modules, and patterns before writing new ones. |
| 3 | **Minimal change** | Touch only what is necessary. Do not refactor unrelated code in the same commit. |
| 4 | **Incremental delivery** | Each change must compile and pass tests independently. Small steps, always green. |
| 5 | **Study before coding** | Read existing code first, plan the approach, then implement. |
| 6 | **Pragmatic over dogmatic** | Adapt to the project's actual conventions rather than enforcing external ideals. |
| 7 | **Clear intent over clever code** | Choose the simplest solution that communicates its purpose. |

---

## Error Handling
<!-- PURPOSE: Error handling matrix: boundary violations, LLM failures, missing files, human review timeouts �?with prescribed actions for each. -->

| Scenario | Action |
|----------|--------|
| Agent boundary violation | Emit `AGENT_BOUNDARY_VIOLATION` hook, abort stage, log to manifest risks |
| LLM call failure | Retry up to 3 times, then emit `WORKFLOW_ERROR` hook |
| File not found | Throw error with clear message, do NOT proceed to next stage |
| Human review timeout | Wait indefinitely (no timeout) �?human must respond |

---

## Artifacts Produced
<!-- PURPOSE: Complete artifact manifest: file name, producer agent, consumer agent �?for traceability and debugging. -->

| File | Producer | Consumer |
|------|----------|----------|
| `output/requirement.md` | AnalystAgent | ArchitectAgent |
| `output/architecture.md` | ArchitectAgent | PlannerAgent, DeveloperAgent |
| `output/execution-plan.md` | PlannerAgent | DeveloperAgent, TesterAgent |
| `output/code.diff` | DeveloperAgent | TesterAgent |
| `output/test-report.md` | TesterAgent | Human reviewer |
| `manifest.json` | StateMachine | All agents (read-only) |
| `output/communication-log.json` | FileRefBus | Observability |

---

## Rules
<!-- PURPOSE: Prescriptive constraints for workflow orchestration. -->

1. **Never skip a pipeline stage** �?Even if the user says "just code it", the workflow must pass through ANALYSE �?ARCHITECT �?PLAN �?CODE �?TEST. Each stage produces artifacts that downstream stages depend on. Skipping creates invisible debt.

2. **FileRefBus is the only inter-agent communication channel** �?Agents must NEVER pass raw content directly. All communication goes through file path references published to the bus. This ensures traceability and enables replay/debugging.

3. **State machine transitions are irreversible within a run** �?Once the workflow advances from PLAN to CODE, you cannot go back to PLAN. If a fundamental flaw is discovered, the workflow must complete (or be aborted) and restarted.

4. **Human review checkpoints are blocking** �?The orchestrator must WAIT for human approval at ARCHITECT and PLAN stages. Never auto-approve on timeout. The human review exists to catch architectural mistakes that are expensive to fix later.

5. **Each agent must operate within its boundary** �?The AnalystAgent must not write architecture decisions. The DeveloperAgent must not modify the execution plan. Boundary violations are logged and should trigger an abort.

6. **Manifest.json is the single source of truth** �?Current state, artifact paths, timestamps, and error history all live in manifest.json. If there's a conflict between in-memory state and manifest, manifest wins.

## Checklist
<!-- PURPOSE: Verification checklist for workflow orchestration. -->

### Pre-workflow
- [ ] Raw requirement string is provided and non-empty
- [ ] `workflow/output/` directory exists and is writable
- [ ] No stale `manifest.json` from a previous aborted run (or user confirms resume)
- [ ] LLM adapter is configured and a test call succeeds

### Post-workflow
- [ ] All 6 artifact files exist in `output/` (requirement, architecture, execution-plan, code.diff, test-report, communication-log)
- [ ] manifest.json shows `currentState: FINISHED`
- [ ] Test report has zero Critical/High defects
- [ ] Communication log shows correct agent-to-agent handoffs

### Per-stage
- [ ] Agent output file is non-empty and valid markdown
- [ ] State transition is recorded in manifest.json
- [ ] FileRefBus publish/consume pairs match (no orphaned messages)

## Best Practices
<!-- PURPOSE: Recommended patterns for workflow orchestration. -->

1. **Use the SocraticEngine for ambiguity resolution** �?When the AnalystAgent identifies ambiguous requirements, don't guess. Use the Socratic questioning mechanism to ask the user targeted questions. One round of clarification saves hours of rework.

2. **Checkpoint aggressively** �?After each stage completes, persist the manifest immediately. If the process crashes between stages, the next run can resume from the last checkpoint instead of starting over.

3. **Include upstream context in downstream prompts** �?The PlannerAgent should receive summaries of ANALYSE and ARCHITECT outputs, not just the raw architecture.md. Upstream context prevents the planner from contradicting earlier decisions.

4. **Monitor LLM token usage per stage** �?Track tokens consumed by each agent. If the AnalystAgent consistently uses 80% of the token budget, the requirement input is probably too large and should be chunked.

5. **Run the TesterAgent even for "obvious" changes** �?Small changes cause surprising regressions. The TesterAgent catches issues that the DeveloperAgent's self-review misses because it has a different perspective (black-box vs white-box).

## Anti-Patterns
<!-- PURPOSE: Common workflow orchestration mistakes. -->

1. **"Let me just code it directly"** �?Skipping ANALYSE and ARCHITECT to jump straight to CODE. Result: code that doesn't match requirements, architecture that's ad-hoc, and a test report that's meaningless because there was nothing to test against. �?Skip �?�?Full pipeline, every time.

2. **Passing raw content between agents** �?Agent A dumps 5000 lines of code into Agent B's prompt instead of writing to a file and passing the path. Result: token budget blown, context truncated, critical information lost. �?Raw content �?�?File path references.

3. **Auto-approving human review** �?Setting a timeout on human review and auto-approving. Result: architectural flaws slip through and compound. By the time they're discovered in TEST, fixing them requires restarting from ARCHITECT. �?Auto-approve �?�?Block until human responds.

4. **Ignoring the execution plan during CODE** �?DeveloperAgent writes code in whatever order feels natural instead of following the planner's task sequence and dependency graph. Result: missing dependencies, incomplete features, tasks done out of order. �?Freestyle �?�?Follow the plan.

5. **Not checking test report for defects** �?Marking the workflow as FINISHED without reading the test report. Critical defects found by TesterAgent are silently ignored. �?Auto-finish �?�?Gate on zero Critical/High defects.

## Gotchas
<!-- PURPOSE: Environment-specific traps for workflow orchestration. -->

1. **LLM rate limits can stall the pipeline** �?If the LLM provider returns 429 (rate limited), the orchestrator must implement exponential backoff. Without this, the workflow fails mid-pipeline, leaving artifacts in an inconsistent state.

2. **File system race conditions on Windows** �?Atomic write (tmp + rename) can fail on Windows if another process has the target file open. The `EPERM` error is misleading. Workaround: retry with short delay, or ensure no other process watches the output directory.

3. **Large diffs exceed LLM context window** �?If code.diff is > 50KB, the TesterAgent's prompt may be truncated, causing it to miss critical changes. Workaround: chunk the diff by file and run multiple tester passes, then merge reports.

4. **Manifest.json corruption on power loss** �?If the process crashes during a manifest write, the file may be truncated. Workaround: use atomic write pattern (write to tmp, then rename). This is already implemented in the orchestrator but must be verified after unexpected shutdowns.

## Context Hints
<!-- PURPOSE: Background knowledge for workflow orchestration decisions. -->

1. **The 7-stage pipeline was inspired by the Waterfall model but is NOT waterfall** �?Each stage is short (minutes, not months) and the full pipeline runs per-feature, not per-release. It's closer to a structured single-iteration Agile sprint.

2. **FileRefBus was designed for observability** �?The decision to use file references instead of direct content passing was driven by debuggability. When something goes wrong, you can inspect every artifact independently without replaying the entire conversation.

3. **The human review checkpoint at ARCHITECT is the highest-ROI quality gate** �?Fixing an architecture mistake at the ARCHITECT stage costs 5 minutes. Finding the same mistake at TEST costs hours (the entire CODE stage must be redone). This is why the review is blocking, not optional.

4. **Agent boundary violations are the #1 cause of quality issues** �?When the AnalystAgent starts making architecture decisions (crossing into the ArchitectAgent's domain), the resulting document is neither a good spec nor a good architecture. Strict boundaries produce better outputs from each agent.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-17 | Initial creation with 7-stage pipeline, Steps SOP, Coding Principles, Error Handling, Artifacts |
| v2.0.0 | 2026-03-19 | Skill-enrich-all: added 7 standard sections (Rules, Checklist, Best Practices, Anti-Patterns, Gotchas, Context Hints) |
