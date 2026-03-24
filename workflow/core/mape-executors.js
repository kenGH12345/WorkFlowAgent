/**
 * MAPE Executors — Action execution and rollback handlers (extracted from mape-engine.js)
 *
 * Contains all 11 action executors (8 original + 3 extensions) and the
 * semantic rollback handler. Mixed into MAPEEngine.prototype by mape-engine.js.
 *
 * Design: Each executor is a standalone method that receives `this` from MAPEEngine.
 * All methods follow the same contract: returns { detail: string, ...extras }.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Import ACTION_TYPE from the constants barrel (avoid circular dep)
const { ACTION_TYPE } = require('./mape-constants');

// ─── Original Executors ───────────────────────────────────────────────────

async function _execConfigAdjustment() {
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

async function _execSkillRefresh() {
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

async function _execArticleScout() {
  try {
    const { ArticleScout } = require('./article-scout');
    const scout = new ArticleScout({ orchestrator: this._orch, verbose: this._verbose });
    const results = await scout.run();
    return { detail: `Scouted ${results.evaluated} article(s), ${results.injected} injected` };
  } catch (_) {
    return { detail: 'ArticleScout not available' };
  }
}

function _execExperienceCleanup() {
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

// ─── P2a: New Action Executors ──────────────────────────────────────────

/**
 * P2a: Rolls back a skill to its previous version using backup files.
 * @returns {object}
 */
async function _execSkillRollback() {
  if (!this._orch?.skillEvolution) return { detail: 'SkillEvolution not available', rolledBack: false };

  let rolledBack = 0;
  const skillsDir = path.join(this._outputDir, '..', 'skills');
  if (!fs.existsSync(skillsDir)) return { detail: 'No skills directory found', rolledBack: 0 };

  // Find skills with .bak files (created by atomic writes)
  try {
    const files = fs.readdirSync(skillsDir);
    const backups = files.filter(f => f.endsWith('.md.tmp'));
    // Also check regression guard baseline for changed skills
    const baselinePath = path.join(this._outputDir, 'evolve-baseline.json');
    if (fs.existsSync(baselinePath)) {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
      for (const [skillName, info] of Object.entries(baseline.skillVersions || {})) {
        const skillPath = path.join(skillsDir, `${skillName}.md`);
        if (!fs.existsSync(skillPath)) continue;
        const content = fs.readFileSync(skillPath, 'utf-8');
        const currentHash = this._quickHash(content);
        if (currentHash !== info.hash && rolledBack < 3) {
          // Skill changed since baseline — check for backup
          const backupPath = skillPath + '.bak';
          if (fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, skillPath);
            rolledBack++;
            if (this._verbose) console.log(`[MAPE:SkillRollback] ↩️  Rolled back: ${skillName}`);
          }
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  return { detail: `Rolled back ${rolledBack} skill(s) to baseline`, rolledBack };
}

/**
 * P2a: Addresses architecture issues by delegating to RED tier PR generation.
 * @returns {object}
 */
async function _execArchitectureFix() {
  if (!this._orch?.autoDeployer) return { detail: 'AutoDeployer not available' };

  // Check for architecture violations from entropy report
  try {
    const entropyPath = path.join(this._outputDir, 'entropy-report.json');
    if (!fs.existsSync(entropyPath)) return { detail: 'No entropy report found' };

    const entropy = JSON.parse(fs.readFileSync(entropyPath, 'utf-8'));
    const violations = (entropy.violations || []).filter(v => v.severity === 'high' || v.severity === 'critical');

    if (violations.length === 0) return { detail: 'No critical architecture violations found' };

    // Generate RED tier PR
    const prResult = this._orch.autoDeployer.generateRedPR({
      title: `Architecture Fix: ${violations.length} violation(s)`,
      description: violations.map(v => `- [${v.severity}] ${v.message || v.rule}`).join('\n'),
      files: violations.map(v => v.file).filter(Boolean).slice(0, 10),
      rationale: 'MAPE Engine detected systematic architecture degradation',
      diff: '(requires manual implementation)',
    });

    return { detail: `Generated architecture fix PR: ${violations.length} violation(s)`, prFile: prResult.prFile };
  } catch (err) {
    return { detail: `Architecture fix failed: ${err.message}` };
  }
}

/**
 * P2a: Auto-resolves low-severity complaints with known patterns.
 * @returns {object}
 */
async function _execComplaintResolution() {
  if (!this._orch?.complaintWall) return { detail: 'ComplaintWall not available' };

  let resolved = 0;
  try {
    const open = this._orch.complaintWall.getOpenComplaints();
    // Auto-resolve minor complaints that have suggestions
    for (const c of open.filter(c => c.severity === 'minor' && c.suggestion)) {
      if (resolved >= 3) break;
      try {
        this._orch.complaintWall.resolve(c.id, `Auto-resolved by MAPE Engine: ${c.suggestion}`);
        resolved++;
      } catch (_) { /* non-fatal */ }
    }
  } catch (_) { /* non-fatal */ }

  return { detail: `Auto-resolved ${resolved} minor complaint(s)`, resolved };
}

/**
 * P2a: Optimizes a specific target metric by choosing the best sub-action.
 * @param {object} action — Must have action.targetMetric
 * @returns {object}
 */
async function _execTargetOptimization(action) {
  const metric = action.targetMetric;
  if (!metric) return { detail: 'No target metric specified' };

  // Map target metrics to concrete sub-actions
  const METRIC_TO_SUB_ACTION = {
    tokenUsage:         () => this._execConfigAdjustment(),
    errorRate:          () => this._execArchitectureFix(),
    expHitRate:         () => this._execExperienceCleanup(),
    skillEffectiveRate: () => this._execSkillRefresh(),
    testPassRate:       () => this._execArchitectureFix(),
    gatePassRate:       () => this._execConfigAdjustment(),
    durationMs:         () => this._execConfigAdjustment(),
  };

  const subAction = METRIC_TO_SUB_ACTION[metric];
  if (!subAction) return { detail: `No optimization strategy for metric "${metric}"` };

  const result = await subAction();
  return { detail: `Target optimization for ${metric}: ${result.detail}`, subResult: result };
}

// ─── P1-ext: Metric Calibration Executor ────────────────────────────────

/**
 * P1-ext: Auto-calibrates unreachable metric targets.
 * When the micro-loop hits a "dead-end" convergence (consecutive rollbacks),
 * this action relaxes the target for the worst-performing metric by 20%,
 * allowing the system to escape the dead-end and focus on achievable goals.
 *
 * Signal: convergence.reason === 'dead-end' OR a metric has 5+ consecutive
 * iterations with 0 improvement.
 *
 * Design: Modifies RegressionGuard._targets at runtime + persists overrides
 * to calibrated-targets.json. Zero LLM calls.
 *
 * @param {object} action — Must have action.targetMetric (or auto-detect worst gap)
 * @returns {object}
 */
function _execMetricCalibration(action) {
  try {
    const { RegressionGuard, METRIC_DIRECTION } = require('./regression-guard');
    const guard = new RegressionGuard({ outputDir: this._outputDir });
    const snapshot = guard.snapshotMetrics();
    const gaps = guard._computeTargetGaps(snapshot.metrics);

    if (gaps.length === 0) return { detail: 'All metrics already at target — no calibration needed', calibrated: 0 };

    // Pick the metric to calibrate: explicit targetMetric, or worst gap
    const targetMetric = action.targetMetric || gaps[0].metric;
    const gap = gaps.find(g => g.metric === targetMetric);
    if (!gap) return { detail: `Metric "${targetMetric}" is already at target`, calibrated: 0 };

    // Relax target by 20% toward current value
    const direction = METRIC_DIRECTION[targetMetric] || 'maximize';
    const isMinimize = direction === 'minimize';
    const oldTarget = gap.target;
    let newTarget;

    if (isMinimize) {
      newTarget = +(oldTarget + (gap.current - oldTarget) * 0.2).toFixed(3);
    } else {
      newTarget = +(oldTarget - (oldTarget - gap.current) * 0.2).toFixed(3);
    }

    // Persist the calibration override
    const calibPath = path.join(this._outputDir, 'calibrated-targets.json');
    let calibrated = {};
    try {
      if (fs.existsSync(calibPath)) {
        calibrated = JSON.parse(fs.readFileSync(calibPath, 'utf-8'));
      }
    } catch (_) { /* start fresh */ }

    calibrated[targetMetric] = {
      originalTarget: calibrated[targetMetric]?.originalTarget ?? oldTarget,
      calibratedTarget: newTarget,
      currentValue: gap.current,
      calibratedAt: new Date().toISOString(),
      reason: `Gap ${gap.gapPct}% unreachable after consecutive failures`,
    };

    try {
      const tmpPath = calibPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(calibrated, null, 2), 'utf-8');
      fs.renameSync(tmpPath, calibPath);
    } catch (_) { /* non-fatal */ }

    if (this._verbose) {
      console.log(`[MAPE:MetricCalibration] 🎯 Calibrated "${targetMetric}": ${oldTarget} → ${newTarget} (current: ${gap.current}, gap was ${gap.gapPct}%)`);
    }

    return {
      detail: `Calibrated "${targetMetric}": target ${oldTarget} → ${newTarget} (current: ${gap.current})`,
      calibrated: 1,
      metric: targetMetric,
      oldTarget,
      newTarget,
      currentValue: gap.current,
    };
  } catch (err) {
    return { detail: `Metric calibration failed: ${err.message}`, calibrated: 0 };
  }
}

// ─── P2-ext: Prompt Evolution Executor ──────────────────────────────────

/**
 * P2-ext: Forces prompt variant exploration via PromptSlotManager.
 *
 * @param {object} action — Optional action.targetRole for specific role
 * @returns {object}
 */
function _execPromptEvolution(action) {
  if (!this._orch?.promptSlotManager) return { detail: 'PromptSlotManager not available', evolved: 0 };

  try {
    const psm = this._orch.promptSlotManager;
    const stats = psm.getStats();
    const slotsToBoost = [];

    // Identify underperforming prompt slots
    for (const [slotKey, slotInfo] of Object.entries(stats)) {
      if (action.targetRole && !slotKey.startsWith(action.targetRole + ':')) continue;

      const activeVariant = slotInfo.variants[slotInfo.activeVariant];
      if (!activeVariant) continue;

      const passRate = parseFloat(activeVariant.gatePassRate);
      if (isNaN(passRate) || activeVariant.totalTrials < 3) continue;

      if (passRate < 0.7) {
        slotsToBoost.push({
          slotKey,
          currentPassRate: passRate,
          trials: activeVariant.totalTrials,
        });
      }
    }

    if (slotsToBoost.length === 0) {
      return { detail: 'No underperforming prompt slots detected — no evolution needed', evolved: 0 };
    }

    // Boost exploration rate for underperforming slots
    let boosted = 0;
    for (const { slotKey, currentPassRate } of slotsToBoost) {
      const slot = psm._data.slots[slotKey];
      if (!slot) continue;

      const oldRate = slot.explorationRate || 0.2;
      slot.explorationRate = Math.min(0.5, oldRate + 0.2);
      boosted++;

      if (this._verbose) {
        console.log(`[MAPE:PromptEvolution] 🔬 Boosted exploration for "${slotKey}": ${oldRate} → ${slot.explorationRate} (passRate: ${currentPassRate})`);
      }
    }

    if (boosted > 0) {
      psm._save();
    }

    return {
      detail: `Boosted prompt exploration for ${boosted} slot(s): ${slotsToBoost.map(s => s.slotKey).join(', ')}`,
      evolved: boosted,
      slots: slotsToBoost,
    };
  } catch (err) {
    return { detail: `Prompt evolution failed: ${err.message}`, evolved: 0 };
  }
}

// ─── P3-ext: Experience Distillation Executor ──────────────────────────

/**
 * P3-ext: Triggers experience distillation when the store is bloated and hit-rate is low.
 *
 * @returns {object}
 */
function _execExperienceDistill() {
  if (!this._orch?.experienceStore) return { detail: 'ExperienceStore not available', distilled: false };

  try {
    const store = this._orch.experienceStore;
    const count = store.experiences.length;

    if (count < 10) {
      return { detail: `Only ${count} experience(s) — too few to distill`, distilled: false };
    }

    const result = store.distill({
      similarityThreshold: 0.65,
      minClusterSize: 2,
      dryRun: false,
    });

    if (this._verbose) {
      console.log(`[MAPE:ExperienceDistill] 🧪 Distilled: ${result.merged} cluster(s), ${result.removed} removed, ${result.conflicts?.length || 0} conflict(s)`);
    }

    return {
      detail: `Distilled ${result.merged} cluster(s), removed ${result.removed} redundant experience(s)`,
      distilled: result.merged > 0,
      merged: result.merged,
      removed: result.removed,
      conflicts: result.conflicts?.length || 0,
    };
  } catch (err) {
    return { detail: `Experience distillation failed: ${err.message}`, distilled: false };
  }
}

// ─── P2b: Real Rollback ─────────────────────────────────────────────────

/**
 * P2b: Semantically rolls back an action based on its type.
 *
 * @param {object} action — The action to roll back
 * @param {object} execResult — The result from executing the action
 * @returns {{ rolledBack: boolean, detail: string }}
 */
async function _rollbackAction(action, execResult) {
  try {
    switch (action.type) {
      case ACTION_TYPE.CONFIG_ADJUSTMENT: {
        if (this._orch?.autoDeployer) {
          const configPath = this._orch.autoDeployer._findConfigPath();
          if (configPath) {
            const dir = path.dirname(configPath);
            const baseName = path.basename(configPath);
            const backups = fs.readdirSync(dir)
              .filter(f => f.startsWith(baseName + '.bak.'))
              .sort()
              .reverse();
            if (backups.length > 0) {
              fs.copyFileSync(path.join(dir, backups[0]), configPath);
              try { delete require.cache[require.resolve(configPath)]; } catch (_) {}
              return { rolledBack: true, detail: `Config restored from backup: ${backups[0]}` };
            }
          }
        }
        return { rolledBack: false, detail: 'No config backup found for rollback' };
      }

      case ACTION_TYPE.SKILL_REFRESH:
      case ACTION_TYPE.SKILL_ROLLBACK: {
        return this._execSkillRollback()
          .then(r => ({ rolledBack: r.rolledBack > 0, detail: r.detail }))
          .catch(() => ({ rolledBack: false, detail: 'Skill rollback failed' }));
      }

      case ACTION_TYPE.EXPERIENCE_CLEANUP: {
        return { rolledBack: false, detail: 'Experience cleanup is non-destructive — no rollback needed' };
      }

      case ACTION_TYPE.ARTICLE_SCOUT: {
        return { rolledBack: false, detail: 'Article scout injections are idempotent — no rollback needed' };
      }

      case ACTION_TYPE.COMPLAINT_RESOLUTION: {
        return { rolledBack: false, detail: 'Complaint resolution does not require rollback' };
      }

      case ACTION_TYPE.ARCHITECTURE_FIX: {
        return { rolledBack: false, detail: 'Architecture fix is RED tier (PR only) — no rollback needed' };
      }

      case ACTION_TYPE.TARGET_OPTIMIZATION: {
        return { rolledBack: false, detail: 'Target optimization rollback depends on sub-action' };
      }

      case ACTION_TYPE.METRIC_CALIBRATION: {
        try {
          const calibPath = path.join(this._outputDir, 'calibrated-targets.json');
          if (fs.existsSync(calibPath)) {
            const calibrated = JSON.parse(fs.readFileSync(calibPath, 'utf-8'));
            const metric = execResult?.metric;
            if (metric && calibrated[metric]) {
              calibrated[metric].calibratedTarget = calibrated[metric].originalTarget;
              calibrated[metric].rolledBackAt = new Date().toISOString();
              const tmpPath = calibPath + '.tmp';
              fs.writeFileSync(tmpPath, JSON.stringify(calibrated, null, 2), 'utf-8');
              fs.renameSync(tmpPath, calibPath);
              return { rolledBack: true, detail: `Restored "${metric}" target to ${calibrated[metric].originalTarget}` };
            }
          }
        } catch (_) { /* non-fatal */ }
        return { rolledBack: false, detail: 'No calibration to rollback' };
      }

      case ACTION_TYPE.PROMPT_EVOLUTION: {
        if (this._orch?.promptSlotManager && execResult?.slots) {
          try {
            const psm = this._orch.promptSlotManager;
            for (const { slotKey } of execResult.slots) {
              const slot = psm._data.slots[slotKey];
              if (slot) {
                slot.explorationRate = 0.2;
              }
            }
            psm._save();
            return { rolledBack: true, detail: `Restored exploration rate to 0.2 for ${execResult.slots.length} slot(s)` };
          } catch (_) { /* non-fatal */ }
        }
        return { rolledBack: false, detail: 'Prompt evolution rollback: no slots to restore' };
      }

      case ACTION_TYPE.EXPERIENCE_DISTILL: {
        return { rolledBack: false, detail: 'Experience distillation is consolidative — no rollback needed' };
      }

      default:
        return { rolledBack: false, detail: `No rollback handler for action type: ${action.type}` };
    }
  } catch (err) {
    return { rolledBack: false, detail: `Rollback failed: ${err.message}` };
  }
}

// ─── Export all executor methods as a mixin ──────────────────────────────

module.exports = {
  _execConfigAdjustment,
  _execSkillRefresh,
  _execArticleScout,
  _execExperienceCleanup,
  _execSkillRollback,
  _execArchitectureFix,
  _execComplaintResolution,
  _execTargetOptimization,
  _execMetricCalibration,
  _execPromptEvolution,
  _execExperienceDistill,
  _rollbackAction,
};
