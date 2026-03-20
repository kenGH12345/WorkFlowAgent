'use strict';

const { ExperienceType, ExperienceCategory } = require('./experience-store');

/**
 * QualityGate – Stage pass/fail decision layer.
 *
 * Problem it solves (P0-A):
 *   Previously, quality gate decisions (should we pass? should we rollback?)
 *   were embedded inside _runArchitect, _runDeveloper, _runTester alongside
 *   Agent calls, file I/O, and state machine transitions. This violated SRP
 *   and made the rollback logic hard to reason about.
 *
 * This class extracts the DECISION logic into a dedicated layer:
 *   - evaluate(reviewResult, stage) → { pass, rollback, needsHumanReview }
 *   - evaluateMultiDimensional(reviewResult, stage, opts) → { ... extended }
 *   - recordExperience(decision, stage, reviewResult) → void
 *
 * P2 Multi-Dimensional QualityGate (Audit Method Borrowing):
 *   Inspired by the white-box audit methodology's four-step verification:
 *   1. Severity Distribution – not just `failed` count, but severity gradient
 *   2. Correction Trend     – is the trend improving? (5→2→1 is encouraging)
 *   3. Category Coverage     – which TYPES of issues were fixed? cherry-picking easy ones?
 *   4. Four-Level Decision   – pass / pass-with-conditions / retry / escalate
 *
 * The Orchestrator's _runXxx functions remain responsible for:
 *   - Calling the Agent (execution layer)
 *   - Injecting context (execution layer)
 *   - Driving the state machine (control layer)
 *
 * see CHANGELOG: P0-A, P2-MultiDim
 */
class QualityGate {
  /**
   * @param {object} opts
   * @param {object} opts.experienceStore - ExperienceStore instance for recording outcomes
   * @param {number} [opts.maxRollbacks=1] - Max rollback attempts per stage before escalating
   */
  constructor({ experienceStore, maxRollbacks = 1 } = {}) {
    this.experienceStore = experienceStore;
    this.maxRollbacks    = maxRollbacks;
  }

  /**
   * Evaluates a review result and returns a gate decision.
   *
   * @param {object} reviewResult - Output from SelfCorrectionEngine or ReviewAgent
   * @param {string} stageName    - e.g. 'ARCHITECT', 'CODE', 'TEST'
   * @param {number} rollbackCount - How many times this stage has already rolled back
   * @returns {{ pass: boolean, rollback: boolean, needsHumanReview: boolean, reason: string }}
   */
  evaluate(reviewResult, stageName, rollbackCount = 0) {
    // Case 1: All issues resolved AND no human-review flag → PASS
    // P1-C fix: must also check needsHumanReview here.
    // SelfCorrectionEngine can return { failed: 0, needsHumanReview: true } when
    // oscillation is detected (signals array is empty because _detectSignals threw,
    // so failed = signals.filter(high).length = 0, but needsHumanReview = true).
    // Without this guard, oscillation is silently treated as a clean PASS.
    if (reviewResult.failed === 0 && !reviewResult.needsHumanReview) {
      return {
        pass:             true,
        rollback:         false,
        needsHumanReview: false,
        reason:           `${stageName} review passed (0 failed items)`,
      };
    }

    // Case 1b: failed === 0 but needsHumanReview === true (oscillation / forced escalation)
    // Fall through to Case 3/4 so the rollback budget is consulted.
    // We treat this as "1 virtual high-severity issue" to trigger the normal rollback path.
    if (reviewResult.failed === 0 && reviewResult.needsHumanReview) {
      // Synthesise a failed count of 1 so Cases 3/4 below fire correctly.
      reviewResult = { ...reviewResult, failed: 1 };
    }

    // Case 2: Issues remain but no high-severity → PASS with warnings
    if (!reviewResult.needsHumanReview) {
      return {
        pass:             true,
        rollback:         false,
        needsHumanReview: false,
        reason:           `${stageName} review passed with ${reviewResult.failed} low/medium issue(s) (no high-severity)`,
      };
    }

    // Case 3: High-severity issues remain, rollback budget available → ROLLBACK
    if (rollbackCount < this.maxRollbacks) {
      return {
        pass:             false,
        rollback:         true,
        needsHumanReview: false,
        reason:           `${stageName} review failed: ${reviewResult.failed} high-severity issue(s) remain (rollback ${rollbackCount + 1}/${this.maxRollbacks})`,
      };
    }

    // Case 4: High-severity issues remain, rollback budget exhausted → ESCALATE
    return {
      pass:             false,
      rollback:         false,
      needsHumanReview: true,
      reason:           `${stageName} review failed after ${rollbackCount} rollback(s): ${reviewResult.failed} high-severity issue(s) remain. Human review required.`,
    };
  }

  /**
   * Multi-dimensional quality evaluation.
   *
   * P2 Enhancement (Audit Method Borrowing):
   * Evaluates across 3 dimensions instead of the single `failed > 0` binary:
   *
   *   1. **Severity Distribution**: Counts critical / high / medium / low separately.
   *      A single critical blocks; multiple highs block; mediums only warn.
   *
   *   2. **Correction Trend**: Analyses the improvement trajectory across rounds.
   *      If failed goes from 5→3→1, the trend is positive even if 1 remains.
   *      A positive trend can soften the decision from rollback → pass-with-conditions.
   *
   *   3. **Category Coverage**: Checks which TYPES of issues were addressed.
   *      If the correction only fixed "style" issues but left "logic" issues,
   *      the coverage is skewed and the decision is harder.
   *
   * Returns a 4-level decision (vs evaluate()'s 3-level):
   *   - pass:                 Clean pass, no issues
   *   - pass-with-conditions: Low/medium issues remain but trend is positive
   *   - retry:                High-severity issues remain, rollback budget available
   *   - escalate:             Rollback budget exhausted or trend is negative
   *
   * @param {object} reviewResult - Output from SelfCorrectionEngine or ReviewAgent
   * @param {string} stageName    - e.g. 'ARCHITECT', 'CODE', 'TEST'
   * @param {object} [opts]
   * @param {number} [opts.rollbackCount=0]  - Previous rollback count
   * @param {number[]} [opts.failedHistory]   - Failed counts from prior rounds [5, 3, 1]
   * @param {object} [opts.severityBreakdown] - { critical:0, high:0, medium:0, low:0 }
   * @returns {{ pass, rollback, needsHumanReview, passWithConditions, reason, dimensions }}
   */
  evaluateMultiDimensional(reviewResult, stageName, opts = {}) {
    const rollbackCount = opts.rollbackCount ?? 0;
    const failedHistory = opts.failedHistory ?? [];
    const severity = opts.severityBreakdown ?? _inferSeverityBreakdown(reviewResult);

    // ── Dimension 1: Severity Distribution ─────────────────────────────────
    const hasCritical = (severity.critical ?? 0) > 0;
    const hasHigh     = (severity.high ?? 0) > 0;
    const hasMedium   = (severity.medium ?? 0) > 0;
    const hasLow      = (severity.low ?? 0) > 0;
    const totalIssues = (severity.critical ?? 0) + (severity.high ?? 0) + (severity.medium ?? 0) + (severity.low ?? 0);

    // Severity score: critical=10, high=5, medium=2, low=1
    const severityScore = (severity.critical ?? 0) * 10
                        + (severity.high ?? 0) * 5
                        + (severity.medium ?? 0) * 2
                        + (severity.low ?? 0) * 1;

    // ── Dimension 2: Correction Trend ──────────────────────────────────────
    // Build full history including current round
    const fullHistory = [...failedHistory, reviewResult.failed ?? 0];
    let trend = 'unknown';
    if (fullHistory.length >= 2) {
      const diffs = [];
      for (let i = 1; i < fullHistory.length; i++) {
        diffs.push(fullHistory[i] - fullHistory[i - 1]);
      }
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      if (avgDiff < -0.5) trend = 'improving';
      else if (avgDiff > 0.5) trend = 'degrading';
      else trend = 'stable';
    }

    // ── Dimension 3: Category Coverage ──────────────────────────────────────
    // Check which categories of issues remain vs. which were fixed
    const fixedIssues = _extractFixedIssues(reviewResult.history);
    const remainingTypes = new Set((reviewResult.riskNotes || []).map(n => {
      if (n.includes('logic') || n.includes('contradiction')) return 'logic';
      if (n.includes('security') || n.includes('vulnerability')) return 'security';
      if (n.includes('performance') || n.includes('perf')) return 'performance';
      if (n.includes('style') || n.includes('format')) return 'style';
      return 'general';
    }));
    const fixedTypes = new Set(fixedIssues.map(f => {
      const d = f.description.toLowerCase();
      if (d.includes('logic') || d.includes('contradiction')) return 'logic';
      if (d.includes('security') || d.includes('vulnerability')) return 'security';
      if (d.includes('performance') || d.includes('perf')) return 'performance';
      if (d.includes('style') || d.includes('format')) return 'style';
      return 'general';
    }));
    // Cherry-pick detection: if only "easy" categories (style, general) were fixed
    // but "hard" categories (logic, security) remain unfixed
    const hardRemaining = [...remainingTypes].filter(t => t === 'logic' || t === 'security');
    const cherryPicked = hardRemaining.length > 0 && fixedTypes.size > 0 && !fixedTypes.has('logic') && !fixedTypes.has('security');

    // ── Build dimensions report ────────────────────────────────────────────
    const dimensions = {
      severity: { ...severity, score: severityScore, total: totalIssues },
      trend: { direction: trend, history: fullHistory },
      coverage: { remainingTypes: [...remainingTypes], fixedTypes: [...fixedTypes], cherryPicked },
    };

    // ── Four-Level Decision Logic ──────────────────────────────────────────

    // Level 1: PASS – zero issues or all remaining are low-severity
    if (totalIssues === 0 || (!hasCritical && !hasHigh && !hasMedium)) {
      return {
        pass: true, rollback: false, needsHumanReview: false, passWithConditions: false,
        reason: `${stageName} multi-dim gate: PASS (${totalIssues === 0 ? '0 issues' : `${totalIssues} low-severity only`})`,
        dimensions,
      };
    }

    // Level 2: PASS-WITH-CONDITIONS – medium issues remain, but:
    //   - No critical/high AND
    //   - Trend is improving (or at least stable) AND
    //   - No cherry-picking detected
    if (!hasCritical && !hasHigh && trend !== 'degrading' && !cherryPicked) {
      return {
        pass: true, rollback: false, needsHumanReview: false, passWithConditions: true,
        reason: `${stageName} multi-dim gate: PASS-WITH-CONDITIONS (${severity.medium ?? 0} medium, trend=${trend}, no critical blockers)`,
        dimensions,
      };
    }

    // Level 2b: PASS-WITH-CONDITIONS – high issues remain BUT trend is strongly improving
    // AND rollback already attempted at least once. The system is converging.
    if (hasHigh && !hasCritical && trend === 'improving' && rollbackCount >= 1 && severityScore <= 10) {
      return {
        pass: true, rollback: false, needsHumanReview: false, passWithConditions: true,
        reason: `${stageName} multi-dim gate: PASS-WITH-CONDITIONS (trend=improving after ${rollbackCount} rollback(s), severityScore=${severityScore} ≤ 10, converging)`,
        dimensions,
      };
    }

    // Level 3: RETRY – critical/high issues, rollback budget available
    if (rollbackCount < this.maxRollbacks) {
      const degradeNote = trend === 'degrading' ? ' [WARNING: trend is degrading]' : '';
      const cherryNote = cherryPicked ? ' [WARNING: cherry-picking detected – hard issues avoided]' : '';
      return {
        pass: false, rollback: true, needsHumanReview: false, passWithConditions: false,
        reason: `${stageName} multi-dim gate: RETRY (severityScore=${severityScore}, trend=${trend}, rollback ${rollbackCount + 1}/${this.maxRollbacks})${degradeNote}${cherryNote}`,
        dimensions,
      };
    }

    // Level 4: ESCALATE – budget exhausted
    return {
      pass: false, rollback: false, needsHumanReview: true, passWithConditions: false,
      reason: `${stageName} multi-dim gate: ESCALATE (severityScore=${severityScore}, trend=${trend}, ${rollbackCount} rollback(s) exhausted)`,
      dimensions,
    };
  }

  /**
   * Records the gate outcome in the experience store.
   *
   * Defect A fix: records DIAGNOSTIC information ("why" and "how"), not just
   * conclusions ("passed/failed"). The previous implementation recorded only
   * "ARCHITECT quality gate passed" which has zero guidance value for the next run.
   *
   * Pass case: records WHAT was checked, HOW MANY correction rounds were needed,
   *   and WHAT specific issues were fixed (extracted from reviewResult.history).
   *   This gives the next ArchitectAgent concrete patterns to follow.
   *
   * Fail case: records WHICH specific issues remained unresolved (riskNotes),
   *   HOW MANY rounds were attempted, and WHY the gate rejected the output.
   *   This gives the next run a concrete list of failure modes to avoid.
   *
   * @param {{ pass, rollback, needsHumanReview, reason }} decision
   * @param {string} stageName
   * @param {object} reviewResult
   * @param {object} [stageConfig] - Stage-specific config (skill name, tags, etc.)
   */
  recordExperience(decision, stageName, reviewResult, stageConfig = {}) {
    if (!this.experienceStore) return;

    const skill    = stageConfig.skill    || stageName.toLowerCase();
    const category = stageConfig.category || ExperienceCategory.STABLE_PATTERN;

    // ── Extract diagnostic details from reviewResult ──────────────────────────
    const rounds    = reviewResult.rounds    ?? 0;
    const total     = reviewResult.total     ?? 0;
    const failed    = reviewResult.failed    ?? 0;
    const riskNotes = Array.isArray(reviewResult.riskNotes) ? reviewResult.riskNotes : [];

    // Extract what was actually fixed from correction history (Defect E data).
    // reviewResult.history shape: [{ round, failures: [{id, finding}], ... }]
    // or SelfCorrectionEngine shape: [{ round, signals: [{label, severity}], ... }]
    const fixedIssues = _extractFixedIssues(reviewResult.history);

    if (decision.pass) {
      // ── Diagnostic PASS experience ──────────────────────────────────────────
      // Title is unique per (stage, rounds, fixed-count) so different pass patterns
      // accumulate as separate experiences rather than collapsing into one entry.
      const roundsLabel = rounds > 0 ? `after ${rounds} correction round(s)` : 'on first attempt';
      const title = `${stageName} passed quality gate ${roundsLabel}`;

      // Build a diagnostic content block that tells the NEXT run:
      //   1. How many items were checked (scope)
      //   2. How many rounds of self-correction were needed (effort signal)
      //   3. What specific issues were fixed in each round (actionable patterns)
      //   4. What risk notes were present (context)
      const contentLines = [
        `${stageName} passed quality gate ${roundsLabel}.`,
        `Scope: ${total} item(s) checked, ${failed} low/medium issue(s) remaining (no high-severity blockers).`,
      ];

      if (fixedIssues.length > 0) {
        contentLines.push(`\nIssues resolved during self-correction (${fixedIssues.length} fix(es)):`);
        fixedIssues.slice(0, 5).forEach(f => contentLines.push(`  - [Round ${f.round}] ${f.description}`));
      } else if (rounds === 0) {
        contentLines.push(`\nNo self-correction needed – output passed review on first attempt.`);
      }

      if (riskNotes.length > 0) {
        contentLines.push(`\nResidual risk notes (low/medium, non-blocking):`);
        riskNotes.slice(0, 3).forEach(n => contentLines.push(`  - ${n}`));
      }

      this.experienceStore.recordIfAbsent(title, {
        type:     ExperienceType.POSITIVE,
        category,
        title,
        content:  contentLines.join('\n'),
        skill,
        tags:     [stageName.toLowerCase(), 'passed', 'quality-gate', `rounds-${rounds}`],
      });

    } else {
      // ── Diagnostic FAIL experience ──────────────────────────────────────────
      // Title is stable (no round count) so repeated failures accumulate context
      // via appendByTitle() rather than creating duplicate entries.
      const title = `${stageName} quality gate: unresolved high-severity issues`;

      // Build a diagnostic content block that tells the NEXT run:
      //   1. What specific issues blocked the gate (actionable avoidance list)
      //   2. How many rounds were attempted (effort context)
      //   3. What was tried but failed (partial fix history)
      const contentLines = [
        `${stageName} failed quality gate after ${rounds} correction round(s).`,
        `${failed} high-severity issue(s) remained unresolved.`,
      ];

      if (riskNotes.length > 0) {
        contentLines.push(`\nUnresolved issues (avoid these patterns in future runs):`);
        riskNotes.slice(0, 5).forEach(n => contentLines.push(`  - ${n}`));
      }

      if (fixedIssues.length > 0) {
        contentLines.push(`\nPartially fixed issues (these were addressed but did not resolve all blockers):`);
        fixedIssues.slice(0, 3).forEach(f => contentLines.push(`  - [Round ${f.round}] ${f.description}`));
      }

      contentLines.push(`\nGate decision: ${decision.reason}`);

      const diagnosticContent = contentLines.join('\n');
      if (!this.experienceStore.appendByTitle(title, diagnosticContent)) {
        this.experienceStore.record({
          type:     ExperienceType.NEGATIVE,
          category: ExperienceCategory.PITFALL,
          title,
          content:  diagnosticContent,
          skill,
          tags:     [stageName.toLowerCase(), 'failed', 'quality-gate', 'pitfall', 'high-severity'],
        });
      }
    }
  }
}

module.exports = { QualityGate };

// ─── Module-private helpers ───────────────────────────────────────────────────

/**
 * Infers a severity breakdown from a reviewResult when one is not explicitly provided.
 * Looks at riskNotes for severity markers like "(high)", "(critical)".
 * Falls back to: all `failed` items counted as high, remainder as medium.
 *
 * @param {object} reviewResult
 * @returns {{ critical: number, high: number, medium: number, low: number }}
 */
function _inferSeverityBreakdown(reviewResult) {
  const breakdown = { critical: 0, high: 0, medium: 0, low: 0 };
  const riskNotes = reviewResult.riskNotes || [];

  if (riskNotes.length > 0) {
    for (const note of riskNotes) {
      const lower = note.toLowerCase();
      if (lower.includes('(critical)') || lower.includes('[critical]')) {
        breakdown.critical++;
      } else if (lower.includes('(high)') || lower.includes('[high]')) {
        breakdown.high++;
      } else if (lower.includes('(medium)') || lower.includes('[medium]')) {
        breakdown.medium++;
      } else if (lower.includes('(low)') || lower.includes('[low]')) {
        breakdown.low++;
      } else {
        // Default: if needsHumanReview flag is set, treat as high; otherwise medium
        if (reviewResult.needsHumanReview) breakdown.high++;
        else breakdown.medium++;
      }
    }
  } else {
    // No riskNotes: use the binary failed count
    const failed = reviewResult.failed ?? 0;
    if (reviewResult.needsHumanReview) {
      breakdown.high = failed;
    } else {
      breakdown.medium = failed;
    }
  }

  return breakdown;
}

/**
 * Defect A fix: Extracts a flat list of fixed issues from a correction history array.
 *
 * Handles two history shapes:
 *   ReviewAgent:          [{ round, failures: [{id, finding}], before, after }]
 *   SelfCorrectionEngine: [{ round, signals: [{label, severity}], before, after, source? }]
 *
 * Returns: [{ round: number, description: string }]
 *   Each entry describes one issue that was fixed in a specific correction round.
 *   `before`/`after` content is intentionally excluded (too large for experience content).
 *
 * @param {object[]} history
 * @returns {{ round: number, description: string }[]}
 */
function _extractFixedIssues(history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const result = [];
  for (const h of history) {
    const round = h.round ?? '?';

    // ReviewAgent history: failures[].finding contains the issue description
    if (Array.isArray(h.failures) && h.failures.length > 0) {
      for (const f of h.failures.slice(0, 3)) {
        const desc = f.finding ? f.finding.slice(0, 150) : (f.id || 'unspecified issue');
        result.push({ round, description: desc });
      }
    }
    // SelfCorrectionEngine history: signals[].label contains the issue description
    else if (Array.isArray(h.signals) && h.signals.length > 0) {
      for (const s of h.signals.slice(0, 3)) {
        const sev = s.severity ? `[${s.severity}] ` : '';
        const desc = s.label ? `${sev}${s.label.slice(0, 130)}` : 'signal resolved';
        result.push({ round, description: desc });
      }
    }
  }
  return result;
}
