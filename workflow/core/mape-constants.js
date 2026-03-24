/**
 * MAPE Constants — Shared enums for the MAPE Engine subsystem
 *
 * Extracted to avoid circular dependencies between mape-engine.js,
 * mape-executors.js, and mape-hypothesis.js.
 */

'use strict';

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
  TARGET_OPTIMIZATION: 'target-optimization',
  // P1-ext: Auto-calibrate unreachable metric targets
  METRIC_CALIBRATION:  'metric-calibration',
  // P2-ext: MAPE-driven prompt variant exploration
  PROMPT_EVOLUTION:    'prompt-evolution',
  // P3-ext: Trigger experience distillation when store is bloated + low hit-rate
  EXPERIENCE_DISTILL:  'experience-distill',
};

module.exports = { MAPE_PHASE, ACTION_PRIORITY, ACTION_TYPE };
