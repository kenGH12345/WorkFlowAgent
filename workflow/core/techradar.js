/**
 * TechRadar (ADR-38)
 *
 * Lightweight tech scanning and upgrade evaluation engine.
 * Scans the web for new AI/Agent/workflow techniques and evaluates whether
 * WorkFlowAgent should adopt them.
 *
 * Design Principles:
 *   - Condition-triggered: Only runs when >7 days since last scan
 *   - Zero daemon: No background processes, triggered on conversation end
 *   - User-controlled: Reminds user, but requires explicit /techradar to execute
 *   - Token-efficient: Minimal LLM calls, focused search queries
 *
 * Scoring Rubric (4 dimensions, 0-1 each):
 *   - relevanceScore:     How relevant to AI agent / workflow systems?
 *   - noveltyScore:       How fresh / novel vs our current implementation?
 *   - actionabilityScore: Can we directly implement something from this?
 *   - upgradeUrgency:     How urgent is the upgrade? (security, performance, deprecation)
 *
 * Trigger:
 *   - `/techradar` command (manual)
 *   - Reminder on _finalizeWorkflow() if >7 days since last scan
 *
 * Output:
 *   - TechRadar report in output/techradar-report.json
 *   - Upgrade recommendations with priority and effort estimates
 *
 * Built on: KnowledgePipeline (ADR-32 P2), ArticleScout patterns
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { KnowledgePipeline, KnowledgeSource, AnalysisTemplate } = require('./knowledge-pipeline');

// ─── Default Scan Topics ────────────────────────────────────────────────────

const DEFAULT_SCAN_TOPICS = [
  {
    query: 'AI coding agent architecture improvements 2025 2026',
    label: 'Agent Architecture',
    category: 'architecture',
  },
  {
    query: 'LLM agent self-improvement self-evolution techniques',
    label: 'Self-Evolution',
    category: 'evolution',
  },
  {
    query: 'AI agent quality assurance testing best practices',
    label: 'Quality Assurance',
    category: 'quality',
  },
  {
    query: 'LLM context window optimization memory management',
    label: 'Context Optimization',
    category: 'performance',
  },
  {
    query: 'AI agent tool use MCP model context protocol',
    label: 'Tool Integration',
    category: 'integration',
  },
];

// ─── Score Weights ───────────────────────────────────────────────────────────

const SCORE_WEIGHTS = {
  relevance:     0.25,
  novelty:       0.25,
  actionability: 0.30,
  upgradeUrgency: 0.20,
};

// Minimum score to consider a technique "adoptable"
const MIN_ADOPT_SCORE = 0.50;

// Maximum techniques to evaluate per run
const MAX_TECHNIQUES_PER_RUN = 5;

// ─── TechRadar Class ─────────────────────────────────────────────────────────

class TechRadar {
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
   * Run a tech radar scan: search, evaluate, and recommend upgrades.
   *
   * @param {object} [opts]
   * @param {Array}   [opts.topics]            - Custom topics to scan (default: DEFAULT_SCAN_TOPICS)
   * @param {number}  [opts.maxTechniques]     - Max techniques to evaluate (default: 5)
   * @param {number}  [opts.minScore]          - Min adopt score (default: 0.50)
   * @param {boolean} [opts.autoInject=false]  - Auto-inject high-value findings
   * @param {boolean} [opts.dryRun=false]      - Preview without injecting
   * @returns {Promise<TechRadarResult>}
   */
  async run(opts = {}) {
    const {
      topics = DEFAULT_SCAN_TOPICS,
      maxTechniques = MAX_TECHNIQUES_PER_RUN,
      minScore = MIN_ADOPT_SCORE,
      autoInject = false,
      dryRun = false,
    } = opts;

    const startTime = Date.now();
    console.log(`\n[TechRadar] 📡 Starting tech scan across ${topics.length} topic(s)...`);

    const allEvaluations = [];
    let injectedCount = 0;

    // ── Phase 1: Search & Collect ─────────────────────────────────────────
    for (const topic of topics.slice(0, 5)) {
      console.log(`[TechRadar] 🔍 Scanning: "${topic.label || topic.query.slice(0, 50)}..."`);

      try {
        const collectResult = await this._pipeline.collect(
          KnowledgeSource.WEB_ARTICLE,
          topic.query,
          { maxResults: 2, maxFetchPages: 1 } // Conservative: minimize token usage
        );

        if (!collectResult.success || collectResult.rawData.length < 100) {
          this._log(`  ⚠️ No useful content for topic: ${topic.label}`);
          continue;
        }

        // ── Phase 2: Analyse & Evaluate ───────────────────────────────────
        const analyseResult = await this._pipeline.analyse(
          collectResult.rawData,
          AnalysisTemplate.TECHNIQUE, // Use technique template
          {
            systemDescription: `WorkFlowAgent: An AI-powered coding workflow system.
Current stack: Node.js, LLM integration, 7-stage pipeline (ANALYSE→ARCHITECT→CODE→TEST→REVIEW→DEPLOY→EVOLVE).
Key modules: SkillEvolution, ExperienceStore, QualityGate, MAPEEngine, KnowledgePipeline.
Design principles: IDE-First (ADR-37), condition-triggered evolution, token-efficient operations.`,
            category: topic.category,
          }
        );

        if (!analyseResult.success || !analyseResult.structured) {
          this._log(`  ⚠️ LLM analysis failed for topic: ${topic.label}`);
          continue;
        }

        const evaluation = this._evaluateTechnique(analyseResult.structured, topic);
        allEvaluations.push(evaluation);

        const status = evaluation.adoptScore >= minScore ? '✅ ADOPT' : '⚪ Pass';
        console.log(`[TechRadar]   ${status}: "${evaluation.title}" (score: ${evaluation.adoptScore.toFixed(2)})`);

        // ── Phase 3: Inject high-value techniques (optional) ───────────────
        if (evaluation.adoptScore >= minScore && autoInject && !dryRun) {
          if (allEvaluations.filter(e => e.adoptScore >= minScore).length <= maxTechniques) {
            const injResult = await this._injectTechniqueKnowledge(analyseResult.structured, collectResult.sources, evaluation);
            injectedCount += injResult.totalInjected;
          }
        }

      } catch (err) {
        console.warn(`[TechRadar] ⚠️ Error scanning topic "${topic.label}": ${err.message}`);
      }
    }

    // ── Phase 4: Generate Report ──────────────────────────────────────────
    const report = this._generateReport(allEvaluations, startTime, injectedCount);
    this._writeReport(report, allEvaluations);

    // Update lastTechRadarAt timestamp
    this._updateTimestamp();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const adoptable = allEvaluations.filter(e => e.adoptScore >= minScore).length;
    console.log(`[TechRadar] ✅ Scan complete in ${elapsed}s: ${allEvaluations.length} technique(s) evaluated, ${adoptable} adoptable.`);

    return {
      evaluations: allEvaluations,
      adoptableCount: adoptable,
      injectedCount,
      elapsedMs: Date.now() - startTime,
      reportPath: path.join(this._outputDir, 'techradar-report.json'),
    };
  }

  // ─── Private: Technique Evaluation ──────────────────────────────────────

  _evaluateTechnique(structured, topic) {
    const relevance = Math.min(1, Math.max(0, structured.relevanceScore || 0));
    const novelty = Math.min(1, Math.max(0, structured.noveltyScore || 0));
    const actionability = Math.min(1, Math.max(0, structured.actionabilityScore || 0));
    const upgradeUrgency = Math.min(1, Math.max(0, structured.upgradeUrgency || 0));

    const adoptScore =
      relevance * SCORE_WEIGHTS.relevance +
      novelty * SCORE_WEIGHTS.novelty +
      actionability * SCORE_WEIGHTS.actionability +
      upgradeUrgency * SCORE_WEIGHTS.upgradeUrgency;

    return {
      title: structured.title || topic.label || 'Unknown',
      topic: topic.label || topic.query.slice(0, 60),
      category: topic.category || 'general',
      scores: {
        relevance: Math.round(relevance * 100) / 100,
        novelty: Math.round(novelty * 100) / 100,
        actionability: Math.round(actionability * 100) / 100,
        upgradeUrgency: Math.round(upgradeUrgency * 100) / 100,
      },
      adoptScore: Math.round(adoptScore * 100) / 100,
      summary: (structured.summary || '').slice(0, 300),
      implementationEffort: structured.implementationEffort || 'unknown',
      riskLevel: structured.riskLevel || 'unknown',
      recommendation: (structured.recommendation || '').slice(0, 200),
      relatedModules: structured.relatedModules || [],
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Private: Knowledge Injection ───────────────────────────────────────

  async _injectTechniqueKnowledge(structured, sources, evaluation) {
    let totalInjected = 0;

    // Inject as experience for future reference
    if (this._orch && this._orch.experienceStore) {
      try {
        this._orch.experienceStore.record({
          type: 'positive',
          category: 'stable_pattern',
          title: `[TechRadar] ${evaluation.title}`,
          content: `${evaluation.summary}\n\n**Recommendation**: ${evaluation.recommendation}\n> _Source: techradar (${sources[0] || 'web'})_`,
          tags: ['techradar', evaluation.category, 'upgrade-candidate'],
          ttlDays: 90,
        });
        totalInjected++;
      } catch (_) { /* non-fatal */ }
    }

    // Persist to pipeline knowledge store
    this._pipeline._persistSearchKnowledge({
      ...structured,
      _adoptScore: evaluation.adoptScore,
    }, { sources, sourceType: KnowledgeSource.WEB_ARTICLE });

    return { totalInjected };
  }

  // ─── Private: Timestamp Management ──────────────────────────────────────

  _updateTimestamp() {
    try {
      if (this._orch && this._orch._manifest && this._orch._manifest.meta) {
        this._orch._manifest.meta.lastTechRadarAt = new Date().toISOString();
      }
    } catch (_) { /* non-fatal */ }
  }

  // ─── Private: Report Generation ─────────────────────────────────────────

  _generateReport(evaluations, startTime, injectedCount) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const adoptable = evaluations.filter(e => e.adoptScore >= MIN_ADOPT_SCORE);

    const lines = [
      `# 📡 TechRadar Report`,
      ``,
      `> Generated: ${new Date().toISOString()}`,
      `> Duration: ${elapsed}s`,
      `> Techniques evaluated: ${evaluations.length}`,
      `> Adoptable techniques: ${adoptable.length}`,
      `> Knowledge entries injected: ${injectedCount}`,
      ``,
      `---`,
      ``,
    ];

    if (adoptable.length > 0) {
      lines.push(`## ✅ Adoptable Techniques`);
      lines.push(``);
      for (const e of adoptable.sort((a, b) => b.adoptScore - a.adoptScore)) {
        lines.push(`### ${e.title} (Score: ${e.adoptScore.toFixed(2)})`);
        lines.push(`- **Category**: ${e.category}`);
        lines.push(`- **Relevance**: ${e.scores.relevance} | **Novelty**: ${e.scores.novelty} | **Actionability**: ${e.scores.actionability} | **Urgency**: ${e.scores.upgradeUrgency}`);
        lines.push(`- **Implementation Effort**: ${e.implementationEffort}`);
        lines.push(`- **Risk Level**: ${e.riskLevel}`);
        lines.push(`- **Summary**: ${e.summary}`);
        if (e.recommendation) lines.push(`- **Recommendation**: ${e.recommendation}`);
        if (e.relatedModules && e.relatedModules.length > 0) {
          lines.push(`- **Related Modules**: ${e.relatedModules.join(', ')}`);
        }
        lines.push(``);
      }
    }

    const passed = evaluations.filter(e => e.adoptScore < MIN_ADOPT_SCORE);
    if (passed.length > 0) {
      lines.push(`## ⚪ Passed Techniques (below threshold ${MIN_ADOPT_SCORE})`);
      lines.push(``);
      for (const e of passed) {
        lines.push(`- **${e.title}** (${e.adoptScore.toFixed(2)}) — ${e.summary.slice(0, 100)}...`);
      }
      lines.push(``);
    }

    if (evaluations.length === 0) {
      lines.push(`## ℹ️ No Techniques Found`, ``, `No techniques were retrieved from web search. This may be due to API rate limiting.`);
    }

    return lines.join('\n');
  }

  _writeReport(markdownReport, evaluations) {
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      // JSON report
      const jsonPath = path.join(this._outputDir, 'techradar-report.json');
      fs.writeFileSync(jsonPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        evaluations,
        adoptableCount: evaluations.filter(e => e.adoptScore >= MIN_ADOPT_SCORE).length,
      }, null, 2), 'utf-8');

      // Markdown report
      const mdPath = path.join(this._outputDir, 'techradar-report.md');
      fs.writeFileSync(mdPath, markdownReport, 'utf-8');

      console.log(`[TechRadar] 📄 Reports written: ${mdPath}`);
    } catch (err) {
      console.warn(`[TechRadar] ⚠️ Failed to write reports: ${err.message}`);
    }
  }

  _log(msg) {
    if (this._verbose) {
      console.log(`[TechRadar] ${msg}`);
    }
  }
}

// ─── Static Helper: Staleness Check ─────────────────────────────────────────

/**
 * Checks if TechRadar scan is stale (>7 days since last scan).
 * Used by Orchestrator._finalizeWorkflow() to trigger reminder.
 *
 * @param {object} manifestMeta - The manifest.meta object
 * @returns {{ isStale: boolean, daysSince: number }}
 */
function isTechRadarStale(manifestMeta) {
  const STALE_DAYS = 7;
  const lastScan = manifestMeta && manifestMeta.lastTechRadarAt;
  const daysSince = lastScan
    ? (Date.now() - new Date(lastScan).getTime()) / (24 * 60 * 60 * 1000)
    : Infinity;

  return {
    isStale: daysSince > STALE_DAYS,
    daysSince: Math.round(daysSince),
    lastScan: lastScan || null,
  };
}

module.exports = {
  TechRadar,
  DEFAULT_SCAN_TOPICS,
  SCORE_WEIGHTS,
  MIN_ADOPT_SCORE,
  isTechRadarStale,
};
