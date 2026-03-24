/**
 * Sleeptime Maintenance Pipeline
 *
 * Unified orchestration of all "background maintenance" tasks that should
 * run after every workflow session completes. Replaces the previously
 * scattered distill/purge/retire/audit calls with a single sleeptime()
 * entry point, called from _finalizeWorkflow().
 *
 * Pipeline stages (sequential, fail-safe):
 *   1. DISTILL  — Merge similar experiences (ExperienceStore.distill)
 *   2. PURGE    — Remove expired experiences (ExperienceStore.purgeExpired)
 *   3. RETIRE   — Retire underperforming skills (SkillEvolution.retireStaleSkills)
 *   4. AUDIT    — Cross-session health audit (HealthAuditor.audit)
 *
 * Each stage is wrapped in try/catch — a failure in one stage does not
 * block subsequent stages. All results are collected into a summary.
 *
 * Design: zero new LLM calls, zero new external dependencies.
 * Token cost: 0 (all operations are local data manipulation).
 */

'use strict';

/**
 * Runs the full sleeptime maintenance pipeline.
 *
 * @param {object} context
 * @param {object}  context.experienceStore  - ExperienceStore instance
 * @param {object}  context.skillEvolution   - SkillEvolutionEngine instance
 * @param {object}  context.selfReflection   - SelfReflectionEngine instance (has auditHealth)
 * @param {object}  [context.healthAuditor]  - HealthAuditor instance (alternative to selfReflection)
 * @param {boolean} [context.verbose=true]   - Print detailed log output
 * @returns {{ stages: object[], totalDurationMs: number, summary: string }}
 */
function sleeptime(context = {}) {
  const {
    experienceStore,
    skillEvolution,
    selfReflection,
    healthAuditor,
    verbose = true,
  } = context;

  const start = Date.now();
  const stages = [];

  if (verbose) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  🌙 SLEEPTIME MAINTENANCE PIPELINE`);
    console.log(`${'─'.repeat(60)}`);
  }

  // ── Stage 1: DISTILL — merge similar experiences ────────────────────────
  try {
    if (experienceStore && typeof experienceStore.distill === 'function') {
      const stageStart = Date.now();
      const result = experienceStore.distill({ similarityThreshold: 0.65, minClusterSize: 2 });
      const elapsed = Date.now() - stageStart;
      stages.push({
        name: 'DISTILL',
        status: 'ok',
        durationMs: elapsed,
        detail: `${result.merged} cluster(s) merged, ${result.removed} redundant record(s) removed`,
        result,
      });
      if (verbose && (result.merged > 0 || result.removed > 0)) {
        console.log(`  [1/4] 🧪 DISTILL: ${result.merged} cluster(s) merged, ${result.removed} removed (${elapsed}ms)`);
      } else if (verbose) {
        console.log(`  [1/4] 🧪 DISTILL: no consolidation needed (${elapsed}ms)`);
      }
    } else {
      stages.push({ name: 'DISTILL', status: 'skipped', detail: 'ExperienceStore not available' });
      if (verbose) console.log(`  [1/4] 🧪 DISTILL: skipped (no ExperienceStore)`);
    }
  } catch (err) {
    stages.push({ name: 'DISTILL', status: 'error', detail: err.message });
    if (verbose) console.warn(`  [1/4] 🧪 DISTILL: failed — ${err.message}`);
  }

  // ── Stage 2: PURGE — remove expired experiences ─────────────────────────
  try {
    if (experienceStore && typeof experienceStore.purgeExpired === 'function') {
      const stageStart = Date.now();
      const result = experienceStore.purgeExpired();
      const elapsed = Date.now() - stageStart;
      stages.push({
        name: 'PURGE',
        status: 'ok',
        durationMs: elapsed,
        detail: `${result.purged} expired record(s) purged, ${result.remaining} remaining`,
        result,
      });
      if (verbose && result.purged > 0) {
        console.log(`  [2/4] 🗑️  PURGE: ${result.purged} expired record(s) purged (${elapsed}ms)`);
      } else if (verbose) {
        console.log(`  [2/4] 🗑️  PURGE: no expired records (${elapsed}ms)`);
      }
    } else {
      stages.push({ name: 'PURGE', status: 'skipped', detail: 'ExperienceStore not available' });
      if (verbose) console.log(`  [2/4] 🗑️  PURGE: skipped (no ExperienceStore)`);
    }
  } catch (err) {
    stages.push({ name: 'PURGE', status: 'error', detail: err.message });
    if (verbose) console.warn(`  [2/4] 🗑️  PURGE: failed — ${err.message}`);
  }

  // ── Stage 3: RETIRE — retire underperforming skills ─────────────────────
  try {
    if (skillEvolution && typeof skillEvolution.retireStaleSkills === 'function') {
      const stageStart = Date.now();
      // Execute retirement (non-dry-run) for skills that meet all criteria
      const result = skillEvolution.retireStaleSkills({
        minUsage: 10,
        effectivenessThreshold: 0.1,
        staleDays: 30,
        dryRun: false,
      });
      const elapsed = Date.now() - stageStart;
      stages.push({
        name: 'RETIRE',
        status: 'ok',
        durationMs: elapsed,
        detail: `${result.stale.length} stale skill(s) detected, ${result.retired.length} retired`,
        result: { staleCount: result.stale.length, retiredCount: result.retired.length, report: result.report },
      });
      if (verbose && result.retired.length > 0) {
        console.log(`  [3/4] 📦 RETIRE: ${result.retired.length} skill(s) retired (${elapsed}ms)`);
        for (const s of result.retired.slice(0, 3)) {
          const hr = ((s.effectiveCount || 0) / (s.usageCount || 1) * 100).toFixed(0);
          console.log(`         - ${s.name}: ${hr}% effective`);
        }
      } else if (verbose) {
        console.log(`  [3/4] 📦 RETIRE: all skills healthy (${elapsed}ms)`);
      }
    } else {
      stages.push({ name: 'RETIRE', status: 'skipped', detail: 'SkillEvolution not available' });
      if (verbose) console.log(`  [3/4] 📦 RETIRE: skipped (no SkillEvolution)`);
    }
  } catch (err) {
    stages.push({ name: 'RETIRE', status: 'error', detail: err.message });
    if (verbose) console.warn(`  [3/4] 📦 RETIRE: failed — ${err.message}`);
  }

  // ── Stage 4: AUDIT — cross-session health check ────────────────────────
  try {
    const auditor = healthAuditor || (selfReflection && typeof selfReflection.auditHealth === 'function' ? selfReflection : null);
    if (auditor) {
      const stageStart = Date.now();
      const result = typeof auditor.audit === 'function'
        ? auditor.audit()
        : auditor.auditHealth();
      const elapsed = Date.now() - stageStart;
      const findingCount = (result.findings || []).length;
      stages.push({
        name: 'AUDIT',
        status: 'ok',
        durationMs: elapsed,
        detail: findingCount > 0
          ? `${findingCount} finding(s): ${(result.findings || []).slice(0, 3).map(f => f.title || f.description || '').join('; ')}`
          : 'no anomalies detected',
        result: { findingCount, summary: result.summary },
      });
      if (verbose && findingCount > 0) {
        console.log(`  [4/4] 🔍 AUDIT: ${findingCount} finding(s) (${elapsed}ms)`);
      } else if (verbose) {
        console.log(`  [4/4] 🔍 AUDIT: clean (${elapsed}ms)`);
      }
    } else {
      stages.push({ name: 'AUDIT', status: 'skipped', detail: 'No auditor available' });
      if (verbose) console.log(`  [4/4] 🔍 AUDIT: skipped (no auditor)`);
    }
  } catch (err) {
    stages.push({ name: 'AUDIT', status: 'error', detail: err.message });
    if (verbose) console.warn(`  [4/4] 🔍 AUDIT: failed — ${err.message}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const totalDurationMs = Date.now() - start;
  const okCount = stages.filter(s => s.status === 'ok').length;
  const errorCount = stages.filter(s => s.status === 'error').length;
  const skippedCount = stages.filter(s => s.status === 'skipped').length;

  const summary = `Sleeptime complete: ${okCount} ok, ${errorCount} error(s), ${skippedCount} skipped (${totalDurationMs}ms)`;

  if (verbose) {
    console.log(`  ${'─'.repeat(56)}`);
    console.log(`  🌙 ${summary}`);
    console.log(`${'─'.repeat(60)}\n`);
  }

  return { stages, totalDurationMs, summary };
}

module.exports = { sleeptime };
