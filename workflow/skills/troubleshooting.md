---
name: troubleshooting
version: 3.0.0
type: troubleshooting
domains: [general, debugging, error-handling]
dependencies: []
load_level: global
max_tokens: 800
triggers:
  keywords: [error, bug, fix, crash, fail, issue, debug, troubleshoot, exception]
  roles: [developer, tester, coding-agent]
description: "Common errors, root causes, and fix recipes accumulated from complaint resolutions"
---

# Skill: troubleshooting

> **Version**: 1.1.0
> **Description**: Common errors, root causes, and fix recipes accumulated from complaint resolutions
> **Domains**: general, debugging, error-handling

---

## Common Errors
<!-- PURPOSE: Document specific error messages, stack traces, and symptoms that developers encounter. Each entry should include the exact error text and a brief description of when it occurs. -->

1. **`ECONNREFUSED` / `Connection refused`** Ôø?The target service is not running or not listening on the expected port. Check: is the service started? Is the port correct? Is a firewall blocking? Is the service binding to `0.0.0.0` vs `127.0.0.1`?

2. **`ENOMEM` / `OutOfMemoryError` / `JavaScript heap out of memory`** Ôø?Process exceeded memory limit. Immediate fix: increase `--max-old-space-size` (Node) or `-Xmx` (Java). Root cause: memory leak (event listeners not removed, growing caches, unclosed streams).

3. **`ETIMEDOUT` / `Request timeout`** Ôø?Remote call exceeded deadline. Check: network connectivity, DNS resolution, target service health, connection pool exhaustion. Fix: add timeout configuration, implement circuit breaker, check for connection leaks.

4. **`ENOENT` / `FileNotFoundException`** Ôø?File or directory does not exist. Common causes: relative path resolved from wrong working directory, file not included in Docker image, case-sensitive file system on Linux vs case-insensitive on macOS/Windows.

5. **`CORS error` (browser)** Ôø?Server not returning proper `Access-Control-Allow-Origin` header. Fix: configure CORS middleware with explicit allowed origins (not `*` in production), handle preflight `OPTIONS` requests, check proxy/gateway CORS config override.

6. **`EADDRINUSE` / `Port already in use`** Ôø?Another process is already listening on the same port. Debug: `lsof -i :PORT` (Unix) or `netstat -ano | findstr PORT` (Windows). Fix: kill the stale process, or use dynamic port assignment for tests.

7. **`ERR_MODULE_NOT_FOUND` / `Cannot find module`** Ôø?Module resolution failure. Common causes: missing `npm install`, wrong relative path (`./` vs no prefix), `.mjs` vs `.cjs` extension mismatch, `exports` field in `package.json` not including the path.

8. **`EPERM` / `Permission denied`** Ôø?File system permission issue. Common in Docker (non-root user), CI pipelines (readonly filesystem), or cross-OS development (executable bit lost on Windows). Fix: check file ownership, use `chmod` / `chown`, verify Docker user matches file owner.

9. **`EMFILE` / `Too many open files`** Ôø?Process hit the OS file descriptor limit. Causes: connection leak (sockets not closed), stream leak (files opened but never closed), excessive parallelism. Fix: increase `ulimit -n`, find and fix the leak with `lsof -p PID | wc -l`.

10. **`SyntaxError: Unexpected token`** Ôø?JSON parse failure or JS/TS syntax error. When parsing: the input is not valid JSON (trailing comma, unquoted key, BOM character). When loading: Node.js version doesn't support the syntax (optional chaining `?.` requires Node 14+).

## Root Cause Analysis
<!-- PURPOSE: Explain WHY each common error occurs at a technical level. Link symptoms to underlying causes (misconfiguration, race condition, version incompatibility, etc.). -->

1. **The "It Works On My Machine" Framework** Ôø?Systematically check differences: OS version, runtime version, environment variables, database state, network access, file system permissions, timezone/locale, available disk space.

2. **Binary search for regression** Ôø?Use `git bisect` to find the exact commit that introduced a bug. Works when: you know a "good" commit and a "bad" commit. Reduces O(n) commit review to O(log n).

3. **Memory leak diagnosis** Ôø?Take heap snapshots at T=0, T=5min, T=30min. Compare retained object counts. Growing arrays, event listeners, closures, and un-disposed timers are the top 4 causes across all runtimes.

4. **Deadlock detection** Ôø?Symptoms: process hangs, CPU near 0%, no logs. Use thread dump (Java: `jstack`, Node: `--inspect` + Chrome DevTools, Go: `pprof`). Look for two threads each holding a lock the other needs.

5. **Race condition identification** Ôø?Symptoms: intermittent failures, different results on retry. Strategy: add logging with timestamps, increase thread/worker count to amplify the race, use thread sanitizer (TSan) if available.

6. **Cascading failure analysis** Ôø?Symptom: one service fails, then others follow. Trace the dependency chain: A Ôø?B Ôø?C. Check if B has circuit breakers, timeouts, and fallbacks. Without these, A's failure propagates to all of B's callers.

7. **Performance degradation root cause** Ôø?Symptom: response times gradually increase. Methodology: (a) check if data volume grew (queries scanning more rows), (b) check if concurrency changed (connection pool contention), (c) check for GC pressure (heap growing), (d) check for lock contention (thread dumps).

8. **Configuration-related failures** Ôø?Symptom: works in staging, fails in production. Diagnosis: diff all configs between environments (`env | sort` both, then `diff`). Common culprits: database connection string, API keys, feature flags, log levels, timeout values.

## Fix Recipes
<!-- PURPOSE: Step-by-step fix instructions for each error. Must be copy-paste actionable: "1. Open X, 2. Change Y to Z, 3. Verify by running W". -->

1. **Connection pool exhaustion** Ôø?Symptom: requests hang after N concurrent connections. Fix: (a) Set explicit pool size matching expected concurrency, (b) Add connection timeout, (c) Add `pool.on('error')` handler, (d) Use connection pool monitoring to detect leaks.

2. **Infinite redirect loop** Ôø?Symptom: browser shows "too many redirects". Debug: `curl -v -L --max-redirs 5 <url>` to see redirect chain. Common cause: HTTP‚ÜíHTTPS redirect + HTTPS‚ÜíHTTP reverse proxy header mismatch. Fix: check `X-Forwarded-Proto` handling.

3. **Stale cache serving outdated data** Ôø?Symptom: changes not reflected despite code deploy. Fix: (a) Add cache-busting version/hash to asset URLs, (b) Set `Cache-Control: no-cache` for dynamic API responses, (c) Clear CDN/Redis cache after deploy.

4. **Time zone bugs** Ôø?Symptom: dates off by N hours, especially around DST transitions. Fix: (a) Store all timestamps as UTC in database, (b) Convert to local only at display layer, (c) Use libraries that handle DST (Luxon, java.time, DateTimeOffset).

5. **Environment variable not loaded** Ôø?Symptom: config value is `undefined`/empty in one environment. Debug: `printenv | grep VAR` on the actual runtime. Common causes: `.env` not loaded (missing dotenv init), Docker not passing `--env-file`, CI secret not configured for branch.

6. **npm/yarn install fails with ERESOLVE** Ôø?Symptom: peer dependency conflict during install. Fix: (a) `npm install --legacy-peer-deps` as quick workaround, (b) check which packages have conflicting version ranges using `npm ls <package>`, (c) update the conflicting packages, (d) use `overrides` in package.json to force resolution.

7. **Docker container exits immediately** Ôø?Symptom: container starts and stops with exit code 0 or 1. Debug: `docker logs <container>` to see stdout/stderr. Common causes: process runs in background (use `exec` form in CMD), missing entrypoint script, wrong working directory, missing env vars.

8. **Database migration fails halfway** Ôø?Symptom: migration script errors mid-execution, leaving DB in inconsistent state. Fix: (a) Always wrap migrations in transactions (if DB supports DDL transactions), (b) For MySQL/NoSQL, write idempotent migrations, (c) Keep a rollback script for every migration, (d) Test migrations against production-clone data first.

## Prevention Rules
<!-- PURPOSE: Prescriptive rules that PREVENT errors from occurring in the first place. Written as imperatives: "Always X", "Never Y", "Before doing Z, check W". -->

1. **Implement structured health checks** Ôø?Every service must expose `/healthz` (liveness) and `/readyz` (readiness) endpoints that verify actual dependencies (DB ping, downstream service connectivity), not just return 200.

2. **Set timeouts on EVERY external call** Ôø?HTTP, gRPC, database, cache, message queue Ôø?all must have explicit timeouts. Default "no timeout" means a hung dependency takes your entire service down.

3. **Centralized error tracking** Ôø?Use Sentry, Datadog, or similar to capture errors with full context (stack trace, request data, user, environment). Alert on error rate spikes, not individual errors.

4. **Canary deployments for risk reduction** Ôø?Deploy to 5% of traffic first, monitor error rates for 15 minutes, then gradually increase. Auto-rollback if error rate exceeds baseline + 2 standard deviations.

5. **Runbook for every alert** Ôø?Every monitoring alert must link to a runbook with: what this alert means, how to diagnose, how to mitigate, who to escalate to. Without runbooks, on-call becomes guesswork.

6. **Never deploy on Friday afternoon** Ôø?Schedule risky deployments for early-week, early-day. This maximizes the available response time if issues are discovered.

7. **Dependency pinning** Ôø?Pin all dependencies to exact versions in lockfiles (`package-lock.json`, `go.sum`, `Pipfile.lock`). Auto-update via Dependabot/Renovate with CI checks, not manual `npm update`.

8. **Pre-deploy checklist** Ôø?Before every production deploy, verify: (a) all tests pass, (b) migration scripts reviewed, (c) rollback plan documented, (d) monitoring dashboard open, (e) team aware of deploy window.

9. **Graceful degradation by default** Ôø?Every non-critical feature must have a fallback: cache miss Ôø?compute on the fly, recommendation service down Ôø?show popular items, analytics service down Ôø?queue for retry.

10. **Post-incident review within 48h** Ôø?After every P0/P1 incident, conduct blameless post-mortem. Produce: timeline, root cause, contributing factors, action items with owners and deadlines. Share learnings widely.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for troubleshooting. -->

1. **Phase 1: Reproduce** ‚Ä?Before diagnosing, confirm you can reproduce the issue. Document: exact steps, environment (OS, runtime version, config), expected behavior, actual behavior. If it's intermittent, note frequency and conditions.

2. **Phase 2: Isolate** ‚Ä?Narrow the scope: (a) which service/module? (b) which function/endpoint? (c) which input triggers it? Use binary search: disable half the system, check if the issue persists. Repeat until the faulty component is isolated.

3. **Phase 3: Diagnose** ‚Ä?Apply root cause analysis from the "Root Cause Analysis" section above. Check logs with the relevant trace_id. Examine recent changes (`git log --since="2 days ago"`). Compare working vs broken environments.

4. **Phase 4: Fix** ‚Ä?Apply the minimal fix that addresses the root cause (not the symptom). Use the "Fix Recipes" section for known issues. For unknown issues, write a failing test first, then fix the code until the test passes.

5. **Phase 5: Verify and Document** ‚Ä?Confirm the fix resolves the issue in the same environment where it was reproduced. Run the full test suite. Add a regression test. Update this Skill's "Common Errors" section if it's a new error pattern.

## Checklist
<!-- PURPOSE: Verification checklist for troubleshooting. -->

### Before Starting
- [ ] Issue is reproducible (or reproduction steps are documented)
- [ ] Environment details captured (OS, runtime, config, timestamps)
- [ ] Recent changes reviewed (`git log`, deployment logs)
- [ ] Relevant logs collected with trace_id

### During Investigation
- [ ] Scope narrowed to specific service/module/function
- [ ] Root cause identified (not just symptom)
- [ ] Related errors in logs checked (the visible error may be a downstream symptom)
- [ ] "Works on my machine" checklist applied (see Root Cause Analysis #1)

### After Fix
- [ ] Regression test added for this specific issue
- [ ] Fix deployed and verified in the original failing environment
- [ ] Related documentation/runbooks updated
- [ ] Post-incident review scheduled (for P0/P1 issues)

## Best Practices
<!-- PURPOSE: Recommended patterns for effective troubleshooting. -->

1. **Log with correlation IDs from day one** ‚Ä?Every request should get a unique `trace_id` at the entry point, propagated through all downstream calls. Without this, correlating logs across services requires timestamp-based guessing, which is unreliable.

2. **Build a troubleshooting dashboard before you need it** ‚Ä?Create a dashboard with: error rate by endpoint, p95/p99 latency, active connections, memory/CPU usage, deployment markers. When an incident happens, having this ready saves 15 minutes of "let me set up monitoring."

3. **Use feature flags for risky deployments** ‚Ä?Wrap new features behind feature flags. If a deployment causes issues, disable the flag (instant rollback) rather than redeploying the old version (slow, error-prone). Feature flags should have a TTL and be cleaned up after stabilization.

4. **Maintain a "known issues" list per service** ‚Ä?A living document of issues that are known but not yet fixed, including workarounds. This prevents multiple engineers from investigating the same known issue independently. Review and prune quarterly.

5. **Practice incident response regularly** ‚Ä?Run "game day" exercises: simulate a database failure, network partition, or dependency outage. This builds muscle memory for real incidents and exposes gaps in runbooks.

## Anti-Patterns
<!-- PURPOSE: Common troubleshooting mistakes. -->

1. **Fixing the symptom, not the cause** ‚Ä?Adding a `try/catch` to suppress an error instead of fixing why the error occurs. The error reappears in a different form later. ‚ù?Suppress error ‚Ü?‚ú?Fix root cause and add a test.

2. **"Shotgun debugging"** ‚Ä?Making multiple changes simultaneously ("I'll update the config, restart the service, AND apply the patch"). If it works, you don't know which change fixed it. If it doesn't, you've introduced more variables. ‚ù?Multiple changes ‚Ü?‚ú?One change at a time, test after each.

3. **Debugging in production without a plan** ‚Ä?Running ad-hoc queries, modifying configs, restarting services randomly. Each action may mask the original issue or cause new ones. ‚ù?Ad-hoc ‚Ü?‚ú?Document your hypothesis and test plan before each action.

4. **Ignoring intermittent failures** ‚Ä?"It only happens sometimes, probably a fluke." Intermittent failures are race conditions, resource exhaustion, or network issues ‚Ä?real bugs that will escalate under load. ‚ù?Ignore ‚Ü?‚ú?Invest in reproduction; increase concurrency to amplify the race.

5. **Not checking recent deployments first** ‚Ä?80% of production issues are caused by recent changes. Before deep-diving into code, check: what was deployed in the last 24 hours? ‚ù?Start from scratch ‚Ü?‚ú?`git log --since="24 hours ago"` first.

## Gotchas
<!-- PURPOSE: Environment-specific troubleshooting traps. -->

1. **Docker container logs are lost on restart** ‚Ä?By default, Docker stores logs in the container's writable layer. When the container is removed, logs are gone. Fix: use a logging driver (json-file with rotation, or forward to an external system like Elasticsearch/CloudWatch).

2. **Timezone differences between application and database** ‚Ä?If your app runs in UTC but the database stores timestamps in local time (or vice versa), time-based queries return wrong results. This is especially tricky around DST transitions. Fix: enforce UTC everywhere.

3. **`kubectl logs` only shows current pod instance** ‚Ä?If a pod crashed and was replaced, `kubectl logs <pod>` shows the NEW pod's logs, not the crashed one. Use `kubectl logs <pod> --previous` to see the crashed pod's last logs.

4. **Browser caching masks API changes** ‚Ä?After deploying a backend fix, the browser may still serve the old JavaScript bundle from cache. Users report "it's still broken" because their client code is stale. Fix: use versioned/hashed asset filenames, or send `Cache-Control: no-cache` headers during incident response.

5. **AWS Lambda cold start time varies by runtime** ‚Ä?Java/C# Lambda cold starts: 3-10 seconds. Node.js/Python: 100-500ms. Go: 50-100ms. If your Lambda-based service has strict latency requirements, cold starts during scale-up events can violate SLAs. Fix: use provisioned concurrency for latency-sensitive functions.

## Context Hints
<!-- PURPOSE: Background knowledge for troubleshooting decisions. -->

1. **Most production incidents are caused by changes, not by existing code** ‚Ä?Deployments, config changes, infrastructure updates, traffic pattern shifts ‚Ä?these trigger most incidents. This is why "what changed recently?" should always be the first question.

2. **Mean Time to Detect (MTTD) is usually longer than Mean Time to Resolve (MTTR)** ‚Ä?Most teams invest in faster resolution, but the bigger win is faster detection. A comprehensive alerting system that catches issues in 2 minutes (instead of waiting for user reports after 30 minutes) reduces total impact more than any fix-time improvement.

3. **Post-incident reviews (PIRs) are the highest-ROI quality activity** ‚Ä?A single thorough PIR that produces 3 concrete action items prevents more bugs than 100 code reviews. The key: make them blameless, action-oriented, and time-bounded (completed within 48 hours).

4. **The "five whys" technique has limitations** ‚Ä?Asking "why?" five times helps find root causes but can lead to overly reductive conclusions ("because humans make mistakes"). Stop when you reach an actionable cause that the team can fix (a missing check, a wrong assumption, a gap in monitoring).

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-17 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Common Errors, Root Cause Analysis, Fix Recipes, Prevention Rules |
| v2.0.0 | 2026-03-19 | Major expansion: Common Errors 5‚Ü?0, Root Cause 5‚Ü?, Fix Recipes 5‚Ü?, Prevention 5‚Ü?0 |
| v3.0.0 | 2026-03-19 | Skill-enrich-all: added SOP, Checklist, Best Practices, Anti-Patterns, Gotchas, Context Hints |