/**
 * TesterStage – TEST pipeline stage runner
 *
 * P0 optimisation: Extracted from orchestrator-stages.js (_runTester function).
 * This module owns the TEST stage interface, independently testable.
 *
 * Responsibilities:
 *   - Test case generation (TestCaseGenerator)
 *   - Test case execution (TestCaseExecutor)
 *   - TesterAgent execution
 *   - Test report self-correction (SelfCorrectionEngine)
 *   - Quality gate evaluation + rollback coordination
 *   - Real test execution + auto-fix loop
 *   - CI integration
 *   - Entropy GC (post-test)
 *   - EvoMap feedback loop (experience hit-rate tracking)
 *   - Store TEST context for downstream stages
 *
 * Implementation: Delegates to the original _runTester function (orchestrator-stages.js)
 * bound to the Orchestrator instance context.
 */

'use strict';

const { StageRunner } = require('../stage-runner');
const { WorkflowState } = require('../types');

class TesterStage extends StageRunner {
  constructor() {
    super(WorkflowState.TEST);
  }

  /**
   * Executes the TEST stage.
   * Delegates to the original _runTester function bound to the orchestrator context.
   *
   * @param {import('../stage-runner').StageContext} ctx
   * @returns {Promise<string|object>} Output artifact path or sentinel
   */
  async execute(ctx) {
    const orch = ctx.orchestrator;
    // P0-2 fix: Import directly from stage-tester.js instead of the orchestrator-stages.js
    // re-export facade to eliminate unnecessary indirection.
    const { _runTester } = require('../stage-tester');
    return _runTester.call(orch);
  }
}

module.exports = { TesterStage };
