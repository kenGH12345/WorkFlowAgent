/**
 * CoverageChecker – Requirement Coverage Checker (Plan B)
 *
 * Compares requirement.md (WHAT) against architecture.md (HOW) to verify
 * that every requirement is addressed in the architecture.
 *
 * Strategy:
 *   1. Parse requirement.md → extract User Stories + Acceptance Criteria items
 *   2. For each item, ask LLM: "Is this requirement covered in the architecture?"
 *   3. Aggregate results → coverage report
 *   4. Return uncovered items as risk notes
 *
 * This is intentionally separate from SelfCorrectionEngine (which checks
 * "is the artifact well-formed?"). CoverageChecker checks "did we build
 * what was asked?".
 */

'use strict';

const fs = require('fs');

// ─── Requirement Parser ───────────────────────────────────────────────────────

/**
 * Extracts requirement items from a requirement.md string.
 * Targets: User Stories (As a...) and Acceptance Criteria (numbered list).
 *
 * @param {string} requirementText
 * @returns {{ id: string, type: 'story'|'criteria', text: string }[]}
 */
function parseRequirements(requirementText) {
  const items = [];
  let idCounter = 1;

  const lines = requirementText.split('\n');
  let inStories = false;
  let inCriteria = false;
  let inFunctional = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Section detection
    if (/^#+\s*(user stories|用户故事)/i.test(trimmed)) { inStories = true; inCriteria = false; inFunctional = false; continue; }
    if (/^#+\s*(acceptance criteria|验收标准|验收条件)/i.test(trimmed)) { inCriteria = true; inStories = false; inFunctional = false; continue; }
    if (/^#+\s*(functional requirements?|功能需求|需求列表|feature list|features?)/i.test(trimmed)) { inFunctional = true; inStories = false; inCriteria = false; continue; }
    if (/^#+/.test(trimmed)) { inStories = false; inCriteria = false; inFunctional = false; continue; }

    // User Story: English "As a ..., I want ..., so that ..."
    //             Chinese "作为...，我想要..." / "作为...，我希望..." / "作为...我需要..."
    if (inStories && (
      /^[-*]\s+as a\b/i.test(trimmed) ||
      /^[-*]\s*(作为|身为)/.test(trimmed)
    )) {
      items.push({ id: `REQ-${String(idCounter++).padStart(3, '0')}`, type: 'story', text: trimmed.replace(/^[-*]\s+/, '') });
      continue;
    }

    // Acceptance Criteria: numbered list items
    if (inCriteria && /^\d+\.\s+/.test(trimmed)) {
      items.push({ id: `REQ-${String(idCounter++).padStart(3, '0')}`, type: 'criteria', text: trimmed.replace(/^\d+\.\s+/, '') });
      continue;
    }

    // Functional Requirements: numbered or bullet list items
    if (inFunctional && (/^\d+\.\s+/.test(trimmed) || /^[-*]\s+/.test(trimmed))) {
      const text = trimmed.replace(/^(\d+\.|[-*])\s+/, '');
      if (text.length > 5) { // Skip very short/empty items
        items.push({ id: `REQ-${String(idCounter++).padStart(3, '0')}`, type: 'functional', text });
      }
      continue;
    }
  }

  // Fallback: if no items found via section-based parsing, try a broader scan
  // This handles requirement.md files that don't use standard section headers
  if (items.length === 0) {
    let fallbackCounter = 1;
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip headings, empty lines, and very short lines
      if (!trimmed || /^#+/.test(trimmed) || trimmed.length < 10) continue;
      // Capture numbered list items anywhere in the document
      if (/^\d+\.\s+.{8,}/.test(trimmed)) {
        items.push({ id: `REQ-${String(fallbackCounter++).padStart(3, '0')}`, type: 'criteria', text: trimmed.replace(/^\d+\.\s+/, '') });
      }
      // Capture bullet list items that look like requirements (contain verbs like "must", "should", "shall", "需要", "必须", "应该")
      if (/^[-*]\s+/.test(trimmed) && /\b(must|should|shall|support|provide|allow|enable|需要|必须|应该|支持|提供|允许)\b/i.test(trimmed)) {
        items.push({ id: `REQ-${String(fallbackCounter++).padStart(3, '0')}`, type: 'criteria', text: trimmed.replace(/^[-*]\s+/, '') });
      }
    }
  }

  return items;
}

// ─── Coverage Prompt Builder ──────────────────────────────────────────────────

/**
 * Builds a batch coverage check prompt.
 * Asks LLM to evaluate each requirement item against the architecture document.
 *
 * @param {object[]} items          - Parsed requirement items
 * @param {string}   architectureText
 * @returns {string}
 */
function buildCoveragePrompt(items, architectureText) {
  const itemList = items
    .map((item, i) => `${i + 1}. [${item.id}] (${item.type}) ${item.text}`)
    .join('\n');

  return [
    `You are a requirement coverage auditor.`,
    ``,
    `## Task`,
    `For each requirement item below, determine whether it is **covered** in the Architecture Document.`,
    ``,
    `A requirement is "covered" if the architecture document explicitly addresses it – even if the`,
    `implementation details differ. A requirement is "not covered" if it is completely absent or`,
    `only vaguely implied.`,
    ``,
    `## Requirement Items`,
    ``,
    itemList,
    ``,
    `## Architecture Document`,
    ``,
    architectureText,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element must have:`,
    `- "id": the requirement ID (e.g. "REQ-001")`,
    `- "covered": true or false`,
    `- "reason": one sentence explaining why it is or is not covered`,
    ``,
    `Example:`,
    `[`,
    `  { "id": "REQ-001", "covered": true, "reason": "Section 3.2 describes the login flow." },`,
    `  { "id": "REQ-002", "covered": false, "reason": "No mention of password reset anywhere." }`,
    `]`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

// ─── JSON Extractor ───────────────────────────────────────────────────────────

/**
 * Extracts a JSON array from LLM response (handles markdown fences).
 * @param {string} response
 * @returns {object[]|null}
 */
function extractJsonArray(response) {
  // Strip markdown fences if present
  const stripped = response.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Try to find a JSON array within the response
    const match = stripped.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

// ─── CoverageChecker ─────────────────────────────────────────────────────────

class CoverageChecker {
  /**
   * @param {Function} llmCall  - async (prompt: string) => string
   * @param {object}   [options]
   * @param {boolean}  [options.verbose=true]
   * @param {number}   [options.batchSize=20]  - Max items per LLM call
   */
  constructor(llmCall, { verbose = true, batchSize = 20 } = {}) {
    if (typeof llmCall !== 'function') {
      throw new Error('[CoverageChecker] llmCall must be a function');
    }
    this.llmCall = llmCall;
    this.verbose = verbose;
    this.batchSize = batchSize;
  }

  /**
   * Runs coverage check between requirement.md and architecture.md.
   *
   * @param {string} requirementPath   - Path to requirement.md
   * @param {string} architecturePath  - Path to architecture.md
   * @returns {Promise<CoverageResult>}
   */
  async check(requirementPath, architecturePath) {
    this._log(`\n╔══════════════════════════════════════════════════════════╗`);
    this._log(`║  📋 COVERAGE CHECK  –  Requirement vs Architecture       ║`);
    this._log(`╚══════════════════════════════════════════════════════════╝`);

    // Read files
    if (!fs.existsSync(requirementPath)) {
      this._log(`[CoverageChecker] ⚠️  requirement.md not found at: ${requirementPath}. Skipping.`);
      return this._emptyResult('requirement.md not found');
    }
    if (!fs.existsSync(architecturePath)) {
      this._log(`[CoverageChecker] ⚠️  architecture.md not found at: ${architecturePath}. Skipping.`);
      return this._emptyResult('architecture.md not found');
    }

    const requirementText = fs.readFileSync(requirementPath, 'utf-8');
    const architectureText = fs.readFileSync(architecturePath, 'utf-8');

    // Parse requirements
    const items = parseRequirements(requirementText);
    if (items.length === 0) {
      // N60 fix: emit a prominent warning instead of silently skipping.
      // A silent skip makes it impossible for the user to distinguish between
      // "coverage check ran and found 100% coverage" vs "coverage check never ran".
      // The _emptyResult() returns coverageRate=100 and skipped=true, which is
      // correct, but without a visible warning the user has no idea why.
      this._log(`[CoverageChecker] ⚠️  WARNING: No parseable requirement items found in requirement.md.`);
      this._log(`[CoverageChecker] ⚠️  Coverage check SKIPPED. Verify that requirement.md uses supported`);
      this._log(`[CoverageChecker] ⚠️  section headers: "User Stories", "Acceptance Criteria", or "Functional Requirements".`);
      this._log(`[CoverageChecker] ⚠️  Coverage rate will be reported as 100% (skipped), which may be misleading.`);
      return this._emptyResult('no parseable items');
    }

    this._log(`[CoverageChecker] 📝 Found ${items.length} requirement item(s). Running coverage check...`);

    // Batch LLM calls
    const allResults = [];
    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize);
      this._log(`[CoverageChecker] 🔄 Checking batch ${Math.floor(i / this.batchSize) + 1}: items ${i + 1}–${i + batch.length}`);

      const prompt = buildCoveragePrompt(batch, architectureText);
      let batchResults = null;

      try {
        const response = await this.llmCall(prompt);
        batchResults = extractJsonArray(response);
      } catch (err) {
        this._log(`[CoverageChecker] ❌ LLM call failed for batch: ${err.message}`);
      }

      if (!batchResults) {
        this._log(`[CoverageChecker] ⚠️  Could not parse LLM response for batch. Marking all as unchecked.`);
        batch.forEach(item => allResults.push({ id: item.id, covered: null, reason: 'LLM response parse error' }));
      } else {
        // Merge batch results, filling in any missing items
        const resultMap = new Map(batchResults.map(r => [r.id, r]));
        batch.forEach(item => {
          const r = resultMap.get(item.id);
          allResults.push(r ?? { id: item.id, covered: null, reason: 'Not returned by LLM' });
        });
      }
    }

    // Build item map for report
    const itemMap = new Map(items.map(i => [i.id, i]));

    const covered = allResults.filter(r => r.covered === true);
    const uncovered = allResults.filter(r => r.covered === false);
    const unchecked = allResults.filter(r => r.covered === null);

    // N31 fix: use only evaluated items (covered + uncovered) as the denominator.
    // unchecked items (LLM parse errors) have unknown status and should not be counted
    // as "uncovered", which would artificially deflate the coverage rate.
    const evaluatedItems = covered.length + uncovered.length;
    const coverageRate = evaluatedItems > 0
      ? Math.round((covered.length / evaluatedItems) * 100)
      : 100;

    this._log(`\n[CoverageChecker] 📊 Coverage: ${covered.length}/${items.length} (${coverageRate}%)`);
    if (uncovered.length > 0) {
      this._log(`[CoverageChecker] ❌ Uncovered (${uncovered.length}):`);
      uncovered.forEach(r => this._log(`  • ${r.id}: ${r.reason}`));
    }
    if (unchecked.length > 0) {
      this._log(`[CoverageChecker] ⚠️  Unchecked (${unchecked.length}) – LLM parse errors`);
    }

    // Build risk notes for uncovered items
    const riskNotes = uncovered.map(r => {
      const item = itemMap.get(r.id);
      return `[Coverage] ${r.id} (${item?.type ?? 'unknown'}) not covered in architecture: ${r.reason}`;
    });

    return {
      total: items.length,
      covered: covered.length,
      uncovered: uncovered.length,
      unchecked: unchecked.length,
      coverageRate,
      results: allResults,
      riskNotes,
      skipped: false,
    };
  }

  /**
   * Formats the coverage result as a Markdown report block.
   * @param {CoverageResult} result
   * @returns {string}
   */
  formatReport(result) {
    if (result.skipped) return `## Coverage Check\n\n> Skipped: ${result.skipReason}\n`;

    const statusIcon = result.coverageRate === 100 ? '✅' : result.coverageRate >= 80 ? '⚠️' : '❌';

    // N42 fix: coverageRate denominator is evaluatedItems (covered + uncovered), NOT total.
    // Display both total and evaluatedItems so the report is internally consistent:
    //   - "Total" shows all parsed items (including unchecked)
    //   - "Evaluated" shows the denominator actually used for coverageRate
    const evaluatedItems = result.covered + result.uncovered;

    const lines = [
      `## Requirement Coverage Report`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total Requirements | ${result.total} |`,
      `| Evaluated (covered + uncovered) | ${evaluatedItems} |`,
      `| Covered | ${result.covered} |`,
      `| Uncovered | ${result.uncovered} |`,
      `| Unchecked (parse errors) | ${result.unchecked} |`,
      `| Coverage Rate (of evaluated) | ${statusIcon} ${result.coverageRate}% |`,
      ``,
    ];

    if (result.uncovered > 0) {
      lines.push(`### ❌ Uncovered Requirements`);
      lines.push(``);
      result.results
        .filter(r => r.covered === false)
        .forEach(r => lines.push(`- **${r.id}**: ${r.reason}`));
      lines.push(``);
    }

    if (result.unchecked > 0) {
      lines.push(`### ⚠️ Unchecked Requirements (parse errors)`);
      result.results
        .filter(r => r.covered === null)
        .forEach(r => lines.push(`- **${r.id}**: ${r.reason}`));
      lines.push(``);
    }

    return lines.join('\n');
  }

  _emptyResult(skipReason) {
    return { total: 0, covered: 0, uncovered: 0, unchecked: 0, coverageRate: 100, results: [], riskNotes: [], skipped: true, skipReason };
  }

  _log(msg) {
    if (this.verbose) console.log(msg);
  }
}

/**
 * @typedef {object} CoverageResult
 * @property {number}   total         - Total requirement items parsed
 * @property {number}   covered       - Items confirmed covered
 * @property {number}   uncovered     - Items confirmed NOT covered
 * @property {number}   unchecked     - Items where LLM check failed
 * @property {number}   coverageRate  - Percentage of covered items (0–100)
 * @property {object[]} results       - Per-item results: { id, covered, reason }
 * @property {string[]} riskNotes     - Risk notes for uncovered items
 * @property {boolean}  skipped       - True if check was skipped
 * @property {string}   [skipReason]  - Reason for skipping
 */

module.exports = { CoverageChecker, parseRequirements };
