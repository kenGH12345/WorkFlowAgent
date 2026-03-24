/**
 * Architect Context Builder
 *
 * Extracted from orchestrator-stage-helpers.js to decompose the 1,800+ line
 * monolith into testable, focused modules (each < 400 lines).
 *
 * This module owns:
 *   - buildArchitectUpstreamCtx() — cross-stage context for ARCHITECT
 *   - buildArchitectContextBlock() — full context block assembly for ArchitectAgent
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { ComplaintTarget } = require('./complaint-wall');
const { WorkflowState } = require('./types');
const { buildJsonBlockInstruction } = require('./agent-output-schema');
const { SmartContextSelector } = require('./smart-context-selector');

const {
  BLOCK_PRIORITY,
  _applyTokenBudget,
  externalExperienceFallback,
} = require('./context-budget-manager');

// Re-use the shared _getContextProfile helper
const { _getContextProfile } = require('./context-helpers');

// Recall Memory: cross-session task history injection
let _archTaskHistoryInstance = null;
function _getArchTaskHistory() {
  if (!_archTaskHistoryInstance) {
    try {
      const { TaskHistory } = require('./task-history');
      _archTaskHistoryInstance = new TaskHistory();
    } catch (_) { /* task-history module not available */ }
  }
  return _archTaskHistoryInstance;
}

// ─── Cross-stage context injection ───────────────────────────────────────────

/**
 * Builds the upstream cross-stage context string for ARCHITECT stage.
 * Defect D fix: uses getRelevant() for dynamic context selection.
 *
 * @param {Orchestrator} orch
 * @param {string} [taskHints]
 * @returns {string}
 */
function buildArchitectUpstreamCtx(orch, taskHints = '') {
  if (!orch.stageCtx) return '';
  const ctx = orch.stageCtx.getRelevant(WorkflowState.ARCHITECT, {
    taskHints,
    maxChars: 1500,
    excludeStages: [WorkflowState.ARCHITECT],
  });
  if (ctx) {
    console.log(`[Orchestrator] 🔗 Cross-stage context injected into ArchitectAgent (${ctx.length} chars, dynamic selection). Upstream: ${orch.stageCtx.getLogLine()}`);
  }

  // ── P1-ModuleMap: Extract and format Functional Module Map ──────────────
  // If ANALYSE stage produced a moduleMap, format it as a dedicated section
  // so ArchitectAgent can use it for module-aware architecture design.
  let moduleMapSection = '';
  const analyseCtx = orch.stageCtx.get(WorkflowState.ANALYSE);
  const moduleMap = analyseCtx?.meta?.moduleMap;
  if (moduleMap && Array.isArray(moduleMap.modules) && moduleMap.modules.length > 0) {
    const lines = [
      `\n## 🗺️ Functional Module Map (from ANALYSE stage)`,
      `> Use this map to structure your architecture around identified modules.`,
      `> Each module represents a distinct functional domain. Design module interfaces explicitly.`,
      `> Isolatable modules (isolatable=true) can potentially be designed in parallel.`,
      ``,
      `| Module ID | Name | Description | Boundaries | Dependencies | Complexity | Isolatable |`,
      `|-----------|------|-------------|------------|--------------|------------|------------|`,
    ];
    for (const m of moduleMap.modules) {
      const bounds = (m.boundaries || []).join(', ') || 'N/A';
      const deps = (m.dependencies || []).join(', ') || 'none';
      lines.push(`| ${m.id} | ${m.name} | ${m.description} | ${bounds} | ${deps} | ${m.complexity} | ${m.isolatable ? 'yes' : 'no'} |`);
    }
    if (moduleMap.crossCuttingConcerns && moduleMap.crossCuttingConcerns.length > 0) {
      lines.push(``);
      lines.push(`**Cross-cutting concerns:** ${moduleMap.crossCuttingConcerns.join(', ')}`);
      lines.push(`> These concerns span multiple modules and should be addressed at the architecture level, not within individual modules.`);
    }
    lines.push(``);
    lines.push(`**Architecture instruction:** Design your component breakdown to align with this module map. Each module should become a component (or component group) in your architecture. Define explicit interface contracts between modules, especially where dependencies exist.`);
    moduleMapSection = lines.join('\n');
    console.log(`[Orchestrator] 🗺️  Module Map injected into ArchitectAgent: ${moduleMap.modules.length} module(s), ${moduleMap.modules.filter(m => m.isolatable).length} isolatable.`);
  }

  return (ctx || '') + moduleMapSection;
}

// ─── Full context block assembly ─────────────────────────────────────────────

/**
 * Assembles the full context string for ArchitectAgent:
 *   techStackPrefix + AGENTS.md + upstream ctx + experience + complaints
 *   + parallel MCP adapter data (industry research, packages, CVEs, license, figma)
 *
 * @param {Orchestrator} orch
 * @param {string} techStackPrefix
 * @param {string} upstreamCtx
 * @returns {Promise<string>}
 */
async function buildArchitectContextBlock(orch, techStackPrefix, upstreamCtx) {
  const agentsMd = orch._agentsMdContent || '';
  if (agentsMd) console.log(`[Orchestrator] 📋 AGENTS.md injected into ArchitectAgent context.`);

  // P1 fix: Detect tech stack for fallback experience matching
  const techStack = orch._detectTechStackForPreheat ? orch._detectTechStackForPreheat() : [];
  const maxExpInjected = orch._adaptiveStrategy?.maxExpInjected ?? 5;
  const { block: expCtx, ids: injectedExpIds } = await orch.experienceStore.getContextBlockWithIds('architecture-design', orch._currentRequirement, maxExpInjected, { techStack });
  console.log(`[Orchestrator] 📚 Experience context injected for ArchitectAgent (${expCtx.length} chars, ${injectedExpIds.length} experience(s), limit=${maxExpInjected})`);

  const complaints = orch.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'architecture-design');
  const complaintBlock = complaints.length > 0
    ? `\n\n## Known Issues (Open Complaints)\n${complaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
    : '';
  if (complaints.length > 0) {
    console.log(`[Orchestrator] ⚠️  ${complaints.length} open complaint(s) injected into ArchitectAgent context.`);
  }

  const jsonInstruction = buildJsonBlockInstruction('architect');

  // ── Smart Context Selection: classify and pre-filter ────────────────────
  const _archProfile = _getContextProfile(orch);

  // ── External Experience (cold-start fallback, not an adapter plugin) ────
  const externalExpBlock = await (async () => {
    if (injectedExpIds.length > 0) return '';
    return externalExperienceFallback(orch, 'architecture-design', orch._currentRequirement);
  })();

  // ── Plugin-driven adapter blocks ───────────────────────────────────────
  // All adapter context blocks are now collected via the AdapterPluginRegistry.
  // No hardcoded adapter calls — new adapters just register a plugin.
  const pluginRegistry = orch._pluginRegistry || (orch.services && orch.services.has('pluginRegistry') ? orch.services.resolve('pluginRegistry') : null);
  let pluginBlocks = [];
  if (pluginRegistry) {
    const pluginResult = await pluginRegistry.collectPluginBlocks(orch, 'ARCHITECT', _archProfile, 20);
    pluginBlocks = pluginResult.blocks;
    // P2 fix: Record Tool Search stats for observability
    if (orch.obs && typeof orch.obs.recordToolSearchStats === 'function') {
      orch.obs.recordToolSearchStats('ARCHITECT', {
        totalPlugins: pluginResult.blocks.length + (pluginResult.skippedByKeyword?.length || 0),
        skippedByKeyword: pluginResult.skippedByKeyword || [],
        executedCount: pluginResult.blocks.filter(b => b.content && b.content.length > 0).length,
      });
    }
  }

  // ── Recall Memory: cross-session task history ──────────────────────────
  let archRecallMemoryCtx = '';
  try {
    const taskHistory = _getArchTaskHistory();
    if (taskHistory) {
      archRecallMemoryCtx = taskHistory.getRecallBlock(5);
      if (archRecallMemoryCtx) {
        console.log(`[Orchestrator] 📖 Recall Memory injected for ArchitectAgent (${archRecallMemoryCtx.length} chars)`);
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Token Budget Guard ──────────────────────────────────────────────────
  // Core blocks (non-adapter, always present) + plugin blocks (dynamic adapter data)
  const labelledBlocks = [
    { label: 'JSON Instruction',    content: jsonInstruction,                                          priority: BLOCK_PRIORITY.JSON_INSTRUCTION, _order: 0 },
    { label: 'Tech Stack Prefix',   content: techStackPrefix ? techStackPrefix.trim() : '',            priority: BLOCK_PRIORITY.TECH_STACK_PREFIX, _order: 1 },
    { label: 'AGENTS.md',           content: agentsMd ? `## Project Context (AGENTS.md)\n${agentsMd}` : '', priority: BLOCK_PRIORITY.AGENTS_MD, _order: 2 },
    { label: 'Upstream Context',    content: upstreamCtx,                                              priority: BLOCK_PRIORITY.UPSTREAM_CTX, _order: 3 },
    { label: 'Experience',          content: expCtx,                                                   priority: BLOCK_PRIORITY.EXPERIENCE, _order: 4 },
    { label: 'External Experience', content: externalExpBlock,                                         priority: BLOCK_PRIORITY.EXTERNAL_EXPERIENCE, _order: 5 },
    { label: 'Complaints',          content: complaintBlock,                                           priority: BLOCK_PRIORITY.COMPLAINTS, _order: 6 },
    { label: 'Recall Memory',       content: archRecallMemoryCtx,                                      priority: BLOCK_PRIORITY.EXTERNAL_EXPERIENCE - 1, _order: 7 },
    // Dynamic adapter blocks from plugin registry (starts at _order: 20)
    ...pluginBlocks,
  ];

  // ── Smart Context: apply priority adjustments before budget guard ──────
  const adjustedBlocks = _archProfile ? _archProfile.applyToBlocks(labelledBlocks) : labelledBlocks;

  // Pass telemetry to _applyTokenBudget for lifecycle tracking
  const archTelemetry = orch._adapterTelemetry || null;
  const { assembled, stats } = _applyTokenBudget(adjustedBlocks, undefined, {
    telemetry: archTelemetry,
    stage: 'ARCHITECT',
  });
  if (stats.dropped.length > 0 || stats.truncated.length > 0) {
    console.log(`[Orchestrator] 📊 ARCHITECT token budget: ${stats.total} chars, dropped=[${stats.dropped.join(',')}], truncated=[${stats.truncated.join(',')}]`);
  }
  if (stats.compressionSaved > 0) {
    console.log(`[Orchestrator] 🗜️  ARCHITECT compression: saved ${stats.compressionSaved} chars.`);
  }
  // P1 fix: Record ToolResultFilter stats for cross-session analysis
  if (orch.obs && stats.preFilterSaved > 0) {
    orch.obs.recordToolResultFilterStats('ARCHITECT', {
      preFilterSaved: stats.preFilterSaved,
      filteredLabels: stats.preFilterLabels || [],
    });
  }

  // A-3 Architecture Fix: Return a proper struct instead of new String() hack.
  // Previously returned `new String(assembled)` with expando `._injectedExpIds`.
  // String objects break `typeof === 'string'` checks and `===` comparisons.
  // Now returns { content: string, injectedExpIds: string[] } — a clean contract.
  return { content: assembled, injectedExpIds };
}

module.exports = {
  buildArchitectUpstreamCtx,
  buildArchitectContextBlock,
};
