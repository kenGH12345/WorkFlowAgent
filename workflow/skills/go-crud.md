---
name: go-crud
version: 1.1.0
type: domain-skill
domains: [backend, go, database]
dependencies: [api-design]
load_level: task
max_tokens: 800
triggers:
  keywords: [go, golang, gin, gorm, grpc, protobuf]
  roles: [developer]
description: "Go language CRUD implementation patterns"
---
# Skill: go-crud

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: Go language CRUD implementation patterns
> **Domains**: backend, go, database

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Always pass `context.Context` as the first parameter** — Every function that does I/O (DB, HTTP, gRPC) must accept `ctx context.Context` as its first argument. This enables timeout propagation, cancellation, and tracing across the call chain.

2. **Handle every error explicitly** — Go has no exceptions. Never use `_` to discard errors. Wrap errors with `fmt.Errorf("operation failed: %w", err)` to preserve the error chain for debugging.

3. **Use struct tags for validation, not manual checks** — Leverage `binding:"required"` (Gin) or `validate:"required,min=1"` (go-playground/validator) on struct fields. Manual `if field == ""` checks proliferate and diverge.

4. **Close `sql.Rows` immediately after use** — Always `defer rows.Close()` right after `db.Query()`. Forgetting this leaks database connections and will exhaust the pool under load.

5. **Prefer `sqlx` or raw `database/sql` for complex queries** — GORM is excellent for simple CRUD but generates suboptimal SQL for complex joins, CTEs, and window functions. Drop to raw SQL for performance-critical paths.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Project Layout**: Follow `golang-standards/project-layout` — `cmd/` for entrypoints, `internal/` for private packages, `pkg/` for public libraries, `api/` for OpenAPI/proto definitions.
2. **CRUD Handler Flow**: Parse & validate request → Call service layer → Service calls repository → Repository executes SQL → Return structured response with proper HTTP status.
3. **Error Propagation**: Repository returns domain errors → Service wraps with context → Handler maps to HTTP status via error type switch (`errors.Is` / `errors.As`).

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] All handlers have request timeout via `context.WithTimeout`
- [ ] Database connection pool configured (`SetMaxOpenConns`, `SetMaxIdleConns`, `SetConnMaxLifetime`)
- [ ] All `sql.Rows` and `sql.Stmt` properly closed with `defer`
- [ ] Input validation using struct tags, not manual checks
- [ ] Graceful shutdown implemented (`signal.Notify` + `server.Shutdown(ctx)`)

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Use database transactions for multi-step writes** — Wrap create-update-delete sequences in `db.Transaction(func(tx *gorm.DB) error { ... })`. Never call separate GORM methods without a transaction when data consistency matters.

2. **Implement pagination with cursor-based approach** — Offset-based pagination (`OFFSET 10000`) degrades linearly. Use cursor pagination (`WHERE id > ? ORDER BY id LIMIT ?`) for stable, O(1) performance on large tables.

3. **Connection pool tuning** — Set `MaxOpenConns` to match your expected concurrency (not higher), `MaxIdleConns` to ~25% of max open, and `ConnMaxLifetime` to < your DB's `wait_timeout` to prevent stale connections.

4. **Use `pgx` over `lib/pq` for PostgreSQL** — `pgx` is actively maintained, supports PostgreSQL-specific features (COPY, LISTEN/NOTIFY, binary protocol), and benchmarks 2-3x faster than `lib/pq`.

5. **Structured logging with `slog` (Go 1.21+)** — Use the standard library `log/slog` with JSON handler for structured, leveled logging. Attach request_id and user_id as attributes at middleware level.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **Global `db` variable without connection pool config** — Using `gorm.Open()` with defaults gives unlimited connections. Instead: always configure pool settings and health-check the connection at startup.

2. **Ignoring `sql.ErrNoRows`** — Treating "no rows" as a fatal error instead of a valid empty result. Instead: check `errors.Is(err, sql.ErrNoRows)` and return a 404 or empty response appropriately.

3. **Goroutine leak in request handlers** — Spawning goroutines in handlers without respecting the request context. Instead: always select on `ctx.Done()` in spawned goroutines to prevent leaks after client disconnects.

4. **GORM callback hell** — Overusing GORM hooks (`BeforeCreate`, `AfterUpdate`) for business logic. Instead: keep hooks for DB-level concerns (timestamps, soft-delete). Put business logic in the service layer.

5. **Returning GORM models directly in API responses** — Exposing internal DB schema (including sensitive fields) to clients. Instead: define separate response DTOs and map explicitly.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **GORM v2 breaking changes** — GORM v2 (`gorm.io/gorm`) has different API from v1 (`github.com/jinzhu/gorm`). Key differences: `*gorm.DB` is now chainable, `AutoMigrate` no longer creates databases, and `Where` conditions stack differently.

2. **Go 1.22+ range-over-func** — Go 1.22 introduced iterator functions. Use `iter.Seq` and `iter.Seq2` for custom iterators, replacing the old channel-based patterns that leaked goroutines.

3. **Gin vs Echo vs Chi** — Gin has the largest ecosystem but uses a custom context. Chi is `net/http` compatible (easier middleware reuse). Echo has the best auto-generated docs. Choose based on middleware ecosystem needs.

4. **gRPC streaming memory** — gRPC server-side streaming holds the entire response in memory by default. For large result sets, use pagination within the stream and set `MaxRecvMsgSize` / `MaxSendMsgSize` appropriately.

5. **`database/sql` prepared statement cache** — `database/sql` automatically caches prepared statements per connection. Calling `db.Prepare()` manually and storing the `*sql.Stmt` is only needed for high-frequency identical queries.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |