/**
 * Stage Runners – barrel export
 *
 * P0 optimisation: Each pipeline stage is now an independent module.
 * Import all four built-in stage runners from this single entry point.
 */

'use strict';

const { AnalystStage }   = require('./analyst-stage');
const { ArchitectStage }  = require('./architect-stage');
const { PlannerStage }    = require('./planner-stage');
const { DeveloperStage }  = require('./developer-stage');
const { TesterStage }     = require('./tester-stage');

module.exports = {
  AnalystStage,
  ArchitectStage,
  PlannerStage,
  DeveloperStage,
  TesterStage,
};
