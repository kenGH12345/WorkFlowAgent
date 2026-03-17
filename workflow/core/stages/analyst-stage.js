/**
 * AnalystStage – ANALYSE pipeline stage runner
 *
 * P0 optimisation: Extracted from orchestrator-stages.js (_runAnalyst function).
 * This module owns the ANALYSE stage interface, independently testable.
 *
 * Responsibilities:
 *   - Requirement clarification (RequirementClarifier)
 *   - Scope decision (SocraticEngine)
 *   - AnalystAgent execution
 *   - Store ANALYSE context for downstream stages
 *   - Task complexity estimation (Defect J)
 *   - Adaptive strategy re-derivation after complexity is known
 *   - Bus publish (ANALYST → ARCHITECT)
 *   - Chinese companion file generation
 *
 * Implementation: Delegates to the original _runAnalyst function (orchestrator-stages.js)
 * bound to the Orchestrator instance context. The original function accesses orchestrator
 * properties via `this` (stateMachine, bus, agents, stageCtx, etc.).
 */

'use strict';

const { StageRunner } = require('../stage-runner');
const { WorkflowState } = require('../types');

class AnalystStage extends StageRunner {
  constructor() {
    super(WorkflowState.ANALYSE);
  }

  /**
   * Executes the ANALYSE stage.
   * Delegates to the original _runAnalyst function bound to the orchestrator context.
   *
   * @param {import('../stage-runner').StageContext} ctx
   * @returns {Promise<string>} Output artifact path (requirements.md)
   */
  async execute(ctx) {
    const orch = ctx.orchestrator;
    const rawRequirement = ctx.rawRequirement;
    // Delegate to the original _runAnalyst function (preserved in orchestrator-stages.js)
    // The function uses `this` to access orchestrator properties, so we bind it.
    const { _runAnalyst } = require('../orchestrator-stages');
    return _runAnalyst.call(orch, rawRequirement);
  }
}

module.exports = { AnalystStage };
