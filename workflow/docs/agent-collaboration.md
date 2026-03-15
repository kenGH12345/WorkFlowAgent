# AI Agent Collaboration Guidelines

> Rules for how AI agents should work on this project.
> Based on Harness Engineering principles (OpenAI, Feb 2026).

---

## Core Principle: Humans Steer, Agents Execute

- **Human role**: Define goals, constraints, acceptance criteria, handle exceptions
- **Agent role**: Implement, test, document within defined boundaries

---

## Session Start Protocol

Every session MUST begin in this order:

1. **Read AGENTS.md** — understand project context
2. **Read `docs/architecture-constraints.md`** — know the enforced rules *(also auto-injected)*
3. **Read `manifest.json`** — understand current workflow state
4. **Read `output/feature-list.json`** — find the highest-priority unfinished task
5. **Check git log** — `git log --oneline -10` to see recent changes

> **Auto-injected context**: `ContextLoader` automatically injects into every Agent prompt:
> - `docs/architecture-constraints.md` — always injected for developer/architect/tester roles
> - `docs/decision-log.md` — relevant ADR entries extracted by keyword matching
> - `skills/*.md` — matching skill files based on task keywords
>
> You do NOT need to manually read these files — they arrive in your context automatically.
> If you need a skill that wasn't injected, mention it explicitly in your task description.

---

## Knowledge Discovery Rules

> "Whether knowledge is discoverable by the Agent matters more than whether it exists."

- All decisions MUST be in `docs/decision-log.md`, NOT just in chat history
- All constraints MUST be in `docs/architecture-constraints.md`
- All acceptance criteria MUST be in `output/feature-list.json` per feature
- Slack messages, verbal agreements, and personal notes = invisible to Agent

---

## Task Execution Rules

1. **One task at a time** — never start a second task before the first is committed
2. **Verify before done** — every task needs a `verificationNote` describing how it was tested
3. **Fix broken environment first** — if tests fail at session start, fix before new work
4. **Constraint check** — before marking done, verify no architecture constraints are violated

---

## When to Create a New ADR

Create a new entry in `docs/decision-log.md` when:
- A file is split or merged
- A new dependency is added
- A UX flow is changed
- A naming convention is established
- A constraint is added or relaxed

---

## Functional Correctness Validation

Code quality (lint, architecture) is necessary but NOT sufficient.
A task is only done when the **user journey** it affects still works end-to-end.

For each task, identify which Journey (from the project's architecture.md) it affects,
and verify that journey still passes after the change.

---

## Output Format

Always begin response with: `> 🔄 启用wf工作流`

During work, output brief phase markers:
- `🔍 Analyzing...`
- `📝 Writing...`
- `✅ Phase N done: <summary>`
- `⚠️ Issue found: <description>`
