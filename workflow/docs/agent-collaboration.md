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

## `/wf init` Command Protocol

When the user sends `/wf init` (with or without `--path <dir>`), you **MUST** execute the
initialisation script via terminal. Do NOT try to "manually" initialise the project by
reading files and generating a report yourself.

**Required action:**

```bash
# If --path is provided:
node workflow/init-project.js --path <dir>

# If no --path, use the current project root:
node workflow/init-project.js --path <current-project-root>
```

This script performs **all** initialisation steps automatically:
1. Auto-detects tech stack and generates `workflow.config.js` (if missing)
2. Runs ProjectProfiler (deep architecture analysis)
3. Builds AGENTS.md (global project context)
4. Generates experience store from source files
5. Registers built-in skills
6. **Builds code-graph** (symbol index + call relationships → `output/code-graph.json`)

**Rules:**
- You MUST run this command in the terminal, not simulate it
- Wait for the command to complete before responding
- Report the output summary to the user
- If the command fails, show the error output and suggest fixes

---

## `/wf <requirement>` Workflow Execution Protocol

When the user sends `/wf <some requirement text>` (NOT `init` or `analyze`), this is a **workflow trigger**.
You must execute the full multi-agent pipeline: ANALYSE → ARCHITECT → PLAN → CODE → TEST.

**Required behaviour:**
1. Begin response with `> 🔄 启用wf工作流`
2. Execute the pipeline via `orchestrator.run(requirement)`
3. Produce workflow artifacts (`requirement.md`, `architecture.md`, code diff, test report)
4. Report progress at each phase: "✅ Phase 1 done: ...", "🔍 Analyzing...", "📝 Writing..."

**Forbidden behaviour:**
- Do NOT just read code and provide verbal analysis — that is NOT a workflow
- Do NOT skip the pipeline and write code directly — each phase must run in order
- Do NOT treat `/wf <text>` as a chat question

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

---

## Agent Negotiation Protocol (ADR-40)

> When a downstream agent discovers that an upstream artifact is incompatible with its
> capabilities, the system supports structured negotiation instead of blind rollback.

### Problem

Without negotiation, the only recovery mechanism is `rollback()` — which throws away
the downstream agent's work and re-runs the upstream stage from scratch. This is wasteful
when the issue is a minor design choice that could be resolved via clarification.

### Protocol

```
┌──────────────┐     NEGOTIATE_REQUEST      ┌──────────────┐
│  Downstream   │ ─────────────────────────▶ │   Upstream    │
│  (e.g. CODE)  │                            │ (e.g. ARCH)   │
│               │ ◀───────────────────────── │               │
│               │    NEGOTIATE_RESPONSE       │               │
└──────────────┘                              └──────────────┘
```

1. **NEGOTIATE_REQUEST**: Downstream agent raises a structured concern via
   `hookEmitter(HOOK_EVENTS.NEGOTIATE_REQUEST, { from, to, concern, suggestion })`.

2. **Orchestrator Mediation**: The orchestrator evaluates the concern:
   - If the concern is within tolerance (minor naming / param change) → auto-approve
   - If the concern requires upstream re-work → trigger targeted rollback
   - If ambiguous → escalate to human review (Socratic decision)

3. **NEGOTIATE_RESPONSE**: The resolution is recorded in the negotiation log
   and the downstream agent adjusts its approach accordingly.

### Negotiation Concern Types

| Type | Example | Default Resolution |
|------|---------|-------------------|
| `interface_mismatch` | API signature in arch.md doesn't match implementation | Ask upstream to clarify |
| `tech_constraint` | Architecture specifies a lib not available in runtime | Auto-suggest alternative |
| `scope_overflow` | Task requires work outside agent's allowed boundaries | Escalate to human |
| `quality_threshold` | Test coverage too low for the quality gate | Negotiate threshold |

### Implementation

- `HOOK_EVENTS.NEGOTIATE_REQUEST` / `HOOK_EVENTS.NEGOTIATE_RESPONSE` events
- Negotiation log persisted to `output/negotiation-log.json`
- Max negotiation rounds per stage: 2 (prevent infinite loops)
- Falls back to rollback if negotiation fails after max rounds
