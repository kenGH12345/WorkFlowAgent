/**
 * Orchestrator Stage Helpers — Thin Re-export Facade
 *
 * ARCHITECTURE REFACTOR: The original 1,800+ line monolith has been decomposed into
 * focused, independently testable modules:
 *
 *   ┌────────────────────────────────────┬────────────────────────────────────────┐
 *   │ Module                             │ Responsibility                         │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ context-budget-manager.js          │ Token budget, BLOCK_PRIORITY,          │
 *   │                                    │ web search cache/helpers,              │
 *   │                                    │ all MCP adapter helpers                │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ architect-context-builder.js       │ buildArchitectUpstreamCtx(),           │
 *   │                                    │ buildArchitectContextBlock()           │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ developer-context-builder.js       │ buildDeveloperUpstreamCtx(),           │
 *   │                                    │ buildDeveloperContextBlock()           │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ tester-context-builder.js          │ buildTesterUpstreamCtx(),              │
 *   │                                    │ buildTesterContextBlock()              │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ context-helpers.js                 │ _getContextProfile() shared utility    │
 *   ├────────────────────────────────────┼────────────────────────────────────────┤
 *   │ orchestrator-stage-helpers.js      │ THIS FILE — stage context storage      │
 *   │ (facade)                           │ helpers + re-exports for backward      │
 *   │                                    │ compatibility                          │
 *   └────────────────────────────────────┴────────────────────────────────────────┘
 *
 * This facade re-exports ALL original symbols so that consumers
 * (e.g. orchestrator-stages.js) require NO import changes.
 */

'use strict';

const { StageContextStore } = require('./stage-context-store');
const { WorkflowState } = require('./types');

// ─── Re-exports from sub-modules ─────────────────────────────────────────────

const {
  STAGE_TOKEN_BUDGET_CHARS,
  BLOCK_PRIORITY,
  _applyTokenBudget,
  webSearchHelper,
  formatWebSearchBlock,
  externalExperienceFallback,
  enrichSkillFromExternalKnowledge,
  preheatExperienceStore,
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
} = require('./context-budget-manager');

const { buildArchitectUpstreamCtx, buildArchitectContextBlock } = require('./architect-context-builder');
const { buildDeveloperUpstreamCtx, buildDeveloperContextBlock } = require('./developer-context-builder');
const { buildTesterUpstreamCtx, buildTesterContextBlock }       = require('./tester-context-builder');

// ─── Stage context storage helpers (owned by this module) ────────────────────

/**
 * Defect E fix: Distils a raw correction history array into a compact,
 * token-efficient format suitable for injection into downstream agent prompts.
 *
 * @param {object[]} rawHistory
 * @returns {{ round: number, issuesFixed: string[], source?: string }[]}
 */
function _extractCorrectionHistory(rawHistory) {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) return [];

  return rawHistory.map(h => {
    const entry = { round: h.round };

    if (Array.isArray(h.failures) && h.failures.length > 0) {
      entry.issuesFixed = h.failures
        .slice(0, 3)
        .map(f => f.finding ? f.finding.slice(0, 120) : (f.id || 'unknown issue'));
    }
    else if (Array.isArray(h.signals) && h.signals.length > 0) {
      entry.issuesFixed = h.signals
        .slice(0, 3)
        .map(s => s.label ? `[${s.severity || 'medium'}] ${s.label.slice(0, 100)}` : 'signal resolved');
    }
    else {
      entry.issuesFixed = [];
    }

    if (h.source) entry.source = h.source;

    return entry;
  });
}

/**
 * Stores ANALYSE stage context for downstream stage consumption.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} clarResult
 */
function storeAnalyseContext(orch, outputPath, clarResult) {
  if (!orch.stageCtx) throw new Error('[storeAnalyseContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.ANALYSE);

  // ── Extract Functional Module Map from JSON block ────────────────────────
  // P1-ModuleMap: If the analyst output contains a structured moduleMap in
  // the JSON block, extract it and store it in meta for downstream consumption.
  // The ARCHITECT stage reads this to enable module-aware architecture design.
  let moduleMap = null;
  if (ctx.jsonBlock && ctx.jsonBlock.moduleMap) {
    const mm = ctx.jsonBlock.moduleMap;
    if (Array.isArray(mm.modules) && mm.modules.length > 0) {
      moduleMap = {
        modules: mm.modules.filter(m => m.id && m.name).map(m => ({
          id:           m.id,
          name:         m.name,
          description:  m.description || '',
          boundaries:   Array.isArray(m.boundaries) ? m.boundaries : [],
          dependencies: Array.isArray(m.dependencies) ? m.dependencies : [],
          complexity:   m.complexity || 'medium',
          isolatable:   Boolean(m.isolatable),
        })),
        crossCuttingConcerns: Array.isArray(mm.crossCuttingConcerns) ? mm.crossCuttingConcerns : [],
      };
      console.log(`[Orchestrator] 🗺️  Module Map extracted: ${moduleMap.modules.length} module(s), ${moduleMap.crossCuttingConcerns.length} cross-cutting concern(s).`);
    }
  }

  orch.stageCtx.set(WorkflowState.ANALYSE, {
    summary:      ctx.summary,
    keyDecisions: ctx.keyDecisions,
    artifacts:    [outputPath],
    risks:        clarResult.riskNotes ?? [],
    meta: {
      clarificationRounds: clarResult.rounds ?? 0,
      signalCount:         clarResult.allSignals?.length ?? 0,
      skipped:             clarResult.skipped ?? false,
      moduleMap,
    },
  });
  const mmMsg = moduleMap ? `, ${moduleMap.modules.length} module(s) mapped` : '';
  console.log(`[Orchestrator] 🔗 ANALYSE context stored: ${ctx.keyDecisions.length} key decision(s)${mmMsg}.`);
  return ctx;
}

/**
 * Stores ARCHITECT stage context.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} archReviewResult
 * @param {object} coverageResult
 * @returns {{ summary: string, keyDecisions: string[] }}
 */
function storeArchitectContext(orch, outputPath, archReviewResult, coverageResult) {
  if (!orch.stageCtx) throw new Error('[storeArchitectContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.ARCHITECT);

  const correctionHistory = _extractCorrectionHistory(archReviewResult.history);

  orch.stageCtx.set(WorkflowState.ARCHITECT, {
    summary:           ctx.summary,
    keyDecisions:      ctx.keyDecisions,
    artifacts:         [outputPath],
    risks:             archReviewResult.riskNotes ?? [],
    correctionHistory,
    meta: {
      reviewRounds: archReviewResult.rounds ?? 0,
      failedItems:  archReviewResult.failed ?? 0,
      coverageRate: coverageResult.coverageRate ?? null,
    },
  });
  const corrMsg = correctionHistory.length > 0 ? `, ${correctionHistory.length} correction round(s)` : '';
  console.log(`[Orchestrator] 🔗 ARCHITECT context stored: ${ctx.keyDecisions.length} key decision(s), ${archReviewResult.riskNotes?.length ?? 0} risk(s)${corrMsg}.`);
  return ctx;
}

/**
 * Stores PLAN stage context for downstream stage consumption.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @returns {{ summary: string, keyDecisions: string[], taskCount: number }}
 */
function storePlannerContext(orch, outputPath) {
  if (!orch.stageCtx) throw new Error('[storePlannerContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.PLAN);

  // Extract task count from the plan content
  let taskCount = 0;
  try {
    const fs = require('fs');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      const taskMatches = content.match(/#### Task T-/g);
      taskCount = taskMatches ? taskMatches.length : 0;
    }
  } catch (_) { /* non-fatal */ }

  orch.stageCtx.set(WorkflowState.PLAN, {
    summary:      ctx.summary,
    keyDecisions: ctx.keyDecisions,
    artifacts:    [outputPath],
    risks:        [],
    meta: {
      taskCount,
    },
  });
  console.log(`[Orchestrator] 🔗 PLAN context stored: ${ctx.keyDecisions.length} key decision(s), ${taskCount} task(s).`);
  return { ...ctx, taskCount };
}

/**
 * Stores CODE stage context.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} reviewResult
 * @returns {{ summary: string, keyDecisions: string[] }}
 */
function storeCodeContext(orch, outputPath, reviewResult) {
  if (!orch.stageCtx) throw new Error('[storeCodeContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.CODE);

  const correctionHistory = _extractCorrectionHistory(reviewResult.history);

  orch.stageCtx.set(WorkflowState.CODE, {
    summary:           ctx.summary,
    keyDecisions:      ctx.keyDecisions,
    artifacts:         [outputPath],
    risks:             reviewResult.riskNotes ?? [],
    correctionHistory,
    meta: {
      reviewRounds: reviewResult.rounds ?? 0,
      failedItems:  reviewResult.failed ?? 0,
    },
  });
  const corrMsg = correctionHistory.length > 0 ? `, ${correctionHistory.length} correction round(s)` : '';
  console.log(`[Orchestrator] 🔗 CODE context stored: ${ctx.keyDecisions.length} key decision(s), ${reviewResult.riskNotes?.length ?? 0} risk(s)${corrMsg}.`);
  return ctx;
}

/**
 * Stores TEST stage context (merges _pendingTestMeta).
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} tcGenResult
 * @param {object|null} tcExecutionReport
 * @param {object|null} [corrResult]
 */
function storeTestContext(orch, outputPath, tcGenResult, tcExecutionReport, corrResult = null) {
  if (!orch.stageCtx) throw new Error('[storeTestContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.TEST);
  const pendingMeta = orch._pendingTestMeta || {};

  const correctionHistory = _extractCorrectionHistory(corrResult?.history || []);

  orch.stageCtx.set(WorkflowState.TEST, {
    summary:           ctx.summary,
    keyDecisions:      ctx.keyDecisions,
    artifacts:         [outputPath],
    risks:             [],
    correctionHistory,
    meta: {
      ...pendingMeta,
      tcGenerated: tcGenResult.caseCount ?? 0,
      tcExecuted:  tcExecutionReport ? (tcExecutionReport.automatedTotal ?? 0) : 0,
      tcPassed:    tcExecutionReport ? (tcExecutionReport.passed ?? 0) : 0,
    },
  });
  orch._pendingTestMeta = null;
  const corrMsg = correctionHistory.length > 0 ? `, ${correctionHistory.length} correction round(s)` : '';
  console.log(`[Orchestrator] 🔗 TEST context stored: ${ctx.keyDecisions.length} key decision(s)${corrMsg}.`);
}

// ─── Module exports (backward-compatible with original monolith) ─────────────

module.exports = {
  // Upstream context builders (from sub-modules)
  buildArchitectUpstreamCtx,
  buildDeveloperUpstreamCtx,
  buildTesterUpstreamCtx,
  // Agent context block assemblers (from sub-modules)
  buildArchitectContextBlock,
  buildDeveloperContextBlock,
  buildTesterContextBlock,
  // Stage context storage helpers (owned by this module)
  storeAnalyseContext,
  storeArchitectContext,
  storePlannerContext,
  storeCodeContext,
  storeTestContext,
  // Web search utilities (from context-budget-manager)
  webSearchHelper,
  formatWebSearchBlock,
  // Package registry + security CVE utilities (from context-budget-manager)
  packageRegistryHelper,
  securityCVEHelper,
  // Code quality utilities (from context-budget-manager)
  codeQualityHelper,
  formatCodeQualityBlock,
  // CI status utilities (from context-budget-manager)
  ciStatusHelper,
  // License compliance utilities (from context-budget-manager)
  licenseComplianceHelper,
  // DocGen utilities (from context-budget-manager)
  docGenHelper,
  // LLM cost router utilities (from context-budget-manager)
  llmCostRouterHelper,
  // Test infra utilities (from context-budget-manager)
  testInfraHelper,
  // Figma design utilities (from context-budget-manager)
  figmaDesignHelper,
  // External experience fallback (from context-budget-manager)
  externalExperienceFallback,
  // External knowledge → Skill enrichment (from context-budget-manager, ADR-29)
  enrichSkillFromExternalKnowledge,
  // Experience Store cold-start preheating (from context-budget-manager, ADR-30)
  preheatExperienceStore,
};
