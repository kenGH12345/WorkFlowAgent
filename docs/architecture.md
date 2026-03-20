# WorkFlowAgent Architecture Decisions

> Last updated: 2026-03-18
> Maintained by: AI Agent + Human review

## Project Overview

**WorkFlowAgent** is a JS project.
Target platforms: TBD.

---

## Architecture Constraints (ENFORCED)

| Constraint | Rule |
|-----------|------|
| File size | Single file <= 600 lines |
| Naming | Follow language conventions |
| Data separation | Business data must live in `data/` subdirectory |
| State management | TBD |

---

## Key User Journeys (Acceptance Criteria)

> These are the acceptance criteria for "done".
> Each journey must be testable end-to-end.

### Journey 1: Core User Journey
1. User opens the application
2. User performs the main action
3. User sees the expected result

---

## ADR-001: Adopt JS as primary tech stack (2026-03-18)

**Status**: Accepted

**Context**:
Project was initialized with the /wf workflow. Tech stack auto-detected as JS.

**Decision**:
Use JS as the primary tech stack. State management: TBD.

**Consequences**:
- Workflow is ready to use. All project-specific config auto-generated.
- Review auto-generated values and update if needed.
