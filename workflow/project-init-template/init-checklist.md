# New Project Onboarding Checklist

> Use this checklist when applying the /wf workflow to a new project.
> Estimated time: 15–30 minutes.

---

## Step 1: Copy Templates into Project Root

```bash
# Copy the template files into your project
cp workflow/project-init-template/AGENTS.md              <your-project>/AGENTS.md
cp workflow/project-init-template/docs/architecture.md   <your-project>/docs/architecture.md
cp workflow/project-init-template/workflow.config.js     <your-project>/workflow.config.js
```

---

## Step 5: Fill in AGENTS.md

Open `<your-project>/AGENTS.md` and replace all `{PLACEHOLDERS}`:
| Placeholder | What to fill |
|-------------|-------------|
| `{PROJECT_NAME}` | Your project name (auto-detected from directory name) |
| `{ONE_LINE_DESCRIPTION}` | e.g., `Flutter I-Ching oracle app` |
| `{TECH_STACK}` | e.g., `Flutter/Dart`, `Unity/Lua`, `Go/React` |
| `{PLATFORMS}` | e.g., `iOS, Android, Windows` |
| `{DIRECTORY_TREE}` | Paste your actual directory structure |
| `{LANGUAGE_SPECIFIC_LIMIT}` | e.g., `800 lines for .dart`, `400 lines for .js` |
| `{NAMING_CONVENTION}` | e.g., `PascalCase for widgets, camelCase for functions` |
| `{STATE_MANAGEMENT_APPROACH}` | e.g., `StatefulWidget`, `Riverpod`, `Redux` |

---

## Step 3: Configure the Automated Verification Loop

Open `<your-project>/workflow.config.js` and set `testCommand`:

```js
// Replace null with your actual test command:
testCommand: 'npm test',        // Node.js
testCommand: 'flutter test',    // Flutter
testCommand: 'pytest',          // Python
testCommand: 'go test ./...',   // Go
```

This enables the **real test execution + auto-fix loop**:
1. After code generation, the workflow runs your actual test suite
2. If tests fail, DeveloperAgent automatically fixes the code
3. Tests are re-run (up to `maxFixRounds` times)
4. Real test results are appended to the AI test report

---

## Step 4: Fill in docs/architecture.md

Open `<your-project>/docs/architecture.md` and:

1. Replace project overview placeholders
2. Define your **Architecture Constraints** (file size, naming, data separation)
3. Write at least **2 Key User Journeys** as acceptance criteria
4. Add your first **ADR-001** documenting the initial architecture decision

---

## Step 6: Verify the Setup

Run a quick sanity check:

- [ ] `AGENTS.md` exists in project root and has no `{PLACEHOLDER}` text remaining
- [ ] `docs/architecture.md` exists and has at least 1 ADR
- [ ] At least 2 Key User Journeys are defined with step-by-step acceptance criteria
- [ ] Architecture Constraints table is filled in
- [ ] Directory Structure in `AGENTS.md` reflects actual project layout
- [ ] `workflow.config.js` has `testCommand` set (or explicitly set to `null` if no tests)
---

## What Belongs Where

| Content Type | Location |
|-------------|----------|
| Workflow engine rules (how /wf works) | `workflow/docs/` |
| Project architecture decisions (ADRs) | `<project>/docs/architecture.md` |
| Project constraints (file size, naming) | `<project>/AGENTS.md` + `<project>/docs/architecture.md` |
| Project user journeys / acceptance criteria | `<project>/docs/architecture.md` |
| Reusable skill knowledge (Flutter, Lua, Go...) | `workflow/skills/` |
| Workflow-level ADRs (how the harness evolved) | `workflow/docs/decision-log.md` |

---

## Common Mistakes to Avoid

❌ **Don't** put project ADRs in `workflow/docs/decision-log.md`
✅ **Do** put them in `<project>/docs/architecture.md`

❌ **Don't** leave architecture decisions only in chat history
✅ **Do** write them down in `docs/architecture.md` immediately

❌ **Don't** create a giant AGENTS.md with all rules
✅ **Do** keep AGENTS.md as a lightweight index, details go in `docs/`

❌ **Don't** define "done" as "code runs"
✅ **Do** define "done" as "Key User Journey acceptance criteria pass"
