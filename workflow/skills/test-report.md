---
name: test-report
version: 1.1.0
type: domain-skill
domains: [testing, qa]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [test, unit test, integration test, coverage, jest, pytest, mocha]
  roles: [tester]
description: "Test report writing standards and quality assurance patterns"
---
# Skill: test-report

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: Test report writing standards and quality assurance patterns
> **Domains**: testing, qa

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Every test must have Arrange-Act-Assert structure** — Clearly separate setup (arrange), execution (act), and verification (assert) with blank lines or comments. This makes test intent immediately obvious and failures easy to diagnose.

2. **Test names must describe the scenario, not the method** — `test_returns_404_when_user_not_found` not `test_getUser`. Name format: `test_<expected_behavior>_when_<condition>`. The test name IS the documentation.

3. **One assertion per logical concept** — A test can have multiple `assert` statements if they verify the same logical outcome. But testing two independent behaviors in one test makes failures ambiguous.

4. **Tests must be deterministic** — No random data, no `Date.now()`, no reliance on execution order. Use fixed seeds, clock mocking, and explicit test data. Flaky tests erode team trust in the entire suite.

5. **Test the behavior, not the implementation** — Assert on outputs and side effects, not on internal method calls. Tests coupled to implementation break on every refactor, providing zero safety net when it matters most.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Test Writing Flow**: Identify behavior to test → Write test name describing scenario → Arrange test data → Act (call the function) → Assert expected output → Verify edge cases → Add negative test cases.
2. **Test Report Structure**: Summary (pass/fail/skip counts, duration) → Failed test details (test name, expected vs actual, stack trace) → Coverage metrics (line, branch, function) → Flaky test list → Action items.
3. **Coverage Strategy**: Aim for 80%+ line coverage as a guardrail, NOT a target. 100% coverage with shallow assertions is worse than 60% coverage with deep, meaningful assertions. Focus coverage on business-critical paths.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] All critical business logic has unit tests
- [ ] Integration tests cover all API endpoints and DB operations
- [ ] Edge cases tested: empty input, null, boundary values, overflow
- [ ] Error paths tested (not just happy path)
- [ ] No test interdependencies (each test runs in isolation)
- [ ] Test data created in test setup, not shared across tests
- [ ] CI runs tests on every PR with pass/fail gate

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Test pyramid: many unit, fewer integration, fewest E2E** — Unit tests are fast (ms), reliable, and pinpoint failures. Integration tests verify boundaries. E2E tests verify critical user journeys. Inverting the pyramid leads to slow, flaky CI.

2. **Use test fixtures/factories, not raw data** — Create `buildUser({ name: "Test" })` factory functions with sensible defaults. This keeps tests readable, DRY, and resilient to schema changes (update the factory, not 200 tests).

3. **Snapshot testing for complex outputs** — Use snapshots (Jest `.toMatchSnapshot()`) for large JSON responses, rendered HTML, or generated code. Review snapshot diffs carefully — auto-updating without review defeats the purpose.

4. **Mutation testing for test quality** — Tools like Stryker (JS), PIT (Java), or mutmut (Python) modify your code and check if tests catch the mutations. If 30% of mutations survive, your tests have a 30% blind spot.

5. **Contract testing for API consumers** — Use Pact or similar tools to verify that API consumers and producers agree on contract. This catches breaking changes without requiring full E2E environment setup.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **Testing private methods** — If you need to test a private method, it should probably be a public method on a separate class. Instead: test through the public interface. Private method testing creates implementation coupling.

2. **Test-per-method** — Mechanically writing one test per method (test_constructor, test_getName, test_setName). Instead: test behaviors and scenarios. A method may need 0 tests (trivial getter) or 10 tests (complex business rule).

3. **Mocking everything** — Over-mocking creates tests that pass no matter what. If you mock the database, the HTTP client, and the logger, you're testing that mocks return what you told them to. Instead: use real implementations where feasible, mock only external boundaries.

4. **Asserting on exact error messages** — `expect(err.message).toBe("User 123 not found in database")` breaks when message is rephrased. Instead: assert on error type/code: `expect(err).toBeInstanceOf(NotFoundError)`.

5. **Ignoring test execution time** — A test suite that takes 30+ minutes kills developer productivity. Instead: keep unit tests under 30 seconds, integration tests under 5 minutes. Parallelize, use in-memory databases, mock slow external calls.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **Test coverage != code quality** — A project with 95% coverage but all shallow assertions (just checking no exceptions) has worse quality assurance than 60% coverage with deep behavioral assertions.

2. **Jest vs Vitest (JavaScript)** — Vitest is Jest-compatible but 2-5x faster due to native ESM support and Vite's transform pipeline. For new projects, prefer Vitest. For existing Jest suites, migration is straightforward.

3. **Property-based testing** — Libraries like fast-check (JS), Hypothesis (Python), QuickCheck (Haskell) generate hundreds of random inputs to find edge cases you'd never think of. Essential for parsers, serializers, and math functions.

4. **Test environment parity** — Tests that pass locally but fail in CI usually differ in: timezone, locale, file system case sensitivity, available memory, or race conditions from parallelism. Pin timezone to UTC in test setup.

5. **Regression test from production bugs** — Every production bug must result in a regression test that would have caught it. This builds an ever-growing safety net specific to YOUR system's failure modes.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |