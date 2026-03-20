/**
 * PlannerStage – PLAN pipeline stage runner
 *
 * Inserted between ARCHITECT and CODE stages.
 * Reads architecture.md and produces execution-plan.md with
 * detailed task breakdown, dependencies, and acceptance criteria.
 *
 * Responsibilities:
 *   - Upstream context injection (ANALYSE + ARCHITECT summaries)
 *   - PlannerAgent execution
 *   - SocraticEngine user approval checkpoint
 *   - Store PLAN context for downstream stages
 *   - Bus publish (PLAN → DEVELOPER)
 */

'use strict';

const { StageRunner } = require('../stage-runner');
const { WorkflowState } = require('../types');

class PlannerStage extends StageRunner {
  constructor() {
    super(WorkflowState.PLAN);
  }

  /**
   * Executes the PLAN stage.
   * Delegates to the _runPlanner function bound to the orchestrator context.
   *
   * @param {import('../stage-runner').StageContext} ctx
   * @returns {Promise<string|object>} Output artifact path
   */
  async execute(ctx) {
    const orch = ctx.orchestrator;
    const { _runPlanner } = require('../stage-planner');
    return _runPlanner.call(orch);
  }
}

module.exports = { PlannerStage };
