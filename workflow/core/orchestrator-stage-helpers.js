/**
 * Orchestrator Stage Helpers
 *
 * P2-NEW-1 fix: extracted from orchestrator-stages.js to reduce the "Fat Orchestrator"
 * problem. Each _runXxx function previously handled 8+ responsibilities inline.
 * This module owns the cross-cutting concerns:
 *   - Cross-stage context injection (upstream context block building)
 *   - Experience + complaint context block assembly
 *   - Stage context storage (stageCtx.set calls)
 *   - Bus publish helpers
 *
 * All functions receive `orchestrator` (the Orchestrator instance) as first arg
 * and use it to access this.stageCtx, this.experienceStore, this.complaintWall, etc.
 * This avoids `this`-binding gymnastics while keeping the helpers pure and testable.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { ComplaintTarget } = require('./complaint-wall');
const { StageContextStore } = require('./stage-context-store');
const { WorkflowState } = require('./types');
// P1-B fix: import buildJsonBlockInstruction so each agent's context block
// explicitly instructs the LLM to output a structured JSON header.
// Without this injection, extractJsonBlock() in StageContextStore always returns
// null and the system falls back to fragile regex extraction.
const { buildJsonBlockInstruction } = require('./agent-output-schema');

// ─── Cross-stage context injection ───────────────────────────────────────────

/**
 * Builds the upstream cross-stage context string for ARCHITECT stage.
 * Defect D fix: uses getRelevant() for dynamic context selection instead
 * of hardcoded getAll(['ARCHITECT'], 1500, ['ANALYSE']).
 *
 * @param {Orchestrator} orch
 * @param {string} [taskHints] - Optional failure context for rollback retries
 * @returns {string}
 */
function buildArchitectUpstreamCtx(orch, taskHints = '') {
  if (!orch.stageCtx) return '';
  // Defect D fix: use getRelevant() which dynamically scores and prioritises
  // upstream context based on stage proximity, risk density, correction history,
  // and keyword overlap with taskHints (e.g. rollback failure context).
  const ctx = orch.stageCtx.getRelevant(WorkflowState.ARCHITECT, {
    taskHints,
    maxChars: 1500,
    excludeStages: [WorkflowState.ARCHITECT],
  });
  if (ctx) {
    console.log(`[Orchestrator] 🔗 Cross-stage context injected into ArchitectAgent (${ctx.length} chars, dynamic selection). Upstream: ${orch.stageCtx.getLogLine()}`);
  }
  return ctx;
}

/**
 * Builds the upstream cross-stage context string for DEVELOPER stage.
 * Defect D fix: uses getRelevant() for dynamic context selection.
 *
 * @param {Orchestrator} orch
 * @param {string} [taskHints] - Optional failure context for rollback retries
 * @returns {string}
 */
function buildDeveloperUpstreamCtx(orch, taskHints = '') {
  if (!orch.stageCtx) return '';
  const ctx = orch.stageCtx.getRelevant(WorkflowState.CODE, {
    taskHints,
    maxChars: 1800,
    excludeStages: [WorkflowState.CODE],
  });
  if (ctx) {
    console.log(`[Orchestrator] 🔗 Cross-stage context injected into DeveloperAgent (${ctx.length} chars, dynamic selection). Upstream: ${orch.stageCtx.getLogLine()}`);
  }
  return ctx;
}

/**
 * Builds the upstream cross-stage context string for TESTER stage.
 * Defect D fix: uses getRelevant() for dynamic context selection.
 *
 * @param {Orchestrator} orch
 * @param {string} [taskHints] - Optional failure context for rollback retries
 * @returns {string}
 */
function buildTesterUpstreamCtx(orch, taskHints = '') {
  if (!orch.stageCtx) return '';
  const ctx = orch.stageCtx.getRelevant(WorkflowState.TEST, {
    taskHints,
    maxChars: 2000,
    excludeStages: [WorkflowState.TEST],
  });
  if (ctx) {
    console.log(`[Orchestrator] 🔗 Cross-stage context injected into TesterAgent (${ctx.length} chars, dynamic selection). Upstream: ${orch.stageCtx.getLogLine()}`);
  }
  return ctx;
}

// ─── Experience + complaint context block assembly ────────────────────────────

/**
 * Assembles the full context string for ArchitectAgent:
 *   techStackPrefix + AGENTS.md + upstream ctx + experience + complaints
 *
 * @param {Orchestrator} orch
 * @param {string} techStackPrefix
 * @param {string} upstreamCtx
 * @returns {string}
 */
async function buildArchitectContextBlock(orch, techStackPrefix, upstreamCtx) {
  const agentsMd = orch._agentsMdContent || '';
  if (agentsMd) console.log(`[Orchestrator] 📋 AGENTS.md injected into ArchitectAgent context.`);

  // EvoMap fix: use getContextBlockWithIds() so we can later call markUsedBatch()
  // when the ARCHITECT stage succeeds, closing the feedback loop:
  // hitCount now means "helped produce a passing architecture" not just "was retrieved".
  // Improvement 4: pass maxExpInjected from adaptive strategy so hit-rate feedback
  // can dynamically adjust how many experiences are injected into the prompt.
  const maxExpInjected = orch._adaptiveStrategy?.maxExpInjected ?? 5;
  const { block: expCtx, ids: injectedExpIds } = await orch.experienceStore.getContextBlockWithIds('architecture-design', orch._currentRequirement, maxExpInjected);
  console.log(`[Orchestrator] 📚 Experience context injected for ArchitectAgent (${expCtx.length} chars, ${injectedExpIds.length} experience(s), limit=${maxExpInjected})`);

  const complaints = orch.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'architecture-design');
  const complaintBlock = complaints.length > 0
    ? `\n\n## Known Issues (Open Complaints)\n${complaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
    : '';
  if (complaints.length > 0) {
    console.log(`[Orchestrator] ⚠️  ${complaints.length} open complaint(s) injected into ArchitectAgent context.`);
  }

  // P1-B fix: inject structured output instruction so the LLM knows it MUST
  // begin its response with a JSON metadata block. Without this, extractJsonBlock()
  // in StageContextStore always returns null and falls back to fragile regex parsing.
  const jsonInstruction = buildJsonBlockInstruction('architect');

  const block = [
    jsonInstruction,
    techStackPrefix ? techStackPrefix.trim() : '',
    agentsMd ? `## Project Context (AGENTS.md)\n${agentsMd}` : '',
    upstreamCtx,
    expCtx,
    complaintBlock,
  ].filter(Boolean).join('\n\n');

  // Attach injectedExpIds to the returned string so _runArchitect can access them
  // without changing the function signature. Callers that only use the string value
  // are unaffected; callers that need the IDs read block._injectedExpIds.
  block._injectedExpIds = injectedExpIds;
  return block;
}

/**
 * Assembles the full context string for DeveloperAgent:
 *   AGENTS.md + upstream ctx + experience + complaints + code graph
 *
 * @param {Orchestrator} orch
 * @param {string} upstreamCtx
 * @returns {string}
 */
async function buildDeveloperContextBlock(orch, upstreamCtx) {
  const agentsMd = orch._agentsMdContent || '';
  if (agentsMd) console.log(`[Orchestrator] 📋 AGENTS.md injected into DeveloperAgent context.`);

  // P1-B fix: inject structured output instruction.
  const jsonInstruction = buildJsonBlockInstruction('developer');

  // EvoMap fix: use getContextBlockWithIds() to enable feedback-loop marking.
  // Improvement 4: pass maxExpInjected from adaptive strategy.
  const devMaxExpInjected = orch._adaptiveStrategy?.maxExpInjected ?? 5;
  const { block: expCtx, ids: injectedExpIds } = await orch.experienceStore.getContextBlockWithIds('code-development', orch._currentRequirement, devMaxExpInjected);
  console.log(`[Orchestrator] 📚 Experience context injected for DeveloperAgent (${expCtx.length} chars, ${injectedExpIds.length} experience(s), limit=${devMaxExpInjected})`);

  // Code graph context: query symbols from architecture.md
  // P0-C fix: use orch._outputDir (instance-level) instead of global PATHS.OUTPUT_DIR.
  // When multiple tasks run in parallel with separate output directories, the global
  // constant would point to the wrong architecture.md.
  let codeGraphCtx = '';
  try {
    const { PATHS } = require('./constants');
    const outputDir = orch._outputDir || PATHS.OUTPUT_DIR;
    const archPath = path.join(outputDir, 'architecture.md');
    if (fs.existsSync(archPath)) {
      const archContent = fs.readFileSync(archPath, 'utf-8');
      const identifiers = [...new Set(
        (archContent.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [])
          .filter(id => id.length >= 3 && id.length <= 40)
          .slice(0, 20)
      )];
      if (identifiers.length > 0) {
        const graphMd = orch.codeGraph.querySymbolsAsMarkdown(identifiers);
        if (graphMd && !graphMd.includes('_Code graph not available') && !graphMd.includes('_No matching')) {
          codeGraphCtx = graphMd;
          console.log(`[Orchestrator] 🗺️  Code graph: queried ${identifiers.length} symbol(s) from architecture doc`);
        }
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] Code graph query failed (non-fatal): ${err.message}`);
  }

  const complaints = orch.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'code-development');
  const complaintBlock = complaints.length > 0
    ? `\n\n## Known Issues (Open Complaints)\n${complaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
    : '';
  if (complaints.length > 0) {
    console.log(`[Orchestrator] ⚠️  ${complaints.length} open complaint(s) injected into DeveloperAgent context.`);
  }

  const block = [
    jsonInstruction,
    agentsMd ? `## Project Context (AGENTS.md)\n${agentsMd}` : '',
    upstreamCtx,
    expCtx,
    complaintBlock,
    codeGraphCtx ? `\n\n${codeGraphCtx}` : '',
  ].filter(Boolean).join('\n\n');

  block._injectedExpIds = injectedExpIds;
  return block;
}

/**
 * Assembles the full context string for TesterAgent:
 *   AGENTS.md + upstream ctx + experience + complaints + real execution results
 *
 * @param {Orchestrator} orch
 * @param {string} upstreamCtx
 * @param {object|null} tcExecutionReport
 * @returns {string}
 */
async function buildTesterContextBlock(orch, upstreamCtx, tcExecutionReport) {
  const agentsMd = orch._agentsMdContent || '';
  if (agentsMd) console.log(`[Orchestrator] 📋 AGENTS.md injected into TesterAgent context.`);

  // P1-B fix: inject structured output instruction.
  const jsonInstruction = buildJsonBlockInstruction('tester');

  // EvoMap fix: use getContextBlockWithIds() to enable feedback-loop marking.
  // Improvement 4: pass maxExpInjected from adaptive strategy.
  const testMaxExpInjected = orch._adaptiveStrategy?.maxExpInjected ?? 5;
  const { block: expCtx, ids: injectedExpIds } = await orch.experienceStore.getContextBlockWithIds('test-report', orch._currentRequirement, testMaxExpInjected);
  console.log(`[Orchestrator] 📚 Experience context injected for TesterAgent (${expCtx.length} chars, ${injectedExpIds.length} experience(s), limit=${testMaxExpInjected})`);

  const complaints = orch.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'test-report');
  const complaintBlock = complaints.length > 0
    ? `\n\n## Known Issues (Open Complaints)\n${complaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
    : '';
  if (complaints.length > 0) {
    console.log(`[Orchestrator] ⚠️  ${complaints.length} open complaint(s) injected into TesterAgent context.`);
  }

  // Real execution results block (see CHANGELOG: Defect #4, M-5)
  let realExecutionBlock = '';
  if (tcExecutionReport && !tcExecutionReport.skipped) {
    const manualCases = (tcExecutionReport.caseResults || []).filter(tc => tc._executionStatus === 'MANUAL_PENDING');
    const manualBlock = manualCases.length > 0
      ? `\n\n## 🖐️ Manual Test Cases (Cannot Be Automated)\n` +
        `> The following ${manualCases.length} case(s) require **human verification**.\n` +
        `> **TesterAgent instruction**: Include a "Manual Verification Checklist" section in your test report\n` +
        `> for each case below. Mark each as ✅ PASS, ❌ FAIL, or ⏳ PENDING based on manual review.\n\n` +
        manualCases.map((tc, i) =>
          `### ${i + 1}. ${tc.case_id}: ${tc.title || ''}\n` +
          (tc.precondition ? `- **Precondition**: ${tc.precondition}\n` : '') +
          (tc.steps && tc.steps.length > 0
            ? `- **Steps**:\n${tc.steps.map((s, j) => `  ${j + 1}. ${s}`).join('\n')}\n`
            : '') +
          (tc.expected ? `- **Expected**: ${tc.expected}\n` : '') +
          `- **Status**: 🖐️ MANUAL_PENDING – awaiting human tester confirmation`
        ).join('\n\n')
      : '';
    realExecutionBlock =
      `\n\n## ⚡ Real Test Execution Results (Pre-Run)\n` +
      `> The following results come from ACTUALLY RUNNING the generated test script.\n` +
      `> Use these as ground truth – do NOT contradict them in your report.\n\n` +
      `${tcExecutionReport.summaryMd}` +
      manualBlock;
    console.log(`[Orchestrator] ⚡ Real execution results injected into TesterAgent context (${tcExecutionReport.total} cases, ${manualCases.length} manual).`);
  }

  const block = [
    jsonInstruction,
    agentsMd ? `## Project Context (AGENTS.md)\n${agentsMd}` : '',
    upstreamCtx,
    expCtx,
    complaintBlock,
    realExecutionBlock,
  ].filter(Boolean).join('\n\n');

  block._injectedExpIds = injectedExpIds;
  return block;
}

// ─── Stage context storage helpers ───────────────────────────────────────────

/**
 * Defect E fix: Distils a raw correction history array (from ReviewAgent.review() or
 * SelfCorrectionEngine.correct()) into a compact, token-efficient format suitable for
 * injection into downstream agent prompts via StageContextStore.getAll().
 *
 * Input shapes handled:
 *   ReviewAgent history:        [{ round, failures: [{id, finding}], before, after }]
 *   SelfCorrectionEngine history: [{ round, signals: [{label, severity}], before, after, source? }]
 *
 * Output shape: [{ round: number, issuesFixed: string[], source?: string }]
 *   - `issuesFixed` contains up to 3 short descriptions of what was corrected.
 *   - `before`/`after` are intentionally dropped (too large for prompt injection).
 *
 * @param {object[]} rawHistory - Raw history array from ReviewAgent or SelfCorrectionEngine
 * @returns {{ round: number, issuesFixed: string[], source?: string }[]}
 */
function _extractCorrectionHistory(rawHistory) {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) return [];

  return rawHistory.map(h => {
    const entry = { round: h.round };

    // ReviewAgent history: failures[].finding contains the issue description
    if (Array.isArray(h.failures) && h.failures.length > 0) {
      entry.issuesFixed = h.failures
        .slice(0, 3)
        .map(f => f.finding ? f.finding.slice(0, 120) : (f.id || 'unknown issue'));
    }
    // SelfCorrectionEngine history: signals[].label contains the issue description
    else if (Array.isArray(h.signals) && h.signals.length > 0) {
      entry.issuesFixed = h.signals
        .slice(0, 3)
        .map(s => s.label ? `[${s.severity || 'medium'}] ${s.label.slice(0, 100)}` : 'signal resolved');
    }
    else {
      entry.issuesFixed = [];
    }

    // Preserve source tag if present (e.g. 'deep-investigation' from SelfCorrectionEngine)
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
  // P2-B fix: unified null guard across all storeXxxContext helpers.
  // stageCtx is now eagerly initialised in the constructor (P2-A fix), so this
  // should never be null in production. Throw fast to surface bugs early rather
  // than silently skipping context storage (which would cause downstream agents
  // to see empty upstream context and produce lower-quality output).
  if (!orch.stageCtx) throw new Error('[storeAnalyseContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.ANALYSE);
  orch.stageCtx.set(WorkflowState.ANALYSE, {
    summary:      ctx.summary,
    keyDecisions: ctx.keyDecisions,
    artifacts:    [outputPath],
    risks:        clarResult.riskNotes ?? [],
    meta: {
      clarificationRounds: clarResult.rounds ?? 0,
      signalCount:         clarResult.allSignals?.length ?? 0,
      skipped:             clarResult.skipped ?? false,
    },
  });
  console.log(`[Orchestrator] 🔗 ANALYSE context stored: ${ctx.keyDecisions.length} key decision(s).`);
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
  // P2-B fix: unified null guard (see storeAnalyseContext).
  if (!orch.stageCtx) throw new Error('[storeArchitectContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.ARCHITECT);

  // Defect E fix: extract structured correction history from archReviewResult.history.
  // archReviewResult.history is populated by ArchitectureReviewAgent.review() and has
  // the shape: [{ round, itemsBefore, itemsAfter, fixedIds, ... }].
  // We distil each round into a compact { round, issuesFixed[] } entry so downstream
  // agents (DeveloperAgent) know exactly what was corrected in the architecture,
  // preventing them from re-introducing already-fixed issues during implementation.
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
 * Stores CODE stage context.
 *
 * @param {Orchestrator} orch
 * @param {string} outputPath
 * @param {object} reviewResult
 * @returns {{ summary: string, keyDecisions: string[] }}
 */
function storeCodeContext(orch, outputPath, reviewResult) {
  // P2-B fix: unified null guard (see storeAnalyseContext).
  if (!orch.stageCtx) throw new Error('[storeCodeContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.CODE);

  // Defect E fix: extract structured correction history from reviewResult.history.
  // reviewResult.history is populated by CodeReviewAgent.review() and has the same
  // shape as ArchReviewResult.history. Downstream TesterAgent reads this to understand
  // what code issues were corrected, so it can focus test coverage on corrected areas.
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
 * @param {object|null} [corrResult]  - Defect E fix: SelfCorrectionEngine result for the
 *   test report. If provided, corrResult.history is extracted and stored as correctionHistory
 *   so downstream stages (if any) can see what was corrected in the test report.
 */
function storeTestContext(orch, outputPath, tcGenResult, tcExecutionReport, corrResult = null) {
  // P2-B fix: unified null guard – throw instead of silently returning.
  // Previously storeTestContext was the only helper with a null check, and it
  // returned silently (losing all TEST context). The other three helpers assumed
  // stageCtx was non-null and would throw TypeError. Now all four are consistent:
  // null stageCtx is a bug that should surface immediately.
  if (!orch.stageCtx) throw new Error('[storeTestContext] orch.stageCtx is null – StageContextStore was not initialised.');
  const ctx = StageContextStore.extractFromFile(outputPath, WorkflowState.TEST);
  const pendingMeta = orch._pendingTestMeta || {};

  // Defect E fix: extract correction history from SelfCorrectionEngine result.
  // corrResult.history has shape: [{ round, signals, before, after, source? }].
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

module.exports = {
  // Upstream context builders
  buildArchitectUpstreamCtx,
  buildDeveloperUpstreamCtx,
  buildTesterUpstreamCtx,
  // Agent context block assemblers
  buildArchitectContextBlock,
  buildDeveloperContextBlock,
  buildTesterContextBlock,
  // Stage context storage helpers
  storeAnalyseContext,
  storeArchitectContext,
  storeCodeContext,
  storeTestContext,
};
