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
│   ├── agent-generator.js       ← IDE Agent definition generator (CodeBuddy, Cursor, Claude Code)
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

## 🏠 Foundational Principle: IDE-First, Self-Built Fallback (ADR-37)

> **This is the #1 architectural principle of WorkFlowAgent.**
> All capability decisions MUST follow this rule: if the host IDE already provides
> a capability, use the IDE's version first. Self-built modules are retained as
> fallback for non-IDE environments and for unique capabilities no IDE offers.

| Capability | IDE Tool (preferred) | Self-Built Fallback |
|------------|---------------------|---------------------|
| Semantic code search | `codebase_search` | CodeGraph.search() |
| Exact text search | `grep_search` | CodeGraph (substring) |
| Symbol navigation | `view_code_item` | CodeGraph.querySymbol() |
| Go to definition | IDE built-in LSP | LSPAdapter (self-spawned) |
| Find references | IDE built-in LSP | LSPAdapter (self-spawned) |
| Type inference / hover | IDE built-in LSP (hover) | LSPAdapter.getHover() |
| Read file content | `read_file` | ContextLoader cache |
| **Hotspot analysis** | ❌ *no IDE equivalent* | **CodeGraph (unique)** |
| **Module summary** | ❌ *no IDE equivalent* | **CodeGraph (unique)** |
| **Skill matching** | ❌ *no IDE equivalent* | **ContextLoader (unique)** |
| **Experience routing** | ❌ *no IDE equivalent* | **ExperienceRouter (unique)** |
| **Project profiling** | ❌ *no IDE equivalent* | **ProjectProfiler (unique)** |

**How it works (automatically):**
- `core/ide-detection.js` detects the IDE environment at startup
- `prompt-builder.js` injects an **IDE Tool Guidance** block into every Agent prompt when inside an IDE
- `lsp-adapter.js` skips spawning a language server when IDE already has one
- Agents see the guidance table and automatically prefer IDE tools
- Self-built context (hotspot, skills, experience, ADRs) is always injected — these have no IDE equivalent

> ⚠️ When adding new capabilities, always check: **does the IDE already provide this?**
> If yes → add IDE-first guidance. If no → implement as self-built module.

---

## Critical Rules (Summary)

1. Work on **ONE task at a time**
2. Every task needs a `verificationNote` before marking done
3. Fix broken environment **before** starting new work
4. All decisions go in `docs/decision-log.md`, not just chat
5. Constraints in `docs/architecture-constraints.md` are **enforced**
6. **New modules must be integrated into both `run()` and `runTaskBased()` paths** (see `docs/decision-log.md` N-series fixes)
7. **IDE-First principle**: prefer IDE-native tools over self-built modules (see ADR-37)
8. **Long Task Protocol**: for multi-step tasks, always show progress (see ADR-41 and `docs/agent-collaboration.md`)

---

## 📍 Progress Beacon (ADR-41)

> Prevents "deep-dive amnesia" — the loss of global task awareness when drilling into details.

**Automated workflow mode** (`runTaskBased()`):
- The orchestrator automatically injects a Progress Beacon into every task's Agent context
- Beacon shows: which tasks are ✅ done, 🔄 current, ⬜ remaining
- Cost: ~100-200 tokens (negligible vs. total context)

**Interactive dialogue mode** (`/wf` commands):
- Agents MUST manually display progress after each step
- Format: `📍 Progress: N/M completed` + checklist
- Key decisions that affect later steps MUST be carried forward

**User visibility**:
- Users can see progress through: console phase markers, progress dashboard in responses,
  `output/feature-list.json`, and optional `output/scratchpad.md`

> Full protocol details: see `docs/agent-collaboration.md` → "Long Task Protocol"

> Full details: see `docs/agent-collaboration.md`

---

## `/wf init` Command (MUST USE TERMINAL)

When the user sends `/wf init` or `/wf init --path <dir>`, you **MUST** run the initialisation
script via terminal. **Do NOT** manually read files and generate a "project status report" yourself.

```bash
node workflow/init-project.js --path <project-root>
```

This one command handles **everything**: tech detection, config generation, AGENTS.md, experience
store, skill registration, and **code-graph construction** (symbol index + call relationships).

> ⚠️ This is not optional. The `/wf init` command MUST be executed as a terminal command.

### Auto-Detection (Zero Config)

The init script **auto-detects** `projectName`, `techStack`, `sourceExtensions`, and `ignoreDirs`
from the project files at runtime. These are NOT stored in `workflow.config.js` — they are
re-detected fresh every time. Users never need to manually configure them.

### Path Anchoring Rule (CRITICAL)

When `--path` is provided, the init script scans from that **exact root directory**, not from
any subdirectory. **Never** substitute a subdirectory path for the `--path` argument.

- ✅ `--path /path/to/MyProject` → scans the entire project from root
- ❌ `--path /path/to/MyProject/src/sub-module` → only scans one sub-module (WRONG)

---

## `/wf <requirement>` Workflow Execution (CRITICAL)

When the user sends `/wf <requirement>` (anything that is NOT `init` or `analyze`), this triggers
the **full multi-agent workflow pipeline**: ANALYSE → ARCHITECT → PLAN → CODE → TEST.

**You MUST:**
1. Begin your response with `> 🔄 启用wf工作流`
2. Actually execute the pipeline via `orchestrator.run(requirement)` or the equivalent terminal command
3. Produce real workflow artifacts: `requirement.md`, `architecture.md`, `execution-plan.md`, code diff, test report

**You MUST NOT:**
- Just read code and give a verbal analysis
- Skip the pipeline and directly write code
- Treat `/wf` as a regular chat question

> ⚠️ The `/wf` command is a **workflow trigger**, not a code analysis request.
> If the environment is not initialized, run `/wf init` first, then execute the workflow.

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

---

## 🤖 IDE Agent Mode (Recommended)

WorkFlowAgent can be installed as a **native IDE Agent**, appearing directly in the
IDE's mode selector (e.g. CodeBuddy's Craft/Ask/Plan dropdown). This is the recommended
integration — zero MCP config, zero external processes, full IDE context access.

### How It Works

`/wf init` automatically generates agent definition files for all supported IDEs:

| IDE | Generated File | How to Use |
|-----|---------------|------------|
| **CodeBuddy** | `.codebuddy/agents/workflow-agent.md` | Select "workflow-agent" in mode dropdown |
| **Cursor** | `.cursor/rules/workflow-agent.mdc` | Auto-loaded as agent rule |
| **Claude Code** | `.claude/agents/workflow-agent.md` | Available as `/workflow-agent` |

### What the Agent Knows

The generated agent definition includes:
- **Project context**: name, tech stack, frameworks, architecture pattern
- **IDE-First principle**: tool preference table (ADR-37)
- **Smart triage**: complexity scoring guide for routing decisions
- **7-stage SOP**: full ANALYSE→ARCHITECT→PLAN→CODE→TEST pipeline
- **Coding principles**: no over-engineering, minimal change, reuse, etc.
- **DO/DON'T rules**: best practices distilled from workflow experience

### Agent Mode vs MCP Mode

| Dimension | IDE Agent Mode ⭐ | MCP Plugin Mode |
|-----------|------------------|-----------------|
| **Configuration** | Zero (auto-generated by `/wf init`) | Manual JSON config per IDE |
| **User experience** | Native mode in IDE dropdown | External tool calls |
| **IDE context** | Full (open files, cursor, LSP) | Isolated process |
| **LLM** | IDE's built-in LLM (free) | None (needs standalone) |
| **IDE tools** | Direct access | Self-built fallback |
| **Team sharing** | Commit to Git, everyone gets it | Each person configures |
| **Heavy compute** | ❌ (no CodeGraph build) | ✅ (runs Node.js) |

> **Best practice**: Use IDE Agent Mode as the primary integration. Use MCP only for
> heavy compute operations (init, CodeGraph build) that require Node.js execution.

### Regenerating Agent Definitions

Agent files are regenerated on every `/wf init`. To force regeneration:

```bash
node workflow/init-project.js --path /your/project
```

The generator respects existing files (won't overwrite unless `--force` is used).

---

## 🔌 MCP Plugin Mode

WorkFlowAgent can also run as an MCP (Model Context Protocol) server, enabling any IDE
(Cursor, VS Code, Claude Code, Windsurf) to call workflow tools directly.

### Quick Start

```bash
# Start MCP server on stdio (for IDE integration)
node workflow/core/mcp-server.js --project-root /path/to/project

# Or via npm script
cd workflow && npm run mcp -- --project-root /path/to/project
```

### IDE Configuration

Add to your IDE's MCP config (e.g. `claude_desktop_config.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "workflowagent": {
      "command": "node",
      "args": ["workflow/core/mcp-server.js", "--project-root", "/path/to/project"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description | Auto-Triage |
|------|------------|-------------|
| `workflow_triage` | Evaluate requirement complexity (0 LLM cost) | — |
| `workflow_run` | Execute workflow pipeline with auto-routing | ✅ |
| `workflow_init` | Initialize project (tech detect + CodeGraph) | — |
| `workflow_status` | Get project init state + staleness warnings | — |

### Auto-Routing (RequestTriage)

The `workflow_run` tool automatically evaluates requirement complexity before starting:

- **Score < 15** → suggests IDE direct handling (simple fix, typo, rename)
- **Score 15-40** → lightweight workflow (StageSmartSkip auto-skips stages)
- **Score ≥ 40** → full pipeline (ANALYSE → ARCHITECT → PLAN → CODE → TEST)

Use `force: true` to bypass triage. Use `workflow_triage` to preview the routing.

> The `/wf` command also auto-triages. Use `--force` to bypass: `/wf fix typo --force`

---

## ⚡ RequestTriage: Smart Routing Best Practices (Auto-Enforced)

The following best practices are **automatically enforced** by the RequestTriage module
(`core/request-triage.js`). You do NOT need to remember or manually follow these rules.

| Rule | Enforcement |
|------|-------------|
| Run `/wf init` before workflows | **InitStateGuard** blocks `/wf` if not initialized |
| Simple tasks → use IDE directly | **RequestTriage** suggests IDE for score < 15 |
| Complex tasks → use full pipeline | **RequestTriage** auto-routes to full pipeline for score ≥ 40 |
| Don't use /wf for one-line fixes | **RequestTriage** catches and suggests IDE |
| Refresh init when artifacts are stale | **StalenessDetector** warns when CodeGraph > 14 days old |
| Let auto-injection handle context | **ContextLoader + prompt-builder** (unchanged, always active) |
| Trust QualityGate rollbacks | **quality-gate.js** (unchanged, always active) |

> Override any auto-routing decision with `--force` (CLI) or `force: true` (MCP).
