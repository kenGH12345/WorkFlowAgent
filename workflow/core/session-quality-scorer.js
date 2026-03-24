/**
 * Session Quality Scorer – Evaluate session output quality for experience capture
 *
 * ADR-43: Session Quality Scoring
 *
 * Reuses KnowledgePipeline's EVALUATE stage to score session outputs.
 * This provides a quality gate before capturing experiences from sessions.
 *
 * Quality Dimensions:
 *   1. Actionability – Can the output be directly applied?
 *   2. Specificity – Is the output concrete and specific?
 *   3. Novelty – Does the output contain new knowledge?
 *   4. Relevance – Is the output relevant to the project?
 *
 * Design Principles:
 *   - Reuses existing KnowledgePipeline.evaluate() logic
 *   - No additional LLM calls for scoring (uses heuristics)
 *   - Integrates with SessionSignalDetector for combined decision
 *
 * @module workflow/core/session-quality-scorer
 */

'use strict';

// ─── Quality Dimensions ────────────────────────────────────────────────────

const QualityDimension = {
  ACTIONABILITY: 'actionability',
  SPECIFICITY: 'specificity',
  NOVELTY: 'novelty',
  RELEVANCE: 'relevance',
};

// ─── Session Quality Scorer Class ──────────────────────────────────────────

class SessionQualityScorer {
  /**
   * @param {object} opts
   * @param {object} [opts.experienceStore] - ExperienceStore for novelty check
   * @param {boolean} [opts.verbose=false]
   */
  constructor(opts = {}) {
    this._expStore = opts.experienceStore || null;
    this._verbose = opts.verbose || false;
  }

  /**
   * Score a session's output quality.
   * Uses heuristics similar to KnowledgePipeline.evaluate().
   *
   * @param {object} sessionOutput
   * @param {string} [sessionOutput.artifactContent] - Main artifact content (e.g. architecture.md)
   * @param {string} [sessionOutput.decisionLog] - Decision trail content
   * @param {string} [sessionOutput.errorLog] - Error messages from session
   * @param {object} [sessionOutput.stats] - Session statistics
   * @returns {{ score: number, dimensions: object, passed: boolean }}
   */
  score(sessionOutput = {}) {
    const dimensions = {
      [QualityDimension.ACTIONABILITY]: 0,
      [QualityDimension.SPECIFICITY]: 0,
      [QualityDimension.NOVELTY]: 0,
      [QualityDimension.RELEVANCE]: 0,
    };

    const content = [
      sessionOutput.artifactContent || '',
      sessionOutput.decisionLog || '',
    ].join('\n');

    // ── Actionability: presence of actionable keywords ─────────────────────
    const actionablePatterns = [
      /\b(implement|create|add|update|fix|refactor|实现|创建|添加|更新|修复|重构)\b/gi,
      /\b(step|步骤|action|操作)\s*\d+/gi,
      /\b(must|should|need to|必须|应该|需要)\b/gi,
    ];
    let actionableMatches = 0;
    for (const pattern of actionablePatterns) {
      const matches = content.match(pattern);
      if (matches) actionableMatches += matches.length;
    }
    dimensions[QualityDimension.ACTIONABILITY] = Math.min(1.0, actionableMatches / 10);

    // ── Specificity: presence of specific technical terms ──────────────────
    const specificityPatterns = [
      /\b\d+(\.\d+)?\s*(ms|s|mb|gb|%|px|em|rem)\b/gi,  // Measurements
      /\b[A-Z][a-zA-Z]+\.[a-zA-Z]+\b/g,                 // Class.method references
      /\b[a-z-]+\.(js|ts|py|go|java|rs)\b/gi,          // File references
      /`[^`]+`/g,                                       // Code snippets
    ];
    let specificityMatches = 0;
    for (const pattern of specificityPatterns) {
      const matches = content.match(pattern);
      if (matches) specificityMatches += matches.length;
    }
    dimensions[QualityDimension.SPECIFICITY] = Math.min(1.0, specificityMatches / 8);

    // ── Novelty: check against existing experiences ────────────────────────
    if (this._expStore && content.length > 100) {
      const existingExps = this._expStore.getAll ? this._expStore.getAll() : [];
      const keywords = this._extractKeywords(content);
      let overlapCount = 0;
      for (const exp of existingExps.slice(0, 50)) { // Check against recent 50
        const expKeywords = new Set(
          (exp.title + ' ' + exp.content).toLowerCase().split(/\W+/).filter(w => w.length > 3)
        );
        for (const kw of keywords) {
          if (expKeywords.has(kw.toLowerCase())) overlapCount++;
        }
      }
      // Lower overlap = higher novelty
      const avgOverlap = keywords.length > 0 ? overlapCount / keywords.length : 0;
      dimensions[QualityDimension.NOVELTY] = Math.max(0, 1.0 - avgOverlap / 5);
    } else {
      dimensions[QualityDimension.NOVELTY] = 0.5; // Default if no store
    }

    // ── Relevance: presence of project-specific context ────────────────────
    const relevancePatterns = [
      /\b(project|module|component|service|api|项目|模块|组件|服务)\b/gi,
      /\b(requirement|feature|task|需求|功能|任务)\b/gi,
    ];
    let relevanceMatches = 0;
    for (const pattern of relevancePatterns) {
      const matches = content.match(pattern);
      if (matches) relevanceMatches += matches.length;
    }
    dimensions[QualityDimension.RELEVANCE] = Math.min(1.0, relevanceMatches / 6);

    // ── Calculate composite score ──────────────────────────────────────────
    // Weighted average: actionability (0.3), specificity (0.2), novelty (0.3), relevance (0.2)
    const weights = {
      [QualityDimension.ACTIONABILITY]: 0.3,
      [QualityDimension.SPECIFICITY]: 0.2,
      [QualityDimension.NOVELTY]: 0.3,
      [QualityDimension.RELEVANCE]: 0.2,
    };

    let score = 0;
    for (const [dim, value] of Object.entries(dimensions)) {
      score += value * weights[dim];
    }
    score = Math.round(score * 100) / 100;

    // ── Determine if passed ────────────────────────────────────────────────
    // Threshold: score >= 0.4 (same as KnowledgePipeline default)
    const passed = score >= 0.4;

    if (this._verbose) {
      console.log(`[SessionQualityScorer] 📊 Score: ${score.toFixed(2)} (passed: ${passed})`);
      for (const [dim, value] of Object.entries(dimensions)) {
        console.log(`  - ${dim}: ${value.toFixed(2)}`);
      }
    }

    return { score, dimensions, passed };
  }

  /**
   * Score a session combined with signal detection results.
   * This is the main entry point for _finalizeWorkflow integration.
   *
   * @param {object} sessionOutput - Same as score()
   * @param {object} signalResult - Result from SessionSignalDetector.detectSignals()
   * @returns {{ score: number, shouldCapture: boolean, reason: string }}
   */
  scoreWithSignals(sessionOutput, signalResult) {
    const qualityResult = this.score(sessionOutput);

    // Combine quality score with signal score
    // Signal score has higher weight because it indicates real issues
    const signalScore = signalResult.score || 0;
    const combinedScore = (qualityResult.score * 0.4) + (Math.min(signalScore, 2) / 2 * 0.6);

    // Decision logic:
    // - If signals detected (score >= 1.0 or HIGH severity), always capture
    // - If quality passed and some signals, capture
    // - Otherwise, skip
    let shouldCapture = false;
    let reason = '';

    if (signalResult.shouldCapture) {
      shouldCapture = true;
      reason = `Signal-driven capture: ${signalResult.signals.length} signal(s) detected (score: ${signalScore.toFixed(2)})`;
    } else if (qualityResult.passed && signalScore > 0.5) {
      shouldCapture = true;
      reason = `Quality + signal capture: quality=${qualityResult.score.toFixed(2)}, signals=${signalScore.toFixed(2)}`;
    } else {
      reason = `Skip capture: quality=${qualityResult.score.toFixed(2)}, signals=${signalScore.toFixed(2)}`;
    }

    return {
      score: Math.round(combinedScore * 100) / 100,
      qualityScore: qualityResult.score,
      signalScore,
      shouldCapture,
      reason,
      dimensions: qualityResult.dimensions,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Extract keywords from content for novelty check.
   * @param {string} content
   * @returns {string[]}
   */
  _extractKeywords(content) {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
      'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
      'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'while',
      'for', 'from', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'about',
    ]);

    return content
      .toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 3 && !stopWords.has(word))
      .slice(0, 20);
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────

module.exports = {
  SessionQualityScorer,
  QualityDimension,
};
