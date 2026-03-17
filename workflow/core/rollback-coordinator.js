'use strict';

const { AgentRole, WorkflowState } = require('./types');

/**
 * RollbackCoordinator – Unified rollback cleanup for all stages.
 *
 * Problem it solves (P0-A / P0-B):
 *   Previously, rollback cleanup was scattered across three separate try-blocks
 *   in orchestrator-stages.js (lines ~250, ~450, ~755). Each block independently
 *   called bus.clearDownstream(), stageCtx.delete(), and cache invalidation.
 *   This made it easy to miss a cleanup step and caused the "fake rollback" bug
 *   where the state machine rolled back but Bus messages and StageContext entries
 *   remained stale.
 *
 * This class centralises ALL rollback side-effects into a single place:
 *   1. stateMachine.rollback()  – update manifest.json
 *   2. bus.clearDownstream()    – invalidate stale Bus queue entries
 *   3. stageCtx.delete()        – invalidate stale cross-stage context
 *   4. cache invalidation       – clear investigation source cache
 *
 * Usage:
 *   const coordinator = new RollbackCoordinator(this);
 *   await coordinator.rollback('ARCHITECT', reason);
 *
 * see CHANGELOG: P0-A, P0-B/stageCtx
 */
class RollbackCoordinator {
  /**
   * @param {object} orchestrator - The Orchestrator instance (provides stateMachine, bus, stageCtx, etc.)
   */
  constructor(orchestrator) {
    this._orch = orchestrator;
    // Defect C fix: subtask result cache for fine-grained rollback.
    // When a stage has multiple subtasks (e.g. ARCHITECT = CoverageCheck + ArchReview),
    // a failure in one subtask shouldn't invalidate the other's cached result.
    // This map stores: stageKey → Map<subtaskName, { result, timestamp }>
    if (!orchestrator._subtaskCache) {
      orchestrator._subtaskCache = new Map();
    }
  }

  /**
   * Performs a full coordinated rollback for the given stage.
   *
   * Cleans up in this order:
   *   1. stateMachine.rollback(reason)
   *   2. bus.clearDownstream(senderRole)  – the role whose output is now stale
   *   3. stageCtx.delete(staleStage)      – the stage whose context is now stale
   *   4. cache.delete(keys)               – investigation source cache entries
   *
   * @param {string}   fromStage  - The stage that failed and is rolling back (e.g. 'ARCHITECT')
   * @param {string}   reason     - Human-readable rollback reason (stored in manifest)
   * @returns {Promise<void>}
   */
  async rollback(fromStage, reason) {
    const orch = this._orch;

    // 1. State machine rollback (updates manifest.json)
    await orch.stateMachine.rollback(reason);

    // 2. Bus cleanup: clear messages published by the stage UPSTREAM of fromStage,
    //    because those messages are now stale (the upstream stage will re-run).
    const busSenderRole = ROLLBACK_BUS_SENDER[fromStage];
    if (busSenderRole && orch.bus) {
      const cleared = orch.bus.clearDownstream(busSenderRole);
      if (cleared > 0) {
        console.log(`[RollbackCoordinator] 🧹 Cleared ${cleared} stale Bus message(s) from ${busSenderRole} (${fromStage} rollback)`);
      }
    }

    // 3. StageContext cleanup: delete the stale context entry for fromStage.
    //    The re-run will deposit a fresh entry after it completes.
    if (orch.stageCtx) {
      const deleted = orch.stageCtx.delete(fromStage);
      if (deleted) {
        console.log(`[RollbackCoordinator] 🧹 Deleted stale StageContext entry: ${fromStage}`);
      }
    }

    // 4. Investigation source cache cleanup
    const cacheKeys = ROLLBACK_CACHE_KEYS[fromStage] || [];
    if (orch._investigationSourceCacheMap && cacheKeys.length > 0) {
      for (const key of cacheKeys) {
        orch._investigationSourceCacheMap.delete(key);
      }
      console.log(`[RollbackCoordinator] 🧹 Cleared ${cacheKeys.length} cache key(s) for ${fromStage} rollback`);
    }

    console.log(`[RollbackCoordinator] ⏪ Rollback complete: ${fromStage} → ${ROLLBACK_TARGET[fromStage] || 'previous stage'}`);
  }

  // ── Defect C fix: Fine-grained subtask-level rollback ───────────────────────

  /**
   * Analyses the failure context and determines if a full-stage rollback is
   * necessary or if only specific subtasks need re-running.
   *
   * The key insight: most stage failures originate from a SINGLE subtask
   * (e.g. ArchReview fails but CoverageCheck succeeded). Re-running the
   * entire upstream stage wastes the successful subtask's LLM call.
   *
   * This method returns a RollbackStrategy that the caller can use to:
   *   - Skip subtasks whose cached results are still valid
   *   - Only re-run the failed subtask(s)
   *   - Fall back to full-stage rollback if the failure is systemic
   *
   * Strategy decision logic:
   *   1. If failedSubtask is specified AND a valid cached result exists for
   *      the OTHER subtasks → SUBTASK_RETRY (only re-run the failed one)
   *   2. If the failure reason contains systemic indicators (timeout, OOM,
   *      "all items failed") → FULL_STAGE_ROLLBACK
   *   3. Default → FULL_STAGE_ROLLBACK (safe fallback)
   *
   * @param {string}   fromStage      - The stage that failed (e.g. 'ARCHITECT')
   * @param {string}   reason         - Human-readable failure reason
   * @param {string}   [failedSubtask]- The specific subtask that failed (e.g. 'ArchReview')
   * @returns {RollbackStrategy}
   */
  analyseRollbackStrategy(fromStage, reason, failedSubtask = null) {
    const orch = this._orch;
    const stageSubtasks = STAGE_SUBTASKS[fromStage];

    // If the stage has no registered subtasks, full rollback is the only option
    if (!stageSubtasks || stageSubtasks.length === 0) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: 'Stage has no subtask decomposition.' };
    }

    // Check for systemic failure indicators that invalidate ALL subtask results
    const SYSTEMIC_PATTERNS = /timeout|ETIMEDOUT|ECONNRESET|OOM|out of memory|all items? failed|rate.?limit|quota/i;
    if (SYSTEMIC_PATTERNS.test(reason)) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: `Systemic failure detected: ${reason.slice(0, 100)}` };
    }

    // If no specific failed subtask is identified, full rollback
    if (!failedSubtask) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: 'No specific failed subtask identified.' };
    }

    // Check if we have cached results for the non-failed subtasks
    const stageCache = orch._subtaskCache.get(fromStage);
    if (!stageCache) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: 'No subtask cache available for this stage.' };
    }

    // Validate that cached results are not stale (max 10 minutes)
    const MAX_CACHE_AGE_MS = 10 * 60 * 1000;
    const now = Date.now();
    const validCached = new Map();
    for (const [name, entry] of stageCache) {
      if (name !== failedSubtask && (now - entry.timestamp) < MAX_CACHE_AGE_MS) {
        validCached.set(name, entry.result);
      }
    }

    // We need at least one valid cached subtask result for partial retry to be useful
    if (validCached.size === 0) {
      return { type: 'FULL_STAGE_ROLLBACK', reason: 'No valid cached subtask results available.' };
    }

    const subtasksToRerun = stageSubtasks.filter(s => s !== failedSubtask || !validCached.has(s));
    console.log(
      `[RollbackCoordinator] 🎯 Subtask analysis for ${fromStage}: ` +
      `rerun=[${subtasksToRerun.join(', ')}], cached=[${[...validCached.keys()].join(', ')}]`
    );

    return {
      type: 'SUBTASK_RETRY',
      failedSubtask,
      subtasksToRerun: subtasksToRerun.filter(s => !validCached.has(s)),
      cachedResults: validCached,
      reason: `Only ${failedSubtask} failed; ${validCached.size} subtask(s) have valid cached results.`,
    };
  }

  /**
   * Caches the result of a successful subtask execution.
   * Called by orchestrator-stages.js after each subtask completes successfully.
   *
   * @param {string} stageName   - e.g. 'ARCHITECT'
   * @param {string} subtaskName - e.g. 'CoverageCheck', 'ArchReview'
   * @param {*}      result      - The subtask's return value
   */
  cacheSubtaskResult(stageName, subtaskName, result) {
    const orch = this._orch;
    if (!orch._subtaskCache.has(stageName)) {
      orch._subtaskCache.set(stageName, new Map());
    }
    orch._subtaskCache.get(stageName).set(subtaskName, {
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Invalidates all cached subtask results for a stage.
   * Called during full-stage rollback to prevent stale cache usage.
   *
   * @param {string} stageName
   */
  invalidateSubtaskCache(stageName) {
    const orch = this._orch;
    if (orch._subtaskCache.has(stageName)) {
      orch._subtaskCache.delete(stageName);
      console.log(`[RollbackCoordinator] 🧹 Invalidated subtask cache for ${stageName}`);
    }
  }
}

// ── Configuration tables ──────────────────────────────────────────────────────

/**
 * @typedef {object} RollbackStrategy
 * @property {'FULL_STAGE_ROLLBACK'|'SUBTASK_RETRY'} type - Rollback granularity
 * @property {string}   reason          - Human-readable explanation of the strategy choice
 * @property {string}   [failedSubtask] - Which subtask failed (SUBTASK_RETRY only)
 * @property {string[]} [subtasksToRerun]- Subtasks that need re-running (SUBTASK_RETRY only)
 * @property {Map<string, *>} [cachedResults] - Valid cached results for reuse (SUBTASK_RETRY only)
 */

/**
 * Defect C fix: Maps each stage to its decomposed subtask names.
 * When a stage has multiple independent subtasks, only the failed subtask needs
 * re-running (if a cached result exists for the others).
 *
 * ARCHITECT: CoverageCheck + ArchReview (already run in parallel via runParallel)
 * CODE:      CodeGeneration + CodeReview
 * TEST:      TestCaseGen + TestExecution + TestReportReview
 *
 * ANALYSE is not included because it's a single-subtask stage (RequirementClarifier
 * + AnalystAgent are sequential and tightly coupled – no meaningful partial retry).
 */
const STAGE_SUBTASKS = {
  [WorkflowState.ARCHITECT]: ['CoverageCheck', 'ArchReview'],
  [WorkflowState.CODE]:      ['CodeGeneration', 'CodeReview'],
  [WorkflowState.TEST]:      ['TestCaseGen', 'TestExecution', 'TestReportReview'],
};

/**
 * Maps the failing stage to the Bus sender role whose messages are now stale.
 * When ARCHITECT fails, ANALYST's output is stale (ARCHITECT will re-consume it).
 * When CODE fails, ARCHITECT's output is stale (DEVELOPER will re-consume it).
 * When TEST fails, DEVELOPER's output is stale (TESTER will re-consume it).
 */
const ROLLBACK_BUS_SENDER = {
  [WorkflowState.ARCHITECT]: AgentRole.ANALYST,
  [WorkflowState.CODE]:      AgentRole.ARCHITECT,
  [WorkflowState.TEST]:      AgentRole.DEVELOPER,
};

/**
 * Maps the failing stage to the human-readable rollback target (for logging).
 */
const ROLLBACK_TARGET = {
  [WorkflowState.ARCHITECT]: WorkflowState.ANALYSE,
  [WorkflowState.CODE]:      WorkflowState.ARCHITECT,
  [WorkflowState.TEST]:      WorkflowState.CODE,
};

/**
 * Maps the failing stage to the investigation source cache keys to invalidate.
 */
const ROLLBACK_CACHE_KEYS = {
  [WorkflowState.ARCHITECT]: ['Architecture', WorkflowState.ARCHITECT],
  [WorkflowState.CODE]:      ['Architecture', 'Code', WorkflowState.ARCHITECT, WorkflowState.CODE],
  [WorkflowState.TEST]:      ['Code', WorkflowState.CODE, 'TestReport'],
};

module.exports = { RollbackCoordinator, STAGE_SUBTASKS };
