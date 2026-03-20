/**
 * Adapter Telemetry — Data-driven adapter lifecycle tracking.
 *
 * Tracks per-block lifecycle events across all workflow stages:
 *   - INJECTED: block was assembled and passed to token budget guard
 *   - COMPRESSED: block was compressed by BlockCompressor (chars saved)
 *   - TRUNCATED: block was partially cut by _applyTokenBudget
 *   - DROPPED: block was entirely removed by _applyTokenBudget
 *   - REFERENCED: LLM output referenced the block (heuristic scan)
 *
 * Lifecycle: Orchestrator creates one AdapterTelemetry per run.
 * Context builders call recordInjection() for each block.
 * _applyTokenBudget() calls recordTruncation() / recordDrop().
 * Post-LLM call, scanReferences() detects which blocks were actually used.
 *
 * After the run, getReport() produces a summary. Blocks with low ROI
 * (high drop/truncate rate, low reference rate) are flagged for demotion.
 *
 * Design: zero side-effects, pure in-memory accumulation, JSON-serialisable.
 */

'use strict';

// ─── Block Lifecycle Events ──────────────────────────────────────────────────

/**
 * @typedef {Object} BlockEvent
 * @property {string} label      - Block label (e.g. 'Security CVE')
 * @property {string} stage      - Stage name (ARCHITECT / DEVELOPER / TESTER)
 * @property {string} event      - Event type: injected | compressed | truncated | dropped | referenced
 * @property {number} chars      - Character count at event time
 * @property {number} [savedChars] - Characters saved (for compressed/truncated events)
 * @property {number} ts         - Timestamp (ms)
 */

// ─── Reference Detection Patterns ───────────────────────────────────────────

/**
 * Heuristic patterns to detect whether the LLM output actually referenced
 * or used data from a specific context block. Each block label maps to
 * a set of regex patterns that indicate the LLM consumed that block.
 */
const REFERENCE_PATTERNS = {
  'Security CVE': [
    /CVE-\d{4}-\d+/i,
    /vulnerabilit(?:y|ies)/i,
    /security\s+(?:scan|audit|advisory)/i,
    /(?:CRITICAL|HIGH)\s+severity/i,
    /OSV\.dev/i,
  ],
  'Package Registry': [
    /deprecated.*package/i,
    /outdated.*dependency/i,
    /upgrade.*(?:to|from)\s+v?\d/i,
    /package.*version/i,
    /dependency.*update/i,
  ],
  'Code Quality': [
    /code\s*smell/i,
    /cyclomatic\s+complexity/i,
    /cognitive\s+complexity/i,
    /quality\s+gate/i,
    /code\s+duplication/i,
    /SonarQube/i,
  ],
  'CI Status': [
    /CI\s+(?:pipeline|build|status)/i,
    /(?:GitHub\s+Actions|Jenkins|GitLab\s+CI)/i,
    /build\s+(?:passed|failed|broken)/i,
    /pipeline\s+(?:status|result)/i,
  ],
  'License Compliance': [
    /license\s+(?:compliance|risk|issue)/i,
    /(?:GPL|AGPL|LGPL|MIT|Apache|BSD)\s+license/i,
    /(?:high|medium)\s*-?\s*risk\s+license/i,
    /copyleft/i,
  ],
  'Figma Design': [
    /design\s+(?:token|spec|system)/i,
    /(?:color|typography|spacing)\s+(?:palette|scale|system)/i,
    /component\s+(?:tree|hierarchy|spec)/i,
    /Figma/i,
  ],
  'Industry Research': [
    /(?:industry|market)\s+research/i,
    /alternative\s+solution/i,
    /open\s+source\s+(?:solution|library|framework)/i,
    /web\s+(?:search|research)\s+result/i,
  ],
  'API Research': [
    /API\s+(?:change|update|migration|deprecat)/i,
    /latest\s+(?:API|version|release)/i,
    /breaking\s+change/i,
  ],
  'Test Best Practices': [
    /testing\s+best\s+practice/i,
    /test\s+(?:pattern|strategy|coverage)/i,
    /(?:unit|integration|e2e)\s+test/i,
  ],
  'Undocumented Exports': [
    /undocumented\s+export/i,
    /missing\s+(?:documentation|JSDoc|docstring)/i,
    /export.*documentation/i,
  ],
  'Test Infra': [
    /(?:flaky|unstable)\s+test/i,
    /coverage\s+(?:report|trend|regression)/i,
    /performance\s+regression/i,
  ],
  'External Experience': [
    /external\s+experience/i,
    /cold[\s-]*start\s+fallback/i,
    /community\s+(?:best\s+practice|pitfall)/i,
  ],
};

class AdapterTelemetry {
  constructor() {
    /** @type {BlockEvent[]} */
    this._events = [];

    /** @type {Map<string, Map<string, {injected:number, injectedChars:number, compressed:number, savedChars:number, truncated:number, truncatedChars:number, dropped:number, referenced:number}>>} */
    this._blockStats = new Map(); // label -> stage -> stats
  }

  // ─── Event Recording ──────────────────────────────────────────────────────

  /**
   * Records that a block was injected into the context.
   * @param {string} label - Block label
   * @param {string} stage - Stage name
   * @param {number} chars - Character count
   */
  recordInjection(label, stage, chars) {
    if (!chars || chars <= 0) return; // Skip empty blocks
    this._events.push({ label, stage, event: 'injected', chars, ts: Date.now() });
    this._ensureStats(label, stage).injected++;
    this._ensureStats(label, stage).injectedChars += chars;
  }

  /**
   * Records that a block was compressed.
   * @param {string} label - Block label
   * @param {string} stage - Stage name
   * @param {number} originalChars - Original size
   * @param {number} compressedChars - Compressed size
   */
  recordCompression(label, stage, originalChars, compressedChars) {
    const saved = originalChars - compressedChars;
    this._events.push({ label, stage, event: 'compressed', chars: compressedChars, savedChars: saved, ts: Date.now() });
    this._ensureStats(label, stage).compressed++;
    this._ensureStats(label, stage).savedChars += saved;
  }

  /**
   * Records that a block was truncated by the token budget.
   * @param {string} label - Block label
   * @param {string} stage - Stage name
   * @param {number} removedChars - Characters removed
   */
  recordTruncation(label, stage, removedChars) {
    this._events.push({ label, stage, event: 'truncated', chars: removedChars, ts: Date.now() });
    this._ensureStats(label, stage).truncated++;
    this._ensureStats(label, stage).truncatedChars += removedChars;
  }

  /**
   * Records that a block was entirely dropped by the token budget.
   * @param {string} label - Block label
   * @param {string} stage - Stage name
   */
  recordDrop(label, stage) {
    this._events.push({ label, stage, event: 'dropped', chars: 0, ts: Date.now() });
    this._ensureStats(label, stage).dropped++;
  }

  /**
   * Records that a block was referenced in the LLM output.
   * @param {string} label - Block label
   * @param {string} stage - Stage name
   */
  recordReference(label, stage) {
    this._events.push({ label, stage, event: 'referenced', chars: 0, ts: Date.now() });
    this._ensureStats(label, stage).referenced++;
  }

  // ─── Reference Scanning ───────────────────────────────────────────────────

  /**
   * Scans the LLM output text for references to injected blocks.
   * Uses heuristic pattern matching to detect whether the LLM actually
   * consumed/referenced data from each block.
   *
   * @param {string} llmOutput - The raw LLM response text
   * @param {string} stage - Stage name (ARCHITECT / DEVELOPER / TESTER)
   * @param {string[]} [injectedLabels] - Labels of blocks that were injected
   * @returns {string[]} Labels of blocks that were referenced
   */
  scanReferences(llmOutput, stage, injectedLabels = []) {
    if (!llmOutput || llmOutput.length === 0) return [];

    const referenced = [];
    const labelsToCheck = injectedLabels.length > 0
      ? injectedLabels
      : Object.keys(REFERENCE_PATTERNS);

    for (const label of labelsToCheck) {
      const patterns = REFERENCE_PATTERNS[label];
      if (!patterns) continue;

      const isReferenced = patterns.some(pattern => pattern.test(llmOutput));
      if (isReferenced) {
        this.recordReference(label, stage);
        referenced.push(label);
      }
    }

    if (referenced.length > 0) {
      console.log(`[Telemetry] 📊 ${stage}: LLM referenced ${referenced.length} block(s): ${referenced.join(', ')}`);
    }

    return referenced;
  }

  // ─── Reporting ────────────────────────────────────────────────────────────

  /**
   * Generates a comprehensive telemetry report.
   *
   * @returns {{
   *   blocks: Array<{label:string, stage:string, injected:number, injectedChars:number, compressed:number, savedChars:number, truncated:number, truncatedChars:number, dropped:number, referenced:number, roi:number, recommendation:string}>,
   *   summary: {totalBlocks:number, totalInjectedChars:number, totalSavedByCompression:number, totalDropped:number, totalTruncated:number, totalReferenced:number, avgRoi:number},
   *   recommendations: string[]
   * }}
   */
  getReport() {
    const blocks = [];
    const recommendations = [];

    let totalInjectedChars = 0;
    let totalSaved = 0;
    let totalDropped = 0;
    let totalTruncated = 0;
    let totalReferenced = 0;
    let roiSum = 0;

    for (const [label, stageMap] of this._blockStats) {
      for (const [stage, stats] of stageMap) {
        // ROI formula: referenced / injected (higher = more valuable)
        // If injected is 0, ROI is 0 (block was never injected)
        const roi = stats.injected > 0
          ? Math.round((stats.referenced / stats.injected) * 100)
          : 0;

        const recommendation = this._deriveRecommendation(label, stats, roi);

        blocks.push({
          label,
          stage,
          ...stats,
          roi,
          recommendation,
        });

        totalInjectedChars += stats.injectedChars;
        totalSaved += stats.savedChars;
        totalDropped += stats.dropped;
        totalTruncated += stats.truncated;
        totalReferenced += stats.referenced;
        roiSum += roi;

        if (recommendation !== 'keep') {
          recommendations.push(`[${stage}] ${label}: ${recommendation} (ROI=${roi}%, dropped=${stats.dropped}, truncated=${stats.truncated})`);
        }
      }
    }

    const totalBlocks = blocks.length;
    const avgRoi = totalBlocks > 0 ? Math.round(roiSum / totalBlocks) : 0;

    return {
      blocks,
      summary: {
        totalBlocks,
        totalInjectedChars,
        totalSavedByCompression: totalSaved,
        totalDropped,
        totalTruncated,
        totalReferenced,
        avgRoi,
      },
      recommendations,
    };
  }

  /**
   * Returns a compact JSON-serialisable snapshot for observability.
   * @returns {object}
   */
  toJSON() {
    const report = this.getReport();
    return {
      blocks: report.blocks,
      summary: report.summary,
      recommendations: report.recommendations,
    };
  }

  // ─── Priority Adjustment Suggestions ──────────────────────────────────────

  /**
   * Based on accumulated telemetry, suggests priority adjustments for blocks.
   * Low-ROI blocks get demoted; high-ROI frequently-truncated blocks get promoted.
   *
   * @returns {Map<string, number>} label -> suggested priority delta
   */
  suggestPriorityAdjustments() {
    const adjustments = new Map();

    for (const [label, stageMap] of this._blockStats) {
      let totalInjected = 0;
      let totalDropped = 0;
      let totalTruncated = 0;
      let totalReferenced = 0;

      for (const stats of stageMap.values()) {
        totalInjected += stats.injected;
        totalDropped += stats.dropped;
        totalTruncated += stats.truncated;
        totalReferenced += stats.referenced;
      }

      if (totalInjected === 0) continue;

      const refRate = totalReferenced / totalInjected;
      const dropRate = totalDropped / totalInjected;

      // High drop rate + low reference rate → demote
      if (dropRate > 0.5 && refRate < 0.2) {
        adjustments.set(label, -10);
      }
      // High reference rate but frequently truncated → promote
      else if (refRate > 0.7 && totalTruncated > 0) {
        adjustments.set(label, +5);
      }
      // Never referenced → slight demotion
      else if (totalReferenced === 0 && totalInjected >= 2) {
        adjustments.set(label, -5);
      }
    }

    return adjustments;
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  /** @private */
  _ensureStats(label, stage) {
    if (!this._blockStats.has(label)) {
      this._blockStats.set(label, new Map());
    }
    const stageMap = this._blockStats.get(label);
    if (!stageMap.has(stage)) {
      stageMap.set(stage, {
        injected: 0,
        injectedChars: 0,
        compressed: 0,
        savedChars: 0,
        truncated: 0,
        truncatedChars: 0,
        dropped: 0,
        referenced: 0,
      });
    }
    return stageMap.get(stage);
  }

  /** @private */
  _deriveRecommendation(label, stats, roi) {
    // Always keep critical blocks
    const criticalBlocks = ['JSON Instruction', 'Tech Stack Prefix', 'AGENTS.md', 'Upstream Context', 'Experience', 'Complaints'];
    if (criticalBlocks.includes(label)) return 'keep';

    // Dropped every time → consider removing
    if (stats.injected > 0 && stats.dropped === stats.injected) {
      return 'remove — always dropped by token budget';
    }

    // Dropped > 50% of the time + never referenced → demote
    if (stats.injected >= 2 && stats.dropped / stats.injected > 0.5 && stats.referenced === 0) {
      return 'demote — high drop rate, never referenced by LLM';
    }

    // Never referenced after multiple injections → monitor
    if (stats.injected >= 3 && stats.referenced === 0) {
      return 'monitor — injected 3+ times but never referenced';
    }

    // Low ROI → consider demotion
    if (roi < 20 && stats.injected >= 2) {
      return 'demote — ROI below 20% threshold';
    }

    return 'keep';
  }
}

module.exports = { AdapterTelemetry, REFERENCE_PATTERNS };
