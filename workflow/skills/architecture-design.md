---
name: architecture-design
version: 1.1.0
type: domain-skill
domains: [architecture, design]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [architecture, design pattern, module, dependency, coupling, solid]
  roles: [architect]
description: "Architecture design patterns, principles and best practices"
---
# Skill: architecture-design

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: Architecture design patterns, principles and best practices
> **Domains**: architecture, design

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Depend on abstractions, not concretions (DIP)** — High-level modules must not import low-level modules. Both should depend on interfaces. This is the foundation of testable, swappable architecture.

2. **Enforce module boundaries with explicit public APIs** — Every module/package exports only what is necessary. Internal implementation details must be inaccessible. Use `internal` (C#), package-private (Java), or barrel exports (TS).

3. **Single Responsibility at every level** — A class has one reason to change. A module owns one domain. A service handles one bounded context. Violation at any level leads to cascading changes on unrelated modifications.

4. **Prefer composition over inheritance** — Inheritance creates rigid hierarchies. Composition with interfaces allows mixing behaviors freely. Limit inheritance depth to 2 levels; beyond that, use strategy/decorator patterns.

5. **Every architectural decision must have a recorded rationale** — Use Architecture Decision Records (ADRs). Without recorded "why", future developers will either blindly follow or blindly reverse decisions.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Architecture Review Flow**: Gather requirements → Identify quality attributes (latency, availability, consistency) → Select patterns → Document in ADR → Prototype critical paths → Review with stakeholders → Implement incrementally.
2. **Dependency Direction**: UI → Application → Domain → Infrastructure (Hexagonal/Clean architecture). Dependencies always point inward. The domain layer has ZERO external dependencies.
3. **Scaling Decision Tree**: Identify bottleneck (CPU/IO/memory) → Vertical scaling first (simpler) → Horizontal scaling if vertical hits limits → Stateless services + external state stores → Eventually consistent if strong consistency isn't required.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] All module boundaries enforced (no circular dependencies)
- [ ] Domain logic has zero infrastructure imports
- [ ] ADR written for every significant design decision
- [ ] Interface defined for every cross-module dependency
- [ ] Maximum 3 levels of abstraction in any call chain
- [ ] Deployment topology documented and matches code architecture

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Hexagonal Architecture (Ports & Adapters)** — Core domain logic in the center, with ports (interfaces) for inbound (use cases) and outbound (DB, messaging) access. Adapters implement ports. Swap adapters for testing or platform changes without touching domain code.

2. **Strangler Fig for legacy migration** — Never rewrite from scratch. Incrementally build new components behind an API gateway/facade that routes traffic between old and new. Gradually increase new-system coverage until legacy is fully replaced.

3. **Event-driven decoupling for cross-domain communication** — Services within the same bounded context call each other directly. Cross-domain communication uses events (domain events, message queues). This prevents temporal coupling and allows independent deployment.

4. **Fitness functions for architecture governance** — Automate architecture rules in CI: dependency direction checks, cyclomatic complexity limits, module coupling metrics. Tools: ArchUnit (Java), TS-Morph (TypeScript), `depcheck`, custom lint rules.

5. **Capacity planning with load testing** — Define performance budgets (p50 < 100ms, p99 < 500ms). Run load tests in CI against staging. Detect performance regressions before they reach production. Tools: k6, Locust, Artillery.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **Big Ball of Mud** — No discernible architecture; everything calls everything. Instead: identify boundaries, extract modules, enforce dependency direction. Start with the highest-coupling hotspot.

2. **Golden Hammer** — Applying the same solution (e.g., microservices) to every problem. Instead: evaluate trade-offs for each context. A modular monolith may outperform microservices for small teams.

3. **Distributed Monolith** — Microservices that must deploy together, share databases, or make synchronous chains of calls. Instead: ensure services own their data, communicate asynchronously, and can deploy independently.

4. **Premature abstraction** — Creating interfaces, factories, and layers before understanding the problem. Instead: follow the Rule of Three — extract an abstraction only after you see the same pattern three times.

5. **Resume-Driven Development** — Choosing technologies to pad resumes rather than to solve the problem. Instead: select the simplest technology that meets requirements. Boring technology is battle-tested technology.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **Monolith-first strategy** — Martin Fowler and DHH both advocate starting with a well-structured monolith. Extract microservices only when team size, deployment frequency, or scaling needs demand it. Most projects never reach that point.

2. **CQRS applicability** — Command Query Responsibility Segregation shines when read and write patterns diverge dramatically (e.g., complex writes, simple reads with different projections). It adds significant complexity — don't use it for simple CRUD.

3. **Event sourcing trade-offs** — Event sourcing provides perfect audit trails and temporal queries, but makes simple queries (current state) complex, requires event schema evolution strategy, and consumes more storage. Use it for domains where history IS the business requirement (finance, compliance).

4. **Conway's Law is real** — Your system architecture will mirror your team communication structure. If you want microservices, you need autonomous teams aligned to bounded contexts. Otherwise, you'll build a distributed monolith.

5. **ADR template** — Use the Nygard format: `# Title`, `## Status` (proposed/accepted/deprecated), `## Context`, `## Decision`, `## Consequences`. Keep each ADR under 2 pages. Store in `/docs/adr/` alongside code.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |