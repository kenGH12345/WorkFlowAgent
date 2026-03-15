/**
 * CodeReviewAgent – Checklist-based Code Review
 *
 * Unlike SelfCorrectionEngine (which detects ambiguous wording),
 * CodeReviewAgent evaluates whether the code is CORRECT and SAFE by
 * checking it against a structured checklist of domain best practices.
 *
 * Review dimensions (checklist categories):
 *   1. Security      – injection, auth, secrets, input validation
 *   2. Error Handling – all error branches covered, no silent failures
 *   3. Performance   – no obvious N+1, memory leaks, blocking calls
 *   4. Code Style    – naming, comments, dead code, magic numbers
 *   5. Requirements  – every acceptance criterion reflected in the diff
 *   6. Edge Cases    – null/undefined, empty collections, boundary values
 *
 * Self-correction loop:
 *   code.diff → checklist review → issues found → refinement prompt →
 *   DeveloperAgent re-generates → re-review → loop until clean or maxRounds
 *
 * Output:
 *   - Corrected code.diff (written back to output/code.diff)
 *   - output/code-review.md (full review report)
 *   - riskNotes[] for Orchestrator risk summary
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Built-in Checklist ───────────────────────────────────────────────────────

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
];

// ─── Prompt Builders ──────────────────────────────────────────────────────────

/**
 * Builds the checklist review prompt.
 * Asks LLM to evaluate each checklist item against the code diff.
 *
 * @param {object[]} checklist
 * @param {string}   codeDiff
 * @param {string}   [requirementText]
 * @returns {string}
 */
function buildReviewPrompt(checklist, codeDiff, requirementText = '') {
  const itemList = checklist
    .map(item => `- [${item.id}] (${item.severity}) ${item.description}\n  Hint: ${item.hint}`)
    .join('\n\n');

  const reqSection = requirementText
    ? `## Requirements Document\n\n${requirementText}\n\n`
    : '';

  return [
    `You are a senior code reviewer performing a structured checklist review.`,
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

/**
 * Builds a developer refinement prompt from failed checklist items.
 *
 * Instead of asking LLM to rewrite the diff (which is error-prone due to strict
 * diff format requirements), we ask LLM to describe the specific code changes
 * needed as a structured fix plan. The caller applies these as annotations.
 *
 * @param {string}   originalDiff
 * @param {object[]} failures      - Failed checklist items with fixInstruction
 * @returns {string}
 */
function buildFixPrompt(originalDiff, failures) {
  const fixList = failures
    .map((f, i) => `${i + 1}. [${f.id}] [${f.severity?.toUpperCase() ?? 'UNKNOWN'}] ${f.finding}\n   Fix: ${f.fixInstruction || 'Please review and fix this missing item.'}`)
    .join('\n\n');

  return [
    `You are a Code Development Agent performing a self-correction pass.`,
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
  // Must have at least one hunk header
  const hasHunk = /@@\s+-\d+[,\d]*\s+\+\d+[,\d]*\s+@@/.test(content);
  if (!hasHunk) return false;
  // Must also have a file header (--- a/... or --- /dev/null or --- \w)
  // to ensure it is a complete diff, not just a partial hunk fragment
  const hasFileHeader = /^---\s+/m.test(content);
  return hasFileHeader;
}

// ─── JSON Extractor ───────────────────────────────────────────────────────────

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

// ─── CodeReviewAgent ─────────────────────────────────────────────────────────

class CodeReviewAgent {
  /**
   * @param {Function} llmCall   - async (prompt: string) => string
   * @param {object}   [options]
   * @param {number}   [options.maxRounds=2]        - Max self-correction rounds
   * @param {boolean}  [options.verbose=true]
   * @param {object[]} [options.extraChecklist=[]]  - Additional checklist items
   * @param {string}   [options.outputDir]          - Where to write code-review.md
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
      throw new Error('[CodeReviewAgent] llmCall must be a function');
    }
    this.llmCall = llmCall;
    this.maxRounds = maxRounds;
    this.verbose = verbose;
    this.checklist = [...DEFAULT_CHECKLIST, ...extraChecklist];
    this.outputDir = outputDir || path.resolve(__dirname, '..', 'output');
    this.investigationTools = investigationTools || null;
  }

  /**
   * Runs the full review + self-correction loop on code.diff.
   *
   * @param {string} codeDiffPath      - Path to output/code.diff
   * @param {string} [requirementPath] - Path to output/requirements.md (optional, for REQ checks)
   * @returns {Promise<CodeReviewResult>}
   */
  async review(codeDiffPath, requirementPath = null) {
    this._log(`\n╔══════════════════════════════════════════════════════════╗`);
    this._log(`║  🔍 CODE REVIEW  –  Checklist-based Analysis             ║`);
    this._log(`╚══════════════════════════════════════════════════════════╝`);

    // Read inputs
    if (!fs.existsSync(codeDiffPath)) {
      this._log(`[CodeReview] ⚠️  code.diff not found at: ${codeDiffPath}. Skipping.`);
      return this._emptyResult('code.diff not found');
    }

    let currentDiff = fs.readFileSync(codeDiffPath, 'utf-8');
    const requirementText = (requirementPath && fs.existsSync(requirementPath))
      ? fs.readFileSync(requirementPath, 'utf-8')
      : '';

    const history = [];
    let round = 0;
    let lastReviewResults = [];

    while (round < this.maxRounds) {
      round++;
      this._log(`\n[CodeReview] 🔄 Round ${round}/${this.maxRounds}: Running checklist review...`);

      // Run checklist review
      const reviewResults = await this._runReview(currentDiff, requirementText);
      lastReviewResults = reviewResults;

      const failures = reviewResults.filter(r => r.result === 'FAIL');
      const passes   = reviewResults.filter(r => r.result === 'PASS');
      const nas      = reviewResults.filter(r => r.result === 'N/A');
      // N50 fix: MISSING items (LLM did not return them) are counted as failures
      // in the summary log so they are visible, not silently ignored.
      const missing  = reviewResults.filter(r => r.result === 'MISSING');

      this._log(`[CodeReview] 📊 Round ${round}: ${passes.length} PASS / ${failures.length} FAIL / ${nas.length} N/A / ${missing.length} MISSING`);

      if (failures.length === 0 && missing.length === 0) {
        this._log(`[CodeReview] ✅ All checklist items passed. Code review complete.\n`);
        break;
      }

      // Log failures
      this._log(`[CodeReview] ❌ Failures (${failures.length + missing.length}):`);
      failures.forEach(f => this._log(`  • [${f.id}] ${f.finding}`));

      // Last round – don't attempt another fix
      if (round >= this.maxRounds) {
        this._log(`[CodeReview] ⚠️  Max rounds reached. Remaining issues will be recorded as risks.`);
        break;
      }

      // Self-correction: optionally run deep investigation before fix prompt
      // so the developer LLM has experience-store context when rewriting.
      let diffForFix = currentDiff;
      if (this.investigationTools) {
        const highFailures = failures.filter(f => {
          const item = this.checklist.find(c => c.id === f.id);
          return item?.severity === 'high';
        });
        if (highFailures.length > 0) {
          this._log(`[CodeReview] 🔬 Running deep investigation for ${highFailures.length} high-severity failure(s)...`);
          const findings = [];
          for (const f of highFailures) {
            if (typeof this.investigationTools.search === 'function') {
              try {
                const r = await this.investigationTools.search(`${f.id} code ${f.finding}`);
                if (r) findings.push(`### Experience for [${f.id}]\n${r}`);
              } catch (_) { /* ignore */ }
            }
            if (typeof this.investigationTools.queryExperience === 'function') {
              try {
                const r = await this.investigationTools.queryExperience('code');
                if (r) findings.push(`### Code Development Experience Context\n${r}`);
              } catch (_) { /* ignore */ }
            }
          }
          if (findings.length > 0) {
            // Prepend findings as a comment block before the diff
            diffForFix = `# Investigation Findings (for self-correction context)\n` +
              findings.map(f => `# ${f.replace(/\n/g, '\n# ')}`).join('\n') +
              `\n# --- End of Findings ---\n\n` + currentDiff;
            this._log(`[CodeReview] 📋 ${findings.length} finding(s) injected into fix context.`);
          }
        }
      }

      // Self-correction: send fix prompt to developer LLM
      // N58 fix: include MISSING items in the fix prompt alongside FAIL items.
      // MISSING means the LLM did not evaluate the item at all – it may simply have
      // overlooked it. Re-prompting with the missing items gives the LLM a chance to
      // address them. Without this, MISSING items are never corrected and always end
      // up in riskNotes, even when the LLM could fix them with a nudge.
      const itemsForFix = [...failures, ...missing];
      this._log(`[CodeReview] 🔧 Sending fix prompt to DeveloperAgent...`);
      const fixPrompt = buildFixPrompt(diffForFix, itemsForFix.map(f => ({
        ...f,
        severity: this.checklist.find(c => c.id === f.id)?.severity ?? 'medium',
      })));

      let fixedDiff = currentDiff;
      try {
        const rawFixed = await this.llmCall(fixPrompt);
        // Strip markdown fences if present – handle ```diff, ```patch, ``` variants
        const diffMatch = rawFixed.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
        // If no fence found, try to extract the diff portion directly from the raw response
        // (LLM may output explanation text before/after the actual diff)
        let candidate;
        if (diffMatch) {
          candidate = diffMatch[1].trim();
        } else {
          // Try to extract from the file header (--- a/...) to end of content.
          // Prefer file header over hunk header to ensure a complete diff (N4 fix).
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
          fixedDiff = candidate;
          this._log(`[CodeReview] ✅ Fix LLM returned a valid diff.`);
        } else {
          // LLM returned something that is not a valid diff (e.g. prose explanation)
          // Keep the current diff and annotate it with fix instructions as comments
          this._log(`[CodeReview] ⚠️  Fix LLM did not return a valid diff. Annotating original diff with fix notes.`);
          const fixAnnotations = failures
            .map(f => `# FIX NEEDED [${f.id}]: ${f.fixInstruction}`)
            .join('\n');
          fixedDiff = fixAnnotations + '\n' + currentDiff;
        }
      } catch (err) {
        this._log(`[CodeReview] ❌ Fix LLM call failed: ${err.message}. Keeping current diff.`);
        break;
      }

      history.push({
        round,
        failures: failures.map(f => ({ id: f.id, finding: f.finding })),
        before: currentDiff,
        after: fixedDiff,
      });

      currentDiff = fixedDiff;
      this._log(`[CodeReview] ✏️  Round ${round} fix applied. Re-reviewing...`);
    }

    // Write corrected diff back
    if (history.length > 0) {
      fs.writeFileSync(codeDiffPath, currentDiff, 'utf-8');
      this._log(`[CodeReview] 💾 Corrected diff written back to: ${codeDiffPath}`);
    }

    // Build final result
    const finalFailures = lastReviewResults.filter(r => r.result === 'FAIL');
    // N50 fix: MISSING items are treated as failures in the final result so they
    // appear in riskNotes and are not silently excluded from the pass rate.
    const finalMissing  = lastReviewResults.filter(r => r.result === 'MISSING');
    const allFailed     = [...finalFailures, ...finalMissing];
    const highFailures  = allFailed.filter(f => {
      const item = this.checklist.find(c => c.id === f.id);
      return item?.severity === 'high';
    });

    const riskNotes = allFailed.map(f => {
      const item = this.checklist.find(c => c.id === f.id);
      return `[CodeReview] ${f.id} (${item?.severity ?? 'unknown'}) ${f.finding}`;
    });

    const result = {
      rounds: round,
      totalItems: this.checklist.length,
      passed: lastReviewResults.filter(r => r.result === 'PASS').length,
      failed: allFailed.length,
      na: lastReviewResults.filter(r => r.result === 'N/A').length,
      failures: allFailed,
      history,
      riskNotes,
      needsHumanReview: highFailures.length > 0,
      skipped: false,
    };

    // Write review report
    const reportPath = path.join(this.outputDir, 'code-review.md');
    const report = this.formatReport(result);
    fs.writeFileSync(reportPath, report, 'utf-8');
    this._log(`[CodeReview] 📄 Review report written to: ${reportPath}`);

    return result;
  }

  /**
   * Runs a single checklist review pass via LLM.
   *
   * @param {string} codeDiff
   * @param {string} requirementText
   * @returns {Promise<object[]>} Array of { id, result, finding, fixInstruction }
   */
  async _runReview(codeDiff, requirementText) {
    const prompt = buildReviewPrompt(this.checklist, codeDiff, requirementText);
    let response;
    try {
      response = await this.llmCall(prompt);
    } catch (err) {
      this._log(`[CodeReview] ❌ Review LLM call failed: ${err.message}`);
      return this.checklist.map(item => ({
        id: item.id,
        result: 'N/A',
        finding: `LLM call failed: ${err.message}`,
        fixInstruction: null,
      }));
    }

    const parsed = extractJsonArray(response);
    if (!parsed) {
      this._log(`[CodeReview] ⚠️  Could not parse LLM review response. Treating all as N/A.`);
      return this.checklist.map(item => ({
        id: item.id,
        result: 'N/A',
        finding: 'LLM response parse error',
        fixInstruction: null,
      }));
    }

    // Merge: fill in any items the LLM missed
    // N50 fix: items the LLM did not return are "not evaluated" (MISSING), NOT "N/A"
    // (not applicable). Marking them N/A incorrectly excludes them from the passRate
    // denominator (evaluatedItems = totalItems - na), making passRate artificially high.
    // MISSING items are treated as failures in the pass-rate calculation so they are
    // visible in the report and do not silently inflate the score.
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
   * @param {CodeReviewResult} result
   * @returns {string}
   */
  formatReport(result) {
    if (result.skipped) {
      return `# Code Review Report\n\n> Skipped: ${result.skipReason}\n`;
    }

    // N26 fix: guard against division by zero when all items are N/A
    // N50 fix: MISSING items are NOT N/A – they are counted as failures (included in
    // result.failed), so they must NOT be subtracted from the evaluatedItems denominator.
    // Only true N/A items (explicitly marked by LLM as not applicable) are excluded.
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

    // Failures by category
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

    // Self-correction history
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
 * @typedef {object} CodeReviewResult
 * @property {number}   rounds           - Number of review+fix rounds performed
 * @property {number}   totalItems       - Total checklist items
 * @property {number}   passed           - Items that passed
 * @property {number}   failed           - Items that failed after all rounds
 * @property {number}   na               - Items marked N/A
 * @property {object[]} failures         - Remaining failed items: { id, result, finding, fixInstruction }
 * @property {object[]} history          - Per-round fix history
 * @property {string[]} riskNotes        - Risk notes for Orchestrator
 * @property {boolean}  needsHumanReview - True if high-severity failures remain
 * @property {boolean}  skipped          - True if review was skipped
 * @property {string}   [skipReason]
 */

module.exports = { CodeReviewAgent, DEFAULT_CHECKLIST };
