# Skill: Full Workflow Orchestration SOP

> **Type**: Workflow Skill  
> **Version**: 1.0.0  
> **Trigger**: `/ask-workflow-agent` or programmatic call  
> **Description**: Standard Operating Procedure for running the complete multi-agent development workflow from raw requirement to delivered code.

---

## Overview

This skill orchestrates the full 6-stage pipeline:

```
INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED
```

Each stage is handled by a dedicated agent with strict role boundaries.  
All inter-agent communication uses **file path references only** (never raw content).

---

## Pre-conditions

- [ ] `manifest.json` does not exist (fresh run) OR exists with a resumable state (checkpoint resume)
- [ ] User has provided a raw requirement string
- [ ] `workflow/output/` directory is writable
- [ ] LLM adapter is configured and reachable

---

## Steps

### Step 1 – INIT
**Actor**: Orchestrator  
**Action**:
1. Check if `manifest.json` exists
   - If YES → load state, skip to the recorded `currentState`
   - If NO → create fresh manifest, set state to `INIT`
2. Build global context: run `MemoryManager.buildGlobalContext()`
3. Emit `HOOK_EVENTS.AFTER_STATE_TRANSITION` with state `INIT`

**Output**: `manifest.json` created/loaded

---

### Step 2 – ANALYSE
**Actor**: AnalystAgent  
**Input**: Raw user requirement string  
**Action**:
1. Call `AnalystAgent.run(null, rawRequirement)`
2. Agent writes `output/requirement.md`
3. Orchestrator calls `FileRefBus.publish('analyst', 'architect', requirementMdPath)`
4. State machine transitions: `INIT → ANALYSE`
5. Record artifact path in manifest

**Output**: `output/requirement.md`  
**Hook**: `HOOK_EVENTS.AFTER_STATE_TRANSITION`

---

### Step 3 – ARCHITECT
**Actor**: ArchitectAgent  
**Input**: `output/requirement.md` (via FileRefBus)  
**Action**:
1. Orchestrator calls `FileRefBus.consume('architect')` → gets `requirementMdPath`
2. Call `ArchitectAgent.run(requirementMdPath)`
3. Agent reads file, writes `output/architecture.md`
4. **Human review hook**: emit `HOOK_EVENTS.HUMAN_REVIEW_REQUIRED` with architecture.md path
5. Wait for human confirmation (Socratic question: "Does this architecture meet your expectations?")
6. State machine transitions: `ANALYSE → ARCHITECT`

**Output**: `output/architecture.md`  
**Hook**: `HOOK_EVENTS.HUMAN_REVIEW_REQUIRED` (blocks until confirmed)

---

### Step 4 – CODE
**Actor**: DeveloperAgent  
**Input**: `output/architecture.md` (via FileRefBus)  
**Action**:
1. Orchestrator calls `FileRefBus.consume('developer')` → gets `architectureMdPath`
2. Call `DeveloperAgent.run(architectureMdPath)`
3. Agent reads file, writes `output/code.diff`
4. State machine transitions: `ARCHITECT → CODE`

**Output**: `output/code.diff`

---

### Step 5 – TEST
**Actor**: TesterAgent  
**Input**: `output/code.diff` (via FileRefBus)  
**Action**:
1. Orchestrator calls `FileRefBus.consume('tester')` → gets `codeDiffPath`
2. Call `TesterAgent.run(codeDiffPath)`
3. Agent reads diff, writes `output/test-report.md`
4. State machine transitions: `CODE → TEST`
5. Check test report for Critical/High defects
   - If defects found → emit `HOOK_EVENTS.HUMAN_REVIEW_REQUIRED`
   - If clean → proceed to FINISHED

**Output**: `output/test-report.md`

---

### Step 6 – FINISHED
**Actor**: Orchestrator  
**Action**:
1. State machine transitions: `TEST → FINISHED`
2. Save `FileRefBus` communication log to `output/communication-log.json`
3. Emit `HOOK_EVENTS.WORKFLOW_COMPLETE`
4. Print summary of all artifacts

**Output**: All artifacts in `output/` directory

---

## Coding Principles

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

| Scenario | Action |
|----------|--------|
| Agent boundary violation | Emit `AGENT_BOUNDARY_VIOLATION` hook, abort stage, log to manifest risks |
| LLM call failure | Retry up to 3 times, then emit `WORKFLOW_ERROR` hook |
| File not found | Throw error with clear message, do NOT proceed to next stage |
| Human review timeout | Wait indefinitely (no timeout) – human must respond |

---

## Artifacts Produced

| File | Producer | Consumer |
|------|----------|----------|
| `output/requirement.md` | AnalystAgent | ArchitectAgent |
| `output/architecture.md` | ArchitectAgent | DeveloperAgent |
| `output/code.diff` | DeveloperAgent | TesterAgent |
| `output/test-report.md` | TesterAgent | Human reviewer |
| `manifest.json` | StateMachine | All agents (read-only) |
| `output/communication-log.json` | FileRefBus | Observability |
