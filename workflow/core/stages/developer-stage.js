/**
 * DeveloperStage – CODE pipeline stage runner
 *
 * P0 optimisation: Extracted from orchestrator-stages.js (_runDeveloper function).
 * This module owns the CODE stage interface, independently testable.
 *
 * Responsibilities:
 *   - Upstream context injection
 *   - DeveloperAgent execution
 *   - Code review (CodeReviewAgent)
 *   - Quality gate evaluation + rollback coordination
 *   - EvoMap feedback loop (experience hit-rate tracking)
 *   - Early entropy scan (post-CODE)
 *   - Store CODE context for downstream stages
 *   - Bus publish (DEVELOPER → TESTER)
 *
 * Implementation: Delegates to the original _runDeveloper function (orchestrator-stages.js)
 * bound to the Orchestrator instance context.
 */

'use strict';

const { StageRunner } = require('../stage-runner');
const { WorkflowState } = require('../types');

class DeveloperStage extends StageRunner {
  constructor() {
    super(WorkflowState.CODE);
  }

  /**
   * Executes the CODE stage.
   * Delegates to the original _runDeveloper function bound to the orchestrator context.
   *
   * @param {import('../stage-runner').StageContext} ctx
   * @returns {Promise<string|object>} Output artifact path or rollback sentinel
   */
  async execute(ctx) {
    const orch = ctx.orchestrator;
    // P0-2 fix: Import directly from stage-developer.js instead of the orchestrator-stages.js
    // re-export facade to eliminate unnecessary indirection.
    const { _runDeveloper } = require('../stage-developer');
    return _runDeveloper.call(orch);
  }
}

module.exports = { DeveloperStage };
