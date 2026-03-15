/**
 * ArchitectureReviewAgent – Checklist-based Architecture Review
 *
 * Evaluates whether the architecture is CORRECT and REASONABLE by checking
 * it against a structured checklist of architecture best practices.
 *
 * This solves the key limitation of SelfCorrectionEngine (regex-based):
 *   - Can judge whether architecture decisions are JUSTIFIED (not just worded clearly)
 *   - Can detect logical flaws in the design (e.g. HA requirement + single instance)
 *   - Can verify that non-functional requirements (perf, security, scalability) are addressed
 *
 * Review dimensions (checklist categories):
 *   1. Decision Justification – every major tech choice has a stated rationale
 *   2. Scalability            – horizontal scaling, stateless design, bottleneck analysis
 *   3. Reliability            – no single point of failure, failover, data durability
 *   4. Security               – auth/authz design, data encryption, attack surface
 *   5. Observability          – logging, metrics, tracing, alerting
 *   6. Requirements Alignment – architecture covers all functional + non-functional requirements
 *   7. Consistency            – no internal contradictions between sections
 *
 * Self-correction loop:
 *   architecture.md → checklist review → issues found → refinement prompt →
 *   ArchitectAgent re-generates → re-review → loop until clean or maxRounds
 *
 * Output:
 *   - Corrected architecture.md (written back)
 *   - output/architecture-review.md (full review report)
 *   - riskNotes[] for Orchestrator risk summary
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Architecture Checklist ───────────────────────────────────────────────────

/**
 * Default architecture checklist.
 * Each item: id, category, severity, description, hint, evaluationGuide.
 *
 * evaluationGuide: tells the LLM HOW to evaluate this item (what to look for).
 * This is the key difference from CodeReviewAgent – architecture items require
 * semantic reasoning, not just pattern matching.
 */
const ARCHITECTURE_CHECKLIST = [
  // ── Decision Justification ────────────────────────────────────────────────
  {
    id: 'ARCH-001', category: 'Decision Justification', severity: 'high',
    description: 'Every major technology choice has a stated rationale',
    hint: 'Database, framework, messaging system, caching layer choices must explain WHY.',
    evaluationGuide: 'For each major technology mentioned (DB, cache, queue, framework), check if the document explains WHY it was chosen over alternatives. A choice without justification is a red flag.',
  },
  {
    id: 'ARCH-002', category: 'Decision Justification', severity: 'medium',
    description: 'Trade-offs of the chosen approach are acknowledged',
    hint: 'Every architectural decision has trade-offs. They should be explicitly stated.',
    evaluationGuide: 'Check if the document acknowledges the downsides or trade-offs of key decisions. A document that only lists benefits without trade-offs is incomplete.',
  },
  {
    id: 'ARCH-003', category: 'Decision Justification', severity: 'medium',
    description: 'Rejected alternatives are briefly mentioned with reasons',
    hint: 'Knowing what was NOT chosen and why helps future maintainers.',
    evaluationGuide: 'Check if the document mentions at least one alternative that was considered and rejected, with a brief reason. This is optional but strongly recommended for major decisions.',
  },

  // ── Scalability ───────────────────────────────────────────────────────────
  {
    id: 'ARCH-004', category: 'Scalability', severity: 'high',
    description: 'Horizontal scaling strategy is defined for stateful components',
    hint: 'Databases, caches, and session stores need explicit sharding/replication strategies.',
    evaluationGuide: 'Identify all stateful components (DB, cache, file storage). For each, check if the document describes how it scales horizontally (sharding, read replicas, partitioning). Stateless services that can simply add instances are fine without explicit strategy.',
  },
  {
    id: 'ARCH-005', category: 'Scalability', severity: 'medium',
    description: 'Bottlenecks and capacity limits are identified',
    hint: 'Every system has a bottleneck. Identifying it early prevents surprises.',
    evaluationGuide: 'Check if the document identifies the expected bottleneck (e.g. DB write throughput, network bandwidth, CPU). If the system has performance requirements, verify the architecture addresses them.',
  },
  {
    id: 'ARCH-006', category: 'Scalability', severity: 'medium',
    description: 'Stateless service design is maintained where applicable',
    hint: 'Stateless services scale trivially. Session state should be externalised.',
    evaluationGuide: 'Check if application services are designed to be stateless (no in-memory session state). If session state exists, verify it is stored in an external store (Redis, DB) not in the service instance.',
  },

  // ── Reliability ───────────────────────────────────────────────────────────
  {
    id: 'ARCH-007', category: 'Reliability', severity: 'high',
    description: 'No single point of failure (SPOF) for critical paths',
    hint: 'Any component that, if it fails, takes down the whole system is a SPOF.',
    evaluationGuide: 'Identify all components in the critical path (the path a user request takes). For each, check if there is redundancy or failover. A single-instance DB with no replica is a SPOF. A load balancer with a single backend is a SPOF.',
  },
  {
    id: 'ARCH-008', category: 'Reliability', severity: 'high',
    description: 'Data durability and backup strategy is defined',
    hint: 'How is data protected against loss? Backup frequency, retention, restore procedure.',
    evaluationGuide: 'Check if the document describes: (1) how data is persisted durably, (2) backup frequency and retention policy, (3) how to restore from backup. If the system stores user data, this is mandatory.',
  },
  {
    id: 'ARCH-009', category: 'Reliability', severity: 'medium',
    description: 'Failure modes and recovery strategies are described',
    hint: 'What happens when component X fails? Circuit breaker, retry, graceful degradation.',
    evaluationGuide: 'Check if the document describes what happens when key components fail (DB down, cache miss, external API timeout). Look for: circuit breakers, retry policies, fallback strategies, graceful degradation.',
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'ARCH-010', category: 'Security', severity: 'high',
    description: 'Authentication and authorisation architecture is defined',
    hint: 'Who can access what? How is identity verified? How are permissions enforced?',
    evaluationGuide: 'Check if the document describes: (1) how users/services authenticate (JWT, OAuth, API key), (2) how authorisation is enforced (RBAC, ABAC, middleware), (3) where auth checks happen in the request flow.',
  },
  {
    id: 'ARCH-011', category: 'Security', severity: 'high',
    description: 'Sensitive data handling is addressed (encryption at rest and in transit)',
    hint: 'PII, credentials, payment data must be encrypted. TLS for all external communication.',
    evaluationGuide: 'Check if the document addresses: (1) TLS/HTTPS for all external communication, (2) encryption at rest for sensitive data (PII, credentials, payment info), (3) secret management (no hardcoded secrets, use vault/env vars).',
  },
  {
    id: 'ARCH-012', category: 'Security', severity: 'medium',
    description: 'Attack surface is minimised (principle of least privilege)',
    hint: 'Services should only have access to what they need. Expose minimum ports/APIs.',
    evaluationGuide: 'Check if the document applies least privilege: (1) services only have DB access they need, (2) internal services are not exposed to the internet, (3) API endpoints are protected appropriately.',
  },

  // ── Observability ─────────────────────────────────────────────────────────
  {
    id: 'ARCH-013', category: 'Observability', severity: 'medium',
    description: 'Logging strategy is defined (what to log, where to store)',
    hint: 'Structured logs, log levels, centralised log aggregation.',
    evaluationGuide: 'Check if the document describes: (1) what events are logged (errors, key business events), (2) log format (structured JSON preferred), (3) where logs are stored/aggregated (ELK, CloudWatch, etc.).',
  },
  {
    id: 'ARCH-014', category: 'Observability', severity: 'medium',
    description: 'Key metrics and alerting thresholds are identified',
    hint: 'What metrics indicate the system is healthy? What triggers an alert?',
    evaluationGuide: 'Check if the document identifies: (1) key health metrics (latency p99, error rate, throughput), (2) alerting thresholds, (3) monitoring tool (Prometheus, Datadog, etc.). For simple systems, basic health checks are acceptable.',
  },

  // ── Requirements Alignment ────────────────────────────────────────────────
  {
    id: 'ARCH-015', category: 'Requirements Alignment', severity: 'high',
    description: 'All non-functional requirements (NFRs) are addressed in the architecture',
    hint: 'Performance, availability, scalability, security NFRs must map to architectural decisions.',
    evaluationGuide: 'If a requirements document is provided, check each NFR (performance targets, availability SLA, security requirements) and verify the architecture explicitly addresses it. An NFR without a corresponding architectural decision is a gap.',
  },
  {
    id: 'ARCH-016', category: 'Requirements Alignment', severity: 'high',
    description: 'Architecture supports all core functional requirements',
    hint: 'Every major feature in requirements.md must have a corresponding component in the architecture.',
    evaluationGuide: 'If a requirements document is provided, check each major functional requirement and verify there is a corresponding component, service, or data flow in the architecture. Missing components are gaps.',
  },

  // ── Consistency ───────────────────────────────────────────────────────────
  {
    id: 'ARCH-017', category: 'Consistency', severity: 'high',
    description: 'No internal contradictions between architecture sections',
    hint: 'Section A says stateless, Section B stores session in memory – contradiction.',
    evaluationGuide: 'Read the document holistically. Look for contradictions: (1) a component described as stateless but storing state, (2) HA requirement but single-instance deployment, (3) microservices architecture but shared database, (4) async processing described but synchronous flow shown.',
  },
  {
    id: 'ARCH-018', category: 'Consistency', severity: 'medium',
    description: 'Diagrams and text descriptions are consistent',
    hint: 'If a diagram shows component X, the text should describe it and vice versa.',
    evaluationGuide: 'Check if components mentioned in text are also shown in diagrams (if any), and vice versa. Inconsistencies between diagrams and text descriptions indicate incomplete documentation.',
  },
];

// ─── Prompt Builders ──────────────────────────────────────────────────────────

/**
 * Builds the architecture checklist review prompt.
 * Uses evaluationGuide to give LLM precise instructions per item.
 *
 * @param {object[]} checklist
 * @param {string}   archContent
 * @param {string}   [requirementText]
 * @returns {string}
 */
function buildArchReviewPrompt(checklist, archContent, requirementText = '') {
  const itemList = checklist
    .map(item => [
      `- [${item.id}] (${item.severity}) ${item.description}`,
      `  Hint: ${item.hint}`,
      `  How to evaluate: ${item.evaluationGuide}`,
    ].join('\n'))
    .join('\n\n');

  const reqSection = requirementText
    ? `## Requirements Document\n\n${requirementText}\n\n`
    : '';

  return [
    `You are a senior software architect performing a structured architecture review.`,
    ``,
    `## Task`,
    `Evaluate the architecture document below against each checklist item.`,
    `For each item, determine: PASS, FAIL, or N/A (not applicable to this architecture).`,
    ``,
    `## Important Evaluation Rules`,
    ``,
    `- PASS: The item is clearly and adequately addressed in the document.`,
    `- FAIL: The item is missing, inadequate, or contradicted in the document.`,
    `- N/A: The item genuinely does not apply to this system (e.g. no user data → no backup needed).`,
    `- When in doubt between PASS and N/A, prefer N/A over FAIL to avoid false positives.`,
    `- A FAIL must have a specific, actionable fixInstruction.`,
    ``,
    `## Checklist`,
    ``,
    itemList,
    ``,
    reqSection,
    `## Architecture Document`,
    ``,
    archContent,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element must have:`,
    `- "id": checklist item ID (e.g. "ARCH-001")`,
    `- "result": "PASS" | "FAIL" | "N/A"`,
    `- "finding": one sentence. If FAIL, describe the specific gap or issue.`,
    `- "fixInstruction": if FAIL, one concrete instruction for the architect to fix it. Otherwise null.`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

/**
 * Builds an architect refinement prompt from failed checklist items.
 *
 * For long documents (>4000 chars), uses a patch-based approach:
 * asks LLM to return only the new/modified sections rather than the full document,
 * then merges them back. This avoids LLM output truncation on large documents.
 *
 * @param {string}   originalContent
 * @param {object[]} failures
 * @returns {{ prompt: string, mode: 'full' | 'patch' }}
 */
function buildArchFixPrompt(originalContent, failures) {
  const fixList = failures
    .map((f, i) => `${i + 1}. [${f.id}] [${f.severity?.toUpperCase() ?? 'UNKNOWN'}] ${f.finding}\n   Fix: ${f.fixInstruction || 'Please review and fix this missing item.'}`)
    .join('\n\n');

  // For long documents, use patch mode to avoid LLM output truncation
  const LONG_DOC_THRESHOLD = 4000;
  const isLongDoc = originalContent.length > LONG_DOC_THRESHOLD;

  if (isLongDoc) {
    const prompt = [
      `You are a Software Architecture Agent performing a self-correction pass.`,
      ``,
      `The following issues were found in your architecture document during a checklist review:`,
      ``,
      `## Issues to Fix`,
      ``,
      fixList,
      ``,
      `## Instructions`,
      ``,
      `The architecture document is long. Instead of rewriting the entire document,`,
      `return ONLY the new or modified sections needed to fix the issues above.`,
      ``,
      `Format your response as a series of section patches:`,
      ``,
      `### PATCH: <Section Heading>`,
      `<complete new content for this section>`,
      ``,
      `### PATCH: <Another Section Heading>`,
      `<complete new content for this section>`,
      ``,
      `Rules:`,
      `- Only include sections that need to be added or modified.`,
      `- Use the exact section heading from the original document if modifying an existing section.`,
      `- If adding a new section, use a clear descriptive heading.`,
      `- Be specific and concrete. Vague statements are not acceptable.`,
      `- Do NOT include sections that are already correct.`,
      ``,
      `## Original Architecture Document (for reference)`,
      ``,
      originalContent,
    ].join('\n');
    return { prompt, mode: 'patch' };
  }

  const prompt = [
    `You are a Software Architecture Agent performing a self-correction pass.`,
    ``,
    `The following issues were found in your architecture document during a checklist review:`,
    ``,
    `## Issues to Fix`,
    ``,
    fixList,
    ``,
    `## Instructions`,
    ``,
    `Rewrite the architecture document below to fix ALL of the issues listed above.`,
    `- Do NOT remove existing content that is correct.`,
    `- Add missing sections, justifications, or strategies as needed.`,
    `- Be specific and concrete. Vague statements like "we will handle this" are not acceptable.`,
    `- Return the complete revised architecture document.`,
    ``,
    `## Original Architecture Document`,
    ``,
    originalContent,
  ].join('\n');
  return { prompt, mode: 'full' };
}

/**
 * Applies patch-mode LLM response back to the original document.
 * Finds each "### PATCH: <heading>" block and replaces or appends the section.
 *
 * @param {string} originalContent
 * @param {string} patchResponse
 * @returns {string}
 */
function applyArchPatches(originalContent, patchResponse) {
  const patchRegex = /###\s+PATCH:\s+(.+?)\n([\s\S]*?)(?=###\s+PATCH:|$)/g;
  let result = originalContent;
  let match;

  while ((match = patchRegex.exec(patchResponse)) !== null) {
    const heading = match[1].trim();
    const newContent = match[2].trim();

    // Strip any leading '#' characters from the heading to get the plain title
    // so we can match it regardless of the heading level used in the original document
    const plainHeading = heading.replace(/^#+\s*/, '');
    const escapedHeading = plainHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Match any heading level (one or more '#') followed by the heading text,
    // then capture everything until the next same-or-higher-level heading or end of document.
    // Use greedy [\s\S]* (not lazy) so the match extends to the LAST possible position
    // before the next heading – avoids the lazy+zero-width-lookahead early-exit bug.
    // N39 fix: the original code used [\s\S]*? (non-greedy / lazy), which caused the regex
    // to stop at the FIRST sub-heading (e.g. ### Sub-section) inside the target section,
    // leaving old sub-heading content intact and only partially applying the patch.
    // Greedy [\s\S]* correctly consumes the entire section body including sub-headings.
    // P7 fix: use `(?=\n#+\s|$)` instead of `(?=\n#+\s|\s*$)` – the `\s*$` variant
    // matches trailing whitespace at end-of-string, which can cause the regex to
    // over-consume and replace content beyond the target section boundary.
    const sectionRegex = new RegExp(
      `(#+\\s+${escapedHeading}[^\\n]*)\\n[\\s\\S]*(?=\\n#+\\s|$)`,
      'i'
    );

    if (sectionRegex.test(result)) {
      // Replace existing section, preserving the original heading line
      result = result.replace(sectionRegex, `$1\n\n${newContent}\n`);
    } else {
      // Section not found – append as a new ## section at the end
      result = result.trimEnd() + `\n\n## ${plainHeading}\n\n${newContent}\n`;
    }
  }

  return result;
}
// ─── JSON Extractor (shared utility) ─────────────────────────────────────────

function extractJsonArray(response) {
  const stripped = response.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = stripped.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

// ─── ArchitectureReviewAgent ──────────────────────────────────────────────────

class ArchitectureReviewAgent {
  /**
   * @param {Function} llmCall   - async (prompt: string) => string
   * @param {object}   [options]
   * @param {number}   [options.maxRounds=2]        - Max self-correction rounds
   * @param {boolean}  [options.verbose=true]
   * @param {object[]} [options.extraChecklist=[]]  - Additional checklist items
   * @param {string}   [options.outputDir]          - Where to write architecture-review.md
   * @param {object}   [options.investigationTools] - Optional tools for deep investigation
   *   (search, readSource, queryExperience) – same interface as SelfCorrectionEngine
   */
  constructor(llmCall, {
    maxRounds = 2,
    verbose = true,
    extraChecklist = [],
    outputDir = null,
    investigationTools = null,
  } = {}) {
    if (typeof llmCall !== 'function') {
      throw new Error('[ArchitectureReviewAgent] llmCall must be a function');
    }
    this.llmCall = llmCall;
    this.maxRounds = maxRounds;
    this.verbose = verbose;
    this.checklist = [...ARCHITECTURE_CHECKLIST, ...extraChecklist];
    this.outputDir = outputDir || path.resolve(__dirname, '..', 'output');
    this.investigationTools = investigationTools || null;
  }

  /**
   * Runs the full review + self-correction loop on architecture.md.
   *
   * @param {string} archPath         - Path to output/architecture.md
   * @param {string} [requirementPath] - Path to output/requirements.md (optional)
   * @returns {Promise<ArchReviewResult>}
   */
  async review(archPath, requirementPath = null) {
    this._log(`\n╔══════════════════════════════════════════════════════════╗`);
    this._log(`║  🏛️  ARCHITECTURE REVIEW  –  Checklist-based Analysis    ║`);
    this._log(`╚══════════════════════════════════════════════════════════╝`);

    if (!fs.existsSync(archPath)) {
      this._log(`[ArchReview] ⚠️  architecture.md not found at: ${archPath}. Skipping.`);
      return this._emptyResult('architecture.md not found');
    }

    let currentContent = fs.readFileSync(archPath, 'utf-8');
    const requirementText = (requirementPath && fs.existsSync(requirementPath))
      ? fs.readFileSync(requirementPath, 'utf-8')
      : '';

    const history = [];
    let round = 0;
    let lastReviewResults = [];

    while (round < this.maxRounds) {
      round++;
      this._log(`\n[ArchReview] 🔄 Round ${round}/${this.maxRounds}: Running checklist review...`);

      const reviewResults = await this._runReview(currentContent, requirementText);
      lastReviewResults = reviewResults;

      const failures = reviewResults.filter(r => r.result === 'FAIL');
      const passes   = reviewResults.filter(r => r.result === 'PASS');
      const nas      = reviewResults.filter(r => r.result === 'N/A');

      this._log(`[ArchReview] 📊 Round ${round}: ${passes.length} PASS / ${failures.length} FAIL / ${nas.length} N/A`);

      if (failures.length === 0) {
        this._log(`[ArchReview] ✅ All checklist items passed. Architecture review complete.\n`);
        break;
      }

      this._log(`[ArchReview] ❌ Failures (${failures.length}):`);
      failures.forEach(f => this._log(`  • [${f.id}] ${f.finding}`));

      if (round >= this.maxRounds) {
        this._log(`[ArchReview] ⚠️  Max rounds reached. Remaining issues will be recorded as risks.`);
        break;
      }

      // Self-correction: optionally run deep investigation before fix prompt
      // so the architect LLM has experience-store context when rewriting.
      let contentForFix = currentContent;
      if (this.investigationTools) {
        const highFailures = failures.filter(f => {
          const item = this.checklist.find(c => c.id === f.id);
          return item?.severity === 'high';
        });
        if (highFailures.length > 0) {
          this._log(`[ArchReview] 🔬 Running deep investigation for ${highFailures.length} high-severity failure(s)...`);
          const findings = [];
          for (const f of highFailures) {
            if (typeof this.investigationTools.search === 'function') {
              try {
                const r = await this.investigationTools.search(`${f.id} architecture ${f.finding}`);
                if (r) findings.push(`### Experience for [${f.id}]\n${r}`);
              } catch (_) { /* ignore */ }
            }
            if (typeof this.investigationTools.queryExperience === 'function') {
              try {
                const r = await this.investigationTools.queryExperience('architecture');
                if (r) findings.push(`### Architecture Experience Context\n${r}`);
              } catch (_) { /* ignore */ }
            }
          }
          if (findings.length > 0) {
            contentForFix = currentContent + '\n\n---\n## Investigation Findings\n\n' + findings.join('\n\n');
            this._log(`[ArchReview] 📋 ${findings.length} finding(s) injected into fix context.`);
          }
        }
      }

      // Self-correction: send fix prompt to architect LLM
      this._log(`[ArchReview] 🔧 Sending fix prompt to ArchitectAgent...`);
      const { prompt: fixPrompt, mode: fixMode } = buildArchFixPrompt(contentForFix, failures.map(f => ({
        ...f,
        severity: this.checklist.find(c => c.id === f.id)?.severity ?? 'medium',
      })));

      if (fixMode === 'patch') {
        this._log(`[ArchReview] 📄 Document is long (>${4000} chars). Using patch mode to avoid truncation.`);
      }

      let fixedContent = currentContent;
      try {
        const rawFixed = await this.llmCall(fixPrompt);
        // Strip markdown fences if present
        const mdMatch = rawFixed.match(/```(?:markdown|md)?\n([\s\S]*?)```/);
        const candidate = mdMatch ? mdMatch[1].trim() : rawFixed.trim();

        if (fixMode === 'patch') {
          // Apply patch-mode response: merge sections back into original
          fixedContent = applyArchPatches(currentContent, candidate);
          this._log(`[ArchReview] ✅ Patch mode: applied ${(candidate.match(/###\s+PATCH:/g) || []).length} patch(es).`);
        } else {
          // Full rewrite mode: validate output is not truncated
          if (candidate.length >= currentContent.length * 0.7) {
            fixedContent = candidate;
          } else {
            this._log(`[ArchReview] ⚠️  Fix LLM output too short (${candidate.length} vs ${currentContent.length}). Possible truncation. Keeping current content.`);
          }
        }
      } catch (err) {
        this._log(`[ArchReview] ❌ Fix LLM call failed: ${err.message}. Keeping current content.`);
        break;
      }

      history.push({
        round,
        failures: failures.map(f => ({ id: f.id, finding: f.finding })),
        before: currentContent,
        after: fixedContent,
      });

      currentContent = fixedContent;
      this._log(`[ArchReview] ✏️  Round ${round} fix applied. Re-reviewing...`);
    }

    // Write corrected architecture back
    if (history.length > 0) {
      fs.writeFileSync(archPath, currentContent, 'utf-8');
      this._log(`[ArchReview] 💾 Corrected architecture written back to: ${archPath}`);
    }

    // Build final result
    const finalFailures = lastReviewResults.filter(r => r.result === 'FAIL');
    // N55 fix: MISSING items (LLM did not return them or LLM call failed) are treated
    // as failures in the final result so they appear in riskNotes and are not silently
    // excluded from the pass rate. This mirrors the N50 fix in CodeReviewAgent.
    const finalMissing  = lastReviewResults.filter(r => r.result === 'MISSING');
    const allFailed     = [...finalFailures, ...finalMissing];
    const highFailures  = allFailed.filter(f => {
      const item = this.checklist.find(c => c.id === f.id);
      return item?.severity === 'high';
    });

    const riskNotes = allFailed.map(f => {
      const item = this.checklist.find(c => c.id === f.id);
      return `[ArchReview] ${f.id} (${item?.severity ?? 'unknown'}) ${f.finding}`;
    });

    const result = {
      rounds: round,
      totalItems: this.checklist.length,
      passed: lastReviewResults.filter(r => r.result === 'PASS').length,
      failed: allFailed.length,
      na: lastReviewResults.filter(r => r.result === 'N/A').length,
      missing: finalMissing.length,
      failures: allFailed,
      history,
      riskNotes,
      needsHumanReview: highFailures.length > 0,
      skipped: false,
    };

    // Write review report
    const reportPath = path.join(this.outputDir, 'architecture-review.md');
    const report = this.formatReport(result);
    fs.writeFileSync(reportPath, report, 'utf-8');
    this._log(`[ArchReview] 📄 Review report written to: ${reportPath}`);

    return result;
  }

  /**
   * Runs a single checklist review pass via LLM.
   *
   * @param {string} archContent
   * @param {string} requirementText
   * @returns {Promise<object[]>}
   */
  async _runReview(archContent, requirementText) {
    const prompt = buildArchReviewPrompt(this.checklist, archContent, requirementText);
    let response;
    try {
      response = await this.llmCall(prompt);
    } catch (err) {
      this._log(`[ArchReview] ❌ Review LLM call failed: ${err.message}`);
      // N55 fix: LLM call failure → mark all items as MISSING (not N/A).
      // N/A means "not applicable to this architecture", which is semantically wrong
      // for a failure case. MISSING items are treated as failures in the pass-rate
      // calculation so passRate is not artificially inflated.
      return this.checklist.map(item => ({
        id: item.id,
        result: 'MISSING',
        finding: `LLM call failed: ${err.message}`,
        fixInstruction: null,
      }));
    }

    const parsed = extractJsonArray(response);
    if (!parsed) {
      this._log(`[ArchReview] ⚠️  Could not parse LLM review response. Treating all as MISSING.`);
      // N55 fix: parse failure → MISSING, not N/A (same reasoning as above).
      return this.checklist.map(item => ({
        id: item.id,
        result: 'MISSING',
        finding: 'LLM response parse error',
        fixInstruction: null,
      }));
    }

    // N55 fix: items the LLM did not return are MISSING (not evaluated), NOT N/A
    // (not applicable). Marking them N/A incorrectly excludes them from the passRate
    // denominator, making passRate artificially high.
    const resultMap = new Map(parsed.map(r => [r.id, r]));
    return this.checklist.map(item => resultMap.get(item.id) ?? {
      id: item.id,
      result: 'MISSING',
      finding: 'Not evaluated by LLM (response did not include this item)',
      fixInstruction: null,
    });
  }

  /**
   * Formats the review result as a Markdown report.
   * @param {ArchReviewResult} result
   * @returns {string}
   */
  formatReport(result) {
    if (result.skipped) {
      return `# Architecture Review Report\n\n> Skipped: ${result.skipReason}\n`;
    }

    // N26 fix: guard against division by zero when all items are N/A
    // N55 fix: MISSING items are NOT N/A – they are counted as failures (included in
    // result.failed), so they must NOT be subtracted from the evaluatedItems denominator.
    // Only true N/A items (explicitly marked by LLM as not applicable) are excluded.
    const evaluatedItems = result.totalItems - result.na;
    const passRate = evaluatedItems > 0
      ? Math.round((result.passed / evaluatedItems) * 100)
      : 100;
    const statusIcon = result.failed === 0 ? '✅' : result.needsHumanReview ? '❌' : '⚠️';
    const missingCount = result.missing ?? 0;

    const lines = [
      `# Architecture Review Report`,
      ``,
      `> Auto-generated by ArchitectureReviewAgent. Rounds: ${result.rounds}.`,
      ``,
      `## Summary`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total Checklist Items | ${result.totalItems} |`,
      `| Passed | ✅ ${result.passed} |`,
      `| Failed | ❌ ${result.failed} |`,
      `| N/A | ➖ ${result.na} |`,
      ...(missingCount > 0 ? [`| Missing (not evaluated) | ⚠️ ${missingCount} |`] : []),
      `| Pass Rate | ${statusIcon} ${passRate}% |`,
      `| Self-Correction Rounds | ${result.rounds} |`,
      ``,
    ];

    if (result.failures.length > 0) {
      const byCategory = {};
      for (const f of result.failures) {
        const item = ARCHITECTURE_CHECKLIST.find(c => c.id === f.id);
        const cat = item?.category ?? 'Other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push({ ...f, severity: item?.severity ?? 'unknown' });
      }

      lines.push(`## ❌ Remaining Issues`);
      lines.push(``);
      for (const [cat, items] of Object.entries(byCategory)) {
        lines.push(`### ${cat}`);
        lines.push(``);
        for (const f of items) {
          lines.push(`- **[${f.id}]** \`${f.severity}\` – ${f.finding}`);
          if (f.fixInstruction) lines.push(`  > Fix: ${f.fixInstruction}`);
        }
        lines.push(``);
      }
    }

    if (result.history.length > 0) {
      lines.push(`## Self-Correction History`);
      lines.push(``);
      for (const h of result.history) {
        lines.push(`### Round ${h.round} – ${h.failures.length} issue(s) fixed`);
        h.failures.forEach(f => lines.push(`- ${f.id}: ${f.finding}`));
        lines.push(``);
      }
    }

    if (result.needsHumanReview) {
      lines.push(`---`);
      lines.push(`> ⚠️ **High-severity issues remain.** These have been recorded as workflow risks.`);
      lines.push(``);
    }

    return lines.join('\n');
  }

  _emptyResult(skipReason) {
    return {
      rounds: 0, totalItems: 0, passed: 0, failed: 0, na: 0,
      failures: [], history: [], riskNotes: [], needsHumanReview: false,
      skipped: true, skipReason,
    };
  }

  _log(msg) {
    if (this.verbose) console.log(msg);
  }
}

/**
 * @typedef {object} ArchReviewResult
 * @property {number}   rounds           - Number of review+fix rounds performed
 * @property {number}   totalItems       - Total checklist items
 * @property {number}   passed           - Items that passed
 * @property {number}   failed           - Items that failed after all rounds
 * @property {number}   na               - Items marked N/A
 * @property {object[]} failures         - Remaining failed items
 * @property {object[]} history          - Per-round fix history
 * @property {string[]} riskNotes        - Risk notes for Orchestrator
 * @property {boolean}  needsHumanReview - True if high-severity failures remain
 * @property {boolean}  skipped          - True if review was skipped
 * @property {string}   [skipReason]
 */

module.exports = { ArchitectureReviewAgent, ARCHITECTURE_CHECKLIST };
