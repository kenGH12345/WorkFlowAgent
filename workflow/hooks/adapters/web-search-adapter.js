/**
 * WebSearchAdapter – provides web search and page fetching capabilities.
 *
 * Supports three providers:
 *   - 'tavily'  – Tavily Search API (best quality, requires API key)
 *   - 'brave'   – Brave Search API (generous free tier, requires API key)
 *   - 'fetch'   – Raw HTTP fetch (no API key needed, fetches page content directly)
 *
 * Usage:
 *   const adapter = new WebSearchAdapter({ provider: 'tavily', apiKey: 'tvly-xxx' });
 *   await adapter.connect();
 *   const results = await adapter.search('Node.js best practices');
 *   const page = await adapter.fetchPage('https://example.com');
 */

'use strict';

const { MCPAdapter, HttpMixin } = require('./base');

class WebSearchAdapter extends MCPAdapter {
  constructor(config = {}) {
    super('websearch', config);
    this.provider = config.provider || 'fetch';
    this.apiKey = config.apiKey || process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY || '';
    this.maxResults = config.maxResults || 5;
    this.timeout = config.timeout || 15000;

    // P2: Tool Use Examples — help LLMs construct accurate search queries
    this.addToolExample(
      'Search for best practices on a technology topic',
      { method: 'search', args: ['React Server Components best practices 2024', { maxResults: 5 }] },
      { provider: 'tavily', results: [{ title: 'RSC Guide', url: 'https://...', snippet: '...' }] }
    );
    this.addToolExample(
      'Fetch and extract content from a specific URL',
      { method: 'fetchPage', args: ['https://docs.example.com/api'] },
      { url: 'https://docs.example.com/api', content: '(extracted text content)', length: 5000 }
    );
  }

  async connect() {
    if (this.provider === 'tavily' && !this.apiKey) {
      console.warn(`[MCPAdapter:websearch] Tavily provider requires apiKey (config.apiKey or TAVILY_API_KEY env var).`);
      console.warn(`[MCPAdapter:websearch] Falling back to 'fetch' provider.`);
      this.provider = 'fetch';
    }
    if (this.provider === 'brave' && !this.apiKey) {
      console.warn(`[MCPAdapter:websearch] Brave provider requires apiKey (config.apiKey or BRAVE_API_KEY env var).`);
      console.warn(`[MCPAdapter:websearch] Falling back to 'fetch' provider.`);
      this.provider = 'fetch';
    }
    this._connected = true;
    console.log(`[MCPAdapter:websearch] Connected (provider: ${this.provider}).`);

    // Provider upgrade hint: when using the zero-config 'fetch' fallback, show a
    // one-time hint that higher-quality providers are available. The fetch backend
    // scrapes Bing/DuckDuckGo HTML which is fragile and lower quality. Tavily and
    // Brave provide structured JSON results with much better relevance.
    if (this.provider === 'fetch' && !WebSearchAdapter._upgradeHintShown) {
      WebSearchAdapter._upgradeHintShown = true;
      console.log(`[MCPAdapter:websearch] 💡 Upgrade tip: You're using the 'fetch' provider (HTML scraping fallback).`);
      console.log(`[MCPAdapter:websearch]    For significantly better search quality, configure a dedicated provider:`);
      console.log(`[MCPAdapter:websearch]    • Tavily (recommended): set TAVILY_API_KEY env var or mcp.webSearch.apiKey`);
      console.log(`[MCPAdapter:websearch]      Sign up free: https://tavily.com (1000 free queries/month)`);
      console.log(`[MCPAdapter:websearch]    • Brave Search: set BRAVE_API_KEY env var`);
      console.log(`[MCPAdapter:websearch]      Sign up free: https://brave.com/search/api (2000 free queries/month)`);
    }
  }

  /**
   * Search the web for a given query string.
   * @param {string} searchQuery
   * @param {object} [options]   - { maxResults, searchDepth }
   * @returns {Promise<{ results: Array<{ title: string, url: string, snippet: string }>, provider: string }>}
   */
  async search(searchQuery, options = {}) {
    this._assertConnected();
    const maxResults = options.maxResults || this.maxResults;
    switch (this.provider) {
      case 'tavily': return this._searchTavily(searchQuery, maxResults, options);
      case 'brave':  return this._searchBrave(searchQuery, maxResults);
      default:       return this._searchFetch(searchQuery, maxResults);
    }
  }

  /**
   * Fetch the text content of a specific URL.
   * @param {string} url
   * @param {object} [options] - { maxLength }
   */
  async fetchPage(url, options = {}) {
    this._assertConnected();
    const maxLength = options.maxLength || 8000;
    try {
      const response = await this._httpGet(url, {
        headers: { 'User-Agent': 'WorkFlowAgent/1.0 (Web Fetcher)' },
      });
      const text = this._extractTextFromHtml(response);
      const truncated = text.length > maxLength;
      return { url, content: text.slice(0, maxLength), contentLength: text.length, truncated };
    } catch (err) {
      console.warn(`[MCPAdapter:websearch] fetchPage failed for ${url}: ${err.message}`);
      return { url, content: '', contentLength: 0, truncated: false, error: err.message };
    }
  }

  async query(queryStr, params = {}) {
    this._assertConnected();
    if (params.url) return this.fetchPage(params.url, params);
    return this.search(queryStr, params);
  }

  async notify(event, payload) { /* no-op */ }

  // ── Private: Tavily Search ────────────────────────────────────────────────

  async _searchTavily(query, maxResults, options = {}) {
    const searchDepth = options.searchDepth || 'basic';
    try {
      const body = JSON.stringify({ query, max_results: maxResults, search_depth: searchDepth, include_answer: true });
      const data = await this._httpPost('https://api.tavily.com/search', body, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      });
      const parsed = JSON.parse(data);
      return {
        provider: 'tavily', answer: parsed.answer || '',
        results: (parsed.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: r.content || '', score: r.score || 0 })),
      };
    } catch (err) {
      console.warn(`[MCPAdapter:websearch] Tavily search failed: ${err.message}`);
      return { provider: 'tavily', answer: '', results: [], error: err.message };
    }
  }

  // ── Private: Brave Search ─────────────────────────────────────────────────

  async _searchBrave(query, maxResults) {
    try {
      const qs = new URLSearchParams({ q: query, count: String(maxResults) }).toString();
      const data = await this._httpGet(`https://api.search.brave.com/res/v1/web/search?${qs}`, {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': this.apiKey },
      });
      const parsed = JSON.parse(data);
      const webResults = (parsed.web && parsed.web.results) || [];
      return { provider: 'brave', results: webResults.map(r => ({ title: r.title || '', url: r.url || '', snippet: r.description || '' })) };
    } catch (err) {
      console.warn(`[MCPAdapter:websearch] Brave search failed: ${err.message}`);
      return { provider: 'brave', results: [], error: err.message };
    }
  }

  // ── Private: Fetch-based search (Bing HTML scrape, zero-API-key fallback) ──

  async _searchFetch(query, maxResults) {
    try {
      const qs = new URLSearchParams({ q: query, count: String(maxResults) }).toString();
      const html = await this._httpGet(`https://www.bing.com/search?${qs}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      const results = [];
      const blockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
      let blockMatch;
      while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
        const block = blockMatch[1];
        const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        const url = linkMatch[1];
        const title = linkMatch[2].replace(/<[^>]*>/g, '').trim();
        const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<div\s+class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = snippetMatch ? (snippetMatch[1] || '').replace(/<[^>]*>/g, '').trim() : '';
        if (url && title) results.push({ title, url, snippet });
      }
      if (results.length === 0) return this._searchDuckDuckGoFallback(query, maxResults);
      return { provider: 'fetch(bing)', results };
    } catch (err) {
      console.warn(`[MCPAdapter:websearch] Bing fetch search failed: ${err.message}, trying DuckDuckGo fallback...`);
      return this._searchDuckDuckGoFallback(query, maxResults);
    }
  }

  async _searchDuckDuckGoFallback(query, maxResults) {
    try {
      const qs = new URLSearchParams({ q: query }).toString();
      const html = await this._httpGet(`https://html.duckduckgo.com/html/?${qs}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      });
      const results = [];
      const blockRegex = /<div\s+class="result\s+results_links\s+results_links_deep\s+[^"]*"[^>]*>([\s\S]*?)(?=<div\s+class="result\s+results_links|$)/gi;
      let blockMatch;
      while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
        const block = blockMatch[0];
        if (block.includes('result--ad')) continue;
        const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        let url = linkMatch[1];
        if (url.includes('uddg=')) {
          try { const uddg = new URLSearchParams(url.includes('?') ? url.split('?')[1] : url).get('uddg'); if (uddg) url = decodeURIComponent(uddg); } catch (_) {}
        }
        if (url.includes('duckduckgo.com/y.js')) continue;
        const title = linkMatch[2].replace(/<[^>]*>/g, '').trim();
        const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '';
        if (url && title && !url.startsWith('//duckduckgo.com')) results.push({ title, url, snippet });
      }
      if (results.length === 0) {
        const linkRegex2 = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snippetRegex2 = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        let lm;
        while ((lm = linkRegex2.exec(html)) !== null && results.length < maxResults) {
          let url = lm[1];
          if (url.includes('duckduckgo.com/y.js')) continue;
          if (url.includes('uddg=')) { try { const uddg = new URLSearchParams(url.includes('?') ? url.split('?')[1] : url).get('uddg'); if (uddg) url = decodeURIComponent(uddg); } catch (_) {} }
          if (url.startsWith('//duckduckgo.com')) continue;
          const title = lm[2].replace(/<[^>]*>/g, '').trim();
          const sm = snippetRegex2.exec(html);
          const snippet = sm ? sm[1].replace(/<[^>]*>/g, '').trim() : '';
          if (url && title) results.push({ title, url, snippet });
        }
      }
      return { provider: 'fetch(ddg)', results };
    } catch (err) {
      console.warn(`[MCPAdapter:websearch] DuckDuckGo fallback also failed: ${err.message}`);
      return { provider: 'fetch', results: [], error: err.message };
    }
  }

  _extractTextFromHtml(html) {
    if (!html) return '';
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  }
}

// Attach shared HTTP helpers
Object.assign(WebSearchAdapter.prototype, HttpMixin);

// Static flag: ensures the provider upgrade hint is shown at most once per process
WebSearchAdapter._upgradeHintShown = false;

module.exports = { WebSearchAdapter };
