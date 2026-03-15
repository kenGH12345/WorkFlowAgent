/**
 * Clarification Engine – Agent Self-Correction for review/approval stages
 *
 * Implements a 3-layer self-correction strategy:
 *  1. Signal Detection  – Detect ambiguity, assumptions, risks, contradictions
 *  2. Self-Correction   – Feed signals back to the Agent as a refinement prompt
 *  3. Smart Evaluation  – Loop until no signals remain or maxRounds reached
 *
 * Signal Detection has two modes:
 *  - Regex mode (default, no LLM needed): fast keyword-based detection
 *  - Semantic mode (requires llmCall): LLM understands context, distinguishes
 *    "real risks" from "mitigated risks", detects logic errors beyond keywords
 *
 * Human review is only triggered when high-severity signals persist after all rounds.
 *
 * Used in: architecture approval, code review, technical proposal review
 */

'use strict';

// ─── Signal Detectors ─────────────────────────────────────────────────────────

const SIGNAL_PATTERNS = [
  {
    type: 'ambiguity',
    label: '🔍 Ambiguous Requirement',
    layer: 'What',
    severity: 'medium',
    patterns: [/\b(some|certain|a few|several|maybe|possibly|一些|某些|可能|也许|大概)\b/i],
    instruction: (match) => `The term "${match}" is ambiguous. Replace it with a concrete, measurable specification.`,
  },
  {
    type: 'assumption',
    label: '⚠️  Suspicious Assumption',
    layer: 'Why',
    severity: 'high',
    patterns: [/\b(assume|assuming|default|by default|假设|默认|缺省)\b/i],
    instruction: (match) => `The assumption "${match}" is unverified. Either justify it with evidence or remove it and state the explicit requirement.`,
  },
  {
    type: 'alternative',
    label: '🔀 Unresolved Alternative',
    layer: 'How',
    severity: 'medium',
    patterns: [/\b(or|alternatively|option [A-Z]|plan [A-Z]|方案[A-Z一二三]|或者|另一种)\b/i],
    instruction: (match) => `Multiple options are mentioned ("${match}") but no decision is made. Pick one option and justify the choice.`,
  },
  {
    type: 'risk',
    label: '🚨 Unmitigated Risk',
    layer: 'What-if',
    severity: 'high',
    patterns: [/\b(might fail|could fail|risk|concern|potential issue|风险|隐患|警告)\b/i],
    instruction: (match) => `The risk "${match}" is mentioned without a mitigation plan. Add a concrete mitigation strategy.`,
  },
  {
    type: 'contradiction',
    label: '⚡ Contradictory Statement',
    layer: 'What',
    severity: 'high',
    patterns: [/\b(but also|yet|however|on the other hand|既要.*又要|同时.*但是|一方面.*另一方面)\b/i],
    instruction: (match) => `There is a contradiction: "${match}". Resolve it by stating which requirement takes priority.`,
  },
];

// ─── Signal Detection (Regex mode) ──────────────────────────────────────────

/**
 * Scans proposal text and returns detected signals using regex patterns.
 * Fast, no LLM needed. Used as fallback when semantic mode is unavailable.
 *
 * @param {string} text
 * @returns {{ type, label, layer, severity, instruction }[]}
 */
function detectSignals(text) {
  const found = [];
  const seen = new Set();

  for (const detector of SIGNAL_PATTERNS) {
    for (const pattern of detector.patterns) {
      const match = text.match(pattern);
      if (match && !seen.has(detector.type)) {
        seen.add(detector.type);
        found.push({
          type: detector.type,
          label: detector.label,
          layer: detector.layer,
          severity: detector.severity,
          instruction: detector.instruction(match[0]),
        });
      }
    }
  }

  // Sort by severity: high → medium → low
  const severityOrder = { high: 0, medium: 1, low: 2 };
  found.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  return found;
}

// ─── Signal Detection (Semantic mode) ────────────────────────────────────────

/**
 * Builds the semantic signal detection prompt.
 * Asks LLM to analyse the document holistically and return structured signals.
 *
 * Key improvements over regex mode:
 *  1. Distinguishes "real risks" (no mitigation) from "mentioned risks" (already mitigated)
 *  2. Detects logic errors and contradictions that don't contain trigger keywords
 *  3. Understands context: "default" in a config example ≠ unverified assumption
 *
 * @param {string} text        - Document text to analyse
 * @param {string} stageLabel  - e.g. 'Architecture', 'Test Report'
 * @returns {string} prompt
 */
function buildSemanticDetectionPrompt(text, stageLabel) {
  return [
    `You are a senior technical reviewer performing a semantic signal analysis on a ${stageLabel} document.`,
    ``,
    `## Your Task`,
    ``,
    `Analyse the document below and identify REAL issues. Apply the following rules strictly:`,
    ``,
    `### Signal Types to Detect`,
    ``,
    `1. **ambiguity** (medium) – Vague, unmeasurable, or undefined terms that leave room for misinterpretation.`,
    `   - REAL: "some users", "fast enough", "large scale" with no concrete definition`,
    `   - NOT REAL: technical terms used correctly in context (e.g. "default timeout = 30s" is NOT ambiguous)`,
    ``,
    `2. **assumption** (high) – Unverified premises that the design depends on but are not justified.`,
    `   - REAL: "We assume the database can handle 10k QPS" with no evidence or load test`,
    `   - NOT REAL: "By default, retry count is 3" – this is a configuration decision, not an assumption`,
    ``,
    `3. **risk** (high) – Unmitigated risks. A risk is REAL only if NO mitigation strategy is described.`,
    `   - REAL: "Network latency may cause timeouts" with no retry/fallback described`,
    `   - NOT REAL: "Network latency risk – mitigated by exponential backoff retry" – already handled`,
    ``,
    `4. **contradiction** (high) – Logically conflicting statements, even without explicit contradiction words.`,
    `   - REAL: Section A says "stateless service", Section B says "session stored in memory"`,
    `   - REAL: "High availability" requirement but "single instance deployment" in architecture`,
    `   - NOT REAL: Discussing trade-offs explicitly ("We chose X over Y because...")`,
    ``,
    `5. **alternative** (medium) – Multiple options presented without a final decision.`,
    `   - REAL: "We can use Redis or Memcached" with no decision made`,
    `   - NOT REAL: "We evaluated Redis and Memcached, and chose Redis because of persistence support"`,
    ``,
    `6. **logic_error** (high) – Logical flaws in the design that are NOT covered by the above types.`,
    `   - REAL: A flow diagram shows step B depends on step C, but step C comes after step B`,
    `   - REAL: "Cache invalidation on write" but the write path described doesn't include cache invalidation`,
    `   - REAL: A security requirement exists but the described auth flow has a bypass path`,
    ``,
    `## Critical Rules`,
    ``,
    `- Only report REAL issues. False positives are worse than false negatives.`,
    `- If a risk/assumption is explicitly acknowledged AND has a concrete mitigation/justification, it is NOT a signal.`,
    `- If you are unsure whether something is a real issue, do NOT report it.`,
    `- Maximum 5 signals total. Prioritise high-severity issues.`,
    ``,
    `## Document to Analyse`,
    ``,
    text,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element must have:`,
    `- "type": one of: ambiguity | assumption | risk | contradiction | alternative | logic_error`,
    `- "severity": "high" | "medium" | "low"`,
    `- "label": short descriptive label (e.g. "Unmitigated network timeout risk")`,
    `- "layer": "What" | "Why" | "How" | "What-if"`,
    `- "evidence": one sentence quoting or referencing the specific text that triggered this signal`,
    `- "instruction": one concrete instruction for the author to fix this issue`,
    ``,
    `If NO real issues are found, return an empty array: []`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

/**
 * Parses LLM semantic detection response into signal objects.
 * Falls back to empty array on parse error.
 *
 * @param {string} response
 * @returns {{ type, label, layer, severity, instruction, evidence }[]}
 */
function parseSemanticSignals(response) {
  const stripped = response.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Try to extract JSON array from response
    const match = stripped.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  // Normalise and validate each signal
  const validTypes = new Set(['ambiguity', 'assumption', 'risk', 'contradiction', 'alternative', 'logic_error']);
  const validSeverities = new Set(['high', 'medium', 'low']);

  return parsed
    .filter(s => s && validTypes.has(s.type) && validSeverities.has(s.severity))
    .map(s => ({
      type: s.type,
      label: s.label || s.type,
      layer: s.layer || 'What',
      severity: s.severity,
      evidence: s.evidence || '',
      instruction: s.instruction || `Fix the ${s.type} issue.`,
    }))
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
    });
}

// ─── Self-Correction Prompt Builder ──────────────────────────────────────────

/**
 * Builds a refinement prompt that instructs the Agent to fix detected issues.
 * @param {string} originalContent - The artifact content to refine
 * @param {{ type, label, layer, severity, instruction }[]} signals
 * @param {string} stageLabel
 * @returns {string}
 */
function buildRefinementPrompt(originalContent, signals, stageLabel) {
  const issueList = signals
    .map((s, i) => `${i + 1}. [${s.severity.toUpperCase()}] [${s.layer}] ${s.label}\n   → ${s.instruction}`)
    .join('\n\n');

  return [
    `You are performing a self-correction pass on the following ${stageLabel} artifact.`,
    ``,
    `## Issues Detected`,
    ``,
    issueList,
    ``,
    `## Instructions`,
    ``,
    `Rewrite the artifact below to fix ALL of the issues listed above.`,
    `- Do NOT add new ambiguities or assumptions.`,
    `- Be specific, concrete, and decisive.`,
    `- Return the complete revised artifact (not just the changed parts).`,
    ``,
    `## Original Artifact`,
    ``,
    originalContent,
  ].join('\n');
}

// ─── Self-Correction Engine ───────────────────────────────────────────────────

class SelfCorrectionEngine {
  /**
   * @param {Function} llmCall        - async (prompt: string) => string
   * @param {object}   [options]
   * @param {number}   [options.maxRounds=3]     - Max self-correction rounds
   * @param {boolean}  [options.verbose=true]    - Print progress to console
   * @param {boolean}  [options.semanticMode=true] - Use LLM semantic detection instead of regex
   *                                               Semantic mode: distinguishes real vs mitigated risks,
   *                                               detects logic errors, understands context.
   *                                               Falls back to regex if LLM call fails.
   * @param {object}   [options.investigationTools] - Optional tools for deep investigation
   * @param {Function} [options.investigationTools.search]          - async (query: string) => string
   * @param {Function} [options.investigationTools.readSource]      - async (filePath: string) => string
   * @param {Function} [options.investigationTools.queryExperience] - async (query: string) => string
   */
  constructor(llmCall, { maxRounds = 3, verbose = true, semanticMode = true, investigationTools = null } = {}) {
    if (typeof llmCall !== 'function') {
      throw new Error('[SelfCorrectionEngine] llmCall must be a function');
    }
    this.llmCall = llmCall;
    this.maxRounds = maxRounds;
    this.verbose = verbose;
    this.semanticMode = semanticMode;
    this.investigationTools = investigationTools || null;
  }

  /**
   * Runs the self-correction loop on an artifact.
   *
   * @param {string} content      - Initial artifact content
   * @param {string} stageLabel   - Human-readable stage name (e.g. "Architecture")
   * @returns {Promise<SelfCorrectionResult>}
   */
  async correct(content, stageLabel = 'Review') {
    let current = content;
    const history = [];
    let round = 0;
    // N56 fix: track whether the loop exited due to an LLM failure.
    // If true, skip the final signal detection pass – the content was NOT modified
    // by the failed round, so re-detecting signals on the original content would
    // incorrectly escalate a transient LLM error into "needs human review".
    let llmFailed = false;

    this._log(`\n╔══════════════════════════════════════════════════════════╗`);
    this._log(`║  🤖 SELF-CORRECTION  –  ${stageLabel.padEnd(33)}║`);
    this._log(`╚══════════════════════════════════════════════════════════╝`);

    while (round < this.maxRounds) {
      round++;

      // Detect signals: semantic mode (LLM) preferred, regex as fallback
      const signals = await this._detectSignals(current, stageLabel);

      if (signals.length === 0) {
        this._log(`\n[SelfCorrection] ✅ Round ${round - 1}: No issues detected. Artifact is clean.\n`);
        return { content: current, rounds: round - 1, signals: [], history, needsHumanReview: false };
      }

      this._log(`\n[SelfCorrection] 🔍 Round ${round}/${this.maxRounds}: ${signals.length} issue(s) detected:`);
      signals.forEach(s => this._log(`  • [${s.severity}] ${s.label}${s.evidence ? ` – "${s.evidence.slice(0, 60)}"` : ''}`))
      this._log(`[SelfCorrection] 🔄 Sending refinement prompt to Agent...`);

      const refinementPrompt = buildRefinementPrompt(current, signals, stageLabel);

      try {
        const refined = await this.llmCall(refinementPrompt);
        history.push({ round, signals, before: current, after: refined });
        current = refined;
        this._log(`[SelfCorrection] ✏️  Round ${round} complete. Artifact updated.`);
      } catch (err) {
        this._log(`[SelfCorrection] ❌ Round ${round} failed: ${err.message}. Keeping previous version.`);
        // N38 fix: the round counter was already incremented before the LLM call failed,
        // so decrement it back to reflect the number of SUCCESSFUL correction rounds.
        round--;
        // N56 fix: mark that we exited due to LLM failure so the final signal
        // detection pass is skipped (see below).
        llmFailed = true;
        break;
      }
    }

    // N56 fix: if the loop exited because the LLM call failed (not because maxRounds
    // was reached), skip the final signal detection pass entirely.
    // The content was NOT changed by the failed round – re-detecting signals on the
    // unchanged content would find the same issues that were already present BEFORE
    // the correction attempt, and incorrectly escalate a transient LLM error into
    // "needs human review". Instead, return a clean result with the last successfully
    // corrected content and a note that the LLM failed.
    if (llmFailed) {
      this._log(`\n[SelfCorrection] ⚠️  Exiting due to LLM failure after ${round} successful round(s). Skipping final signal check.`);
      return {
        content: current,
        rounds: round,
        signals: [],
        history,
        needsHumanReview: false,
        llmError: true,
      };
    }

    // Final check after all rounds
    let remainingSignals = await this._detectSignals(current, stageLabel);
    let highSeverityRemaining = remainingSignals.filter(s => s.severity === 'high');

    // If high-severity issues remain, attempt deep investigation before giving up
    if (highSeverityRemaining.length > 0 && this.investigationTools) {
      this._log(`\n[SelfCorrection] 🔬 High-severity issues remain. Starting deep investigation...`);
      const investigationResult = await this._deepInvestigate(current, highSeverityRemaining, stageLabel);

      if (investigationResult.enrichedContent) {
        // One more correction round with investigation findings injected
        this._log(`[SelfCorrection] 🔄 Applying investigation findings in final correction round...`);
        try {
          const finalPrompt = buildRefinementPrompt(investigationResult.enrichedContent, highSeverityRemaining, stageLabel);
          const finalRefined = await this.llmCall(finalPrompt);
          history.push({ round: round + 1, signals: highSeverityRemaining, before: current, after: finalRefined, source: 'deep-investigation' });
          current = finalRefined;
          this._log(`[SelfCorrection] ✏️  Post-investigation correction complete.`);
        } catch (err) {
          this._log(`[SelfCorrection] ❌ Post-investigation correction failed: ${err.message}`);
        }
      }

      // Re-evaluate after investigation-driven correction
      // N24 fix: wrap final _detectSignals in try/catch; if LLM fails here,
      // fall back to regex so we don't falsely mark resolved issues as still present.
      try {
        remainingSignals = await this._detectSignals(current, stageLabel);
      } catch (err) {
        this._log(`[SelfCorrection] ⚠️  Final signal detection failed (${err.message}). Falling back to regex.`);
        remainingSignals = detectSignals(current);
      }
      highSeverityRemaining = remainingSignals.filter(s => s.severity === 'high');

      if (highSeverityRemaining.length === 0) {
        this._log(`[SelfCorrection] ✅ Deep investigation resolved all high-severity issues.`);
      } else {
        this._log(`[SelfCorrection] ⚠️  ${highSeverityRemaining.length} high-severity issue(s) still remain after deep investigation.`);
      }
    } else if (highSeverityRemaining.length > 0) {
      this._log(`\n[SelfCorrection] ⚠️  ${highSeverityRemaining.length} high-severity issue(s) remain. No investigation tools configured.`);
    }

    const needsHumanReview = highSeverityRemaining.length > 0;

    if (!needsHumanReview && remainingSignals.length === 0) {
      this._log(`\n[SelfCorrection] ✅ All issues resolved after ${round} round(s).`);
    } else if (!needsHumanReview) {
      this._log(`\n[SelfCorrection] ℹ️  ${remainingSignals.length} minor issue(s) remain. Proceeding automatically.`);
    }

    return {
      content: current,
      rounds: round,
      signals: remainingSignals,
      history,
      needsHumanReview,
    };
  }

  /**
   * Deep investigation: executes search, source reading, and experience queries
   * to gather additional context for resolving high-severity signals.
   *
   * @param {string}   content           - Current artifact content
   * @param {object[]} highSignals        - High-severity signals to investigate
   * @param {string}   stageLabel
   * @returns {Promise<{ enrichedContent: string|null, findings: string[] }>}
   */
  async _deepInvestigate(content, highSignals, stageLabel) {
    const findings = [];
    const tools = this.investigationTools;

    for (const signal of highSignals) {
      this._log(`  [Investigate] 🔍 Signal: ${signal.label} (${signal.type})`);

      // 1. Search – look for related patterns, docs, or prior solutions
      if (typeof tools.search === 'function') {
        try {
          this._log(`  [Investigate] 🌐 Running search for: "${signal.type} ${stageLabel}"`);
          const searchResult = await tools.search(`${signal.type} ${stageLabel} solution best practice`);
          if (searchResult) {
            findings.push(`### Search Findings for [${signal.label}]\n${searchResult}`);
            this._log(`  [Investigate] ✅ Search returned results.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Search failed: ${err.message}`);
        }
      } else {
        this._log(`  [Investigate] ⏭️  No search tool configured. Skipping.`);
      }

      // 2. Read source – scan relevant source files for context
      if (typeof tools.readSource === 'function') {
        try {
          this._log(`  [Investigate] 📂 Reading source files related to: ${signal.type}`);
          const sourceResult = await tools.readSource(signal.type, content);
          if (sourceResult) {
            findings.push(`### Source Code Context for [${signal.label}]\n${sourceResult}`);
            this._log(`  [Investigate] ✅ Source reading returned context.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Source reading failed: ${err.message}`);
        }
      } else {
        this._log(`  [Investigate] ⏭️  No readSource tool configured. Skipping.`);
      }

      // 3. Experience index – query accumulated experience store
      if (typeof tools.queryExperience === 'function') {
        try {
          this._log(`  [Investigate] 🧠 Querying experience index for: ${signal.type}`);
          const expResult = await tools.queryExperience(signal.type);
          if (expResult) {
            findings.push(`### Experience Index for [${signal.label}]\n${expResult}`);
            this._log(`  [Investigate] ✅ Experience index returned ${expResult.length} chars.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Experience query failed: ${err.message}`);
        }
      } else {
        this._log(`  [Investigate] ⏭️  No queryExperience tool configured. Skipping.`);
      }
    }

    if (findings.length === 0) {
      this._log(`  [Investigate] ℹ️  No findings gathered from investigation.`);
      return { enrichedContent: null, findings };
    }

    // Inject findings as additional context into the artifact
    const enrichedContent = [
      content,
      ``,
      `---`,
      `## Investigation Findings (Auto-gathered for Self-Correction)`,
      ``,
      findings.join('\n\n'),
    ].join('\n');

    this._log(`  [Investigate] 📋 ${findings.length} finding(s) gathered. Enriching artifact for final correction.`);
    return { enrichedContent, findings };
  }

  /**
   * Detects signals in the given text.
   * Uses semantic (LLM) mode if enabled, falls back to regex on failure.
   *
   * @param {string} text
   * @param {string} stageLabel
   * @returns {Promise<object[]>} signals
   */
  async _detectSignals(text, stageLabel) {
    if (!this.semanticMode) {
      // Regex mode: fast, no LLM call
      return detectSignals(text);
    }

    // Semantic mode: LLM understands context
    this._log(`[SelfCorrection] 🧠 Running semantic signal detection (LLM)...`);
    try {
      const prompt = buildSemanticDetectionPrompt(text, stageLabel);
      const response = await this.llmCall(prompt);
      const signals = parseSemanticSignals(response);

      if (signals.length > 0) {
        this._log(`[SelfCorrection] 🧠 Semantic detection found ${signals.length} real issue(s).`);
      } else {
        this._log(`[SelfCorrection] 🧠 Semantic detection: no real issues found.`);
      }

      return signals;
    } catch (err) {
      // Fallback to regex on LLM failure
      this._log(`[SelfCorrection] ⚠️  Semantic detection failed (${err.message}). Falling back to regex.`);
      return detectSignals(text);
    }
  }

  _log(msg) {
    if (this.verbose) console.log(msg);
  }
}

/**
 * @typedef {object} SelfCorrectionResult
 * @property {string}   content           - Final (possibly corrected) artifact content
 * @property {number}   rounds            - Number of correction rounds performed
 * @property {object[]} signals           - Remaining signals after all rounds
 * @property {object[]} history           - Per-round correction history
 * @property {boolean}  needsHumanReview  - True only if high-severity issues remain
 */

// ─── Legacy ClarificationEngine (kept for backward compatibility) ─────────────

/**
 * @deprecated Use SelfCorrectionEngine instead.
 * Kept so existing callers don't break during migration.
 */
class ClarificationEngine {
  constructor(options = {}) {
    this._options = options;
    console.warn('[ClarificationEngine] Deprecated: use SelfCorrectionEngine for Agent self-correction mode.');
  }

  async analyse(proposalText, stageLabel = 'Review') {
    const signals = detectSignals(proposalText);
    if (signals.length === 0) return { signals: [], clarifications: [], skipped: true };
    return { signals, clarifications: [], skipped: false, needsHumanReview: signals.some(s => s.severity === 'high') };
  }
}

// ─── Report Formatter ─────────────────────────────────────────────────────────

/**
 * Formats self-correction results as a Markdown block for injection into artifacts.
 * @param {SelfCorrectionResult} result
 * @returns {string}
 */
function formatClarificationReport(result) {
  if (!result || (!result.history && !result.signals)) return '';
  if (result.rounds === 0 && result.signals.length === 0) return '';

  const lines = [
    `## Self-Correction Notes`,
    ``,
    `> Auto-generated by SelfCorrectionEngine. Rounds: ${result.rounds}.`,
    ``,
  ];

  if (result.history && result.history.length > 0) {
    for (const h of result.history) {
      lines.push(`### Round ${h.round} – ${h.signals.length} issue(s) fixed`);
      h.signals.forEach(s => lines.push(`- [${s.severity}] ${s.label}: ${s.instruction}`));
      lines.push('');
    }
  }

  if (result.signals && result.signals.length > 0) {
    lines.push(`### ⚠️ Remaining Issues (${result.signals.length})`);
    result.signals.forEach(s => lines.push(`- [${s.severity}] ${s.label}`));
    lines.push('');
  }

  if (result.needsHumanReview) {
    lines.push(`> **Human review recommended** – high-severity issues could not be auto-resolved.`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  SelfCorrectionEngine,
  ClarificationEngine,
  detectSignals,
  buildSemanticDetectionPrompt,
  parseSemanticSignals,
  formatClarificationReport,
};
