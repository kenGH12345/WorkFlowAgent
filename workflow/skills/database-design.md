---
name: database-design
version: 1.0.0
type: domain-skill
domains: [database, data-modeling, persistence]
dependencies: []
load_level: task
max_tokens: 1000
triggers:
  keywords: [database, db, sql, nosql, migration, schema, index, query, table, column, foreign key, orm, model, entity, relation, transaction, mongodb, postgresql, mysql, redis, sqlite]
  roles: [architect, developer]
description: "Database design, query optimization, migration safety, and data modeling best practices"
---
# Skill: database-design

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Database design, query optimization, migration safety, and data modeling best practices
> **Domains**: database, data-modeling, persistence

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

### R1: Schema Design Before Code
Always design the data model BEFORE writing application code. The schema is the contract that outlasts any application layer refactoring.

### R2: Migration Safety
Every schema change MUST be backward-compatible with the previous application version:
- Add columns with DEFAULT values (never NOT NULL without default on existing tables)
- Never rename columns in a single step (add new → migrate data → drop old)
- Never drop columns that the current production code still reads
- Always test migrations on a production-sized dataset copy

### R3: Index Discipline
- Every foreign key MUST have an index
- Every column used in WHERE, ORDER BY, or JOIN must be evaluated for indexing
- Composite indexes: put the most selective column first (leftmost prefix rule)
- Never create indexes speculatively — use EXPLAIN ANALYZE to justify each index

### R4: Transaction Boundaries
- Keep transactions as short as possible
- Never hold a transaction open across network calls or user interactions
- Use appropriate isolation levels (READ COMMITTED is usually sufficient; SERIALIZABLE only when necessary)
- Always handle transaction rollback on error

---

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

### Phase 1: Data Modeling
1. Identify entities and their relationships from requirements
2. Define primary keys (prefer UUID or auto-increment; avoid composite PKs for simplicity)
3. Normalize to 3NF first, then denormalize intentionally where performance requires it
4. Document every denormalization decision with rationale

### Phase 2: Schema Design
1. Define column types precisely (use the smallest type that fits: `smallint` over `integer`, `varchar(100)` over `text` when length is bounded)
2. Add NOT NULL constraints by default (nullable columns are the exception, not the rule)
3. Define foreign keys with appropriate ON DELETE behavior (CASCADE, SET NULL, or RESTRICT)
4. Add CHECK constraints for business rules that can be expressed in SQL
5. Add created_at and updated_at timestamps to every table

### Phase 3: Query Design
1. Write queries that use indexes (check with EXPLAIN ANALYZE)
2. Avoid SELECT * — list only needed columns
3. Use parameterised queries exclusively (never string concatenation)
4. Paginate all list queries (LIMIT + OFFSET or cursor-based)
5. Avoid N+1 query patterns — use JOINs or batch loading

### Phase 4: Migration Execution
1. Write both UP and DOWN migrations
2. Test migration on a staging database with production-sized data
3. Measure migration duration — long-running migrations need special handling
4. Use online schema change tools for large tables (pt-online-schema-change, gh-ost)

---

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

### Schema
- [ ] All tables have a single-column primary key
- [ ] All foreign keys have corresponding indexes
- [ ] All columns have appropriate NOT NULL constraints
- [ ] Timestamps (created_at, updated_at) present on every entity table
- [ ] Enum-like columns use a lookup table or CHECK constraint (not bare strings)

### Queries
- [ ] All queries use parameterised statements (no string concatenation)
- [ ] All list endpoints use pagination
- [ ] No N+1 query patterns (DB calls inside loops)
- [ ] Complex queries validated with EXPLAIN ANALYZE
- [ ] Aggregate queries (COUNT, SUM) have appropriate indexes

### Migrations
- [ ] Migration is backward-compatible with current production code
- [ ] Both UP and DOWN migration scripts exist
- [ ] Migration tested on production-sized dataset
- [ ] Long-running DDL operations use online schema change tools

---

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

### 1. Normalization with Intent
Normalize by default (eliminate data redundancy). Denormalize only when:
- Query performance requires it AND profiling proves it
- The denormalized data has a clear update strategy (triggers, application-level sync, or eventual consistency)
- Document the denormalization decision in an ADR

### 2. Connection Pooling
- Always use connection pools (never open/close per query)
- Size pools appropriately: `pool_size = (core_count * 2) + disk_spindles` (PostgreSQL recommendation)
- Set idle timeouts to reclaim unused connections
- Monitor pool exhaustion as a key metric

### 3. Soft Deletes vs Hard Deletes
- Prefer soft deletes (`deleted_at` timestamp) for business data that may need audit or recovery
- Use hard deletes for transient data (logs, caches, sessions)
- Add a partial index on `deleted_at IS NULL` to keep queries efficient
- Schedule periodic hard deletion of soft-deleted records past retention period

### 4. Read Replicas and Write Splitting
- Route read queries to replicas, write queries to primary
- Account for replication lag in application logic (read-your-own-writes consistency)
- Never send transactions or writes to replicas

---

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Store JSON blobs for structured data | Use proper columns with types and constraints |
| Use EAV (Entity-Attribute-Value) pattern | Define explicit columns; use JSONB only for truly dynamic data |
| Create indexes on every column "just in case" | Index only columns used in WHERE/JOIN/ORDER BY, validated by EXPLAIN |
| Use OFFSET for deep pagination | Use cursor-based pagination (WHERE id > last_id LIMIT N) |
| Lock entire tables for updates | Use row-level locks with SELECT ... FOR UPDATE |
| Store files as BLOBs in the database | Store files in object storage (S3), store URL/key in database |
| Run unbounded queries (no LIMIT) | Always paginate; add LIMIT even on admin/internal queries |

---

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

- When the project uses **PostgreSQL**: leverage JSONB for semi-structured data, partial indexes, CTEs, and LISTEN/NOTIFY
- When the project uses **MySQL**: be aware of InnoDB locking behavior, use `utf8mb4` charset, enable `innodb_file_per_table`
- When the project uses **MongoDB**: design for access patterns (embed vs reference), use schema validation, create compound indexes
- When the project uses **Redis**: use appropriate data structures (Hash for objects, Sorted Set for leaderboards), set TTL on all keys, plan for eviction
- When the project uses **SQLite**: single-writer limitation, WAL mode for concurrent reads, no ALTER TABLE DROP COLUMN (before 3.35)
- When the task is **schema migration**: prioritize backward-compatibility and rollback safety
- When the task is **query optimization**: always start with EXPLAIN ANALYZE before making changes

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-19 | Initial creation. Comprehensive database design skill covering schema design, query optimization, migration safety, and data modeling. Inspired by ECC skill ecosystem. |