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
const { ReflectionType, ReflectionSeverity, ReflectionStatus } = require('./self-reflection-types');
const { HealthAuditor } = require('./health-auditor');
const { QualityGate, DEFAULT_QUALITY_GATES } = require('./quality-gate');

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
    this._reflectionPath = path.join(this._outputDir, 'reflections.json');

    /** @type {ReflectionEntry[]} */
    this._reflections = [];

    /** @type {Map<string, number>} Pattern frequency counter for recurring detection */
    this._patternFrequency = new Map();

    // A-1 architecture fix: delegate health audit and quality gating to focused classes.
    // Both receive a bound recordIssue callback so findings flow back into reflections.
    const boundRecordIssue = this.recordIssue.bind(this);
    this._healthAuditor = new HealthAuditor({
      outputDir: this._outputDir,
      recordIssue: boundRecordIssue,
      skillEvolution: options.skillEvolution || null,
    });
    this._qualityGate = new QualityGate({
      qualityGates: options.qualityGates,
      recordIssue: boundRecordIssue,
    });

    this._load();
  }

  /**
   * Injects or updates the SkillEvolutionEngine reference for health auditing.
   * Called after Orchestrator initialisation when the engine becomes available.
   * A-1 fix: avoids Check 8/9 creating orphan SkillEvolutionEngine instances.
   * @param {object} skillEvolution
   */
  setSkillEvolution(skillEvolution) {
    this._healthAuditor.setSkillEvolution(skillEvolution);
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

  // ─── Proactive Audit: Health Check (delegated to HealthAuditor – A-1 fix) ──

  /**
   * Analyses cross-session metrics history to proactively identify anomalies.
   * Delegates to HealthAuditor which encapsulates all 9 health checks.
   *
   * @returns {{ findings: ReflectionEntry[], summary: string }}
   */
  auditHealth() {
    return this._healthAuditor.audit();
  }

  // ─── Automated Gating: Run Validation (delegated to QualityGate – A-1 fix) ──

  /**
   * Validates a completed workflow run against quality gates.
   * Delegates to QualityGate which encapsulates all gate evaluation logic.
   *
   * @param {object} metrics - From Observability.flush()
   * @returns {{ passed: boolean, gates: Array, reflections: ReflectionEntry[] }}
   */
  validateRun(metrics) {
    return this._qualityGate.validate(metrics);
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

        // P1-7 fix: Enforce maximum reflection count to prevent unbounded memory growth.
        // Keep the most recent entries; archive fixed/deferred ones first.
        const MAX_REFLECTIONS = 500;
        if (this._reflections.length > MAX_REFLECTIONS) {
          // Partition: keep all OPEN, trim FIXED/DEFERRED first
          const open = this._reflections.filter(e => e.status === ReflectionStatus.OPEN);
          const closed = this._reflections.filter(e => e.status !== ReflectionStatus.OPEN);
          // Sort closed by date descending, keep only enough to fill quota
          closed.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          const maxClosed = Math.max(0, MAX_REFLECTIONS - open.length);
          this._reflections = [...open, ...closed.slice(0, maxClosed)].slice(0, MAX_REFLECTIONS);
          console.log(`[SelfReflection] Trimmed reflections from ${data.reflections.length} to ${this._reflections.length} (max ${MAX_REFLECTIONS})`);
        }

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
