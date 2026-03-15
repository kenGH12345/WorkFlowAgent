# AGENTS.md – WorkFlow Agent Project Index

> This file is the **entry point** for AI agents. It is a directory index, not a rule dump.
> Read this file first, then follow the links to the relevant documents.
> Last updated: 2026-03-15

---

## Quick Start

**Output format**: Always begin your response with `> 🔄 启用wf工作流` as the very first line.

**Session start**: Read the documents below in order, then pick ONE task from `output/feature-list.json`.

---

## Knowledge Base

| Document | What's Inside | Read When |
|----------|--------------|----------|
| `docs/agent-collaboration.md` | Session protocol, task rules, output format | Every session |
| `docs/architecture-constraints.md` | File size limits, module boundaries, naming rules | **Auto-injected** before writing code |
| `docs/decision-log.md` | Why things are the way they are (ADRs) | **Auto-injected** (relevant entries only) |
| `skills/*.md` | Domain skill knowledge (SOP, best practices, anti-patterns) | **Auto-injected** by keyword matching |
| `skills/workflow-orchestration.md` | Full workflow SOP (INIT→ANALYSE→ARCHITECT→CODE→TEST) | When running a workflow |
| `README.md` | Project overview, quick start, migration guide | First time setup |
| `project-init-template/init-checklist.md` | Step-by-step guide to onboard a new project | When starting on a new project |

> **Auto-injection**: `docs/architecture-constraints.md`, relevant `docs/decision-log.md` ADR entries,
> and matching `skills/*.md` files are **automatically injected** into every Agent prompt by `ContextLoader`.
> You do NOT need to manually read these — they arrive in your context automatically.
---

## Project Structure

```
workflow/
├── AGENTS.md                    ← You are here (index only)
├── docs/
│   ├── agent-collaboration.md   ← Session protocol & AI rules
│   ├── architecture-constraints.md  ← Enforced code rules
│   └── decision-log.md          ← Architecture decisions (ADRs)
├── index.js                     ← Orchestrator entry point
├── agents/                      ← Specialist agents
├── core/                        ← Core services
│   ├── git-integration.js       ← Git: branch, commit, push, PR/MR creation
│   ├── sandbox.js               ← Dry-run: intercept file writes, preview mode
│   └── ...
├── commands/                    ← Slash command handlers
├── hooks/                       ← Lifecycle hooks & MCP adapters
├── skills/                      ← Skill knowledge files
├── tools/                       ← Thin/thick tool adapters
├── output/                      ← All agent artifacts land here
│   ├── pr-description.md        ← Auto-generated PR description (git.enabled)
│   └── dry-run-report.md        ← Pending ops report (sandbox.dryRun)
├── project-init-template/       ← Template for onboarding new projects
│   ├── AGENTS.md                ← Project AGENTS.md template
│   ├── docs/architecture.md     ← Project architecture doc template
│   └── init-checklist.md        ← Step-by-step onboarding guide
└── tests/                       ← E2E test suite
```

---

## Agent Role Boundaries

| Agent | Allowed | Forbidden |
|-------|---------|-----------|
| **AnalystAgent** | Write `output/requirement.md` | Write code, architecture, tests |
| **ArchitectAgent** | Write `output/architecture.md` | Write code, modify requirements |
| **DeveloperAgent** | Write code diff | Modify requirements, architecture, tests |
| **TesterAgent** | Write test report | Modify any source files |

---

## Critical Rules (Summary)

1. Work on **ONE task at a time**
2. Every task needs a `verificationNote` before marking done
3. Fix broken environment **before** starting new work
4. All decisions go in `docs/decision-log.md`, not just chat
5. Constraints in `docs/architecture-constraints.md` are **enforced**
6. **New modules must be integrated into both `run()` and `runTaskBased()` paths** (see `docs/decision-log.md` N-series fixes)

> Full details: see `docs/agent-collaboration.md`

---

## Git PR Workflow (New)

Enable in `workflow.config.js` → `git.enabled: true` or pass `git: { enabled: true }` to the constructor.

```js
const orchestrator = new Orchestrator({
  projectId: 'my-project',
  llmCall,
  git: {
    enabled:    true,
    baseBranch: 'main',
    autoPush:   true,       // push branch to remote
    draft:      false,      // create as ready-for-review PR
    labels:     ['ai-generated'],
    reviewers:  ['alice'],
  },
});
```

**What happens automatically at the end of each run:**
1. Creates `feat/<date>-<slug>` branch (if currently on base branch)
2. Commits all workflow artifacts with a structured message
3. Pushes branch to remote (if `autoPush: true`)
4. Invokes `gh pr create` (GitHub CLI) or `glab mr create` (GitLab CLI) if available
5. Always writes `output/pr-description.md` as fallback

**Prerequisites:** `git init` + optionally install [GitHub CLI](https://cli.github.com) or GitLab CLI.

---

## Dry-Run / Sandbox Mode (New)

Enable in `workflow.config.js` → `sandbox.dryRun: true` or pass `dryRun: true` to the constructor.

```js
const orchestrator = new Orchestrator({
  projectId: 'my-project',
  llmCall,
  dryRun: true,   // intercept all file writes
});

await orchestrator.run('Build a REST API');

// Review what would be changed:
console.log(orchestrator.sandbox.report());

// Apply changes to real FS when ready:
await orchestrator.sandbox.apply();

// Or discard:
orchestrator.sandbox.reset();
```

**What dry-run intercepts:**
- All `[REPLACE_IN_FILE]` patches applied by DeveloperAgent / auto-fix loop
- All file writes in the workflow output pipeline

**What dry-run does NOT intercept:**
- `output/*.md` artifact files (requirement, architecture, test-report) — these are workflow metadata, not source code
- Git operations (git is skipped entirely in dry-run mode)
