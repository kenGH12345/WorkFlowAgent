# {PROJECT_NAME} Architecture Decisions

> Last updated: {DATE}
> Maintained by: AI Agent + Human review

## Project Overview

**{PROJECT_NAME}** is a {BRIEF_DESCRIPTION}.
Target platforms: {PLATFORMS}.

---

## Architecture Constraints (ENFORCED)

| Constraint | Rule |
|-----------|------|
| File size | Single file <= {MAX_LINES} lines |
| Naming | {NAMING_RULE} |
| Data separation | Business data must live in `data/` subdirectory |
| State management | {STATE_MANAGEMENT_RULE} |

---

## Key User Journeys (Acceptance Criteria)

> These are the acceptance criteria for "done".
> Each journey must be testable end-to-end.

### Journey 1: {JOURNEY_NAME}
1. {STEP_1}
2. {STEP_2}
3. {STEP_3}

### Journey 2: {JOURNEY_NAME}
1. {STEP_1}
2. {STEP_2}

---

## ADR-001: {FIRST_DECISION_TITLE} ({DATE})

**Status**: Accepted

**Context**:
{WHY_THIS_DECISION_WAS_NEEDED}

**Decision**:
{WHAT_WAS_DECIDED}

**Consequences**:
- {POSITIVE_CONSEQUENCE}
- {TRADEOFF_IF_ANY}
