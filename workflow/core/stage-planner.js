/**
 * Stage Runner: PLAN
 *
 * Implements the PLAN pipeline stage – an independent execution planning stage
 * inserted between ARCHITECT and CODE.
 *
 * Responsibilities:
 *   - Read architecture.md from upstream (ARCHITECT stage output)
 *   - Inject upstream cross-stage context + experience context
 *   - Execute PlannerAgent to generate execution-plan.md
 *   - SocraticEngine user approval checkpoint
 *   - Store PLAN stage context for downstream consumption
 *   - Bus publish (PLAN → DEVELOPER)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { translateMdFile } = require('./i18n-translator');
const {
  storePlannerContext,
} = require('./orchestrator-stage-helpers');

/**
 * Builds upstream context for the Planner from previous stages.
 *
 * @param {Orchestrator} orch
 * @returns {string} Context block string
 */
function buildPlannerUpstreamCtx(orch) {
  const parts = [];

  // Inject ANALYSE stage context
  if (orch.stageCtx) {
    const analyseCtx = orch.stageCtx.get(WorkflowState.ANALYSE);
    if (analyseCtx) {
      parts.push(`## Upstream: ANALYSE Stage Summary`);
      parts.push(`Summary: ${analyseCtx.summary || 'N/A'}`);
      if (analyseCtx.keyDecisions && analyseCtx.keyDecisions.length > 0) {
        parts.push(`Key Decisions:\n${analyseCtx.keyDecisions.map(d => `- ${d}`).join('\n')}`);
      }
      if (analyseCtx.risks && analyseCtx.risks.length > 0) {
        parts.push(`Risks:\n${analyseCtx.risks.slice(0, 5).map(r => `- ${r}`).join('\n')}`);
      }
    }

    // Inject ARCHITECT stage context
    const archCtx = orch.stageCtx.get(WorkflowState.ARCHITECT);
    if (archCtx) {
      parts.push(`\n## Upstream: ARCHITECT Stage Summary`);
      parts.push(`Summary: ${archCtx.summary || 'N/A'}`);
      if (archCtx.keyDecisions && archCtx.keyDecisions.length > 0) {
        parts.push(`Key Decisions:\n${archCtx.keyDecisions.map(d => `- ${d}`).join('\n')}`);
      }
      if (archCtx.risks && archCtx.risks.length > 0) {
        parts.push(`Risks:\n${archCtx.risks.slice(0, 5).map(r => `- ${r}`).join('\n')}`);
      }
      if (archCtx.correctionHistory && archCtx.correctionHistory.length > 0) {
        parts.push(`Correction History: ${archCtx.correctionHistory.length} round(s) of self-correction`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Builds the full experience + upstream context block for the Planner.
 *
 * @param {Orchestrator} orch
 * @param {string} upstreamCtx
 * @returns {Promise<string>} Context block with experience and upstream info
 */
async function buildPlannerContextBlock(orch, upstreamCtx) {
  let expContext = '';
  const _injectedExpIds = [];

  // Inject relevant experiences from ExperienceStore
  if (orch.experienceStore) {
    try {
      const planExp = orch.experienceStore.query({
        skill: 'execution-planning',
        limit: orch._adaptiveStrategy?.maxExpInjected ?? 5,
        currentRequirement: orch._currentRequirement || '',
      });
      if (planExp.length > 0) {
        expContext += `## Execution Planning Experience (${planExp.length} items)\n`;
        for (const exp of planExp) {
          expContext += `- [${exp.type}] ${exp.title}: ${exp.content.slice(0, 200)}\n`;
          if (exp.id) _injectedExpIds.push(exp.id);
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  // Inject upstream context
  if (upstreamCtx) {
    expContext += `\n${upstreamCtx}`;
  }

  // Inject complaint context
  if (orch.complaintWall) {
    try {
      const planComplaints = orch.complaintWall.query({ target: 'workflow', status: 'open' });
      if (planComplaints.length > 0) {
        expContext += `\n## ⚠️ Open Complaints (from ComplaintWall)\n`;
        for (const c of planComplaints.slice(0, 3)) {
          expContext += `- [${c.severity}] ${c.description.slice(0, 150)}\n`;
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  const result = expContext || null;
  if (result) result._injectedExpIds = _injectedExpIds;
  return result;
}

async function _runPlanner() {
  const planStageStartTime = Date.now();
  console.log(`\n[Orchestrator] Stage: PLAN (PlannerAgent — Kent Beck XP Planning)`);
  const inputPath = this.bus.consume(AgentRole.PLANNER);
  console.log(`[Orchestrator] 📥 PLAN upstream input: ${inputPath ? path.basename(inputPath) : '(none)'}`);

  // ── Build upstream context ──────────────────────────────────────────────
  const upstreamCtx = buildPlannerUpstreamCtx(this);
  if (upstreamCtx) {
    const ctxLines = upstreamCtx.split('\n').filter(l => l.trim()).length;
    console.log(`[Orchestrator] 🔗 PLAN upstream context: ${ctxLines} line(s) from ANALYSE + ARCHITECT stages`);
  } else {
    console.log(`[Orchestrator] ⚠️  PLAN upstream context: empty (no prior stage context available)`);
  }

  // ── Build experience + context block ────────────────────────────────────
  const planExpContext = await buildPlannerContextBlock(this, upstreamCtx);
  if (planExpContext) {
    const injectedExpCount = (planExpContext._injectedExpIds || []).length;
    this.obs.recordExpUsage({ injected: injectedExpCount });
    console.log(`[Orchestrator] 📚 PLAN experience injection: ${injectedExpCount} experience(s) from ExperienceStore`);
    if (injectedExpCount > 0) {
      console.log(`[Orchestrator]    Experience IDs: [${planExpContext._injectedExpIds.slice(0, 5).join(', ')}${injectedExpCount > 5 ? '...' : ''}]`);
    }
  } else {
    console.log(`[Orchestrator] 📚 PLAN experience injection: none (ExperienceStore empty or no matches)`);
  }

  // ── Execute PlannerAgent ───────────────────────────────────────────────
  console.log(`[Orchestrator] 🚀 Executing PlannerAgent (generating execution-plan.md)...`);
  const plannerStartTime = Date.now();
  const outputPath = await this.agents[AgentRole.PLANNER].run(inputPath, null, planExpContext);
  const plannerDuration = ((Date.now() - plannerStartTime) / 1000).toFixed(1);
  console.log(`[Orchestrator] ✅ PlannerAgent completed in ${plannerDuration}s → ${outputPath ? path.basename(outputPath) : '(no output)'}`);

  // ── SocraticEngine: User approval of execution plan ────────────────────
  try {
    // Define the plan approval question inline (no need to add to socratic-engine.js constants
    // since it's only used here; can be extracted later if needed)
    const planApprovalQuestion = {
      id: 'PLAN_APPROVAL',
      question: '执行计划已生成。请审查计划后做出决定：',
      options: [
        { label: '✅ 批准执行计划，继续到 CODE 阶段', value: 'approve' },
        { label: '❌ 拒绝执行计划，终止工作流', value: 'reject' },
        { label: '⚠️ 有保留地批准，继续但记录风险', value: 'approve_with_reservations' },
      ],
      defaultIndex: 0,
    };

    const planDecision = this.socratic.askAsync(planApprovalQuestion, 0);
    if (planDecision.optionIndex === 1) {
      const abortMsg = '[SocraticEngine] User rejected execution plan. Workflow aborted by user decision.';
      this.stateMachine.recordRisk('high', abortMsg);
      throw new Error(abortMsg);
    } else if (planDecision.optionIndex === 2) {
      this.stateMachine.recordRisk('medium', '[SocraticEngine] User approved execution plan with reservations. Proceeding to CODE stage.');
      console.log(`[Orchestrator] ⚠️  Execution plan approved with reservations. Proceeding.`);
    } else {
      console.log(`[Orchestrator] ✅ Execution plan approved by user. Proceeding to CODE stage.`);
    }
  } catch (err) {
    if (err.message.includes('User rejected execution plan')) throw err;
    this.stateMachine.recordRisk('low', `[SocraticEngine] Plan approval skipped (engine unavailable): ${err.message}`);
    console.warn(`[Orchestrator] ⚠️  SocraticEngine plan approval skipped – proceeding automatically. Reason: ${err.message}`);
  }

  // ── Store PLAN stage context ──────────────────────────────────────────
  const planOutputCtx = storePlannerContext(this, outputPath);

  // ── Log plan artifact stats ───────────────────────────────────────────
  if (planOutputCtx.taskCount > 0) {
    console.log(`[Orchestrator] 📋 Execution plan breakdown: ${planOutputCtx.taskCount} task(s), ${planOutputCtx.keyDecisions.length} key decision(s)`);
  }
  if (planOutputCtx.summary) {
    console.log(`[Orchestrator] 📝 Plan summary: ${planOutputCtx.summary.slice(0, 150)}${planOutputCtx.summary.length > 150 ? '...' : ''}`);
  }

  // ── Read plan content for detailed logging ─────────────────────────────
  try {
    if (outputPath && fs.existsSync(outputPath)) {
      const planContent = fs.readFileSync(outputPath, 'utf-8');
      const planLines = planContent.split('\n').length;
      const planSize = Buffer.byteLength(planContent, 'utf-8');

      // Extract phase info
      const phaseMatches = planContent.match(/###?\s*Phase\s+\d+/gi) || [];
      // Extract dependency info
      const depMatches = planContent.match(/depend[s]?\s*(?:on)?\s*[:=]\s*\[?T-\d+/gi) || [];

      console.log(`[Orchestrator] 📊 Plan stats: ${planLines} lines, ${(planSize / 1024).toFixed(1)} KB, ${phaseMatches.length} phase(s), ${depMatches.length} dependency link(s)`);
    }
  } catch (_) { /* non-fatal logging */ }

  // ── Bus publish: PLAN → DEVELOPER ─────────────────────────────────────
  // The developer receives both the architecture doc AND the execution plan.
  // The architecture doc is passed via the bus from ARCHITECT→PLAN→DEVELOPER chain.
  // The execution plan path is stored in context for the developer to reference.
  const busMeta = {
    executionPlanPath: outputPath,
    contextSummary: planOutputCtx.summary,
    taskCount: planOutputCtx.taskCount || 0,
  };
  this.bus.publish(AgentRole.PLANNER, AgentRole.DEVELOPER, inputPath, busMeta);
  console.log(`[Orchestrator] 📤 Bus: PLANNER → DEVELOPER (architecture.md + execution-plan, ${busMeta.taskCount} task(s))`);

  // ── Translate to Chinese ──────────────────────────────────────────────
  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  const totalDuration = ((Date.now() - planStageStartTime) / 1000).toFixed(1);
  console.log(`[Orchestrator] ✅ PLAN stage completed in ${totalDuration}s (PlannerAgent: ${plannerDuration}s, overhead: ${(totalDuration - plannerDuration).toFixed(1)}s)`);

  return outputPath;
}

module.exports = { _runPlanner, buildPlannerUpstreamCtx, buildPlannerContextBlock };
