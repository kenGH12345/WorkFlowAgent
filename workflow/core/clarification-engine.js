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
    // Two-step detection to avoid variable-length lookbehind (not supported in Node.js < 16):
    // Step 1: match the risk keyword with a simple forward-only lookahead (no lookbehind).
    // Step 2: the custom `filter` function checks the surrounding context to exclude
    //         already-mitigated risks (e.g. "mitigates the risk", "no risk", "risk is low").
    // This approach is compatible with ALL Node.js versions (no lookbehind at all).
    patterns: [/\b(might fail|could fail|risk|concern|potential issue|风险|隐患|警告)\b(?!\s+(?:is\s+)?(?:low|minimal|acceptable|mitigated|addressed|resolved|handled|managed))/i],
    // Filter: returns false (skip signal) if ALL occurrences of the match are preceded
    // by a mitigation phrase. If ANY occurrence is NOT mitigated, the signal is kept.
    // Scan ALL occurrences; return true if any is unmitigated. see CHANGELOG: P2-5/risk-filter
    filter: (match, fullText) => {
      const lowerText = fullText.toLowerCase();
      const lowerMatch = match.toLowerCase();
      const mitigationPrefixes = ['mitigates ', 'mitigated ', 'mitigating ', 'no ', 'without ', 'addresses ', 'addressed ', 'reduces ', 'reduced '];
      let searchFrom = 0;
      let foundUnmitigated = false;
      while (true) {
        const idx = lowerText.indexOf(lowerMatch, searchFrom);
        if (idx < 0) break;
        const prefix = lowerText.slice(Math.max(0, idx - 40), idx);
        const isMitigated = mitigationPrefixes.some(p => prefix.endsWith(p) || prefix.includes(p + 'the '));
        if (!isMitigated) {
          foundUnmitigated = true;
          break;
        }
        searchFrom = idx + 1;
      }
      return foundUnmitigated;
    },
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
        // Optional filter callback: allows detectors to exclude false positives
        // using context-aware logic (e.g. checking prefix text for mitigation phrases)
        // without relying on variable-length lookbehind assertions.
        if (typeof detector.filter === 'function' && !detector.filter(match[0], text)) {
          continue; // filtered out – skip this signal
        }
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
  // Cap document at 6000 chars to stay within LLM context window. see CHANGELOG: P1-4/buildSemanticDetectionPrompt
  const MAX_DOC_CHARS = 6000;
  let docText = text;
  if (text.length > MAX_DOC_CHARS) {
    const half = MAX_DOC_CHARS / 2;
    const head = text.slice(0, half);
    const tail = text.slice(-half);
    const omitted = text.length - MAX_DOC_CHARS;
    docText = `${head}\n\n... [${omitted} chars omitted for token budget] ...\n\n${tail}`;
    // Only log in non-test environments to avoid noise in unit tests
    if (typeof console !== 'undefined' && process.env.NODE_ENV !== 'test') {
      console.log(`[SelfCorrectionEngine] 📏 Document truncated for semantic detection: ${text.length} → ${docText.length} chars (${omitted} omitted).`);
    }
  }

  return [
    `You are **W. Edwards Deming** – the father of quality management, creator of the PDCA (Plan-Do-Check-Act) cycle, and the statistician who transformed post-war Japanese manufacturing into a quality powerhouse.
You believe that quality must be built in, not inspected in. You are performing a semantic signal analysis on a ${stageLabel} document to identify the quality defects that will cause rework downstream.`,
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
    docText,
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
 * Builds an adversarial verification prompt for the final signal check.
 *
 * Independence principle (P1-A fix):
 *   The standard detection prompt asks the LLM to "find issues". After self-correction,
 *   the same LLM tends to confirm its own fixes ("I fixed it, so it must be fine").
 *   This verification prompt uses a DIFFERENT persona – a sceptical second reviewer
 *   who is specifically looking for issues that a previous reviewer might have missed
 *   or glossed over. This breaks the self-validation loop.
 *
 * @param {string} text        - Document text to verify
 * @param {string} stageLabel  - e.g. 'Architecture', 'Test Report'
 * @returns {string} prompt
 */
/**
 * Builds a correlation analysis prompt for the final round of self-correction.
 *
 * Correlation mode (P1 Audit Method Borrowing – Round Objective Progression):
 *   After detection (breadth) and verification (depth), this third objective
 *   performs cross-signal correlation analysis. It looks for CAUSAL CHAINS:
 *   signals that individually seem low/medium severity but combine into a
 *   high-severity systemic issue.
 *
 *   Inspired by the white-box audit methodology's "Phase 3: Correlation Analysis"
 *   which combines independent findings into attack chains.
 *
 * @param {string} text        - Document text to correlate
 * @param {string} stageLabel  - e.g. 'Architecture', 'Test Report'
 * @param {object[]} priorSignals - Signals from previous rounds (for context)
 * @returns {string} prompt
 */
function buildSemanticCorrelationPrompt(text, stageLabel, priorSignals = []) {
  const MAX_DOC_CHARS = 5000;
  let docText = text;
  if (text.length > MAX_DOC_CHARS) {
    const half = MAX_DOC_CHARS / 2;
    const omitted = text.length - MAX_DOC_CHARS;
    docText = `${text.slice(0, half)}\n\n... [${omitted} chars omitted for token budget] ...\n\n${text.slice(-half)}`;
  }

  const priorBlock = priorSignals.length > 0
    ? [
        `## Prior Signals (from earlier rounds)`,
        ``,
        `The following individual issues were detected in previous rounds:`,
        ...priorSignals.slice(0, 8).map((s, i) => `${i + 1}. [${s.severity}] ${s.type}: ${s.label}`),
        ``,
        `Your task is to find CONNECTIONS between these signals that create compound risks.`,
        ``,
      ].join('\n')
    : '';

  return [
    `You are **James Reason** – author of *Swiss Cheese Model* and the world's foremost`,
    `expert on systemic failure analysis. You understand that catastrophic failures`,
    `rarely come from a single cause – they emerge when multiple small gaps align.`,
    ``,
    `You are performing a **correlation analysis** on a ${stageLabel} document.`,
    `Your job is NOT to find new individual issues (previous rounds already did that).`,
    `Your job IS to find **causal chains** – combinations of signals that together`,
    `create a systemic risk greater than the sum of individual parts.`,
    ``,
    priorBlock,
    `## Correlation Patterns to Look For`,
    ``,
    `1. **Risk Amplification** – Issue A in one area makes Issue B in another area much worse`,
    `   (e.g. "missing input validation" + "direct SQL query" = SQL injection)`,
    `2. **Hidden Dependency** – Two seemingly independent components share a fragile assumption`,
    `   (e.g. both assume a config value exists, but neither validates it)`,
    `3. **Error Cascade** – A failure in component A propagates to B, C, D with no circuit breaker`,
    `   (e.g. no error handling + no retry + no fallback = total system failure)`,
    `4. **Contradictory Constraints** – Two requirements/design decisions conflict under edge cases`,
    `   (e.g. "must be stateless" + "must maintain session" = architectural tension)`,
    `5. **Single Point of Failure** – Multiple critical paths converge on one unprotected resource`,
    ``,
    `## Document to Analyse`,
    ``,
    docText,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element represents a CORRELATED risk chain:`,
    `- "type": "correlation"`,
    `- "severity": "high" | "medium" (correlations are always medium+ by definition)`,
    `- "label": short descriptive label for the compound risk`,
    `- "layer": "What-if" (correlations are always hypothetical compound scenarios)`,
    `- "evidence": one sentence describing which signals/components interact`,
    `- "instruction": one concrete instruction to break the causal chain`,
    `- "chain": array of 2-3 contributing factor descriptions (strings)`,
    ``,
    `## Critical Rules`,
    ``,
    `- Only report COMPOUND risks, not individual issues already found.`,
    `- Each correlation must involve at least 2 distinct components or concerns.`,
    `- Maximum 3 correlations. Focus on the highest-impact chains.`,
    `- If no meaningful correlations exist, return an empty array: []`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

function buildSemanticVerificationPrompt(text, stageLabel) {
  const MAX_DOC_CHARS = 6000;
  let docText = text;
  if (text.length > MAX_DOC_CHARS) {
    const half = MAX_DOC_CHARS / 2;
    const omitted = text.length - MAX_DOC_CHARS;
    docText = `${text.slice(0, half)}\n\n... [${omitted} chars omitted for token budget] ...\n\n${text.slice(-half)}`;
  }

  return [
    `You are **Nassim Nicholas Taleb** – author of *The Black Swan* and *Antifragile*, and the world's foremost expert on hidden risks, tail events, and the fragility of systems that look robust on the surface.
You are performing a final adversarial quality gate check on a ${stageLabel} document. Your job is to find the risks that the previous reviewer normalised away.`,
    ``,
    `## Context`,
    ``,
    `This document has already been reviewed and self-corrected by another reviewer.`,
    `Your job is to act as an independent adversarial checker: assume the previous reviewer`,
    `may have been too lenient or may have missed subtle issues.`,
    ``,
    `## Your Task`,
    ``,
    `Look specifically for issues that are easy to overlook after self-correction:`,
    ``,
    `1. **Residual ambiguity** – Terms that are still vague after correction (e.g. "reasonable", "appropriate", "sufficient")`,
    `2. **Unverified assumptions** – Premises stated as facts without evidence or justification`,
    `3. **Unmitigated risks** – Risks mentioned but with no concrete mitigation plan (not just "we will handle it")`,
    `4. **Logical contradictions** – Two statements that cannot both be true, even if they use different words`,
    `5. **Undecided alternatives** – Multiple options still present with no final decision`,
    `6. **Logic errors** – Flows or dependencies that are internally inconsistent`,
    ``,
    `## Critical Rules`,
    ``,
    `- Be MORE strict than the original reviewer. If something is borderline, report it.`,
    `- A risk with only a vague mitigation ("we will monitor it") is still an unmitigated risk.`,
    `- An assumption with only a weak justification ("it is generally accepted that...") is still unverified.`,
    `- Maximum 5 signals. Focus on the most impactful issues.`,
    `- If the document is genuinely clean, return an empty array.`,
    ``,
    `## Document to Verify`,
    ``,
    docText,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element must have:`,
    `- "type": one of: ambiguity | assumption | risk | contradiction | alternative | logic_error`,
    `- "severity": "high" | "medium" | "low"`,
    `- "label": short descriptive label`,
    `- "layer": "What" | "Why" | "How" | "What-if"`,
    `- "evidence": one sentence quoting the specific text that triggered this signal`,
    `- "instruction": one concrete instruction to fix this issue`,
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
    `You are **W. Edwards Deming** – father of quality management and the PDCA cycle.
You are performing a self-correction pass on the following ${stageLabel} artifact. Apply the same rigour you would to a quality audit: fix every defect completely, verify the fix does not introduce new defects, and leave the artifact in a better state than you found it.`,
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
    // P1-NEW-1 fix: oscillation detection – track signal label sets across rounds.
    // If two consecutive rounds produce the same (or highly overlapping) signal set,
    // the correction loop is oscillating: fixing one issue re-introduces another.
    // In that case we terminate early and mark needsHumanReview rather than burning
    // all maxRounds on a loop that will never converge.
    let prevSignalKey = null;
    let oscillationDetected = false;

    this._log(`\n╔══════════════════════════════════════════════════════════╗`);
    this._log(`║  🤖 SELF-CORRECTION  –  ${stageLabel.padEnd(33)}║`);
    this._log(`╚══════════════════════════════════════════════════════════╝`);

    while (round < this.maxRounds) {
      round++;

      // Detect signals: semantic mode (LLM) preferred, regex as fallback
      const signals = await this._detectSignals(current, stageLabel);

      if (signals.length === 0) {
        // R1-6 audit: when round=1, round-1=0 which is confusing in logs.
        // Use "after N scan(s)" phrasing which is always clear.
        const scanLabel = round === 1 ? 'Initial scan' : `After ${round - 1} correction(s)`;
        this._log(`\n[SelfCorrection] ✅ ${scanLabel}: No issues detected. Artifact is clean.\n`);
        return { content: current, rounds: round - 1, signals: [], history, needsHumanReview: false };
      }

      // P2-C fix: use signal.type (enum value) as the oscillation fingerprint instead
      // of signal.label (LLM-generated natural language). The same underlying issue can
      // be described with different labels across rounds (e.g. "Unmitigated network
      // timeout risk" vs "Network timeout risk without mitigation" vs "Missing retry
      // strategy for network failures"), causing the string-equality check to miss
      // oscillation. signal.type is a stable enum ('risk', 'assumption', 'ambiguity',
      // etc.) that is invariant to LLM phrasing variation.
      //
      // Fingerprint format: sorted type list joined by '|'
      // e.g. "assumption|risk|risk" (duplicates kept to detect count changes)
      const currentSignalKey = signals.map(s => s.type).sort().join('|');
      if (prevSignalKey !== null && currentSignalKey === prevSignalKey) {
        this._log(`\n[SelfCorrection] 🔁 Round ${round}: Signal type-set identical to previous round – oscillation detected. Terminating early.`);
        oscillationDetected = true;
        break;
      }
      // Partial-overlap check: if ≥80% of signal types are shared, treat as oscillation.
      // Uses type counts (not just unique types) so "2×risk + 1×assumption" vs
      // "2×risk + 1×ambiguity" correctly scores as 2/3 = 67% overlap (not 100%).
      if (prevSignalKey !== null) {
        const prevTypes = prevSignalKey.split('|');
        const curTypes  = signals.map(s => s.type);
        // Count how many (type, position) pairs match after sorting both lists
        const prevSorted = [...prevTypes].sort();
        const curSorted  = [...curTypes].sort();
        let matchCount = 0;
        let pi = 0, ci = 0;
        while (pi < prevSorted.length && ci < curSorted.length) {
          if (prevSorted[pi] === curSorted[ci]) { matchCount++; pi++; ci++; }
          else if (prevSorted[pi] < curSorted[ci]) { pi++; }
          else { ci++; }
        }
        const overlapRatio = matchCount / Math.max(prevSorted.length, curSorted.length);
        if (overlapRatio >= 0.8) {
          this._log(`\n[SelfCorrection] 🔁 Round ${round}: ${Math.round(overlapRatio * 100)}% signal-type overlap with previous round – oscillation detected. Terminating early.`);
          oscillationDetected = true;
          break;
        }
      }
      prevSignalKey = currentSignalKey;

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
      // Decrement round to reflect successful rounds only. see CHANGELOG: N38
      round--;
      // see CHANGELOG: N56
      llmFailed = true;
        break;
      }
    }

    // P1-NEW-1: if oscillation was detected, skip the normal final-check path and
    // return immediately with needsHumanReview=true so the caller can escalate.
    if (oscillationDetected) {
      this._log(`\n[SelfCorrection] ⚠️  Oscillation detected after ${round} round(s). Marking for human review.`);
      const lastSignals = await this._detectSignals(current, stageLabel).catch(() => []);
      return {
        content: current,
        rounds: round,
        signals: lastSignals,
        history,
        needsHumanReview: true,
        oscillation: true,
      };
    }

    // Skip final signal detection when LLM failed – avoids false escalation. see CHANGELOG: N56
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

    // ── P1 Round Objective Progression (Audit Method Borrowing) ──────────────
    // Three-objective final evaluation, inspired by the white-box audit methodology:
    //
    //   Round N+1 (Verification – depth):  Adversarial second-reviewer persona.
    //     Catches issues the self-correction loop glossed over.
    //
    //   Round N+2 (Correlation – cross-signal):  Causal chain analysis.
    //     Combines individual signals into compound systemic risks.
    //     Only runs when there are enough prior signals to correlate.
    //
    // The verification round always runs. The correlation round runs when:
    //   1. semanticMode is enabled (requires LLM)
    //   2. There are ≥2 signals across all history rounds to correlate
    //   3. maxRounds > 1 (trivial tasks with maxRounds=1 skip correlation)

    // Collect all signals from history for correlation context
    const allPriorSignals = history.reduce((acc, h) => {
      if (Array.isArray(h.signals)) acc.push(...h.signals);
      return acc;
    }, []);

    // Objective 2: Verification (adversarial depth scan)
    this._log(`\n[SelfCorrection] 🎯 Round objective: VERIFICATION (adversarial depth scan)`);
    let remainingSignals = await this._detectSignals(current, stageLabel, { verificationMode: true });
    let highSeverityRemaining = remainingSignals.filter(s => s.severity === 'high');

    // Objective 3: Correlation (cross-signal causal chain analysis)
    // Only run when there are enough prior signals to form meaningful correlations
    const shouldRunCorrelation = this.semanticMode
      && this.maxRounds > 1
      && (allPriorSignals.length + remainingSignals.length) >= 2;

    if (shouldRunCorrelation) {
      this._log(`[SelfCorrection] 🎯 Round objective: CORRELATION (cross-signal causal chain analysis)`);
      const correlationSignals = await this._detectSignals(
        current, stageLabel,
        { correlationMode: true, priorSignals: [...allPriorSignals, ...remainingSignals] }
      );

      if (correlationSignals.length > 0) {
        this._log(`[SelfCorrection] 🔗 Correlation analysis found ${correlationSignals.length} compound risk(s):`);
        correlationSignals.forEach(s => {
          const chain = s.chain ? ` (chain: ${s.chain.join(' → ')})` : '';
          this._log(`  • [${s.severity}] ${s.label}${chain}`);
        });
        // Merge correlation signals into remaining signals
        // Correlation signals are always at least medium severity
        remainingSignals = [...remainingSignals, ...correlationSignals];
        highSeverityRemaining = remainingSignals.filter(s => s.severity === 'high');
      } else {
        this._log(`[SelfCorrection] 🔗 Correlation analysis: no compound risks found.`);
      }
    }

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
      // Use enrichedContent as fallback when post-investigation correction failed. see CHANGELOG: P1-4/contentForFinalDetection, N24
      const contentForFinalDetection = current !== content ? current : (investigationResult.enrichedContent || current);
      try {
        remainingSignals = await this._detectSignals(contentForFinalDetection, stageLabel);
      } catch (err) {
        this._log(`[SelfCorrection] ⚠️  Final signal detection failed (${err.message}). Falling back to regex.`);
        remainingSignals = detectSignals(contentForFinalDetection);
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
    // P1-1 / P2-5 fix: readSource returns the same content for every signal because
    // it is keyed by stageLabel (not signalType). Calling it once per signal produces
    // N identical "Source Code Context" blocks in findings, wasting tokens and
    // potentially confusing the LLM. Fix: call readSource at most once per
    // _deepInvestigate invocation and share the result across all signals.
    let sourceContextAdded = false;

    for (const signal of highSignals) {
      this._log(`  [Investigate] 🔍 Signal: ${signal.label} (${signal.type})`);

      // 1. Search – look for related patterns, docs, or prior solutions
      if (typeof tools.search === 'function') {
        try {
          // P1-5 fix: build a precise search query from signal.evidence and signal.instruction
          // instead of the generic "${signal.type} ${stageLabel} solution best practice".
          // The generic query returns unrelated best-practice articles that have nothing
          // to do with the specific issue. Using the actual evidence text and instruction
          // produces targeted results that are directly actionable for this signal.
          const evidenceSnippet = (signal.evidence || '').slice(0, 80).trim();
          const instructionSnippet = (signal.instruction || '').slice(0, 80).trim();
          const searchQuery = evidenceSnippet
            ? `${signal.type} fix: ${evidenceSnippet}`
            : instructionSnippet
              ? `${signal.type} ${stageLabel}: ${instructionSnippet}`
              : `${signal.type} ${stageLabel} solution best practice`;
          this._log(`  [Investigate] 🌐 Running search for: "${searchQuery.slice(0, 100)}"`);
          const searchResult = await tools.search(searchQuery);
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
      // P1-1 / P2-5 fix: only call readSource once across all signals (see above).
      if (typeof tools.readSource === 'function' && !sourceContextAdded) {
        try {
          this._log(`  [Investigate] 📂 Reading source files (shared across all signals)`);
          const sourceResult = await tools.readSource(signal.type, content);
          if (sourceResult) {
            findings.push(`### Source Code Context\n${sourceResult}`);
            sourceContextAdded = true;
            this._log(`  [Investigate] ✅ Source reading returned context.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Source reading failed: ${err.message}`);
        }
      } else if (typeof tools.readSource === 'function' && sourceContextAdded) {
        this._log(`  [Investigate] ⏭️  Source context already added – skipping duplicate readSource call.`);
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

      // 4. Web search – fallback to internet when local knowledge is insufficient.
      //    Only triggers when: (a) webSearch tool is available AND (b) previous
      //    steps yielded fewer than 2 findings for this signal (i.e. local knowledge gap).
      if (typeof tools.webSearch === 'function' && findings.length < 2) {
        try {
          const evidenceSnippet = (signal.evidence || '').slice(0, 60).trim();
          const webQuery = evidenceSnippet
            ? `${signal.type} solution: ${evidenceSnippet}`
            : `${signal.type} ${stageLabel} best practice fix`;
          this._log(`  [Investigate] 🌐 Web search for: "${webQuery.slice(0, 100)}"`);
          const webResult = await tools.webSearch(webQuery);
          if (webResult) {
            findings.push(`### Web Search Results for [${signal.label}]\n${webResult}`);
            this._log(`  [Investigate] ✅ Web search returned results.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Web search failed: ${err.message}`);
        }
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
   * P1 Round Objective Progression: supports three detection modes:
   *   - detection (default):  breadth scan – find all individual issues
   *   - verification:         depth scan – adversarial re-check of prior fixes
   *   - correlation:          cross-signal analysis – find causal chains
   *
   * @param {string}  text
   * @param {string}  stageLabel
   * @param {object}  [opts]
   * @param {boolean} [opts.verificationMode=false] - Adversarial second reviewer
   * @param {boolean} [opts.correlationMode=false]  - Cross-signal causal chain analysis
   * @param {object[]} [opts.priorSignals=[]]        - Signals from earlier rounds (for correlation)
   * @returns {Promise<object[]>} signals
   */
  async _detectSignals(text, stageLabel, { verificationMode = false, correlationMode = false, priorSignals = [] } = {}) {
    if (!this.semanticMode) {
      // Regex mode: fast, no LLM call (correlation not supported in regex mode)
      return detectSignals(text);
    }

    // Semantic mode: LLM understands context
    const modeLabel = correlationMode
      ? 'correlation (cross-signal)'
      : verificationMode ? 'verification (adversarial)' : 'detection';
    this._log(`[SelfCorrection] 🧠 Running semantic signal ${modeLabel} (LLM)...`);
    try {
      const prompt = correlationMode
        ? buildSemanticCorrelationPrompt(text, stageLabel, priorSignals)
        : verificationMode
          ? buildSemanticVerificationPrompt(text, stageLabel)
          : buildSemanticDetectionPrompt(text, stageLabel);
      const response = await this.llmCall(prompt);
      const signals = parseSemanticSignals(response);

      if (signals.length > 0) {
        this._log(`[SelfCorrection] 🧠 Semantic ${modeLabel} found ${signals.length} real issue(s).`);
      } else {
        this._log(`[SelfCorrection] 🧠 Semantic ${modeLabel}: no real issues found.`);
      }

      return signals;
    } catch (err) {
      // Fallback to regex on LLM failure (correlation mode falls back to empty)
      this._log(`[SelfCorrection] ⚠️  Semantic ${modeLabel} failed (${err.message}). Falling back to ${correlationMode ? 'empty' : 'regex'}.`);
      return correlationMode ? [] : detectSignals(text);
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
  buildSemanticVerificationPrompt,
  parseSemanticSignals,
  formatClarificationReport,
};
