/**
 * ReviewAgentBase – Shared base class for checklist-based review agents
 *
 * Extracts the common review loop, adversarial verification, and reporting
 * logic that was previously duplicated between:
 *   - ArchitectureReviewAgent (architecture-review-agent.js)
 *   - CodeReviewAgent (code-review-agent.js)
 *
 * Subclasses MUST implement:
 *   - _getReviewContent(inputPath)       → string (read the artifact to review)
 *   - _buildReviewPrompt(content, reqText)      → string
 *   - _buildAdversarialPrompt(content, mainResults, reqText)  → string|null
 *   - _buildFixPrompt(content, failures) → { prompt: string, mode?: string }
 *   - _applyFix(currentContent, rawFixed, mode) → string
 *   - _writeBackArtifact(inputPath, content) → void
 *   - _writeReport(result)               → void
 *   - _getInvestigationDomain()          → string (e.g. 'architecture' or 'code')
 *   - _getLabelPrefix()                  → string (e.g. 'ArchReview' or 'CodeReview')
 *   - _getHeaderLine()                   → string (banner line for logging)
 */

'use strict';

const fs = require('fs');
const path = require('path');

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

// ─── ReviewAgentBase ──────────────────────────────────────────────────────────

class ReviewAgentBase {
  /**
   * @param {Function} llmCall            - async (prompt: string) => string
   * @param {object}   [options]
   * @param {number}   [options.maxRounds=2]           - Max self-correction rounds
   * @param {boolean}  [options.verbose=true]
   * @param {object[]} [options.checklist=[]]           - Base checklist items
   * @param {object[]} [options.extraChecklist=[]]     - Additional checklist items
   * @param {string}   [options.outputDir]             - Where to write review report
   * @param {object}   [options.investigationTools]    - Optional tools for deep investigation
   * @param {Function} [options.adversarialLlmCall]    - Optional independent LLM for adversarial
   *   verification (P1-A fix). If not provided, falls back to llmCall with an adversarial
   *   system prompt. Pass a different LLM instance (higher temperature or different model)
   *   for true independence.
   */
  constructor(llmCall, {
    maxRounds = 2,
    verbose = true,
    checklist = [],
    extraChecklist = [],
    outputDir = null,
    investigationTools = null,
    adversarialLlmCall = null,
  } = {}) {
    if (typeof llmCall !== 'function') {
      throw new Error(`[${this.constructor.name}] llmCall must be a function`);
    }
    this.llmCall = llmCall;
    // P1-A fix: adversarial verifier uses a different framing to surface blind spots.
    // Falls back to the same llmCall if no independent verifier is provided.
    this.adversarialLlmCall = (typeof adversarialLlmCall === 'function') ? adversarialLlmCall : llmCall;
    this.maxRounds = maxRounds;
    this.verbose = verbose;
    this.checklist = [...checklist, ...extraChecklist];
    this.outputDir = outputDir || path.resolve(__dirname, '..', 'output');
    this.investigationTools = investigationTools || null;
  }

  // ─── Abstract methods (subclasses MUST override) ──────────────────────────

  /** Read the artifact to review from disk. @returns {string|null} */
  _getReviewContent(inputPath) { throw new Error('Subclass must implement _getReviewContent'); }

  /** Build the main review prompt. @returns {string} */
  _buildReviewPrompt(content, requirementText) { throw new Error('Subclass must implement _buildReviewPrompt'); }

  /** Build the adversarial prompt. @returns {string|null} */
  _buildAdversarialPrompt(content, mainResults, requirementText) { throw new Error('Subclass must implement _buildAdversarialPrompt'); }

  /** Build the fix prompt. @returns {{ prompt: string, mode?: string }} */
  _buildFixPrompt(content, failures) { throw new Error('Subclass must implement _buildFixPrompt'); }

  /** Apply the fix from LLM to current content. @returns {string} */
  _applyFix(currentContent, rawFixed, mode) { throw new Error('Subclass must implement _applyFix'); }

  /** Write the corrected artifact back to disk. */
  _writeBackArtifact(inputPath, content) { throw new Error('Subclass must implement _writeBackArtifact'); }

  /** Write the review report. */
  _writeReport(result) { throw new Error('Subclass must implement _writeReport'); }

  /** Return the domain for investigation tools (e.g. 'architecture' or 'code'). @returns {string} */
  _getInvestigationDomain() { throw new Error('Subclass must implement _getInvestigationDomain'); }

  /** Return the label prefix for logging (e.g. 'ArchReview' or 'CodeReview'). @returns {string} */
  _getLabelPrefix() { throw new Error('Subclass must implement _getLabelPrefix'); }

  /** Return the header banner line for review start. @returns {string} */
  _getHeaderLine() { throw new Error('Subclass must implement _getHeaderLine'); }

  /** Return the LLM failure result for this review type (MISSING or N/A). @returns {string} */
  _getFailureDefault() { return 'MISSING'; }

  // ─── Main Review Loop (shared) ─────────────────────────────────────────────

  /**
   * Runs the full review + self-correction loop.
   *
   * @param {string} inputPath       - Path to the artifact (e.g. architecture.md, code.diff)
   * @param {string} [requirementPath] - Path to requirements.md (optional)
   * @returns {Promise<ReviewResult>}
   */
  async review(inputPath, requirementPath = null) {
    const label = this._getLabelPrefix();

    this._log(`\n${this._getHeaderLine()}`);

    // Read inputs
    const content = this._getReviewContent(inputPath);
    if (content === null) {
      this._log(`[${label}] ⚠️  Artifact not found at: ${inputPath}. Skipping.`);
      return this._emptyResult('Artifact not found');
    }

    let currentContent = content;
    const requirementText = (requirementPath && fs.existsSync(requirementPath))
      ? fs.readFileSync(requirementPath, 'utf-8')
      : '';

    const history = [];
    let round = 0;
    let lastReviewResults = [];

    while (round < this.maxRounds) {
      round++;
      this._log(`\n[${label}] 🔄 Round ${round}/${this.maxRounds}: Running checklist review...`);

      // Run checklist review (Phase 1 + Phase 2 adversarial)
      const reviewResults = await this._runReview(currentContent, requirementText);
      lastReviewResults = reviewResults;

      const failures = reviewResults.filter(r => r.result === 'FAIL');
      const passes   = reviewResults.filter(r => r.result === 'PASS');
      const nas      = reviewResults.filter(r => r.result === 'N/A');
      const missing  = reviewResults.filter(r => r.result === 'MISSING');

      this._log(`[${label}] 📊 Round ${round}: ${passes.length} PASS / ${failures.length} FAIL / ${nas.length} N/A${missing.length > 0 ? ` / ${missing.length} MISSING` : ''}`);

      if (failures.length === 0 && missing.length === 0) {
        this._log(`[${label}] ✅ All checklist items passed. Review complete.\n`);
        break;
      }

      // Log failures
      this._log(`[${label}] ❌ Failures (${failures.length + missing.length}):`);
      failures.forEach(f => this._log(`  • [${f.id}] ${f.finding}`));

      if (round >= this.maxRounds) {
        this._log(`[${label}] ⚠️  Max rounds reached. Remaining issues will be recorded as risks.`);
        break;
      }

      // Self-correction: optionally run deep investigation before fix prompt
      let contentForFix = currentContent;
      if (this.investigationTools) {
        const highFailures = failures.filter(f => {
          const item = this.checklist.find(c => c.id === f.id);
          return item?.severity === 'high';
        });
        if (highFailures.length > 0) {
          this._log(`[${label}] 🔬 Running deep investigation for ${highFailures.length} high-severity failure(s)...`);
          const findings = [];
          const domain = this._getInvestigationDomain();
          for (const f of highFailures) {
            if (typeof this.investigationTools.search === 'function') {
              try {
                const r = await this.investigationTools.search(`${f.id} ${domain} ${f.finding}`);
                if (r) findings.push(`### Experience for [${f.id}]\n${r}`);
              } catch (_) { /* ignore */ }
            }
            if (typeof this.investigationTools.queryExperience === 'function') {
              try {
                const r = await this.investigationTools.queryExperience(domain);
                if (r) findings.push(`### ${domain.charAt(0).toUpperCase() + domain.slice(1)} Experience Context\n${r}`);
              } catch (_) { /* ignore */ }
            }
          }
          if (findings.length > 0) {
            contentForFix = this._injectInvestigationFindings(currentContent, findings);
            this._log(`[${label}] 📋 ${findings.length} finding(s) injected into fix context.`);
          }
        }
      }

      // Self-correction: send fix prompt to LLM
      // Include MISSING items alongside FAIL items so LLM can address both
      const itemsForFix = [...failures, ...missing];
      this._log(`[${label}] 🔧 Sending fix prompt...`);
      const { prompt: fixPrompt, mode: fixMode } = this._buildFixPrompt(
        contentForFix,
        itemsForFix.map(f => ({
          ...f,
          severity: this.checklist.find(c => c.id === f.id)?.severity ?? 'medium',
        }))
      );

      if (fixMode === 'patch') {
        this._log(`[${label}] 📄 Document is long. Using patch mode to avoid truncation.`);
      }

      let fixedContent = currentContent;
      try {
        const rawFixed = await this.llmCall(fixPrompt);
        fixedContent = this._applyFix(currentContent, rawFixed, fixMode);
      } catch (err) {
        this._log(`[${label}] ❌ Fix LLM call failed: ${err.message}. Keeping current content.`);
        break;
      }

      history.push({
        round,
        failures: failures.map(f => ({ id: f.id, finding: f.finding })),
        before: currentContent,
        after: fixedContent,
      });

      currentContent = fixedContent;
      this._log(`[${label}] ✏️  Round ${round} fix applied. Re-reviewing...`);
    }

    // Write corrected artifact back
    if (history.length > 0) {
      this._writeBackArtifact(inputPath, currentContent);
      this._log(`[${label}] 💾 Corrected artifact written back to: ${inputPath}`);
    }

    // Build final result
    const finalFailures = lastReviewResults.filter(r => r.result === 'FAIL');
    const finalMissing  = lastReviewResults.filter(r => r.result === 'MISSING');
    const allFailed     = [...finalFailures, ...finalMissing];
    const highFailures  = allFailed.filter(f => {
      const item = this.checklist.find(c => c.id === f.id);
      return item?.severity === 'high';
    });

    const riskNotes = allFailed.map(f => {
      const item = this.checklist.find(c => c.id === f.id);
      return `[${label}] ${f.id} (${item?.severity ?? 'unknown'}) ${f.finding}`;
    });

    const result = {
      rounds: round,
      totalItems: this.checklist.length,
      passed: lastReviewResults.filter(r => r.result === 'PASS').length,
      failed: allFailed.length,
      na: lastReviewResults.filter(r => r.result === 'N/A').length,
      missing: finalMissing.length,
      failures: allFailed,
      // Fix: expose the full results array (PASS + FAIL + N/A + MISSING) so
      // subclass formatReport() methods can perform multi-dimensional analysis.
      // Previously only `failures` (FAIL + MISSING) was returned, causing
      // CodeReviewAgent's AEF 4-Way Review dimension table to always be empty.
      allResults: lastReviewResults,
      history,
      riskNotes,
      needsHumanReview: highFailures.length > 0,
      skipped: false,
    };

    // Write review report
    this._writeReport(result);

    return result;
  }

  /**
   * Runs a single checklist review pass via LLM, followed by an adversarial
   * second-opinion pass to surface blind spots. see CHANGELOG: P1-A
   *
   * Two-phase review:
   *   Phase 1 (main):       this.llmCall evaluates all checklist items
   *   Phase 2 (adversarial): this.adversarialLlmCall re-evaluates PASS/N/A items
   *                          with a skeptical framing to find missed issues
   *
   * @param {string} content
   * @param {string} requirementText
   * @returns {Promise<object[]>}
   */
  async _runReview(content, requirementText) {
    const label = this._getLabelPrefix();
    const failDefault = this._getFailureDefault();

    // ── Phase 1: Main review ──────────────────────────────────────────────────
    const prompt = this._buildReviewPrompt(content, requirementText);
    let response;
    try {
      response = await this.llmCall(prompt);
    } catch (err) {
      this._log(`[${label}] ❌ Review LLM call failed: ${err.message}`);
      return this.checklist.map(item => ({
        id: item.id,
        result: failDefault,
        finding: `LLM call failed: ${err.message}`,
        fixInstruction: null,
      }));
    }

    const parsed = extractJsonArray(response);
    if (!parsed) {
      this._log(`[${label}] ⚠️  Could not parse LLM review response. Treating all as ${failDefault}.`);
      return this.checklist.map(item => ({
        id: item.id,
        result: failDefault,
        finding: 'LLM response parse error',
        fixInstruction: null,
      }));
    }

    const resultMap = new Map(parsed.map(r => [r.id, r]));
    const mainResults = this.checklist.map(item => resultMap.get(item.id) ?? {
      id: item.id,
      result: 'MISSING',
      finding: 'Not evaluated by LLM (response did not include this item)',
      fixInstruction: null,
    });

    // ── Phase 2: Adversarial verification (P1-A fix) ──────────────────────────
    const passedItems = mainResults.filter(r => r.result === 'PASS' || r.result === 'N/A');
    if (passedItems.length === 0) {
      this._log(`[${label}] ⚡ Adversarial pass skipped (no PASS/N/A items to challenge).`);
      return mainResults;
    }

    const adversarialPrompt = this._buildAdversarialPrompt(
      content, mainResults, requirementText
    );
    if (!adversarialPrompt) return mainResults;

    this._log(`[${label}] 🔴 Running adversarial verification on ${passedItems.length} PASS/N/A item(s)...`);
    let adversarialResults = [];
    try {
      const adversarialResponse = await this.adversarialLlmCall(adversarialPrompt);
      adversarialResults = extractJsonArray(adversarialResponse) || [];
    } catch (err) {
      this._log(`[${label}] ⚠️  Adversarial LLM call failed: ${err.message}. Using main results only.`);
      return mainResults;
    }

    // Merge: adversarial FAIL overrides main PASS/N/A
    const adversarialMap = new Map(adversarialResults.map(r => [r.id, r]));
    let downgrades = 0;
    const mergedResults = mainResults.map(mainItem => {
      if (mainItem.result !== 'PASS' && mainItem.result !== 'N/A') return mainItem;
      const adversarialItem = adversarialMap.get(mainItem.id);
      if (adversarialItem && adversarialItem.result === 'FAIL') {
        downgrades++;
        this._log(`[${label}] 🔴 Adversarial downgrade: [${mainItem.id}] PASS → FAIL – ${adversarialItem.finding}`);
        return {
          ...adversarialItem,
          finding: `[Adversarial] ${adversarialItem.finding}`,
        };
      }
      return mainItem;
    });

    if (downgrades > 0) {
      this._log(`[${label}] 🔴 Adversarial pass found ${downgrades} additional issue(s) missed by main review.`);
    } else {
      this._log(`[${label}] ✅ Adversarial pass confirmed main review (no additional issues found).`);
    }

    return mergedResults;
  }

  /**
   * Injects investigation findings into the content for the fix prompt.
   * Subclasses can override for custom injection formatting.
   *
   * @param {string} content  - Original content
   * @param {string[]} findings - Investigation findings
   * @returns {string} Content with findings injected
   */
  _injectInvestigationFindings(content, findings) {
    return content + '\n\n---\n## Investigation Findings\n\n' + findings.join('\n\n');
  }

  _emptyResult(skipReason) {
    return {
      rounds: 0, totalItems: 0, passed: 0, failed: 0, na: 0, missing: 0,
      failures: [], history: [], riskNotes: [], needsHumanReview: false,
      skipped: true, skipReason,
    };
  }

  _log(msg) {
    if (this.verbose) console.log(msg);
  }
}

module.exports = { ReviewAgentBase, extractJsonArray };
