---
name: code-review
version: 2.0.0
type: domain-skill
domains: [quality, review, security]
dependencies: []
load_level: task
max_tokens: 1200
triggers:
  keywords: [review, refactor, clean code, lint, quality, smell, audit, vulnerability, security]
  roles: [developer, architect, coding-agent]
description: "Code review checklist, anti-hallucination rules, and security audit best practices"
---
# Skill: code-review

> **Type**: Domain Skill
> **Version**: 2.0.0
> **Description**: Code review checklist, anti-hallucination rules, and security audit best practices
> **Domains**: quality, review, security

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

### R1: Anti-Hallucination Constraints (MANDATORY)
Every finding MUST satisfy ALL of the following conditions:
1. **File path verified**: The reviewer MUST have actually read the file. Do NOT guess or fabricate file paths.
2. **Code evidence required**: Every FAIL finding must cite the exact code snippet or line number from the diff. No finding is valid without evidence.
3. **No phantom findings**: If you cannot locate the exact file, line, or code construct — do NOT report the finding. "I believe there might be..." is forbidden.
4. **No hallucinated fixes**: Fix instructions must reference real APIs, functions, or patterns that exist in the project. Do NOT invent APIs.

### R2: Confidence-Tiered Evidence Requirements
| Severity | Required Evidence |
|----------|-------------------|
| **critical** | Exact file:line, code snippet, full data-flow trace (source → transform → sink), and PoC exploit path |
| **high** | Exact file:line, code snippet, data-flow trace (at least source → sink) |
| **medium** | Exact file:line, code snippet |
| **low** | File reference and description |

### R3: Anti-Confirmation-Bias
- Do NOT anchor on the first issue found. Systematically evaluate ALL checklist dimensions.
- After completing the initial review pass, explicitly check: "Which dimensions did I NOT find issues in? Could I have missed something?"
- The adversarial pass exists to catch this. Trust the process.

### R4: Severity Accuracy
- CRITICAL: Exploitable vulnerability or data loss risk with confirmed attack path
- HIGH: Confirmed defect that will cause runtime failure or security weakness
- MEDIUM: Code quality issue that increases maintenance risk or has edge-case failure
- LOW: Style, readability, or minor improvement opportunity
- Never inflate severity. A missing comment is LOW, not MEDIUM.

---

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

### Phase 1: Structured Checklist Review
1. Read the entire diff/code before making any judgments
2. Evaluate each checklist item in order (SEC → ERR → PERF → STYLE → REQ → SYNTAX → EDGE → INTF → EXPORT → CONST)
3. For each item: PASS (with evidence), FAIL (with evidence + fix), or N/A (with brief reason)
4. Record which review dimensions were actually exercised

### Phase 2: Adversarial Second Opinion
1. All PASS/N/A items from Phase 1 are re-evaluated by a skeptical reviewer
2. Focus on: subtle bugs, missing edge cases, security oversights, optimistic assumptions
3. Any downgrade (PASS→FAIL) must include specific evidence the main reviewer missed

### Phase 3: Coverage Self-Check (NEW)
1. After Phases 1+2, compute a Coverage Matrix across all security dimensions
2. If any dimension has 0 items evaluated (all N/A), flag as potential blind spot
3. Dimensions: Injection, AuthN/AuthZ, Secrets, Input Validation, Error Info Leak, Race Condition, Resource Exhaustion, Crypto, Dependency, Business Logic

### Phase 4: Attack Chain Analysis (for security-sensitive reviews)
1. After individual findings are identified, analyse: can 2+ findings be COMBINED into an end-to-end attack path?
2. Example: Input validation bypass (SEC-003 FAIL) + SQL injection (SEC-001 FAIL) = authenticated SQLi attack chain
3. Document each chain as: Entry Point → Vulnerability 1 → Vulnerability 2 → Impact

### Phase 5: Self-Correction & Fix
1. All FAIL items are sent to the fix agent with severity context
2. Fix agent applies minimal, targeted changes
3. Re-review only the affected dimensions (not full re-review)

---

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

> The authoritative checklist is defined in `code-review-agent.js` (DEFAULT_CHECKLIST).
> This section provides supplementary guidance for each category.

### Security (SEC-001 to SEC-004)
- Always check: raw string concatenation in SQL/NoSQL queries, hardcoded secrets in source, unvalidated user input, missing auth checks
- For high-severity SEC findings: provide source→sink data-flow trace
- Consider attack chains: how can multiple SEC findings combine?

### Error Handling (ERR-001 to ERR-003)
- Every `await` must have error handling
- Empty catch blocks are never acceptable
- Error messages must not leak stack traces or internal paths to clients

### Performance (PERF-001 to PERF-003)
- N+1 queries: look for DB calls inside loops
- Memory leaks: look for event listeners added without cleanup
- Blocking calls: `fs.readFileSync` in async handlers is always a FAIL

### Code Style (STYLE-001 to STYLE-003)
- Dead code: commented-out blocks, unreachable branches
- Magic numbers: any literal that isn't self-explanatory needs a named constant
- Naming: single-letter vars (except `i`, `j`, `k` in loops) are FAIL

### Requirements (REQ-001 to REQ-002)
- Cross-check every acceptance criterion against the diff
- Flag any code that implements features NOT in requirements (scope creep)

### Syntax (SYNTAX-001 to SYNTAX-002)
- Broken JSDoc blocks are the #1 cause of cascading SyntaxErrors
- Always check for unclosed brackets, unterminated strings, mismatched template literals

### Edge Cases (EDGE-001 to EDGE-003)
- null/undefined guard: every function receiving external data
- Empty collections: `arr[0]` on empty array
- Numeric boundaries: 0, negative, MAX_SAFE_INTEGER

### Interface Contract (INTF-001 to INTF-002)
- Trace every property access on return values back to the producing function
- String comparisons: verify exact casing matches the constant definition

### Export Completeness (EXPORT-001 to EXPORT-002)
- Search for `require('./this-file')` across the codebase
- Check barrel files (index.js) for newly added exports

### Constant Consistency (CONST-001)
- If an enum/constant exists, all comparisons must use it (not raw strings)

---

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

### 1. Evidence-First Review
> "If you can't point to the exact line, you don't have a finding."
Every finding must be grounded in specific code. This prevents LLM hallucination and ensures actionable feedback.

### 2. Progressive Disclosure of Security Context
Only load language-specific security checklists when the tech stack is identified. For example:
- **Java**: Check for deserialization attacks (ObjectInputStream), JNDI injection, XXE in XML parsers
- **Python**: Check for pickle injection, eval() usage, template injection (Jinja2)
- **Go**: Check for goroutine leaks, unchecked error returns, race conditions
- **JavaScript/Node.js**: Check for prototype pollution, ReDoS, unsafe eval/Function constructor

### 3. Attack Chain Thinking
Individual vulnerabilities are often low-risk in isolation. The real danger is when they combine:
- Example: `SEC-003 (input validation bypass)` + `SEC-001 (SQL injection)` = **authenticated SQLi**
- Example: `ERR-003 (error info leak)` + `SEC-002 (exposed secrets)` = **credential harvesting**
Always ask: "If an attacker controls input X and exploits vulnerability Y, what's the maximum damage?"

### 4. Coverage-Driven Review
After the review, compute coverage: how many of the 10 security dimensions were actually tested?
- If a dimension shows 0 evaluated items, it's a blind spot, not proof of safety.
- Target: ≥80% dimension coverage for standard reviews, 100% for deep security audits.

### 5. Defect Chain Analysis (Beyond Security)
The "attack chain" pattern generalises to code quality:
- **Performance chain**: N+1 query + missing cache + large payload = cascading timeout
- **Reliability chain**: Missing error handling + silent failure + no monitoring = undetected outage
- **Maintenance chain**: Magic numbers + no comments + complex branching = unmaintainable code

---

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Report findings without file/line evidence | Every FAIL must cite exact location |
| Guess file paths that weren't in the diff | Only report on files actually reviewed |
| Inflate severity to seem thorough | Use the Severity Accuracy scale (R4) |
| Skip dimensions that "probably don't apply" | Systematically evaluate ALL dimensions |
| Report individual vulnerabilities without considering combinations | Analyse attack chains after individual findings |
| Accept "// TODO: add validation" as a PASS | TODOs for security items are always FAIL |
| Provide vague fix instructions ("improve error handling") | Give concrete fix: "Wrap line 42 `await fetch()` in try/catch and return 500 on failure" |
| Focus only on security, ignore code quality | Review ALL dimensions: SEC + ERR + PERF + STYLE + REQ + SYNTAX + EDGE |

---

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

- When the task includes keywords like "security", "audit", "vulnerability", "penetration", load the full attack-chain analysis phase
- When the task type is "bugfix", prioritise ERR and EDGE dimensions over SEC and STYLE
- When the project type is "frontend", deprioritise SQL injection checks but elevate XSS and CSRF checks
- When the diff is small (<50 lines), a quick review (1 round, no adversarial) is sufficient
- When the diff touches auth/payment/encryption code, always run deep review (max rounds + adversarial)

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation (empty shell) |
| v2.0.0 | 2026-03-18 | Full population: Rules (anti-hallucination, confidence tiers, anti-bias, severity), SOP (5 phases incl. coverage check + attack chain), Checklist guidance, Best Practices (evidence-first, progressive disclosure, attack chain thinking, coverage-driven, defect chain), Anti-Patterns, Context Hints. Inspired by code-audit Skill article analysis. |
