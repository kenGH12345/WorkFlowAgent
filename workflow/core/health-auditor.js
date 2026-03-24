/**
 * Health Auditor – Proactive cross-session anomaly detection
 *
 * Extracted from SelfReflectionEngine (A-1 architecture fix: God Object decomposition).
 * Encapsulates all 9 health checks that analyse cross-session metrics history
 * to identify anomalies, regressions, and optimisation opportunities.
 *
 * Integration: receives a `recordIssue(opts)` callback from SelfReflectionEngine
 * so findings are still recorded as reflections without circular dependency.
 */

'use strict';

const { ReflectionType, ReflectionSeverity } = require('./self-reflection-types');

class HealthAuditor {
  /**
   * @param {object} options
   * @param {string}   options.outputDir        - Directory for observability data
   * @param {Function} options.recordIssue       - Callback: (opts) => ReflectionEntry
   * @param {object}   [options.skillEvolution]  - SkillEvolutionEngine instance (injected, not created)
   */
  constructor(options = {}) {
    this._outputDir = options.outputDir;
    this._recordIssue = options.recordIssue;
    this._skillEvolution = options.skillEvolution || null;
  }

  /**
   * Injects or updates the SkillEvolutionEngine reference.
   * Called after Orchestrator initialisation when the engine becomes available.
   * @param {object} skillEvolution
   */
  setSkillEvolution(skillEvolution) {
    this._skillEvolution = skillEvolution;
  }

  /**
   * Analyses cross-session metrics history to proactively identify anomalies
   * and optimisation opportunities.
   *
   * Checks performed:
   *   1. Token consumption trend (increasing = potential prompt bloat)
   *   2. Error rate trend (increasing = quality regression)
   *   3. Duration trend (increasing = performance regression)
   *   4. Experience hit rate (low = experience store noise)
   *   5. Clarification effectiveness (low = clarification wasting rounds)
   *   6. Block telemetry (high drop rate = token budget pressure)
   *   7. Skill effectiveness (skills injected but never effective)
   *   8. Skill content staleness (not evolved in >90 days)
   *   9. Skill keyword overlap / conflict detection
   *
   * @returns {{ findings: object[], summary: string }}
   */
  audit() {
    const ObsStrategy = require('./observability-strategy');
    const history = ObsStrategy.loadHistory(this._outputDir);

    if (history.length < 3) {
      return { findings: [], summary: 'Insufficient history data (need ≥3 sessions) for health audit.' };
    }

    const trends = ObsStrategy.computeTrends(history);
    const recent = history.slice(0, Math.min(5, history.length));
    const findings = [];

    // Check 1: Token consumption trend
    if (trends.tokenTrend === 'increasing') {
      const avgTokens = trends.avgTokensEst;
      findings.push(this._recordIssue({
        type: ReflectionType.ANOMALY_DETECTED,
        severity: avgTokens > 50000 ? ReflectionSeverity.HIGH : ReflectionSeverity.MEDIUM,
        title: 'Token consumption trending upward',
        description: `Average token usage is ~${avgTokens.toLocaleString()} and increasing across recent sessions. This may indicate prompt bloat, insufficient context pruning, or adapter results growing without bounds.`,
        source: 'audit:health',
        patternKey: 'token-trend-increasing',
        rootCause: 'Possible causes: adapter results growing, insufficient ToolResultFilter thresholds, or prompt template expansion.',
        suggestedFix: 'Review _applyTokenBudget stats, check ToolResultFilter effectiveness, audit adapter block sizes.',
        metrics: { avgTokensEst: avgTokens, trend: 'increasing' },
      }));
    }

    // Check 2: Error rate trend
    if (trends.errorTrend === 'increasing') {
      findings.push(this._recordIssue({
        type: ReflectionType.ANOMALY_DETECTED,
        severity: ReflectionSeverity.HIGH,
        title: 'Error rate trending upward',
        description: `Average error count is ${trends.avgErrorCount} and increasing. This suggests a quality regression that needs attention.`,
        source: 'audit:health',
        patternKey: 'error-trend-increasing',
        rootCause: 'Possible causes: new code introducing bugs, external service degradation, or insufficient test coverage.',
        suggestedFix: 'Review recent error details in run-metrics.json, check if specific stages are failing more often.',
        metrics: { avgErrorCount: trends.avgErrorCount, trend: 'increasing' },
      }));
    }

    // Check 3: Duration trend
    if (trends.durationTrend === 'increasing' && trends.avgDurationMs > 120000) {
      findings.push(this._recordIssue({
        type: ReflectionType.ANOMALY_DETECTED,
        severity: trends.avgDurationMs > 300000 ? ReflectionSeverity.HIGH : ReflectionSeverity.MEDIUM,
        title: 'Workflow duration trending upward',
        description: `Average duration is ${(trends.avgDurationMs / 1000).toFixed(1)}s and increasing. Runs exceeding 2 minutes may indicate unnecessary retry loops or slow adapters.`,
        source: 'audit:health',
        patternKey: 'duration-trend-increasing',
        suggestedFix: 'Profile per-stage timing in run-metrics.json, check for retry loops, review adapter timeouts.',
        metrics: { avgDurationMs: trends.avgDurationMs, trend: 'increasing' },
      }));
    }

    // Check 4: Experience hit rate
    const sessionsWithExp = recent.filter(h => h.expInjectedCount > 0);
    if (sessionsWithExp.length >= 3) {
      const totalInjected = sessionsWithExp.reduce((s, h) => s + h.expInjectedCount, 0);
      const totalHits = sessionsWithExp.reduce((s, h) => s + (h.expHitCount || 0), 0);
      const hitRate = totalHits / totalInjected;

      if (hitRate < 0.15) {
        findings.push(this._recordIssue({
          type: ReflectionType.OPTIMISATION_OPP,
          severity: ReflectionSeverity.MEDIUM,
          title: 'Experience hit rate critically low',
          description: `Only ${(hitRate * 100).toFixed(0)}% of injected experiences are confirmed effective. The experience store may contain too much noise, or keyword matching is too loose.`,
          source: 'audit:health',
          patternKey: 'exp-hit-rate-low',
          rootCause: 'Experience store may have accumulated stale/irrelevant entries, or LLM query expansion is generating too many false positives.',
          suggestedFix: 'Run ExperienceStore.purgeExpired(), review zombie experiences (high retrievalCount, zero hitCount), tighten keyword extraction.',
          metrics: { hitRate: Math.round(hitRate * 100) + '%', totalInjected, totalHits },
        }));
      }
    }

    // Check 5: Clarification effectiveness
    const sessionsWithClar = recent.filter(h => h.clarificationEffectiveness != null && h.clarificationRounds > 0);
    if (sessionsWithClar.length >= 2) {
      const avgEff = sessionsWithClar.reduce((s, h) => s + h.clarificationEffectiveness, 0) / sessionsWithClar.length;
      if (avgEff < 30) {
        findings.push(this._recordIssue({
          type: ReflectionType.OPTIMISATION_OPP,
          severity: ReflectionSeverity.MEDIUM,
          title: 'Clarification rounds have low effectiveness',
          description: `Average clarification effectiveness is ${avgEff.toFixed(0)}%, which means clarification is consuming LLM calls without meaningfully improving requirement quality.`,
          source: 'audit:health',
          patternKey: 'clarification-low-eff',
          suggestedFix: 'Consider reducing maxClarificationRounds or improving the clarification prompt to ask more targeted questions.',
          metrics: { avgEffectiveness: avgEff.toFixed(0) + '%' },
        }));
      }
    }

    // Check 6: Block telemetry — check for consistently dropped blocks
    const sessionsWithTelemetry = recent.filter(h => h.blockTelemetrySummary);
    if (sessionsWithTelemetry.length >= 2) {
      for (const session of sessionsWithTelemetry.slice(0, 1)) {
        const summary = session.blockTelemetrySummary;
        if (summary && summary.totalDropped > summary.totalInjected * 0.4) {
          findings.push(this._recordIssue({
            type: ReflectionType.OPTIMISATION_OPP,
            severity: ReflectionSeverity.MEDIUM,
            title: 'High block drop rate indicates token budget pressure',
            description: `${summary.totalDropped} of ${summary.totalInjected} blocks were dropped due to token budget. This means significant context is being lost.`,
            source: 'audit:health',
            patternKey: 'high-block-drop-rate',
            suggestedFix: 'Review BLOCK_PRIORITY assignments, increase STAGE_TOKEN_BUDGET_CHARS, or improve ToolResultFilter compression.',
            metrics: { totalInjected: summary.totalInjected, totalDropped: summary.totalDropped },
          }));
        }
      }
    }

    // Check 7: Skill effectiveness — detect skills injected but rarely effective
    const sessionsWithSkills = recent.filter(h => h.skillInjectedTotal > 0);
    if (sessionsWithSkills.length >= 3) {
      const totalInjected = sessionsWithSkills.reduce((s, h) => s + (h.skillInjectedTotal || 0), 0);
      const totalEffective = sessionsWithSkills.reduce((s, h) => s + (h.skillEffectiveCount || 0), 0);
      const allInjectedNames = new Set();
      const allEffectiveNames = new Set();
      for (const session of sessionsWithSkills) {
        for (const name of (session.skillInjectedNames || [])) allInjectedNames.add(name);
        for (const name of (session.skillEffectiveNames || [])) allEffectiveNames.add(name);
      }
      const neverEffective = [...allInjectedNames].filter(n => !allEffectiveNames.has(n));

      if (neverEffective.length > 0) {
        findings.push(this._recordIssue({
          type: ReflectionType.OPTIMISATION_OPP,
          severity: neverEffective.length >= 3 ? ReflectionSeverity.HIGH : ReflectionSeverity.MEDIUM,
          title: `${neverEffective.length} skill(s) injected but never effective`,
          description: `Skills [${neverEffective.join(', ')}] were injected across ${sessionsWithSkills.length} sessions but never contributed to a successful stage. Consider retiring or improving these skills.`,
          source: 'audit:health',
          patternKey: 'skill-never-effective',
          suggestedFix: 'Review skill content quality, check if keywords are too broad (triggering on irrelevant tasks), or run retireStaleSkills() to clean up.',
          metrics: { neverEffective, totalInjected, totalEffective },
        }));
      }

      // Overall skill effectiveness check
      if (totalInjected > 5) {
        const skillHitRate = totalEffective / allInjectedNames.size;
        if (skillHitRate < 0.2) {
          findings.push(this._recordIssue({
            type: ReflectionType.OPTIMISATION_OPP,
            severity: ReflectionSeverity.MEDIUM,
            title: 'Overall skill effectiveness is critically low',
            description: `Only ${(skillHitRate * 100).toFixed(0)}% of unique skills injected are confirmed effective. The skill library may contain too many irrelevant or outdated skills.`,
            source: 'audit:health',
            patternKey: 'skill-effectiveness-low',
            suggestedFix: 'Run SkillEvolutionEngine.retireStaleSkills() to identify and retire underperforming skills.',
            metrics: { skillHitRate: Math.round(skillHitRate * 100) + '%', uniqueInjected: allInjectedNames.size, uniqueEffective: allEffectiveNames.size },
          }));
        }
      }
    }

    // Check 8: Skill content staleness detection
    // A-1 fix: uses injected _skillEvolution instance instead of creating a new one
    this._auditSkillStaleness(findings);

    // Check 9: Skill keyword overlap / conflict detection
    // A-1 fix: uses injected _skillEvolution instance instead of creating a new one
    this._auditSkillKeywordOverlap(findings);

    const summary = findings.length === 0
      ? '✅ Health audit passed: no anomalies detected across cross-session metrics.'
      : `⚠️ Health audit found ${findings.length} issue(s):\n${findings.map(f => `  - [${f.severity}] ${f.title}`).join('\n')}`;

    console.log(`[HealthAuditor] 📊 Health audit complete: ${findings.length} finding(s) from ${history.length} sessions.`);
    return { findings, summary };
  }

  // ─── Private: Skill Staleness (Check 8) ─────────────────────────────────

  _auditSkillStaleness(findings) {
    if (!this._skillEvolution) return;
    try {
      const STALE_DAYS = 90;
      const now = Date.now();
      const staleSkills = [];

      for (const meta of this._skillEvolution.registry.values()) {
        if (meta.retiredAt) continue;
        const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
        const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
        const latestActivity = Math.max(lastEvolved, created);
        const daysSinceActivity = latestActivity > 0 ? (now - latestActivity) / (24 * 60 * 60 * 1000) : Infinity;

        if (daysSinceActivity > STALE_DAYS && (meta.usageCount || 0) > 0) {
          staleSkills.push({ name: meta.name, daysSinceActivity: Math.round(daysSinceActivity) });
        }
      }

      if (staleSkills.length > 0) {
        findings.push(this._recordIssue({
          type: ReflectionType.OPTIMISATION_OPP,
          severity: staleSkills.length >= 5 ? ReflectionSeverity.HIGH : ReflectionSeverity.MEDIUM,
          title: `${staleSkills.length} skill(s) have stale content (not updated in >${STALE_DAYS} days)`,
          description: `Skills [${staleSkills.slice(0, 5).map(s => `${s.name} (${s.daysSinceActivity}d)`).join(', ')}] haven't been evolved recently. Their content may be outdated as the project evolves.`,
          source: 'audit:health',
          patternKey: 'skill-content-stale',
          suggestedFix: 'Review stale skill content against current project conventions. Re-evolve with fresh experiences or manually update.',
          metrics: { staleSkills: staleSkills.map(s => s.name), count: staleSkills.length },
        }));
      }
    } catch (_) { /* Non-fatal: SkillEvolutionEngine may not be fully initialised */ }
  }

  // ─── Private: Skill Keyword Overlap (Check 9) ───────────────────────────

  _auditSkillKeywordOverlap(findings) {
    if (!this._skillEvolution) return;
    try {
      const skillKeywordMap = new Map();

      for (const meta of this._skillEvolution.registry.values()) {
        if (meta.retiredAt) continue;
        const keywords = (meta.triggers && meta.triggers.keywords) || [];
        if (keywords.length >= 2) {
          skillKeywordMap.set(meta.name, new Set(keywords.map(k => k.toLowerCase())));
        }
      }

      const overlappingPairs = [];
      const skillNames = [...skillKeywordMap.keys()];
      for (let i = 0; i < skillNames.length; i++) {
        for (let j = i + 1; j < skillNames.length; j++) {
          const setA = skillKeywordMap.get(skillNames[i]);
          const setB = skillKeywordMap.get(skillNames[j]);
          let intersection = 0;
          for (const kw of setA) {
            if (setB.has(kw)) intersection++;
          }
          const smaller = Math.min(setA.size, setB.size);
          const overlapRatio = smaller > 0 ? intersection / smaller : 0;
          if (overlapRatio > 0.5 && intersection >= 2) {
            overlappingPairs.push({
              skillA: skillNames[i],
              skillB: skillNames[j],
              overlapRatio: +(overlapRatio * 100).toFixed(0),
              sharedKeywords: [...setA].filter(k => setB.has(k)),
            });
          }
        }
      }

      if (overlappingPairs.length > 0) {
        findings.push(this._recordIssue({
          type: ReflectionType.OPTIMISATION_OPP,
          severity: overlappingPairs.length >= 3 ? ReflectionSeverity.HIGH : ReflectionSeverity.MEDIUM,
          title: `${overlappingPairs.length} skill pair(s) have conflicting keyword overlap`,
          description: `Skill pairs with >50% keyword overlap may inject contradictory advice: ${overlappingPairs.slice(0, 3).map(p => `${p.skillA}↔${p.skillB} (${p.overlapRatio}%, shared: [${p.sharedKeywords.join(',')}])`).join('; ')}`,
          source: 'audit:health',
          patternKey: 'skill-keyword-conflict',
          suggestedFix: 'Review overlapping skills for content conflicts. Consider merging redundant skills or differentiating their keywords.',
          metrics: { pairs: overlappingPairs.slice(0, 5), count: overlappingPairs.length },
        }));
      }
    } catch (_) { /* Non-fatal: keyword analysis is optional */ }
  }
}

module.exports = { HealthAuditor };
