---
name: api-design
version: 1.1.0
type: domain-skill
domains: [backend, api]
dependencies: [architecture-design]
load_level: task
max_tokens: 800
triggers:
  keywords: [api, rest, graphql, endpoint, swagger, openapi, http]
  roles: [developer]
description: "REST/RPC API design rules and patterns"
---
# Skill: api-design

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: REST/RPC API design rules and patterns
> **Domains**: backend, api

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Use nouns for resources, verbs for actions** — `GET /users/123` not `GET /getUser?id=123`. Reserve verb-style paths only for non-CRUD operations like `POST /users/123/activate`.

2. **Version your API from day one** — Use URL prefix versioning (`/api/v1/`) for public APIs. Header-based versioning (`Accept: application/vnd.api.v2+json`) is elegant but painful for debugging and cURL testing.

3. **Return consistent error envelope** — Every error response must follow the same shape: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`. Never return plain strings or mixed formats.

4. **Use HTTP status codes correctly** — 200 for success, 201 for created, 204 for deleted (no body), 400 for client errors, 401 for auth, 403 for authz, 404 for not found, 409 for conflict, 429 for rate-limit, 500 for server errors. Never return 200 with error in body.

5. **All list endpoints must support pagination** — Default to `?page=1&page_size=20` with hard upper limit (e.g., max 100). Response must include `total_count`, `page`, `page_size`, and `has_next`.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **API Design Flow**: Define resources → Map CRUD to HTTP verbs → Design request/response schemas → Write OpenAPI spec first (design-first) → Generate server stubs → Implement handlers → Add integration tests.
2. **Breaking Change Protocol**: New fields → add with defaults (non-breaking) → Removing/renaming fields → new API version → Deprecate old version with `Sunset` header and minimum 6-month overlap.
3. **Auth Flow**: Use Bearer tokens (JWT or opaque). Access tokens: short-lived (15min). Refresh tokens: long-lived, rotated on use, stored securely. Never send credentials in query parameters.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] OpenAPI/Swagger spec exists and is kept in sync with implementation
- [ ] All endpoints return consistent error envelope
- [ ] Pagination implemented on all list endpoints with max page_size cap
- [ ] Rate limiting configured with `429` response and `Retry-After` header
- [ ] CORS configured explicitly (not `*` in production)
- [ ] Request/response examples in OpenAPI spec for every endpoint

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Design-first with OpenAPI** — Write the OpenAPI spec before implementation. This forces clear thinking about contracts, enables parallel frontend/backend development, and auto-generates client SDKs and documentation.

2. **Use ETag/If-None-Match for cache validation** — Return `ETag` headers on GET responses. Clients send `If-None-Match` on subsequent requests. Server returns `304 Not Modified` if unchanged, saving bandwidth and processing.

3. **Idempotency keys for mutations** — Accept `Idempotency-Key` header on POST/PATCH requests. Store the key-to-response mapping server-side for 24h. This makes retries safe for payment, order, and other critical mutations.

4. **HATEOAS for discoverability** — Include `_links` in responses pointing to related resources and available actions. This enables clients to navigate the API without hardcoding URLs: `"_links": { "self": "/users/123", "orders": "/users/123/orders" }`.

5. **Envelope your responses** — Wrap data in `{ "data": ..., "meta": { "request_id": "...", "timestamp": "..." } }`. The meta block enables debugging without parsing headers and supports consistent client handling.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **Chatty API** — Requiring 10+ API calls to render a single page. Instead: design aggregation endpoints or use GraphQL for flexible data fetching. Consider BFF (Backend-for-Frontend) pattern.

2. **Exposing internal IDs** — Using auto-increment database IDs in URLs leaks information (total count, creation order). Instead: use UUIDs or short hashids for public identifiers.

3. **Ignoring Accept / Content-Type** — Not validating or respecting content negotiation headers. Instead: return `415 Unsupported Media Type` for unknown content types and `406 Not Acceptable` for unsupported accept types.

4. **Nested resource abuse** — Deep URLs like `/orgs/1/teams/2/members/3/tasks/4`. Instead: limit nesting to one level. Use query parameters or flat endpoints with filters for deeper relationships.

5. **Undocumented breaking changes** — Changing response shapes without versioning. Instead: treat any field removal, type change, or behavior change as a breaking change requiring a new version.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **GraphQL vs REST decision** — Use REST for simple CRUD with stable schemas. Use GraphQL when clients need flexible data shapes, multiple entity aggregation, or real-time subscriptions. Avoid GraphQL for file uploads and simple microservice-to-microservice calls.

2. **gRPC for internal services** — gRPC with Protocol Buffers is 5-10x faster than JSON REST for internal service communication. Use `grpc-gateway` to expose gRPC services as REST for external consumers.

3. **OpenAPI 3.1 vs 3.0** — OAS 3.1 aligns with JSON Schema 2020-12 (full compatibility). OAS 3.0 has subtle differences in `nullable`, `oneOf`, and `$ref` handling. Tooling support for 3.1 is now mature — prefer it for new projects.

4. **Rate limiting strategies** — Token bucket for steady-state limiting, sliding window for burst protection, leaky bucket for smoothing. Use `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.

5. **API Gateway gotcha** — API gateways (Kong, AWS API Gateway) may modify headers, add latency, and have request/response size limits (e.g., 10MB for AWS). Always test with the gateway in the loop, not just direct service calls.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |