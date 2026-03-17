/**
 * CodeReviewAgent – Checklist-based Code Review
 *
 * Unlike SelfCorrectionEngine (which detects ambiguous wording),
 * CodeReviewAgent evaluates whether the code is CORRECT and SAFE by
 * checking it against a structured checklist of domain best practices.
 *
 * Extends ReviewAgentBase for the shared review loop, adversarial verification,
 * and reporting infrastructure.
 *
 * Review dimensions (checklist categories):
 *   1. Syntax        – parseability, valid JS, intact comment blocks
 *   2. Security      – injection, auth, secrets, input validation
 *   3. Error Handling – all error branches covered, no silent failures
 *   4. Performance   – no obvious N+1, memory leaks, blocking calls
 *   5. Code Style    – naming, comments, dead code, magic numbers
 *   6. Requirements  – every acceptance criterion reflected in the diff
 *   7. Edge Cases    – null/undefined, empty collections, boundary values
 *
 * Output:
 *   - Corrected code.diff (written back to output/code.diff)
 *   - output/code-review.md (full review report)
 *   - riskNotes[] for Orchestrator risk summary
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ReviewAgentBase } = require('./review-agent-base');

// ─── Built-in Checklist ───────────────────────────────────────────────────────

/**
 * AEF-inspired Review Dimensions (from workflow-code-review).
 * Used to categorise findings and support targeted re-review.
 *
 * When a fix addresses only one dimension, only the corresponding reviewer
 * dimension is re-run (instead of full re-review) – saving LLM calls.
 */
const REVIEW_DIMENSIONS = {
  SPEC_COMPLIANCE: 'spec-compliance',   // Does the code match the spec?
  STANDARDS:       'standards',          // Does the code follow coding standards?
  PERFORMANCE:     'performance',        // Are there performance concerns?
  ROBUSTNESS:      'robustness',         // Are edge cases and errors handled?
};

/**
 * Maps each checklist item to its review dimension.
 * This enables targeted re-review: when fixing a PERF issue,
 * only the performance dimension is re-reviewed.
 */
const ITEM_TO_DIMENSION = {
  'SEC':    REVIEW_DIMENSIONS.ROBUSTNESS,
  'ERR':    REVIEW_DIMENSIONS.ROBUSTNESS,
  'PERF':   REVIEW_DIMENSIONS.PERFORMANCE,
  'STYLE':  REVIEW_DIMENSIONS.STANDARDS,
  'REQ':    REVIEW_DIMENSIONS.SPEC_COMPLIANCE,
  'SYNTAX': REVIEW_DIMENSIONS.STANDARDS,
  'EDGE':   REVIEW_DIMENSIONS.ROBUSTNESS,
  'INTF':   REVIEW_DIMENSIONS.SPEC_COMPLIANCE,
  'EXPORT': REVIEW_DIMENSIONS.STANDARDS,
  'CONST':  REVIEW_DIMENSIONS.STANDARDS,
};

/**
 * Default checklist items.
 * Each item has: id, category, severity, description, hint.
 * Callers can extend this via options.extraChecklist.
 */
const DEFAULT_CHECKLIST = [
  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'SEC-001', category: 'Security', severity: 'high',
    description: 'No SQL / NoSQL injection vulnerabilities',
    hint: 'Check for raw string concatenation in queries. Parameterised queries must be used.',
  },
  {
    id: 'SEC-002', category: 'Security', severity: 'high',
    description: 'No hardcoded secrets, tokens, or passwords',
    hint: 'Scan for string literals that look like API keys, passwords, or tokens.',
  },
  {
    id: 'SEC-003', category: 'Security', severity: 'high',
    description: 'All user inputs are validated and sanitised before use',
    hint: 'Every external input (HTTP params, file content, env vars) must be validated.',
  },
  {
    id: 'SEC-004', category: 'Security', severity: 'medium',
    description: 'Authentication and authorisation checks are present where required',
    hint: 'Protected routes/functions must verify identity and permissions.',
  },

  // ── Error Handling ────────────────────────────────────────────────────────
  {
    id: 'ERR-001', category: 'Error Handling', severity: 'high',
    description: 'All async operations have error handling (try/catch or .catch())',
    hint: 'Unhandled promise rejections crash Node.js. Every await must be guarded.',
  },
  {
    id: 'ERR-002', category: 'Error Handling', severity: 'medium',
    description: 'No silent error swallowing (empty catch blocks)',
    hint: 'catch(e) {} with no body hides bugs. At minimum log the error.',
  },
  {
    id: 'ERR-003', category: 'Error Handling', severity: 'medium',
    description: 'Error messages are informative and do not leak internal details',
    hint: 'Stack traces and DB errors must not be sent to clients.',
  },

  // ── Performance ───────────────────────────────────────────────────────────
  {
    id: 'PERF-001', category: 'Performance', severity: 'medium',
    description: 'No N+1 query patterns (queries inside loops)',
    hint: 'Database calls inside for/while loops cause N+1. Use batch queries.',
  },
  {
    id: 'PERF-002', category: 'Performance', severity: 'medium',
    description: 'No obvious memory leaks (event listeners removed, resources closed)',
    hint: 'Event listeners added in loops or without cleanup cause memory leaks.',
  },
  {
    id: 'PERF-003', category: 'Performance', severity: 'low',
    description: 'No synchronous blocking calls in async code paths',
    hint: 'fs.readFileSync, JSON.parse on large payloads block the event loop.',
  },

  // ── Code Style ────────────────────────────────────────────────────────────
  {
    id: 'STYLE-001', category: 'Code Style', severity: 'low',
    description: 'No dead code (commented-out blocks, unreachable branches)',
    hint: 'Dead code increases maintenance burden and confuses readers.',
  },
  {
    id: 'STYLE-002', category: 'Code Style', severity: 'low',
    description: 'No magic numbers or unexplained string literals',
    hint: 'Constants like 86400, "admin" should be named constants with comments.',
  },
  {
    id: 'STYLE-003', category: 'Code Style', severity: 'low',
    description: 'Function and variable names are descriptive and consistent',
    hint: 'Single-letter variables (except loop counters) and abbreviations reduce readability.',
  },

  // ── Requirements ──────────────────────────────────────────────────────────
  {
    id: 'REQ-001', category: 'Requirements', severity: 'high',
    description: 'All acceptance criteria from requirements.md are reflected in the diff',
    hint: 'Cross-check each acceptance criterion against the changed files.',
  },
  {
    id: 'REQ-002', category: 'Requirements', severity: 'medium',
    description: 'No features implemented that are NOT in requirements.md (scope creep)',
    hint: 'Extra features add untested surface area and delay delivery.',
  },

  // ── Syntax & Parseability ────────────────────────────────────────────────
  {
    id: 'SYNTAX-001', category: 'Syntax', severity: 'critical',
    description: 'All modified files are syntactically valid and parseable',
    hint: 'Check for unclosed brackets, broken comment blocks (e.g. JSDoc missing /** opener), unterminated strings, and mismatched template literals. A single broken comment can cascade into SyntaxError for the entire module.',
  },
  {
    id: 'SYNTAX-002', category: 'Syntax', severity: 'high',
    description: 'No broken JSDoc / multi-line comment blocks (missing /** or */)',
    hint: 'Look for multi-line comments that are missing the opening /** or closing */. These cause the JS parser to treat subsequent code as part of the comment, leading to cryptic SyntaxErrors far from the actual defect.',
  },

  // ── Edge Cases ────────────────────────────────────────────────────────────
  {
    id: 'EDGE-001', category: 'Edge Cases', severity: 'medium',
    description: 'Null / undefined inputs are handled gracefully',
    hint: 'Functions receiving external data must guard against null/undefined.',
  },
  {
    id: 'EDGE-002', category: 'Edge Cases', severity: 'medium',
    description: 'Empty collections and zero-length strings are handled',
    hint: 'arr[0] on an empty array returns undefined. Always check length.',
  },
  {
    id: 'EDGE-003', category: 'Edge Cases', severity: 'low',
    description: 'Numeric boundary values are handled (0, negative, MAX_SAFE_INTEGER)',
    hint: 'Off-by-one errors and integer overflow are common in boundary conditions.',
  },

  // ── Interface Contract ────────────────────────────────────────────────────
  {
    id: 'INTF-001', category: 'Interface Contract', severity: 'high',
    description: 'Function return objects contain all fields expected by callers',
    hint: 'Trace every property access on the return value in consuming modules. If a caller reads result.foo, the producing function must include foo in its return object.',
  },
  {
    id: 'INTF-002', category: 'Interface Contract', severity: 'medium',
    description: 'Enum/constant values used in comparisons match their definitions',
    hint: 'When code checks value === "foo", verify that the producer actually emits "foo" (not "Foo" or "FOO"). Cross-reference the constant definition file.',
  },

  // ── Export Completeness ───────────────────────────────────────────────────
  {
    id: 'EXPORT-001', category: 'Export Completeness', severity: 'medium',
    description: 'module.exports includes all symbols that are require()d by other modules',
    hint: 'Search for require("./this-file") across the codebase. Every destructured symbol in those require() calls must be present in module.exports.',
  },
  {
    id: 'EXPORT-002', category: 'Export Completeness', severity: 'low',
    description: 'Re-export barrel files (index.js) include newly added symbols from source modules',
    hint: 'When a new constant, class, or function is added to a module that is re-exported through index.js, the index.js import/export must be updated to include it.',
  },

  // ── Constant Consistency ──────────────────────────────────────────────────
  {
    id: 'CONST-001', category: 'Constant Consistency', severity: 'medium',
    description: 'No hardcoded string literals that duplicate an existing constant value',
    hint: 'If a file imports a Status/Type/Severity enum, all comparisons should use the constant (e.g. Status.RESOLVED), not a raw string ("resolved").',
  },
];

// ─── Prompt Builders (Code-specific) ──────────────────────────────────────────

function buildReviewPrompt(checklist, codeDiff, requirementText = '') {
  const itemList = checklist
    .map(item => `- [${item.id}] (${item.severity}) ${item.description}\n  Hint: ${item.hint}`)
    .join('\n\n');

  const reqSection = requirementText
    ? `## Requirements Document\n\n${requirementText}\n\n`
    : '';

  return [
    `You are **Robert C. Martin (Uncle Bob)** – author of *Clean Code*, *The Clean Coder*, and *Clean Architecture*, and the originator of the SOLID principles.
You have reviewed more code than almost anyone alive, and you have zero tolerance for code that violates the Single Responsibility Principle, hides its intent, or leaves the next developer worse off than you found it.
Your hallmark: every FAIL finding comes with a concrete, actionable fix instruction – not a vague suggestion.
You are performing a structured checklist code review.`,
    ``,
    `## Task`,
    `Evaluate the code diff below against each checklist item.`,
    `For each item, determine: PASS, FAIL, or N/A (not applicable to this diff).`,
    ``,
    `## Checklist`,
    ``,
    itemList,
    ``,
    reqSection,
    `## Code Diff`,
    ``,
    codeDiff,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element must have:`,
    `- "id": checklist item ID (e.g. "SEC-001")`,
    `- "result": "PASS" | "FAIL" | "N/A"`,
    `- "finding": one sentence. If FAIL, describe the specific issue and location.`,
    `- "fixInstruction": if FAIL, one concrete instruction for the developer to fix it. Otherwise null.`,
    ``,
    `Example:`,
    `[`,
    `  { "id": "SEC-001", "result": "PASS", "finding": "Parameterised queries used throughout.", "fixInstruction": null },`,
    `  { "id": "ERR-001", "result": "FAIL", "finding": "fetchUser() at line 42 has no try/catch.", "fixInstruction": "Wrap the await fetchUser() call in a try/catch block and handle the error." }`,
    `]`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

function buildFixPrompt(originalDiff, failures) {
  const fixList = failures
    .map((f, i) => `${i + 1}. [${f.id}] [${f.severity?.toUpperCase() ?? 'UNKNOWN'}] ${f.finding}\n   Fix: ${f.fixInstruction || 'Please review and fix this missing item.'}`)
    .join('\n\n');

  return [
    `You are **Kent Beck** – inventor of TDD and author of *Test Driven Development: By Example*.
You are performing a self-correction pass on a code diff. Fix every issue listed below by applying the simplest change that makes the code correct, clear, and honest.`,
    ``,
    `The following issues were found in your code diff during a checklist review:`,
    ``,
    `## Issues to Fix`,
    ``,
    fixList,
    ``,
    `## Instructions`,
    ``,
    `Analyse the diff below and produce a corrected version that fixes ALL of the issues listed above.`,
    ``,
    `IMPORTANT OUTPUT RULES:`,
    `- Return the corrected diff in standard unified diff format (same format as the input).`,
    `- Only modify the lines that need to change to fix the listed issues.`,
    `- Do NOT change code that is unrelated to the listed issues.`,
    `- Do NOT introduce new issues.`,
    `- Preserve all diff headers (--- a/... +++ b/... @@ ... @@) exactly.`,
    `- If you cannot produce a valid diff, return the original diff unchanged.`,
    `- Output ONLY the diff content. No explanation, no markdown fences.`,
    ``,
    `## Original Diff`,
    ``,
    originalDiff,
  ].join('\n');
}

function buildAdversarialCodePrompt(checklist, codeDiff, mainResults, requirementText = '') {
  const passedItems = mainResults.filter(r => r.result === 'PASS' || r.result === 'N/A');
  if (passedItems.length === 0) return null;

  const itemList = passedItems
    .map(r => {
      const item = checklist.find(c => c.id === r.id);
      return [
        `- [${r.id}] (${item?.severity ?? 'unknown'}) ${item?.description ?? r.id}`,
        `  Main reviewer said: ${r.result} – "${r.finding}"`,
        `  Hint: ${item?.hint ?? ''}`,
      ].join('\n');
    })
    .join('\n\n');

  const reqSection = requirementText
    ? `## Requirements Document\n\n${requirementText}\n\n`
    : '';

  return [
    `You are **Bruce Schneier** – world-renowned security technologist, author of *Applied Cryptography* and *Secrets and Lies*, and the person who coined the phrase "security is a process, not a product".
You are performing an adversarial security-focused second-opinion code review. Your job is to find the security and correctness issues that the main reviewer was too lenient about.`,
    ``,
    `The main reviewer has already evaluated this code diff and marked the following items as PASS or N/A.`,
    `Your job is to find cases where the main reviewer was TOO LENIENT.`,
    ``,
    `## Your Mission`,
    ``,
    `For each item below, determine whether the main reviewer's PASS/N/A verdict was CORRECT or WRONG.`,
    `- If you agree the item genuinely passes: return PASS with a brief confirmation.`,
    `- If you find the main reviewer missed a real issue: return FAIL with a SPECIFIC finding (file + line if possible) and fix instruction.`,
    `- Be skeptical. Look for subtle bugs, missing edge cases, and security oversights.`,
    `- A comment like "// TODO: add validation" is NOT a pass for input validation.`,
    ``,
    `## Items to Re-evaluate (main reviewer said PASS or N/A)`,
    ``,
    itemList,
    ``,
    reqSection,
    `## Code Diff`,
    ``,
    codeDiff,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array with ONLY the items you are re-evaluating (same IDs as above).`,
    `Each element must have:`,
    `- "id": checklist item ID`,
    `- "result": "PASS" | "FAIL"`,
    `- "finding": one sentence. If FAIL, describe the SPECIFIC issue the main reviewer missed.`,
    `- "fixInstruction": if FAIL, one concrete instruction. Otherwise null.`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

/**
 * Validates that a string looks like a valid unified diff.
 * Requires BOTH a file header (--- a/... or --- /dev/null) AND at least one
 * hunk header (@@ -N,N +N,N @@). This prevents partial diffs (hunk-only,
 * no file header) from passing validation and failing at git-apply time (N4 fix).
 *
 * @param {string} content
 * @returns {boolean}
 */
function isValidDiff(content) {
  if (!content || content.trim().length === 0) return false;
  const hasHunk = /@@\s+-\d+[,\d]*\s+\+\d+[,\d]*\s+@@/.test(content);
  if (!hasHunk) return false;
  const hasFileHeader = /^---\s+/m.test(content);
  return hasFileHeader;
}

// ─── CodeReviewAgent (extends ReviewAgentBase) ────────────────────────────────

class CodeReviewAgent extends ReviewAgentBase {
  /**
   * @param {Function} llmCall            - async (prompt: string) => string
   * @param {object}   [options]
   * @param {number}   [options.maxRounds=2]           - Max self-correction rounds
   * @param {boolean}  [options.verbose=true]
   * @param {object[]} [options.extraChecklist=[]]     - Additional checklist items
   * @param {string}   [options.outputDir]             - Where to write code-review.md
   * @param {object}   [options.investigationTools]    - Optional tools for deep investigation
   * @param {Function} [options.adversarialLlmCall]    - Optional independent LLM for adversarial verification
   */
  constructor(llmCall, options = {}) {
    super(llmCall, {
      ...options,
      checklist: DEFAULT_CHECKLIST,
    });
  }

  // ─── Abstract method implementations ───────────────────────────────────────

  _getReviewContent(inputPath) {
    if (!fs.existsSync(inputPath)) return null;
    return fs.readFileSync(inputPath, 'utf-8');
  }

  _buildReviewPrompt(content, requirementText) {
    return buildReviewPrompt(this.checklist, content, requirementText);
  }

  _buildAdversarialPrompt(content, mainResults, requirementText) {
    return buildAdversarialCodePrompt(this.checklist, content, mainResults, requirementText);
  }

  _buildFixPrompt(content, failures) {
    return { prompt: buildFixPrompt(content, failures), mode: 'full' };
  }

  _applyFix(currentContent, rawFixed, _mode) {
    // Strip markdown fences if present – handle ```diff, ```patch, ``` variants
    const diffMatch = rawFixed.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
    let candidate;
    if (diffMatch) {
      candidate = diffMatch[1].trim();
    } else {
      // Try to extract from the file header (--- a/...) to end of content.
      const fileHeaderStart = rawFixed.search(/^---\s+/m);
      if (fileHeaderStart !== -1) {
        candidate = rawFixed.slice(fileHeaderStart).trim();
      } else {
        // Fallback: try from first @@ hunk header (may be partial, will fail isValidDiff)
        const hunkStart = rawFixed.search(/@@\s+-\d+/);
        candidate = hunkStart !== -1 ? rawFixed.slice(hunkStart).trim() : rawFixed.trim();
      }
    }

    // Validate the returned content looks like a real diff
    if (isValidDiff(candidate)) {
      this._log(`[CodeReview] ✅ Fix LLM returned a valid diff.`);
      return candidate;
    }

    // LLM returned something that is not a valid diff (e.g. prose explanation)
    // Keep the current diff unchanged. The base class review() loop will
    // re-review and catch remaining issues in the next round.
    this._log(`[CodeReview] ⚠️  Fix LLM did not return a valid diff. Keeping current diff unchanged.`);
    return currentContent;
  }

  _writeBackArtifact(inputPath, content) {
    fs.writeFileSync(inputPath, content, 'utf-8');
  }

  _writeReport(result) {
    const reportPath = path.join(this.outputDir, 'code-review.md');
    const report = this.formatReport(result);
    fs.writeFileSync(reportPath, report, 'utf-8');
    this._log(`[CodeReview] 📄 Review report written to: ${reportPath}`);
  }

  _getInvestigationDomain() { return 'code'; }
  _getLabelPrefix() { return 'CodeReview'; }
  _getHeaderLine() {
    return [
      `╔══════════════════════════════════════════════════════════╗`,
      `║  🔍 CODE REVIEW  –  Checklist-based Analysis             ║`,
      `╚══════════════════════════════════════════════════════════╝`,
    ].join('\n');
  }

  /**
   * Code review: LLM failure defaults to N/A (not MISSING), preserving original behavior
   * where a failed LLM call marks all items as N/A.
   */
  _getFailureDefault() { return 'N/A'; }

  /**
   * Code review: investigation findings are injected as diff comments (# prefix)
   * rather than as markdown sections.
   */
  _injectInvestigationFindings(content, findings) {
    return `# Investigation Findings (for self-correction context)\n` +
      findings.map(f => `# ${f.replace(/\n/g, '\n# ')}`).join('\n') +
      `\n# --- End of Findings ---\n\n` + content;
  }

  // ─── Report Formatting (Code-specific) ──────────────────────────────────────

  formatReport(result) {
    if (result.skipped) {
      return `# Code Review Report\n\n> Skipped: ${result.skipReason}\n`;
    }

    // N26 fix: guard against division by zero when all items are N/A
    // N50 fix: MISSING items are NOT N/A – they are counted as failures
    const evaluatedItems = result.totalItems - result.na;
    const passRate = evaluatedItems > 0
      ? Math.round((result.passed / evaluatedItems) * 100)
      : 100;
    const statusIcon = result.failed === 0 ? '✅' : result.needsHumanReview ? '❌' : '⚠️';

    const lines = [
      `# Code Review Report`,
      ``,
      `> Auto-generated by CodeReviewAgent. Rounds: ${result.rounds}.`,
      ``,
      `## Summary`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total Checklist Items | ${result.totalItems} |`,
      `| Passed | ✅ ${result.passed} |`,
      `| Failed | ❌ ${result.failed} |`,
      `| N/A | ➖ ${result.na} |`,
      `| Pass Rate | ${statusIcon} ${passRate}% |`,
      `| Self-Correction Rounds | ${result.rounds} |`,
      ``,
    ];

    // ── AEF Multi-Dimensional Summary ──────────────────────────────────────
    // Group failures by review dimension for targeted re-review support
    const dimensionStats = {};
    for (const dim of Object.values(REVIEW_DIMENSIONS)) {
      dimensionStats[dim] = { total: 0, passed: 0, failed: 0 };
    }
    for (const f of (result.allResults || [])) {
      const prefix = (f.id || '').split('-')[0];
      const dim = ITEM_TO_DIMENSION[prefix] || REVIEW_DIMENSIONS.STANDARDS;
      if (!dimensionStats[dim]) dimensionStats[dim] = { total: 0, passed: 0, failed: 0 };
      dimensionStats[dim].total++;
      if (f.result === 'PASS') dimensionStats[dim].passed++;
      else if (f.result === 'FAIL') dimensionStats[dim].failed++;
    }
    if (result.allResults && result.allResults.length > 0) {
      lines.push(`## 🔍 Multi-Dimensional Analysis (AEF 4-Way Review)`);
      lines.push(``);
      lines.push(`| Dimension | Status | Issues |`);
      lines.push(`|-----------|--------|--------|`);
      for (const [dim, stats] of Object.entries(dimensionStats)) {
        const dimIcon = stats.failed === 0 ? '✅ PASS' : '❌ NEEDS_CHANGES';
        lines.push(`| ${dim} | ${dimIcon} | ${stats.failed} |`);
      }
      lines.push(``);
    }

    if (result.failures.length > 0) {
      const byCategory = {};
      for (const f of result.failures) {
        const item = DEFAULT_CHECKLIST.find(c => c.id === f.id);
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
 * @typedef {object} CodeReviewResult
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

module.exports = { CodeReviewAgent, DEFAULT_CHECKLIST, REVIEW_DIMENSIONS, ITEM_TO_DIMENSION };
