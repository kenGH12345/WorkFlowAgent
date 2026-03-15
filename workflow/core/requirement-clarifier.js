/**
 * RequirementClarifier – Requirement-stage clarification via Socratic questioning
 *
 * Runs BEFORE AnalystAgent to ensure the raw requirement is unambiguous.
 * Unlike SelfCorrectionEngine (which corrects AI-generated artifacts),
 * this module detects signals in HUMAN-written requirements and asks the
 * human to clarify – producing a richer, unambiguous requirement string.
 *
 * Flow:
 *   rawRequirement
 *       ↓
 *   detectSignals()          ← same detector as clarification-engine
 *       ↓ signals found?
 *   buildClarificationQuestions()
 *       ↓
 *   askUser()                ← callback provided by caller (e.g. CLI prompt / chat)
 *       ↓
 *   mergeAnswers()           ← append answers to requirement text
 *       ↓ repeat until clean or maxRounds reached
 *   return enrichedRequirement
 */

'use strict';

const { detectSignals, parseSemanticSignals } = require('./clarification-engine');

// ─── Semantic Detection for Human Requirements ───────────────────────────────

/**
 * Builds a semantic detection prompt specifically for HUMAN-written requirements.
 *
 * Key differences from SelfCorrectionEngine's prompt (which targets AI-generated docs):
 *  - Understands oral/informal language patterns
 *  - Focuses on "what needs to be asked" rather than "what needs to be fixed"
 *  - Avoids false positives on domain terms (e.g. "风险提示" is a feature name, not a risk)
 *  - Detects implicit scope gaps that regex cannot find (e.g. "做个好用的界面")
 *
 * @param {string} text - Raw requirement text from human
 * @returns {string} prompt
 */
function buildRequirementSemanticPrompt(text) {
  return [
    `You are a senior product manager reviewing a raw requirement written by a human.`,
    `Your job is to identify points that need clarification BEFORE development begins.`,
    ``,
    `## Your Task`,
    ``,
    `Analyse the requirement below and identify REAL ambiguities or gaps that would cause`,
    `misunderstanding or rework if left unaddressed. Apply the following rules strictly:`,
    ``,
    `### Signal Types to Detect`,
    ``,
    `1. **ambiguity** (medium) – Vague or unmeasurable terms that different people would interpret differently.`,
    `   - REAL: "做个好用的界面" ("good UI" – no criteria), "一些用户" ("some users" – no count)`,
    `   - REAL: "尽快完成" ("ASAP" – no deadline), "支持大量并发" ("large concurrency" – no number)`,
    `   - NOT REAL: "默认3条命" – this is a concrete design decision, not ambiguous`,
    `   - NOT REAL: domain/feature names that happen to contain vague-sounding words (e.g. "风险提示功能")`,
    ``,
    `2. **assumption** (high) – The requirement implicitly assumes something that may not be true.`,
    `   - REAL: "用户已登录后进入游戏" – assumes login system exists, but is it confirmed?`,
    `   - REAL: "复用现有的支付模块" – assumes the payment module supports this use case`,
    `   - NOT REAL: explicit design decisions stated as facts ("玩家初始金币为1000")`,
    ``,
    `3. **alternative** (medium) – Multiple options are mentioned but no decision is made.`,
    `   - REAL: "可以用排行榜或者成就系统来激励用户" – which one? both? priority?`,
    `   - NOT REAL: listing features that are all required ("支持A、B、C三种模式")`,
    ``,
    `4. **risk** (high) – A potential problem is mentioned but no handling strategy is described.`,
    `   - REAL: "网络断线时可能丢失进度" – how should this be handled?`,
    `   - NOT REAL: feature names containing risk-related words ("风险提示", "异常处理模块")`,
    `   - NOT REAL: risks that already have a described solution`,
    ``,
    `5. **contradiction** (high) – Two parts of the requirement conflict with each other.`,
    `   - REAL: "游戏要简单易上手" AND "包含20种复杂道具组合" – these conflict`,
    `   - REAL: "离线可玩" AND "实时同步服务器数据" – these conflict`,
    ``,
    `## Critical Rules`,
    ``,
    `- You are reading HUMAN-written text, not a technical document. Be tolerant of informal language.`,
    `- Only flag issues that would genuinely cause misunderstanding or rework.`,
    `- Do NOT flag domain/feature names just because they contain ambiguous-sounding words.`,
    `- Do NOT flag explicit design decisions as assumptions.`,
    `- If you are unsure whether something is a real issue, do NOT report it.`,
    `- Maximum 5 signals total. Prioritise high-severity issues.`,
    ``,
    `## Requirement to Analyse`,
    ``,
    text,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element must have:`,
    `- "type": one of: ambiguity | assumption | risk | contradiction | alternative`,
    `- "severity": "high" | "medium" | "low"`,
    `- "label": short descriptive label in the same language as the requirement`,
    `- "layer": "What" | "Why" | "How" | "What-if"`,
    `- "evidence": quote the specific phrase from the requirement that triggered this signal`,
    `- "instruction": one concrete question to ask the human to resolve this (in the same language as the requirement)`,
    ``,
    `If NO real issues are found, return an empty array: []`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

/**
 * Detects signals in a human-written requirement using LLM semantic analysis.
 * Falls back to regex detectSignals() on LLM failure.
 *
 * @param {string}   text     - Raw requirement text
 * @param {Function} llmCall  - async (prompt: string) => string
 * @param {Function} logFn    - logging function
 * @returns {Promise<object[]>} signals
 */
async function detectRequirementSignals(text, llmCall, logFn) {
  if (typeof llmCall !== 'function') {
    // No LLM available – fall back to regex
    return detectSignals(text);
  }

  logFn('[RequirementClarifier] 🧠 Running semantic signal detection (LLM)...');
  try {
    const prompt = buildRequirementSemanticPrompt(text);
    const response = await llmCall(prompt);
    const signals = parseSemanticSignals(response);

    if (signals.length > 0) {
      logFn(`[RequirementClarifier] 🧠 Semantic detection found ${signals.length} real issue(s).`);
    } else {
      logFn('[RequirementClarifier] 🧠 Semantic detection: requirement looks clear.');
    }

    return signals;
  } catch (err) {
    // Fallback to regex on LLM failure
    logFn(`[RequirementClarifier] ⚠️  Semantic detection failed (${err.message}). Falling back to regex.`);
    return detectSignals(text);
  }
}

// ─── Question Builder ─────────────────────────────────────────────────────────

/**
 * Maps signal types to layered Socratic question prefixes (What → Why → How → What-if).
 * The actual question content comes directly from signal.instruction (LLM-generated),
 * which is already a concrete, context-aware question in the requirement's language.
 */
const QUESTION_PREFIXES = {
  ambiguity:    { icon: '🔍', layer: 'What' },
  assumption:   { icon: '⚠️ ', layer: 'Why' },
  alternative:  { icon: '🔀', layer: 'How' },
  risk:         { icon: '🚨', layer: 'What-if' },
  contradiction:{ icon: '⚡', layer: 'What' },
};
/**
 * Builds a list of clarification questions from detected signals.
 * Uses signal.instruction directly (LLM-generated, context-aware question)
 * with a type-specific icon/layer prefix for readability.
 *
 * @param {object[]} signals
 * @returns {{ signal: object, question: string }[]}
 */
function buildClarificationQuestions(signals) {
  return signals.map((signal) => {
    const prefix = QUESTION_PREFIXES[signal.type];
    // signal.instruction is already a concrete question from LLM semantic detection.
    // Just prepend the icon and layer tag for visual clarity.
    const question = prefix
      ? `${prefix.icon} [${prefix.layer}] ${signal.instruction}`
      : `[${signal.layer}] ${signal.instruction}`;
    return { signal, question };
  });
}

// ─── Answer Merger ────────────────────────────────────────────────────────────

/**
 * Builds a prompt asking LLM to fuse Q&A answers into the requirement text.
 * This produces a single coherent requirement instead of a raw appendix.
 *
 * @param {string} requirement - Original requirement text
 * @param {{ question: string, answer: string }[]} qa - Q&A pairs
 * @returns {string} prompt
 */
function buildMergePrompt(requirement, qa) {
  const qaBlock = qa
    .map(({ question, answer }, i) => `Q${i + 1}: ${question}\nA${i + 1}: ${answer}`)
    .join('\n\n');

  return [
    `You are a product manager refining a requirement document.`,
    ``,
    `The following clarification Q&A was collected from the stakeholder.`,
    `Your task is to integrate the answers into the original requirement text,`,
    `producing a single coherent, unambiguous requirement document.`,
    ``,
    `## Rules`,
    `- Incorporate each answer naturally into the relevant part of the requirement.`,
    `- Do NOT append a Q&A section at the end – integrate the information inline.`,
    `- Keep the original structure and language style.`,
    `- CRITICAL: Preserve the original language of the requirement. If the original is in Chinese, the output MUST be in Chinese. If in English, output in English. Do NOT translate or switch languages.`,
    `- Do not add new requirements beyond what the answers specify.`,
    `- Do not introduce vague or ambiguous phrasing. Use concrete, specific language from the answers.`,
    `- Return ONLY the updated requirement text. No preamble, no explanation.`,
    ``,
    `## Original Requirement`,
    ``,
    requirement,
    ``,
    `## Clarification Q&A`,
    ``,
    qaBlock,
  ].join('\n');
}

/**
 * Merges user answers back into the requirement text.
 *
 * If llmCall is provided, uses LLM to fuse answers inline for a coherent result.
 * Falls back to structured appendix if LLM is unavailable or fails.
 *
 * @param {string}   requirement  - Original requirement text
 * @param {{ question: string, answer: string }[]} qa - Q&A pairs
 * @param {Function} [llmCall]    - async (prompt: string) => string
 * @param {Function} [logFn]      - logging function
 * @returns {Promise<string>}
 */
async function mergeAnswers(requirement, qa, llmCall, logFn) {
  if (!qa || qa.length === 0) return requirement;

  // Try LLM-based inline fusion first
  if (typeof llmCall === 'function') {
    try {
      logFn && logFn('[RequirementClarifier] 🔀 Fusing answers into requirement via LLM...');
      const prompt = buildMergePrompt(requirement, qa);
      const merged = await llmCall(prompt);
      if (merged && merged.trim().length > 0) {
        // Sanity check: merged result should be at least 50% the length of the original
        // to guard against LLM returning a truncated or empty-ish response.
        // N16 fix: threshold lowered from 0.8 to 0.5 – when answers remove/cancel features,
        // the merged requirement may legitimately shrink by more than 20%.
        // N62 fix: also check upper bound (3x original length) to guard against LLM
        // hallucinations that repeat the original requirement multiple times, which would
        // cause the requirement document to grow unboundedly across clarification rounds.
        const mergedText = merged.trim();
        const minLength = requirement.length * 0.5;
        const maxLength = requirement.length * 3;
        if (mergedText.length >= minLength && mergedText.length <= maxLength) {
          logFn && logFn('[RequirementClarifier] ✅ Answers fused inline. Requirement updated.');
          return mergedText;
        } else if (mergedText.length < minLength) {
          logFn && logFn(`[RequirementClarifier] ⚠️  LLM merge result too short (${mergedText.length} vs min ${Math.round(minLength)}). Falling back to appendix.`);
        } else {
          logFn && logFn(`[RequirementClarifier] ⚠️  LLM merge result too long (${mergedText.length} vs max ${Math.round(maxLength)}). Possible hallucination. Falling back to appendix.`);
        }
      }
    } catch (err) {
      logFn && logFn(`[RequirementClarifier] ⚠️  LLM merge failed (${err.message}). Falling back to appendix.`);
    }
  }

  // Fallback: structured appendix (AnalystAgent will read and interpret it).
  // Detect the dominant language of the original requirement to keep the appendix
  // header consistent with the requirement's language (avoids a Chinese requirement
  // getting an English "## Clarifications" header that looks out of place).
  const chineseCharCount = (requirement.match(/[\u4e00-\u9fff]/g) || []).length;
  const isChinese = chineseCharCount / Math.max(requirement.length, 1) > 0.1;
  const round = qa[0]?._round ?? 1;
  const appendixHeader = isChinese
    ? `## 需求澄清（第 ${round} 轮）`
    : `## Clarifications (Round ${round})`;

  const clarificationBlock = [
    ``,
    `---`,
    appendixHeader,
    ``,
    ...qa.map(({ question, answer }, i) => [
      `**Q${i + 1}:** ${question}`,
      `**A${i + 1}:** ${answer}`,
      ``,
    ].join('\n')),
  ].join('\n');

  return requirement + clarificationBlock;
}

// ─── RequirementClarifier ─────────────────────────────────────────────────────

class RequirementClarifier {
  /**
   * @param {object} options
   * @param {Function} options.askUser
   *   async (questions: string[]) => string[]
   *   Called with an array of question strings; must return an array of answer strings.
   *   If null/undefined, clarification is skipped (non-interactive mode).
   * @param {number} [options.maxRounds=2]
   *   Max clarification rounds before proceeding with risk notes.
   * @param {boolean} [options.verbose=true]
   * @param {Function} [options.llmCall]
   *   async (prompt: string) => string
   *   If provided, uses LLM semantic detection to understand context and reduce false positives.
   *   Falls back to regex detection if not provided or if LLM call fails.
   *   Semantic mode advantages over regex:
   *   - Understands domain terms ("风险提示功能" ≠ unmitigated risk)
   *   - Detects implicit gaps regex cannot find ("做个好用的界面")
   *   - Avoids false positives on explicit design decisions ("默认3条命")
   */
  constructor({ askUser = null, maxRounds = 2, verbose = true, llmCall = null } = {}) {
    this.askUser = askUser;
    this.maxRounds = maxRounds;
    this.verbose = verbose;
    this.llmCall = llmCall;
  }

  /**
   * Runs the clarification loop on a raw requirement string.
   *
   * @param {string} rawRequirement
   * @returns {Promise<ClarificationResult>}
   */
  async clarify(rawRequirement) {
    // Non-interactive mode: skip clarification
    if (typeof this.askUser !== 'function') {
      this._log(`[RequirementClarifier] No askUser callback – skipping clarification (non-interactive mode).`);
      return {
        enrichedRequirement: rawRequirement,
        rounds: 0,
        allSignals: [],
        riskNotes: [],
        skipped: true,
      };
    }

    let current = rawRequirement;
    let round = 0;
    const allSignals = [];
    const riskNotes = [];
    // N47 fix: track whether the loop exited because the requirement became clean
    // (signals.length === 0). Any other break (askUser error, no answers) is NOT a
    // clean exit – remaining high-severity signals must still be reported as risks.
    let cleanExit = false;
    // N52 fix: track the signal count of the last round so we can slice allSignals
    // precisely to get only the last-round signals (not signals from earlier rounds
    // that were already addressed by user answers).
    let lastRoundSignalCount = 0;

    this._log(`\n╔══════════════════════════════════════════════════════════╗`);
    this._log(`║  💬 REQUIREMENT CLARIFICATION                            ║`);
    this._log(`╚══════════════════════════════════════════════════════════╝`);

    while (round < this.maxRounds) {
      round++;
      const signals = await detectRequirementSignals(current, this.llmCall, this._log.bind(this));

      if (signals.length === 0) {
        this._log(`\n[RequirementClarifier] ✅ Round ${round - 1}: Requirement is clear. No questions needed.\n`);
        cleanExit = true; // N47 fix: mark as clean exit so remaining-signal check is skipped
        break;
      }

      this._log(`\n[RequirementClarifier] 🔍 Round ${round}/${this.maxRounds}: ${signals.length} signal(s) detected:`);
      signals.forEach(s => this._log(`  • [${s.severity}] ${s.label}`));
      allSignals.push(...signals);
      lastRoundSignalCount = signals.length; // N52 fix: record this round's signal count

      const qaPairs = buildClarificationQuestions(signals);
      const questions = qaPairs.map(q => q.question);

      this._log(`[RequirementClarifier] 💬 Asking user ${questions.length} clarification question(s)...`);

      let answers;
      try {
        answers = await this.askUser(questions);
      } catch (err) {
        this._log(`[RequirementClarifier] ⚠️  askUser failed: ${err.message}. Proceeding with risk notes.`);
        signals.forEach(s => riskNotes.push(`[${s.severity}] ${s.label} – not clarified (askUser error)`));
        break;
      }

      // Validate answers array
      if (!Array.isArray(answers) || answers.length === 0) {
        this._log(`[RequirementClarifier] ⚠️  No answers received. Proceeding with risk notes.`);
        signals.forEach(s => riskNotes.push(`[${s.severity}] ${s.label} – not clarified (no answer)`));
        break;
      }

      // Build Q&A pairs with answers
      const qa = qaPairs.map((qp, i) => ({
        question: qp.question,
        answer: answers[i] ?? '(no answer)',
        _round: round,
      }));

      current = await mergeAnswers(current, qa, this.llmCall, this._log.bind(this));
      this._log(`[RequirementClarifier] ✏️  Round ${round} complete. Requirement enriched with ${qa.length} answer(s).`);
    }

    // Final signal check – record any remaining high-severity signals as risks.
    // N47 fix: use cleanExit flag instead of (round >= maxRounds) to distinguish:
    //   - cleanExit = true  → signals.length === 0, requirement is clear, nothing to check
    //   - cleanExit = false → loop exhausted maxRounds OR askUser failed/returned no answers
    //     In both cases, the last-round signals are still unresolved and must be reported.
    // N52 fix: use lastRoundSignalCount to slice only the last round's signals from
    //   allSignals. allSignals accumulates across ALL rounds, so allSignals.slice(-5)
    //   could include signals from earlier rounds that were already addressed by user
    //   answers, causing duplicate riskNotes. Slicing by lastRoundSignalCount is precise.
    const remaining = cleanExit
      ? []
      : allSignals.slice(lastRoundSignalCount > 0 ? -lastRoundSignalCount : -5);
    const highRemaining = remaining.filter(s => s.severity === 'high');
    if (highRemaining.length > 0) {
      this._log(`[RequirementClarifier] ⚠️  ${highRemaining.length} high-severity signal(s) remain after ${round} round(s). Recording as risks.`);
      highRemaining.forEach(s => riskNotes.push(`[Requirement] ${s.label} – unresolved after ${round} clarification round(s).`));
    }

    return {
      enrichedRequirement: current,
      rounds: round,
      allSignals,
      riskNotes,
      skipped: false,
    };
  }

  _log(msg) {
    if (this.verbose) console.log(msg);
  }
}

/**
 * @typedef {object} ClarificationResult
 * @property {string}   enrichedRequirement  - Requirement text enriched with Q&A answers
 * @property {number}   rounds               - Number of clarification rounds performed
 * @property {object[]} allSignals           - All signals detected across all rounds
 * @property {string[]} riskNotes            - Risk notes for unresolved signals
 * @property {boolean}  skipped              - True if clarification was skipped (non-interactive)
 */

module.exports = { RequirementClarifier, buildClarificationQuestions, mergeAnswers };
