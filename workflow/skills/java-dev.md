---
name: java-dev
version: 1.1.0
type: domain-skill
domains: [backend, java]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [java, spring, maven, gradle, jvm, kotlin]
  roles: [developer]
description: "Java development patterns"
---
# Skill: java-dev

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: Java development patterns
> **Domains**: backend, java

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Prefer records for DTOs (Java 17+)** — Use `record` types for immutable data carriers. They auto-generate `equals()`, `hashCode()`, `toString()`, eliminating boilerplate and subtle bugs from manual implementations.

2. **Never catch `Throwable` or `Error`** — Only catch `Exception` and its subclasses. Catching `OutOfMemoryError` or `StackOverflowError` leads to zombie processes that cannot recover.

3. **Close resources with try-with-resources** — Every `AutoCloseable` (streams, connections, readers) must use try-with-resources. Manual `finally` blocks are error-prone and miss multi-exception edge cases.

4. **Use `Optional` for return types, never for parameters** — Returning `Optional<T>` makes nullable returns explicit. But `Optional` as a method parameter creates confusing APIs — use method overloading instead.

5. **Specify `@Transactional(readOnly = true)` on read queries** — This hints the JPA provider to skip dirty checking and flush, significantly improving read performance on large result sets.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Spring Boot Service Flow**: Define interface → Implement with `@Service` → Inject via constructor (not `@Autowired` on field) → Add `@Transactional` at service layer → Unit test with Mockito, integration test with `@SpringBootTest`.
2. **Exception Handling**: Use `@ControllerAdvice` + `@ExceptionHandler` for global exception mapping. Map domain exceptions to HTTP status codes. Never expose stack traces in production responses.
3. **Configuration**: Use `@ConfigurationProperties` with `@Validated` instead of scattered `@Value` annotations. Group related configs into type-safe POJO classes.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] All `AutoCloseable` resources use try-with-resources
- [ ] No `@Autowired` on fields — use constructor injection exclusively
- [ ] All `@Entity` classes override `equals()` and `hashCode()` using business key (not JPA `@Id`)
- [ ] `@Transactional` boundaries are at service layer, not repository or controller
- [ ] Loggers use parameterized messages (`log.info("User {} logged in", userId)`) not string concatenation

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Constructor injection over field injection** — Constructor injection makes dependencies explicit, enables immutability (`final` fields), and makes classes testable without Spring context. Lombok's `@RequiredArgsConstructor` reduces boilerplate.

2. **Use `Pageable` for all list endpoints** — Never return unbounded collections from REST endpoints. Always accept `Pageable` and return `Page<T>`. This prevents OOM on large datasets and enables consistent client pagination.

3. **Flyway/Liquibase for schema management** — Never use JPA `ddl-auto=update` in production. Use versioned migration scripts (Flyway or Liquibase) for repeatable, auditable schema changes.

4. **Structured logging with MDC** — Set request-id, user-id, and trace-id in `MDC` at the filter level. Every log line automatically includes correlation context, making distributed debugging tractable.

5. **Virtual Threads for I/O-bound workloads (Java 21+)** — Use `Executors.newVirtualThreadPerTaskExecutor()` for I/O-heavy services. Virtual threads eliminate the thread-pool sizing problem — each blocking call gets its own lightweight thread at near-zero cost.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **N+1 Query Problem** — Lazy-loading collections in a loop generates N+1 SQL queries. Instead: use `@EntityGraph` or `JOIN FETCH` in JPQL to eagerly load associations in a single query.

2. **Transaction per request without thought** — Wrapping entire controller methods in `@Transactional` holds DB connections for the full request (including serialization). Instead: scope transactions tightly around the actual DB operations.

3. **Using `Date`/`Calendar` for date-time** — Legacy date classes are mutable and thread-unsafe. Instead: use `java.time.*` (`Instant`, `LocalDateTime`, `ZonedDateTime`). With JPA, use `@Column(columnDefinition = "TIMESTAMP")`.

4. **Catching and swallowing exceptions** — `catch (Exception e) { /* empty */ }` hides critical errors. Instead: at minimum log with full stack trace, or let it propagate to a global handler.

5. **Hardcoding environment-specific values** — Embedding URLs, credentials, or feature flags in code. Instead: use Spring profiles (`@Profile`), environment variables, or Config Server for 12-factor compliance.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **Spring Boot 3.x requires Java 17+** — Spring Boot 3.x migrated from `javax.*` to `jakarta.*` namespace. Third-party libraries using old `javax.servlet` will not compile — check dependency compatibility.

2. **GraalVM native image caveats** — Spring Native / GraalVM AOT compilation does not support reflection by default. Any library relying on reflection (Jackson, Hibernate proxies) needs explicit hints in `reflect-config.json`.

3. **Maven vs Gradle performance** — Gradle with build cache and parallel execution is 2-5x faster for incremental builds in large monorepos. Maven is simpler for straightforward projects. Choose based on project scale.

4. **Kotlin interop** — Kotlin data classes work seamlessly as Spring DTOs but require `kotlin-noarg` and `kotlin-allopen` compiler plugins for JPA entities and Spring proxying.

5. **`CompletableFuture` exception gotcha** — Exceptions in `thenApply()` chains are silently swallowed unless you add `exceptionally()` or `handle()`. Always add error handling to every async chain.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-15 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |