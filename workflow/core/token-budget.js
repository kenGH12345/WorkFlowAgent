/**
 * Context Budget Manager
 *
 * Extracted from orchestrator-stage-helpers.js to decompose the 1,800+ line
 * monolith into testable, focused modules (each < 400 lines).
 *
 * This module owns:
 *   - Token budget constants and priority-based truncation algorithm
 *   - Web search cache, helpers, and formatters
 *   - External experience fallback (cold-start enhancement)
 *   - All MCP adapter helper functions (package registry, security CVE,
 *     CI status, license compliance, doc gen, LLM cost router, Figma design,
 *     test infra, code quality)
 *
 * All functions receive `orch` (the Orchestrator instance) as first arg
 * to access services, projectRoot, etc. without `this`-binding gymnastics.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { BlockCompressor } = require('./block-compressor');

// Singleton compressor instance (stateless, safe to share)
const _compressor = new BlockCompressor();

// ─── Token Budget Guard ──────────────────────────────────────────────────────

/**
 * Per-stage context window budget (in characters).
 *
 * Rationale: Most LLMs accept 128k–200k tokens. 1 token ≈ 4 chars (English) or
 * ≈ 2 chars (Chinese). We reserve ~30% for the model's own generation, leaving
 * ~90k tokens ≈ 360k chars for input. But upstream context (system prompt +
 * agent instructions + code files) already occupies ~40-60% of the budget.
 * So the *injected enrichment blocks* (web search, security, packages, quality,
 * experience) should stay within ~60k chars per stage.
 *
 * Each block has a priority. When the total exceeds the budget, lower-priority
 * blocks are truncated first (down to their minimum useful size), then dropped
 * entirely if still over.
 */
const STAGE_TOKEN_BUDGET_CHARS = 60000; // ~15k tokens – safe margin for enrichment blocks

/**
 * Priority levels for context blocks (higher = more important, kept longer).
 */
const BLOCK_PRIORITY = {
  // Critical – always kept
  JSON_INSTRUCTION: 100,
  TECH_STACK_PREFIX: 95,
  AGENTS_MD: 90,
  UPSTREAM_CTX: 85,
  EXPERIENCE: 80,
  COMPLAINTS: 75,
  // High – important enrichment
  CODE_GRAPH: 70,
  SECURITY_CVE: 65,
  CI_STATUS: 63,
  CODE_QUALITY: 60,
  LICENSE_COMPLIANCE: 58,
  LLM_COST: 57,
  // Medium – valuable but expendable under pressure
  PACKAGE_REGISTRY: 55,
  API_RESEARCH: 50,
  INDUSTRY_RESEARCH: 50,
  TEST_BEST_PRACTICES: 50,
  REAL_EXECUTION: 70,
  UNDOCUMENTED_EXPORTS: 45,
  TEST_INFRA: 43,
  // Medium-low – UI-specific enrichment
  FIGMA_DESIGN: 52,
  // Low – nice-to-have fallbacks
  EXTERNAL_EXPERIENCE: 30,
};

/**
 * Applies a token budget to an array of labelled context blocks.
 * Blocks are sorted by priority; lower-priority blocks are truncated/dropped
 * first when the total exceeds the budget.
 *
 * @param {Array<{label: string, content: string, priority: number}>} blocks
 * @param {number} [budget=STAGE_TOKEN_BUDGET_CHARS]
 * @returns {{ assembled: string, stats: {total: number, dropped: string[], truncated: string[]} }}
 */
function _applyTokenBudget(blocks, budget = STAGE_TOKEN_BUDGET_CHARS, opts = {}) {
  const { telemetry = null, stage = 'UNKNOWN' } = opts;

  // Filter out empty blocks
  const active = blocks.filter(b => b.content && b.content.length > 0);

  // ── Phase 0: Block Compression ─────────────────────────────────────────
  // Compress verbose adapter blocks (Markdown tables → JSON shorthand)
  // BEFORE checking the budget. This maximises information density.
  const { totalSaved: compressionSaved, compressedLabels } = _compressor.compressBlocks(active);

  // ── Phase 0.5: Tool Result Pre-filtering (P1 Programmatic Tool Calling) ──
  // Inspired by Claude's "Programmatic Tool Calling" pattern: large adapter
  // result blocks are pre-filtered BEFORE entering the budget pipeline.
  // This prevents bloated tool results from consuming the entire token budget
  // and forces information extraction at the source.
  const _toolResultFilter = new ToolResultFilter();
  const { totalSaved: preFilterSaved, filteredLabels: preFilterLabels } = _toolResultFilter.applyToBlocks(active);

  // Record compression telemetry
  if (telemetry && compressedLabels.length > 0) {
    for (const cl of compressedLabels) {
      const match = cl.match(/^(.+?)\(-\d+\)$/);
      if (match) {
        const label = match[0].replace(/\(-\d+\)$/, '');
        const saved = parseInt(cl.match(/-(\d+)/)[1], 10);
        const block = active.find(b => b.label === label);
        if (block) {
          telemetry.recordCompression(label, stage, block.content.length + saved, block.content.length);
        }
      }
    }
  }

  // Record all injections (non-empty blocks that survived filtering)
  if (telemetry) {
    for (const b of active) {
      telemetry.recordInjection(b.label, stage, b.content.length);
    }
  }

  const totalBefore = active.reduce((sum, b) => sum + b.content.length, 0);

  if (totalBefore <= budget) {
    // Under budget – no truncation needed
    return {
      assembled: active.map(b => b.content).join('\n\n'),
      stats: { total: totalBefore, dropped: [], truncated: [], compressionSaved, preFilterSaved },
    };
  }

  console.warn(`[TokenBudget] ⚠️  Context blocks total ${totalBefore} chars (budget: ${budget}). Applying priority-based truncation.`);

  // Sort by priority descending (highest priority first)
  const sorted = [...active].sort((a, b) => b.priority - a.priority);

  // Minimum useful size per block (headers + first few lines)
  const MIN_BLOCK_SIZE = 200;

  // Phase 1: Try truncating lower-priority blocks to min size
  let currentTotal = totalBefore;
  const truncated = [];
  const dropped = [];

  // Work from lowest priority upward
  for (let i = sorted.length - 1; i >= 0 && currentTotal > budget; i--) {
    const block = sorted[i];
    if (block.content.length <= MIN_BLOCK_SIZE) continue;

    const excess = currentTotal - budget;
    const canTrim = block.content.length - MIN_BLOCK_SIZE;
    const trimAmount = Math.min(excess, canTrim);

    if (trimAmount > 0) {
      // R4-1/R4-2 audit: capture original length BEFORE mutation for accurate logging
      // and correct currentTotal tracking.
      const originalLen = block.content.length;
      const newLen = originalLen - trimAmount;
      // Truncate at a natural boundary (newline)
      const truncateAt = block.content.lastIndexOf('\n', newLen);
      const cutPoint = truncateAt > MIN_BLOCK_SIZE ? truncateAt : newLen;
      const truncSuffix = `\n\n> ⚠️ _[Truncated: ${block.label} reduced from ${originalLen} to ${cutPoint} chars due to token budget]_`;
      block.content = block.content.slice(0, cutPoint) + truncSuffix;
      // R4-2 audit: track actual delta (including truncation suffix) to keep currentTotal accurate.
      // Without this, Phase 2 would use stale block.content.length values.
      const actualDelta = originalLen - block.content.length;
      currentTotal -= actualDelta;
      truncated.push(`${block.label}(-${actualDelta})`);

      // Record truncation telemetry
      if (telemetry) {
        telemetry.recordTruncation(block.label, stage, trimAmount);
      }
    }
  }

  // Phase 2: Drop lowest-priority blocks entirely if still over
  for (let i = sorted.length - 1; i >= 0 && currentTotal > budget; i--) {
    const block = sorted[i];
    if (block.content.length === 0) continue;
    currentTotal -= block.content.length;
    dropped.push(block.label);
    block.content = '';

    // Record drop telemetry
    if (telemetry) {
      telemetry.recordDrop(block.label, stage);
    }
  }

  if (dropped.length > 0) {
    console.warn(`[TokenBudget] 🗑️  Dropped blocks: ${dropped.join(', ')}`);
  }
  if (truncated.length > 0) {
    console.warn(`[TokenBudget] ✂️  Truncated blocks: ${truncated.join(', ')}`);
  }
  console.log(`[TokenBudget] Final context size: ${currentTotal} chars (was ${totalBefore}, saved ${totalBefore - currentTotal}).`);
  if (compressionSaved > 0) {
    console.log(`[TokenBudget] 🗜️  Pre-compression saved additional ${compressionSaved} chars.`);
  }
  if (preFilterSaved > 0) {
    console.log(`[TokenBudget] 🔍 Pre-filtering (Programmatic Tool Calling) saved ${preFilterSaved} chars across [${preFilterLabels.join(', ')}].`);
  }

  // Re-sort back to original insertion order for coherent reading
  // R5-4 audit: added trim() guard to prevent whitespace-only blocks from passing filter
  const assembled = sorted
    .filter(b => b.content && b.content.trim().length > 0)
    .sort((a, b) => a._order - b._order)
    .map(b => b.content)
    .join('\n\n');

  return {
    assembled,
    stats: { total: currentTotal, dropped, truncated, compressionSaved, preFilterSaved },
  };
}


// ─── P1 Optimisation: Tool Result Filter (Programmatic Tool Calling) ─────────
//
// Inspired by Claude's "Programmatic Tool Calling" pattern: instead of letting
// the LLM see raw, unfiltered tool results (e.g. a 500-line file dumped into
// context), we pre-filter / summarise / compress the results before they enter
// the token budget pipeline.
//
// This acts as a **front-gate** filter — applied BEFORE blocks reach
// _applyTokenBudget(). The budget manager handles priority-based truncation
// for blocks that ARE included; ToolResultFilter prevents bloated content
// from ever reaching that stage.
//
// Key strategies:
//   1. Large text truncation: content > threshold is trimmed with head/tail preview
//   2. Repetitive line dedup: adjacent similar lines are collapsed
//   3. Relevance grep: if a relevance pattern is provided, only matching lines + context are kept
//   4. Structured data extraction: JSON/YAML blocks are summarised to keys/stats

/**
 * ToolResultFilter — pre-filters adapter/tool result blocks to reduce token waste.
 *
 * Usage:
 *   const filter = new ToolResultFilter({ maxBlockChars: 8000 });
 *   const filteredContent = filter.apply(rawContent, { grepPattern: /error|warn/i });
 */
class ToolResultFilter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxBlockChars=8000]     - Max chars per block after filtering
   * @param {number} [opts.headLines=40]            - Lines to keep from the start
   * @param {number} [opts.tailLines=20]            - Lines to keep from the end
   * @param {number} [opts.grepContextLines=3]      - Lines of context around grep matches
   * @param {number} [opts.dedupeThreshold=0.85]    - Similarity threshold for dedup (0-1)
   */
  constructor(opts = {}) {
    this.maxBlockChars = opts.maxBlockChars ?? 8000;
    this.headLines = opts.headLines ?? 40;
    this.tailLines = opts.tailLines ?? 20;
    this.grepContextLines = opts.grepContextLines ?? 3;
    this.dedupeThreshold = opts.dedupeThreshold ?? 0.85;
  }

  /**
   * Applies filtering strategies to a raw content block.
   *
   * @param {string} content - Raw content from adapter/tool
   * @param {object} [opts]
   * @param {RegExp} [opts.grepPattern] - If provided, only lines matching this pattern are kept
   * @param {string} [opts.label]       - Block label for logging
   * @returns {{ content: string, stats: { originalChars: number, filteredChars: number, strategy: string } }}
   */
  apply(content, opts = {}) {
    if (!content || typeof content !== 'string') {
      return { content: '', stats: { originalChars: 0, filteredChars: 0, strategy: 'empty' } };
    }

    const originalChars = content.length;

    // Fast path: content is within budget — no filtering needed
    if (originalChars <= this.maxBlockChars) {
      return { content, stats: { originalChars, filteredChars: originalChars, strategy: 'passthrough' } };
    }

    const label = opts.label || 'unknown';
    let result = content;
    let strategy = '';

    // Strategy 1: Relevance grep — if a pattern is provided, extract matching lines + context
    if (opts.grepPattern) {
      const grepResult = this._grepFilter(result, opts.grepPattern);
      if (grepResult.matchCount > 0) {
        result = grepResult.content;
        strategy = `grep(${grepResult.matchCount} matches)`;
        if (result.length <= this.maxBlockChars) {
          console.log(`[ToolResultFilter] 🔍 ${label}: ${originalChars} → ${result.length} chars (${strategy})`);
          return { content: result, stats: { originalChars, filteredChars: result.length, strategy } };
        }
      }
    }

    // Strategy 2: Dedup adjacent similar lines
    const dedupResult = this._deduplicateLines(result);
    if (dedupResult.removedCount > 0) {
      result = dedupResult.content;
      strategy += (strategy ? ' + ' : '') + `dedup(${dedupResult.removedCount} lines)`;
      if (result.length <= this.maxBlockChars) {
        console.log(`[ToolResultFilter] 🔁 ${label}: ${originalChars} → ${result.length} chars (${strategy})`);
        return { content: result, stats: { originalChars, filteredChars: result.length, strategy } };
      }
    }

    // Strategy 3: Head/tail truncation with middle summary
    const truncResult = this._headTailTruncate(result);
    result = truncResult.content;
    strategy += (strategy ? ' + ' : '') + `truncate(head=${this.headLines}+tail=${this.tailLines})`;

    console.log(`[ToolResultFilter] ✂️  ${label}: ${originalChars} → ${result.length} chars (${strategy})`);
    return { content: result, stats: { originalChars, filteredChars: result.length, strategy } };
  }

  /**
   * Batch-apply filtering to an array of labelled blocks.
   * Modifies blocks in-place for efficiency.
   *
   * @param {Array<{label: string, content: string, priority: number}>} blocks
   * @param {object} [opts]
   * @param {RegExp} [opts.grepPattern] - Global grep pattern for all blocks
   * @returns {{ totalSaved: number, filteredLabels: string[] }}
   */
  applyToBlocks(blocks, opts = {}) {
    let totalSaved = 0;
    const filteredLabels = [];

    for (const block of blocks) {
      if (!block.content || block.content.length <= this.maxBlockChars) continue;

      const { content, stats } = this.apply(block.content, {
        label: block.label,
        grepPattern: opts.grepPattern,
      });

      const saved = stats.originalChars - stats.filteredChars;
      if (saved > 0) {
        block.content = content;
        totalSaved += saved;
        filteredLabels.push(`${block.label}(-${saved})`);
      }
    }

    if (filteredLabels.length > 0) {
      console.log(`[ToolResultFilter] 📊 Batch filter: saved ${totalSaved} chars across ${filteredLabels.length} block(s): [${filteredLabels.join(', ')}]`);
    }

    return { totalSaved, filteredLabels };
  }

  /**
   * Grep filter: extracts matching lines with surrounding context.
   * @param {string} content
   * @param {RegExp} pattern
   * @returns {{ content: string, matchCount: number }}
   */
  _grepFilter(content, pattern) {
    const lines = content.split('\n');
    const matchIndices = new Set();
    let matchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        matchCount++;
        // Add context lines around the match
        for (let j = Math.max(0, i - this.grepContextLines); j <= Math.min(lines.length - 1, i + this.grepContextLines); j++) {
          matchIndices.add(j);
        }
      }
    }

    if (matchCount === 0) return { content, matchCount: 0 };

    const resultLines = [];
    let lastIdx = -2;
    for (const idx of [...matchIndices].sort((a, b) => a - b)) {
      if (idx > lastIdx + 1) {
        resultLines.push(`  ... (${idx - lastIdx - 1} lines omitted) ...`);
      }
      resultLines.push(lines[idx]);
      lastIdx = idx;
    }

    if (lastIdx < lines.length - 1) {
      resultLines.push(`  ... (${lines.length - 1 - lastIdx} lines omitted) ...`);
    }

    return { content: resultLines.join('\n'), matchCount };
  }

  /**
   * Deduplicates adjacent similar lines (e.g. repeated log entries, table rows).
   * @param {string} content
   * @returns {{ content: string, removedCount: number }}
   */
  _deduplicateLines(content) {
    const lines = content.split('\n');
    if (lines.length < 5) return { content, removedCount: 0 };

    const resultLines = [];
    let removedCount = 0;
    let consecutiveDupes = 0;
    let prevNormalized = '';

    for (let i = 0; i < lines.length; i++) {
      // Normalize: strip leading whitespace, numbers, timestamps for comparison
      const normalized = lines[i].replace(/^\s+/, '').replace(/\d+/g, 'N').replace(/\s+/g, ' ');

      if (normalized === prevNormalized && normalized.length > 10) {
        consecutiveDupes++;
        removedCount++;
      } else {
        if (consecutiveDupes > 0) {
          resultLines.push(`  ... (${consecutiveDupes} similar line(s) collapsed) ...`);
          consecutiveDupes = 0;
        }
        resultLines.push(lines[i]);
      }
      prevNormalized = normalized;
    }

    if (consecutiveDupes > 0) {
      resultLines.push(`  ... (${consecutiveDupes} similar line(s) collapsed) ...`);
    }

    return { content: resultLines.join('\n'), removedCount };
  }

  /**
   * Head/tail truncation: keeps first N lines + last M lines, summarises middle.
   * @param {string} content
   * @returns {{ content: string }}
   */
  _headTailTruncate(content) {
    const lines = content.split('\n');
    if (lines.length <= this.headLines + this.tailLines + 5) {
      // Not enough lines to warrant truncation — just char-truncate
      return { content: content.slice(0, this.maxBlockChars) + '\n... [truncated]' };
    }

    const head = lines.slice(0, this.headLines);
    const tail = lines.slice(-this.tailLines);
    const omitted = lines.length - this.headLines - this.tailLines;

    return {
      content: [
        ...head,
        ``,
        `--- ✂️  ${omitted} lines omitted (${omitted} of ${lines.length} total) ---`,
        ``,
        ...tail,
      ].join('\n'),
    };
  }
}


module.exports = {
  STAGE_TOKEN_BUDGET_CHARS,
  BLOCK_PRIORITY,
  _applyTokenBudget,
  ToolResultFilter,
};
