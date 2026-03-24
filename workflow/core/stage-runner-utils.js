/**
 * Stage Runner Utilities – Shared micro-operations for orchestrator stages.
 *
 * P1-3 fix: _runArchitect, _runDeveloper, and _runTester all share identical
 * structural patterns (Quality Gate → Rollback → EvoMap → Context Store → Publish).
 * Instead of a heavyweight Template Method base class (which would require
 * over-abstraction given each stage's unique details), we extract the three
 * highest-frequency repeated code blocks as composable helper functions.
 *
 * Each helper is a pure function that receives the Orchestrator instance and
 * stage-specific parameters, keeping orchestrator-stages.js focused on the
 * unique orchestration logic of each stage.
 *
 * Extracted patterns:
 *   1. consumeAndPrepareStage()     – Bus consume + upstream ctx + meta log + exp block + obs record
 *   2. runQualityGateWithRollback() – QualityGate evaluate + experience record + rollback decision
 *   3. runEvoMapFeedback()          – computeMatchedIds + markUsedBatch + recordExpUsage + triggerEvolutions
 */

'use strict';

const { QualityGate } = require('./quality-gate');

// ─── 1. consumeAndPrepareStage ──────────────────────────────────────────────

/**
 * Shared pre-execution sequence for ARCHITECT, DEVELOPER, and TESTER stages.
 *
 * Steps:
 *   1. Consume the bus message for this stage
 *   2. Build upstream cross-stage context
 *   3. Log upstream meta (if previous stage had corrections)
 *   4. Build experience + complaint context block
 *   5. Record injection count to Observability
 *
 * @param {Orchestrator} orch         - Orchestrator instance
 * @param {object}       opts
 * @param {string}       opts.agentRole        - AgentRole enum value for this stage
 * @param {Function}     opts.buildUpstreamCtx - (orch) => string
 * @param {Function}     opts.buildContextBlock - async (orch, upstreamCtx, ...extra) => string
 * @param {Array}        [opts.contextBlockArgs] - Extra args passed to buildContextBlock after upstreamCtx
 * @param {string}       [opts.prevStageName]   - Human-readable name of the previous stage (for logging)
 * @param {string}       [opts.prevMetaField]   - Meta field to check for correction rounds (e.g. 'reviewRounds')
 * @returns {{ inputPath: string, upstreamCtx: string, contextBlock: string }}
 */
async function consumeAndPrepareStage(orch, {
  agentRole,
  buildUpstreamCtx,
  buildContextBlock,
  contextBlockArgs = [],
  prevStageName = null,
  prevMetaField = 'reviewRounds',
}) {
  const inputPath = orch.bus.consume(agentRole);

  // Build upstream cross-stage context
  const upstreamCtx = buildUpstreamCtx(orch);

  // Log upstream meta if previous stage had corrections
  if (prevStageName) {
    const meta = orch.bus.getMeta(agentRole);
    if (meta && meta[prevMetaField] > 0) {
      console.log(
        `[Orchestrator] ℹ️  ${prevStageName} was self-corrected in ${meta[prevMetaField]} round(s)` +
        `${meta.failedItems != null ? ` (${meta.failedItems} issue(s) fixed)` : ''}.`
      );
    }
  }

  // Build experience + complaint context block
  const contextBlock = await buildContextBlock(orch, upstreamCtx, ...contextBlockArgs);

  // Record injection count to Observability for hit-rate tracking
  // A-3 fix: contextBlock may be either { content, injectedExpIds } struct (new)
  // or a legacy String object with ._injectedExpIds expando (old).
  const _expIds = contextBlock.injectedExpIds || contextBlock._injectedExpIds || [];
  orch.obs.recordExpUsage({
    injected: _expIds.length,
  });

  return { inputPath, upstreamCtx, contextBlock };
}

// ─── 2. runQualityGateWithRollback ──────────────────────────────────────────

/**
 * Evaluates the QualityGate for a stage and records the experience outcome.
 *
 * This encapsulates the pattern repeated in ARCHITECT, CODE, and TEST stages:
 *   1. Create QualityGate instance
 *   2. Read rollback counter
 *   3. Evaluate review result
 *   4. Record experience
 *   5. Record Prompt A/B outcome
 *
 * @param {Orchestrator} orch
 * @param {object}       opts
 * @param {object}       opts.reviewResult - Result from ReviewAgent or SelfCorrectionEngine
 * @param {string}       opts.workflowState - WorkflowState enum value (e.g. ARCHITECT, CODE, TEST)
 * @param {string}       opts.agentRoleForAB - Role name for Prompt A/B recording
 * @param {string}       opts.skill        - Skill name for experience recording
 * @param {string}       opts.category     - ExperienceCategory for experience recording
 * @param {number}       [opts.maxRollbacks=1] - Max rollback attempts
 * @param {Function}     opts.recordPromptABOutcome - _recordPromptABOutcome function
 * @returns {{ decision: object, rollbackCount: number }}
 */
function runQualityGateWithRollback(orch, {
  reviewResult,
  workflowState,
  agentRoleForAB,
  skill,
  category,
  maxRollbacks = 1,
  recordPromptABOutcome,
}) {
  const gate = new QualityGate({
    experienceStore: orch.experienceStore,
    maxRollbacks,
  });

  // Read rollback counter from the appropriate source
  // P1-NEW-3 pattern: prefer _rollbackCounters (instance-level Map) over stageCtx.meta
  const rollbackCount = orch._rollbackCounters?.get(workflowState)
    ?? orch.stageCtx?.get(workflowState)?.meta?.[`_${_stateKeyLower(workflowState)}RollbackCount`]
    ?? 0;

  const decision = gate.evaluate(reviewResult, workflowState, rollbackCount);

  gate.recordExperience(decision, workflowState, reviewResult, {
    skill,
    category,
  });

  // Prompt A/B recording
  if (recordPromptABOutcome) {
    recordPromptABOutcome(agentRoleForAB, decision.pass, reviewResult.rounds ?? 0);
  }

  return { decision, rollbackCount };
}

/**
 * Converts a WorkflowState string to the lowercase key fragment used in
 * rollback counter meta fields (e.g. `_archRollbackCount`).
 *
 * P0-3 fix: The original implementation only mapped 3 states (ARCHITECT, CODE,
 * TEST). PLAN and any custom stages registered via StageRegistry would fall
 * through to `workflowState.toLowerCase()`, producing keys like `_planRollbackCount`
 * that are never written — causing QualityGate to silently read 0 and ignore
 * rollback history.
 *
 * Fix: Added PLAN mapping and a defensive log for unknown states so that
 * unmapped custom stages produce a visible warning instead of silent failure.
 *
 * @param {string} workflowState - e.g. 'ARCHITECT', 'CODE', 'TEST', 'PLAN'
 * @returns {string} Lowercase key fragment (e.g. 'arch', 'code', 'test', 'plan')
 */
function _stateKeyLower(workflowState) {
  const map = {
    ARCHITECT: 'arch',
    CODE: 'code',
    TEST: 'test',
    PLAN: 'plan',
    ANALYSE: 'analyse',
  };
  const key = map[workflowState];
  if (!key) {
    console.warn(
      `[stage-runner-utils] ⚠️  _stateKeyLower: no mapping for state "${workflowState}". ` +
      `Using "${workflowState.toLowerCase()}". If this state uses rollback counters, ` +
      `add a mapping to _stateKeyLower().`
    );
    return workflowState.toLowerCase();
  }
  return key;
}

// ─── 3. runEvoMapFeedback ───────────────────────────────────────────────────

/**
 * Executes the EvoMap experience feedback loop after a stage passes QualityGate.
 *
 * This encapsulates the pattern repeated 4+ times across orchestrator-stages.js:
 *   1. computeMatchedIds() – measure which injected experiences actually matched
 *   2. markUsedBatch()     – increment hit counts for matched experiences
 *   3. recordExpUsage()    – report confirmed hits to Observability
 *   4. triggerEvolutions() – trigger skill evolution for high-usage experiences
 *
 * @param {Orchestrator} orch
 * @param {object}       opts
 * @param {string[]}     opts.injectedExpIds - IDs of experiences injected into the agent prompt
 * @param {string}       opts.errorContext   - Error text for matching NEGATIVE experiences
 * @param {string}       opts.stageLabel     - Human-readable stage label for logging
 * @returns {Promise<{ matchedCount: number, evolvedCount: number }>}
 */
async function runEvoMapFeedback(orch, { injectedExpIds, errorContext, stageLabel }) {
  if (!injectedExpIds || injectedExpIds.length === 0) {
    return { matchedCount: 0, evolvedCount: 0 };
  }

  // Defect H fix: use computeMatchedIds() for accurate hit-rate measurement.
  // POSITIVE experiences are always matched. NEGATIVE experiences are only matched
  // when the review's risk notes mention their tags/category.
  const { matchedIds, matchedCount } = orch.experienceStore.computeMatchedIds(
    injectedExpIds,
    errorContext,
  );

  // Only markUsedBatch on matched IDs – unmatched experiences were prompt noise
  const evolutionTriggers = orch.experienceStore.markUsedBatch(matchedIds);

  // Report only confirmed matched hits to Observability
  orch.obs.recordExpUsage({ hits: matchedCount });
  console.log(`[Orchestrator] 🎯 Experience hit-rate (${stageLabel}): ${matchedCount}/${injectedExpIds.length} matched`);

  // Centralized evolution trigger via ExperienceStore.triggerEvolutions()
  // P1 Enhancement: triggerEvolutions now returns { evolved, created } instead of just a number.
  // 'created' tracks newly auto-created skills from orphan experiences.
  const evoResult = await orch.experienceStore.triggerEvolutions(
    evolutionTriggers,
    orch.skillEvolution,
    orch.hooks,
    stageLabel,
  );
  // Backward-compatible: handle both old (number) and new ({ evolved, created }) return format
  const evolvedCount = typeof evoResult === 'number' ? evoResult : (evoResult.evolved || 0);
  const createdCount = typeof evoResult === 'object' ? (evoResult.created || 0) : 0;
  console.log(`[Orchestrator] 📊 Marked ${matchedCount}/${injectedExpIds.length} experience(s) as effective (${stageLabel} passed). Evolution triggers: ${evolvedCount}${createdCount > 0 ? `, new skills: ${createdCount}` : ''}`);

  // Skill Lifecycle: mark all skills that were injected during this stage as effective.
  // This is the key feedback signal: skills injected into prompts for stages that
  // pass QualityGate are confirmed as contributing to successful outcomes.
  // The skill names are aggregated by Observability across all LLM calls this session.
  if (orch.obs._skillInjectedCounts && orch.obs._skillInjectedCounts.size > 0) {
    orch.obs.markSkillEffective([...orch.obs._skillInjectedCounts.keys()]);
  }

  return { matchedCount, evolvedCount, createdCount };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  consumeAndPrepareStage,
  runQualityGateWithRollback,
  runEvoMapFeedback,
};
