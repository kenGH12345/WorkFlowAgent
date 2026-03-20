/**
 * Knowledge Pipeline (ADR-32 — P2)
 *
 * Unified abstraction for the "External Knowledge + AI Analysis → Internal
 * Structured Knowledge" pipeline. This is the reusable engine that powers:
 *
 *   - ArticleScout (P3): web articles → evaluation → skill/experience enrichment
 *   - SkillEnrichment (ADR-29): web search → skill section generation
 *   - ExperiencePreheat (ADR-30): web search → seed experience injection
 *   - DeepAudit findings injection: audit results → experience records
 *   - Future: user feedback, bug fix learning, competitive analysis
 *
 * Four-stage pipeline:
 *   1. COLLECT  — Acquire raw data from a source (web, user input, system event)
 *   2. ANALYSE  — LLM-powered structured extraction with configurable templates
 *   3. EVALUATE — Score, deduplicate, and detect knowledge conflicts
 *   4. INJECT   — Smart routing to the correct target store
 *
 * Design: zero new external dependencies. Reuses webSearchHelper, LLM calls,
 * ExperienceStore, SkillEvolution, ComplaintWall — all via Orchestrator.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Source Types ────────────────────────────────────────────────────────────

const KnowledgeSource = {
  WEB_SEARCH:   'web-search',
  WEB_ARTICLE:  'web-article',
  USER_INPUT:   'user-input',
  SYSTEM_EVENT: 'system-event',   // audit findings, error patterns, etc.
  AI_GENERATED: 'ai-generated',   // LLM internal knowledge (fallback)
};

// ─── Target Types ────────────────────────────────────────────────────────────

const KnowledgeTarget = {
  SKILL:           'skill',
  EXPERIENCE:      'experience',
  COMPLAINT:       'complaint',
  SEARCH_KNOWLEDGE:'search-knowledge',
};

// ─── Analysis Templates ──────────────────────────────────────────────────────

const AnalysisTemplate = {
  ARTICLE:    'article',     // For web articles → value assessment + knowledge extraction
  CODE:       'code',        // For code-related content → rules, anti-patterns
  EXPERIENCE: 'experience',  // For experience extraction → structured experiences
};

// ─── Knowledge Pipeline Class ────────────────────────────────────────────────

class KnowledgePipeline {
  /**
   * @param {object} opts
   * @param {object}  opts.orchestrator - Orchestrator instance
   * @param {boolean} [opts.verbose=false]
   */
  constructor({ orchestrator, verbose = false } = {}) {
    this._orch = orchestrator;
    this._verbose = verbose;
    this._log('Pipeline initialised.');
  }

  // ─── Stage 1: COLLECT ───────────────────────────────────────────────────

  /**
   * Collect raw data from a specified source.
   *
   * @param {string} source   - KnowledgeSource enum value
   * @param {string} query    - Search query or topic
   * @param {object} [opts]
   * @param {number} [opts.maxResults=5]
   * @param {number} [opts.maxFetchPages=3]
   * @returns {Promise<CollectResult>}
   */
  async collect(source, query, opts = {}) {
    const { maxResults = 5, maxFetchPages = 3 } = opts;
    this._log(`COLLECT: source=${source}, query="${query.slice(0, 80)}..."`);

    switch (source) {
      case KnowledgeSource.WEB_SEARCH:
      case KnowledgeSource.WEB_ARTICLE: {
        const { webSearchHelper } = require('./context-budget-manager');
        const searchResult = await webSearchHelper(this._orch, query, {
          maxResults,
          label: 'KnowledgePipeline',
        });

        if (!searchResult || !searchResult.results || searchResult.results.length === 0) {
          return { success: false, rawData: '', sources: [], error: 'No search results' };
        }

        // Deduplicate by URL
        const seen = new Set();
        const unique = searchResult.results.filter(r => {
          if (seen.has(r.url)) return false;
          seen.add(r.url);
          return true;
        });

        // Deep fetch top pages if WebSearchAdapter is available
        let fetchedContent = '';
        const sources = [];

        let wsAdapter = null;
        try {
          if (this._orch && this._orch.services && this._orch.services.has('mcpRegistry')) {
            const registry = this._orch.services.resolve('mcpRegistry');
            wsAdapter = registry.get('websearch');
          }
        } catch (_) { /* no adapter */ }

        if (wsAdapter && wsAdapter.fetchPage) {
          const pagesToFetch = unique.slice(0, maxFetchPages);
          const fetchPromises = pagesToFetch.map(r =>
            wsAdapter.fetchPage(r.url, { maxLength: 8000 }).catch(() => ({ url: r.url, content: '' }))
          );
          const pages = await Promise.all(fetchPromises);
          for (const page of pages) {
            if (page.content && page.content.length > 100) {
              fetchedContent += `\n\n--- Source: ${page.url} ---\n${page.content}`;
              sources.push(page.url);
            }
          }
        }

        // Fallback to snippets
        if (!fetchedContent) {
          fetchedContent = unique.map(r =>
            `--- Source: ${r.url} ---\n${r.title}\n${(r.snippet || '').slice(0, 400)}`
          ).join('\n\n');
          sources.push(...unique.map(r => r.url));
        }

        return {
          success: fetchedContent.length > 100,
          rawData: fetchedContent,
          sources,
          resultCount: unique.length,
          provider: searchResult.provider,
        };
      }

      case KnowledgeSource.USER_INPUT:
        return {
          success: query.length > 10,
          rawData: query,
          sources: ['user-input'],
          resultCount: 1,
        };

      case KnowledgeSource.SYSTEM_EVENT:
        return {
          success: query.length > 10,
          rawData: query,
          sources: ['system-event'],
          resultCount: 1,
        };

      case KnowledgeSource.AI_GENERATED:
        return {
          success: true,
          rawData: '', // LLM will generate from internal knowledge
          sources: ['ai-internal-knowledge'],
          resultCount: 0,
        };

      default:
        return { success: false, rawData: '', sources: [], error: `Unknown source: ${source}` };
    }
  }

  // ─── Stage 2: ANALYSE ───────────────────────────────────────────────────

  /**
   * Analyse collected raw data using LLM with a structured template.
   *
   * @param {string} rawData    - Raw text content to analyse
   * @param {string} template   - AnalysisTemplate enum value
   * @param {object} [context]  - Additional context (e.g. skill name, tech stack)
   * @returns {Promise<AnalyseResult>}
   */
  async analyse(rawData, template, context = {}) {
    this._log(`ANALYSE: template=${template}, rawData=${rawData.length} chars`);

    const prompt = this._buildAnalysisPrompt(template, rawData, context);

    let llmResponse = null;
    if (this._orch && this._orch._rawLlmCall) {
      llmResponse = await this._orch._rawLlmCall(prompt, `kp-analyse-${template}`);
    } else if (this._orch && this._orch.llmCall) {
      llmResponse = await this._orch.llmCall(prompt, `kp-analyse-${template}`);
    }

    if (!llmResponse) {
      return { success: false, structured: null, error: 'No LLM response' };
    }

    const structured = this._parseJsonResponse(llmResponse);
    if (!structured) {
      return { success: false, structured: null, error: 'Failed to parse LLM response as JSON' };
    }

    return { success: true, structured };
  }

  // ─── Stage 3: EVALUATE ──────────────────────────────────────────────────

  /**
   * Evaluate analysed knowledge: score quality, detect duplicates, check conflicts.
   *
   * @param {object} structured  - Parsed structured knowledge from ANALYSE stage
   * @param {object} [opts]
   * @param {number} [opts.minScore=0.4] - Minimum quality score (0-1) to accept
   * @returns {EvaluateResult}
   */
  evaluate(structured, opts = {}) {
    const { minScore = 0.4 } = opts;
    this._log(`EVALUATE: scoring structured knowledge...`);

    if (!structured || typeof structured !== 'object') {
      return { score: 0, accepted: false, reason: 'Invalid structured data' };
    }

    let score = 0;
    let totalEntries = 0;
    let actionableEntries = 0;

    // Count and score entries across all sections
    const sections = ['rules', 'antiPatterns', 'gotchas', 'bestPractices', 'contextHints',
                      'experiences', 'insights', 'recommendations'];
    for (const key of sections) {
      if (structured[key] && Array.isArray(structured[key])) {
        for (const entry of structured[key]) {
          totalEntries++;
          if (entry.title && entry.title.length > 5 &&
              entry.content && entry.content.length > 20) {
            actionableEntries++;
          }
        }
      }
    }

    if (totalEntries === 0) {
      return { score: 0, accepted: false, reason: 'No entries found in structured data' };
    }

    // Quality score: ratio of actionable entries
    score = actionableEntries / totalEntries;

    // Bonus for diversity (having multiple section types)
    const populatedSections = sections.filter(k =>
      structured[k] && Array.isArray(structured[k]) && structured[k].length > 0
    ).length;
    if (populatedSections >= 3) score = Math.min(1.0, score + 0.1);
    if (populatedSections >= 5) score = Math.min(1.0, score + 0.1);

    // Article-specific scoring
    if (structured.relevanceScore !== undefined) {
      score = (score + structured.relevanceScore) / 2;
    }

    const accepted = score >= minScore;
    return {
      score: Math.round(score * 100) / 100,
      accepted,
      reason: accepted ? `Score ${score.toFixed(2)} ≥ threshold ${minScore}` : `Score ${score.toFixed(2)} < threshold ${minScore}`,
      totalEntries,
      actionableEntries,
      populatedSections,
    };
  }

  // ─── Stage 4: INJECT ────────────────────────────────────────────────────

  /**
   * Smart-route evaluated knowledge into the appropriate target store(s).
   *
   * @param {object} structured  - Evaluated structured knowledge
   * @param {string|string[]} targets - KnowledgeTarget(s) to inject into
   * @param {object} [context]   - Injection context (skillName, tags, etc.)
   * @returns {Promise<InjectResult>}
   */
  async inject(structured, targets, context = {}) {
    if (!Array.isArray(targets)) targets = [targets];
    this._log(`INJECT: targets=[${targets.join(', ')}]`);

    const results = {};

    for (const target of targets) {
      switch (target) {
        case KnowledgeTarget.SKILL:
          results.skill = await this._injectIntoSkill(structured, context);
          break;

        case KnowledgeTarget.EXPERIENCE:
          results.experience = this._injectIntoExperience(structured, context);
          break;

        case KnowledgeTarget.COMPLAINT:
          results.complaint = this._injectIntoComplaint(structured, context);
          break;

        case KnowledgeTarget.SEARCH_KNOWLEDGE:
          results.searchKnowledge = this._persistSearchKnowledge(structured, context);
          break;

        default:
          results[target] = { success: false, error: `Unknown target: ${target}` };
      }
    }

    return results;
  }

  // ─── Full Pipeline Run ──────────────────────────────────────────────────

  /**
   * Run the complete 4-stage pipeline in sequence.
   *
   * @param {object} opts
   * @param {string}   opts.source      - KnowledgeSource
   * @param {string}   opts.query       - Search query or raw input
   * @param {string}   opts.template    - AnalysisTemplate
   * @param {string|string[]} opts.targets - KnowledgeTarget(s)
   * @param {object}   [opts.context]   - Additional context
   * @param {number}   [opts.minScore]  - Minimum quality score
   * @returns {Promise<PipelineResult>}
   */
  async run(opts) {
    const { source, query, template, targets, context = {}, minScore = 0.4 } = opts;
    const startTime = Date.now();

    this._log(`=== Pipeline RUN: ${source} → ${template} → [${[].concat(targets).join(', ')}] ===`);

    // 1. Collect
    const collectResult = await this.collect(source, query, context);
    if (!collectResult.success) {
      return { success: false, stage: 'collect', error: collectResult.error, elapsedMs: Date.now() - startTime };
    }

    // 2. Analyse
    const analyseResult = await this.analyse(collectResult.rawData, template, {
      ...context,
      sources: collectResult.sources,
    });
    if (!analyseResult.success) {
      return { success: false, stage: 'analyse', error: analyseResult.error, elapsedMs: Date.now() - startTime };
    }

    // 3. Evaluate
    const evalResult = this.evaluate(analyseResult.structured, { minScore });
    if (!evalResult.accepted) {
      return { success: false, stage: 'evaluate', error: evalResult.reason, score: evalResult.score, elapsedMs: Date.now() - startTime };
    }

    // 4. Inject
    const injectResult = await this.inject(analyseResult.structured, targets, {
      ...context,
      sources: collectResult.sources,
      sourceType: collectResult.sources.includes('ai-internal-knowledge')
        ? KnowledgeSource.AI_GENERATED : source,
    });

    const elapsedMs = Date.now() - startTime;
    this._log(`=== Pipeline DONE in ${(elapsedMs / 1000).toFixed(1)}s: score=${evalResult.score} ===`);

    return {
      success: true,
      score: evalResult.score,
      collectResult,
      evalResult,
      injectResult,
      elapsedMs,
    };
  }

  // ─── Private: Injection Implementations ─────────────────────────────────

  async _injectIntoSkill(structured, context) {
    if (!this._orch || !this._orch.services || !this._orch.services.has('skillEvolution')) {
      return { success: false, injected: 0, error: 'SkillEvolution not available' };
    }

    const skillName = context.skillName;
    if (!skillName) {
      return { success: false, injected: 0, error: 'No skillName in context' };
    }

    const skillEvolution = this._orch.services.resolve('skillEvolution');
    const sourceType = context.sourceType || KnowledgeSource.AI_GENERATED;
    const sourceUrl = (context.sources && context.sources[0]) || '';

    let injected = 0;
    const sectionMap = [
      { key: 'rules', section: 'Rules' },
      { key: 'antiPatterns', section: 'Anti-Patterns' },
      { key: 'gotchas', section: 'Gotchas' },
      { key: 'bestPractices', section: 'Best Practices' },
      { key: 'contextHints', section: 'Context Hints' },
    ];

    for (const { key, section } of sectionMap) {
      const entries = structured[key];
      if (!entries || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry.title || !entry.content) continue;
        const annotatedContent = `${entry.content}\n> _Source: ${sourceType}${sourceUrl ? ` | ${sourceUrl}` : ''}_`;
        const ok = skillEvolution.evolve(skillName, {
          section,
          title: entry.title,
          content: annotatedContent,
          sourceExpId: `kp-${sourceType}-${Date.now()}`,
          reason: `KnowledgePipeline injection (${sourceType})`,
        });
        if (ok) injected++;
      }
    }

    return { success: true, injected };
  }

  _injectIntoExperience(structured, context) {
    if (!this._orch || !this._orch.experienceStore) {
      return { success: false, injected: 0, error: 'ExperienceStore not available' };
    }

    const experiences = structured.experiences || structured.insights || [];
    if (!Array.isArray(experiences)) {
      return { success: false, injected: 0, error: 'No experiences in structured data' };
    }

    const sourceType = context.sourceType || KnowledgeSource.AI_GENERATED;
    let injected = 0;

    for (const exp of experiences.slice(0, 10)) {
      try {
        const type = exp.type === 'positive' ? 'positive' : 'negative';
        this._orch.experienceStore.record({
          type,
          category: exp.category || 'stable_pattern',
          title: exp.title,
          content: `${exp.content}\n> _Source: ${sourceType} (KnowledgePipeline)_`,
          tags: exp.tags || context.tags || [],
          ttlDays: type === 'negative' ? 90 : 180,
        });
        injected++;
      } catch (_) { /* non-fatal */ }
    }

    return { success: true, injected };
  }

  _injectIntoComplaint(structured, context) {
    if (!this._orch || !this._orch._complaintWall) {
      return { success: false, injected: 0, error: 'ComplaintWall not available' };
    }

    const complaints = structured.complaints || structured.issues || [];
    if (!Array.isArray(complaints) || complaints.length === 0) {
      return { success: true, injected: 0 };
    }

    let injected = 0;
    for (const c of complaints.slice(0, 5)) {
      try {
        this._orch._complaintWall.file({
          title: c.title || 'Unknown complaint',
          description: c.content || c.description || '',
          severity: c.severity || 'medium',
          source: 'knowledge-pipeline',
        });
        injected++;
      } catch (_) { /* non-fatal */ }
    }

    return { success: true, injected };
  }

  _persistSearchKnowledge(structured, context) {
    try {
      const outputDir = this._orch?._outputDir || path.join(__dirname, '..', 'output');
      const knowledgePath = path.join(outputDir, 'pipeline-knowledge.json');

      let existing = [];
      if (fs.existsSync(knowledgePath)) {
        try { existing = JSON.parse(fs.readFileSync(knowledgePath, 'utf-8')); } catch (_) { existing = []; }
      }

      existing.push({
        timestamp: new Date().toISOString(),
        sources: context.sources || [],
        sourceType: context.sourceType || 'unknown',
        score: structured._pipelineScore || 0,
        summary: (structured.summary || '').slice(0, 500),
        entryCount: this._countAllEntries(structured),
      });

      // Cap at 100 entries
      if (existing.length > 100) existing = existing.slice(-100);

      const tmpPath = knowledgePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf-8');
      fs.renameSync(tmpPath, knowledgePath);

      return { success: true, totalEntries: existing.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ─── Private: Analysis Prompt Builders ──────────────────────────────────

  _buildAnalysisPrompt(template, rawData, context) {
    switch (template) {
      case AnalysisTemplate.ARTICLE:
        return this._buildArticleAnalysisPrompt(rawData, context);
      case AnalysisTemplate.CODE:
        return this._buildCodeAnalysisPrompt(rawData, context);
      case AnalysisTemplate.EXPERIENCE:
        return this._buildExperienceAnalysisPrompt(rawData, context);
      default:
        return this._buildCodeAnalysisPrompt(rawData, context);
    }
  }

  _buildArticleAnalysisPrompt(rawData, context) {
    return [
      `You are an expert technology analyst evaluating web articles for an AI coding agent system.`,
      ``,
      `## Task`,
      `Analyse the following article content and evaluate its value for improving an AI agent workflow system.`,
      `${context.systemDescription ? `\nSystem context: ${context.systemDescription}` : ''}`,
      ``,
      `## Output Format`,
      `Return ONLY a JSON object (no markdown fences, no explanation):`,
      `{`,
      `  "title": "<article title>",`,
      `  "summary": "<2-3 sentence summary of key insights>",`,
      `  "relevanceScore": <0.0-1.0>,`,
      `  "noveltyScore": <0.0-1.0>,`,
      `  "actionabilityScore": <0.0-1.0>,`,
      `  "systemFitScore": <0.0-1.0>,`,
      `  "crossDomainValue": "<description of cross-domain applicability>",`,
      `  "riskAssessment": "<potential risks of adopting these ideas>",`,
      `  "implementationCost": "low|medium|high",`,
      `  "recommendations": [{ "title": "<action item>", "content": "<detailed recommendation>" }],`,
      `  "insights": [{ "title": "<insight>", "content": "<explanation>", "type": "positive", "tags": [] }],`,
      `  "rules": [{ "title": "<rule>", "content": "<prescriptive rule>" }],`,
      `  "antiPatterns": [{ "title": "<pattern>", "content": "<what NOT to do>" }],`,
      `  "bestPractices": [{ "title": "<practice>", "content": "<what TO do>" }]`,
      `}`,
      ``,
      `## Scoring Guide`,
      `- relevanceScore: How relevant is this to AI agent/workflow systems?`,
      `- noveltyScore: How novel/fresh is this insight vs common knowledge?`,
      `- actionabilityScore: Can we directly implement something from this?`,
      `- systemFitScore: How well does this fit our existing architecture?`,
      `- Max 5 items per section. Quality over quantity.`,
      ``,
      `## Source Content`,
      rawData.slice(0, 15000),
    ].join('\n');
  }

  _buildCodeAnalysisPrompt(rawData, context) {
    const skillName = context.skillName || 'general';
    const domains = context.domains || 'software development';
    return [
      `You are a senior software engineering knowledge curator.`,
      ``,
      `## Task`,
      `Analyse the following content about "${skillName}" (domains: ${domains})`,
      `and extract actionable knowledge into structured JSON.`,
      ``,
      `## Output Format`,
      `Return ONLY a JSON object (no markdown fences, no explanation):`,
      `{`,
      `  "rules": [{ "title": "<concise rule name>", "content": "<1-3 sentence prescriptive rule>" }],`,
      `  "antiPatterns": [{ "title": "<pattern name>", "content": "<what NOT to do and why>" }],`,
      `  "gotchas": [{ "title": "<gotcha name>", "content": "<environment/version/platform-specific trap>" }],`,
      `  "bestPractices": [{ "title": "<practice name>", "content": "<what TO do and why>" }],`,
      `  "contextHints": [{ "title": "<hint name>", "content": "<useful context for future debugging>" }]`,
      `}`,
      ``,
      `## Quality Rules`,
      `- Each entry must be ACTIONABLE and SPECIFIC`,
      `- Max 5 entries per section`,
      `- Gotchas MUST be environment/version/platform-specific`,
      `- Anti-Patterns must describe concrete "instead" alternatives`,
      ``,
      `## Source Content`,
      rawData.slice(0, 15000),
    ].join('\n');
  }

  _buildExperienceAnalysisPrompt(rawData, context) {
    const techStack = context.techStack ? context.techStack.join(', ') : 'general';
    return [
      `You are an experienced software engineer extracting actionable experiences.`,
      ``,
      `## Task`,
      `Analyse the following content and extract structured experiences for a ${context.projectType || 'software'} project using ${techStack}.`,
      ``,
      `## Output Format`,
      `Return ONLY a JSON object:`,
      `{`,
      `  "experiences": [`,
      `    {`,
      `      "type": "positive" or "negative",`,
      `      "category": "pitfall" | "stable_pattern" | "performance" | "framework_limit" | "debug_technique",`,
      `      "title": "<concise title>",`,
      `      "content": "<2-3 sentence actionable description>",`,
      `      "tags": ["<relevant>", "<keywords>"]`,
      `    }`,
      `  ]`,
      `}`,
      ``,
      `## Rules`,
      `- Extract 5-8 experiences (mix of positive and negative)`,
      `- Each must be ACTIONABLE and SPECIFIC`,
      ``,
      `## Source Content`,
      rawData.slice(0, 15000),
    ].join('\n');
  }

  // ─── Private: Utilities ─────────────────────────────────────────────────

  _parseJsonResponse(response) {
    if (!response || typeof response !== 'string') return null;
    try {
      let cleaned = response.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
      else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
      cleaned = cleaned.trim();

      const startIdx = cleaned.indexOf('{');
      const endIdx = cleaned.lastIndexOf('}');
      if (startIdx === -1 || endIdx === -1) return null;
      cleaned = cleaned.slice(startIdx, endIdx + 1);

      return JSON.parse(cleaned);
    } catch (_) {
      return null;
    }
  }

  _countAllEntries(structured) {
    let count = 0;
    const keys = ['rules', 'antiPatterns', 'gotchas', 'bestPractices', 'contextHints',
                  'experiences', 'insights', 'recommendations', 'complaints'];
    for (const k of keys) {
      if (structured[k] && Array.isArray(structured[k])) count += structured[k].length;
    }
    return count;
  }

  _log(msg) {
    if (this._verbose) {
      console.log(`[KnowledgePipeline] ${msg}`);
    }
  }
}

module.exports = {
  KnowledgePipeline,
  KnowledgeSource,
  KnowledgeTarget,
  AnalysisTemplate,
};
