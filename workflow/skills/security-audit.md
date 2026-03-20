---
name: security-audit
version: 1.0.0
type: domain-skill
domains: [security, audit, review]
dependencies: [code-review]
load_level: task
max_tokens: 1200
triggers:
  keywords: [security, audit, vulnerability, penetration, cve, owasp, injection, xss, csrf, auth, authentication, authorization, encrypt, decrypt, secret, token, credential]
  roles: [developer, architect, tester]
description: "Security audit skill covering OWASP Top 10, language-specific vulnerability patterns, supply chain security, and threat modeling"
---
# Skill: security-audit

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Comprehensive security audit covering OWASP Top 10, language-specific vulnerability patterns, supply chain security, and threat modeling
> **Domains**: security, audit, review

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

### R1: Threat Model First
Before auditing code, establish a threat model:
1. **Assets**: What data or resources are we protecting?
2. **Threat Actors**: Who might attack (external hacker, insider, automated bot)?
3. **Attack Surface**: What entry points exist (API endpoints, file uploads, WebSocket, CLI args)?
4. **Trust Boundaries**: Where does trusted data become untrusted?

Without a threat model, security review becomes a checklist exercise that misses context-specific risks.

### R2: Defense in Depth
Never rely on a single security control. Layer defenses:
- Input validation at the boundary
- Parameterised queries at the data layer
- Output encoding at the presentation layer
- AuthN/AuthZ at the middleware layer
- Encryption at the transport and storage layer

### R3: Principle of Least Privilege
Every component, service, and user should have the minimum permissions necessary:
- Database users should have only the permissions they need (no `GRANT ALL`)
- API keys should be scoped to specific operations
- Service accounts should not have admin access
- File system permissions should be restrictive by default

### R4: Fail Secure
When errors occur, the system must fail to a secure state:
- Authentication failures → deny access (never grant)
- Parsing errors → reject input (never pass through)
- Service unavailable → return error (never bypass checks)

---

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

### Phase 1: Static Analysis Checklist
Scan the codebase for known vulnerability patterns:

**OWASP Top 10 (2021) Mapping**:

| # | Category | What to Look For |
|---|----------|-----------------|
| A01 | Broken Access Control | Missing auth checks on endpoints, IDOR (Insecure Direct Object Reference), path traversal |
| A02 | Cryptographic Failures | Weak algorithms (MD5/SHA1 for passwords), hardcoded keys, missing TLS, improper certificate validation |
| A03 | Injection | SQL/NoSQL injection, OS command injection, LDAP injection, XSS, template injection |
| A04 | Insecure Design | Missing rate limiting, no account lockout, business logic flaws |
| A05 | Security Misconfiguration | Debug mode in production, default credentials, overly permissive CORS, unnecessary features enabled |
| A06 | Vulnerable Components | Known CVEs in dependencies, outdated packages, unmaintained libraries |
| A07 | Auth Failures | Weak password policies, missing MFA, session fixation, improper token handling |
| A08 | Data Integrity Failures | Missing integrity checks on CI/CD pipeline, unsigned updates, deserialization of untrusted data |
| A09 | Logging Failures | Sensitive data in logs, insufficient audit trail, log injection |
| A10 | SSRF | Unvalidated URLs in server-side requests, internal network access from user input |

### Phase 2: Language-Specific Vulnerability Patterns

**JavaScript / Node.js**:
- Prototype pollution (`__proto__`, `constructor.prototype`)
- ReDoS (Regular Expression Denial of Service) in user-supplied regex
- `eval()`, `Function()`, `vm.runInNewContext()` with user input
- Unsafe deserialization (`JSON.parse` is safe; `node-serialize` is not)
- Path traversal in file operations (`path.join` without sanitization)
- Event loop blocking in security-critical paths

**Python**:
- `pickle.loads()` on untrusted data (arbitrary code execution)
- `eval()`, `exec()`, `__import__()` with user input
- Template injection (Jinja2 `|safe`, Django `{% autoescape off %}`)
- YAML `load()` vs `safe_load()` (arbitrary code execution)
- SQL injection in raw queries (even with ORMs when using `.raw()` or `.extra()`)

**Go**:
- Goroutine leaks (missing context cancellation)
- Unchecked error returns (especially in security paths: `if err != nil` must not be skipped)
- Race conditions on shared state (use `-race` flag)
- TLS certificate verification disabled (`InsecureSkipVerify: true`)
- Integer overflow in slice length calculations

**Java**:
- Deserialization attacks (`ObjectInputStream.readObject()`)
- JNDI injection (Log4Shell pattern: `${jndi:ldap://...}`)
- XXE in XML parsers (disable external entities)
- SQL injection in JPQL/HQL (use parameterised queries)
- Reflection-based attacks (unrestricted `Class.forName()`)

### Phase 3: Supply Chain Security
1. Run dependency vulnerability scan (`npm audit`, `pip audit`, `go vuln check`)
2. Check for dependency confusion (private vs public package names)
3. Verify lockfile integrity (lockfile should be committed and unchanged)
4. Check for typosquatting risks (similar-named packages)
5. Review post-install scripts in new dependencies

### Phase 4: Secrets Management Audit
1. Scan for hardcoded secrets (API keys, passwords, tokens, private keys)
2. Check `.gitignore` for sensitive files (`.env`, `*.pem`, `*.key`)
3. Verify secrets are loaded from environment variables or secret managers
4. Check git history for accidentally committed secrets (`git log -p | grep -i password`)
5. Ensure secret rotation strategy exists for critical credentials

---

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

### Input Validation
- [ ] All user inputs validated at the trust boundary (type, length, format, range)
- [ ] Allowlist validation preferred over denylist
- [ ] File upload: type, size, and content validation (not just extension)
- [ ] URL validation: protocol allowlist (http/https only), no internal network access

### Authentication & Authorization
- [ ] Password hashing uses bcrypt/scrypt/argon2 (NOT MD5/SHA1/SHA256)
- [ ] Session tokens are cryptographically random and sufficiently long
- [ ] JWT tokens have proper expiration, audience, and issuer validation
- [ ] Rate limiting on authentication endpoints
- [ ] Account lockout after N failed attempts

### Data Protection
- [ ] Sensitive data encrypted at rest (AES-256 minimum)
- [ ] TLS 1.2+ enforced for all network communication
- [ ] PII data is not logged or stored unnecessarily
- [ ] Database connections use parameterised queries exclusively

### Error Handling
- [ ] Error messages do not expose internal implementation details
- [ ] Stack traces are not returned to clients in production
- [ ] Security-relevant errors are logged with context (who, what, when, from where)

---

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

### 1. Secure by Default
Design systems where the default configuration is secure. Developers should have to explicitly opt OUT of security, not opt IN.
- Default: strict CSP headers → developer loosens for specific routes
- Default: all endpoints require auth → developer marks specific ones as public
- Default: input rejected → developer defines validation rules to accept

### 2. Security as Code
Codify security rules so they are enforced automatically:
- Pre-commit hooks: scan for secrets (`gitleaks`, `truffleHog`)
- CI pipeline: dependency vulnerability scan, SAST (static analysis)
- Runtime: WAF rules, rate limiting, anomaly detection
- Infrastructure: security groups as code, least-privilege IAM policies

### 3. Assume Breach
Design systems assuming the attacker is already inside:
- Internal services authenticate to each other (zero-trust)
- Database connections are encrypted even within VPC
- Logs are shipped to an immutable store
- Blast radius is minimised (service isolation, network segmentation)

---

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Validate input only on the client side | Validate on server side (client-side is UX, not security) |
| Use MD5/SHA1 for password hashing | Use bcrypt/scrypt/argon2 with per-user salt |
| Store secrets in source code or config files | Use environment variables or secret managers (Vault, AWS Secrets Manager) |
| Disable security headers "because they break the app" | Fix the app to work WITH security headers |
| Log full request/response bodies | Log only necessary metadata; mask sensitive fields |
| Trust JWT tokens without verifying signature | Always verify signature, expiration, issuer, and audience |
| Use `SELECT *` in database queries | Select only needed columns (reduces information exposure) |

---

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

- When the project handles **payment data**: activate PCI-DSS compliance checks (card data encryption, tokenisation, audit logging)
- When the project handles **health data**: activate HIPAA compliance checks (PHI encryption, access controls, audit trails)
- When the project handles **user authentication**: activate OWASP Authentication Cheat Sheet checks
- When the project is a **public API**: activate API security checks (rate limiting, API key rotation, CORS, input validation)
- When the project uses **containers**: check for root user, secret injection, image vulnerability scanning
- When reviewing a **small diff** (<30 lines): focus on input validation and auth checks only
- When reviewing a **large diff** (>200 lines): run full Phase 1-4 audit

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-19 | Initial creation. Comprehensive security audit skill covering OWASP Top 10, language-specific patterns, supply chain security, secrets management, and threat modeling. Inspired by ECC security-reviewer patterns, adapted for WorkFlowAgent framework. |