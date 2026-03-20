/**
 * Web Search Helpers
 *
 * Extracted from context-budget-manager.js (P0 decomposition – ADR-33).
 * Contains: web search cache, webSearchHelper, formatWebSearchBlock, externalExperienceFallback
 */

'use strict';

// ─── Web Search Cache ────────────────────────────────────────────────────────

const _webSearchCache = new Map();
const WEB_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const WEB_SEARCH_CACHE_MAX_SIZE = 50; // R4-3 audit: cap cache entries to prevent memory growth

/**
 * R4-3 audit: Evict expired entries from _webSearchCache.
 * Called before each insertion to prevent unbounded memory growth
 * in long-running IDE processes.
 */
function _evictExpiredWebSearchCache() {
  const now = Date.now();
  for (const [key, entry] of _webSearchCache) {
    if (now - entry.timestamp > WEB_SEARCH_CACHE_TTL_MS) {
      _webSearchCache.delete(key);
    }
  }
  // Hard cap: if still over limit, evict oldest entries
  if (_webSearchCache.size > WEB_SEARCH_CACHE_MAX_SIZE) {
    const entries = [..._webSearchCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, _webSearchCache.size - WEB_SEARCH_CACHE_MAX_SIZE);
    for (const [key] of toRemove) {
      _webSearchCache.delete(key);
    }
  }
}

function _normaliseCacheKey(query) {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─── Web Search Helper ───────────────────────────────────────────────────────

/**
 * Unified helper to perform a web search via the WebSearchAdapter.
 * Handles MCPRegistry lookup, connection check, caching, and error recovery.
 *
 * @param {Orchestrator} orch
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.maxResults=3]
 * @param {string} [opts.label='WebSearch']
 * @param {boolean} [opts.noCache=false]
 * @returns {Promise<{provider: string, results: Array}|null>}
 */
async function webSearchHelper(orch, query, opts = {}) {
  const { maxResults = 3, label = 'WebSearch', noCache = false } = opts;
  try {
    if (!orch.services || !orch.services.has('mcpRegistry')) return null;
    const registry = orch.services.resolve('mcpRegistry');
    const wsAdapter = registry.get('websearch');
    if (!wsAdapter) return null;

    const cacheKey = _normaliseCacheKey(query);
    if (!noCache) {
      const cached = _webSearchCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < WEB_SEARCH_CACHE_TTL_MS) {
        console.log(`[Orchestrator] \uD83C\uDF10 ${label}: cache hit (${cached.result.results.length} result(s), age ${Math.round((Date.now() - cached.timestamp) / 1000)}s).`);
        return cached.result;
      }
    }

    const result = await wsAdapter.search(query, { maxResults });
    if (result && result.results && result.results.length > 0) {
      console.log(`[Orchestrator] \uD83C\uDF10 ${label}: ${result.results.length} result(s) (provider: ${result.provider}).`);
      _evictExpiredWebSearchCache(); // R4-3: clean expired entries before adding new ones
      _webSearchCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    }
    console.log(`[Orchestrator] \uD83C\uDF10 ${label}: no results found.`);
    return null;
  } catch (err) {
    console.warn(`[Orchestrator] \uD83C\uDF10 ${label} failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Formats web search results into a Markdown block.
 *
 * @param {object} searchResult
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.guidance]
 * @param {number} [opts.snippetLimit=300]
 * @returns {string}
 */
function formatWebSearchBlock(searchResult, opts = {}) {
  if (!searchResult || !searchResult.results || searchResult.results.length === 0) return '';
  const { title = 'Web Research', guidance = '', snippetLimit = 300 } = opts;
  const formatted = searchResult.results.map((r, i) =>
    `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${(r.snippet || '').slice(0, snippetLimit)}`
  ).join('\n\n');
  return [
    `## \uD83C\uDF10 ${title}`,
    guidance ? `> ${guidance}` : '',
    ``,
    formatted,
  ].filter(Boolean).join('\n');
}

// ─── External Experience Fallback (Cold-start Enhancement) ───────────────────

/**
 * When the local ExperienceStore has no entries for a given skill,
 * search the web for common pitfalls and best practices.
 *
 * @param {Orchestrator} orch
 * @param {string} skill
 * @param {string} requirement
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
async function externalExperienceFallback(orch, skill, requirement, opts = {}) {
  const { maxResults = 3 } = opts;
  try {
    const techTerms = (requirement || '').match(
      /\b(?:React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Koa|NestJS|Django|Flask|FastAPI|Spring\s?Boot|Laravel|Rails|Prisma|TypeORM|Sequelize|Mongoose|TailwindCSS|Bootstrap|Redis|MongoDB|PostgreSQL|MySQL|SQLite|GraphQL|gRPC|Socket\.io|WebSocket|Stripe|Auth0|Firebase|Supabase|Docker|Kubernetes|Terraform|Jest|Vitest|Playwright|Cypress|Mocha|pytest|unittest|Go|Rust|TypeScript|Python|Node\.js|Java|C#|\.NET)\b/gi
    ) || [];
    const uniqueTerms = [...new Set(techTerms.map(t => t.trim()))].slice(0, 4);

    const skillQueryMap = {
      'architecture-design': 'software architecture common pitfalls best practices',
      'code-development': 'coding best practices common mistakes anti-patterns',
      'test-report': 'testing best practices common test coverage mistakes',
    };
    const skillContext = skillQueryMap[skill] || `${skill} best practices pitfalls`;
    const techContext = uniqueTerms.length > 0 ? uniqueTerms.join(' ') : '';
    const searchQuery = `${techContext} ${skillContext}`.trim().slice(0, 200);

    console.log(`[Orchestrator] 🌐 External experience fallback (${skill}): searching "${searchQuery.slice(0, 80)}..."`);
    const searchResult = await webSearchHelper(orch, searchQuery, {
      maxResults,
      label: `External Experience (${skill})`,
    });

    if (searchResult) {
      // ── ADR-29: Persist high-quality external knowledge into Skill ──────
      // When the external search returns ≥3 results, the knowledge is valuable
      // enough to persist into the corresponding skill file (in addition to
      // the existing behaviour of injecting it into the prompt).
      if (searchResult.results && searchResult.results.length >= 3) {
        // Fire-and-forget: don't block the prompt pipeline for enrichment
        require('./skill-enrichment').enrichSkillFromExternalKnowledge(orch, skill, { maxSearchResults: 3, maxFetchPages: 2 })
          .then(r => {
            if (r.success) {
              console.log(`[Orchestrator] 🌐→📝 External experience persisted to skill "${skill}": ${r.sectionsAdded} entries`);
            }
          })
          .catch(() => { /* non-fatal */ });
      }

      return formatWebSearchBlock(searchResult, {
        title: 'External Experience (Cold-start Fallback)',
        guidance: 'The local experience store has no entries yet. The following web results provide common pitfalls and best practices from the community. **Treat these as external experience** — validate against the current project context before applying.',
      });
    }
    return '';
  } catch (err) {
    console.warn(`[Orchestrator] 🌐 External experience fallback failed (non-fatal): ${err.message}`);
    return '';
  }
}

module.exports = {
  webSearchHelper,
  formatWebSearchBlock,
  externalExperienceFallback,
};
