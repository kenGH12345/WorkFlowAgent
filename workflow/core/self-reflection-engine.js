/**
 * Self-Reflection Engine – Automated introspection and experience replay
 *
 * Implements the "Experience Replay" pattern for WorkFlowAgent:
 *   - Every issue encountered during audit or user interaction is recorded
 *   - Periodic reflection analyses patterns, extracts root causes
 *   - Proactive audit scans metrics-history for anomalies
 *   - Automated gating validates each run against quality baselines
 *
 * This is the key module for Level 3 self-optimisation: the system can
 * not only execute self-improvement tasks, but also DISCOVER when
 * improvement is needed and MEASURE whether improvements were effective.
 *
 * Integration points:
 *   - Observability: reads metrics-history.jsonl for quantitative signals
 *   - ExperienceStore: records reflections as NEGATIVE experiences for future retrieval
 *   - ComplaintWall: files complaints for actionable issues
 *   - ObservabilityStrategy: uses deriveStrategy for adaptive parameter feedback
 *
 * Lifecycle:
 *   1. During workflow run: recordIssue() is called when problems are detected
 *   2. At end of run: validateRun() checks quality gates
 *   3. Periodically: auditHealth() scans cross-session trends for anomalies
 *   4. On demand: reflect() generates a structured reflection report
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Reflection Types ───────────────────────────────────────────────────────

const ReflectionType = {
  ISSUE_DETECTED:    'issue_detected',     // Problem found during audit/usage
  PATTERN_RECURRING: 'pattern_recurring',  // Same issue appeared multiple times
  QUALITY_GATE_FAIL: 'quality_gate_fail',  // Run failed a quality threshold
  ANOMALY_DETECTED:  'anomaly_detected',   // Cross-session metric anomaly
  OPTIMISATION_OPP:  'optimisation_opp',   // Identified optimisation opportunity
};

const ReflectionSeverity = {
  CRITICAL: 'critical',  // Blocks correctness, must fix
  HIGH:     'high',      // Significant impact on quality/efficiency
  MEDIUM:   'medium',    // Noticeable but not blocking
  LOW:      'low',       // Minor improvement opportunity
};

const ReflectionStatus = {
  OPEN:     'open',      // Not yet addressed
  ANALYSED: 'analysed',  // Root cause identified, plan generated
  FIXED:    'fixed',     // Fix applied
  DEFERRED: 'deferred',  // Acknowledged, deferred to later
};

// ─── Quality Gate Thresholds ────────────────────────────────────────────────

const DEFAULT_QUALITY_GATES = {
  maxErrorCount:       3,     // Max errors per run before flagging
  maxTokenWasteRatio:  0.35,  // If >35% of tokens are in dropped/truncated blocks → waste
  minTestPassRate:     0.70,  // Minimum test pass rate (passed / (passed + failed))
  maxDurationMs:       600000, // 10 minutes max per run
  maxLlmCalls:         15,    // More than 15 LLM calls suggests retry loops
  maxPluginSkipRatio:  0.80,  // If >80% of plugins are skipped, keywords may be too narrow
  minPluginSkipRatio:  0.10,  // If <10% of plugins are skipped, keywords may be too broad
};

// ─── Self-Reflection Engine ─────────────────────────────────────────────────

class SelfReflectionEngine {
  /**
   * @param {object} options
   * @param {string}   options.outputDir       - Directory for reflection data
   * @param {object}   [options.experienceStore] - ExperienceStore instance
   * @param {object}   [options.complaintWall]   - ComplaintWall instance
   * @param {object}   [options.qualityGates]    - Override default quality gate thresholds
   */
  constructor(options = {}) {
    this._outputDir = options.outputDir || path.join(process.cwd(), 'output');
    this._experienceStore = options.experienceStore || null;
    this._complaintWall = options.complaintWall || null;
    this._qualityGates = { ...DEFAULT_QUALITY_GATES, ...options.qualityGates };
    this._reflectionPath = path.join(this._outputDir, 'reflections.json');

    /** @type {ReflectionEntry[]} */
    this._reflections = [];

    /** @type {Map<string, number>} Pattern frequency counter for recurring detection */
    this._patternFrequency = new Map();

    this._load();
  }

  // ─── Core API: Record Issues ──────────────────────────────────────────────

  /**
   * Records an issue encountered during workflow execution or audit.
   * This is the primary ingestion point — every time a problem is noticed,
   * call this method to create a structured reflection entry.
   *
   * If the same issue pattern has been seen before (by patternKey), the
   * engine automatically escalates it to PATTERN_RECURRING with higher severity.
   *
   * @param {object} options
   * @param {string}   options.type        - ReflectionType value
   * @param {string}   options.severity    - ReflectionSeverity value
   * @param {string}   options.title       - Short description (one line)
   * @param {string}   options.description - Detailed description with context
   * @param {string}   [options.source]    - Where this was detected (e.g. 'audit:R1', 'user:correction')
   * @param {string}   [options.patternKey] - Dedup/pattern key (e.g. 'regex-backtrack', 'token-waste-high')
   * @param {string}   [options.rootCause]  - Root cause analysis
   * @param {string}   [options.suggestedFix] - Proposed fix
   * @param {object}   [options.metrics]    - Quantitative data associated with this reflection
   * @returns {ReflectionEntry}
   */
  recordIssue(options) {
    const {
      type = ReflectionType.ISSUE_DETECTED,
      severity = ReflectionSeverity.MEDIUM,
      title,
      description,
      source = 'unknown',
      patternKey = null,
      rootCause = null,
      suggestedFix = null,
      metrics = null,
    } = options;

    // Pattern recurring detection
    let effectiveType = type;
    let effectiveSeverity = severity;
    if (patternKey) {
      const count = (this._patternFrequency.get(patternKey) || 0) + 1;
      this._patternFrequency.set(patternKey, count);

      if (count >= 3) {
        effectiveType = ReflectionType.PATTERN_RECURRING;
        // Escalate severity for recurring patterns
        if (severity === ReflectionSeverity.LOW) effectiveSeverity = ReflectionSeverity.MEDIUM;
        if (severity === ReflectionSeverity.MEDIUM) effectiveSeverity = ReflectionSeverity.HIGH;
      }
    }

    const entry = {
      id: `REF-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      type: effectiveType,
      severity: effectiveSeverity,
      title,
      description,
      source,
      patternKey,
      rootCause,
      suggestedFix,
      metrics,
      status: ReflectionStatus.OPEN,
      occurrenceCount: patternKey ? (this._patternFrequency.get(patternKey) || 1) : 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._reflections.push(entry);

    // Bridge to ExperienceStore: record as negative experience for future retrieval
    if (this._experienceStore && effectiveSeverity !== ReflectionSeverity.LOW) {
      try {
        this._experienceStore.recordIfAbsent(`Reflection: ${title}`, {
          type: 'negative',
          category: 'pitfall',
          title: `Reflection: ${title}`,
          content: [
            `Source: ${source}`,
            `Severity: ${effectiveSeverity}`,
            `Description: ${description}`,
            rootCause ? `Root Cause: ${rootCause}` : null,
            suggestedFix ? `Suggested Fix: ${suggestedFix}` : null,
            metrics ? `Metrics: ${JSON.stringify(metrics)}` : null,
          ].filter(Boolean).join('\n'),
          tags: ['self-reflection', source, effectiveType, patternKey].filter(Boolean),
        });
      } catch (_) { /* Non-fatal */ }
    }

    // Bridge to ComplaintWall: file complaint for HIGH/CRITICAL issues
    if (this._complaintWall && (effectiveSeverity === ReflectionSeverity.CRITICAL || effectiveSeverity === ReflectionSeverity.HIGH)) {
      try {
        this._complaintWall.file({
          targetType: 'workflow',
          targetId: source,
          severity: effectiveSeverity === ReflectionSeverity.CRITICAL ? 'frustrating' : 'annoying',
          description: `[Self-Reflection] ${title}: ${description}`,
          suggestion: suggestedFix || 'Needs investigation',
          agentId: 'system:self-reflection',
          rootCause: rootCause || null,
        });
      } catch (_) { /* Non-fatal */ }
    }

    console.log(`[SelfReflection] 🔍 ${effectiveType} [${effectiveSeverity}]: ${title}${patternKey ? ` (pattern: ${patternKey}, count: ${this._patternFrequency.get(patternKey)})` : ''}`);

    this._save();
    return entry;
  }

  // ─── Proactive Audit: Health Check ────────────────────────────────────────

  /**
   * Analyses cross-session metrics history to proactively identify anomalies
   * and optimisation opportunities. This is the "self-driving" part —
   * it doesn't wait for someone to say "go audit", it examines the data
   * and surfaces problems automatically.
   *
   * Checks performed:
   *   1. Token consumption trend (increasing = potential prompt bloat)
   *   2. Error rate trend (increasing = quality regression)
   *   3. Duration trend (increasing = performance regression)
   *   4. Experience hit rate (low = experience store noise)
   *   5. Clarification effectiveness (low = clarification wasting rounds)
   *   6. Plugin skip ratio (too high or too low = keyword tuning needed)
   *
   * @returns {{ findings: ReflectionEntry[], summary: string }}
   */
  auditHealth() {
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
      findings.push(this.recordIssue({
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
      findings.push(this.recordIssue({
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
      findings.push(this.recordIssue({
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
        findings.push(this.recordIssue({
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
        findings.push(this.recordIssue({
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
          findings.push(this.recordIssue({
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
      // Count unique skill names that appeared but were never effective
      const allInjectedNames = new Set();
      const allEffectiveNames = new Set();
      for (const session of sessionsWithSkills) {
        for (const name of (session.skillInjectedNames || [])) allInjectedNames.add(name);
        for (const name of (session.skillEffectiveNames || [])) allEffectiveNames.add(name);
      }
      const neverEffective = [...allInjectedNames].filter(n => !allEffectiveNames.has(n));

      if (neverEffective.length > 0) {
        findings.push(this.recordIssue({
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
          findings.push(this.recordIssue({
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

    // Check 8: Skill content staleness detection (Gap 4)
    // Skills that haven't been evolved in a long time may contain outdated advice.
    // Uses SkillEvolutionEngine registry (if available via Orchestrator) to check
    // lastEvolvedAt timestamps against a staleness threshold.
    try {
      const { SkillEvolutionEngine } = require('./skill-evolution');
      const skillEngine = new SkillEvolutionEngine();
      const STALE_DAYS = 90; // Skills not evolved in 90 days are flagged
      const now = Date.now();
      const staleSkills = [];

      for (const meta of skillEngine.registry.values()) {
        if (meta.retiredAt) continue; // Already retired
        const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
        const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
        const latestActivity = Math.max(lastEvolved, created);
        const daysSinceActivity = latestActivity > 0 ? (now - latestActivity) / (24 * 60 * 60 * 1000) : Infinity;

        if (daysSinceActivity > STALE_DAYS && (meta.usageCount || 0) > 0) {
          staleSkills.push({ name: meta.name, daysSinceActivity: Math.round(daysSinceActivity) });
        }
      }

      if (staleSkills.length > 0) {
        findings.push(this.recordIssue({
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
    } catch (_) { /* Non-fatal: SkillEvolutionEngine may not be available */ }

    // Check 9: Skill keyword overlap / conflict detection (Gap 5)
    // Two skills with heavily overlapping keywords may inject conflicting advice.
    // Detects skill pairs where >50% of keywords overlap, which indicates either
    // redundancy (merge candidates) or conflict risk (contradictory advice).
    try {
      const { ContextLoader } = require('./context-loader');
      // Access BUILTIN_SKILL_KEYWORDS via a temporary loader or directly
      const BUILTIN_SKILL_KEYWORDS = require('./context-loader').__test_BUILTIN_SKILL_KEYWORDS || {};

      // If we can't access keywords, try reading from loaded skill files
      const { SkillEvolutionEngine } = require('./skill-evolution');
      const skillEngine = new SkillEvolutionEngine();
      const skillKeywordMap = new Map();

      for (const meta of skillEngine.registry.values()) {
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
        findings.push(this.recordIssue({
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

    const summary = findings.length === 0
      ? '✅ Health audit passed: no anomalies detected across cross-session metrics.'
      : `⚠️ Health audit found ${findings.length} issue(s):\n${findings.map(f => `  - [${f.severity}] ${f.title}`).join('\n')}`;

    console.log(`[SelfReflection] 📊 Health audit complete: ${findings.length} finding(s) from ${history.length} sessions.`);
    return { findings, summary };
  }

  // ─── Automated Gating: Run Validation ─────────────────────────────────────

  /**
   * Validates a completed workflow run against quality gates.
   * Call this after Observability.flush() with the session metrics.
   *
   * Returns a pass/fail verdict with details on which gates were breached.
   * Automatically records reflections for any failures.
   *
   * @param {object} metrics - From Observability.flush()
   * @returns {{ passed: boolean, gates: Array<{ name: string, passed: boolean, actual: any, threshold: any, message: string }>, reflections: ReflectionEntry[] }}
   */
  validateRun(metrics) {
    if (!metrics) return { passed: true, gates: [], reflections: [] };

    const gates = [];
    const reflections = [];
    const g = this._qualityGates;

    // Gate 1: Error count
    const errorCount = metrics.errors?.count || 0;
    const errorGate = {
      name: 'maxErrorCount',
      passed: errorCount <= g.maxErrorCount,
      actual: errorCount,
      threshold: g.maxErrorCount,
      message: errorCount <= g.maxErrorCount
        ? `Errors within limit (${errorCount} ≤ ${g.maxErrorCount})`
        : `Error count exceeded (${errorCount} > ${g.maxErrorCount})`,
    };
    gates.push(errorGate);

    // Gate 2: Test pass rate
    if (metrics.testResult) {
      const { passed: tp = 0, failed: tf = 0 } = metrics.testResult;
      const total = tp + tf;
      const passRate = total > 0 ? tp / total : 1;
      const testGate = {
        name: 'minTestPassRate',
        passed: passRate >= g.minTestPassRate,
        actual: `${(passRate * 100).toFixed(0)}%`,
        threshold: `${(g.minTestPassRate * 100).toFixed(0)}%`,
        message: passRate >= g.minTestPassRate
          ? `Test pass rate OK (${(passRate * 100).toFixed(0)}% ≥ ${(g.minTestPassRate * 100).toFixed(0)}%)`
          : `Test pass rate too low (${(passRate * 100).toFixed(0)}% < ${(g.minTestPassRate * 100).toFixed(0)}%)`,
      };
      gates.push(testGate);
    }

    // Gate 3: Duration
    const duration = metrics.totalDurationMs || 0;
    const durationGate = {
      name: 'maxDurationMs',
      passed: duration <= g.maxDurationMs,
      actual: `${(duration / 1000).toFixed(1)}s`,
      threshold: `${(g.maxDurationMs / 1000).toFixed(1)}s`,
      message: duration <= g.maxDurationMs
        ? `Duration within limit (${(duration / 1000).toFixed(1)}s ≤ ${(g.maxDurationMs / 1000).toFixed(1)}s)`
        : `Duration exceeded (${(duration / 1000).toFixed(1)}s > ${(g.maxDurationMs / 1000).toFixed(1)}s)`,
    };
    gates.push(durationGate);

    // Gate 4: LLM call count (detect retry storms)
    const llmCalls = metrics.llm?.totalCalls || 0;
    const llmGate = {
      name: 'maxLlmCalls',
      passed: llmCalls <= g.maxLlmCalls,
      actual: llmCalls,
      threshold: g.maxLlmCalls,
      message: llmCalls <= g.maxLlmCalls
        ? `LLM calls within limit (${llmCalls} ≤ ${g.maxLlmCalls})`
        : `LLM call count high — possible retry storm (${llmCalls} > ${g.maxLlmCalls})`,
    };
    gates.push(llmGate);

    // Gate 5: Token waste ratio (if blockTelemetry available)
    if (metrics.blockTelemetry?.summary) {
      const { totalInjected = 0, totalDropped = 0 } = metrics.blockTelemetry.summary;
      const wasteRatio = totalInjected > 0 ? totalDropped / totalInjected : 0;
      const wasteGate = {
        name: 'maxTokenWasteRatio',
        passed: wasteRatio <= g.maxTokenWasteRatio,
        actual: `${(wasteRatio * 100).toFixed(0)}%`,
        threshold: `${(g.maxTokenWasteRatio * 100).toFixed(0)}%`,
        message: wasteRatio <= g.maxTokenWasteRatio
          ? `Token waste acceptable (${(wasteRatio * 100).toFixed(0)}% ≤ ${(g.maxTokenWasteRatio * 100).toFixed(0)}%)`
          : `Token waste too high (${(wasteRatio * 100).toFixed(0)}% > ${(g.maxTokenWasteRatio * 100).toFixed(0)}%)`,
      };
      gates.push(wasteGate);
    }

    // Record reflections for failed gates
    const failedGates = gates.filter(g => !g.passed);
    for (const fg of failedGates) {
      reflections.push(this.recordIssue({
        type: ReflectionType.QUALITY_GATE_FAIL,
        severity: fg.name === 'maxErrorCount' || fg.name === 'minTestPassRate'
          ? ReflectionSeverity.HIGH
          : ReflectionSeverity.MEDIUM,
        title: `Quality gate breached: ${fg.name}`,
        description: fg.message,
        source: 'gating:validateRun',
        patternKey: `gate-fail:${fg.name}`,
        metrics: { actual: fg.actual, threshold: fg.threshold },
      }));
    }

    const passed = failedGates.length === 0;
    if (passed) {
      console.log(`[SelfReflection] ✅ All ${gates.length} quality gates passed.`);
    } else {
      console.warn(`[SelfReflection] ❌ ${failedGates.length} of ${gates.length} quality gates failed: [${failedGates.map(g => g.name).join(', ')}]`);
    }

    return { passed, gates, reflections };
  }

  // ─── Reflection Report ────────────────────────────────────────────────────

  /**
   * Generates a structured reflection report from all recorded reflections.
   * Groups by pattern, identifies recurring themes, and suggests priorities.
   *
   * @param {object} [options]
   * @param {number}   [options.limit=20]     - Max entries to include
   * @param {string}   [options.since]        - ISO date string to filter by creation time
   * @param {boolean}  [options.openOnly=false] - Only include open reflections
   * @returns {{ report: string, stats: object, prioritised: ReflectionEntry[] }}
   */
  reflect(options = {}) {
    const { limit = 20, since = null, openOnly = false } = options;

    let entries = [...this._reflections];

    if (since) {
      const sinceTs = new Date(since).getTime();
      entries = entries.filter(e => new Date(e.createdAt).getTime() >= sinceTs);
    }
    if (openOnly) {
      entries = entries.filter(e => e.status === ReflectionStatus.OPEN);
    }

    // Sort by severity (critical first) then by occurrence count (most frequent first)
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    entries.sort((a, b) => {
      const sevDiff = (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
      if (sevDiff !== 0) return sevDiff;
      return (b.occurrenceCount || 1) - (a.occurrenceCount || 1);
    });

    const prioritised = entries.slice(0, limit);

    // Generate stats
    const stats = {
      total: this._reflections.length,
      filtered: entries.length,
      bySeverity: {},
      byType: {},
      bySource: {},
      recurringPatterns: [],
    };

    for (const e of entries) {
      stats.bySeverity[e.severity] = (stats.bySeverity[e.severity] || 0) + 1;
      stats.byType[e.type] = (stats.byType[e.type] || 0) + 1;
      stats.bySource[e.source] = (stats.bySource[e.source] || 0) + 1;
    }

    // Identify recurring patterns (count ≥ 2)
    for (const [key, count] of this._patternFrequency) {
      if (count >= 2) {
        stats.recurringPatterns.push({ pattern: key, count });
      }
    }
    stats.recurringPatterns.sort((a, b) => b.count - a.count);

    // Generate report text
    const lines = [
      `## 🔍 Self-Reflection Report`,
      ``,
      `**Generated**: ${new Date().toISOString()}`,
      `**Total Reflections**: ${stats.total} | **Filtered**: ${stats.filtered}`,
      ``,
      `### Severity Distribution`,
      `- 🔴 Critical: ${stats.bySeverity.critical || 0}`,
      `- 🟠 High: ${stats.bySeverity.high || 0}`,
      `- 🟡 Medium: ${stats.bySeverity.medium || 0}`,
      `- 🟢 Low: ${stats.bySeverity.low || 0}`,
      ``,
    ];

    if (stats.recurringPatterns.length > 0) {
      lines.push(`### ⚠️ Recurring Patterns (Needs Attention)`);
      for (const { pattern, count } of stats.recurringPatterns.slice(0, 5)) {
        lines.push(`- **${pattern}**: appeared ${count} times`);
      }
      lines.push('');
    }

    if (prioritised.length > 0) {
      lines.push(`### Top Issues (Prioritised)`);
      for (let i = 0; i < prioritised.length; i++) {
        const e = prioritised[i];
        const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[e.severity] || '⚪';
        lines.push(`\n${i + 1}. ${icon} **[${e.severity.toUpperCase()}]** ${e.title}`);
        lines.push(`   - Source: ${e.source}`);
        lines.push(`   - Description: ${e.description.length > 200 ? e.description.slice(0, 200) + '...' : e.description}`);
        if (e.rootCause) lines.push(`   - Root Cause: ${e.rootCause}`);
        if (e.suggestedFix) lines.push(`   - Suggested Fix: ${e.suggestedFix}`);
        if (e.occurrenceCount > 1) lines.push(`   - Occurrences: ${e.occurrenceCount}x`);
      }
    } else {
      lines.push(`_No reflections recorded yet._`);
    }

    const report = lines.join('\n');
    return { report, stats, prioritised };
  }

  // ─── Reflection Summary for Context Injection ─────────────────────────────

  /**
   * Returns a compact summary suitable for injection into agent prompts.
   * This gives agents awareness of known issues and recurring patterns,
   * so they can proactively avoid them.
   *
   * @param {number} [maxChars=2000] - Maximum characters for the summary
   * @returns {string}
   */
  getReflectionSummary(maxChars = 2000) {
    const open = this._reflections.filter(e => e.status === ReflectionStatus.OPEN);
    if (open.length === 0) return '';

    // Group by severity
    const critical = open.filter(e => e.severity === ReflectionSeverity.CRITICAL);
    const high = open.filter(e => e.severity === ReflectionSeverity.HIGH);

    if (critical.length === 0 && high.length === 0) return '';

    const lines = ['## ⚠️ Known Issues (Self-Reflection)\n'];

    if (critical.length > 0) {
      lines.push('### 🔴 Critical');
      for (const e of critical.slice(0, 3)) {
        lines.push(`- ${e.title}${e.suggestedFix ? ` → ${e.suggestedFix}` : ''}`);
      }
    }
    if (high.length > 0) {
      lines.push('### 🟠 High Priority');
      for (const e of high.slice(0, 5)) {
        lines.push(`- ${e.title}${e.suggestedFix ? ` → ${e.suggestedFix}` : ''}`);
      }
    }

    const raw = lines.join('\n');
    return raw.length > maxChars ? raw.slice(0, maxChars) + '\n\n_... (truncated)_' : raw;
  }

  // ─── Mark Resolution ──────────────────────────────────────────────────────

  /**
   * Marks a reflection as fixed or deferred.
   *
   * @param {string} reflectionId
   * @param {string} status - 'fixed' or 'deferred'
   * @param {string} [resolution] - What was done to fix it
   */
  resolveReflection(reflectionId, status = ReflectionStatus.FIXED, resolution = '') {
    const entry = this._reflections.find(e => e.id === reflectionId);
    if (!entry) {
      console.warn(`[SelfReflection] Reflection not found: ${reflectionId}`);
      return null;
    }
    entry.status = status;
    entry.resolution = resolution;
    entry.updatedAt = new Date().toISOString();
    this._save();
    console.log(`[SelfReflection] ✅ Reflection ${reflectionId} marked as ${status}.`);
    return entry;
  }

  // ─── Statistics ───────────────────────────────────────────────────────────

  /**
   * Returns aggregate statistics about all reflections.
   * @returns {object}
   */
  getStats() {
    const total = this._reflections.length;
    const open = this._reflections.filter(e => e.status === ReflectionStatus.OPEN).length;
    const fixed = this._reflections.filter(e => e.status === ReflectionStatus.FIXED).length;
    const deferred = this._reflections.filter(e => e.status === ReflectionStatus.DEFERRED).length;

    const bySeverity = {};
    for (const e of this._reflections) {
      bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
    }

    const recurringCount = [...this._patternFrequency.values()].filter(c => c >= 2).length;

    return { total, open, fixed, deferred, bySeverity, recurringPatterns: recurringCount };
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /** Writes reflections to disk. */
  flush() {
    this._save();
  }

  _load() {
    try {
      if (fs.existsSync(this._reflectionPath)) {
        const data = JSON.parse(fs.readFileSync(this._reflectionPath, 'utf-8'));
        this._reflections = data.reflections || [];
        // Rebuild pattern frequency map
        for (const e of this._reflections) {
          if (e.patternKey) {
            this._patternFrequency.set(
              e.patternKey,
              (this._patternFrequency.get(e.patternKey) || 0) + 1
            );
          }
        }
        console.log(`[SelfReflection] Loaded ${this._reflections.length} reflections (${this._patternFrequency.size} patterns tracked).`);
      }
    } catch (err) {
      console.warn(`[SelfReflection] Could not load reflections: ${err.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this._reflectionPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        reflections: this._reflections,
        patternFrequency: Object.fromEntries(this._patternFrequency),
        stats: this.getStats(),
      };

      const tmpPath = this._reflectionPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._reflectionPath);
    } catch (err) {
      console.warn(`[SelfReflection] Could not save reflections: ${err.message}`);
    }
  }
}

module.exports = {
  SelfReflectionEngine,
  ReflectionType,
  ReflectionSeverity,
  ReflectionStatus,
  DEFAULT_QUALITY_GATES,
};
