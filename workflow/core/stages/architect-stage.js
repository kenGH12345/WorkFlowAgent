/**
 * ArchitectStage – ARCHITECT pipeline stage runner
 *
 * P0 optimisation: Extracted from orchestrator-stages.js (_runArchitect function).
 * This module owns the ARCHITECT stage logic, independently testable.
 *
 * Responsibilities:
 *   - Upstream context injection
 *   - SocraticEngine tech stack preference
 *   - ArchitectAgent execution
 *   - Parallel CoverageChecker + ArchitectureReviewAgent
 *   - Quality gate evaluation + rollback coordination
 *   - EvoMap feedback loop (experience hit-rate tracking)
 *   - Store ARCHITECT context for downstream stages
 *   - Bus publish (ARCHITECT → PLANNER)
 */

'use strict';

const { StageRunner } = require('../stage-runner');
const { WorkflowState } = require('../types');

class ArchitectStage extends StageRunner {
  constructor() {
    super(WorkflowState.ARCHITECT);
  }

  /**
   * Executes the ARCHITECT stage.
   * Delegates to the original _runArchitect function bound to the orchestrator context.
   *
   * @param {import('../stage-runner').StageContext} ctx
   * @returns {Promise<string|object>} Output artifact path or rollback sentinel
   */
  async execute(ctx) {
    const orch = ctx.orchestrator;
    // P0-2 fix: Import directly from stage-architect.js instead of the orchestrator-stages.js
    // re-export facade to eliminate unnecessary indirection.
    const { _runArchitect } = require('../stage-architect');
    return _runArchitect.call(orch);
  }
}

module.exports = { ArchitectStage };
