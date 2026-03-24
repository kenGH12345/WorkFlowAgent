/**
 * Developer Context Builder
 *
 * Extracted from orchestrator-stage-helpers.js to decompose the 1,800+ line
 * monolith into testable, focused modules (each < 400 lines).
 *
 * This module owns:
 *   - buildDeveloperUpstreamCtx() — cross-stage context for DEVELOPER
 *   - buildDeveloperContextBlock() — full context block assembly for DeveloperAgent
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { ComplaintTarget } = require('./complaint-wall');
const { WorkflowState } = require('./types');
const { buildJsonBlockInstruction } = require('./agent-output-schema');

const {
  BLOCK_PRIORITY,
  _applyTokenBudget,
  externalExperienceFallback,
} = require('./context-budget-manager');

const { _getContextProfile } = require('./context-helpers');

// Recall Memory: cross-session task history injection
let _taskHistoryInstance = null;
function _getTaskHistory() {
  if (!_taskHistoryInstance) {
    try {
      const { TaskHistory } = require('./task-history');
      _taskHistoryInstance = new TaskHistory();
    } catch (_) { /* task-history module not available */ }
  }
  return _taskHistoryInstance;
}

// ─── Cross-stage context injection ───────────────────────────────────────────

/**
 * Builds the upstream cross-stage context string for DEVELOPER stage.
 * Defect D fix: uses getRelevant() for dynamic context selection.
 *
 * @param {Orchestrator} orch
 * @param {string} [taskHints]
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

// ─── Full context block assembly ─────────────────────────────────────────────

/**
 * Assembles the full context string for DeveloperAgent:
 *   AGENTS.md + upstream ctx + experience + complaints + code graph
 *   + parallel MCP adapter data (API research, code quality, security, packages, CI, docgen, figma)
 *
 * @param {Orchestrator} orch
 * @param {string} upstreamCtx
 * @returns {Promise<string>}
 */
async function buildDeveloperContextBlock(orch, upstreamCtx) {
  const agentsMd = orch._agentsMdContent || '';
  if (agentsMd) console.log(`[Orchestrator] 📋 AGENTS.md injected into DeveloperAgent context.`);

  const jsonInstruction = buildJsonBlockInstruction('developer');

  // P1 fix: Detect tech stack for fallback experience matching
  const techStack = orch._detectTechStackForPreheat ? orch._detectTechStackForPreheat() : [];
  const devMaxExpInjected = orch._adaptiveStrategy?.maxExpInjected ?? 5;
  const { block: expCtx, ids: injectedExpIds } = await orch.experienceStore.getContextBlockWithIds('code-development', orch._currentRequirement, devMaxExpInjected, { techStack });
  console.log(`[Orchestrator] 📚 Experience context injected for DeveloperAgent (${expCtx.length} chars, ${injectedExpIds.length} experience(s), limit=${devMaxExpInjected})`);

  // Code graph context: query symbols from architecture.md
  let codeGraphCtx = '';
  try {
    const { PATHS } = require('./constants');
    const outputDir = orch._outputDir || PATHS.OUTPUT_DIR;
    const archPath = path.join(outputDir, 'architecture.md');
    if (fs.existsSync(archPath)) {
      const archContent = fs.readFileSync(archPath, 'utf-8');
      // R2-1 audit: extended regex to capture both PascalCase and camelCase identifiers
      // (previously only PascalCase was matched, missing most JS function names).
      // Also filter out common English words that are not code identifiers.
      const COMMON_WORDS = new Set([
        'This', 'That', 'These', 'Those', 'With', 'From', 'Should', 'Would', 'Could',
        'When', 'Where', 'What', 'Which', 'Each', 'Every', 'Some', 'None', 'Only',
        'Before', 'After', 'Between', 'During', 'About', 'Below', 'Above', 'Under',
        'Must', 'Also', 'Will', 'Shall', 'Note', 'Make', 'Uses', 'Used', 'Using',
      ]);
      const identifiers = [...new Set(
        (archContent.match(/\b[A-Za-z][a-zA-Z0-9_]{3,}\b/g) || [])
          .filter(id => id.length >= 4 && id.length <= 40)
          .filter(id => !COMMON_WORDS.has(id))
          // Prefer identifiers that look like code: contain uppercase transitions or underscores
          .filter(id => /[a-z][A-Z]|[A-Z][a-z]|_/.test(id))
          .slice(0, 25)
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

  // ── Smart Context Selection: classify and pre-filter ────────────────────
  const _devProfile = _getContextProfile(orch);

  // ── External Experience (cold-start fallback, not an adapter plugin) ────
  const devExternalExpBlock = await (async () => {
    if (injectedExpIds.length > 0) return '';
    return externalExperienceFallback(orch, 'code-development', orch._currentRequirement);
  })();

  // ── Plugin-driven adapter blocks ───────────────────────────────────────
  const pluginRegistry = orch._pluginRegistry || (orch.services && orch.services.has('pluginRegistry') ? orch.services.resolve('pluginRegistry') : null);
  let devPluginBlocks = [];
  if (pluginRegistry) {
    const pluginResult = await pluginRegistry.collectPluginBlocks(orch, 'DEVELOPER', _devProfile, 20);
    devPluginBlocks = pluginResult.blocks;
    // P2 fix: Record Tool Search stats for observability
    if (orch.obs && typeof orch.obs.recordToolSearchStats === 'function') {
      orch.obs.recordToolSearchStats('DEVELOPER', {
        totalPlugins: pluginResult.blocks.length + (pluginResult.skippedByKeyword?.length || 0),
        skippedByKeyword: pluginResult.skippedByKeyword || [],
        executedCount: pluginResult.blocks.filter(b => b.content && b.content.length > 0).length,
      });
    }
  }

  // ── P0-1 fix: Extract upstream context text and execution plan from the structured object.
  // stage-developer.js now passes { text: string, executionPlanBlock: string } instead of
  // a bare string (which silently dropped the executionPlanBlock expando).
  const upstreamCtxText = typeof upstreamCtx === 'string'
    ? upstreamCtx  // backward compat: if caller passes plain string
    : (upstreamCtx?.text || '');
  let executionPlanCtx = '';
  if (upstreamCtx && upstreamCtx.executionPlanBlock) {
    executionPlanCtx = upstreamCtx.executionPlanBlock;
    console.log(`[Orchestrator] 📋 Execution plan injected into DeveloperAgent context (${executionPlanCtx.length} chars).`);
  }

  // ── Module Scope from ANALYSE + PLAN stages (Phase 2.5B) ──────────────
  let moduleScopeCtx = '';
  try {
    const analyseCtx = orch.stageCtx?.get(WorkflowState.ANALYSE);
    const planCtx = orch.stageCtx?.get(WorkflowState.PLAN);
    const moduleMap = analyseCtx?.meta?.moduleMap;
    const moduleGrouping = planCtx?.meta?.moduleGrouping;

    if (moduleMap && Array.isArray(moduleMap.modules) && moduleMap.modules.length > 0) {
      const parts = [`\n## Module Scope Guide (from ANALYSE + PLAN stages)`];
      parts.push(`> Each module has file boundaries. Focus your code changes within the assigned module's boundaries to reduce cross-module conflicts.`);
      parts.push(``);
      parts.push(`| Module | Boundaries | Complexity | Isolatable |`);
      parts.push(`|--------|-----------|-----------|-----------|`);
      for (const m of moduleMap.modules) {
        parts.push(`| **${m.id}** (${m.name}) | ${(m.boundaries || []).join(', ') || 'N/A'} | ${m.complexity} | ${m.isolatable ? 'yes' : 'no'} |`);
      }
      if (moduleMap.crossCuttingConcerns && moduleMap.crossCuttingConcerns.length > 0) {
        parts.push(``);
        parts.push(`**Cross-cutting concerns** (shared across modules): ${moduleMap.crossCuttingConcerns.join(', ')}`);
      }
      if (moduleGrouping && Array.isArray(moduleGrouping.groups)) {
        parts.push(``);
        parts.push(`### Task-Module Assignments`);
        for (const g of moduleGrouping.groups) {
          parts.push(`- **${g.moduleId}** (${g.moduleName}): Tasks ${(g.taskIds || []).join(', ')}`);
        }
        if (moduleGrouping.crossModuleTasks && moduleGrouping.crossModuleTasks.length > 0) {
          parts.push(`- **cross-module**: Tasks ${moduleGrouping.crossModuleTasks.join(', ')}`);
        }
        parts.push(``);
        parts.push(`> **Module-Scope Rule**: When implementing a task, restrict your file changes to the module's boundaries listed above. If a task is cross-module, document which module boundary each file change belongs to.`);
      }
      moduleScopeCtx = parts.join('\n');
      console.log(`[Orchestrator] 🗺️  Module scope context injected into DeveloperAgent (${moduleScopeCtx.length} chars, ${moduleMap.modules.length} module(s)).`);
    }
  } catch (_) { /* non-fatal */ }

  // ── Recall Memory: cross-session task history ───────────────────────────
  let recallMemoryCtx = '';
  try {
    const taskHistory = _getTaskHistory();
    if (taskHistory) {
      recallMemoryCtx = taskHistory.getRecallBlock(5);
      if (recallMemoryCtx) {
        console.log(`[Orchestrator] 📖 Recall Memory injected for DeveloperAgent (${recallMemoryCtx.length} chars)`);
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Token Budget Guard (DEVELOPER) ─────────────────────────────────────
  const devLabelledBlocks = [
    { label: 'JSON Instruction',    content: jsonInstruction,                                          priority: BLOCK_PRIORITY.JSON_INSTRUCTION, _order: 0 },
    { label: 'AGENTS.md',           content: agentsMd ? `## Project Context (AGENTS.md)\n${agentsMd}` : '', priority: BLOCK_PRIORITY.AGENTS_MD, _order: 1 },
    // P0-1 + P0-2 fix: use upstreamCtxText (extracted above) instead of the raw object
    { label: 'Upstream Context',    content: upstreamCtxText,                                                                priority: BLOCK_PRIORITY.UPSTREAM_CTX, _order: 2 },
    { label: 'Execution Plan',     content: executionPlanCtx,                                          priority: BLOCK_PRIORITY.UPSTREAM_CTX + 1, _order: 3 },
    { label: 'Module Scope',       content: moduleScopeCtx,                                            priority: BLOCK_PRIORITY.UPSTREAM_CTX + 2, _order: 3.5 },
    { label: 'Experience',          content: expCtx,                                                   priority: BLOCK_PRIORITY.EXPERIENCE, _order: 4 },
    { label: 'Complaints',          content: complaintBlock,                                           priority: BLOCK_PRIORITY.COMPLAINTS, _order: 5 },
    { label: 'Code Graph',          content: codeGraphCtx ? `\n\n${codeGraphCtx}` : '',                priority: BLOCK_PRIORITY.CODE_GRAPH, _order: 6 },
    { label: 'External Experience', content: devExternalExpBlock,                                      priority: BLOCK_PRIORITY.EXTERNAL_EXPERIENCE, _order: 7 },
    { label: 'Recall Memory',       content: recallMemoryCtx,                                          priority: BLOCK_PRIORITY.EXTERNAL_EXPERIENCE - 1, _order: 8 },
    // Dynamic adapter blocks from plugin registry (starts at _order: 20)
    ...devPluginBlocks,
  ];

  // ── Smart Context: apply priority adjustments before budget guard ──────
  const devAdjustedBlocks = _devProfile ? _devProfile.applyToBlocks(devLabelledBlocks) : devLabelledBlocks;

  // Pass telemetry to _applyTokenBudget for lifecycle tracking
  const devTelemetry = orch._adapterTelemetry || null;
  const { assembled: devAssembled, stats: devStats } = _applyTokenBudget(devAdjustedBlocks, undefined, {
    telemetry: devTelemetry,
    stage: 'DEVELOPER',
  });
  if (devStats.dropped.length > 0 || devStats.truncated.length > 0) {
    console.log(`[Orchestrator] 📊 DEVELOPER token budget: ${devStats.total} chars, dropped=[${devStats.dropped.join(',')}], truncated=[${devStats.truncated.join(',')}]`);
  }
  if (devStats.compressionSaved > 0) {
    console.log(`[Orchestrator] 🗜️  DEVELOPER compression: saved ${devStats.compressionSaved} chars.`);
  }
  // P1 fix: Record ToolResultFilter stats for cross-session analysis
  if (orch.obs && devStats.preFilterSaved > 0) {
    orch.obs.recordToolResultFilterStats('DEVELOPER', {
      preFilterSaved: devStats.preFilterSaved,
      filteredLabels: devStats.preFilterLabels || [],
    });
  }

  // A-3 Architecture Fix: Return a proper struct instead of new String() hack.
  // See architect-context-builder.js for the full rationale.
  return { content: devAssembled, injectedExpIds };
}

module.exports = {
  buildDeveloperUpstreamCtx,
  buildDeveloperContextBlock,
};
