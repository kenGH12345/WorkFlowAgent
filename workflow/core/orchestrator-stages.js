/**
 * Stage Runner Methods – Re-export Facade
 *
 * ADR-33 (P0 decomposition): This file was previously a 1976-line monolith.
 * It is now a backward-compatible re-export facade that delegates to:
 *   - stage-analyst.js    (~250 lines)  →  _runAnalyst
 *   - stage-architect.js  (~400 lines)  →  _runArchitect
 *   - stage-developer.js  (~320 lines)  →  _runDeveloper
 *   - stage-tester.js     (~900 lines)  →  _runTester, _runRealTestLoop
 *
 * All existing require('./orchestrator-stages') calls continue to work unchanged.
 */

'use strict';

const { _runAnalyst }                  = require('./stage-analyst');
const { _runArchitect }                = require('./stage-architect');
const { _runPlanner }                  = require('./stage-planner');
const { _runDeveloper }                = require('./stage-developer');
const { _runTester, _runRealTestLoop } = require('./stage-tester');

module.exports = { _runAnalyst, _runArchitect, _runPlanner, _runDeveloper, _runTester, _runRealTestLoop };
