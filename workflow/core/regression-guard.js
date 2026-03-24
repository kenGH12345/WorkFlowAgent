/**
 * Regression Guard — Cross-Session Quality Delta Tracking (ADR-35, P2b)
 *
 * Solves the problem: "After evolving skills/config, did things actually improve?"
 *
 * Before each evolve cycle, captures a quality baseline snapshot:
 *   - Quality gate pass/fail history
 *   - Error rates and token usage trends
 *   - Test pass rates
 *   - Experience hit-rates
 *   - Skill effectiveness scores
 *
 * After evolve, compares the new metrics against the baseline.
 * If quality degraded after a skill refresh → auto-rollback the skill.
 *
 * Integration:
 *   - /evolve captures baseline BEFORE running steps
 *   - _finalizeWorkflow() records post-run metrics
 *   - Regression detected → skill rollback via git + experience annotation
 *
 * Design: Pure comparison logic. No LLM calls. No new external dependencies.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Quality Metric Keys ────────────────────────────────────────────────────

const METRIC_KEY = {
  ERROR_RATE:       'errorRate',
  TOKEN_USAGE:      'tokenUsage',
  TEST_PASS_RATE:   'testPassRate',
  DURATION_MS:      'durationMs',
  EXP_HIT_RATE:     'expHitRate',
  GATE_PASS_RATE:   'gatePassRate',
  SKILL_EFFECTIVE:  'skillEffectiveRate',
};

// ─── Metric Direction Registry ──────────────────────────────────────────────
// Defines whether each metric improves by going UP or DOWN.
// Inspired by pi-autoresearch's metric+direction pattern.

const METRIC_DIRECTION = {
  [METRIC_KEY.ERROR_RATE]:      'minimize', // lower is better
  [METRIC_KEY.TOKEN_USAGE]:     'minimize', // lower is better
  [METRIC_KEY.DURATION_MS]:     'minimize', // lower is better
  [METRIC_KEY.TEST_PASS_RATE]:  'maximize', // higher is better
  [METRIC_KEY.EXP_HIT_RATE]:    'maximize', // higher is better
  [METRIC_KEY.GATE_PASS_RATE]:  'maximize', // higher is better
  [METRIC_KEY.SKILL_EFFECTIVE]: 'maximize', // higher is better
};

// ─── Metric Target Registry ─────────────────────────────────────────────────
// Defines target thresholds. Once a metric reaches its target, it is considered
// "healthy" and optimization effort shifts to other metrics.
// Targets can be overridden via constructor opts.targets.

const DEFAULT_METRIC_TARGETS = {
  [METRIC_KEY.ERROR_RATE]:      0,     // zero errors
  [METRIC_KEY.TOKEN_USAGE]:     5000,  // ≤5K tokens per session
  [METRIC_KEY.DURATION_MS]:     60000, // ≤60s per session
  [METRIC_KEY.TEST_PASS_RATE]:  0.95,  // ≥95% test pass
  [METRIC_KEY.EXP_HIT_RATE]:    0.6,   // ≥60% experience relevance
  [METRIC_KEY.GATE_PASS_RATE]:  0.9,   // ≥90% quality gates pass
  [METRIC_KEY.SKILL_EFFECTIVE]: 0.7,   // ≥70% skill effectiveness
};

// ─── Regression Guard Class ─────────────────────────────────────────────────

class RegressionGuard {
  /**
   * @param {object} opts
   * @param {string} opts.outputDir — Path to output directory
   * @param {boolean} [opts.verbose]
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || path.join(process.cwd(), 'workflow', 'output');
    this._verbose   = opts.verbose ?? false;
    this._baselinePath = path.join(this._outputDir, 'evolve-baseline.json');
    this._historyPath  = path.join(this._outputDir, 'evolve-history.jsonl');
    this._targets   = { ...DEFAULT_METRIC_TARGETS, ...(opts.targets || {}) };
  }

  // ─── Capture Baseline ─────────────────────────────────────────────────

  /**
   * Captures a quality baseline snapshot from the most recent metrics.
   * Call this BEFORE running any evolve steps.
   *
   * @returns {object} Baseline snapshot
   */
  captureBaseline() {
    const baseline = {
      capturedAt: new Date().toISOString(),
      metrics: {},
      skillVersions: {},
    };

    // Read recent metrics history
    try {
      const ObsStrategy = require('./observability-strategy');
      const history = ObsStrategy.loadHistory(this._outputDir);
      const recent = history.slice(0, 5);

      if (recent.length > 0) {
        // Average error rate
        const errorRates = recent.map(h => h.errorCount || 0);
        baseline.metrics[METRIC_KEY.ERROR_RATE] = +(errorRates.reduce((a, b) => a + b, 0) / errorRates.length).toFixed(2);

        // Average token usage
        const tokens = recent.map(h => h.tokensEst || 0).filter(t => t > 0);
        if (tokens.length > 0) {
          baseline.metrics[METRIC_KEY.TOKEN_USAGE] = Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);
        }

        // Average test pass rate
        const testRates = recent
          .filter(h => h.testPassed != null && h.testFailed != null)
          .map(h => {
            const total = (h.testPassed || 0) + (h.testFailed || 0);
            return total > 0 ? (h.testPassed || 0) / total : 1;
          });
        if (testRates.length > 0) {
          baseline.metrics[METRIC_KEY.TEST_PASS_RATE] = +(testRates.reduce((a, b) => a + b, 0) / testRates.length).toFixed(3);
        }

        // Average duration
        const durations = recent.map(h => h.totalDurationMs || 0).filter(d => d > 0);
        if (durations.length > 0) {
          baseline.metrics[METRIC_KEY.DURATION_MS] = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
        }

        // Average experience hit rate
        const hitRates = recent
          .filter(h => (h.expInjectedCount || 0) > 0)
          .map(h => (h.expHitCount || 0) / h.expInjectedCount);
        if (hitRates.length > 0) {
          baseline.metrics[METRIC_KEY.EXP_HIT_RATE] = +(hitRates.reduce((a, b) => a + b, 0) / hitRates.length).toFixed(3);
        }

        // Skill effectiveness: count of effective skills from most recent run
        const latest = recent[0];
        if (latest.skillEffectiveCount != null) {
          baseline.metrics[METRIC_KEY.SKILL_EFFECTIVE] = latest.skillEffectiveCount;
        }
      }
    } catch (_) { /* non-fatal */ }

    // Capture skill file versions (for rollback detection)
    try {
      const skillsDir = path.join(this._outputDir, '..', 'skills');
      if (fs.existsSync(skillsDir)) {
        const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
        for (const f of skillFiles) {
          const fullPath = path.join(skillsDir, f);
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, 'utf-8');
          // Extract version from frontmatter
          const versionMatch = content.match(/^version:\s*(.+)$/m);
          baseline.skillVersions[f.replace('.md', '')] = {
            version: versionMatch ? versionMatch[1].trim() : 'unknown',
            modifiedAt: stat.mtime.toISOString(),
            size: stat.size,
            hash: this._quickHash(content),
          };
        }
      }
    } catch (_) { /* non-fatal */ }

    // Save baseline to disk
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      fs.writeFileSync(this._baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
    } catch (_) { /* non-fatal */ }

    if (this._verbose) {
      console.log(`[RegressionGuard] 📸 Baseline captured: ${Object.keys(baseline.metrics).length} metrics, ${Object.keys(baseline.skillVersions).length} skills`);
    }

    return baseline;
  }

  // ─── Compare Against Baseline ─────────────────────────────────────────

  /**
   * Compares current metrics against the saved baseline.
   * Call this AFTER evolve steps complete and at least one workflow run has finished.
   *
   * @param {object} [currentMetrics] — Override: pass current metrics directly
   * @returns {{ improved: string[], degraded: string[], unchanged: string[], regressions: object[], delta: object }}
   */
  compareWithBaseline(currentMetrics) {
    // Load baseline
    let baseline;
    try {
      baseline = JSON.parse(fs.readFileSync(this._baselinePath, 'utf-8'));
    } catch (_) {
      return { improved: [], degraded: [], unchanged: [], regressions: [], delta: {}, error: 'No baseline found' };
    }

    // Get current metrics (from latest run-metrics.json or parameter)
    const current = currentMetrics || this._loadCurrentMetrics();
    if (!current) {
      return { improved: [], degraded: [], unchanged: [], regressions: [], delta: {}, error: 'No current metrics' };
    }

    const improved = [];
    const degraded = [];
    const unchanged = [];
    const delta = {};

    // Compare each metric
    for (const [key, baselineValue] of Object.entries(baseline.metrics)) {
      const currentValue = current[key];
      if (currentValue == null) continue;

      const diff = currentValue - baselineValue;
      const pctChange = baselineValue !== 0 ? (diff / baselineValue) * 100 : 0;

      delta[key] = {
        before: baselineValue,
        after:  currentValue,
        diff:   +diff.toFixed(3),
        pctChange: +pctChange.toFixed(1),
      };

      // Determine direction from the registry (replaces hardcoded list)
      const direction = METRIC_DIRECTION[key] || 'maximize';
      const isMinimize = direction === 'minimize';
      const threshold = 0.05; // 5% change threshold

      if (Math.abs(pctChange) < threshold * 100) {
        unchanged.push(key);
      } else if ((isMinimize && diff < 0) || (!isMinimize && diff > 0)) {
        improved.push(key);
      } else {
        degraded.push(key);
      }
    }

    // Detect skill-specific regressions
    const regressions = this._detectSkillRegressions(baseline);

    if (this._verbose) {
      console.log(`[RegressionGuard] 📊 Comparison: ${improved.length} improved, ${degraded.length} degraded, ${unchanged.length} unchanged, ${regressions.length} regression(s)`);
    }

    // Compute target gap analysis — which metrics are still below target?
    const targetGaps = this._computeTargetGaps(current);

    return { improved, degraded, unchanged, regressions, delta, targetGaps };
  }

  // ─── Target Gap Analysis ──────────────────────────────────────────────

  /**
   * Computes which metrics have not yet reached their targets.
   * Returns an array of { metric, direction, current, target, gapPct }.
   *
   * @param {object} currentMetrics
   * @returns {object[]}
   */
  _computeTargetGaps(currentMetrics) {
    const gaps = [];
    for (const [key, target] of Object.entries(this._targets)) {
      const current = currentMetrics?.[key];
      if (current == null || target == null) continue;

      const direction = METRIC_DIRECTION[key] || 'maximize';
      const isMinimize = direction === 'minimize';

      // Check if target is met
      const targetMet = isMinimize ? current <= target : current >= target;
      if (targetMet) continue;

      // Compute gap percentage
      const gap = isMinimize ? current - target : target - current;
      const gapPct = target !== 0 ? +((gap / target) * 100).toFixed(1) : Infinity;

      gaps.push({
        metric: key,
        direction,
        current,
        target,
        gap: +gap.toFixed(3),
        gapPct,
      });
    }

    // Sort by gap percentage (largest gap first = highest priority)
    gaps.sort((a, b) => b.gapPct - a.gapPct);
    return gaps;
  }

  // ─── Snapshot / Rollback Helpers (for MAPE Micro-Loop) ────────────────

  /**
   * Takes a lightweight metrics snapshot for micro-loop comparison.
   * Unlike captureBaseline(), this is fast and doesn't persist to disk.
   *
   * @returns {object} { metrics: {...}, snapshotAt: string }
   */
  snapshotMetrics() {
    const metrics = this._loadCurrentMetrics() || {};
    return {
      metrics,
      snapshotAt: new Date().toISOString(),
    };
  }

  /**
   * Compares a post-action snapshot against a pre-action snapshot.
   * Returns { improved, degraded, shouldRollback }.
   *
   * @param {object} before — From snapshotMetrics()
   * @param {object} after  — From snapshotMetrics() or direct metrics
   * @param {object} [opts]
   * @param {number} [opts.degradationThreshold=0.1] — 10% degradation triggers rollback
   * @returns {{ improved: string[], degraded: string[], shouldRollback: boolean, reason: string }}
   */
  evaluateMicroDelta(before, after, opts = {}) {
    const { degradationThreshold = 0.1 } = opts;
    const improved = [];
    const degraded = [];

    for (const [key, beforeVal] of Object.entries(before.metrics || {})) {
      const afterVal = (after.metrics || after)[key];
      if (afterVal == null) continue;

      const diff = afterVal - beforeVal;
      const pctChange = beforeVal !== 0 ? Math.abs(diff / beforeVal) : 0;
      if (pctChange < 0.01) continue; // < 1% = noise

      const direction = METRIC_DIRECTION[key] || 'maximize';
      const isMinimize = direction === 'minimize';
      const isImproved = (isMinimize && diff < 0) || (!isMinimize && diff > 0);

      if (isImproved) {
        improved.push(key);
      } else if (pctChange >= degradationThreshold) {
        degraded.push(key);
      }
    }

    const shouldRollback = degraded.length > 0 && degraded.length >= improved.length;
    const reason = shouldRollback
      ? `${degraded.length} metric(s) degraded ≥${(degradationThreshold * 100).toFixed(0)}%: ${degraded.join(', ')}`
      : '';

    return { improved, degraded, shouldRollback, reason };
  }

  // ─── Detect Skill Regressions ─────────────────────────────────────────

  /**
   * Checks if any skills changed and whether the change correlated with quality degradation.
   *
   * @param {object} baseline
   * @returns {object[]} Array of { skillName, reason, action }
   */
  _detectSkillRegressions(baseline) {
    const regressions = [];

    try {
      const skillsDir = path.join(this._outputDir, '..', 'skills');
      if (!fs.existsSync(skillsDir)) return regressions;

      for (const [skillName, baselineInfo] of Object.entries(baseline.skillVersions || {})) {
        const skillPath = path.join(skillsDir, `${skillName}.md`);
        if (!fs.existsSync(skillPath)) continue;

        const content = fs.readFileSync(skillPath, 'utf-8');
        const currentHash = this._quickHash(content);

        if (currentHash !== baselineInfo.hash) {
          // Skill content changed since baseline
          regressions.push({
            skillName,
            reason: 'content-changed-since-baseline',
            baselineVersion: baselineInfo.version,
            baselineHash: baselineInfo.hash,
            currentHash,
            action: 'monitor', // Mark for monitoring; auto-rollback only on confirmed degradation
          });
        }
      }
    } catch (_) { /* non-fatal */ }

    return regressions;
  }

  // ─── Record Evolution Outcome ─────────────────────────────────────────

  /**
   * Records the outcome of an evolution cycle for long-term trend analysis.
   * Appended to evolve-history.jsonl.
   *
   * @param {object} evolveReport — From /evolve command
   * @param {object} comparison   — From compareWithBaseline()
   * @param {object} [mapeReport] — From MAPEEngine.runCycle()
   */
  recordOutcome(evolveReport, comparison, mapeReport) {
    const record = {
      timestamp:   new Date().toISOString(),
      improved:    comparison.improved,
      degraded:    comparison.degraded,
      unchanged:   comparison.unchanged,
      regressions: comparison.regressions.length,
      delta:       comparison.delta,
      stepsRun:    (evolveReport.steps || []).map(s => ({ name: s.name, status: s.status })),
      mapeROI:     mapeReport?.phases?.plan?.estimatedROI || null,
      mapeActions: mapeReport?.phases?.execute?.executed || 0,
    };

    // Calculate Evolution ROI Score
    // ROI = (improved metrics × weight) / (LLM tokens used + time spent)
    const improvedWeight = comparison.improved.length * 3;
    const degradedPenalty = comparison.degraded.length * -5;
    const regressionPenalty = comparison.regressions.length * -10;
    record.evolutionROI = +(improvedWeight + degradedPenalty + regressionPenalty).toFixed(1);

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      fs.appendFileSync(this._historyPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (_) { /* non-fatal */ }

    if (this._verbose) {
      console.log(`[RegressionGuard] 📝 Outcome recorded: ROI=${record.evolutionROI}, improved=${comparison.improved.length}, degraded=${comparison.degraded.length}`);
    }

    return record;
  }

  // ─── Load Evolution History ───────────────────────────────────────────

  /**
   * Loads the evolution outcome history for trend analysis.
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  loadHistory(limit = 20) {
    if (!fs.existsSync(this._historyPath)) return [];
    try {
      return fs.readFileSync(this._historyPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
        .reverse()
        .slice(0, limit);
    } catch (_) {
      return [];
    }
  }

  /**
   * Returns a trend summary of evolution effectiveness.
   * @returns {object}
   */
  getTrend() {
    const history = this.loadHistory(10);
    if (history.length === 0) {
      return { cycles: 0, avgROI: 0, trend: 'no-data' };
    }

    const roiValues = history.map(h => h.evolutionROI || 0);
    const avgROI = roiValues.reduce((a, b) => a + b, 0) / roiValues.length;

    // Trend direction: compare first half vs second half
    const half = Math.ceil(roiValues.length / 2);
    const recentAvg = roiValues.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const olderAvg = roiValues.slice(half).reduce((a, b) => a + b, 0) / (roiValues.length - half || 1);

    let trend = 'stable';
    if (recentAvg > olderAvg + 1) trend = 'improving';
    if (recentAvg < olderAvg - 1) trend = 'degrading';

    return {
      cycles: history.length,
      avgROI: +avgROI.toFixed(1),
      trend,
      recentROI: roiValues.slice(0, 3),
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _loadCurrentMetrics() {
    try {
      const ObsStrategy = require('./observability-strategy');
      const history = ObsStrategy.loadHistory(this._outputDir);
      if (history.length === 0) return null;

      const recent = history.slice(0, 3);
      const metrics = {};

      const errorRates = recent.map(h => h.errorCount || 0);
      metrics[METRIC_KEY.ERROR_RATE] = +(errorRates.reduce((a, b) => a + b, 0) / errorRates.length).toFixed(2);

      const tokens = recent.map(h => h.tokensEst || 0).filter(t => t > 0);
      if (tokens.length > 0) {
        metrics[METRIC_KEY.TOKEN_USAGE] = Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);
      }

      const durations = recent.map(h => h.totalDurationMs || 0).filter(d => d > 0);
      if (durations.length > 0) {
        metrics[METRIC_KEY.DURATION_MS] = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
      }

      const hitRates = recent
        .filter(h => (h.expInjectedCount || 0) > 0)
        .map(h => (h.expHitCount || 0) / h.expInjectedCount);
      if (hitRates.length > 0) {
        metrics[METRIC_KEY.EXP_HIT_RATE] = +(hitRates.reduce((a, b) => a + b, 0) / hitRates.length).toFixed(3);
      }

      return metrics;
    } catch (_) {
      return null;
    }
  }

  /**
   * Simple hash for quick content comparison (not cryptographic).
   * @param {string} content
   * @returns {string}
   */
  _quickHash(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const ch = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash |= 0; // Convert to 32bit integer
    }
    return 'h' + (hash >>> 0).toString(36);
  }
}

module.exports = { RegressionGuard, METRIC_KEY, METRIC_DIRECTION, DEFAULT_METRIC_TARGETS };
