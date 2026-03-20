/**
 * ArchitectureReviewAgent – Checklist-based Architecture Review
 *
 * Evaluates whether the architecture is CORRECT and REASONABLE by checking
 * it against a structured checklist of architecture best practices.
 *
 * Extends ReviewAgentBase for the shared review loop, adversarial verification,
 * and reporting infrastructure.
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
 * Output:
 *   - Corrected architecture.md (written back)
 *   - output/architecture-review.md (full review report)
 *   - riskNotes[] for Orchestrator risk summary
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ReviewAgentBase } = require('./review-agent-base');

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

// ─── Prompt Builders (Architecture-specific) ──────────────────────────────────

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
    `You are **Grady Booch** – co-creator of UML, IBM Fellow, and author of *Object-Oriented Analysis and Design with Applications*.
You have reviewed hundreds of enterprise architectures and you know exactly what separates a design that will scale from one that will collapse under its own weight.
Your hallmark: you evaluate architecture with the rigour of a formal methods expert and the pragmatism of someone who has shipped production systems.
You are performing a structured architecture review.`,
    ``,
    `## Task`,
    `Evaluate the architecture document below against each checklist item.`,
    `For each item, determine: PASS, FAIL, or N/A (not applicable to this architecture).`,
    ``,
    `## MANDATORY Anti-Hallucination Rules`,
    ``,
    `You MUST follow these rules. Violation of ANY rule invalidates your entire review:`,
    `1. **Section references must be real**: Only cite sections that actually exist in the document. NEVER fabricate or guess section names.`,
    `2. **Evidence required**: Every FAIL finding MUST quote or paraphrase the specific part of the document (or its absence) that justifies the verdict.`,
    `3. **No phantom gaps**: If a dimension is genuinely not applicable to this system, mark it N/A with a clear reason. Do NOT mark it FAIL just to seem thorough.`,
    `4. **Severity must be earned**: A missing backup strategy for a read-only config service is LOW, not HIGH. Match severity to actual risk.`,
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

function buildAdversarialArchPrompt(checklist, archContent, mainResults, requirementText = '') {
  const passedItems = mainResults.filter(r => r.result === 'PASS' || r.result === 'N/A');
  if (passedItems.length === 0) return null;

  const itemList = passedItems
    .map(r => {
      const item = checklist.find(c => c.id === r.id);
      return [
        `- [${r.id}] (${item?.severity ?? 'unknown'}) ${item?.description ?? r.id}`,
        `  Main reviewer said: ${r.result} – "${r.finding}"`,
        `  Hint: ${item?.hint ?? ''}`,
        `  How to evaluate: ${item?.evaluationGuide ?? ''}`,
      ].join('\n');
    })
    .join('\n\n');

  const reqSection = requirementText
    ? `## Requirements Document\n\n${requirementText}\n\n`
    : '';

  return [
    `You are **Fred Brooks** – author of *The Mythical Man-Month* and *The Design of Design*, Turing Award laureate, and the architect who learned the hardest lessons about software complexity firsthand.
You are performing an adversarial second-opinion architecture review. Your job is to find what the main reviewer missed.`,
    ``,
    `The main reviewer has already evaluated this architecture and marked the following items as PASS or N/A.`,
    `Your job is to find cases where the main reviewer was TOO LENIENT.`,
    ``,
    `## Your Mission`,
    ``,
    `For each item below, determine whether the main reviewer's PASS/N/A verdict was CORRECT or WRONG.`,
    `- If you agree the item genuinely passes: return PASS with a brief confirmation.`,
    `- If you find the main reviewer missed a real issue: return FAIL with a SPECIFIC finding and fix instruction.`,
    `- Be skeptical. Look for vague statements, missing details, and unstated assumptions.`,
    `- A statement like "we will handle this" or "standard practices apply" is NOT a pass.`,
    ``,
    `## MANDATORY Anti-Hallucination Rules (same as main review)`,
    ``,
    `1. Only reference sections that exist in the document. NEVER fabricate section names.`,
    `2. Every FAIL must cite specific evidence (quote or describe the gap). No evidence = no finding.`,
    `3. Do NOT inflate severity to justify a downgrade.`,
    ``,
    `## Items to Re-evaluate (main reviewer said PASS or N/A)`,
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
    `Return a JSON array with ONLY the items you are re-evaluating (same IDs as above).`,
    `Each element must have:`,
    `- "id": checklist item ID`,
    `- "result": "PASS" | "FAIL"`,
    `- "finding": one sentence. If FAIL, describe the SPECIFIC gap the main reviewer missed.`,
    `- "fixInstruction": if FAIL, one concrete instruction. Otherwise null.`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

function buildArchFixPrompt(originalContent, failures) {
  const fixList = failures
    .map((f, i) => `${i + 1}. [${f.id}] [${f.severity?.toUpperCase() ?? 'UNKNOWN'}] ${f.finding}\n   Fix: ${f.fixInstruction || 'Please review and fix this missing item.'}`)
    .join('\n\n');

  const LONG_DOC_THRESHOLD = 4000;
  const isLongDoc = originalContent.length > LONG_DOC_THRESHOLD;

  if (isLongDoc) {
    const prompt = [
      `You are **Martin Fowler** – Chief Scientist at ThoughtWorks, author of *Refactoring* and *Patterns of Enterprise Application Architecture*.
You are performing a self-correction pass on an architecture document. Fix every issue listed below with the precision of someone who has refactored thousands of designs.`,
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
    `You are **Martin Fowler** – Chief Scientist at ThoughtWorks, author of *Refactoring* and *Patterns of Enterprise Application Architecture*.
You are performing a self-correction pass on an architecture document. Fix every issue listed below with the precision of someone who has refactored thousands of designs.`,
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

function applyArchPatches(originalContent, patchResponse) {
  const patchRegex = /###\s+PATCH:\s+(.+?)\n([\s\S]*?)(?=###\s+PATCH:|$)/g;
  let result = originalContent;
  let match;

  while ((match = patchRegex.exec(patchResponse)) !== null) {
    const heading = match[1].trim();
    const newContent = match[2].trim();

    const plainHeading = heading.replace(/^#+\s*/, '');
    const escapedHeading = plainHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const sectionRegex = new RegExp(
      `(#+\\s+${escapedHeading}[^\\n]*)\\n[\\s\\S]*(?=\\n#+\\s|$)`,
      'i'
    );

    if (sectionRegex.test(result)) {
      result = result.replace(sectionRegex, `$1\n\n${newContent}\n`);
    } else {
      result = result.trimEnd() + `\n\n## ${plainHeading}\n\n${newContent}\n`;
    }
  }

  return result;
}

// ─── ArchitectureReviewAgent (extends ReviewAgentBase) ────────────────────────

class ArchitectureReviewAgent extends ReviewAgentBase {
  /**
   * @param {Function} llmCall            - async (prompt: string) => string
   * @param {object}   [options]
   * @param {number}   [options.maxRounds=2]           - Max self-correction rounds
   * @param {boolean}  [options.verbose=true]
   * @param {object[]} [options.extraChecklist=[]]     - Additional checklist items
   * @param {string}   [options.outputDir]             - Where to write architecture-review.md
   * @param {object}   [options.investigationTools]    - Optional tools for deep investigation
   * @param {Function} [options.adversarialLlmCall]    - Optional independent LLM for adversarial verification
   */
  constructor(llmCall, options = {}) {
    super(llmCall, {
      ...options,
      checklist: ARCHITECTURE_CHECKLIST,
    });
  }

  // ─── Abstract method implementations ───────────────────────────────────────

  _getReviewContent(inputPath) {
    if (!fs.existsSync(inputPath)) return null;
    return fs.readFileSync(inputPath, 'utf-8');
  }

  _buildReviewPrompt(content, requirementText) {
    // Optimization 5: inject tech stack validation context (web search results)
    // into the review prompt so the reviewer can verify technology choices against
    // real-world, up-to-date data (latest versions, known issues, deprecations).
    const enrichedReqText = this.techStackValidationCtx
      ? `${requirementText}\n\n${this.techStackValidationCtx}`
      : requirementText;
    return buildArchReviewPrompt(this.checklist, content, enrichedReqText);
  }

  _buildAdversarialPrompt(content, mainResults, requirementText) {
    return buildAdversarialArchPrompt(this.checklist, content, mainResults, requirementText);
  }

  _buildFixPrompt(content, failures) {
    return buildArchFixPrompt(content, failures);
  }

  _applyFix(currentContent, rawFixed, mode) {
    // Strip markdown fences if present
    const mdMatch = rawFixed.match(/```(?:markdown|md)?\n([\s\S]*?)```/);
    const candidate = mdMatch ? mdMatch[1].trim() : rawFixed.trim();

    if (mode === 'patch') {
      const patched = applyArchPatches(currentContent, candidate);
      this._log(`[ArchReview] ✅ Patch mode: applied ${(candidate.match(/###\s+PATCH:/g) || []).length} patch(es).`);
      return patched;
    }

    // Full rewrite mode: validate output is not truncated
    if (candidate.length >= currentContent.length * 0.7) {
      return candidate;
    }
    this._log(`[ArchReview] ⚠️  Fix LLM output too short (${candidate.length} vs ${currentContent.length}). Possible truncation. Keeping current content.`);
    return currentContent;
  }

  _writeBackArtifact(inputPath, content) {
    fs.writeFileSync(inputPath, content, 'utf-8');
  }

  _writeReport(result) {
    const reportPath = path.join(this.outputDir, 'architecture-review.md');
    const report = this.formatReport(result);
    fs.writeFileSync(reportPath, report, 'utf-8');
    this._log(`[ArchReview] 📄 Review report written to: ${reportPath}`);
  }

  _getInvestigationDomain() { return 'architecture'; }
  _getLabelPrefix() { return 'ArchReview'; }
  _getHeaderLine() {
    return [
      `╔══════════════════════════════════════════════════════════╗`,
      `║  🏛️  ARCHITECTURE REVIEW  –  Checklist-based Analysis    ║`,
      `╚══════════════════════════════════════════════════════════╝`,
    ].join('\n');
  }
  _getFailureDefault() { return 'MISSING'; }

  // ─── Report Formatting (Architecture-specific) ─────────────────────────────

  formatReport(result) {
    if (result.skipped) {
      return `# Architecture Review Report\n\n> Skipped: ${result.skipReason}\n`;
    }

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
