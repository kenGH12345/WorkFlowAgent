/**
 * Article Scout (ADR-32 — P3)
 *
 * Autonomous agent that searches the web for high-value Agent/AI/workflow
 * articles, evaluates them using a multi-dimensional scoring rubric, and
 * extracts actionable knowledge through the KnowledgePipeline.
 *
 * Scoring Rubric (4 dimensions, 0-1 each):
 *   - relevanceScore:     How relevant to AI agent / workflow systems?
 *   - noveltyScore:       How fresh / novel vs common knowledge?
 *   - actionabilityScore: Can we directly implement something from this?
 *   - systemFitScore:     How well does this fit our existing WFA architecture?
 *
 * Composite score = weighted average (relevance 0.3 + novelty 0.2 + actionability 0.3 + systemFit 0.2)
 *
 * Trigger:
 *   - `/article-scout` command (manual)
 *   - Future: scheduled/periodic execution
 *
 * Output:
 *   - Article evaluation reports in output/article-scout-report.json
 *   - High-value articles → KnowledgePipeline → Skill/Experience injection
 *
 * Built on: KnowledgePipeline (P2), webSearchHelper (existing), LLM analysis (existing)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { KnowledgePipeline, KnowledgeSource, KnowledgeTarget, AnalysisTemplate } = require('./knowledge-pipeline');

// ─── Default Scout Topics ────────────────────────────────────────────────────

const DEFAULT_SCOUT_TOPICS = [
  {
    query: 'AI coding agent architecture self-improvement autonomous workflow 2025 2026',
    label: 'Agent Architecture & Self-Improvement',
  },
  {
    query: 'LLM agent memory management context window optimization techniques',
    label: 'LLM Memory & Context Optimization',
  },
  {
    query: 'AI agent quality assurance automated testing self-review code generation',
    label: 'Agent QA & Self-Review',
  },
  {
    query: 'multi-agent collaboration orchestration workflow coordination patterns',
    label: 'Multi-Agent Orchestration Patterns',
  },
  {
    query: 'AI agent experience replay self-reflection knowledge accumulation',
    label: 'Experience Replay & Knowledge Accumulation',
  },
];

// ─── Score Weights ───────────────────────────────────────────────────────────

const SCORE_WEIGHTS = {
  relevance:     0.30,
  novelty:       0.20,
  actionability: 0.30,
  systemFit:     0.20,
};

// Minimum composite score to consider an article "high-value"
const MIN_COMPOSITE_SCORE = 0.55;

// Maximum articles to process per scout run
const MAX_ARTICLES_PER_RUN = 5;

// ─── Article Scout Class ─────────────────────────────────────────────────────

class ArticleScout {
  /**
   * @param {object} opts
   * @param {object}  opts.orchestrator - Orchestrator instance
   * @param {boolean} [opts.verbose=false]
   * @param {string}  [opts.outputDir]
   */
  constructor({ orchestrator, verbose = false, outputDir } = {}) {
    this._orch = orchestrator;
    this._verbose = verbose;
    this._outputDir = outputDir || (orchestrator && orchestrator._outputDir)
      || path.join(__dirname, '..', 'output');
    this._pipeline = new KnowledgePipeline({ orchestrator, verbose });
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Run a scouting session: search, evaluate, and extract knowledge from
   * high-value articles.
   *
   * @param {object} [opts]
   * @param {Array}   [opts.topics]            - Custom topics to search (default: DEFAULT_SCOUT_TOPICS)
   * @param {number}  [opts.maxArticles]       - Max articles to process (default: 5)
   * @param {number}  [opts.minScore]          - Min composite score (default: 0.55)
   * @param {boolean} [opts.autoInject=true]   - Auto-inject high-value findings
   * @param {boolean} [opts.dryRun=false]      - Preview without injecting
   * @returns {Promise<ScoutResult>}
   */
  async run(opts = {}) {
    const {
      topics = DEFAULT_SCOUT_TOPICS,
      maxArticles = MAX_ARTICLES_PER_RUN,
      minScore = MIN_COMPOSITE_SCORE,
      autoInject = true,
      dryRun = false,
    } = opts;

    const startTime = Date.now();
    console.log(`\n[ArticleScout] 🔍 Starting article scout across ${topics.length} topic(s)...`);

    const allEvaluations = [];
    let injectedCount = 0;

    // ── Phase 1: Search & Collect ─────────────────────────────────────────
    for (const topic of topics.slice(0, 5)) {
      console.log(`[ArticleScout] 📡 Searching: "${topic.label || topic.query.slice(0, 50)}..."`);

      try {
        const collectResult = await this._pipeline.collect(
          KnowledgeSource.WEB_ARTICLE,
          topic.query,
          { maxResults: 3, maxFetchPages: 2 }
        );

        if (!collectResult.success || collectResult.rawData.length < 100) {
          this._log(`  ⚠️ No useful content for topic: ${topic.label}`);
          continue;
        }

        // ── Phase 2: Analyse & Evaluate ───────────────────────────────────
        const analyseResult = await this._pipeline.analyse(
          collectResult.rawData,
          AnalysisTemplate.ARTICLE,
          {
            systemDescription: 'WorkFlowAgent: An AI-powered coding workflow system with self-reflection, skill evolution, quality gates, experience replay, and knowledge pipeline.',
          }
        );

        if (!analyseResult.success || !analyseResult.structured) {
          this._log(`  ⚠️ LLM analysis failed for topic: ${topic.label}`);
          continue;
        }

        const evaluation = this._evaluateArticle(analyseResult.structured, topic);

        allEvaluations.push(evaluation);

        const status = evaluation.compositeScore >= minScore ? '✅ HIGH-VALUE' : '⚪ Low-value';
        console.log(`[ArticleScout]   ${status}: "${evaluation.title}" (score: ${evaluation.compositeScore.toFixed(2)})`);

        // ── Phase 3: Inject high-value articles ───────────────────────────
        if (evaluation.compositeScore >= minScore && autoInject && !dryRun) {
          if (allEvaluations.filter(e => e.compositeScore >= minScore).length <= maxArticles) {
            const injResult = await this._injectArticleKnowledge(analyseResult.structured, collectResult.sources, evaluation);
            injectedCount += injResult.totalInjected;
          }
        }

      } catch (err) {
        console.warn(`[ArticleScout] ⚠️ Error processing topic "${topic.label}": ${err.message}`);
      }
    }

    // ── Phase 4: Generate Report ──────────────────────────────────────────
    const report = this._generateReport(allEvaluations, startTime, injectedCount);
    this._writeReport(report, allEvaluations);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const highValue = allEvaluations.filter(e => e.compositeScore >= minScore).length;
    console.log(`[ArticleScout] ✅ Scout complete in ${elapsed}s: ${allEvaluations.length} article(s) evaluated, ${highValue} high-value, ${injectedCount} entries injected.`);

    return {
      evaluations: allEvaluations,
      highValueCount: highValue,
      injectedCount,
      elapsedMs: Date.now() - startTime,
      reportPath: path.join(this._outputDir, 'article-scout-report.json'),
    };
  }

  // ─── Single Article Evaluation ──────────────────────────────────────────

  /**
   * Evaluate a single URL directly.
   *
   * @param {string} url - URL to evaluate
   * @param {object} [opts] - Same options as run()
   * @returns {Promise<ScoutResult>}
   */
  async evaluateUrl(url, opts = {}) {
    return this.run({
      ...opts,
      topics: [{ query: url, label: `Direct URL: ${url}` }],
      maxArticles: 1,
    });
  }

  // ─── Private: Article Evaluation ────────────────────────────────────────

  _evaluateArticle(structured, topic) {
    const relevance = Math.min(1, Math.max(0, structured.relevanceScore || 0));
    const novelty = Math.min(1, Math.max(0, structured.noveltyScore || 0));
    const actionability = Math.min(1, Math.max(0, structured.actionabilityScore || 0));
    const systemFit = Math.min(1, Math.max(0, structured.systemFitScore || 0));

    const compositeScore =
      relevance * SCORE_WEIGHTS.relevance +
      novelty * SCORE_WEIGHTS.novelty +
      actionability * SCORE_WEIGHTS.actionability +
      systemFit * SCORE_WEIGHTS.systemFit;

    return {
      title: structured.title || topic.label || 'Unknown',
      topic: topic.label || topic.query.slice(0, 60),
      scores: {
        relevance: Math.round(relevance * 100) / 100,
        novelty: Math.round(novelty * 100) / 100,
        actionability: Math.round(actionability * 100) / 100,
        systemFit: Math.round(systemFit * 100) / 100,
      },
      compositeScore: Math.round(compositeScore * 100) / 100,
      summary: (structured.summary || '').slice(0, 300),
      implementationCost: structured.implementationCost || 'unknown',
      riskAssessment: (structured.riskAssessment || '').slice(0, 200),
      crossDomainValue: (structured.crossDomainValue || '').slice(0, 200),
      recommendationCount: (structured.recommendations || []).length,
      insightCount: (structured.insights || []).length,
      ruleCount: (structured.rules || []).length,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Private: Knowledge Injection ───────────────────────────────────────

  async _injectArticleKnowledge(structured, sources, evaluation) {
    let totalInjected = 0;

    // Inject insights as experiences
    if (this._orch && this._orch.experienceStore && structured.insights) {
      const expResult = this._pipeline._injectIntoExperience(structured, {
        sources,
        sourceType: KnowledgeSource.WEB_ARTICLE,
        tags: ['article-scout', evaluation.topic.replace(/\s+/g, '-').toLowerCase()],
      });
      if (expResult.success) totalInjected += expResult.injected;
    }

    // Inject recommendations as experiences
    if (structured.recommendations && this._orch && this._orch.experienceStore) {
      for (const rec of structured.recommendations.slice(0, 3)) {
        try {
          this._orch.experienceStore.record({
            type: 'positive',
            category: 'stable_pattern',
            title: `[ArticleScout] ${rec.title}`,
            content: `${rec.content}\n> _Source: article-scout (${sources[0] || 'web'})_`,
            tags: ['article-scout', 'recommendation'],
            ttlDays: 180,
          });
          totalInjected++;
        } catch (_) { /* non-fatal */ }
      }
    }

    // Persist to pipeline knowledge store
    this._pipeline._persistSearchKnowledge({
      ...structured,
      _pipelineScore: evaluation.compositeScore,
    }, { sources, sourceType: KnowledgeSource.WEB_ARTICLE });

    return { totalInjected };
  }

  // ─── Private: Report Generation ─────────────────────────────────────────

  _generateReport(evaluations, startTime, injectedCount) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const highValue = evaluations.filter(e => e.compositeScore >= MIN_COMPOSITE_SCORE);

    const lines = [
      `# 🔍 Article Scout Report`,
      ``,
      `> Generated: ${new Date().toISOString()}`,
      `> Duration: ${elapsed}s`,
      `> Articles evaluated: ${evaluations.length}`,
      `> High-value articles: ${highValue.length}`,
      `> Knowledge entries injected: ${injectedCount}`,
      ``,
      `---`,
      ``,
    ];

    if (highValue.length > 0) {
      lines.push(`## ⭐ High-Value Articles`);
      lines.push(``);
      for (const e of highValue.sort((a, b) => b.compositeScore - a.compositeScore)) {
        lines.push(`### ${e.title} (Score: ${e.compositeScore.toFixed(2)})`);
        lines.push(`- **Topic**: ${e.topic}`);
        lines.push(`- **Relevance**: ${e.scores.relevance} | **Novelty**: ${e.scores.novelty} | **Actionability**: ${e.scores.actionability} | **System Fit**: ${e.scores.systemFit}`);
        lines.push(`- **Implementation Cost**: ${e.implementationCost}`);
        lines.push(`- **Summary**: ${e.summary}`);
        if (e.crossDomainValue) lines.push(`- **Cross-Domain Value**: ${e.crossDomainValue}`);
        if (e.riskAssessment) lines.push(`- **Risk**: ${e.riskAssessment}`);
        lines.push(`- **Extracted**: ${e.recommendationCount} recommendations, ${e.insightCount} insights, ${e.ruleCount} rules`);
        lines.push(``);
      }
    }

    const lowValue = evaluations.filter(e => e.compositeScore < MIN_COMPOSITE_SCORE);
    if (lowValue.length > 0) {
      lines.push(`## ⚪ Low-Value Articles (below threshold ${MIN_COMPOSITE_SCORE})`);
      lines.push(``);
      for (const e of lowValue) {
        lines.push(`- **${e.title}** (${e.compositeScore.toFixed(2)}) — ${e.summary.slice(0, 100)}...`);
      }
      lines.push(``);
    }

    if (evaluations.length === 0) {
      lines.push(`## ℹ️ No articles found`, ``, `No articles were retrieved from web search. This may be due to API rate limiting.`);
    }

    return lines.join('\n');
  }

  _writeReport(markdownReport, evaluations) {
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      // JSON report
      const jsonPath = path.join(this._outputDir, 'article-scout-report.json');
      fs.writeFileSync(jsonPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        evaluations,
        highValueCount: evaluations.filter(e => e.compositeScore >= MIN_COMPOSITE_SCORE).length,
      }, null, 2), 'utf-8');

      // Markdown report
      const mdPath = path.join(this._outputDir, 'article-scout-report.md');
      fs.writeFileSync(mdPath, markdownReport, 'utf-8');

      console.log(`[ArticleScout] 📄 Reports written: ${mdPath}`);
    } catch (err) {
      console.warn(`[ArticleScout] ⚠️ Failed to write reports: ${err.message}`);
    }
  }

  _log(msg) {
    if (this._verbose) {
      console.log(`[ArticleScout] ${msg}`);
    } else {
      console.log(`[ArticleScout] ${msg}`);
    }
  }
}

module.exports = { ArticleScout, DEFAULT_SCOUT_TOPICS, SCORE_WEIGHTS, MIN_COMPOSITE_SCORE };
