/**
 * Context Budget Manager – Re-export Facade
 *
 * ADR-33 (P0 decomposition): This file was previously a 1643-line monolith.
 * It is now a backward-compatible re-export facade that delegates to:
 *   - token-budget.js        (~475 lines) → budget constants, _applyTokenBudget, ToolResultFilter
 *   - web-search-helpers.js   (~188 lines) → webSearchHelper, formatWebSearchBlock, externalExperienceFallback
 *   - skill-enrichment.js     (~512 lines) → enrichSkillFromExternalKnowledge, preheatExperienceStore
 *   - mcp-adapter-helpers.js  (~544 lines) → all MCP adapter helper functions
 *
 * All existing require('./context-budget-manager') calls continue to work unchanged.
 */

'use strict';

const {
  STAGE_TOKEN_BUDGET_CHARS,
  BLOCK_PRIORITY,
  _applyTokenBudget,
  ToolResultFilter,
} = require('./token-budget');

const {
  webSearchHelper,
  formatWebSearchBlock,
  externalExperienceFallback,
} = require('./web-search-helpers');

const {
  enrichSkillFromExternalKnowledge,
  preheatExperienceStore,
} = require('./skill-enrichment');

const {
  packageRegistryHelper,
  securityCVEHelper,
  ciStatusHelper,
  licenseComplianceHelper,
  docGenHelper,
  llmCostRouterHelper,
  figmaDesignHelper,
  testInfraHelper,
  codeQualityHelper,
  formatCodeQualityBlock,
  _detectRegistry,
  _extractDependencies,
} = require('./mcp-adapter-helpers');

module.exports = {
  // Token budget
  STAGE_TOKEN_BUDGET_CHARS,
  BLOCK_PRIORITY,
  _applyTokenBudget,
  // P1: Tool Result Filter (Programmatic Tool Calling)
  ToolResultFilter,
  // Web search
  webSearchHelper,
  formatWebSearchBlock,
  externalExperienceFallback,
  enrichSkillFromExternalKnowledge,
  preheatExperienceStore,
  // Adapter helpers
  packageRegistryHelper,
  securityCVEHelper,
  ciStatusHelper,
  licenseComplianceHelper,
  docGenHelper,
  llmCostRouterHelper,
  figmaDesignHelper,
  testInfraHelper,
  codeQualityHelper,
  formatCodeQualityBlock,
  // Internal utilities (exported for testing)
  _detectRegistry,
  _extractDependencies,
};
