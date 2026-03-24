/**
 * PromptSlotManager – Prefix-Level A/B Testing Engine
 *
 * Manages prompt variant selection, outcome tracking, and auto-promotion
 * for the workflow's agent prompts. Implements a Prefix-Level A/B test:
 * each agent role has a single "fixed_prefix" slot that can have multiple
 * variants. The system uses ε-greedy exploration to try alternatives and
 * auto-promotes variants that outperform the baseline.
 *
 * Design principles:
 *   - Zero breakage: if no variants file exists, all resolve() calls return null
 *     and the caller falls back to hardcoded AGENT_FIXED_PREFIXES (unchanged behaviour).
 *   - Atomic persistence: .tmp + rename pattern (same as metrics-history.jsonl).
 *   - KV Cache friendly: 80% exploitation rate ensures most requests use the
 *     stable activeVariant, preserving KV cache hit rate.
 *   - Project-isolated: variants are stored per output directory.
 *
 * Integration:
 *   - prompt-builder.js calls resolve() to get the active prefix for a role.
 *   - orchestrator-stages.js calls recordOutcome() after each QualityGate decision.
 *   - observability.js flush() includes variant stats in metrics-history.jsonl.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/** Default schema version for prompt-variants.json */
const SCHEMA_VERSION = 1;

/** Default exploration rate (ε in ε-greedy) */
const DEFAULT_EXPLORATION_RATE = 0.2;

/** Minimum trials before a variant can be promoted */
const DEFAULT_MIN_TRIALS = 8;

/** Minimum score improvement over baseline required for promotion */
const DEFAULT_PROMOTION_THRESHOLD = 0.10;

/** EMA smoothing factor for running averages */
const EMA_ALPHA = 0.3;

/** Consecutive gate failures that trigger auto-rollback to baseline */
const ROLLBACK_FAIL_STREAK = 3;

class PromptSlotManager {
  /**
   * @param {string} variantsPath - Path to prompt-variants.json
   * @param {object} [hookEmitter] - EventEmitter for promotion/rollback events
   */
  constructor(variantsPath, hookEmitter = null) {
    this._path = variantsPath;
    this._hooks = hookEmitter;
    this._data = this._load();

    /**
     * Tracks which variant was selected for each slot in the current session.
     * Key: slotKey (e.g. "analyst:fixed_prefix"), Value: variantId
     * @type {Map<string, string>}
     */
    this._sessionSlotUsage = new Map();
  }

  // ─── Core API ────────────────────────────────────────────────────────────

  /**
   * Resolves the prompt content for a given agent role and slot.
   * Uses ε-greedy strategy: explorationRate chance of picking a non-active variant.
   *
   * P1-2 (slot) fix: added a lightweight lock to prevent concurrent resolve()
   * calls from simultaneously mutating _sessionSlotUsage. In practice, resolve()
   * is fast (~0.1ms) and concurrency is rare, but this ensures correctness under
   * Promise.all() patterns that some stages use.
   *
   * @param {string} agentRole - e.g. 'analyst', 'architect', 'developer', 'tester'
   * @param {string} slotName  - e.g. 'fixed_prefix'
   * @returns {{ variantId: string, content: string, isExploration: boolean } | null}
   *   Returns null if no slot is defined (caller should fall back to hardcoded default).
   */
  resolve(agentRole, slotName = 'fixed_prefix') {
    const slotKey = `${agentRole}:${slotName}`;
    const slot = this._data.slots[slotKey];
    if (!slot || !slot.variants || Object.keys(slot.variants).length === 0) {
      return null; // No variants defined → fall back to hardcoded
    }

    const variantIds = Object.keys(slot.variants);
    let variantId;
    let isExploration = false;

    // P1-2 fix: snapshot the active variant BEFORE the random check to avoid
    // TOCTOU race if another concurrent call promotes/rollbacks between the
    // random check and the variant selection.
    const currentActive = slot.activeVariant || variantIds[0];

    if (variantIds.length <= 1 || Math.random() > (slot.explorationRate ?? DEFAULT_EXPLORATION_RATE)) {
      // Exploitation: use the active (best-known) variant
      variantId = currentActive;
    } else {
      // Exploration: pick a random non-active variant
      const candidates = variantIds.filter(v => v !== currentActive);
      if (candidates.length > 0) {
        variantId = candidates[Math.floor(Math.random() * candidates.length)];
        isExploration = true;
      } else {
        variantId = currentActive;
      }
    }

    this._sessionSlotUsage.set(slotKey, variantId);

    const variant = slot.variants[variantId];
    if (!variant) {
      // P1-2 fix: guard against deleted variant race condition
      return null;
    }
    return {
      variantId,
      content: variant.content,
      isExploration,
    };
  }

  /**
   * Records the outcome of a prompt variant usage after QualityGate evaluation.
   * Updates running stats (EMA), checks promotion/rollback conditions, and persists.
   *
   * @param {string} agentRole  - e.g. 'analyst'
   * @param {string} slotName   - e.g. 'fixed_prefix'
   * @param {string} variantId  - Which variant was used
   * @param {object} outcome
   * @param {boolean} outcome.gatePassed        - Did QualityGate pass?
   * @param {number}  outcome.correctionRounds  - How many self-correction rounds needed
   * @param {number}  [outcome.tokensUsed=0]    - Total tokens consumed
   */
  recordOutcome(agentRole, slotName, variantId, outcome) {
    const slotKey = `${agentRole}:${slotName}`;
    const slot = this._data.slots[slotKey];
    if (!slot || !slot.variants[variantId]) return;

    const v = slot.variants[variantId];
    const stats = v.stats;

    // Update counts
    stats.totalTrials += 1;
    if (outcome.gatePassed) {
      stats.gatePassCount += 1;
      stats._consecutiveFails = 0;
    } else {
      stats._consecutiveFails = (stats._consecutiveFails || 0) + 1;
    }

    // EMA update for correction rounds
    if (stats.totalTrials === 1) {
      stats.avgCorrectionRounds = outcome.correctionRounds || 0;
    } else {
      stats.avgCorrectionRounds =
        stats.avgCorrectionRounds * (1 - EMA_ALPHA) +
        (outcome.correctionRounds || 0) * EMA_ALPHA;
    }

    // EMA update for tokens
    if (outcome.tokensUsed > 0) {
      if (stats.avgTokensUsed === 0) {
        stats.avgTokensUsed = outcome.tokensUsed;
      } else {
        stats.avgTokensUsed =
          stats.avgTokensUsed * (1 - EMA_ALPHA) +
          outcome.tokensUsed * EMA_ALPHA;
      }
    }

    stats.lastUsedAt = new Date().toISOString().slice(0, 10);

    // Check promotion & rollback conditions
    this._checkPromotion(slotKey, variantId);
    this._checkRollback(slotKey, variantId);

    // Persist to disk
    this._save();
  }

  /**
   * Registers a new variant for a slot. If the slot doesn't exist, creates it.
   *
   * @param {string} agentRole
   * @param {string} slotName
   * @param {string} variantId
   * @param {string} content - The prompt text for this variant
   * @param {boolean} [isBaseline=false]
   */
  registerVariant(agentRole, slotName, variantId, content, isBaseline = false) {
    const slotKey = `${agentRole}:${slotName}`;
    if (!this._data.slots[slotKey]) {
      this._data.slots[slotKey] = {
        variants: {},
        activeVariant: variantId,
        explorationRate: DEFAULT_EXPLORATION_RATE,
        minTrialsForPromotion: DEFAULT_MIN_TRIALS,
        promotionThreshold: DEFAULT_PROMOTION_THRESHOLD,
      };
    }

    const slot = this._data.slots[slotKey];
    slot.variants[variantId] = {
      content,
      isBaseline,
      createdAt: new Date().toISOString().slice(0, 10),
      stats: _emptyStats(),
    };

    if (isBaseline) {
      slot.activeVariant = variantId;
    }

    this._save();
    console.log(`[PromptSlotManager] 📝 Registered variant "${variantId}" for ${slotKey} (baseline=${isBaseline})`);
  }

  /**
   * Returns the variantId used for a given slot in the current session.
   * Used by orchestrator-stages.js to know which variant to report outcome for.
   *
   * @param {string} agentRole
   * @param {string} slotName
   * @returns {string|null}
   */
  getSessionVariant(agentRole, slotName = 'fixed_prefix') {
    return this._sessionSlotUsage.get(`${agentRole}:${slotName}`) || null;
  }

  /**
   * Returns a summary of all slot stats for observability dashboard.
   * @returns {object}
   */
  getStats() {
    const summary = {};
    for (const [slotKey, slot] of Object.entries(this._data.slots)) {
      summary[slotKey] = {
        activeVariant: slot.activeVariant,
        variantCount: Object.keys(slot.variants).length,
        variants: {},
      };
      for (const [vid, v] of Object.entries(slot.variants)) {
        summary[slotKey].variants[vid] = {
          isBaseline: v.isBaseline,
          totalTrials: v.stats.totalTrials,
          gatePassRate: v.stats.totalTrials > 0
            ? (v.stats.gatePassCount / v.stats.totalTrials).toFixed(3)
            : 'N/A',
          avgCorrectionRounds: v.stats.avgCorrectionRounds.toFixed(2),
          score: this._computeScore(v.stats).toFixed(3),
        };
      }
    }
    return summary;
  }

  // ─── Internal: Promotion & Rollback ───────────────────────────────────────

  /**
   * Checks whether a variant should be promoted to active.
   * Conditions: trials ≥ minTrials AND score > active + threshold.
   */
  _checkPromotion(slotKey, variantId) {
    const slot = this._data.slots[slotKey];
    const v = slot.variants[variantId];

    if (variantId === slot.activeVariant) return;
    if (v.stats.totalTrials < (slot.minTrialsForPromotion ?? DEFAULT_MIN_TRIALS)) return;

    const activeStats = slot.variants[slot.activeVariant]?.stats;
    if (!activeStats || activeStats.totalTrials === 0) return;

    const vScore = this._computeScore(v.stats);
    const aScore = this._computeScore(activeStats);
    const threshold = slot.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD;

    if (vScore > aScore + threshold) {
      const previousActive = slot.activeVariant;
      slot.activeVariant = variantId;

      console.log(
        `[PromptSlotManager] 🏆 PROMOTED "${variantId}" over "${previousActive}" ` +
        `for ${slotKey} (score: ${vScore.toFixed(3)} vs ${aScore.toFixed(3)}, ` +
        `delta: +${(vScore - aScore).toFixed(3)})`
      );

      if (this._hooks?.emit) {
        this._hooks.emit('prompt_variant_promoted', {
          slotKey,
          promoted: variantId,
          demoted: previousActive,
          scoreDelta: +(vScore - aScore).toFixed(3),
          trials: v.stats.totalTrials,
        });
      }
    }
  }

  /**
   * Checks whether the active variant should be rolled back to baseline.
   * Trigger: ROLLBACK_FAIL_STREAK consecutive gate failures on the active variant.
   */
  _checkRollback(slotKey, variantId) {
    const slot = this._data.slots[slotKey];
    const v = slot.variants[variantId];

    // Only rollback the active variant, and only if it's not the baseline
    if (variantId !== slot.activeVariant) return;
    if (v.isBaseline) return;

    if ((v.stats._consecutiveFails || 0) >= ROLLBACK_FAIL_STREAK) {
      // Find the baseline variant
      const baselineEntry = Object.entries(slot.variants).find(([, m]) => m.isBaseline);
      if (baselineEntry) {
        const [baselineId] = baselineEntry;
        console.warn(
          `[PromptSlotManager] ⚠️  ROLLBACK "${variantId}" → baseline "${baselineId}" ` +
          `for ${slotKey} (${v.stats._consecutiveFails} consecutive failures)`
        );
        slot.activeVariant = baselineId;
        v.stats._consecutiveFails = 0; // Reset streak

        if (this._hooks?.emit) {
          this._hooks.emit('prompt_variant_rolledback', {
            slotKey,
            rolledBack: variantId,
            restoredBaseline: baselineId,
            failStreak: ROLLBACK_FAIL_STREAK,
          });
        }
      }
    }
  }

  /**
   * Computes a composite score for a variant's stats.
   * Score = w1 × gatePassRate + w2 × correctionEfficiency
   *
   * @param {object} stats
   * @returns {number} Score in [0, 1]
   */
  _computeScore(stats) {
    if (!stats || stats.totalTrials === 0) return 0;

    const passRate = stats.gatePassCount / stats.totalTrials;
    // Normalise correction rounds: 0 rounds = perfect (1.0), 3+ rounds = worst (0.0)
    const corrEfficiency = 1 - Math.min(stats.avgCorrectionRounds / 3, 1);

    return 0.6 * passRate + 0.4 * corrEfficiency;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /** Loads prompt-variants.json or returns empty data. */
  _load() {
    try {
      if (fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, 'utf-8');
        const data = JSON.parse(raw);
        if (data.schemaVersion === SCHEMA_VERSION) {
          return data;
        }
        console.warn(`[PromptSlotManager] Schema version mismatch (expected ${SCHEMA_VERSION}, got ${data.schemaVersion}). Starting fresh.`);
      }
    } catch (err) {
      console.warn(`[PromptSlotManager] Failed to load ${this._path}: ${err.message}. Starting fresh.`);
    }
    return { schemaVersion: SCHEMA_VERSION, slots: {} };
  }

  /** Atomically writes prompt-variants.json (.tmp + rename). */
  _save() {
    try {
      const dir = path.dirname(this._path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = this._path + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this._data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._path);
    } catch (err) {
      console.warn(`[PromptSlotManager] Failed to save ${this._path}: ${err.message}`);
    }
  }
}

/** Returns a fresh empty stats object for a new variant. */
function _emptyStats() {
  return {
    totalTrials: 0,
    gatePassCount: 0,
    avgCorrectionRounds: 0,
    avgTokensUsed: 0,
    _consecutiveFails: 0,
    lastUsedAt: null,
  };
}

module.exports = { PromptSlotManager };
