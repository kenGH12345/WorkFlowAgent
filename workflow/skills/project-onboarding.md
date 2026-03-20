---
name: project-onboarding
version: 1.1.0
type: domain-skill
domains: [onboarding, legacy]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [onboard, setup, init, new project, getting started]
  roles: [developer, analyst]
description: "Legacy project onboarding: familiarise, distil, execute"
---
# Skill: project-onboarding

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: Legacy project onboarding: familiarise → distil → execute
> **Domains**: onboarding, legacy

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Read before write — always** — Spend the first 20% of onboarding time reading existing code, docs, and tests. Never start modifying code until you can explain the system's data flow from entry point to database.

2. **Map the dependency graph first** — Before touching code, build a mental (or actual) graph of module dependencies. Identify the "god modules" that everything depends on — those are the highest-risk change targets.

3. **Run the existing test suite immediately** — Before any changes, run all tests to establish a baseline. If tests fail, document which ones and why. This prevents inheriting blame for pre-existing failures.

4. **Never refactor during onboarding** — Resist the urge to "clean up" code you don't fully understand. What looks like dead code may be critical for an edge case. Earn understanding before earning the right to change.

5. **Document tribal knowledge as you discover it** — When a colleague explains something undocumented, write it down immediately (in code comments, wiki, or ADR). You are the last person who will ask — future devs won't have that colleague.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Day 1-3: Reconnaissance** — Clone repo → Read README/CONTRIBUTING → Run build → Run tests → Identify entry points (`main`, routes, event handlers) → Trace one full request end-to-end.
2. **Day 4-7: Cartography** — Map architecture (draw boxes-and-arrows diagram) → List all external dependencies → Identify deployment pipeline → Read the last 20 merged PRs to understand team conventions.
3. **Week 2+: First Contribution** — Pick a well-scoped bug or small feature → Implement following existing patterns exactly → Request review from a senior team member → Learn from review feedback.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] README read and build instructions followed successfully
- [ ] Full test suite executed with results documented
- [ ] Architecture diagram drawn (even rough boxes-and-arrows)
- [ ] All external service dependencies identified (DBs, APIs, queues)
- [ ] Deployment pipeline understood (CI/CD steps, environments)
- [ ] At least one full request traced from entry point to response
- [ ] Team coding conventions documented (naming, testing, branching)

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **The "5 Whys" for legacy code** — When you encounter confusing code, ask "why" 5 times. Why is this check here? Because X crashed in 2022. Why did X crash? Because the upstream API changed format. This reveals the REAL constraints behind the code.

2. **Create a "Glossary of Terms"** — Legacy projects accumulate domain jargon. Build a mapping: "What the code calls it → What the business calls it → What it actually is." This prevents miscommunication with stakeholders.

3. **Shadow the on-call rotation** — Sit with the on-call engineer for a day. You'll learn more about failure modes, monitoring gaps, and operational pain points in 8 hours than in 2 weeks of code reading.

4. **Clone the production database (sanitized) locally** — Running against realistic data reveals edge cases that unit tests miss. Stale enums, nulls in "required" fields, and encoding issues only appear with real data.

5. **Build a "Change Impact Map"** — Before your first PR, create a document listing: "If I change module X, modules Y and Z are affected because..." This forces you to understand coupling and gives reviewers confidence.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **The Big Rewrite** — Proposing to rewrite the entire system in week 2. This always fails due to underestimating edge cases, hidden business rules, and integration complexity. Instead: incremental improvement via Strangler Fig pattern.

2. **Copy-paste existing patterns blindly** — Following existing code patterns without understanding why they exist. The pattern may be working around a bug that was since fixed, or may be an anti-pattern the team wants to move away from. Instead: ask why.

3. **Skipping local environment setup** — Reading code on GitHub without running it locally. You miss runtime behavior, configuration nuances, and build-order dependencies. Instead: invest the time to get a full local dev environment running.

4. **Over-documenting before understanding** — Writing extensive documentation based on first impressions. Initial understanding is often wrong. Instead: take personal notes first, convert to team docs only after validated understanding.

5. **Ignoring test quality** — Assuming existing tests are correct and complete. Legacy tests often have outdated assertions, flaky timing dependencies, or test the wrong thing entirely. Instead: read test code as critically as production code.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **Git archaeology is your best friend** — `git log --oneline --since="2024-01-01" -- path/to/file` shows recent changes. `git blame` reveals who wrote each line and when. `git log --all --follow -- deleted-file.js` finds deleted files.

2. **CI pipeline as documentation** — The CI config (`.github/workflows/`, `Jenkinsfile`, `.gitlab-ci.yml`) often reveals hidden build steps, environment variables, and deployment targets that aren't documented anywhere else.

3. **Database migration history tells the story** — Read migrations chronologically. They reveal how the data model evolved, which columns were added/removed, and what business requirements drove schema changes.

4. **Watch for "temporal coupling"** — Legacy systems often have implicit ordering requirements (service A must start before B, job X must complete before Y). These are rarely documented and are the #1 source of "works on my machine" issues.

5. **`.env.example` is a treasure map** — The example environment file lists every external dependency the project needs: databases, API keys, feature flags, service URLs. If it doesn't exist, create one as your first contribution.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |