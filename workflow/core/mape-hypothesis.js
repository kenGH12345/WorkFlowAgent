/**
 * MAPE Hypothesis Generator + Micro-Loop utilities
 * (extracted from mape-engine.js)
 *
 * Contains:
 *   - HypothesisGenerator class (P1: G1) — rule-based, zero LLM
 *   - Convergence detection (_checkConvergence)
 *   - Experiment history persistence (_persistExperimentHistory)
 *   - Failure experience feedback (_recordFailureExperience)
 *   - Canary health check (_canaryCheck)
 *   - Quick hash utility (_quickHash)
 *
 * Design: HypothesisGenerator is a standalone class.
 * The remaining functions are mixed into MAPEEngine.prototype.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { ACTION_PRIORITY } = require('./mape-constants');

// ─── Hypothesis Generator (P1: G1) ─────────────────────────────────────────
// Rule-based hypothesis engine. Three sources:
//   1. Target gaps (from RegressionGuard._computeTargetGaps)
//   2. Historical failure avoidance (from experiment-history.jsonl)
//   3. Pattern rules (metric → action type mapping)
//
// Design: Zero LLM calls. Pure local rules. Returns ranked hypotheses.

class HypothesisGenerator {
  /**
   * @param {object} opts
   * @param {string} opts.outputDir — Path to output directory
   * @param {boolean} [opts.verbose]
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || path.join(process.cwd(), 'workflow', 'output');
    this._verbose = opts.verbose ?? false;
    this._experimentHistoryPath = path.join(this._outputDir, 'experiment-history.jsonl');
  }

  /**
   * Generates ranked hypotheses for the micro-loop.
   *
   * @param {object} opts
   * @param {object[]} opts.actions — Planned actions from MAPE plan phase
   * @param {object}   opts.guard   — RegressionGuard instance
   * @param {object}   [opts.snapshot] — Current metrics snapshot
   * @returns {{ hypotheses: object[], excluded: object[] }}
   */
  generate({ actions, guard, snapshot }) {
    const failureHistory = this._loadFailureHistory();
    const excluded = [];
    const hypotheses = [];

    for (const action of actions) {
      // Source 2: Check failure history — skip actions that failed recently
      const recentFailure = this._findRecentFailure(failureHistory, action.type);
      if (recentFailure) {
        excluded.push({
          action: action.title,
          type: action.type,
          reason: `Failed ${recentFailure.daysAgo}d ago: ${recentFailure.reason}`,
          failureId: recentFailure.id,
        });
        if (this._verbose) {
          console.log(`[HypothesisGen] ⏭️  Skipping "${action.type}" — failed ${recentFailure.daysAgo}d ago`);
        }
        continue;
      }

      // Source 1 + 3: Score hypothesis based on target gap + pattern confidence
      const confidence = this._computeConfidence(action, guard, snapshot, failureHistory);

      hypotheses.push({
        ...action,
        confidence,
        hypothesis: `Executing "${action.type}" will improve ${action.targetMetric || 'overall health'}`,
      });
    }

    // Rank by confidence (highest first)
    hypotheses.sort((a, b) => b.confidence - a.confidence);

    if (this._verbose) {
      console.log(`[HypothesisGen] Generated ${hypotheses.length} hypothesis(es), excluded ${excluded.length}`);
    }

    return { hypotheses, excluded };
  }

  /**
   * Computes confidence score for a hypothesis.
   * Score range: 0.0 (low confidence) to 1.0 (high confidence).
   *
   * @param {object} action
   * @param {object} guard — RegressionGuard
   * @param {object} snapshot — Current metrics
   * @param {object[]} failureHistory
   * @returns {number}
   */
  _computeConfidence(action, guard, snapshot, failureHistory) {
    let score = 0.5; // base confidence

    // Boost: action targets a metric with large gap
    if (action.targetMetric && snapshot?.metrics) {
      try {
        const gaps = guard._computeTargetGaps(snapshot.metrics);
        const gap = gaps.find(g => g.metric === action.targetMetric);
        if (gap) {
          // Larger gap = higher confidence that action is needed
          score += Math.min(0.3, gap.gapPct / 200);
        }
      } catch (_) { /* non-fatal */ }
    }

    // Boost: action priority is CRITICAL or HIGH
    if (action.priority === ACTION_PRIORITY.CRITICAL) score += 0.2;
    else if (action.priority === ACTION_PRIORITY.HIGH) score += 0.1;

    // Penalty: this action type has partial failure history (succeeded sometimes, failed others)
    const typeFailures = failureHistory.filter(f => f.actionType === action.type);
    if (typeFailures.length > 0) {
      score -= Math.min(0.2, typeFailures.length * 0.05);
    }

    return Math.max(0, Math.min(1, +score.toFixed(3)));
  }

  /**
   * Loads recent failure history from experiment-history.jsonl.
   * @param {number} [ttlDays=30]
   * @returns {object[]}
   */
  _loadFailureHistory(ttlDays = 30) {
    if (!fs.existsSync(this._experimentHistoryPath)) return [];
    try {
      const cutoff = Date.now() - ttlDays * 86400000;
      return fs.readFileSync(this._experimentHistoryPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => {
          try { return JSON.parse(l); } catch (_) { return null; }
        })
        .filter(r => r && r.status === 'rolled-back' && new Date(r.timestamp).getTime() > cutoff)
        .map(r => ({
          ...r,
          daysAgo: Math.round((Date.now() - new Date(r.timestamp).getTime()) / 86400000),
        }));
    } catch (_) {
      return [];
    }
  }

  /**
   * Finds the most recent failure for a given action type.
   * @param {object[]} failureHistory
   * @param {string} actionType
   * @returns {object|null}
   */
  _findRecentFailure(failureHistory, actionType) {
    return failureHistory.find(f => f.actionType === actionType) || null;
  }
}

// ─── P2c: Convergence Detection ─────────────────────────────────────────

/**
 * P2c: Checks if the micro-loop should terminate early.
 * Three convergence conditions:
 *   1. All target metrics within threshold → "target-reached"
 *   2. Consecutive iterations with < 1% improvement → "plateau"
 *   3. Consecutive rollbacks ≥ limit → "dead-end"
 *
 * @param {object} opts
 * @param {object[]} opts.iterations
 * @param {object}   opts.guard
 * @param {number}   [opts.plateauThreshold=0.01]
 * @param {number}   [opts.consecutiveRollbackLimit=3]
 * @param {number}   [opts.targetGapThreshold=5]
 * @returns {{ converged: boolean, reason: string }}
 */
function _checkConvergence(opts = {}) {
  const {
    iterations = [],
    guard,
    plateauThreshold = 0.01,
    consecutiveRollbackLimit = 3,
    targetGapThreshold = 5,
  } = opts;

  if (iterations.length === 0) return { converged: false, reason: '' };

  // Condition 1: All target metrics within threshold
  try {
    const snapshot = guard.snapshotMetrics();
    const gaps = guard._computeTargetGaps(snapshot.metrics);
    if (gaps.length === 0 || gaps.every(g => g.gapPct <= targetGapThreshold)) {
      return {
        converged: true,
        reason: `All metrics within ${targetGapThreshold}% of target — optimization complete`,
      };
    }
  } catch (_) { /* non-fatal */ }

  // Condition 2: Plateau detection
  const recentKept = iterations.filter(it => it.status === 'kept').slice(-2);
  if (recentKept.length >= 2) {
    const allNegligible = recentKept.every(it => {
      const improved = it.delta?.improved || [];
      return improved.length === 0;
    });
    if (allNegligible) {
      return {
        converged: true,
        reason: `Plateau detected: last ${recentKept.length} iterations had no measurable improvement`,
      };
    }
  }

  // Condition 3: Dead-end — consecutive rollbacks
  let consecutiveRollbacks = 0;
  for (let i = iterations.length - 1; i >= 0; i--) {
    if (iterations[i].status === 'rolled-back') {
      consecutiveRollbacks++;
    } else {
      break;
    }
  }
  if (consecutiveRollbacks >= consecutiveRollbackLimit) {
    return {
      converged: true,
      reason: `Dead-end: ${consecutiveRollbacks} consecutive rollback(s) — no viable actions remaining`,
    };
  }

  return { converged: false, reason: '' };
}

// ─── P3a: Experiment History Persistence ────────────────────────────────

/**
 * P3a: Persists a micro-loop iteration result to experiment-history.jsonl.
 *
 * @param {object} iteration
 * @param {object} [context]
 */
function _persistExperimentHistory(iteration, context = {}) {
  const record = {
    id: `EXH-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    actionType: iteration.type || 'unknown',
    actionTitle: iteration.action,
    status: iteration.status,
    delta: iteration.delta || {},
    durationMs: iteration.durationMs || 0,
    confidence: context.confidence || null,
    reason: iteration.status === 'rolled-back'
      ? `Degraded: ${(iteration.delta?.degraded || []).join(', ')}`
      : null,
  };

  try {
    if (!fs.existsSync(this._outputDir)) {
      fs.mkdirSync(this._outputDir, { recursive: true });
    }
    fs.appendFileSync(this._experimentHistoryPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch (_) { /* non-fatal */ }
}

// ─── P3b: Failure Experience Feedback ───────────────────────────────────

/**
 * P3b: Records a rolled-back action as a NEGATIVE experience in ExperienceStore.
 *
 * @param {object} iteration
 */
function _recordFailureExperience(iteration) {
  if (!this._orch?.experienceStore) return;

  try {
    const { ExperienceType, ExperienceCategory } = require('./experience-store');
    const title = `[MAPE:Rollback] ${iteration.type}: ${(iteration.delta?.degraded || []).join(', ')} degraded`;

    this._orch.experienceStore.recordIfAbsent(title, {
      type: ExperienceType.NEGATIVE,
      category: ExperienceCategory.STABLE_PATTERN || 'stable-pattern',
      title,
      content: [
        `Action: ${iteration.action}`,
        `Type: ${iteration.type}`,
        `Status: ${iteration.status}`,
        `Degraded metrics: ${(iteration.delta?.degraded || []).join(', ')}`,
        `Improved metrics: ${(iteration.delta?.improved || []).join(', ')}`,
        `Duration: ${iteration.durationMs}ms`,
        `Conclusion: This action type should be avoided for the current metric configuration.`,
      ].join('\n'),
      tags: ['mape-rollback', iteration.type, ...(iteration.delta?.degraded || [])],
      ttlDays: 30,
    });

    if (this._verbose) {
      console.log(`[MAPE:Feedback] 📝 Recorded failure experience: ${title}`);
    }
  } catch (_) { /* non-fatal */ }
}

/**
 * Canary health check: verifies the system is still operational.
 * @returns {boolean}
 */
function _canaryCheck() {
  try {
    // Check 1: Can we still load config?
    const configPath = path.join(this._orch?.projectRoot || process.cwd(), 'workflow.config.js');
    if (fs.existsSync(configPath)) {
      delete require.cache[require.resolve(configPath)];
      require(configPath);
    }
    // Check 2: Is ExperienceStore intact?
    if (this._orch?.experienceStore) {
      const count = this._orch.experienceStore.experiences.length;
      if (count === 0 && this._orch.experienceStore._titleIndex?.size > 0) {
        return false; // Data corruption
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Simple hash for quick content comparison (used by _execSkillRollback).
 * @param {string} content
 * @returns {string}
 */
function _quickHash(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return 'h' + (hash >>> 0).toString(36);
}

module.exports = {
  HypothesisGenerator,
  // Mixin methods for MAPEEngine.prototype
  _checkConvergence,
  _persistExperimentHistory,
  _recordFailureExperience,
  _canaryCheck,
  _quickHash,
};
