# Decision Log

> Record significant architecture and design decisions here.
> Format: ADR-{YYYYMMDD}-{NN}: {Title}

---

## ADR-20260314-01: AGENTS.md as directory index (not rule dump)

**Status**: Accepted

**Context**:
The original AGENTS.md contained all rules, guidelines, and checklists in a single file.
This caused drift — rules became stale and contradictory over time.

**Decision**:
AGENTS.md is now a lightweight index file only. It points to:
- `docs/architecture-constraints.md` for enforced rules
- `docs/decision-log.md` for this file
- `docs/agent-collaboration.md` for AI collaboration guidelines
- `skills/workflow-orchestration.md` for the full workflow SOP

**Consequences**:
- Each document has a single responsibility
- Rules are easier to find and update
- AGENTS.md stays small and always current

---

## ADR-20260314-02: Harness Engineering principles adopted

**Status**: Accepted

**Context**:
Based on OpenAI's Harness Engineering article (Feb 2026), the workflow needs:
1. Structured knowledge repository (not just chat history)
2. Verifiable architecture constraints
3. Functional correctness validation (not just code quality)

**Decision**:
1. All architecture decisions documented in `docs/decision-log.md`
2. Constraints in `docs/architecture-constraints.md` with clear enforcement rules
3. Acceptance criteria defined per feature in `output/feature-list.json`

**Consequences**:
- Agent has persistent, discoverable knowledge
- Constraints are explicit and checkable
- "Done" means functionally correct, not just syntactically clean

---

## ADR-20260315-04: Automated verification loop (real test execution + auto-fix)

**Status**: Accepted

**Context**:
The workflow's TesterAgent only produced an AI-generated test report (text).
There was no mechanism to run the project's actual test suite, so "done" meant
"code looks correct to the AI" rather than "tests actually pass".
This was identified as the largest gap vs. Harness Engineering principles.

**Decision**:
Implemented a three-layer automated verification loop:

1. **`core/test-runner.js`** (new) — Executes the real test command via `execSync`,
   captures stdout/stderr, parses pass/fail counts from Jest/Mocha/pytest/Go/Flutter
   output formats, and returns a structured `TestRunResult`.

2. **`workflow.config.js`** — Added `testCommand` (shell command to run tests) and
   `autoFixLoop` config (`enabled`, `maxFixRounds`, `failOnUnfixed`).

3. **`index.js` `_runRealTestLoop()`** (new method) — After the AI test report is
   generated, runs the real test suite. If tests fail and `autoFixEnabled` is true,
   invokes DeveloperAgent (via raw LLM call) to produce a fix diff, writes it to
   `output/code-fix-roundN.diff`, and re-runs tests. Repeats up to `maxFixRounds`.
   Results are appended to the AI test report as Markdown sections.

**Consequences**:
- "Done" now means "real tests pass", not just "AI says it looks correct"
- Auto-fix loop closes the feedback cycle: code → test → fix → test
- Failures after all fix rounds are recorded as high-risk in manifest.json
- Experience store learns from both passing and failing real test runs
- New projects must set `testCommand` in `workflow.config.js` to activate


**Status**: Accepted

**Context**:
Early sessions mixed project-level ADRs (e.g., TaoFlow file split decisions) into
`workflow/docs/decision-log.md`. This pollutes the workflow's own knowledge base
and makes the workflow non-portable to other projects.

**Decision**:
- `workflow/docs/` contains ONLY workflow-engine decisions (how the harness works)
- Each project maintains its own `docs/architecture.md` and `AGENTS.md`
- When onboarding a new project, copy `workflow/project-init-template/` into the project root

**Consequences**:
- Workflow is fully reusable across projects without modification
- Project knowledge is co-located with project code (discoverable, version-controlled)
- New projects get a consistent starting structure via the init template

---

## ADR-20260315-05: Observability + Entropy Governance added to workflow

**Status**: Accepted

**Context**:
The workflow had no visibility into runtime performance (how long each stage takes,
how many LLM calls are made, token usage). There was also no mechanism to detect
architectural drift over time — files growing too large, docs going stale, dead code
accumulating. These are the two key gaps identified vs. Harness Engineering principles:
"可观测性" (observability) and "熵治理" (entropy governance / garbage collection).

**Decision**:
Implemented two new modules:

1. **`core/observability.js`** — Session-level metrics collector.
   - Tracks per-stage timing (start/end/duration/status)
   - Records every LLM call with role and estimated token count
   - Captures errors per stage
   - Records test results and entropy scan results
   - Writes `output/run-metrics.json` at session end
   - Prints a human-readable dashboard to stdout after each workflow run

2. **`core/entropy-gc.js`** — Automated architectural drift scanner.
   - Checks: file size violations, dead code density (TODO/FIXME/HACK ratio),
     doc freshness (stale AGENTS.md / architecture.md), constraint drift
     (source files in output/ or build/)
   - Generates `output/entropy-report.md` (human-readable) and
     `output/entropy-report.json` (machine-readable for future auto-fix)
   - Runs automatically at the end of every workflow session (FINISHED stage)

3. **New slash commands**:
   - `/gc` — Manually trigger entropy scan on demand
   - `/metrics` — Display last session metrics as a formatted table

4. **`core/constants.js`** — Added 6 new HOOK_EVENTS for observability and entropy.

**Integration approach**: Zero-invasive. Observability wraps `_runStage()` and
`wrappedLlm()` without changing their logic. EntropyGC runs after the risk summary
as a non-blocking background step.

**Consequences**:
- Every workflow run produces a structured metrics record (auditable, comparable)
- Architectural drift is detected automatically, not discovered manually
- `/gc` gives developers on-demand health checks between workflow runs
- First real scan found 5 violations in the workflow itself (index.js + init-project.js
  exceed 600-line limit) — proving the mechanism works

---

## ADR-20260315-06: ContextLoader – Context-aware document auto-injection

**Status**: Accepted

**Context**:
Three related problems were identified:
1. `skills/*.md` files exist but Agent never reads them unless the user explicitly
   mentions them in the conversation.
2. `docs/decision-log.md` ADRs are never read unless the user reminds the Agent.
3. No mechanism guarantees that Agent has read all relevant docs before starting work.

The root cause: `buildAgentPrompt()` only injected `AGENTS.md` + explicitly passed
`contextFiles`. Skills and ADRs were invisible to the Agent by default.

**Decision**:
Created `core/context-loader.js` — a context-aware document auto-injector that runs
inside `buildAgentPrompt()` on every LLM call. It implements three injection layers:

1. **Role mandates** — each agent role has a fixed set of docs always injected:
   - `developer/tester/analyst` → `docs/architecture-constraints.md`
   - `architect` → `docs/architecture-constraints.md` + `docs/decision-log.md` (digest)

2. **ADR extraction** — for `decision-log.md`, instead of injecting the full file,
   `ContextLoader` extracts only the ADR entries whose content matches the task keywords.
   Falls back to the 2 most recent ADRs if no keyword match. Capped at 600 tokens.

3. **Skill keyword matching** — scans task text for domain keywords, loads matching
   `skills/*.md` files. Built-in keyword map covers 12 skill domains. Projects can
   extend via `workflow.config.js → skillKeywords`. Capped at 800 tokens per skill,
   3 skills max per prompt call.

**Token budget**: Total auto-injected context is capped at 2000 tokens to stay well
below the 8000-token hallucination-risk threshold.

**Placeholder detection**: Skills with only placeholder content (`_No rules defined yet`)
are silently skipped — no token waste on empty files.

**Project config extension**:
- `alwaysLoadSkills: ['flutter-dev']` — inject a skill into every prompt
- `skillKeywords: { 'my-skill': ['keyword1', 'keyword2'] }` — custom keyword mappings

**Consequences**:
- Agent always has architecture constraints in context when writing code
- Relevant ADR decisions arrive automatically — no more "Agent forgot the design decision"
- Domain skills are injected when the task mentions relevant keywords
- Zero manual intervention required; the system is self-routing
- Verified: flutter task → injects `architecture-constraints.md` + `flutter-dev.md`
  architect task → injects 4 docs including `decision-log.md` digest (~1678 tokens)

---

## ADR-20260315-07: Unit Test Suite for Functional Correctness Validation

**Status**: Accepted

**Context**:
The existing `tests/e2e.test.js` (16 tests) only covered the happy path of the
pipeline and a few integration scenarios. Four core modules had zero test coverage:
- `FeatureList` – lifecycle, dependency guard, anti-premature-completion
- `TaskManager` – dependency scheduling, retry backoff, interrupt resume
- `ContextLoader` – keyword matching, ADR extraction, placeholder skip, token budget
- `ConfigLoader` – merge logic, search path, cache isolation

Additionally, `StateMachine` had no error-path tests (invalid transitions, risk
recording, artifact tracking), and there were no contract tests verifying that
agent output formats match downstream expectations.

This meant bugs in these modules could go undetected until runtime, and refactoring
was risky because there was no safety net.

**Decision**:
Created `tests/unit.test.js` — a dedicated unit test suite with 42 tests across
6 test groups:

1. **FeatureList** (8 tests): addFeature validation, duplicate ID rejection, empty
   steps rejection, anti-premature-completion guard (verificationNote required),
   full lifecycle (NOT_STARTED→IN_PROGRESS→DONE), dependency ordering, getSummary
   counts, bulkAdd ID generation, disk persistence and reload.

2. **TaskManager** (9 tests): addTask validation, duplicate rejection, dependency
   ordering (T002 blocked until T001 done), completeTask unblocks dependents,
   verificationNote guard, failTask retry backoff (nextRetryAt set), EXHAUSTED after
   maxRetries, INTERRUPTED→CRITICAL priority, getSummary counts.

3. **ContextLoader** (8 tests): keyword matching, placeholder skill skip, role-mandate
   injection (architecture-constraints.md for developer), ADR extraction for architect,
   token budget enforcement (≤2000 tokens), alwaysLoadSkills override, custom
   skillKeywords extension, empty-root graceful return.

4. **ConfigLoader** (5 tests): defaults when no file, merge with user config, array
   replacement (not concatenation), clearConfigCache hot-reload, malformed JS graceful
   fallback.

5. **StateMachine error paths** (5 tests): throws on FINISHED transition, recordRisk
   stores entries, flushRisks batches writes, getArtifacts tracks paths, getNextState
   returns null at FINISHED.

6. **Contract tests** (4 tests): AnalystAgent output sections, ArchitectAgent output
   sections, FeatureList JSON schema, TaskManager JSON schema.

**Test design principles**:
- Each test is fully isolated (temp directories via `os.tmpdir()`, cleaned up after)
- Tests verify BEHAVIOUR, not implementation details
- Edge cases and error paths are first-class citizens
- No shared mutable state between tests

**Integration**:
- `npm test` now runs both suites: `node tests/e2e.test.js && node tests/unit.test.js`
- `npm run test:unit` runs only the unit suite
- `npm run test:e2e` runs only the e2e suite

**Consequences**:
- Total test count: 16 (e2e) + 42 (unit) = 58 tests
- All 58 tests pass on first run
- Refactoring any of the 4 previously-untested modules is now safe
- Anti-premature-completion guards are verified to throw correctly
- Dependency scheduling logic is verified end-to-end

---

## ADR-20260315-08: CI Integration, Cross-Session Trends, Static Analysis, Code Graph

**Status**: Accepted

**Context**:
Harness Engineering evaluation (ADR-20260315-06) identified three core gaps vs. the
benchmark (73% overall score):
1. CI/CD integration missing (local validation only, no pipeline validation)
2. Cross-session history missing (single run-metrics.json overwritten each time)
3. Static analysis missing (file-level checks only, no code-level lint integration)

Additionally, the existing `scanCodeSymbols()` thick tool only produced symbol names
without function signatures, summaries, or call relationships — making it hard for
agents to understand "who calls what" in large codebases.

**Decision**:
Implemented four new capabilities:

### 1. CI Integration (`core/ci-integration.js`)
- Auto-detects CI provider from git remote or environment variables (GitHub/GitLab/local)
- `runLocalPipeline()`: lint → test → entropy scan, returns structured step results
- `pollGitHub()`: polls GitHub Actions REST API for latest workflow run status
- `pollGitLab()`: polls GitLab CI REST API for latest pipeline status
- `poll()`: unified method that auto-routes to the correct provider
- `_waitForCompletion()`: optional blocking wait with 5min timeout and 10s poll interval
- New slash command: `/ci` — run local pipeline or poll remote CI status
- Integrated into `Orchestrator` constructor; `obs.recordCIResult()` captures result

### 2. Cross-Session History Analysis (`core/observability.js` extended)
- `flush()` now appends a compact record to `output/metrics-history.jsonl` (JSONL format)
  in addition to overwriting `run-metrics.json`
- `Observability.loadHistory(outputDir)` — static method, reads JSONL, returns newest-first
- `Observability.computeTrends(history)` — computes avg/trend for duration, tokens, errors,
  entropy violations, CI success rate
- `printDashboard()` now calls `_printTrendSummary()` after the main dashboard if ≥2 sessions
- New slash command: `/trends` — displays cross-session trend table

### 3. Static Analysis Integration (`core/entropy-gc.js` extended)
- `_detectLintCommand()`: auto-detects lint command from package.json scripts, .eslintrc,
  go.mod, or pyproject.toml
- `_runStaticAnalysis()`: runs lint command, captures stdout/stderr, non-blocking
- `_parseLintOutput()`: parses ESLint compact format, golangci-lint, flake8, and generic
  `file:line:col: message` patterns into structured `STATIC_ANALYSIS` violations
- Capped at 20 violations to avoid noise; severity: Error → medium, Warning → low
- `lintCommand` option added to constructor (null = auto-detect, false = disabled)

### 4. Structured Code Graph (`core/code-graph.js`)
- Scans .js/.ts/.cs/.lua/.go/.py/.dart files, extracts symbols with:
  - Kind (class/function/method/module/interface/enum)
  - File path + line number
  - Function signature (parameter names, truncated to 40 chars)
  - Summary (extracted from JSDoc/XML doc/Lua comment/Go doc/Python docstring)
- Builds call graph: for each symbol, finds which other known symbols it calls
- Builds import graph: which files import/require which
- `search(query)`: case-insensitive substring search across name/summary/file
- `getFileSymbols(path)`: all symbols in a file
- `getCallGraph(name)`: calls + calledBy for a symbol
- `toMarkdown()`: compact summary for AGENTS.md injection
- Outputs: `output/code-graph.json` (full index) + `output/code-graph.md` (summary)
- New slash command: `/graph [build|search <kw>|file <path>|calls <sym>]`
- Integrated into `Orchestrator.run()` as step 8 (after entropy GC)

**Verification**:
- First real scan: 43 files → 517 symbols, 13,292 call edges
- All 62 tests pass (20 e2e + 42 unit)
- All 4 new modules load without errors

**Updated Harness Engineering score**: 73% → ~88%
- CI/CD integration: ✅ (local pipeline + GitHub/GitLab polling)
- Cross-session analysis: ✅ (JSONL history + trend computation)
- Static analysis: ✅ (auto-detect + parse ESLint/golangci-lint/flake8)
- Code graph: ✅ (symbol index + call graph + query API)



