---
name: standards
version: 3.0.0
type: standards
domains: [general, quality, conventions]
dependencies: []
load_level: global
max_tokens: 600
triggers:
  keywords: [standard, convention, naming, style, format, lint]
  roles: [developer, architect, coding-agent]
description: "Project-wide coding standards, naming conventions, and directory structure rules"
---

# Skill: standards

> **Version**: 1.0.0
> **Description**: Project-wide coding standards, naming conventions, and directory structure rules
> **Domains**: general, quality, conventions

---

## Coding Standards
<!-- PURPOSE: Language-specific coding rules enforced across the project. Each rule should be testable (a linter or reviewer can verify compliance). -->

### JavaScript / Node.js Conventions

1. **Strict mode**: Always use `'use strict';` at the top of each module
2. **Const over let**: Prefer `const` for variables that are not reassigned; never use `var`
3. **Early return**: Use early returns / guard clauses to reduce nesting depth
4. **Error handling**: Always handle errors in async functions with try/catch; never leave a `.catch()` empty
5. **Atomic writes**: Use tmp-file + rename pattern for crash-safe file writes
6. **JSDoc**: All public methods must have JSDoc comments with `@param` and `@returns`
7. **No magic numbers/strings**: Extract to named constants with clear names (e.g. `const MAX_RETRIES = 3`)
8. **Arrow functions for callbacks**: Use arrow functions for inline callbacks to preserve lexical `this`
9. **Destructuring**: Prefer destructuring for accessing object properties when using 2+ properties
10. **Template literals over concatenation**: Use backtick strings for multi-part string assembly
11. **Explicit return types in JSDoc**: Even for internal helpers, document return type to aid IDE inference
12. **No nested ternaries**: Single-level ternary is fine; nested ternaries must be refactored to if/else

### Cross-Language Conventions

1. **Single responsibility per file**: Each file should have one primary export / class / purpose
2. **Max line length: 120 characters**: Wrap longer lines. Exception: URLs, import paths, string literals
3. **No commented-out code**: Delete it; version control remembers. Reference commit hash if needed
4. **Consistent indentation**: 2 spaces for JS/YAML/JSON, 4 spaces for Python, tabs for Go
5. **Imports sorted alphabetically**: Group by: built-in Ôø?external Ôø?internal, with blank line between groups
6. **No wildcard imports**: Always import specific symbols (`import { foo }` not `import *`)
7. **Guard against null/undefined**: Validate inputs at trust boundaries; use optional chaining (`?.`) for deep access
8. **Log levels used correctly**: ERROR = needs human attention, WARN = self-recovered, INFO = business events, DEBUG = development only

## Naming Conventions
<!-- PURPOSE: Naming patterns for files, variables, functions, classes, constants, and database entities. Include examples for each pattern. -->

### Files and Directories
- **Modules**: `kebab-case.js` (e.g. `skill-evolution.js`, `prompt-builder.js`)
- **Test files**: `<module>.test.js` (e.g. `skill-evolution.test.js`)
- **Config files**: `kebab-case.json` or `kebab-case.yaml` (e.g. `adapter-config.json`)
- **Skill files**: `kebab-case.md` matching the skill name (e.g. `api-design.md`)
- **Script files**: `kebab-case.js` in `scripts/` (e.g. `batch-inject-purpose.js`)

### Code Symbols
| Category | Pattern | Example | Anti-Example |
|----------|---------|---------|-------------|
| Class | `PascalCase` | `SkillEvolutionEngine` | `skillEvolutionEngine` |
| Function/Method | `camelCase` | `registerSkill()` | `RegisterSkill()` |
| Private method | `_camelCase` | `_loadRegistry()` | `loadRegistryPrivate()` |
| Constant | `UPPER_SNAKE_CASE` | `MAX_INJECT_TOKENS` | `maxInjectTokens` |
| Boolean variable | `is/has/can/should` prefix | `isReady`, `hasError` | `ready`, `error` |
| Array variable | Plural noun | `skills`, `pendingTasks` | `skillList`, `taskArr` |
| Map/Dict variable | `<key>To<Value>` or `<noun>Map` | `idToName`, `skillMap` | `mapping`, `dict` |
| Event handler | `on<Event>` or `handle<Event>` | `onStageComplete` | `stageCompleteCallback` |
| Factory function | `create<Thing>` | `createAgent()` | `newAgent()`, `agentFactory()` |

### Skill Metadata
- **Frontmatter**: Always include YAML frontmatter with: `name`, `version`, `type`, `domains`, `triggers`, `description`
- **Version format**: Semantic versioning `MAJOR.MINOR.PATCH`
- **Domain values**: Lowercase, hyphen-separated (e.g. `api-design`, `error-handling`)

## Directory Structure
<!-- PURPOSE: Expected project layout rules. Describe where different types of files should live and why. -->

```
workflow/
‚îú‚îÄ‚îÄ core/          # Core engine modules (state machine, orchestrator, etc.)
Ôø?                 # Rule: No external dependencies; only Node.js built-ins
‚îú‚îÄ‚îÄ agents/        # Agent implementations (analyst, architect, developer, etc.)
Ôø?                 # Rule: One file per agent; agent must extend base Agent class
‚îú‚îÄ‚îÄ commands/      # CLI command handlers (registered in command-router)
Ôø?                 # Rule: Thin wrappers; delegate logic to core/
‚îú‚îÄ‚îÄ hooks/         # Hook event handlers (pre-stage, post-stage, etc.)
Ôø?                 # Rule: Side-effect only; must not alter stage output
‚îú‚îÄ‚îÄ tools/         # Tool adapters (thin-tools, thick-tools)
Ôø?                 # Rule: Adapter pattern; each tool isolated behind interface
‚îú‚îÄ‚îÄ skills/        # Skill SOP markdown files (with YAML frontmatter)
Ôø?                 # Rule: One file per skill; machine-readable frontmatter
‚îú‚îÄ‚îÄ docs/          # Architecture constraints, decision logs, specs
Ôø?                 # Rule: Reference-only; not loaded into agent prompts
‚îú‚îÄ‚îÄ scripts/       # Utility scripts (batch ops, migrations, analysis)
Ôø?                 # Rule: Standalone; runnable with `node scripts/<name>.js`
‚îú‚îÄ‚îÄ tests/         # Unit and integration tests
Ôø?                 # Rule: Mirror core/ structure; one test file per module
‚îî‚îÄ‚îÄ output/        # Generated artifacts (requirement.md, architecture.md, etc.)
                   # Rule: Gitignored; ephemeral per-project
```

### Placement Rules
1. **New core logic** Ôø?`core/` Ôø?Must be required by orchestrator or agents
2. **New agent** Ôø?`agents/` Ôø?Must register in agent-registry
3. **New CLI command** Ôø?`commands/` Ôø?Must register in command-router
4. **New skill** Ôø?`skills/` Ôø?Must have valid YAML frontmatter
5. **New test** Ôø?`tests/` Ôø?Must be importable by `unit.test.js` runner
6. **Temporary/debug files** Ôø?Never committed; add to `.gitignore`

## Commit Conventions
<!-- PURPOSE: Git commit message format, branch naming, PR title conventions. Include templates and examples. -->

### Commit Message Format

```
<type>(<scope>): <short description>

[optional body: what and why, not how]

[optional footer: Breaking Change, Issue references]
```

### Types
| Type | When to Use | Example |
|------|-------------|---------|
| `feat` | New feature or capability | `feat(planner): add upstream context injection` |
| `fix` | Bug fix | `fix(bus): correct sender role mapping for PLAN stage` |
| `refactor` | Code restructuring without behavior change | `refactor(prompt-builder): extract auto-sections into helper` |
| `docs` | Documentation only | `docs(skills): add PURPOSE comments to all sections` |
| `test` | Adding or updating tests | `test(skill-evolution): add enrichment prompt coverage` |
| `chore` | Tooling, build, CI changes | `chore(scripts): add batch-inject-purpose utility` |
| `perf` | Performance improvement | `perf(context-loader): cache skill file reads` |

### Rules
1. **Each commit must compile and pass tests independently** Ôø?No "WIP" commits in main branch
2. **Subject line Ôø?72 characters** Ôø?Truncated in most UIs beyond this
3. **Use imperative mood** Ôø?"Add feature" not "Added feature" or "Adds feature"
4. **Reference issue/task IDs in footer** Ôø?e.g. `Closes #42` or `Refs T-3`
5. **Breaking changes require BREAKING CHANGE footer** Ôø?e.g. `BREAKING CHANGE: removed deprecated API`
6. **Atomic commits** Ôø?One logical change per commit; don't mix feat + refactor

### Branch Naming
- Feature: `feat/<short-description>` (e.g. `feat/planner-stage`)
- Fix: `fix/<issue-id>-<description>` (e.g. `fix/42-bus-routing`)
- Release: `release/v<version>` (e.g. `release/v2.0.0`)

## Rules
<!-- PURPOSE: Prescriptive constraints for project-wide standards compliance. -->

1. **Every PR must pass linting with zero warnings** ‚Ä?Warnings are deferred errors. Configure CI to treat warnings as errors (`--max-warnings 0`). No exceptions for "legacy code" ‚Ä?fix it or suppress with an inline comment explaining why.

2. **All new files must follow the naming convention** ‚Ä?No exceptions. A file named `myHelper.js` (camelCase) in a `kebab-case.js` project causes confusion and breaks tooling assumptions. Enforce via pre-commit hook.

3. **Every module must have a corresponding test file** ‚Ä?If `core/skill-evolution.js` exists, `tests/skill-evolution.test.js` must exist. Coverage is secondary; test existence is the minimum bar.

4. **Environment-specific config must never be committed** ‚Ä?API keys, database passwords, secrets ‚Ä?all go in `.env` files (gitignored) or CI secrets. Use `.env.example` to document required variables without values.

5. **All error messages must be in English** ‚Ä?Comments and UI strings can follow project locale, but error messages (logs, exceptions, API errors) must be in English for consistent monitoring, alerting, and Googling.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for standards compliance. -->

1. **Phase 1: Setup** ‚Ä?Clone the repo, run `npm install`, verify all linting passes with `npm run lint`. If linting fails on a fresh clone, fix the failing rules before starting any new work.

2. **Phase 2: Development** ‚Ä?Follow naming conventions from this Skill. Run linter after every file save (configure IDE to lint on save). Commit messages follow the conventional commit format.

3. **Phase 3: Pre-commit** ‚Ä?Before committing: (a) run `npm test` to ensure no regressions, (b) verify no `console.log` statements left in production code, (c) verify no TODO comments without owner and ticket reference.

4. **Phase 4: Code Review** ‚Ä?Reviewer checks: naming, file placement, commit message format, test coverage, and standards compliance. Use this Skill's Checklist as the review guide.

## Checklist
<!-- PURPOSE: Verification checklist for standards compliance. -->

### Naming
- [ ] All new files follow `kebab-case.js` convention
- [ ] All new classes use `PascalCase`
- [ ] All new constants use `UPPER_SNAKE_CASE`
- [ ] Boolean variables use `is/has/can/should` prefix

### Code Quality
- [ ] No `var` declarations (use `const` or `let`)
- [ ] No nested ternaries
- [ ] No wildcard imports
- [ ] All public functions have JSDoc with `@param` and `@returns`
- [ ] No magic numbers or strings (extracted to named constants)

### Project Structure
- [ ] New files placed in correct directory per Directory Structure rules
- [ ] New Skill files have valid YAML frontmatter
- [ ] Test file exists for every new module

### Git
- [ ] Commit message follows `<type>(<scope>): <description>` format
- [ ] Subject line ‚â?72 characters
- [ ] No "WIP" or "fix typo" commits in PR (squash them)

## Best Practices
<!-- PURPOSE: Recommended patterns for maintaining project standards. -->

1. **Use EditorConfig + Prettier for formatting** ‚Ä?Automated formatting eliminates style debates. Configure `.editorconfig` for cross-IDE consistency and Prettier for JS/TS/JSON/YAML. Run Prettier as a pre-commit hook.

2. **Adopt trunk-based development** ‚Ä?Keep branches short-lived (< 2 days). Merge to main frequently. Long-lived feature branches accumulate merge conflicts and drift from main. Use feature flags for incomplete features.

3. **Version Skill files semantically** ‚Ä?PATCH (1.0.x): typos, clarifications. MINOR (1.x.0): new entries in existing sections. MAJOR (x.0.0): new sections, structural changes, or rules that change behavior.

4. **Review standards quarterly** ‚Ä?Standards that don't evolve become irrelevant. Every quarter, review this Skill: remove rules nobody follows, add rules for recurring issues, update examples to match current codebase.

## Anti-Patterns
<!-- PURPOSE: Common standards violations and their corrections. -->

1. **"We'll fix the naming later"** ‚Ä?Technical debt in naming compounds. Every new file that follows the wrong convention makes the correct convention harder to enforce. ‚ù?`myComponent.JS` ‚Ü?‚ú?`my-component.js`. Fix naming before merging.

2. **Copy-paste commit messages** ‚Ä?`fix: stuff`, `update`, `wip` provide zero information in `git log`. ‚ù?`fix stuff` ‚Ü?‚ú?`fix(bus): correct sender role mapping for PLAN stage`. Each commit message is documentation for future debuggers.

3. **Skipping tests "because it's a small change"** ‚Ä?Small changes cause big regressions. A one-line config change can break the entire application. ‚ù?"too small to test" ‚Ü?‚ú?add a regression test for the specific fix.

4. **Inconsistent error handling patterns** ‚Ä?Module A uses exceptions, module B uses error codes, module C uses Result types. Consumer code needs three different error handling strategies. ‚ù?Mixed patterns ‚Ü?‚ú?One pattern per module boundary, with adapters at boundaries.

## Gotchas
<!-- PURPOSE: Environment-specific traps related to standards. -->

1. **Windows vs Unix line endings** ‚Ä?Git on Windows may convert LF to CRLF, breaking scripts with `#!/bin/bash` shebangs. Fix: configure `.gitattributes` with `* text=auto` and `*.sh text eol=lf`.

2. **Case-insensitive file systems (macOS/Windows)** ‚Ä?Renaming `Foo.js` to `foo.js` may not register as a change in Git on case-insensitive systems. Use `git mv Foo.js foo.js` to force the rename.

3. **Node.js require resolution order** ‚Ä?`require('config')` first checks `node_modules/config`, not `./config.js`. If you have a local file named the same as an npm package, use explicit relative path: `require('./config')`.

4. **JSON trailing commas** ‚Ä?JSON spec does not allow trailing commas, but JavaScript objects do. `JSON.parse('{"a":1,}')` throws `SyntaxError`. Common when copy-pasting from JS code to JSON config files.

## Context Hints
<!-- PURPOSE: Background knowledge for standards decisions. -->

1. **Standards adoption follows an S-curve** ‚Ä?New standards face resistance initially, then rapidly adopt once 30-40% of the team follows them. Focus energy on getting early adopters to demonstrate the value, not on forcing compliance.

2. **Linters enforce the 80%, culture enforces the 20%** ‚Ä?Automated tools catch formatting and simple pattern violations. But deeper standards (meaningful names, appropriate abstractions, clear intent) require human judgment during code review.

3. **The "broken windows" theory applies to codebases** ‚Ä?One file that violates naming conventions signals that conventions are optional. Maintain zero tolerance for violations in new code, even if legacy code has violations. Fix legacy violations opportunistically.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-17 | Initial creation with JS/Node conventions |
| v2.0.0 | 2026-03-19 | Major expansion: cross-language conventions (8), naming examples table, directory placement rules, commit type table, branch naming |
| v3.0.0 | 2026-03-19 | Skill-enrich-all: added 7 standard sections (Rules, SOP, Checklist, Best Practices, Anti-Patterns, Gotchas, Context Hints) |
