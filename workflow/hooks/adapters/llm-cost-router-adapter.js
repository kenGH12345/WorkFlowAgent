/**
 * LLMCostRouterAdapter – LLM cost-aware routing and budget enforcement.
 *
 * Bridges the gap between LlmRouter (which supports per-role routing but is
 * cost-blind) and real-world LLM pricing data. Provides:
 *
 *   1. Real-time model pricing   – via OpenRouter API or LiteLLM /model/info endpoint
 *   2. Per-run cost tracking     – accumulates token usage × unit price per role
 *   3. Budget enforcement        – warns or blocks when cumulative cost exceeds threshold
 *   4. Cost/Quality/Speed matrix – recommends optimal model per role given budget constraints
 *
 * Pricing backends (in priority order):
 *   1. OpenRouter /api/v1/models       – Free, no API key needed for pricing query
 *   2. LiteLLM /model/info             – Self-hosted, returns cost_per_token
 *   3. Built-in fallback table          – Hardcoded pricing for common models (updated periodically)
 *
 * Usage:
 *   const adapter = new LLMCostRouterAdapter({ budgetUsd: 2.0 });
 *   await adapter.connect();
 *   const pricing = adapter.getModelPricing('gpt-4o');
 *   adapter.recordUsage('ARCHITECT', 'gpt-4o', 5000, 2000); // inputTokens, outputTokens
 *   const summary = adapter.getCostSummary();
 *   const recommendation = adapter.recommend('DEVELOPER', { optimise: 'cost' });
 */

'use strict';

const { MCPAdapter, HttpMixin } = require('./base');

// ── Fallback pricing table (USD per 1M tokens) ─────────────────────────────
// Updated: 2026-03. Prices change; adapter fetches live data when available.

const FALLBACK_PRICING = {
  // OpenAI
  'gpt-4o':             { input: 2.50,  output: 10.00, quality: 9, speed: 8 },
  'gpt-4o-mini':        { input: 0.15,  output: 0.60,  quality: 7, speed: 9 },
  'gpt-4-turbo':        { input: 10.00, output: 30.00, quality: 9, speed: 6 },
  'gpt-4':              { input: 30.00, output: 60.00, quality: 8, speed: 5 },
  'gpt-3.5-turbo':      { input: 0.50,  output: 1.50,  quality: 5, speed: 10 },
  'o1':                 { input: 15.00, output: 60.00, quality: 10, speed: 4 },
  'o1-mini':            { input: 3.00,  output: 12.00, quality: 8, speed: 7 },
  'o3-mini':            { input: 1.10,  output: 4.40,  quality: 9, speed: 8 },
  // Anthropic
  'claude-3.5-sonnet':  { input: 3.00,  output: 15.00, quality: 9, speed: 8 },
  'claude-3-opus':      { input: 15.00, output: 75.00, quality: 10, speed: 5 },
  'claude-3-haiku':     { input: 0.25,  output: 1.25,  quality: 6, speed: 10 },
  'claude-3.5-haiku':   { input: 0.80,  output: 4.00,  quality: 7, speed: 9 },
  'claude-4-sonnet':    { input: 3.00,  output: 15.00, quality: 10, speed: 8 },
  // Google
  'gemini-2.0-flash':   { input: 0.10,  output: 0.40,  quality: 7, speed: 10 },
  'gemini-2.0-pro':     { input: 1.25,  output: 10.00, quality: 9, speed: 7 },
  'gemini-1.5-pro':     { input: 1.25,  output: 5.00,  quality: 8, speed: 7 },
  'gemini-1.5-flash':   { input: 0.075, output: 0.30,  quality: 6, speed: 10 },
  // DeepSeek
  'deepseek-chat':      { input: 0.14,  output: 0.28,  quality: 8, speed: 9 },
  'deepseek-reasoner':  { input: 0.55,  output: 2.19,  quality: 9, speed: 7 },
  // Meta
  'llama-3.1-70b':      { input: 0.52,  output: 0.75,  quality: 7, speed: 8 },
  'llama-3.1-405b':     { input: 2.00,  output: 2.00,  quality: 8, speed: 6 },
};

// ── Role-specific optimisation profiles ─────────────────────────────────────

const ROLE_PROFILES = {
  ANALYST:   { qualityWeight: 0.3, speedWeight: 0.4, costWeight: 0.3 },
  ARCHITECT: { qualityWeight: 0.6, speedWeight: 0.1, costWeight: 0.3 },
  DEVELOPER: { qualityWeight: 0.5, speedWeight: 0.2, costWeight: 0.3 },
  TESTER:    { qualityWeight: 0.4, speedWeight: 0.3, costWeight: 0.3 },
};


class LLMCostRouterAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {number}  [config.budgetUsd]         - Per-run budget in USD (default: 5.0)
   * @param {number}  [config.warnThresholdPct]  - Warn when budget usage exceeds this % (default: 80)
   * @param {string}  [config.pricingBackend]    - 'openrouter' | 'litellm' | 'fallback' (default: 'openrouter')
   * @param {string}  [config.litellmBaseUrl]    - LiteLLM base URL (default: 'http://localhost:4000')
   * @param {number}  [config.timeout]           - HTTP timeout in ms (default: 10000)
   * @param {number}  [config.cacheTtlMs]        - Pricing cache TTL (default: 3600000 = 1h)
   */
  constructor(config = {}) {
    super('llm-cost-router', config);
    this.budgetUsd = config.budgetUsd ?? 5.0;
    this.warnThresholdPct = config.warnThresholdPct ?? 80;
    this.pricingBackend = config.pricingBackend || 'openrouter';
    this.litellmBaseUrl = config.litellmBaseUrl || 'http://localhost:4000';
    this.timeout = config.timeout || 10000;
    this._cacheTtlMs = config.cacheTtlMs || 3600000; // 1 hour

    /** @type {Map<string, {input: number, output: number, quality: number, speed: number}>} */
    this._pricingCache = new Map();
    this._pricingCacheTs = 0;

    /** @type {Array<{role: string, model: string, inputTokens: number, outputTokens: number, costUsd: number, ts: number}>} */
    this._usageLog = [];

    /** @type {Map<string, {calls: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number}>} */
    this._roleStats = new Map();

    this._totalCostUsd = 0;
    this._budgetWarned = false;
  }

  async connect() {
    // Pre-fetch pricing data
    try {
      await this._refreshPricing();
    } catch (err) {
      console.warn(`[MCPAdapter:llm-cost-router] Live pricing fetch failed, using fallback table: ${err.message}`);
      this._loadFallbackPricing();
    }
    this._connected = true;
    console.log(`[MCPAdapter:llm-cost-router] Connected (backend: ${this.pricingBackend}, budget: $${this.budgetUsd}).`);
  }

  // ── Public API: Pricing ───────────────────────────────────────────────────

  /**
   * Returns pricing info for a specific model.
   * Prices are in USD per 1M tokens.
   *
   * @param {string} modelId - Model identifier (e.g. 'gpt-4o', 'claude-3.5-sonnet')
   * @returns {{input: number, output: number, quality: number, speed: number}|null}
   */
  getModelPricing(modelId) {
    this._assertConnected();
    // Exact match
    if (this._pricingCache.has(modelId)) return this._pricingCache.get(modelId);
    // Fuzzy match: try partial key matching
    for (const [key, val] of this._pricingCache) {
      if (key.includes(modelId) || modelId.includes(key)) return val;
    }
    return null;
  }

  /**
   * Returns all known model pricing data.
   *
   * @returns {Object<string, {input: number, output: number, quality: number, speed: number}>}
   */
  getAllPricing() {
    this._assertConnected();
    const result = {};
    for (const [k, v] of this._pricingCache) result[k] = { ...v };
    return result;
  }

  // ── Public API: Cost Tracking ─────────────────────────────────────────────

  /**
   * Records token usage for a specific role and model.
   * Calculates cost and adds to cumulative totals.
   * Triggers budget warnings when threshold is exceeded.
   *
   * @param {string} role         - Agent role (ANALYST, ARCHITECT, DEVELOPER, TESTER)
   * @param {string} model        - Model identifier
   * @param {number} inputTokens  - Number of input/prompt tokens
   * @param {number} outputTokens - Number of output/completion tokens
   * @returns {{costUsd: number, totalCostUsd: number, budgetRemainingUsd: number, budgetPct: number}}
   */
  recordUsage(role, model, inputTokens, outputTokens) {
    const pricing = this.getModelPricing(model);
    let costUsd = 0;
    if (pricing) {
      costUsd = (inputTokens / 1_000_000 * pricing.input) + (outputTokens / 1_000_000 * pricing.output);
    }

    this._usageLog.push({
      role, model, inputTokens, outputTokens, costUsd, ts: Date.now(),
    });

    // Update role stats
    if (!this._roleStats.has(role)) {
      this._roleStats.set(role, { calls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 });
    }
    const stats = this._roleStats.get(role);
    stats.calls += 1;
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    stats.totalCostUsd += costUsd;

    this._totalCostUsd += costUsd;

    // Budget check
    const budgetPct = (this._totalCostUsd / this.budgetUsd) * 100;
    if (budgetPct >= this.warnThresholdPct && !this._budgetWarned) {
      this._budgetWarned = true;
      console.warn(`[MCPAdapter:llm-cost-router] ⚠️ Budget warning: $${this._totalCostUsd.toFixed(4)} / $${this.budgetUsd} (${budgetPct.toFixed(1)}% used).`);
    }

    return {
      costUsd,
      totalCostUsd: this._totalCostUsd,
      budgetRemainingUsd: Math.max(0, this.budgetUsd - this._totalCostUsd),
      budgetPct,
    };
  }

  /**
   * Returns a comprehensive cost summary for the current run.
   *
   * @returns {CostSummary}
   */
  getCostSummary() {
    const byRole = {};
    for (const [role, stats] of this._roleStats) {
      byRole[role] = { ...stats };
    }

    return {
      totalCostUsd: this._totalCostUsd,
      budgetUsd: this.budgetUsd,
      budgetRemainingUsd: Math.max(0, this.budgetUsd - this._totalCostUsd),
      budgetPct: (this._totalCostUsd / this.budgetUsd) * 100,
      totalCalls: this._usageLog.length,
      byRole,
      usageLog: [...this._usageLog],
    };
  }

  /**
   * Checks if there is enough budget remaining for an estimated call.
   *
   * @param {string} model            - Model identifier
   * @param {number} estimatedInputTokens
   * @param {number} estimatedOutputTokens
   * @returns {{allowed: boolean, estimatedCostUsd: number, remainingUsd: number}}
   */
  checkBudget(model, estimatedInputTokens = 4000, estimatedOutputTokens = 2000) {
    const pricing = this.getModelPricing(model);
    let estimatedCostUsd = 0;
    if (pricing) {
      estimatedCostUsd = (estimatedInputTokens / 1_000_000 * pricing.input) +
                         (estimatedOutputTokens / 1_000_000 * pricing.output);
    }
    const remainingUsd = Math.max(0, this.budgetUsd - this._totalCostUsd);
    return {
      allowed: remainingUsd >= estimatedCostUsd,
      estimatedCostUsd,
      remainingUsd,
    };
  }

  // ── Public API: Recommendations ───────────────────────────────────────────

  /**
   * Recommends the optimal model for a given role based on cost/quality/speed trade-offs.
   *
   * @param {string} role    - Agent role
   * @param {object} [opts]
   * @param {string} [opts.optimise] - 'cost' | 'quality' | 'speed' | 'balanced' (default: 'balanced')
   * @param {number} [opts.maxCostPerCallUsd] - Max cost per call in USD
   * @returns {{model: string, score: number, costPer1kTokens: number, reason: string}[]}
   */
  recommend(role, opts = {}) {
    this._assertConnected();
    const optimise = opts.optimise || 'balanced';
    const maxCost = opts.maxCostPerCallUsd || Infinity;
    const profile = ROLE_PROFILES[role] || ROLE_PROFILES.DEVELOPER;

    // Adjust weights based on optimise preference
    let qw = profile.qualityWeight;
    let sw = profile.speedWeight;
    let cw = profile.costWeight;

    if (optimise === 'cost')    { cw = 0.7; qw = 0.2; sw = 0.1; }
    if (optimise === 'quality') { qw = 0.7; cw = 0.1; sw = 0.2; }
    if (optimise === 'speed')   { sw = 0.7; qw = 0.2; cw = 0.1; }

    const candidates = [];
    for (const [model, pricing] of this._pricingCache) {
      // Estimate cost for a typical call (4k input, 2k output)
      const typicalCost = (4000 / 1_000_000 * pricing.input) + (2000 / 1_000_000 * pricing.output);
      if (typicalCost > maxCost) continue;

      // Normalise cost score: lower cost = higher score (0-10 scale)
      // Using log scale: $0.001/call = 10, $1/call = 0
      const costScore = Math.max(0, Math.min(10, 10 - Math.log10(typicalCost * 1000 + 1) * 3));

      const compositeScore = (pricing.quality * qw) + (pricing.speed * sw) + (costScore * cw);

      candidates.push({
        model,
        score: Math.round(compositeScore * 100) / 100,
        costPer1kTokens: Math.round(((pricing.input + pricing.output) / 2000) * 10000) / 10000,
        typicalCallCost: Math.round(typicalCost * 10000) / 10000,
        quality: pricing.quality,
        speed: pricing.speed,
        reason: `Q:${pricing.quality}/10 S:${pricing.speed}/10 C:$${typicalCost.toFixed(4)}/call`,
      });
    }

    // Sort by composite score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 5);
  }

  // ── Public API: Formatting ────────────────────────────────────────────────

  /**
   * Formats the cost summary as a Markdown block for prompt injection.
   *
   * @param {CostSummary} [summary] - Optional; generates fresh if not provided
   * @returns {string}
   */
  formatCostBlock(summary) {
    const s = summary || this.getCostSummary();
    if (s.totalCalls === 0) return '';

    const budgetIcon = s.budgetPct >= 90 ? '🔴' : s.budgetPct >= 70 ? '🟡' : '🟢';
    const lines = [
      `## 💰 LLM Cost Summary`,
      `> ${budgetIcon} **$${s.totalCostUsd.toFixed(4)} / $${s.budgetUsd.toFixed(2)}** (${s.budgetPct.toFixed(1)}% of budget used)`,
      `> Remaining: **$${s.budgetRemainingUsd.toFixed(4)}** | Total calls: **${s.totalCalls}**`,
      ``,
    ];

    if (Object.keys(s.byRole).length > 0) {
      lines.push(`| Role | Calls | Input Tokens | Output Tokens | Cost |`);
      lines.push(`|------|-------|-------------|--------------|------|`);
      for (const [role, stats] of Object.entries(s.byRole)) {
        lines.push(`| ${role} | ${stats.calls} | ${stats.totalInputTokens.toLocaleString()} | ${stats.totalOutputTokens.toLocaleString()} | $${stats.totalCostUsd.toFixed(4)} |`);
      }
      lines.push(``);
    }

    if (s.budgetPct >= 80) {
      lines.push(`> ⚠️ **Budget pressure**: Consider switching to cheaper models for remaining stages.`);
      const recs = this.recommend('DEVELOPER', { optimise: 'cost' });
      if (recs.length > 0) {
        lines.push(`> **Cost-optimised alternatives**: ${recs.slice(0, 3).map(r => `\`${r.model}\` ($${r.typicalCallCost}/call)`).join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Formats model recommendations as a Markdown block.
   *
   * @param {string} role
   * @returns {string}
   */
  formatRecommendationBlock(role) {
    const recs = this.recommend(role);
    if (recs.length === 0) return '';

    const lines = [
      `## 🧭 Model Recommendations for ${role}`,
      `| Rank | Model | Score | Quality | Speed | Cost/call |`,
      `|------|-------|-------|---------|-------|-----------|`,
    ];

    recs.forEach((r, i) => {
      lines.push(`| ${i + 1} | \`${r.model}\` | ${r.score} | ${r.quality}/10 | ${r.speed}/10 | $${r.typicalCallCost} |`);
    });

    return lines.join('\n');
  }

  // ── MCPAdapter interface ──────────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();
    if (queryStr === 'summary') return this.getCostSummary();
    if (queryStr === 'recommend') return this.recommend(params.role || 'DEVELOPER', params);
    if (queryStr === 'pricing') return this.getAllPricing();
    if (queryStr === 'budget') return this.checkBudget(params.model, params.inputTokens, params.outputTokens);
    return this.getCostSummary();
  }

  async notify(event, payload) {
    // Track usage from external notifications
    if (event === 'llm_usage' && payload) {
      this.recordUsage(payload.role, payload.model, payload.inputTokens || 0, payload.outputTokens || 0);
    }
  }

  // ── Private: Pricing refresh ──────────────────────────────────────────────

  async _refreshPricing() {
    const now = Date.now();
    if (this._pricingCache.size > 0 && (now - this._pricingCacheTs) < this._cacheTtlMs) {
      return; // Cache is still fresh
    }

    if (this.pricingBackend === 'openrouter') {
      await this._fetchOpenRouterPricing();
    } else if (this.pricingBackend === 'litellm') {
      await this._fetchLiteLLMPricing();
    } else {
      this._loadFallbackPricing();
    }

    this._pricingCacheTs = now;
  }

  async _fetchOpenRouterPricing() {
    try {
      const raw = await this._httpGet('https://openrouter.ai/api/v1/models', {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'WorkFlowAgent/1.0 (LLMCostRouter)',
        },
        timeout: this.timeout,
      });
      const data = JSON.parse(raw);
      if (!data.data || !Array.isArray(data.data)) throw new Error('Invalid OpenRouter response');

      let loaded = 0;
      for (const model of data.data) {
        if (!model.pricing) continue;
        const inputPricePerToken = parseFloat(model.pricing.prompt) || 0;
        const outputPricePerToken = parseFloat(model.pricing.completion) || 0;

        // Convert from per-token to per-1M tokens
        const inputPer1M = inputPricePerToken * 1_000_000;
        const outputPer1M = outputPricePerToken * 1_000_000;

        if (inputPer1M === 0 && outputPer1M === 0) continue;

        // Extract short model name from full path (e.g. 'openai/gpt-4o' → 'gpt-4o')
        const fullId = model.id || '';
        const shortId = fullId.includes('/') ? fullId.split('/').pop() : fullId;

        // Estimate quality/speed from context length and response time hints
        const quality = this._estimateQuality(model);
        const speed = this._estimateSpeed(model);

        this._pricingCache.set(shortId, { input: inputPer1M, output: outputPer1M, quality, speed });
        // Also store full ID for exact matching
        if (shortId !== fullId) {
          this._pricingCache.set(fullId, { input: inputPer1M, output: outputPer1M, quality, speed });
        }
        loaded++;
      }

      console.log(`[MCPAdapter:llm-cost-router] Loaded pricing for ${loaded} models from OpenRouter.`);
    } catch (err) {
      console.warn(`[MCPAdapter:llm-cost-router] OpenRouter pricing fetch failed: ${err.message}`);
      this._loadFallbackPricing();
    }
  }

  async _fetchLiteLLMPricing() {
    try {
      const raw = await this._httpGet(`${this.litellmBaseUrl}/model/info`, {
        headers: { 'Accept': 'application/json' },
        timeout: this.timeout,
      });
      const data = JSON.parse(raw);
      const models = data.data || data;

      let loaded = 0;
      for (const model of (Array.isArray(models) ? models : [])) {
        const id = model.model_name || model.id || '';
        const inputCost = model.input_cost_per_token || 0;
        const outputCost = model.output_cost_per_token || 0;

        this._pricingCache.set(id, {
          input: inputCost * 1_000_000,
          output: outputCost * 1_000_000,
          quality: 7, // Default estimate
          speed: 7,
        });
        loaded++;
      }

      console.log(`[MCPAdapter:llm-cost-router] Loaded pricing for ${loaded} models from LiteLLM.`);
    } catch (err) {
      console.warn(`[MCPAdapter:llm-cost-router] LiteLLM pricing fetch failed: ${err.message}`);
      this._loadFallbackPricing();
    }
  }

  _loadFallbackPricing() {
    for (const [model, pricing] of Object.entries(FALLBACK_PRICING)) {
      this._pricingCache.set(model, { ...pricing });
    }
    console.log(`[MCPAdapter:llm-cost-router] Loaded fallback pricing for ${Object.keys(FALLBACK_PRICING).length} models.`);
  }

  // ── Private: Quality/Speed estimation ─────────────────────────────────────

  _estimateQuality(model) {
    // Heuristic based on context length and pricing
    const ctx = model.context_length || 4096;
    const price = parseFloat(model.pricing?.prompt || '0') * 1_000_000;
    if (price > 10) return 10;  // Premium models
    if (price > 3) return 9;
    if (price > 1) return 8;
    if (ctx > 100000) return 8;
    if (price > 0.5) return 7;
    if (price > 0.1) return 6;
    return 5;
  }

  _estimateSpeed(model) {
    // Heuristic: smaller models and lower context = faster
    const price = parseFloat(model.pricing?.prompt || '0') * 1_000_000;
    if (price < 0.2) return 10;
    if (price < 0.5) return 9;
    if (price < 1.5) return 8;
    if (price < 5) return 7;
    if (price < 15) return 6;
    return 5;
  }

  /**
   * Resets all usage tracking data. Call between runs.
   */
  resetUsage() {
    this._usageLog = [];
    this._roleStats.clear();
    this._totalCostUsd = 0;
    this._budgetWarned = false;
  }
}

// Attach shared HTTP helpers
Object.assign(LLMCostRouterAdapter.prototype, HttpMixin);

module.exports = { LLMCostRouterAdapter, FALLBACK_PRICING, ROLE_PROFILES };
