/**
 * Observability – Runtime metrics collection for the workflow.
 *
 * Tracks per-stage timing, LLM call counts, estimated token usage,
 * error counts, and test results. Writes a structured JSON report to
 * output/run-metrics.json at the end of each session.
 *
 * Cross-session history: appends each session record to
 * output/metrics-history.jsonl (one JSON object per line) for trend analysis.
 * Use Observability.loadHistory() to read and analyse historical data.
 *
 * P1-4 fix: Strategy derivation (deriveStrategy, computeTrends,
 * estimateTaskComplexity, loadHistory) has been extracted to
 * observability-strategy.js to separate collection from analysis.
 * Static methods on this class remain as backward-compatible proxies.
 *
 * Design: zero-dependency, zero-side-effect on existing code.
 * Integration: Orchestrator calls obs.stageStart/stageEnd around each
 * _runStage call, and obs.recordLlmCall inside the wrappedLlm closure.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const ObsStrategy = require('./observability-strategy');

/**
 * Compute a fast SHA-256 hex hash of a string.
 * Used by prompt tracing to generate a deterministic fingerprint
 * for dedup and cross-session lookup without storing the full text.
 *
 * @param {string} text
 * @returns {string} 64-char hex hash
 */
function _quickHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

class Observability {
  /**
   * @param {string} outputDir  - Directory to write run-metrics.json
   * @param {string} projectId  - Project identifier
   */
  constructor(outputDir, projectId) {
    this._outputDir  = outputDir;
    this._projectId  = projectId;
    this._sessionId  = `${projectId}-${Date.now()}`;
    this._startedAt  = Date.now();

    /** @type {Map<string, {start:number, end?:number, status?:string}>} */
    this._stages = new Map();

    /** @type {{role:string, estimatedTokens:number, ts:number}[]} */
    this._llmCalls = [];

    /** @type {{stage:string, message:string, ts:number}[]} */
    this._errors = [];

    /** @type {{passed:number, failed:number, skipped:number, rounds:number}|null} */
    this._testResult = null;

    /** @type {{violations:number, filesScanned:number, reportPath:string|null}|null} */
    this._entropyResult = null;

    /** @type {{status:string, provider:string, steps:object[], durationMs:number}|null} */
    this._ciResult = null;

    /** @type {{symbolCount:number, fileCount:number, edgeCount:number}|null} */
    this._codeGraphResult = null;

    /**
     * Experience injection & hit tracking for deriveStrategy Rule 4.
     * Populated by recordExpUsage() calls from orchestrator-stages.js.
     *
     * injectedCount: total number of experience IDs injected into agent prompts
     *   this session (sum of ids.length across all getContextBlockWithIds calls).
     * hitCount: total number of those injected experiences that were later
     *   confirmed effective via markUsedBatch() (i.e. the downstream task succeeded).
     *
     * hitRate = hitCount / injectedCount tells deriveStrategy whether the
     * experience store is actually helping or just adding prompt noise.
     */
    this._expInjectedCount = 0;
    this._expHitCount = 0;

    /**
     * Skill injection tracking for Skill Lifecycle Management.
     * Populated by recordSkillUsage() calls from prompt-builder.js.
     *
     * injectedSkills: Map of skill names → injection count this session.
     * effectiveSkills: Set of skill names confirmed effective (stage passed
     *   after skill was injected). Populated by markSkillEffective().
     *
     * Cross-session analysis enables:
     *   - Skill-level hit-rate (effective / injected)
     *   - Stale skill detection (injected but never effective)
     *   - Skill retirement recommendations
     *
     * @type {Map<string, number>}
     */
    this._skillInjectedCounts = new Map();
    /** @type {Set<string>} */
    this._skillEffectiveSet = new Set();

    /**
     * Defect G fix: Clarification quality metrics tracking.
     * Populated by recordClarificationQuality() from orchestrator-stages.js.
     *
     * Enables deriveStrategy() Rule 5 to adjust maxClarificationRounds based
     * on whether clarification is actually improving requirement quality.
     *
     * @type {{ textChangePct: number, effectivenessScore: number, highSeverityResolved: number, highSeverityInitial: number, rounds: number }|null}
     */
    this._clarificationQuality = null;

    /**
     * Defect J fix: Task complexity score for the current session.
     * Populated by recordTaskComplexity() from orchestrator-stages.js after
     * the ANALYSE stage produces the enriched requirement.
     *
     * Enables deriveStrategy() Rule 6 to scale maxFixRounds and maxReviewRounds
     * based on the actual difficulty of the current task, rather than relying
     * solely on historical success rates (which are biased towards the historical
     * mix of simple/complex tasks).
     *
     * @type {{ score: number, level: string, factors: object }|null}
     */
    this._taskComplexity = null;

    /**
     * Prompt A/B testing: variant usage stats for the current session.
     * Populated by recordPromptVariantUsage() from orchestrator-stages.js.
     * Written to metrics-history.jsonl by flush() for cross-session analysis.
     *
     * @type {object|null}
     */
    this._promptVariantStats = null;

    /**
     * Adapter Telemetry: per-block lifecycle tracking.
     * Populated by AdapterTelemetry instance shared across context builders.
     * Written to run-metrics.json and metrics-history.jsonl by flush().
     *
     * @type {object|null}
     */
    this._blockTelemetry = null;

    /**
     * P1 Tool Search Optimisation: plugin skip statistics.
     * Tracks how many plugins were skipped by keyword pre-filtering vs executed.
     * Populated by recordToolSearchStats() from context builders.
     *
     * @type {{ totalPlugins: number, skippedByKeyword: number, skippedBySmartContext: number, executed: number, stages: object }|null}
     */
    this._toolSearchStats = null;

    /**
     * P1 Programmatic Tool Calling: ToolResultFilter statistics.
     * Tracks how many characters were saved by pre-filtering adapter results.
     * Populated by recordToolResultFilterStats() from context builders.
     *
     * @type {{ totalSaved: number, filteredBlocks: number, strategies: object }|null}
     */
    this._toolResultFilterStats = null;

    /**
     * Self-Reflection Engine: gating results from the current session.
     * Populated by validateRun() at flush time.
     *
     * @type {{ passed: boolean, failedGates: string[], gateCount: number }|null}
     */
    this._reflectionGating = null;

    /**
     * P0 Prompt Tracing: captures a digest of every LLM prompt sent this session.
     *
     * Each entry stores:
     *   - role: agent role (analyst/architect/developer/tester/__internal)
     *   - ts: timestamp in ms
     *   - promptHash: SHA-256 hex digest of the full prompt text (for dedup & lookup)
     *   - promptHead: first 500 chars of the prompt (for quick inspection)
     *   - promptTail: last 200 chars of the prompt (to see the actual instruction)
     *   - promptLength: total character length of the full prompt
     *   - estimatedTokens: token estimate
     *
     * Rationale (from "24h 打工人" article review): without prompt traces,
     * SelfReflectionEngine cannot diagnose WHY a stage degraded — was it the
     * prompt that changed, or the model output? Prompt A/B comparison also
     * requires input data.
     *
     * Storage: written to output/prompt-traces.jsonl (separate from run-metrics
     * to avoid bloating the main metrics file). One JSON object per line.
     *
     * @type {Array<{role:string, ts:number, promptHash:string, promptHead:string, promptTail:string, promptLength:number, estimatedTokens:number}>}
     */
    this._promptTraces = [];
  }

  // ─── Stage Tracking ───────────────────────────────────────────────────────

  /** Mark the start of a workflow stage. */
  stageStart(stageName) {
    this._stages.set(stageName, { start: Date.now() });
  }

  /** Mark the end of a workflow stage with a status. */
  stageEnd(stageName, status = 'ok') {
    const entry = this._stages.get(stageName) || { start: Date.now() };
    entry.end    = Date.now();
    entry.status = status;
    entry.durationMs = entry.end - entry.start;
    this._stages.set(stageName, entry);
  }

  // ─── LLM Call Tracking ────────────────────────────────────────────────────

  /**
   * Record a single LLM call with estimated token count and optional prompt digest.
   *
   * P0 Enhancement: accepts an optional `promptText` parameter. When provided,
   * a compact digest is stored in `_promptTraces[]` for later analysis by
   * SelfReflectionEngine and cross-session prompt A/B comparison.
   *
   * The full prompt is NEVER stored — only a hash + head + tail + length.
   * This keeps storage bounded while enabling meaningful debugging.
   *
   * @param {string} role            - Agent role (analyst / architect / developer / tester)
   * @param {number} estimatedTokens - Token estimate from buildAgentPrompt
   * @param {string} [promptText]    - Optional: full prompt text for digest extraction
   */
  recordLlmCall(role, estimatedTokens = 0, promptText) {
    const ts = Date.now();
    this._llmCalls.push({ role, estimatedTokens, actualTokens: null, ts });

    // P0 Prompt Tracing: store compact digest if prompt text is provided
    if (promptText && typeof promptText === 'string' && promptText.length > 0) {
      const promptHash = _quickHash(promptText);
      const promptLength = promptText.length;
      const promptHead = promptText.slice(0, 500);
      const promptTail = promptLength > 700 ? promptText.slice(-200) : '';
      this._promptTraces.push({
        role,
        ts,
        promptHash,
        promptHead,
        promptTail,
        promptLength,
        estimatedTokens,
      });
    }
  }

  /**
   * Update the last LLM call record with actual token usage returned by the LLM API.
   *
   * Problem it solves (P2-A):
   *   estimatedTokens is a rough heuristic from buildAgentPrompt (char count / 4).
   *   The actual token count from the LLM API (usage.total_tokens) is the ground truth.
   *   Without it, we cannot do cost budgeting, identify token black holes, or run
   *   prompt A/B tests with accurate measurements.
   *
   * Usage:
   *   const response = await this._rawLlmCall(prompt);
   *   const actual = response?.usage?.total_tokens ?? null;
   *   this.obs.recordActualTokens(role, actual);
   *
   * @param {string}      role         - Agent role (must match the last recordLlmCall role)
   * @param {number|null} actualTokens - Actual token count from LLM API, or null if unavailable
   */
  recordActualTokens(role, actualTokens) {
    if (actualTokens == null) return;
    // Walk backwards to find the most recent call for this role
    for (let i = this._llmCalls.length - 1; i >= 0; i--) {
      if (this._llmCalls[i].role === role) {
        this._llmCalls[i].actualTokens = actualTokens;
        return;
      }
    }
  }

  // ─── Error Tracking ───────────────────────────────────────────────────────

  /** Record a workflow error. */
  recordError(stage, message) {
    this._errors.push({ stage, message, ts: Date.now() });
  }

  // ─── P1 Recovery Hook: Stage Retry Tracking ──────────────────────────────

  /**
   * Records a stage retry event for cross-session analysis.
   * Called by _runStage() when a transient error triggers an automatic retry.
   *
   * @param {string} stageLabel - e.g. 'INIT→ANALYSE'
   * @param {number} attempt    - retry attempt number (1-based)
   * @param {string} errorMsg   - the error message that triggered the retry
   */
  recordStageRetry(stageLabel, attempt, errorMsg) {
    if (!this._stageRetries) {
      this._stageRetries = [];
    }
    this._stageRetries.push({
      stage: stageLabel,
      attempt,
      error: (errorMsg || '').slice(0, 200),
      ts: Date.now(),
    });
    console.log(`[Observability] 🔄 Stage retry recorded: ${stageLabel} attempt ${attempt} (${errorMsg.slice(0, 80)})`);
  }

  // ─── Test Result ──────────────────────────────────────────────────────────

  /** Record the final test execution result. */
  recordTestResult({ passed = 0, failed = 0, skipped = 0, rounds = 1 } = {}) {
    this._testResult = { passed, failed, skipped, rounds };
  }

  // ─── Entropy Result ───────────────────────────────────────────────────────

  /** Record the entropy GC scan result. */
  recordEntropyResult({ violations = 0, filesScanned = 0, reportPath = null } = {}) {
    this._entropyResult = { violations, filesScanned, reportPath };
  }

  /** Record the CI pipeline result. */
  recordCIResult({ status = 'unknown', provider = 'local', steps = [], durationMs = 0 } = {}) {
    this._ciResult = { status, provider, steps, durationMs };
  }

  /** Record the code graph build result. */
  recordCodeGraphResult({ symbolCount = 0, fileCount = 0, edgeCount = 0 } = {}) {
    this._codeGraphResult = { symbolCount, fileCount, edgeCount };
  }

  /**
   * Records experience injection and hit counts for this session.
   *
   * Call this from orchestrator-stages.js at two points:
   *   1. After getContextBlockWithIds(): recordExpUsage({ injected: ids.length })
   *   2. After markUsedBatch() succeeds: recordExpUsage({ hits: triggerCount })
   *
   * The accumulated injectedCount and hitCount are written to metrics-history.jsonl
   * by flush(), enabling deriveStrategy() to compute a cross-session hit rate and
   * adjust maxExpInjected accordingly.
   *
   * @param {object} options
   * @param {number} [options.injected=0] - Number of experience IDs injected this call
   * @param {number} [options.hits=0]     - Number of those IDs confirmed effective
   */
  recordExpUsage({ injected = 0, hits = 0 } = {}) {
    this._expInjectedCount += injected;
    this._expHitCount += hits;
  }

  /**
   * Records which skills were injected into an agent prompt this call.
   * Called by prompt-builder.js after ContextLoader.resolve().
   *
   * @param {string[]} skillNames - Names of skills injected (from sources)
   */
  recordSkillUsage(skillNames) {
    if (!skillNames || skillNames.length === 0) return;
    for (const name of skillNames) {
      // Normalise: extract skill filename from source strings like "flutter-dev.md"
      const normalised = name.replace(/\.md$/, '').replace(/\s*\(.*\)$/, '');
      if (!normalised) continue;
      this._skillInjectedCounts.set(
        normalised,
        (this._skillInjectedCounts.get(normalised) || 0) + 1
      );
    }
  }

  /**
   * Marks skills as effective for this session.
   * Called after a stage passes QualityGate when skills were injected.
   *
   * @param {string[]} skillNames - Names of skills confirmed effective
   */
  markSkillEffective(skillNames) {
    if (!skillNames || skillNames.length === 0) return;
    for (const name of skillNames) {
      const normalised = name.replace(/\.md$/, '').replace(/\s*\(.*\)$/, '');
      if (normalised) this._skillEffectiveSet.add(normalised);
    }
  }

  /**
   * Defect G fix: Records clarification quality metrics for this session.
   * Called by orchestrator-stages.js after RequirementClarifier.clarify() completes.
   *
   * @param {object} metrics - ClarificationQualityMetrics from RequirementClarifier
   * @param {number} rounds  - Number of clarification rounds performed
   */
  recordClarificationQuality(metrics, rounds = 0) {
    if (!metrics) return;
    this._clarificationQuality = {
      textChangePct:       metrics.textChangePct,
      effectivenessScore:  metrics.effectivenessScore,
      highSeverityResolved: metrics.highSeverityResolved,
      highSeverityInitial: metrics.highSeverityInitial,
      totalSignalsResolved: metrics.totalSignalsResolved,
      totalSignalsInitial: metrics.totalSignalsInitial,
      newSignalsIntroduced: metrics.newSignalsIntroduced,
      rounds,
    };
  }

  // ─── Task Complexity Estimation (Defect J fix) ────────────────────────────

  /**
   * Defect J fix: Records the task complexity assessment for this session.
   * Called by orchestrator-stages.js at the end of ANALYSE stage, after the
   * enriched requirement is available.
   *
   * @param {object} complexity - From Observability.estimateTaskComplexity()
   */
  recordTaskComplexity(complexity) {
    if (!complexity) return;
    this._taskComplexity = complexity;
    console.log(`[Observability] 📊 Task complexity: ${complexity.level} (score=${complexity.score}/100)`);
  }

  /**
   * Records prompt variant usage stats for the current session.
   * Called by the Orchestrator at flush time to snapshot the PromptSlotManager stats.
   *
   * @param {object} stats - From PromptSlotManager.getStats()
   */
  recordPromptVariantUsage(stats) {
    if (!stats || Object.keys(stats).length === 0) return;
    this._promptVariantStats = stats;
  }

  /**
   * Records adapter block telemetry data for this session.
   * Called by the Orchestrator at flush time with the AdapterTelemetry report.
   *
   * @param {object} telemetryReport - From AdapterTelemetry.getReport()
   */
  recordBlockTelemetry(telemetryReport) {
    if (!telemetryReport) return;
    this._blockTelemetry = telemetryReport;
  }

  // ─── P1 Tool Search: Plugin Skip Statistics ─────────────────────────────

  /**
   * Records plugin skip statistics from AdapterPluginRegistry.collectPluginBlocks().
   * Call this from each context builder after collectPluginBlocks() returns.
   *
   * @param {string} stage - Stage name (ARCHITECT, DEVELOPER, TESTER)
   * @param {object} stats
   * @param {number}   stats.totalPlugins       - Total plugins registered for this stage
   * @param {string[]} stats.skippedByKeyword    - Plugin names skipped by keyword filter
   * @param {number}   stats.executedCount       - Plugins that actually executed
   */
  recordToolSearchStats(stage, stats) {
    if (!stats) return;
    if (!this._toolSearchStats) {
      this._toolSearchStats = { totalPlugins: 0, skippedByKeyword: 0, skippedBySmartContext: 0, executed: 0, stages: {} };
    }
    const stageStats = {
      totalPlugins: stats.totalPlugins || 0,
      skippedByKeyword: (stats.skippedByKeyword || []).length,
      skippedNames: stats.skippedByKeyword || [],
      executedCount: stats.executedCount || 0,
    };
    this._toolSearchStats.stages[stage] = stageStats;
    this._toolSearchStats.totalPlugins += stageStats.totalPlugins;
    this._toolSearchStats.skippedByKeyword += stageStats.skippedByKeyword;
    this._toolSearchStats.executed += stageStats.executedCount;
  }

  // ─── P1 Programmatic Tool Calling: ToolResultFilter Statistics ──────────

  /**
   * Records ToolResultFilter statistics from _applyTokenBudget().
   * Call this from context builders after _applyTokenBudget() returns.
   *
   * @param {string} stage - Stage name
   * @param {object} stats
   * @param {number}   stats.preFilterSaved   - Characters saved by ToolResultFilter
   * @param {string[]} stats.filteredLabels    - Labels of blocks that were filtered
   */
  recordToolResultFilterStats(stage, stats) {
    if (!stats) return;
    if (!this._toolResultFilterStats) {
      this._toolResultFilterStats = { totalSaved: 0, filteredBlocks: 0, stages: {} };
    }
    this._toolResultFilterStats.stages[stage] = {
      charsSaved: stats.preFilterSaved || 0,
      filteredLabels: stats.filteredLabels || [],
    };
    this._toolResultFilterStats.totalSaved += (stats.preFilterSaved || 0);
    this._toolResultFilterStats.filteredBlocks += (stats.filteredLabels || []).length;
  }

  // ─── Custom Metrics Recording ───────────────────────────────────────────

  /**
   * Records a custom metric for extensibility.
   * Used by Sleeptime pipeline and other extensions.
   *
   * @param {string} name - Metric name
   * @param {object} value - Metric value
   */
  recordCustomMetric(name, value) {
    if (!this._customMetrics) {
      this._customMetrics = {};
    }
    this._customMetrics[name] = value;
  }

  // ─── RunGuard Summary Recording ─────────────────────────────────────────

  /**
   * Records the RunGuard summary for cross-session cost analysis.
   * Called by orchestrator-lifecycle.js during _finalizeWorkflow().
   *
   * @param {object} summary - From RunGuard.getSummary()
   */
  recordRunGuardSummary(summary) {
    if (!summary) return;
    this._runGuardSummary = {
      totalCalls: summary.totalCalls || 0,
      totalTokens: summary.totalTokens || 0,
      estimatedCost: summary.estimatedCost || 0,
      tierDowngrades: summary.tierDowngrades || 0,
    };
  }

  // ─── Self-Reflection: Gating Result Recording ──────────────────────────

  /**
   * Records the self-reflection gating result for this session.
   * Called by the Orchestrator after SelfReflectionEngine.validateRun().
   *
   * @param {object} gatingResult - From SelfReflectionEngine.validateRun()
   */
  recordReflectionGating(gatingResult) {
    if (!gatingResult) return;
    this._reflectionGating = {
      passed: gatingResult.passed,
      failedGates: gatingResult.gates?.filter(g => !g.passed).map(g => g.name) || [],
      gateCount: gatingResult.gates?.length || 0,
    };
  }

  /**
   * P1-4 fix: Proxy to observability-strategy.js (backward compatible).
   * @see observability-strategy.js#estimateTaskComplexity
   */
  static estimateTaskComplexity(requirementText) {
    return ObsStrategy.estimateTaskComplexity(requirementText);
  }

  // ─── Prompt Tracing ─────────────────────────────────────────────────────────

  /**
   * Returns a compact summary of prompt traces for the current session.
   * Useful for SelfReflectionEngine to compare prompts across sessions.
   *
   * @returns {{ totalCalls: number, uniquePrompts: number, byRole: Object<string, number>, avgPromptLength: number }}
   */
  getPromptTraceSummary() {
    const byRole = {};
    const hashes = new Set();
    let totalLength = 0;

    for (const trace of this._promptTraces) {
      byRole[trace.role] = (byRole[trace.role] || 0) + 1;
      hashes.add(trace.promptHash);
      totalLength += trace.promptLength;
    }

    return {
      totalCalls: this._promptTraces.length,
      uniquePrompts: hashes.size,
      byRole,
      avgPromptLength: this._promptTraces.length > 0
        ? Math.round(totalLength / this._promptTraces.length)
        : 0,
    };
  }

  /**
   * Flush prompt trace digests to output/prompt-traces.jsonl.
   *
   * Written as a separate file from run-metrics.json because:
   *   1. Prompt traces can be large (hundreds of entries per session)
   *   2. They're append-only (like metrics-history.jsonl)
   *   3. They serve a different audience: debugging & prompt engineering
   *      vs. performance monitoring
   *
   * Each line is a JSON object: { sessionId, role, ts, promptHash, promptHead,
   * promptTail, promptLength, estimatedTokens }.
   *
   * The file is append-only: each session appends its traces to the same file,
   * enabling cross-session prompt drift analysis.
   *
   * @returns {number} Number of traces written
   */
  flushPromptTraces() {
    if (this._promptTraces.length === 0) return 0;

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      const tracePath = path.join(this._outputDir, 'prompt-traces.jsonl');
      const lines = this._promptTraces.map(trace => JSON.stringify({
        sessionId: this._sessionId,
        ...trace,
      })).join('\n') + '\n';

      // Atomic append: write to tmp first, then append
      const tmpPath = tracePath + '.tmp';
      fs.writeFileSync(tmpPath, lines, 'utf-8');
      fs.appendFileSync(tracePath, lines, 'utf-8');
      try { fs.unlinkSync(tmpPath); } catch (_) { /* cleanup best-effort */ }

      console.log(`[Observability] 📝 Flushed ${this._promptTraces.length} prompt trace(s) to ${tracePath}`);
      return this._promptTraces.length;
    } catch (err) {
      console.warn(`[Observability] ⚠️  Failed to flush prompt traces: ${err.message}`);
      return 0;
    }
  }

  // ─── Report Generation ────────────────────────────────────────────────────

  /**
   * Returns a read-only snapshot of current session metrics WITHOUT writing
   * to disk. Used by SelfReflectionEngine to validate quality gates before
   * the final flush() call.
   *
   * @returns {object} Current metrics snapshot (same shape as flush() output)
   */
  getMetricsSnapshot() {
    const totalMs = Date.now() - this._startedAt;
    const totalTokensEst    = this._llmCalls.reduce((s, c) => s + (c.estimatedTokens || 0), 0);
    const totalTokensActual = this._llmCalls.reduce((s, c) => s + (c.actualTokens || 0), 0);
    const callsByRole  = {};
    const tokensByRole = {};
    for (const c of this._llmCalls) {
      callsByRole[c.role]  = (callsByRole[c.role]  || 0) + 1;
      tokensByRole[c.role] = (tokensByRole[c.role] || 0) + (c.actualTokens || c.estimatedTokens || 0);
    }
    const stagesArr = [];
    for (const [name, entry] of this._stages) {
      stagesArr.push({ name, ...entry });
    }
    return {
      sessionId:      this._sessionId,
      projectId:      this._projectId,
      startedAt:      new Date(this._startedAt).toISOString(),
      totalDurationMs: totalMs,
      stages:         stagesArr,
      llm: {
        totalCalls:      this._llmCalls.length,
        totalTokensEst:  totalTokensEst,
        totalTokensActual: totalTokensActual > 0 ? totalTokensActual : null,
        callsByRole,
        tokensByRole,
      },
      errors: {
        count:   this._errors.length,
        details: this._errors,
      },
      testResult:      this._testResult,
      blockTelemetry:  this._blockTelemetry,
      reflectionGating: this._reflectionGating,
      // P0 Prompt Tracing: compact summary of prompt traces for this session
      promptTraceSummary: this.getPromptTraceSummary(),
    };
  }

  /**
   * Builds the metrics object and writes it to output/run-metrics.json.
   * Safe to call multiple times (overwrites previous report for this session).
   * @returns {object} The metrics object
   */
  flush() {
    const totalMs      = Date.now() - this._startedAt;
    const totalTokensEst    = this._llmCalls.reduce((s, c) => s + (c.estimatedTokens || 0), 0);
    const totalTokensActual = this._llmCalls.reduce((s, c) => s + (c.actualTokens || 0), 0);
    const callsByRole  = {};
    const tokensByRole = {};
    for (const c of this._llmCalls) {
      callsByRole[c.role]  = (callsByRole[c.role]  || 0) + 1;
      tokensByRole[c.role] = (tokensByRole[c.role] || 0) + (c.actualTokens || c.estimatedTokens || 0);
    }

    const stagesArr = [];
    for (const [name, entry] of this._stages) {
      stagesArr.push({ name, ...entry });
    }

    const metrics = {
      sessionId:      this._sessionId,
      projectId:      this._projectId,
      startedAt:      new Date(this._startedAt).toISOString(),
      finishedAt:     new Date().toISOString(),
      totalDurationMs: totalMs,
      stages:         stagesArr,
      llm: {
        totalCalls:      this._llmCalls.length,
        totalTokensEst:  totalTokensEst,
        totalTokensActual: totalTokensActual > 0 ? totalTokensActual : null,
        callsByRole,
        tokensByRole,
      },
      errors: {
        count:   this._errors.length,
        details: this._errors,
      },
      testResult:      this._testResult,
      entropyResult:   this._entropyResult,
      ciResult:        this._ciResult,
      codeGraphResult: this._codeGraphResult,
      // Defect G fix: clarification quality metrics for deriveStrategy Rule 5
      clarificationQuality: this._clarificationQuality,
      // Defect J fix: task complexity assessment for deriveStrategy Rule 6
      taskComplexity: this._taskComplexity,
      // Adapter telemetry: per-block lifecycle tracking
      blockTelemetry: this._blockTelemetry,
      // P1 Tool Search: plugin skip statistics (quantitative baseline)
      toolSearchStats: this._toolSearchStats,
      // P1 Programmatic Tool Calling: ToolResultFilter savings
      toolResultFilterStats: this._toolResultFilterStats,
      // Self-Reflection: quality gate results
      reflectionGating: this._reflectionGating,
      // P0 Prompt Tracing: compact summary (full traces in prompt-traces.jsonl)
      promptTraceSummary: this.getPromptTraceSummary(),
      // Skill Lifecycle: per-skill injection and effectiveness tracking
      skillUsage: this._skillInjectedCounts.size > 0 ? {
        injected: Object.fromEntries(this._skillInjectedCounts),
        effective: [...this._skillEffectiveSet],
        totalInjected: [...this._skillInjectedCounts.values()].reduce((s, c) => s + c, 0),
        totalEffective: this._skillEffectiveSet.size,
      } : null,
    };

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      // Overwrite latest session snapshot
      const outPath = path.join(this._outputDir, 'run-metrics.json');
      fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2), 'utf-8');

      // Append to cross-session history (JSONL format)
      // ── Defect #6 fix: atomic append to metrics-history.jsonl ────────────────
      // Previously used appendFileSync() directly. If the process crashed mid-write,
      // a partial JSON line would be written, causing JSON.parse() to throw in
      // loadHistory() and silently returning [] (all history lost).
      // Fix: write the new line to a .tmp file first, then read-append-write the
      // full history file atomically via writeFileSync (overwrite). This ensures
      // the file is always a valid sequence of complete JSON lines.
      const historyPath = path.join(this._outputDir, 'metrics-history.jsonl');
      const historyLine = JSON.stringify({
        sessionId:       metrics.sessionId,
        projectId:       metrics.projectId,
        startedAt:       metrics.startedAt,
        totalDurationMs: metrics.totalDurationMs,
        llmCalls:        metrics.llm.totalCalls,
        tokensEst:       metrics.llm.totalTokensEst,
        tokensActual:    metrics.llm.totalTokensActual,
        errorCount:      metrics.errors.count,
        testPassed:      metrics.testResult?.passed ?? null,
        testFailed:      metrics.testResult?.failed ?? null,
        entropyViolations: metrics.entropyResult?.violations ?? null,
        ciStatus:        metrics.ciResult?.status ?? null,
        codeGraphSymbols: metrics.codeGraphResult?.symbolCount ?? null,
        // Improvement 4: experience hit-rate tracking
        // expInjectedCount: how many experience IDs were injected into agent prompts
        // expHitCount: how many of those were confirmed effective (task succeeded)
        // hitRate = expHitCount / expInjectedCount → used by deriveStrategy Rule 4
        expInjectedCount: this._expInjectedCount,
        expHitCount:      this._expHitCount,
        // Defect G fix: clarification quality metrics for cross-session trend analysis
        // deriveStrategy Rule 5 reads these to adjust maxClarificationRounds
        clarificationEffectiveness: this._clarificationQuality?.effectivenessScore ?? null,
        clarificationRounds: this._clarificationQuality?.rounds ?? null,
        clarificationTextChangePct: this._clarificationQuality?.textChangePct ?? null,
        clarificationNewSignals: this._clarificationQuality?.newSignalsIntroduced ?? null,
        // Defect J fix: task complexity for cross-session complexity-aware strategy
        // deriveStrategy Rule 6 reads this to modulate maxFixRounds/maxReviewRounds
        // based on how complex the current task actually is, rather than relying only
        // on historical success rates (which are biased by the historical task mix).
        taskComplexityScore: this._taskComplexity?.score ?? null,
        taskComplexityLevel: this._taskComplexity?.level ?? null,
        // Prompt A/B testing: variant usage stats for cross-session tracking
        // promptVariantStats captures which variants were used and their outcomes
        // this session. Stored as { [slotKey]: { variantId, trials, passes } }.
        promptVariantStats: this._promptVariantStats ?? null,
        // Adapter telemetry: per-block lifecycle summary for cross-session analysis
        // blockTelemetry captures injection/truncation/drop/reference counts per block
        blockTelemetrySummary: this._blockTelemetry?.summary ?? null,
        blockTelemetryRecommendations: this._blockTelemetry?.recommendations ?? null,
        // P1 Tool Search: plugin skip stats for cross-session analysis
        toolSearchSkippedByKeyword: this._toolSearchStats?.skippedByKeyword ?? null,
        toolSearchTotalPlugins: this._toolSearchStats?.totalPlugins ?? null,
        toolSearchExecuted: this._toolSearchStats?.executed ?? null,
        // P1 ToolResultFilter: chars saved for cross-session analysis
        toolResultFilterSaved: this._toolResultFilterStats?.totalSaved ?? null,
        toolResultFilterBlocks: this._toolResultFilterStats?.filteredBlocks ?? null,
        // Self-Reflection: quality gate pass/fail for cross-session trends
        reflectionGatingPassed: this._reflectionGating?.passed ?? null,
        reflectionGatingFailedGates: this._reflectionGating?.failedGates ?? null,
        // P0 Prompt Tracing: summary stats for cross-session prompt drift analysis
        promptTraceCount: this._promptTraces.length,
        promptTraceUniqueCount: new Set(this._promptTraces.map(t => t.promptHash)).size,
        promptTraceAvgLength: this._promptTraces.length > 0
          ? Math.round(this._promptTraces.reduce((s, t) => s + t.promptLength, 0) / this._promptTraces.length)
          : null,
        // Skill Lifecycle: cross-session skill effectiveness tracking
        skillInjectedNames: this._skillInjectedCounts.size > 0 ? [...this._skillInjectedCounts.keys()] : null,
        skillInjectedTotal: this._skillInjectedCounts.size > 0 ? [...this._skillInjectedCounts.values()].reduce((s, c) => s + c, 0) : null,
        skillEffectiveNames: this._skillEffectiveSet.size > 0 ? [...this._skillEffectiveSet] : null,
        skillEffectiveCount: this._skillEffectiveSet.size > 0 ? this._skillEffectiveSet.size : null,
        // P1 Recovery Hook: stage retry tracking for cross-session analysis
        // Records how many transient errors were auto-recovered via retry.
        // Used by deriveStrategy to tune maxStageRetries budget.
        stageRetryCount: (this._stageRetries && this._stageRetries.length) || 0,
        stageRetries: (this._stageRetries && this._stageRetries.length > 0) ? this._stageRetries : null,
      }) + '\n';
      // R1-3 audit: optimised from read-full+append+write-full to atomic append.
      // The previous approach read the ENTIRE history file into memory, appended one line,
      // and wrote the whole file back. For long-running projects with hundreds of sessions,
      // this caused O(n) I/O on every flush. The new approach writes only the new line to
      // a tmp file, then atomically appends it via a two-step process:
      //   1. Write new line to tmp file
      //   2. Append tmp file content to history file using appendFileSync
      //   3. Clean up tmp file
      // If the append fails mid-write, only the new line is at risk (not the entire history).
      const historyTmpPath = historyPath + '.tmp';
      fs.writeFileSync(historyTmpPath, historyLine, 'utf-8');
      fs.appendFileSync(historyPath, historyLine, 'utf-8');
      try { fs.unlinkSync(historyTmpPath); } catch (_) { /* cleanup best-effort */ }
    } catch (err) {
      console.warn(`[Observability] Failed to write metrics: ${err.message}`);
    }

    return metrics;
  }

  // ─── Cross-Session History Analysis (P1-4: proxied to observability-strategy.js) ──

  /** @see observability-strategy.js#loadHistory */
  static loadHistory(outputDir) {
    return ObsStrategy.loadHistory(outputDir);
  }

  /** @see observability-strategy.js#computeTrends */
  static computeTrends(history) {
    return ObsStrategy.computeTrends(history);
  }

  /**
   * P1-4 fix: Proxy to observability-strategy.js (backward compatible).
   * @see observability-strategy.js#deriveStrategy
   */
  static deriveStrategy(outputDir, defaults = {}) {
    return ObsStrategy.deriveStrategy(outputDir, defaults);
  }

  /**
   * Prints a human-readable dashboard to stdout.
   * Call after flush() to display the session summary.
   */
  printDashboard() {
    const m = this.flush();
    const bar = '─'.repeat(58);
    console.log(`\n${bar}`);
    console.log(`  📊 WORKFLOW OBSERVABILITY DASHBOARD`);
    console.log(`  Session : ${m.sessionId}`);
    console.log(`  Duration: ${(m.totalDurationMs / 1000).toFixed(1)}s`);
    console.log(bar);

    // Stage timings
    console.log(`  Stages:`);
    for (const s of m.stages) {
      const icon   = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️ ';
      const dur    = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
      console.log(`    ${icon} ${s.name.padEnd(14)} ${dur}`);
    }

    // LLM usage
    const tokenDisplay = m.llm.totalTokensActual != null
      ? `${m.llm.totalTokensActual.toLocaleString()} actual (est: ~${m.llm.totalTokensEst.toLocaleString()})`
      : `~${m.llm.totalTokensEst.toLocaleString()} est.`;
    console.log(`  LLM Calls: ${m.llm.totalCalls} total | ${tokenDisplay} tokens`);
    for (const [role, cnt] of Object.entries(m.llm.callsByRole)) {
      const roleTokens = m.llm.tokensByRole?.[role] || 0;
      console.log(`    • ${role}: ${cnt} call(s), ~${roleTokens.toLocaleString()} tokens`);
    }

    // Errors
    if (m.errors.count > 0) {
      console.log(`  ⚠️  Errors: ${m.errors.count}`);
      for (const e of m.errors.details.slice(0, 3)) {
        console.log(`    [${e.stage}] ${e.message.slice(0, 80)}`);
      }
    }

    // Test result
    if (m.testResult) {
      const t = m.testResult;
      const icon = t.failed === 0 ? '✅' : '❌';
      console.log(`  ${icon} Tests: ${t.passed} passed / ${t.failed} failed / ${t.skipped} skipped (${t.rounds} round(s))`);
    }

    // Entropy
    if (m.entropyResult) {
      const e = m.entropyResult;
      const icon = e.violations === 0 ? '✅' : '⚠️ ';
      console.log(`  ${icon} Entropy GC: ${e.violations} violation(s) in ${e.filesScanned} files scanned`);
      if (e.reportPath) console.log(`    Report: ${e.reportPath}`);
    }

    // CI result
    if (m.ciResult) {
      const c    = m.ciResult;
      const icon = c.status === 'success' ? '✅' : c.status === 'failed' ? '❌' : '🔄';
      console.log(`  ${icon} CI [${c.provider}]: ${c.status} (${(c.durationMs / 1000).toFixed(1)}s)`);
    }

    // Code graph
    if (m.codeGraphResult) {
      const g = m.codeGraphResult;
      console.log(`  📊 Code Graph: ${g.symbolCount} symbols | ${g.edgeCount} call edges | ${g.fileCount} files`);
    }

    // P1 Tool Search stats
    if (m.toolSearchStats) {
      const ts = m.toolSearchStats;
      const skipRatio = ts.totalPlugins > 0 ? ((ts.skippedByKeyword / ts.totalPlugins) * 100).toFixed(0) : 0;
      console.log(`  🔍 Tool Search: ${ts.skippedByKeyword} of ${ts.totalPlugins} plugins skipped by keyword (${skipRatio}% savings)`);
    }

    // P1 ToolResultFilter stats
    if (m.toolResultFilterStats) {
      const trf = m.toolResultFilterStats;
      console.log(`  ✂️  ToolResultFilter: ${trf.totalSaved.toLocaleString()} chars saved across ${trf.filteredBlocks} block(s)`);
    }

    // Self-Reflection quality gates
    if (m.reflectionGating) {
      const rg = m.reflectionGating;
      const icon = rg.passed ? '✅' : '❌';
      console.log(`  ${icon} Quality Gates: ${rg.passed ? 'ALL PASSED' : `${rg.failedGates.length} of ${rg.gateCount} FAILED [${rg.failedGates.join(', ')}]`}`);
    }

    // Skill Lifecycle: injection & effectiveness
    if (m.skillUsage) {
      const su = m.skillUsage;
      const uniqueCount = Object.keys(su.injected).length;
      const injectedNames = Object.keys(su.injected).join(', ');
      console.log(`  📚 Skills: ${uniqueCount} unique skill(s) injected (${su.totalInjected} total), ${su.totalEffective} effective`);
      if (injectedNames) console.log(`    Injected: ${injectedNames}`);
      if (su.effective.length > 0) console.log(`    Effective: ${su.effective.join(', ')}`);
    }

    console.log(bar);
    console.log(`  Full metrics: output/run-metrics.json`);
    console.log(`  History:      output/metrics-history.jsonl`);
    console.log(`${bar}\n`);

    // Cross-session trend summary (if history exists)
    this._printTrendSummary();
  }


  // ─── HTML Report Generation ────────────────────────────────────────────────

  /**
   * Generates an interactive HTML report of the current session's metrics.
   * The report includes:
   *   - Session overview (duration, status, complexity)
   *   - Stage timeline (Gantt-style visualisation)
   *   - LLM call breakdown by role (bar chart + table)
   *   - Token usage analysis (estimated vs actual)
   *   - Error log with stage attribution
   *   - Test results, entropy scan, CI pipeline, code graph stats
   *   - Cross-session trend history (if available)
   *
   * The HTML is fully self-contained (no external CSS/JS dependencies) and
   * can be opened directly in any browser.
   *
   * @param {object} [options]
   * @param {object} [options.metrics]  - Pre-computed metrics (from flush()). If null, calls flush().
   * @param {string} [options.outputPath] - Override output path (default: output/session-report.html)
   * @returns {string} Absolute path to the generated HTML file
   */
  generateHTMLReport(options = {}) {
    const m = options.metrics || this.flush();
    const outputPath = options.outputPath || path.join(this._outputDir, 'session-report.html');

    // Load cross-session history for trend section
    let history = [];
    try {
      history = Observability.loadHistory(this._outputDir);
    } catch (err) { console.warn(`[Observability] Failed to load history: ${err.message}`); }

    const html = this._buildHTML(m, history);

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      fs.writeFileSync(outputPath, html, 'utf-8');
      console.log(`[Observability] 📊 HTML report generated: ${outputPath}`);
    } catch (err) {
      console.warn(`[Observability] Failed to write HTML report: ${err.message}`);
    }

    return outputPath;
  }

  /**
   * Builds the complete HTML string for the session report.
   * @private
   */
  _buildHTML(m, history) {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const dur = (ms) => ms != null ? `${(ms / 1000).toFixed(1)}s` : '–';
    const pct = (n, total) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';

    // ── Stage timeline data ──
    const stageRows = m.stages.map(s => {
      const statusClass = s.status === 'ok' ? 'status-ok' : s.status === 'error' ? 'status-error' : 'status-warn';
      const icon = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️';
      return `<tr>
        <td>${icon} ${esc(s.name)}</td>
        <td class="${statusClass}">${esc(s.status || '–')}</td>
        <td>${dur(s.durationMs)}</td>
        <td><div class="bar-container"><div class="bar ${statusClass}" style="width: ${m.totalDurationMs > 0 ? Math.max(2, (s.durationMs || 0) / m.totalDurationMs * 100) : 0}%"></div></div></td>
      </tr>`;
    }).join('\n');

    // ── LLM usage by role ──
    const roleEntries = Object.entries(m.llm.callsByRole || {});
    const maxRoleTokens = Math.max(1, ...Object.values(m.llm.tokensByRole || {}).map(Number));
    const llmRoleRows = roleEntries.map(([role, cnt]) => {
      const tokens = m.llm.tokensByRole?.[role] || 0;
      return `<tr>
        <td>${esc(role)}</td>
        <td>${cnt}</td>
        <td>~${tokens.toLocaleString()}</td>
        <td><div class="bar-container"><div class="bar bar-tokens" style="width: ${(tokens / maxRoleTokens) * 100}%"></div></div></td>
      </tr>`;
    }).join('\n');

    // ── Error details ──
    const errorRows = (m.errors.details || []).map(e => {
      return `<tr>
        <td>${esc(e.stage)}</td>
        <td>${esc(e.message)}</td>
        <td>${new Date(e.ts).toLocaleTimeString()}</td>
      </tr>`;
    }).join('\n');

    // ── Test result ──
    const testSection = m.testResult ? `
      <div class="card">
        <h3>${m.testResult.failed === 0 ? '✅' : '❌'} Test Results</h3>
        <table>
          <tr><td>Passed</td><td><strong>${m.testResult.passed}</strong></td></tr>
          <tr><td>Failed</td><td><strong>${m.testResult.failed}</strong></td></tr>
          <tr><td>Skipped</td><td>${m.testResult.skipped}</td></tr>
          <tr><td>Rounds</td><td>${m.testResult.rounds}</td></tr>
        </table>
      </div>` : '';

    // ── Entropy result ──
    const entropySection = m.entropyResult ? `
      <div class="card">
        <h3>${m.entropyResult.violations === 0 ? '✅' : '⚠️'} Entropy GC</h3>
        <table>
          <tr><td>Violations</td><td><strong>${m.entropyResult.violations}</strong></td></tr>
          <tr><td>Files Scanned</td><td>${m.entropyResult.filesScanned}</td></tr>
        </table>
      </div>` : '';

    // ── CI result ──
    const ciSection = m.ciResult ? `
      <div class="card">
        <h3>${m.ciResult.status === 'success' ? '✅' : '❌'} CI Pipeline [${esc(m.ciResult.provider)}]</h3>
        <table>
          <tr><td>Status</td><td><strong>${esc(m.ciResult.status)}</strong></td></tr>
          <tr><td>Duration</td><td>${dur(m.ciResult.durationMs)}</td></tr>
          <tr><td>Steps</td><td>${(m.ciResult.steps || []).length}</td></tr>
        </table>
      </div>` : '';

    // ── Code graph ──
    const graphSection = m.codeGraphResult ? `
      <div class="card">
        <h3>📊 Code Graph</h3>
        <table>
          <tr><td>Symbols</td><td><strong>${m.codeGraphResult.symbolCount}</strong></td></tr>
          <tr><td>Call Edges</td><td>${m.codeGraphResult.edgeCount}</td></tr>
          <tr><td>Files</td><td>${m.codeGraphResult.fileCount}</td></tr>
        </table>
      </div>` : '';

    // ── Task complexity ──
    const complexitySection = m.taskComplexity ? `
      <div class="card">
        <h3>🎯 Task Complexity</h3>
        <table>
          <tr><td>Level</td><td><strong>${esc(m.taskComplexity.level)}</strong></td></tr>
          <tr><td>Score</td><td>${m.taskComplexity.score}/100</td></tr>
        </table>
      </div>` : '';

    // ── P1 Tool Search stats ──
    const toolSearchSection = m.toolSearchStats ? `
      <div class="card">
        <h3>🔍 Tool Search (P1)</h3>
        <table>
          <tr><td>Total Plugins</td><td><strong>${m.toolSearchStats.totalPlugins}</strong></td></tr>
          <tr><td>Skipped (keyword)</td><td><strong>${m.toolSearchStats.skippedByKeyword}</strong></td></tr>
          <tr><td>Executed</td><td>${m.toolSearchStats.executed}</td></tr>
          <tr><td>Skip Ratio</td><td>${m.toolSearchStats.totalPlugins > 0 ? ((m.toolSearchStats.skippedByKeyword / m.toolSearchStats.totalPlugins) * 100).toFixed(0) : 0}%</td></tr>
        </table>
      </div>` : '';

    // ── P1 ToolResultFilter stats ──
    const toolResultFilterSection = m.toolResultFilterStats ? `
      <div class="card">
        <h3>✂️ ToolResultFilter (P1)</h3>
        <table>
          <tr><td>Chars Saved</td><td><strong>${m.toolResultFilterStats.totalSaved.toLocaleString()}</strong></td></tr>
          <tr><td>Blocks Filtered</td><td>${m.toolResultFilterStats.filteredBlocks}</td></tr>
        </table>
      </div>` : '';

    // ── Quality Gates ──
    const gatingSection = m.reflectionGating ? `
      <div class="card">
        <h3>${m.reflectionGating.passed ? '✅' : '❌'} Quality Gates</h3>
        <table>
          <tr><td>Status</td><td><strong class="${m.reflectionGating.passed ? 'status-ok' : 'status-error'}">${m.reflectionGating.passed ? 'ALL PASSED' : 'FAILED'}</strong></td></tr>
          <tr><td>Gates Checked</td><td>${m.reflectionGating.gateCount}</td></tr>
          ${m.reflectionGating.failedGates.length > 0 ? `<tr><td>Failed</td><td class="status-error">${m.reflectionGating.failedGates.join(', ')}</td></tr>` : ''}
        </table>
      </div>` : '';

    // ── Trend history table ──
    let trendSection = '';
    if (history.length >= 2) {
      const trends = Observability.computeTrends(history);
      const trendIcon = (t) => t === 'increasing' ? '📈' : t === 'decreasing' ? '📉' : '➡️';
      const historyRows = history.slice(0, 10).map(h => {
        const hdur = h.totalDurationMs ? dur(h.totalDurationMs) : '–';
        const ci = h.ciStatus ? (h.ciStatus === 'success' ? '✅' : '❌') : '–';
        return `<tr>
          <td>${esc(h.sessionId?.slice(-12) || '?')}</td>
          <td>${esc(h.startedAt?.slice(0, 16) || '–')}</td>
          <td>${hdur}</td>
          <td>~${(h.tokensEst || 0).toLocaleString()}</td>
          <td>${h.errorCount || 0}</td>
          <td>${ci}</td>
        </tr>`;
      }).join('\n');

      trendSection = `
      <div class="card wide">
        <h3>📈 Cross-Session Trends (last ${trends?.sessionCount || history.length} sessions)</h3>
        ${trends ? `<div class="trend-summary">
          <span>${trendIcon(trends.durationTrend)} Duration: ${dur(trends.avgDurationMs)} avg</span>
          <span>${trendIcon(trends.tokenTrend)} Tokens: ~${trends.avgTokensEst?.toLocaleString() || 0} avg</span>
          <span>${trendIcon(trends.errorTrend)} Errors: ${trends.avgErrorCount} avg</span>
        </div>` : ''}
        <table class="full-width">
          <thead><tr><th>Session</th><th>Date</th><th>Duration</th><th>Tokens</th><th>Errors</th><th>CI</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>`;
    }

    // ── Token display ──
    const tokenDisplay = m.llm.totalTokensActual != null
      ? `${m.llm.totalTokensActual.toLocaleString()} actual (est: ~${m.llm.totalTokensEst.toLocaleString()})`
      : `~${m.llm.totalTokensEst.toLocaleString()} est.`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Workflow Session Report – ${esc(m.sessionId)}</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
    --border: #30363d; --text: #e6edf3; --text-dim: #8b949e;
    --accent: #58a6ff; --green: #3fb950; --red: #f85149;
    --orange: #d29922; --purple: #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text);
    line-height: 1.5; padding: 24px; max-width: 1200px; margin: 0 auto;
  }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  h2 { font-size: 1.2rem; color: var(--accent); margin: 24px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 1rem; margin-bottom: 8px; }
  .header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .header-meta { color: var(--text-dim); font-size: 0.85rem; }
  .overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; text-align: center;
  }
  .stat-card .value { font-size: 1.6rem; font-weight: 700; color: var(--accent); }
  .stat-card .label { font-size: 0.8rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; margin-bottom: 12px;
  }
  .card.wide { grid-column: 1 / -1; }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  table.full-width { width: 100%; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--text-dim); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .bar-container { background: var(--surface2); border-radius: 4px; height: 18px; overflow: hidden; min-width: 60px; }
  .bar { height: 100%; border-radius: 4px; transition: width 0.3s ease; min-width: 2px; }
  .bar.status-ok { background: var(--green); }
  .bar.status-error { background: var(--red); }
  .bar.status-warn { background: var(--orange); }
  .bar.bar-tokens { background: var(--purple); }
  .status-ok { color: var(--green); }
  .status-error { color: var(--red); }
  .status-warn { color: var(--orange); }
  .trend-summary {
    display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px;
    font-size: 0.9rem; color: var(--text-dim);
  }
  .trend-summary span { white-space: nowrap; }
  .footer { margin-top: 32px; text-align: center; color: var(--text-dim); font-size: 0.8rem; border-top: 1px solid var(--border); padding-top: 16px; }
  @media (max-width: 600px) {
    body { padding: 12px; }
    .overview { grid-template-columns: repeat(2, 1fr); }
    .grid-2 { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>📊 Workflow Session Report</h1>
  <div class="header-meta">
    <strong>${esc(m.sessionId)}</strong> &nbsp;|&nbsp;
    ${esc(m.startedAt)} → ${esc(m.finishedAt)}
  </div>
</div>

<div class="overview">
  <div class="stat-card">
    <div class="value">${dur(m.totalDurationMs)}</div>
    <div class="label">Duration</div>
  </div>
  <div class="stat-card">
    <div class="value">${m.llm.totalCalls}</div>
    <div class="label">LLM Calls</div>
  </div>
  <div class="stat-card">
    <div class="value">${tokenDisplay}</div>
    <div class="label">Tokens</div>
  </div>
  <div class="stat-card">
    <div class="value" style="color: ${m.errors.count > 0 ? 'var(--red)' : 'var(--green)'}">${m.errors.count}</div>
    <div class="label">Errors</div>
  </div>
  <div class="stat-card">
    <div class="value">${m.stages.length}</div>
    <div class="label">Stages</div>
  </div>
</div>

<h2>🔄 Stage Timeline</h2>
<div class="card">
  <table>
    <thead><tr><th>Stage</th><th>Status</th><th>Duration</th><th>Timeline</th></tr></thead>
    <tbody>${stageRows}</tbody>
  </table>
</div>

<h2>🤖 LLM Usage by Role</h2>
<div class="card">
  <table>
    <thead><tr><th>Role</th><th>Calls</th><th>Tokens</th><th>Distribution</th></tr></thead>
    <tbody>${llmRoleRows}</tbody>
  </table>
</div>

${m.errors.count > 0 ? `
<h2>❌ Errors (${m.errors.count})</h2>
<div class="card">
  <table>
    <thead><tr><th>Stage</th><th>Message</th><th>Time</th></tr></thead>
    <tbody>${errorRows}</tbody>
  </table>
</div>` : ''}

<h2>📋 Details</h2>
<div class="grid-2">
  ${testSection}
  ${entropySection}
  ${ciSection}
  ${graphSection}
  ${complexitySection}
  ${toolSearchSection}
  ${toolResultFilterSection}
  ${gatingSection}
</div>

${trendSection}

<div class="footer">
  Generated by WorkFlowAgent Observability &nbsp;|&nbsp; ${new Date().toISOString()}
</div>

</body>
</html>`;
  }

  _printTrendSummary() {
    try {
      const history = Observability.loadHistory(this._outputDir);
      if (history.length < 2) return; // Need at least 2 sessions for trends

      const trends = Observability.computeTrends(history);
      if (!trends) return;

      const bar = '─'.repeat(58);
      console.log(`  📈 TREND ANALYSIS (last ${trends.sessionCount} sessions)`);
      console.log(bar);

      const trendIcon = (t) => t === 'increasing' ? '📈' : t === 'decreasing' ? '📉' : '➡️ ';
      console.log(`  Avg Duration : ${(trends.avgDurationMs / 1000).toFixed(1)}s  ${trendIcon(trends.durationTrend)} ${trends.durationTrend}`);
      console.log(`  Avg Tokens   : ~${trends.avgTokensEst.toLocaleString()}  ${trendIcon(trends.tokenTrend)} ${trends.tokenTrend}`);
      console.log(`  Avg Errors   : ${trends.avgErrorCount}  ${trendIcon(trends.errorTrend)} ${trends.errorTrend}`);
      if (trends.avgEntropyViolations != null) {
        console.log(`  Avg Entropy  : ${trends.avgEntropyViolations} violations  ${trendIcon(trends.entropyTrend)} ${trends.entropyTrend}`);
      }
      if (trends.ciSuccessRate != null) {
        console.log(`  CI Success   : ${(trends.ciSuccessRate * 100).toFixed(0)}%`);
      }
      console.log(`${bar}\n`);
    } catch (err) { console.warn(`[Observability] Failed to print trends: ${err.message}`); }
  }
}

module.exports = { Observability };
