/**
 * MAPE Engine — Monitor-Analyze-Plan-Execute Closed-Loop (ADR-35, P2a)
 *
 * Replaces the linear evolve pipeline with a unified feedback loop:
 *
 *   ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
 *   │ MONITOR  │ ──▶ │ ANALYZE  │ ──▶ │  PLAN    │ ──▶ │ EXECUTE  │
 *   │ Collect  │     │ Correlate│     │ Prioritise│     │ + Canary │
 *   └──────────┘     └──────────┘     └──────────┘     └──────────┘
 *        ▲                                                   │
 *        └───────────── feedback ────────────────────────────┘
 *
 * Monitor:  Collects anomaly signals from metrics-history, self-reflection,
 *           quality gates, and entropy scans
 * Analyze:  Cross-correlates findings from multiple sources, identifies root causes
 * Plan:     Generates a prioritised action plan with estimated ROI
 * Execute:  Runs actions in priority order with canary validation between steps
 *
 * Design: Stateless per-invocation. All state comes from disk (metrics-history,
 * reflections, audit reports). Reuses existing module APIs without modification.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── MAPE Phase Constants ───────────────────────────────────────────────────

const MAPE_PHASE = {
  MONITOR:  'monitor',
  ANALYZE:  'analyze',
  PLAN:     'plan',
  EXECUTE:  'execute',
};

// ─── Action Priority Levels ─────────────────────────────────────────────────

const ACTION_PRIORITY = {
  CRITICAL: 0,  // Must fix now (quality gates failing, regressions detected)
  HIGH:     1,  // Should fix soon (stale skills, recurring patterns)
  MEDIUM:   2,  // Nice to fix (hollow skills, enrichment opportunities)
  LOW:      3,  // Optional (cleanup, optimisation)
};

// ─── Action Types ───────────────────────────────────────────────────────────

const ACTION_TYPE = {
  SKILL_REFRESH:       'skill-refresh',
  SKILL_ROLLBACK:      'skill-rollback',
  CONFIG_ADJUSTMENT:   'config-adjustment',
  ARTICLE_SCOUT:       'article-scout',
  COMPLAINT_RESOLUTION:'complaint-resolution',
  ARCHITECTURE_FIX:    'architecture-fix',
  EXPERIENCE_CLEANUP:  'experience-cleanup',
};

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

    return {
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

    return { actions: trimmedActions, estimatedROI };
  }

  // ─── Phase 4: EXECUTE ─────────────────────────────────────────────────

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
      default:
        return { detail: `Action type "${action.type}" not yet implemented — logged for manual review` };
    }
  }

  async _execConfigAdjustment() {
    if (!this._orch?.autoDeployer) return { detail: 'AutoDeployer not available' };
    const Obs = require('./observability');
    const cfg = this._orch._config?.autoFixLoop || {};
    const strategy = Obs.deriveStrategy(this._outputDir, {
      maxFixRounds:    cfg.maxFixRounds    ?? 2,
      maxReviewRounds: cfg.maxReviewRounds ?? 2,
      maxExpInjected:  cfg.maxExpInjected  ?? 5,
      projectId:       this._orch.projectId,
    });
    const result = this._orch.autoDeployer.applyYellow(strategy);
    return { detail: `YELLOW auto-deploy: ${result.changes.length} change(s)`, applied: result.applied };
  }

  async _execSkillRefresh() {
    if (!this._orch?.skillEvolution) return { detail: 'SkillEvolution not available' };
    // Refresh top-3 stale skills
    let refreshed = 0;
    for (const meta of this._orch.skillEvolution.registry.values()) {
      if (refreshed >= 3) break;
      const daysSince = (Date.now() - new Date(meta.lastUpdated || meta.createdAt).getTime()) / 86400000;
      if (daysSince > 90) {
        try {
          await this._orch.skillEvolution.enrichSkillFromExternalKnowledge(meta.name);
          refreshed++;
        } catch (_) { /* non-fatal */ }
      }
    }
    return { detail: `Refreshed ${refreshed} stale skill(s)` };
  }

  async _execArticleScout() {
    try {
      const { ArticleScout } = require('./article-scout');
      const scout = new ArticleScout({ orchestrator: this._orch, verbose: this._verbose });
      const results = await scout.run();
      return { detail: `Scouted ${results.evaluated} article(s), ${results.injected} injected` };
    } catch (_) {
      return { detail: 'ArticleScout not available' };
    }
  }

  _execExperienceCleanup() {
    if (!this._orch?.experienceStore) return { detail: 'ExperienceStore not available' };
    // Remove expired experiences
    const before = this._orch.experienceStore.experiences.length;
    this._orch.experienceStore.experiences = this._orch.experienceStore.experiences.filter(e => {
      if (e.expiresAt && new Date(e.expiresAt).getTime() < Date.now()) return false;
      return true;
    });
    const removed = before - this._orch.experienceStore.experiences.length;
    if (removed > 0) this._orch.experienceStore._save();
    return { detail: `Cleaned up ${removed} expired experience(s)` };
  }

  /**
   * Canary health check: verifies the system is still operational.
   * @returns {boolean}
   */
  _canaryCheck() {
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
}

module.exports = { MAPEEngine, MAPE_PHASE, ACTION_PRIORITY, ACTION_TYPE };
