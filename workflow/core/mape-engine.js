/**
 * MAPE Engine - Monitor-Analyze-Plan-Execute Closed-Loop (ADR-35, P2a)
 *
 * Architecture: Split into 4 files for maintainability (core/*.js 400-line rule):
 *   - mape-constants.js    - Shared enums (MAPE_PHASE, ACTION_PRIORITY, ACTION_TYPE)
 *   - mape-hypothesis.js   - HypothesisGenerator class + micro-loop utilities
 *   - mape-executors.js    - 11 action executors + rollback handler
 *   - mape-engine.js       - THIS FILE: MAPEEngine class (orchestration skeleton)
 *
 * Design: Stateless per-invocation. All state comes from disk (metrics-history,
 * reflections, audit reports). Reuses existing module APIs without modification.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Shared constants
const { MAPE_PHASE, ACTION_PRIORITY, ACTION_TYPE } = require('./mape-constants');

// Extracted modules (mixed into MAPEEngine.prototype below)
const executors    = require('./mape-executors');
const hypothesisMod = require('./mape-hypothesis');
const { HypothesisGenerator } = hypothesisMod;

// ─── MAPE Engine Class ──────────────────────────────────────────────────────

class MAPEEngine {
  /**
   * @param {object} opts
   * @param {object} opts.orchestrator — Orchestrator instance
   * @param {boolean} [opts.verbose]
   */
  constructor(opts = {}) {
    this._orch = opts.orchestrator;
    this._verbose = opts.verbose ?? false;
    this._outputDir = this._orch?._outputDir || path.join(process.cwd(), 'workflow', 'output');
    this._microLoopMaxIter = opts.microLoopMaxIter ?? 3;
    this._experimentHistoryPath = path.join(this._outputDir, 'experiment-history.jsonl');
  }

  // ─── Full MAPE Cycle ──────────────────────────────────────────────────

  /**
   * Runs a complete MAPE cycle: Monitor → Analyze → Plan → Execute.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun=false] — Plan only, skip Execute phase
   * @param {number}  [opts.maxActions=10] — Max actions to plan
   * @returns {object} MAPE cycle report
   */
  async runCycle(opts = {}) {
    const { dryRun = false, maxActions = 10 } = opts;
    const startTime = Date.now();

    // Phase 1: Monitor
    const signals = this.monitor();

    // Phase 2: Analyze
    const analysis = this.analyze(signals);

    // Phase 3: Plan
    const plan = this.plan(analysis, { maxActions });

    // Phase 4: Execute (skip in dry-run)
    let execution = { executed: 0, skipped: plan.actions.length, results: [] };
    if (!dryRun && plan.actions.length > 0) {
      execution = await this.execute(plan);
    }

    const elapsed = Date.now() - startTime;

    const report = {
      phases: {
        monitor:  { signalCount: signals.length, signals },
        analyze:  { rootCauses: analysis.rootCauses.length, correlations: analysis.correlations.length, analysis },
        plan:     { actionCount: plan.actions.length, estimatedROI: plan.estimatedROI, plan },
        execute:  execution,
      },
      elapsed,
      dryRun,
      timestamp: new Date().toISOString(),
    };

    // P2 fix: Persist analysis to mape-analysis.jsonl for cross-session tracking
    this._persistAnalysis(analysis, report);

    return report;
  }

  /**
   * P2 fix: Persists MAPE analysis results to mape-analysis.jsonl for cross-session tracking.
   * Enables long-term trend analysis and evolution tracking.
   *
   * @param {object} analysis - The analysis result from analyze()
   * @param {object} report - The full MAPE cycle report
   */
  _persistAnalysis(analysis, report) {
    try {
      const outputPath = path.join(this._outputDir || path.join(process.cwd(), 'output'), 'mape-analysis.jsonl');

      // Ensure output directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const entry = {
        timestamp: report.timestamp,
        elapsed: report.elapsed,
        dryRun: report.dryRun,
        signals: {
          count: report.phases.monitor.signalCount,
          topTypes: this._summarizeSignalTypes(report.phases.monitor.signals),
        },
        analysis: {
          rootCauses: (analysis.rootCauses || []).slice(0, 5).map(rc => ({
            type: rc.type,
            severity: rc.severity,
            source: rc.source,
          })),
          correlations: (analysis.correlations || []).slice(0, 3).map(c => ({
            pattern: c.pattern,
            confidence: c.confidence,
          })),
        },
        plan: {
          actionCount: report.phases.plan.actionCount,
          estimatedROI: report.phases.plan.estimatedROI,
          topActions: (report.phases.plan.plan.actions || []).slice(0, 3).map(a => ({
            type: a.type,
            priority: a.priority,
            target: a.target,
          })),
        },
        execution: {
          executed: report.phases.execute.executed,
          skipped: report.phases.execute.skipped,
        },
      };

      fs.appendFileSync(outputPath, JSON.stringify(entry) + '\n', 'utf-8');
      console.log(`[MAPE] 📊 Analysis persisted to mape-analysis.jsonl`);
    } catch (err) {
      console.warn(`[MAPE] ⚠️  Could not persist analysis: ${err.message}`);
    }
  }

  /**
   * Summarizes signal types for compact logging.
   *
   * @param {Array} signals
   * @returns {Array<{type: string, count: number}>}
   */
  _summarizeSignalTypes(signals) {
    const counts = {};
    for (const s of (signals || [])) {
      const type = s.type || 'unknown';
      counts[type] = (counts[type] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));
  }

  // ─── Phase 1: MONITOR ─────────────────────────────────────────────────

  /**
   * Collects anomaly signals from all available sources.
   * Returns a unified signal array sorted by severity.
   *
   * @returns {object[]} Array of { source, type, severity, title, data }
   */
  monitor() {
    const signals = [];

    // Source 1: Metrics History — cross-session trends
    try {
      const ObsStrategy = require('./observability-strategy');
      const history = ObsStrategy.loadHistory(this._outputDir);

      if (history.length >= 3) {
        const trends = ObsStrategy.computeTrends(history);
        if (trends) {
          // Token trend increasing?
          if (trends.tokenTrend > 0.1) {
            signals.push({
              source: 'metrics-history', type: 'anomaly', severity: 'medium',
              title: 'Token usage trending upward',
              data: { trend: trends.tokenTrend, sessions: history.length },
            });
          }
          // Error rate increasing?
          if (trends.errorTrend > 0) {
            signals.push({
              source: 'metrics-history', type: 'anomaly', severity: 'high',
              title: 'Error rate trending upward',
              data: { trend: trends.errorTrend, sessions: history.length },
            });
          }
          // Duration regression?
          if (trends.durationTrend > 0.2) {
            signals.push({
              source: 'metrics-history', type: 'anomaly', severity: 'medium',
              title: 'Workflow duration trending longer',
              data: { trend: trends.durationTrend, sessions: history.length },
            });
          }
        }

        // Experience hit-rate check
        const recent = history.slice(0, 5);
        const avgHitRate = recent.reduce((s, h) => {
          const injected = h.expInjectedCount || 0;
          const hit = h.expHitCount || 0;
          return s + (injected > 0 ? hit / injected : 1);
        }, 0) / recent.length;

        if (avgHitRate < 0.3 && recent.some(h => (h.expInjectedCount || 0) > 0)) {
          signals.push({
            source: 'metrics-history', type: 'anomaly', severity: 'high',
            title: 'Low experience hit-rate (< 30%)',
            data: { avgHitRate: (avgHitRate * 100).toFixed(1) + '%', recentSessions: recent.length },
          });
        }
      }
    } catch (_) { /* non-fatal */ }

    // Source 2: Self-Reflection — quality gate failures and recurring patterns
    try {
      if (this._orch?._selfReflection) {
        const sr = this._orch._selfReflection;
        const report = sr.reflect({ limit: 20, openOnly: true });

        for (const entry of (report.prioritised || []).slice(0, 10)) {
          signals.push({
            source: 'self-reflection', type: entry.type,
            severity: entry.severity || 'medium',
            title: entry.title,
            data: { patternKey: entry.patternKey, count: entry.metrics?.patternCount },
          });
        }
      }
    } catch (_) { /* non-fatal */ }

    // Source 3: Quality gate history — recent failures
    try {
      const metricsPath = path.join(this._outputDir, 'run-metrics.json');
      if (fs.existsSync(metricsPath)) {
        const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
        if (metrics.reflectionGating && !metrics.reflectionGating.passed) {
          const failed = (metrics.reflectionGating.gates || []).filter(g => !g.passed);
          for (const gate of failed) {
            signals.push({
              source: 'quality-gate', type: 'gate-failure', severity: 'high',
              title: `Quality gate failed: ${gate.name}`,
              data: { actual: gate.actual, threshold: gate.threshold },
            });
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    // Source 4: Entropy — structural violations
    try {
      const entropyPath = path.join(this._outputDir, 'entropy-report.json');
      if (fs.existsSync(entropyPath)) {
        const entropy = JSON.parse(fs.readFileSync(entropyPath, 'utf-8'));
        for (const v of (entropy.violations || []).slice(0, 5)) {
          signals.push({
            source: 'entropy', type: 'violation', severity: v.severity || 'medium',
            title: v.message || v.rule || 'Entropy violation',
            data: v,
          });
        }
      }
    } catch (_) { /* non-fatal */ }

    // Source 5: Metric calibration — unreachable targets (dead-end signal)
    try {
      const { RegressionGuard } = require('./regression-guard');
      const guard = new RegressionGuard({ outputDir: this._outputDir });
      const snapshot = guard.snapshotMetrics();
      const gaps = guard._computeTargetGaps(snapshot.metrics);

      // Check for metrics stuck far from target (>100% gap = likely unreachable)
      for (const gap of gaps.filter(g => g.gapPct > 100).slice(0, 3)) {
        signals.push({
          source: 'metric-calibration', type: 'unreachable-target', severity: 'medium',
          title: `Metric "${gap.metric}" far from target (${gap.gapPct}% gap)`,
          data: { metric: gap.metric, current: gap.current, target: gap.target, gapPct: gap.gapPct },
        });
      }
    } catch (_) { /* non-fatal */ }

    // Source 6: Prompt performance — low gate-pass rate on prompt slots
    try {
      if (this._orch?.promptSlotManager) {
        const stats = this._orch.promptSlotManager.getStats();
        for (const [slotKey, slotInfo] of Object.entries(stats)) {
          const active = slotInfo.variants[slotInfo.activeVariant];
          if (!active || active.totalTrials < 3) continue;
          const passRate = parseFloat(active.gatePassRate);
          if (!isNaN(passRate) && passRate < 0.7) {
            signals.push({
              source: 'prompt-performance', type: 'low-pass-rate', severity: 'medium',
              title: `Prompt slot "${slotKey}" has low pass rate (${(passRate * 100).toFixed(0)}%)`,
              data: { slotKey, passRate, trials: active.totalTrials, activeVariant: slotInfo.activeVariant },
            });
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    // Source 7: Experience store bloat — high count + low hit-rate
    try {
      if (this._orch?.experienceStore) {
        const count = this._orch.experienceStore.experiences.length;
        // Cross-reference with hit-rate signal
        const hasLowHitRateSignal = signals.some(s => s.title?.includes('hit-rate'));
        if (count > 100 || (count > 50 && hasLowHitRateSignal)) {
          signals.push({
            source: 'experience-store', type: 'bloat', severity: 'low',
            title: `Experience store bloated (${count} entries)${hasLowHitRateSignal ? ' with low hit-rate' : ''}`,
            data: { experienceCount: count, hasLowHitRate: hasLowHitRateSignal },
          });
        }
      }
    } catch (_) { /* non-fatal */ }

    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    signals.sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5));

    if (this._verbose) {
      console.log(`[MAPE:Monitor] Collected ${signals.length} signal(s) from ${new Set(signals.map(s => s.source)).size} source(s)`);
    }

    return signals;
  }

  // ─── Phase 2: ANALYZE ─────────────────────────────────────────────────

  /**
   * Cross-correlates signals to identify root causes and relationships.
   *
   * @param {object[]} signals — From monitor()
   * @returns {{ rootCauses: object[], correlations: object[], signalGroups: object }}
   */
  analyze(signals) {
    const rootCauses = [];
    const correlations = [];

    // Group signals by source
    const bySource = {};
    for (const sig of signals) {
      if (!bySource[sig.source]) bySource[sig.source] = [];
      bySource[sig.source].push(sig);
    }

    // Group signals by pattern key (if available)
    const byPattern = {};
    for (const sig of signals) {
      const key = sig.data?.patternKey || sig.title;
      if (!byPattern[key]) byPattern[key] = [];
      byPattern[key].push(sig);
    }

    // Correlation 1: Quality gate failure + token trend = config mistuning
    const hasGateFailure = signals.some(s => s.source === 'quality-gate');
    const hasTokenTrend  = signals.some(s => s.title?.includes('Token usage'));
    if (hasGateFailure && hasTokenTrend) {
      correlations.push({
        type: 'config-mistuning',
        description: 'Quality gates failing alongside rising token usage suggests config parameters (maxFixRounds, maxReviewRounds) need adjustment',
        signals: signals.filter(s => s.source === 'quality-gate' || s.title?.includes('Token')),
        suggestedAction: ACTION_TYPE.CONFIG_ADJUSTMENT,
      });
    }

    // Correlation 2: Low experience hit-rate + stale skills = knowledge decay
    const hasLowHitRate = signals.some(s => s.title?.includes('hit-rate'));
    const hasSkillIssue = signals.some(s => s.data?.patternKey?.includes('skill'));
    if (hasLowHitRate || hasSkillIssue) {
      correlations.push({
        type: 'knowledge-decay',
        description: 'Low experience effectiveness or skill issues suggest knowledge base needs refreshing',
        signals: signals.filter(s => s.title?.includes('hit-rate') || s.data?.patternKey?.includes('skill')),
        suggestedAction: ACTION_TYPE.SKILL_REFRESH,
      });
    }

    // Correlation 3: Error trend + duration trend = systematic degradation
    const hasErrorTrend    = signals.some(s => s.title?.includes('Error rate'));
    const hasDurationTrend = signals.some(s => s.title?.includes('duration'));
    if (hasErrorTrend && hasDurationTrend) {
      correlations.push({
        type: 'systematic-degradation',
        description: 'Both error rates and durations increasing indicates fundamental regression',
        signals: signals.filter(s => s.title?.includes('Error') || s.title?.includes('duration')),
        suggestedAction: ACTION_TYPE.ARCHITECTURE_FIX,
      });
    }

    // Correlation 4: Unreachable targets = metric calibration needed
    const hasUnreachableTarget = signals.some(s => s.source === 'metric-calibration');
    if (hasUnreachableTarget) {
      const unreachableSignals = signals.filter(s => s.source === 'metric-calibration');
      correlations.push({
        type: 'unreachable-targets',
        description: `${unreachableSignals.length} metric(s) far from target — targets may need calibration`,
        signals: unreachableSignals,
        suggestedAction: ACTION_TYPE.METRIC_CALIBRATION,
      });
    }

    // Correlation 5: Low prompt performance = prompt evolution needed
    const hasLowPromptPerf = signals.some(s => s.source === 'prompt-performance');
    if (hasLowPromptPerf) {
      correlations.push({
        type: 'prompt-degradation',
        description: 'Prompt slots have low gate-pass rate — variant exploration may find better prompts',
        signals: signals.filter(s => s.source === 'prompt-performance'),
        suggestedAction: ACTION_TYPE.PROMPT_EVOLUTION,
      });
    }

    // Correlation 6: Experience bloat + low hit-rate = distillation needed
    const hasExpBloat = signals.some(s => s.source === 'experience-store');
    if (hasExpBloat && hasLowHitRate) {
      correlations.push({
        type: 'experience-bloat',
        description: 'Experience store is bloated with low hit-rate — distillation will consolidate and improve quality',
        signals: signals.filter(s => s.source === 'experience-store' || s.title?.includes('hit-rate')),
        suggestedAction: ACTION_TYPE.EXPERIENCE_DISTILL,
      });
    }

    // Root cause extraction: recurring patterns are likely root causes
    for (const [key, group] of Object.entries(byPattern)) {
      if (group.length >= 2) {
        rootCauses.push({
          pattern: key,
          occurrences: group.length,
          severity: group[0].severity,
          sources: [...new Set(group.map(s => s.source))],
          suggestedAction: group[0].data?.patternKey?.includes('skill')
            ? ACTION_TYPE.SKILL_REFRESH
            : ACTION_TYPE.EXPERIENCE_CLEANUP,
        });
      }
    }

    rootCauses.sort((a, b) => b.occurrences - a.occurrences);

    if (this._verbose) {
      console.log(`[MAPE:Analyze] Found ${rootCauses.length} root cause(s) and ${correlations.length} correlation(s)`);
    }

    return { rootCauses, correlations, signalGroups: bySource };
  }

  // ─── Phase 3: PLAN ────────────────────────────────────────────────────

  /**
   * Generates a prioritised action plan from analysis results.
   *
   * @param {object} analysis — From analyze()
   * @param {object} [opts]
   * @param {number} [opts.maxActions=10]
   * @returns {{ actions: object[], estimatedROI: number }}
   */
  plan(analysis, opts = {}) {
    const { maxActions = 10 } = opts;
    const actions = [];

    // Generate actions from correlations
    for (const corr of analysis.correlations) {
      actions.push({
        type: corr.suggestedAction,
        priority: corr.type === 'systematic-degradation' ? ACTION_PRIORITY.CRITICAL : ACTION_PRIORITY.HIGH,
        title: `Fix: ${corr.description.slice(0, 80)}`,
        source: `correlation:${corr.type}`,
        estimatedEffort: corr.type === 'config-adjustment' ? 'low' : 'medium',
        estimatedImpact: corr.type === 'systematic-degradation' ? 'high' : 'medium',
      });
    }

    // Generate actions from root causes
    for (const rc of analysis.rootCauses) {
      const existing = actions.find(a => a.type === rc.suggestedAction);
      if (!existing) {
        actions.push({
          type: rc.suggestedAction,
          priority: rc.occurrences >= 3 ? ACTION_PRIORITY.HIGH : ACTION_PRIORITY.MEDIUM,
          title: `Address recurring: ${rc.pattern}`,
          source: `root-cause:${rc.pattern}`,
          estimatedEffort: 'medium',
          estimatedImpact: rc.occurrences >= 3 ? 'high' : 'medium',
        });
      }
    }

    // Sort by priority
    actions.sort((a, b) => a.priority - b.priority);

    // Trim to max
    const trimmedActions = actions.slice(0, maxActions);

    // Estimate ROI: high impact + low effort = high ROI
    const impactMap  = { high: 3, medium: 2, low: 1 };
    const effortMap  = { low: 3, medium: 2, high: 1 };
    const totalROI = trimmedActions.reduce((sum, a) => {
      return sum + (impactMap[a.estimatedImpact] || 1) * (effortMap[a.estimatedEffort] || 1);
    }, 0);

    const estimatedROI = trimmedActions.length > 0
      ? +(totalROI / trimmedActions.length).toFixed(2)
      : 0;

    if (this._verbose) {
      console.log(`[MAPE:Plan] Generated ${trimmedActions.length} action(s), estimated ROI: ${estimatedROI}`);
    }

    // Add target-optimization actions for metrics that haven't reached their targets
    try {
      const { RegressionGuard } = require('./regression-guard');
      const guard = new RegressionGuard({ outputDir: this._outputDir });
      const snapshot = guard.snapshotMetrics();
      const gaps = guard._computeTargetGaps(snapshot.metrics);

      for (const gap of gaps.slice(0, 3)) {
        const existing = trimmedActions.find(a => a.targetMetric === gap.metric);
        if (existing) continue;

        // Map metric gaps to action types
        let actionType = ACTION_TYPE.TARGET_OPTIMIZATION;
        if (gap.gapPct > 100) {
          // P1-ext: Extremely large gap = likely unreachable, calibrate target instead
          actionType = ACTION_TYPE.METRIC_CALIBRATION;
        } else if (gap.metric === 'tokenUsage')    actionType = ACTION_TYPE.CONFIG_ADJUSTMENT;
        else if (gap.metric === 'errorRate')        actionType = ACTION_TYPE.ARCHITECTURE_FIX;
        else if (gap.metric === 'expHitRate')       actionType = ACTION_TYPE.EXPERIENCE_CLEANUP;
        else if (gap.metric === 'skillEffectiveRate') actionType = ACTION_TYPE.SKILL_REFRESH;

        trimmedActions.push({
          type: actionType,
          priority: gap.gapPct > 50 ? ACTION_PRIORITY.HIGH : ACTION_PRIORITY.MEDIUM,
          title: `Optimize ${gap.metric}: ${gap.current} → ${gap.target} (${gap.direction}, ${gap.gapPct}% gap)`,
          source: `target-gap:${gap.metric}`,
          targetMetric: gap.metric,
          estimatedEffort: 'medium',
          estimatedImpact: gap.gapPct > 50 ? 'high' : 'medium',
        });
      }
    } catch (_) { /* non-fatal: RegressionGuard not available */ }

    // Re-sort after adding target actions
    trimmedActions.sort((a, b) => a.priority - b.priority);
    trimmedActions.splice(maxActions); // Re-trim

    return { actions: trimmedActions, estimatedROI };
  }

  // ─── Phase 4: EXECUTE ─────────────────────────────────────────────
  /**
   * Executes planned actions in priority order.
   * After each action, validates that the system is still healthy (canary check).
   *
   * @param {object} plan — From plan()
   * @returns {{ executed: number, skipped: number, results: object[] }}
   */
  async execute(plan) {
    const results = [];
    let executed = 0;
    let skipped = 0;

    for (const action of plan.actions) {
      try {
        const result = await this._executeAction(action);
        results.push({ action: action.title, status: 'done', ...result });
        executed++;

        // Canary check: verify system health after each action
        const healthy = this._canaryCheck();
        if (!healthy) {
          console.warn(`[MAPE:Execute] ⚠️ Canary check failed after "${action.title}" — stopping execution`);
          skipped += plan.actions.length - executed;
          break;
        }
      } catch (err) {
        results.push({ action: action.title, status: 'error', error: err.message });
        // Continue with other actions (fail-open for non-critical)
        if (action.priority === ACTION_PRIORITY.CRITICAL) {
          console.warn(`[MAPE:Execute] ❌ Critical action failed: ${action.title} — stopping`);
          skipped += plan.actions.length - executed - 1;
          break;
        }
      }
    }

    return { executed, skipped, results };
  }

  /**
   * Executes a single action based on its type.
   * All 11 action types have executors (8 original + 3 extensions).
   * @param {object} action
   * @returns {object} Result details
   */
  async _executeAction(action) {
    switch (action.type) {
      case ACTION_TYPE.CONFIG_ADJUSTMENT:
        return this._execConfigAdjustment();
      case ACTION_TYPE.SKILL_REFRESH:
        return this._execSkillRefresh();
      case ACTION_TYPE.ARTICLE_SCOUT:
        return this._execArticleScout();
      case ACTION_TYPE.EXPERIENCE_CLEANUP:
        return this._execExperienceCleanup();
      // P2a: 4 new executors
      case ACTION_TYPE.SKILL_ROLLBACK:
        return this._execSkillRollback();
      case ACTION_TYPE.ARCHITECTURE_FIX:
        return this._execArchitectureFix();
      case ACTION_TYPE.COMPLAINT_RESOLUTION:
        return this._execComplaintResolution();
      case ACTION_TYPE.TARGET_OPTIMIZATION:
        return this._execTargetOptimization(action);
      // P1-ext / P2-ext / P3-ext: 3 new action executors
      case ACTION_TYPE.METRIC_CALIBRATION:
        return this._execMetricCalibration(action);
      case ACTION_TYPE.PROMPT_EVOLUTION:
        return this._execPromptEvolution(action);
      case ACTION_TYPE.EXPERIENCE_DISTILL:
        return this._execExperienceDistill();
      default:
        return { detail: `Action type "${action.type}" not yet implemented — logged for manual review` };
    }
  }

  // --- Executor methods & rollback: mixed in from mape-executors.js ---
  // --- Utility methods (convergence, persistence, canary, hash): mixed in from mape-hypothesis.js ---

  // ─── MAPE Micro-Loop V2 ───────────────────────────────────────────────
  // Replaces the original runMicroLoop with hypothesis-driven iteration,
  // real rollback, convergence detection, history persistence, and failure feedback.

  /**
   * Runs a micro-loop V2: Hypothesize → Execute → Measure → Keep/Rollback.
   *
   * Enhancements over V1:
   *   - P1: HypothesisGenerator filters and ranks actions
   *   - P2b: Real rollback (semantic, per action type)
   *   - P2c: Convergence detection (target-reached / plateau / dead-end)
   *   - P3a: Each iteration persisted to experiment-history.jsonl
   *   - P3b: Rolled-back actions recorded as negative experiences
   *
   * @param {object} [opts]
   * @param {number} [opts.maxIterations=3]
   * @param {number} [opts.degradationThreshold=0.1]
   * @returns {{ iterations: object[], kept: number, rolledBack: number, stopped: boolean, convergence: object|null, excluded: object[] }}
   */
  async runMicroLoop(opts = {}) {
    const {
      maxIterations = this._microLoopMaxIter,
      degradationThreshold = 0.1,
    } = opts;

    let RegressionGuard;
    try {
      ({ RegressionGuard } = require('./regression-guard'));
    } catch (_) {
      return { iterations: [], kept: 0, rolledBack: 0, stopped: true, convergence: null, excluded: [], error: 'RegressionGuard not available' };
    }

    const guard = new RegressionGuard({ outputDir: this._outputDir, verbose: this._verbose });

    // First, run a standard MAPE cycle to get the action plan
    const cycleResult = await this.runCycle({ dryRun: true, maxActions: maxIterations });
    const actions = cycleResult.phases?.plan?.plan?.actions || [];

    if (actions.length === 0) {
      if (this._verbose) console.log('[MAPE:MicroLoop] No actions to execute — system is healthy');
      return { iterations: [], kept: 0, rolledBack: 0, stopped: false, convergence: null, excluded: [] };
    }

    // P1: Generate hypotheses — filter and rank actions
    const hypothesisGen = new HypothesisGenerator({ outputDir: this._outputDir, verbose: this._verbose });
    const currentSnapshot = guard.snapshotMetrics();
    const { hypotheses, excluded } = hypothesisGen.generate({ actions, guard, snapshot: currentSnapshot });

    if (hypotheses.length === 0) {
      if (this._verbose) console.log('[MAPE:MicroLoop] All actions excluded by HypothesisGenerator — nothing to try');
      return { iterations: [], kept: 0, rolledBack: 0, stopped: false, convergence: null, excluded };
    }

    const iterations = [];
    let kept = 0;
    let rolledBack = 0;
    let stopped = false;
    let convergence = null;

    if (this._verbose) {
      console.log(`[MAPE:MicroLoop] Starting V2 micro-loop: ${Math.min(hypotheses.length, maxIterations)} hypothesis(es), ${excluded.length} excluded`);
    }

    for (let i = 0; i < Math.min(hypotheses.length, maxIterations); i++) {
      const action = hypotheses[i];
      const iterStart = Date.now();

      // Step 1: Snapshot BEFORE
      const beforeSnapshot = guard.snapshotMetrics();

      // Step 2: Execute action
      let execResult;
      try {
        execResult = await this._executeAction(action);
      } catch (err) {
        const errIter = {
          iteration: i + 1,
          action: action.title,
          type: action.type,
          status: 'error',
          error: err.message,
          confidence: action.confidence,
          durationMs: Date.now() - iterStart,
        };
        iterations.push(errIter);
        this._persistExperimentHistory(errIter, { confidence: action.confidence }); // P3a
        continue;
      }

      // Step 3: Snapshot AFTER
      const afterSnapshot = guard.snapshotMetrics();

      // Step 4: Evaluate delta
      const delta = guard.evaluateMicroDelta(beforeSnapshot, afterSnapshot, { degradationThreshold });

      let status;
      if (delta.shouldRollback) {
        // P2b: Real rollback
        const rollbackResult = await this._rollbackAction(action, execResult);
        status = 'rolled-back';
        rolledBack++;
        if (this._verbose) {
          console.log(`[MAPE:MicroLoop] ↩️  Iteration ${i + 1}: ROLLBACK — ${delta.reason} (actual: ${rollbackResult.detail})`);
        }
      } else {
        status = 'kept';
        kept++;
        if (this._verbose) {
          const improvedStr = delta.improved.length > 0 ? delta.improved.join(', ') : 'none';
          console.log(`[MAPE:MicroLoop] ✅ Iteration ${i + 1}: KEPT — improved: ${improvedStr}`);
        }
      }

      const iterResult = {
        iteration: i + 1,
        action: action.title,
        type: action.type,
        status,
        delta: {
          improved: delta.improved,
          degraded: delta.degraded,
        },
        confidence: action.confidence,
        hypothesis: action.hypothesis,
        execResult,
        durationMs: Date.now() - iterStart,
      };

      iterations.push(iterResult);

      // P3a: Persist iteration to experiment history
      this._persistExperimentHistory(iterResult, { confidence: action.confidence });

      // P3b: Record failure experience for rolled-back actions
      if (status === 'rolled-back') {
        this._recordFailureExperience(iterResult);
      }

      // Step 5: Canary check
      const healthy = this._canaryCheck();
      if (!healthy) {
        if (this._verbose) console.warn('[MAPE:MicroLoop] ⚠️  Canary failed — stopping micro-loop');
        stopped = true;
        break;
      }

      // P2c: Convergence detection
      convergence = this._checkConvergence({ iterations, guard });
      if (convergence.converged) {
        if (this._verbose) {
          console.log(`[MAPE:MicroLoop] 🎯 Converged: ${convergence.reason}`);
        }
        break;
      }
    }

    if (this._verbose) {
      console.log(`[MAPE:MicroLoop] Complete: ${kept} kept, ${rolledBack} rolled back, stopped=${stopped}, converged=${convergence?.converged || false}`);
    }

    return { iterations, kept, rolledBack, stopped, convergence, excluded };
  }
}


// Mix executor methods into MAPEEngine.prototype
for (const key of Object.keys(executors)) {
  MAPEEngine.prototype[key] = executors[key];
}

// Mix hypothesis utility methods into MAPEEngine.prototype
const { _checkConvergence, _persistExperimentHistory, _recordFailureExperience, _canaryCheck, _quickHash } = hypothesisMod;
Object.assign(MAPEEngine.prototype, { _checkConvergence, _persistExperimentHistory, _recordFailureExperience, _canaryCheck, _quickHash });

module.exports = { MAPEEngine, HypothesisGenerator, MAPE_PHASE, ACTION_PRIORITY, ACTION_TYPE };
