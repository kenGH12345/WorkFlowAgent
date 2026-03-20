---
name: code-development
version: 1.1.0
type: domain-skill
domains: [development, coding]
dependencies: [code-review, standards]
load_level: task
max_tokens: 800
triggers:
  keywords: [code, develop, implement, build, program]
  roles: [developer, coding-agent]
description: "Code development patterns, coding standards and best practices"
---
# Skill: code-development

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: Code development patterns, coding standards and best practices
> **Domains**: development, coding

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Make the change easy, then make the easy change** — Before implementing a feature, refactor the code so the feature becomes a trivial addition. Small preparatory refactors reduce risk and keep diffs reviewable.

2. **Every function should do one thing at one level of abstraction** — If a function reads from DB, transforms data, AND sends an email, split it into three functions. The caller composes them. This makes each piece independently testable.

3. **Name things by what they ARE, not how they're USED** — `userList` is better than `data`. `calculateShippingCost()` is better than `process()`. Names are the first line of documentation; investing 2 minutes in naming saves 2 hours in comprehension.

4. **Fail fast and fail loudly** — Validate preconditions at function entry with early returns or assertions. Silent failures that return default values create bugs that surface far from their cause, making debugging exponentially harder.

5. **Write code that is easy to delete** — Design modules so they can be removed without cascading changes. Use interfaces, avoid deep coupling, and prefer flat dependency graphs. The best code is code you never have to maintain.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Feature Development Flow**: Read ticket/spec → Reproduce current behavior → Write failing test → Implement minimum code to pass → Refactor → Update documentation → Self-review diff → Submit PR.
2. **Bug Fix Flow**: Reproduce bug → Write test that fails due to bug → Fix the bug → Verify test passes → Check for similar patterns elsewhere → Add regression guard → Document root cause in commit message.
3. **Refactoring Flow**: Ensure tests pass (baseline) → Make ONE structural change → Run tests → Commit → Repeat. Never mix refactoring with feature work in the same commit.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] All public functions/methods have doc comments explaining WHAT and WHY (not HOW)
- [ ] No magic numbers — all constants named and explained
- [ ] Error messages include context (what was attempted, what failed, what to do)
- [ ] Cyclomatic complexity per function ≤ 10
- [ ] No commented-out code (use version control history instead)
- [ ] Function length ≤ 30 lines (excluding setup/teardown)

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Test-Driven Development (TDD) for complex logic** — Write the test first for any function with branching logic. The test defines the contract; the implementation fulfills it. TDD naturally produces smaller, more focused functions.

2. **Boy Scout Rule** — Leave code cleaner than you found it. Every PR should include one small improvement (rename a variable, extract a function, add a missing test) beyond the ticket scope. Compound improvements over time.

3. **Trunk-based development with feature flags** — Ship incomplete features behind flags instead of long-lived branches. This keeps branches short (< 1 day), reduces merge conflicts, and enables incremental rollout.

4. **Structured error handling with error types** — Define domain-specific error classes/types (e.g., `NotFoundError`, `ValidationError`, `ConflictError`). Callers switch on error type, not error message strings. This enables reliable error handling across API boundaries.

5. **Immutable data by default** — Use `const`, `readonly`, `final`, or `Object.freeze()` by default. Mutability is opt-in, not opt-out. Immutable code is easier to reason about, thread-safe by construction, and less prone to side-effect bugs.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **Premature optimization** — Optimizing code before profiling shows it's actually slow. Instead: write clear, correct code first. Profile. Optimize only the measured bottlenecks. 97% of "optimized" code was never in the hot path.

2. **Clever code** — Using obscure language features, one-liners, or tricks that require 5 minutes to understand. Instead: write code that a junior developer can understand in 5 seconds. Debugging is twice as hard as writing — if you write the cleverest code you can, you're not smart enough to debug it.

3. **Shotgun surgery** — Making a single logical change that requires modifications in 10+ files. Instead: this signals poor encapsulation. Refactor to co-locate related logic before adding more changes.

4. **Feature envy** — A function that primarily accesses data from another module instead of its own. Instead: move the function to the module whose data it uses, or provide a proper interface.

5. **Boolean parameter trap** — `createUser(name, true, false, true)` — what do those booleans mean? Instead: use named parameters, enums, or options objects: `createUser(name, { isAdmin: true, sendEmail: false, verified: true })`.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **The Rule of Three** — Don't abstract until you've seen the same pattern three times. The first two occurrences might be coincidental. The third confirms the pattern and reveals the right abstraction boundary.

2. **Cognitive load budget** — A developer can hold ~7 things in working memory. If understanding a function requires tracking more than 7 variables, states, or conditions, it's too complex. Split it.

3. **Code review as design tool** — The best time to catch architectural issues is during code review, not during refactoring sprints. Reviewers should ask "does this change make future changes easier or harder?"

4. **Debugging time > writing time** — Developers spend 50-75% of time reading/debugging code and 25-50% writing new code. Optimize for readability over writability. Verbose but clear beats terse but obscure.

5. **Technical debt is a spectrum** — Not all tech debt is bad. "Prudent deliberate" debt (shipping a known shortcut with a cleanup plan) is a valid business tool. "Reckless inadvertent" debt (messy code from ignorance) compounds exponentially.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |