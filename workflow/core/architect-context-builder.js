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
  return ctx;
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
  }

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

  // R2-3 audit: _applyTokenBudget returns a primitive string, which cannot hold
  // expando properties (block._injectedExpIds would silently fail in strict mode).
  // Wrap in a String object so downstream consumers can read ._injectedExpIds.
  // String objects are coerced to primitives when used as strings (concatenation,
  // template literals, agent.run() input), so this is transparent to all consumers.
  const block = new String(assembled);
  block._injectedExpIds = injectedExpIds;
  return block;
}

module.exports = {
  buildArchitectUpstreamCtx,
  buildArchitectContextBlock,
};
