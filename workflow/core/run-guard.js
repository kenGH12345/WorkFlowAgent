/**
 * RunGuard – Global execution guard and cost-aware gateway.
 *
 * Combines two complementary optimisation strategies:
 *
 *   Direction 1 – CostAwareGateway (closed-loop cost control):
 *     Monitors cumulative LLM spending and dynamically downgrades model tiers
 *     when budget pressure increases. Transforms cost tracking from "passive
 *     recording" into "active feedback loop" by connecting CostRouter spending
 *     data back to LlmRouter routing decisions.
 *
 *   Direction 2 – Global Run Guard (hard execution ceiling):
 *     Enforces absolute limits on total LLM calls, total tokens, and total
 *     wall-clock time per workflow run. Prevents runaway execution regardless
 *     of individual stage retry/loop limits.
 *
 * These form a layered defence:
 *   - Soft limit (Direction 1): downgrade model tier to reduce cost
 *   - Hard limit (Direction 2): abort execution entirely
 *
 * Integration points:
 *   - beforeStage(stageName): called before each stage in _runStage()
 *   - beforeLlmCall(role, estimatedTokens): called before each LLM invocation
 *   - afterLlmCall(role, inputTokens, outputTokens): called after each LLM invocation
 *   - getSummary(): returns a structured summary for _finalizeWorkflow()
 *
 * Reference:
 *   - OpenHands AgentController max_iterations
 *   - Temporal budget enforcement pattern
 *   - 2025 industry data: 85% of AI projects cite cost as #1 failure reason
 *
 * @module run-guard
 */

'use strict';

// ─── Default Limits ─────────────────────────────────────────────────────────

const DEFAULT_LIMITS = {
  maxTotalLlmCalls:    50,             // Global max LLM API calls per run
  maxTotalTokens:      800_000,        // Global max tokens (input + output) per run
  maxTotalDurationMs:  30 * 60 * 1000, // 30 minutes wall-clock time

  // Cost-aware gateway thresholds (% of budget)
  downgradeTierAt:     40,   // Switch to cost-optimised model when budget % remaining <= this
  emergencyTierAt:     15,   // Switch to cheapest possible model when budget % remaining <= this
  abortAt:             5,    // Abort execution when budget % remaining <= this
};

// ─── RunGuardAbortError ─────────────────────────────────────────────────────

/**
 * Custom error thrown when RunGuard aborts execution.
 * Identified by code === 'RUN_GUARD_ABORT' for upstream catch handlers.
 */
class RunGuardAbortError extends Error {
  /**
   * @param {string} reason - Human-readable reason for abort
   * @param {string} limitType - 'llm_calls' | 'tokens' | 'duration' | 'budget'
   * @param {object} details - Current vs limit values
   */
  constructor(reason, limitType, details = {}) {
    super(`[RunGuard] ABORT: ${reason}`);
    this.name = 'RunGuardAbortError';
    this.code = 'RUN_GUARD_ABORT';
    this.limitType = limitType;
    this.details = details;
  }
}

// ─── RunGuard Class ─────────────────────────────────────────────────────────

class RunGuard {
  /**
   * @param {object} opts
   * @param {number}  [opts.maxTotalLlmCalls]    - Max LLM calls per run
   * @param {number}  [opts.maxTotalTokens]      - Max total tokens per run
   * @param {number}  [opts.maxTotalDurationMs]   - Max wall-clock time per run
   * @param {number}  [opts.downgradeTierAt]      - Budget % remaining to trigger downgrade
   * @param {number}  [opts.emergencyTierAt]      - Budget % remaining to trigger emergency mode
   * @param {number}  [opts.abortAt]              - Budget % remaining to trigger abort
   * @param {number}  [opts.budgetUsd]            - Total budget in USD (from CostRouter config)
   * @param {boolean} [opts.enabled]              - Whether guard is active (default: true)
   */
  constructor(opts = {}) {
    this._limits = {
      maxTotalLlmCalls:  opts.maxTotalLlmCalls  ?? DEFAULT_LIMITS.maxTotalLlmCalls,
      maxTotalTokens:    opts.maxTotalTokens    ?? DEFAULT_LIMITS.maxTotalTokens,
      maxTotalDurationMs: opts.maxTotalDurationMs ?? DEFAULT_LIMITS.maxTotalDurationMs,
      downgradeTierAt:   opts.downgradeTierAt   ?? DEFAULT_LIMITS.downgradeTierAt,
      emergencyTierAt:   opts.emergencyTierAt   ?? DEFAULT_LIMITS.emergencyTierAt,
      abortAt:           opts.abortAt           ?? DEFAULT_LIMITS.abortAt,
    };

    this._budgetUsd = opts.budgetUsd ?? 5.0;
    this._enabled = opts.enabled !== false;

    // ── Counters ──
    this._totalLlmCalls = 0;
    this._totalInputTokens = 0;
    this._totalOutputTokens = 0;
    this._startMs = Date.now();

    // ── Cost tracking (fed by afterLlmCall or external source) ──
    this._totalCostUsd = 0;

    // ── Tier downgrade state ──
    this._currentTierMode = 'normal';  // 'normal' | 'downgraded' | 'emergency'
    this._tierDowngrades = [];         // History of tier changes

    // ── Stage tracking ──
    this._stageCallCounts = new Map();  // stage → number of LLM calls in that stage

    if (this._enabled) {
      console.log(
        `[RunGuard] 🛡️  Initialised (calls≤${this._limits.maxTotalLlmCalls}, ` +
        `tokens≤${(this._limits.maxTotalTokens / 1000).toFixed(0)}K, ` +
        `time≤${(this._limits.maxTotalDurationMs / 60000).toFixed(0)}min, ` +
        `budget=$${this._budgetUsd})`
      );
    }
  }

  // ─── Pre-Stage Check ────────────────────────────────────────────────────

  /**
   * Called before each workflow stage begins.
   * Checks global limits and applies cost-aware tier routing if needed.
   *
   * @param {string} stageName - e.g. 'ANALYSE', 'ARCHITECT'
   * @param {object} [context]
   * @param {import('./llm-router').LlmRouter} [context.llmRouter] - For tier downgrade
   * @returns {{ allowed: boolean, tierMode: string, warnings: string[] }}
   * @throws {RunGuardAbortError} if hard limits are exceeded
   */
  beforeStage(stageName, context = {}) {
    if (!this._enabled) return { allowed: true, tierMode: 'normal', warnings: [] };

    const warnings = [];
    this._stageCallCounts.set(stageName, 0);

    // ── Check hard limits ──
    this._checkHardLimits(warnings);

    // ── Direction 1: Cost-aware gateway ──
    const budgetRemaining = this._getBudgetRemainingPct();
    const previousMode = this._currentTierMode;

    if (budgetRemaining <= this._limits.abortAt) {
      throw new RunGuardAbortError(
        `Budget nearly exhausted: ${budgetRemaining.toFixed(1)}% remaining ($${(this._budgetUsd - this._totalCostUsd).toFixed(4)} of $${this._budgetUsd})`,
        'budget',
        { budgetRemainingPct: budgetRemaining, totalCostUsd: this._totalCostUsd, budgetUsd: this._budgetUsd }
      );
    }

    if (budgetRemaining <= this._limits.emergencyTierAt && this._currentTierMode !== 'emergency') {
      this._currentTierMode = 'emergency';
      this._applyTierDowngrade('emergency', context.llmRouter, stageName);
      warnings.push(`🔴 Budget critical (${budgetRemaining.toFixed(1)}% remaining) — switched to emergency tier (cheapest models)`);
    } else if (budgetRemaining <= this._limits.downgradeTierAt && this._currentTierMode === 'normal') {
      this._currentTierMode = 'downgraded';
      this._applyTierDowngrade('downgraded', context.llmRouter, stageName);
      warnings.push(`🟡 Budget pressure (${budgetRemaining.toFixed(1)}% remaining) — switched to cost-optimised tier`);
    }

    if (warnings.length > 0) {
      for (const w of warnings) console.warn(`[RunGuard] ${w}`);
    }

    return { allowed: true, tierMode: this._currentTierMode, warnings };
  }

  // ─── Pre-LLM Call Check ─────────────────────────────────────────────────

  /**
   * Called before each LLM API call.
   * Checks if the call is allowed under current limits.
   *
   * @param {string} role - Agent role (e.g. 'ARCHITECT')
   * @param {number} [estimatedInputTokens=4000] - Estimated input tokens
   * @returns {{ allowed: boolean, reason?: string }}
   * @throws {RunGuardAbortError} if hard limits are exceeded
   */
  beforeLlmCall(role, estimatedInputTokens = 4000) {
    if (!this._enabled) return { allowed: true };

    // Check LLM call count
    if (this._totalLlmCalls >= this._limits.maxTotalLlmCalls) {
      throw new RunGuardAbortError(
        `LLM call limit reached: ${this._totalLlmCalls} >= ${this._limits.maxTotalLlmCalls}`,
        'llm_calls',
        { current: this._totalLlmCalls, limit: this._limits.maxTotalLlmCalls }
      );
    }

    // Check token count
    const totalTokens = this._totalInputTokens + this._totalOutputTokens;
    if (totalTokens + estimatedInputTokens >= this._limits.maxTotalTokens) {
      throw new RunGuardAbortError(
        `Token limit approaching: ${totalTokens} + ~${estimatedInputTokens} >= ${this._limits.maxTotalTokens}`,
        'tokens',
        { current: totalTokens, estimated: estimatedInputTokens, limit: this._limits.maxTotalTokens }
      );
    }

    // Check duration
    const elapsedMs = Date.now() - this._startMs;
    if (elapsedMs >= this._limits.maxTotalDurationMs) {
      throw new RunGuardAbortError(
        `Duration limit reached: ${(elapsedMs / 60000).toFixed(1)}min >= ${(this._limits.maxTotalDurationMs / 60000).toFixed(1)}min`,
        'duration',
        { elapsedMs, limit: this._limits.maxTotalDurationMs }
      );
    }

    return { allowed: true };
  }

  // ─── Post-LLM Call Recording ────────────────────────────────────────────

  /**
   * Called after each LLM API call completes.
   * Updates counters and cost tracking.
   *
   * @param {string} role - Agent role
   * @param {number} inputTokens - Actual input tokens used
   * @param {number} outputTokens - Actual output tokens used
   * @param {number} [costUsd=0] - Cost of this call (from CostRouter)
   */
  afterLlmCall(role, inputTokens = 0, outputTokens = 0, costUsd = 0) {
    if (!this._enabled) return;

    this._totalLlmCalls += 1;
    this._totalInputTokens += inputTokens;
    this._totalOutputTokens += outputTokens;
    this._totalCostUsd += costUsd;

    // Track per-stage call counts
    for (const [stage, count] of this._stageCallCounts) {
      // Update the most recently started stage
      this._stageCallCounts.set(stage, count); // will be incremented by specific stage
    }
  }

  /**
   * Increments the LLM call counter for a specific stage.
   * @param {string} stageName
   */
  recordStageCall(stageName) {
    const current = this._stageCallCounts.get(stageName) || 0;
    this._stageCallCounts.set(stageName, current + 1);
  }

  /**
   * Updates the total cost from an external source (e.g. CostRouterAdapter).
   * Use this when cost tracking is done outside RunGuard.
   *
   * @param {number} totalCostUsd - Cumulative cost so far
   */
  syncCost(totalCostUsd) {
    this._totalCostUsd = totalCostUsd;
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  /**
   * Returns a structured summary of the run guard state.
   * Used by _finalizeWorkflow() for the cost analysis report.
   *
   * @returns {RunGuardSummary}
   */
  getSummary() {
    const elapsedMs = Date.now() - this._startMs;
    const totalTokens = this._totalInputTokens + this._totalOutputTokens;
    const budgetRemainingPct = this._getBudgetRemainingPct();

    return {
      enabled: this._enabled,
      totalLlmCalls: this._totalLlmCalls,
      totalTokens,
      totalInputTokens: this._totalInputTokens,
      totalOutputTokens: this._totalOutputTokens,
      totalCostUsd: this._totalCostUsd,
      budgetUsd: this._budgetUsd,
      budgetRemainingPct,
      elapsedMs,
      limits: { ...this._limits },
      tierMode: this._currentTierMode,
      tierDowngrades: [...this._tierDowngrades],
      stageCallCounts: Object.fromEntries(this._stageCallCounts),
      // Utilisation percentages
      utilisation: {
        llmCallsPct: (this._totalLlmCalls / this._limits.maxTotalLlmCalls * 100),
        tokensPct: (totalTokens / this._limits.maxTotalTokens * 100),
        durationPct: (elapsedMs / this._limits.maxTotalDurationMs * 100),
        budgetPct: 100 - budgetRemainingPct,
      },
    };
  }

  /**
   * Formats the run guard summary as a Markdown block for console/report output.
   *
   * @returns {string}
   */
  formatSummary() {
    const s = this.getSummary();
    if (!s.enabled) return '';

    const icon = (pct) => pct >= 90 ? '🔴' : pct >= 70 ? '🟡' : '🟢';
    const bar = (pct) => {
      const filled = Math.round(pct / 5);
      return '█'.repeat(Math.min(filled, 20)) + '░'.repeat(Math.max(0, 20 - filled));
    };

    const lines = [
      ``,
      `${'─'.repeat(60)}`,
      `  🛡️  RUN GUARD SUMMARY`,
      `${'─'.repeat(60)}`,
      ``,
      `  ${icon(s.utilisation.llmCallsPct)} LLM Calls:  ${s.totalLlmCalls} / ${s._limits?.maxTotalLlmCalls || s.limits.maxTotalLlmCalls}  [${bar(s.utilisation.llmCallsPct)}] ${s.utilisation.llmCallsPct.toFixed(0)}%`,
      `  ${icon(s.utilisation.tokensPct)} Tokens:     ${(s.totalTokens / 1000).toFixed(1)}K / ${(s.limits.maxTotalTokens / 1000).toFixed(0)}K  [${bar(s.utilisation.tokensPct)}] ${s.utilisation.tokensPct.toFixed(0)}%`,
      `  ${icon(s.utilisation.durationPct)} Duration:   ${(s.elapsedMs / 60000).toFixed(1)}min / ${(s.limits.maxTotalDurationMs / 60000).toFixed(0)}min  [${bar(s.utilisation.durationPct)}] ${s.utilisation.durationPct.toFixed(0)}%`,
      `  ${icon(s.utilisation.budgetPct)} Budget:     $${s.totalCostUsd.toFixed(4)} / $${s.budgetUsd.toFixed(2)}  [${bar(s.utilisation.budgetPct)}] ${s.utilisation.budgetPct.toFixed(0)}%`,
    ];

    if (s.tierDowngrades.length > 0) {
      lines.push(``);
      lines.push(`  ⚡ Tier Changes:`);
      for (const d of s.tierDowngrades) {
        lines.push(`    ${d.timestamp} — ${d.from} → ${d.to} (stage: ${d.stage}, reason: ${d.reason})`);
      }
    }

    if (Object.keys(s.stageCallCounts).length > 0) {
      lines.push(``);
      lines.push(`  📊 LLM Calls per Stage:`);
      for (const [stage, count] of Object.entries(s.stageCallCounts)) {
        if (count > 0) lines.push(`    ${stage}: ${count} call(s)`);
      }
    }

    lines.push(`${'─'.repeat(60)}`);
    return lines.join('\n');
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /**
   * Checks hard limits and throws RunGuardAbortError if exceeded.
   * @param {string[]} warnings - Mutable array to push warnings to
   * @private
   */
  _checkHardLimits(warnings) {
    const elapsedMs = Date.now() - this._startMs;
    if (elapsedMs >= this._limits.maxTotalDurationMs) {
      throw new RunGuardAbortError(
        `Duration limit exceeded: ${(elapsedMs / 60000).toFixed(1)}min >= ${(this._limits.maxTotalDurationMs / 60000).toFixed(1)}min`,
        'duration',
        { elapsedMs, limit: this._limits.maxTotalDurationMs }
      );
    }

    if (this._totalLlmCalls >= this._limits.maxTotalLlmCalls) {
      throw new RunGuardAbortError(
        `LLM call limit reached: ${this._totalLlmCalls} >= ${this._limits.maxTotalLlmCalls}`,
        'llm_calls',
        { current: this._totalLlmCalls, limit: this._limits.maxTotalLlmCalls }
      );
    }

    // Soft warnings at 80% utilisation
    const callPct = this._totalLlmCalls / this._limits.maxTotalLlmCalls * 100;
    if (callPct >= 80) {
      warnings.push(`LLM calls at ${callPct.toFixed(0)}% of limit (${this._totalLlmCalls}/${this._limits.maxTotalLlmCalls})`);
    }

    const durationPct = elapsedMs / this._limits.maxTotalDurationMs * 100;
    if (durationPct >= 80) {
      warnings.push(`Duration at ${durationPct.toFixed(0)}% of limit (${(elapsedMs / 60000).toFixed(1)}min)`);
    }
  }

  /**
   * Returns budget remaining as a percentage (0-100).
   * @returns {number}
   * @private
   */
  _getBudgetRemainingPct() {
    if (this._budgetUsd <= 0) return 100;
    return Math.max(0, (1 - this._totalCostUsd / this._budgetUsd) * 100);
  }

  /**
   * Applies a tier downgrade to the LlmRouter.
   *
   * @param {'downgraded'|'emergency'} mode
   * @param {import('./llm-router').LlmRouter|null} llmRouter
   * @param {string} stageName
   * @private
   */
  _applyTierDowngrade(mode, llmRouter, stageName) {
    const from = this._tierDowngrades.length > 0
      ? this._tierDowngrades[this._tierDowngrades.length - 1].to
      : 'normal';

    this._tierDowngrades.push({
      timestamp: new Date().toISOString().slice(11, 19),
      from,
      to: mode,
      stage: stageName,
      reason: mode === 'emergency'
        ? `Budget ≤${this._limits.emergencyTierAt}% remaining`
        : `Budget ≤${this._limits.downgradeTierAt}% remaining`,
    });

    if (!llmRouter) {
      console.warn(`[RunGuard] ⚠️  No LlmRouter available for tier downgrade.`);
      return;
    }

    // Direction 1: Feed cost data back into LlmRouter routing decisions
    // When budget is under pressure, simulate a higher complexity tier to force
    // the router to use cheaper models.
    if (mode === 'emergency') {
      // Force all roles to 'fast' (cheapest) tier
      const tierConfig = llmRouter.getTierConfig();
      if (tierConfig) {
        llmRouter.applyTierRouting({ score: 10, level: 'simple' });
        console.log(`[RunGuard] 🔴 Emergency tier: forced all roles to 'fast' (cheapest) models.`);
      }
    } else if (mode === 'downgraded') {
      // Downgrade: use 'moderate' tier (default models, not premium)
      const tierConfig = llmRouter.getTierConfig();
      if (tierConfig) {
        llmRouter.applyTierRouting({ score: 40, level: 'moderate' });
        console.log(`[RunGuard] 🟡 Cost-optimised tier: switched remaining roles to 'default' models.`);
      }
    }
  }
}

module.exports = { RunGuard, RunGuardAbortError, DEFAULT_LIMITS };
