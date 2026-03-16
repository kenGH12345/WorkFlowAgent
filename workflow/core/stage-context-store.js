'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * StageContextStore – Cross-stage semantic context propagation.
 *
 * Problem it solves (Defect #9 – "Cross-stage Context missing"):
 *   Previously, agents only received a file path via FileRefBus.
 *   The meta object carried only numeric counters (reviewRounds, failedItems).
 *   Downstream agents had NO visibility into upstream decisions:
 *     - What tech stack did the architect choose?
 *     - Which modules did the developer change?
 *     - What risks did the analyst flag?
 *
 * This module provides a lightweight key-value store where each stage
 * deposits a structured summary of its key decisions. Downstream stages
 * read the accumulated summaries and inject them into their Agent prompts.
 *
 * Design principles:
 *   - Summaries are SHORT (≤600 chars each) to avoid token bloat
 *   - Summaries are STRUCTURED (key decisions, not raw content)
 *   - The store is IN-MEMORY per workflow run (no persistence needed)
 *   - Optionally persisted to output/stage-context.json for debugging
 */
class StageContextStore {
  constructor(opts = {}) {
    /** @type {Map<string, StageContext>} stageName → context */
    this._store = new Map();
    this._outputDir = opts.outputDir || null;
    this._verbose   = opts.verbose   ?? false;

    // Auto-load persisted context on construction so workflow resumption
    // (e.g. after a crash mid-CODE stage) can see ANALYSE + ARCHITECT summaries.
    if (this._outputDir) {
      this._load();
    }
  }

  // ─── Write ────────────────────────────────────────────────────────────────

  /**
   * Records the context summary for a completed stage.
   *
   * @param {string} stageName  - e.g. 'ANALYSE', 'ARCHITECT', 'CODE', 'TEST'
   * @param {object} context
   * @param {string}   context.summary       - Short human-readable summary (≤600 chars)
   * @param {string[]} [context.keyDecisions] - Bullet list of key decisions made
   * @param {string[]} [context.artifacts]    - Output file paths produced
   * @param {string[]} [context.risks]        - Risk notes recorded in this stage
   * @param {object}   [context.meta]         - Arbitrary structured metadata
   */
  set(stageName, context) {
    const entry = {
      stageName,
      summary:      (context.summary      || '').slice(0, 600),
      keyDecisions: context.keyDecisions  || [],
      artifacts:    context.artifacts     || [],
      risks:        context.risks         || [],
      meta:         context.meta          || {},
      timestamp:    new Date().toISOString(),
    };
    this._store.set(stageName, entry);

    if (this._verbose) {
      console.log(`[StageContextStore] Stored context for stage: ${stageName} (${entry.summary.length} chars)`);
    }

    // Persist to disk for debugging (non-blocking, best-effort)
    if (this._outputDir) {
      this._persist();
    }
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /**
   * Returns the context for a specific stage, or null if not found.
   * @param {string} stageName
   * @returns {StageContext|null}
   */
  get(stageName) {
    return this._store.get(stageName) || null;
  }

  /**
   * Returns all stored stage contexts as a formatted Markdown block.
   * Intended for injection into downstream Agent prompts.
   *
   * @param {string[]} [excludeStages] - Stage names to exclude (e.g. current stage)
   * @param {number}   [maxChars=2000] - Total character budget for the output
   * @returns {string} Markdown-formatted context block, or '' if empty
   */
  getAll(excludeStages = [], maxChars = 2000) {
    if (this._store.size === 0) return '';

    const lines = [
      `## 🔗 Cross-Stage Context (from upstream stages)`,
      `> The following summaries capture key decisions made in earlier stages.`,
      `> Use this context to ensure consistency and avoid contradicting upstream decisions.`,
      ``,
    ];

    let totalChars = lines.join('\n').length;
    // ── Defect D fix: use an explicit counter instead of lines.filter(###) ───
    // Previously: lines.filter(l => l.startsWith('###')).length was used to count
    // rendered stages, but sectionText is pushed as a single multi-line string
    // (not line-by-line), so filter() always returned 0 and the truncation notice
    // always showed store.size stages truncated instead of the actual remainder.
    // Now: we track rendered stages with a dedicated counter.
    let renderedStageCount = 0;

    for (const [stageName, ctx] of this._store) {
      if (excludeStages.includes(stageName)) continue;

      const sectionLines = [`### ${stageName} Stage`];

      if (ctx.summary) {
        sectionLines.push(ctx.summary);
      }

      if (ctx.keyDecisions && ctx.keyDecisions.length > 0) {
        sectionLines.push(`**Key Decisions:**`);
        ctx.keyDecisions.slice(0, 5).forEach(d => sectionLines.push(`- ${d}`));
      }

      if (ctx.risks && ctx.risks.length > 0) {
        sectionLines.push(`**Risks Flagged:**`);
        ctx.risks.slice(0, 3).forEach(r => sectionLines.push(`- ⚠️ ${r}`));
      }

      if (ctx.artifacts && ctx.artifacts.length > 0) {
        sectionLines.push(`**Artifacts:** ${ctx.artifacts.map(a => `\`${path.basename(a)}\``).join(', ')}`);
      }

      sectionLines.push('');
      const sectionText = sectionLines.join('\n');

      if (totalChars + sectionText.length > maxChars) {
        // Budget exceeded – add a truncation notice and stop
        const remaining = this._store.size - renderedStageCount;
        lines.push(`_... (${remaining} more stage(s) truncated due to token budget)_`);
        break;
      }

      lines.push(sectionText);
      totalChars += sectionText.length;
      renderedStageCount++;
    }

    const result = lines.join('\n');
    return result.length > 50 ? result : ''; // Don't return near-empty blocks
  }

  /**
   * Returns a compact single-line summary of all stages for logging.
   * @returns {string}
   */
  getLogLine() {
    if (this._store.size === 0) return '(no upstream context)';
    return [...this._store.keys()].map(s => {
      const ctx = this._store.get(s);
      return `${s}(${ctx.keyDecisions?.length ?? 0} decisions, ${ctx.risks?.length ?? 0} risks)`;
    }).join(' → ');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Extracts a structured context summary from a stage output file.
   * Uses simple heuristics (no LLM call) to keep it fast and free.
   *
   * ── Improvement #3 fix: full-document intelligent extraction ─────────────
   * Previously only scanned the first 1200 chars of the file. For long documents
   * (e.g. architecture.md with 500+ lines), the first 1200 chars are often just
   * the title and table of contents – the actual decisions are in the middle/end.
   * Now: scan the FULL document for heading+content pairs, and pick the most
   * informative paragraphs regardless of position.
   *
   * @param {string} filePath   - Path to the stage output file (e.g. architecture.md)
   * @param {string} stageName  - Stage name for labelling
   * @returns {{ summary: string, keyDecisions: string[] }}
   */
  static extractFromFile(filePath, stageName) {
    if (!fs.existsSync(filePath)) {
      return { summary: `${stageName} output not found.`, keyDecisions: [] };
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return { summary: `Could not read ${stageName} output.`, keyDecisions: [] };
    }

    // ── Key Decisions: extract CONTENT under decision-relevant headings ────────
    // Scan the FULL document (not just first 1200 chars) so decisions buried in
    // the middle or end of long architecture/requirements docs are captured.
    // Priority: headings that contain decision-signal keywords are ranked first.
    const DECISION_KEYWORDS = /tech|stack|architect|design|decision|approach|pattern|module|component|api|database|framework|language|choice|select|use|adopt|implement/i;

    const keyDecisions = [];
    const allDecisions = []; // { priority: number, text: string }

    // ── P1-4 fix: \Z is not a valid JS regex anchor (it's Python/Ruby syntax).
    // In JS, \Z is treated as a literal 'Z', so the last heading's content is
    // never captured (the regex fails to match to end-of-string).
    // Fix: use (?=^#{1,3}\s|$(?![\s\S])) – match until the next heading OR
    // the true end of string. Since JS multiline $ matches end-of-line (not
    // end-of-string), we use a lookahead that checks for either a heading line
    // OR the position where [\s\S] can no longer match (true end of input).
    const headingContentRegex = /^#{2,3}\s+(.+)$([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/gm;
    let hMatch;
    while ((hMatch = headingContentRegex.exec(content)) !== null) {
      const heading = hMatch[1].trim();
      const body = (hMatch[2] || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 10 && !l.startsWith('```') && !l.startsWith('|') && !l.startsWith('#'))
        .slice(0, 2)
        .join(' ');

      if (body.length > 15) {
        const text = `${heading}: ${body.slice(0, 150)}`;
        const priority = DECISION_KEYWORDS.test(heading) ? 0 : 1;
        allDecisions.push({ priority, text });
      } else if (heading.length > 3) {
        const priority = DECISION_KEYWORDS.test(heading) ? 1 : 2;
        allDecisions.push({ priority, text: heading });
      }
    }

    // Sort by priority (decision-signal headings first), then take top 6
    allDecisions.sort((a, b) => a.priority - b.priority);
    for (const d of allDecisions.slice(0, 6)) {
      keyDecisions.push(d.text);
    }

    // ── Summary: find the most informative paragraph in the document ──────────
    // Previously: always used the first paragraph (often just a title/intro).
    // Now: scan ALL paragraphs, score them by length and keyword density,
    // and pick the most informative one. Fall back to first paragraph if none found.
    const paragraphs = content
      .split(/\n{2,}/)
      .map(p => p.replace(/^#+\s+/, '').trim())
      .filter(p => p.length > 40 && !p.startsWith('```') && !p.startsWith('|') && !p.startsWith('-'));

    let bestParagraph = paragraphs[0] || '';
    let bestScore = 0;
    for (const p of paragraphs) {
      // Score: length (capped) + keyword density bonus
      const keywordMatches = (p.match(DECISION_KEYWORDS) || []).length;
      const score = Math.min(p.length, 300) + keywordMatches * 20;
      if (score > bestScore) {
        bestScore = score;
        bestParagraph = p;
      }
    }

    const summary = bestParagraph
      ? bestParagraph.slice(0, 500).replace(/\n/g, ' ')
      : `${stageName} stage completed.`;

    return { summary, keyDecisions };
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  _persist() {
    try {
      const data = {};
      for (const [k, v] of this._store) data[k] = v;
      const outPath = path.join(this._outputDir, 'stage-context.json');
      // Atomic write: write to .tmp first, then rename over the target.
      // This prevents a corrupt stage-context.json if the process crashes mid-write.
      // Consistent with StateMachine._writeManifest() and ExperienceStore._save().
      const tmpPath = outPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, outPath);
    } catch { /* non-fatal */ }
  }

  /**
   * Loads persisted stage context from stage-context.json.
   * Called automatically on construction to support workflow resumption:
   * if the workflow crashed mid-CODE stage, the ANALYSE + ARCHITECT contexts
   * are restored so downstream agents still see the full upstream history.
   *
   * Only loads entries that are NOT already in the in-memory store
   * (in-memory always wins over persisted data).
   */
  _load() {
    try {
      const outPath = path.join(this._outputDir, 'stage-context.json');
      if (!fs.existsSync(outPath)) return;
      const raw = fs.readFileSync(outPath, 'utf-8');
      const data = JSON.parse(raw);
      let loaded = 0;
      for (const [stageName, entry] of Object.entries(data)) {
        if (!this._store.has(stageName)) {
          this._store.set(stageName, entry);
          loaded++;
        }
      }
      if (loaded > 0 && this._verbose) {
        console.log(`[StageContextStore] Restored ${loaded} stage context(s) from stage-context.json (workflow resumption).`);
      }
    } catch { /* non-fatal – missing or corrupt file is fine */ }
  }
}

module.exports = { StageContextStore };
