/**
 * Adapter Plugin Registry — Decoupled adapter injection via self-describing plugins.
 *
 * PROBLEM: Adding a new MCP adapter previously required modifying 6 files:
 *   1. adapters/xxx-adapter.js  — adapter implementation
 *   2. adapters/index.js         — require + re-export
 *   3. hooks/mcp-adapter.js      — facade re-export
 *   4. workflow/index.js          — new XxxAdapter() + mcpRegistry.register()
 *   5. context-budget-manager.js  — xxxHelper() function + module.exports
 *   6. architect/developer/tester-context-builder.js — import + promise + labelledBlocks
 *
 * SOLUTION: Each adapter declares a **context plugin manifest** that describes:
 *   - Which stages it injects into (ARCHITECT / DEVELOPER / TESTER)
 *   - Its block priority (from BLOCK_PRIORITY constants)
 *   - Its SmartContext key (for dynamic skip/boost decisions)
 *   - Its helper function (async (orch, opts) => { block, ... })
 *
 * Adding a new adapter now requires ONLY:
 *   1. Create the adapter file (adapters/xxx-adapter.js)
 *   2. Create a plugin file (plugins/xxx-plugin.js) — or embed manifest in adapter
 *   3. Done. The plugin is auto-discovered and injected.
 *
 * ARCHITECTURE:
 *   ┌─────────────────────┐     ┌──────────────────────────────┐
 *   │  AdapterPlugin      │────▶│  AdapterPluginRegistry       │
 *   │  { name, label,     │     │  .register(plugin)           │
 *   │    stages, priority, │     │  .getPluginsForStage(stage)  │
 *   │    smartContextKey,  │     │  .collectPluginBlocks(orch,  │
 *   │    helperFn }        │     │    stage, profile)           │
 *   └─────────────────────┘     └──────────────────────────────┘
 *                                            │
 *                        ┌───────────────────┼───────────────────┐
 *                        ▼                   ▼                   ▼
 *                  ARCHITECT           DEVELOPER             TESTER
 *                  context             context               context
 *                  builder             builder               builder
 *
 * Design: The registry is a pure in-memory data structure. Plugin registration
 * is synchronous. Block collection is async (parallel adapter calls).
 * SmartContext integration is built-in — plugins that should be skipped are
 * filtered out before any HTTP calls are made.
 */

'use strict';

const { BLOCK_PRIORITY } = require('./context-budget-manager');

// ─── Plugin Schema ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} AdapterPlugin
 * @property {string} name              - Unique plugin name (e.g. 'security-cve')
 * @property {string} label             - Human-readable block label (e.g. 'Security CVE')
 * @property {string[]} stages          - Stages to inject into: ['ARCHITECT','DEVELOPER','TESTER']
 * @property {number} priority          - Block priority from BLOCK_PRIORITY
 * @property {string} smartContextKey   - Key for SmartContextSelector (e.g. 'SECURITY_CVE')
 * @property {Function} helperFn        - async (orch, opts) => { block: string, ...metadata }
 * @property {object} [stageOpts]       - Per-stage options override: { ARCHITECT: {...}, DEVELOPER: {...} }
 * @property {boolean} [enabled=true]   - Master switch (set to false to disable without removing)
 * @property {string[]} [keywords]      - Requirement keywords that signal relevance (P1 Tool Search optimisation)
 * @property {boolean} [alwaysLoad=false] - If true, skip keyword-based pre-filter (always load this plugin)
 */

/**
 * Validates a plugin manifest.
 * @param {AdapterPlugin} plugin
 * @throws {Error} if invalid
 */
function validatePlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error('[AdapterPluginRegistry] Plugin must be an object');
  }
  const required = ['name', 'label', 'stages', 'priority', 'smartContextKey', 'helperFn'];
  for (const field of required) {
    if (plugin[field] == null) {
      throw new Error(`[AdapterPluginRegistry] Plugin "${plugin.name || 'unknown'}" missing required field: ${field}`);
    }
  }
  if (!Array.isArray(plugin.stages) || plugin.stages.length === 0) {
    throw new Error(`[AdapterPluginRegistry] Plugin "${plugin.name}" must declare at least one stage`);
  }
  const validStages = ['ARCHITECT', 'PLAN', 'DEVELOPER', 'TESTER'];
  for (const stage of plugin.stages) {
    if (!validStages.includes(stage)) {
      throw new Error(`[AdapterPluginRegistry] Plugin "${plugin.name}" has invalid stage: "${stage}". Valid: ${validStages.join(', ')}`);
    }
  }
  if (typeof plugin.priority !== 'number' || plugin.priority < 0 || plugin.priority > 100) {
    throw new Error(`[AdapterPluginRegistry] Plugin "${plugin.name}" priority must be 0-100, got ${plugin.priority}`);
  }
  if (typeof plugin.helperFn !== 'function') {
    throw new Error(`[AdapterPluginRegistry] Plugin "${plugin.name}" helperFn must be a function`);
  }
}

// ─── Plugin Registry ────────────────────────────────────────────────────────

class AdapterPluginRegistry {
  constructor() {
    /** @type {Map<string, AdapterPlugin>} */
    this._plugins = new Map();

    /** @type {Map<string, AdapterPlugin[]>} stage → sorted plugin list (cache) */
    this._stageCache = new Map();
  }

  /**
   * Registers a context plugin.
   * @param {AdapterPlugin} plugin
   */
  register(plugin) {
    validatePlugin(plugin);
    if (this._plugins.has(plugin.name)) {
      console.warn(`[AdapterPluginRegistry] Overwriting existing plugin: "${plugin.name}"`);
    }
    this._plugins.set(plugin.name, { enabled: true, stageOpts: {}, ...plugin });
    this._stageCache.clear(); // Invalidate cache
    console.log(`[AdapterPluginRegistry] ✅ Registered plugin: "${plugin.name}" → stages=[${plugin.stages.join(',')}], priority=${plugin.priority}`);
  }

  /**
   * Unregisters a plugin by name.
   * @param {string} name
   * @returns {boolean}
   */
  unregister(name) {
    const existed = this._plugins.delete(name);
    if (existed) {
      this._stageCache.clear();
      console.log(`[AdapterPluginRegistry] ❌ Unregistered plugin: "${name}"`);
    }
    return existed;
  }

  /**
   * Returns all enabled plugins for a given stage, sorted by priority descending.
   * @param {string} stage - 'ARCHITECT' | 'DEVELOPER' | 'TESTER'
   * @returns {AdapterPlugin[]}
   */
  getPluginsForStage(stage) {
    if (this._stageCache.has(stage)) {
      return this._stageCache.get(stage);
    }
    const plugins = [];
    for (const plugin of this._plugins.values()) {
      if (plugin.enabled !== false && plugin.stages.includes(stage)) {
        plugins.push(plugin);
      }
    }
    // Sort by priority descending (higher priority first)
    plugins.sort((a, b) => b.priority - a.priority);
    this._stageCache.set(stage, plugins);
    return plugins;
  }

  /**
   * Returns all registered plugin names.
   * @returns {string[]}
   */
  getPluginNames() {
    return [...this._plugins.keys()];
  }

  /**
   * Gets a plugin by name.
   * @param {string} name
   * @returns {AdapterPlugin|undefined}
   */
  get(name) {
    return this._plugins.get(name);
  }

  /**
   * Returns the count of registered plugins.
   * @returns {number}
   */
  get size() {
    return this._plugins.size;
  }

  // ─── Block Collection (Core Orchestration) ──────────────────────────────

  /**
   * Collects context blocks from all plugins registered for a given stage.
   * Executes all plugin helpers in parallel, respects SmartContext skip decisions
   * AND keyword-based pre-filtering (P1 Tool Search optimisation),
   * and returns labelled blocks ready for _applyTokenBudget().
   *
   * P1 Tool Search Optimisation:
   *   Plugins can declare a `keywords` array. If the current requirement text
   *   does NOT match any of the plugin's keywords, the plugin's helperFn is
   *   skipped entirely — saving HTTP round-trips, API calls, and token budget.
   *   Plugins with `alwaysLoad: true` or no `keywords` array bypass this filter.
   *
   * @param {object} orch - Orchestrator instance
   * @param {string} stage - 'ARCHITECT' | 'DEVELOPER' | 'TESTER'
   * @param {object|null} profile - ContextProfile from SmartContextSelector
   * @param {number} startOrder - Starting _order index for block ordering
   * @returns {Promise<{blocks: Array<{label:string, content:string, priority:number, _order:number}>, elapsed: number, skippedByKeyword: string[]}>}
   */
  async collectPluginBlocks(orch, stage, profile = null, startOrder = 100) {
    const plugins = this.getPluginsForStage(stage);
    if (plugins.length === 0) {
      return { blocks: [], elapsed: 0, skippedByKeyword: [] };
    }

    // P1 Tool Search: extract requirement text for keyword pre-filtering
    const requirementText = (orch._currentRequirement || '').toLowerCase();
    const skippedByKeyword = [];

    const parallelStart = Date.now();

    // Create parallel promises for each plugin
    const promises = plugins.map(async (plugin, idx) => {
      try {
        // P1 Tool Search: keyword-based pre-filter
        // If a plugin declares keywords and the requirement doesn't mention any,
        // skip the plugin entirely — don't even make the HTTP/API call.
        if (!plugin.alwaysLoad && plugin.keywords && plugin.keywords.length > 0 && requirementText.length > 0) {
          const hasRelevantKeyword = plugin.keywords.some(kw => requirementText.includes(kw.toLowerCase()));
          if (!hasRelevantKeyword) {
            skippedByKeyword.push(plugin.name);
            console.log(`[ToolSearch] ⏭️  Skipping ${plugin.label} (no keyword match in requirement)`);
            return { label: plugin.label, content: '', priority: plugin.priority, _order: startOrder + idx };
          }
        }

        // SmartContext: check if this plugin should be skipped
        if (profile && profile.shouldSkip(plugin.smartContextKey)) {
          console.log(`[SmartContext] ⏭️  Skipping ${plugin.label} (irrelevant for ${profile.projectType}/${profile.taskType})`);
          return { label: plugin.label, content: '', priority: plugin.priority, _order: startOrder + idx };
        }

        // Get per-stage options
        const stageOpts = (plugin.stageOpts && plugin.stageOpts[stage]) || {};
        const opts = { ...stageOpts, label: `${plugin.label} (${stage})`, stage };

        // Execute the plugin helper
        const result = await plugin.helperFn(orch, opts);

        // Normalise result: plugins can return string or { block: string, ... }
        let content = '';
        if (typeof result === 'string') {
          content = result;
        } else if (result && typeof result === 'object') {
          content = result.block || result.content || '';
        }

        return {
          label: plugin.label,
          content,
          priority: plugin.priority,
          _order: startOrder + idx,
        };
      } catch (err) {
        console.warn(`[AdapterPluginRegistry] Plugin "${plugin.name}" failed for ${stage} (non-fatal): ${err.message}`);
        return { label: plugin.label, content: '', priority: plugin.priority, _order: startOrder + idx };
      }
    });

    const results = await Promise.allSettled(promises);
    const elapsed = Date.now() - parallelStart;

    const blocks = results.map(r =>
      r.status === 'fulfilled' ? r.value : { label: 'unknown', content: '', priority: 0, _order: 999 }
    );

    const activeCount = blocks.filter(b => b.content && b.content.length > 0).length;
    console.log(`[AdapterPluginRegistry] ⚡ ${stage}: ${plugins.length} plugin(s) executed in ${elapsed}ms (${activeCount} produced content${skippedByKeyword.length > 0 ? `, ${skippedByKeyword.length} skipped by keyword filter` : ''}).`);

    return { blocks, elapsed, skippedByKeyword };
  }
}

// ─── Built-in Plugin Definitions ─────────────────────────────────────────────

/**
 * Creates the standard set of adapter plugins from the existing helper functions.
 * This bridges the existing helper functions into the new plugin architecture
 * without requiring any changes to the adapter implementations.
 *
 * @returns {AdapterPlugin[]}
 */
function createBuiltinPlugins() {
  // Lazy-require to avoid circular dependency
  // (context-budget-manager → adapter-plugin-registry → context-budget-manager)
  const cbm = require('./context-budget-manager');

  return [
    // ─── Industry Research (web search for arch alternatives) ────────────
    {
      name: 'industry-research',
      label: 'Industry Research',
      stages: ['ARCHITECT'],
      priority: BLOCK_PRIORITY.INDUSTRY_RESEARCH,
      smartContextKey: 'INDUSTRY_RESEARCH',
      alwaysLoad: true, // Industry research is always valuable for architecture decisions
      helperFn: async (orch, opts) => {
        if (!orch.services || !orch.services.has('mcpRegistry')) return '';
        const registry = orch.services.resolve('mcpRegistry');
        let wsAdapter;
        try { wsAdapter = registry.get('websearch'); } catch (_) { return ''; }
        if (!wsAdapter) return '';
        const reqText = orch._currentRequirement || '';
        if (reqText.length <= 10) return '';
        const techTerms = reqText
          .replace(/[\n\r]+/g, ' ')
          .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s.,/-]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length >= 3)
          .slice(0, 15)
          .join(' ');
        const searchQuery = `best practices open source solution: ${techTerms}`.slice(0, 200);
        console.log(`[Orchestrator] 🌐 Industry research: searching web for: "${searchQuery.slice(0, 80)}..."`);
        const searchResult = await wsAdapter.search(searchQuery, { maxResults: 5 });
        if (searchResult && searchResult.results && searchResult.results.length > 0) {
          const formattedResults = searchResult.results.map((r, i) =>
            `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${(r.snippet || '').slice(0, 300)}`
          ).join('\n\n');
          console.log(`[Orchestrator] 🌐 Industry research: ${searchResult.results.length} result(s) injected (provider: ${searchResult.provider}).`);
          return {
            block: [
              `## 🌐 Industry Research Context (Web Search)`,
              `> The following results were obtained from a live web search to provide real-world context`,
              `> for Chapter 5 (Alternative Solutions) and Chapter 6 (Industry Research).`,
              `> **Use these as references** — cite relevant URLs, compare approaches, and evaluate applicability.`,
              `> Do NOT blindly copy; critically assess each solution's fit for the current requirement.`,
              ``,
              formattedResults,
            ].join('\n'),
          };
        }
        console.log(`[Orchestrator] 🌐 Industry research: no results found.`);
        return '';
      },
    },

    // ─── Package Registry ───────────────────────────────────────────────
    {
      name: 'package-registry',
      label: 'Package Registry',
      stages: ['ARCHITECT', 'DEVELOPER'],
      priority: BLOCK_PRIORITY.PACKAGE_REGISTRY,
      smartContextKey: 'PACKAGE_REGISTRY',
      keywords: ['package', 'dependency', 'npm', 'pip', 'cargo', 'install', 'version', 'upgrade', 'migrate', 'library', 'module', 'sdk', 'framework', '依赖', '包', '版本', '升级', '迁移', '库'],
      stageOpts: {
        ARCHITECT: { maxPackages: 12 },
        DEVELOPER: { maxPackages: 10, issuesOnly: true },
      },
      helperFn: async (orch, opts) => {
        const result = await cbm.packageRegistryHelper(orch, null, {
          maxPackages: opts.maxPackages || 12,
          label: opts.label || 'PackageRegistry',
        });
        if (!result) return '';
        // In DEVELOPER stage, only show if there are issues
        if (opts.issuesOnly && !result.hasIssues) return '';
        return result;
      },
    },

    // ─── Security CVE ───────────────────────────────────────────────────
    {
      name: 'security-cve',
      label: 'Security CVE',
      stages: ['ARCHITECT', 'DEVELOPER'],
      priority: BLOCK_PRIORITY.SECURITY_CVE,
      smartContextKey: 'SECURITY_CVE',
      keywords: ['security', 'cve', 'vulnerability', 'exploit', 'auth', 'encrypt', 'xss', 'csrf', 'injection', 'owasp', 'token', 'password', '安全', '漏洞', '认证', '授权', '加密', '注入'],
      stageOpts: {
        ARCHITECT: { maxPackages: 12 },
        DEVELOPER: { maxPackages: 10, vulnsOnly: true },
      },
      helperFn: async (orch, opts) => {
        const result = await cbm.securityCVEHelper(orch, null, {
          maxPackages: opts.maxPackages || 12,
          label: opts.label || 'SecurityCVE',
        });
        if (!result) return '';
        // In DEVELOPER stage, only show if there are vulns
        if (opts.vulnsOnly && result.totalVulns === 0) return '';
        return result;
      },
    },

    // ─── License Compliance ─────────────────────────────────────────────
    {
      name: 'license-compliance',
      label: 'License Compliance',
      stages: ['ARCHITECT'],
      priority: BLOCK_PRIORITY.LICENSE_COMPLIANCE,
      smartContextKey: 'LICENSE_COMPLIANCE',
      keywords: ['license', 'compliance', 'gpl', 'mit', 'apache', 'open source', 'copyright', 'legal', '许可', '合规', '版权', '开源'],
      helperFn: async (orch, opts) => {
        const result = await cbm.licenseComplianceHelper(orch, {
          label: opts.label || 'LicenseCompliance',
        });
        return (result && result.block) ? result : '';
      },
    },

    // ─── Figma Design ───────────────────────────────────────────────────
    {
      name: 'figma-design',
      label: 'Figma Design',
      stages: ['ARCHITECT', 'DEVELOPER'],
      priority: BLOCK_PRIORITY.FIGMA_DESIGN,
      smartContextKey: 'FIGMA_DESIGN',
      keywords: ['figma', 'design', 'ui', 'ux', 'mockup', 'prototype', 'layout', 'component', 'theme', 'style', 'css', '设计', '界面', '样式', '组件', '主题', '布局'],
      helperFn: async (orch, opts) => {
        const result = await cbm.figmaDesignHelper(orch, {
          label: opts.label || 'FigmaDesign',
        });
        return (result && result.block) ? result : '';
      },
    },

    // ─── API Research (web search for latest API changes) ───────────────
    {
      name: 'api-research',
      label: 'API Research',
      stages: ['DEVELOPER'],
      priority: BLOCK_PRIORITY.API_RESEARCH,
      smartContextKey: 'API_RESEARCH',
      keywords: ['api', 'rest', 'graphql', 'grpc', 'endpoint', 'swagger', 'openapi', 'http', 'websocket', 'sdk', 'integration', 'third-party', '接口', '集成', '第三方'],
      helperFn: async (orch, opts) => {
        const fs = require('fs');
        const path = require('path');
        const { PATHS } = require('./constants');
        const outputDir = orch._outputDir || PATHS.OUTPUT_DIR;
        const archPath = path.join(outputDir, 'architecture.md');
        if (!fs.existsSync(archPath)) return '';
        const archContent = fs.readFileSync(archPath, 'utf-8');
        const techMentions = [...new Set(
          (archContent.match(/\b(?:React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Koa|NestJS|Django|Flask|FastAPI|Spring\s?Boot|Laravel|Rails|Prisma|TypeORM|Sequelize|Mongoose|TailwindCSS|Bootstrap|Material[- ]UI|Chakra[- ]UI|Redis|MongoDB|PostgreSQL|MySQL|SQLite|GraphQL|gRPC|Socket\.io|WebSocket|Stripe|Auth0|Firebase|Supabase|Docker|Kubernetes|Terraform|AWS\s?SDK|Azure|GCP|Vite|Webpack|esbuild|Jest|Vitest|Playwright|Cypress|Storybook)\b/gi) || [])
            .map(t => t.trim())
        )].slice(0, 5);
        if (techMentions.length === 0) return '';
        const searchQuery = `${techMentions.join(' ')} latest API changes best practices 2024 2025`.slice(0, 200);
        console.log(`[Orchestrator] 🌐 API research: searching for: "${searchQuery.slice(0, 80)}..."`);
        const searchResult = await cbm.webSearchHelper(orch, searchQuery, {
          maxResults: 4,
          label: opts.label || 'API Research',
        });
        if (searchResult) {
          return {
            block: cbm.formatWebSearchBlock(searchResult, {
              title: 'Third-party Library API Research',
              guidance: 'The following web search results contain latest API documentation and best practices. **Use these to ensure you are using up-to-date APIs**. If any API has changed or been deprecated, adapt your code accordingly.',
            }),
          };
        }
        return '';
      },
    },

    // ─── Code Quality ───────────────────────────────────────────────────
    {
      name: 'code-quality',
      label: 'Code Quality',
      stages: ['DEVELOPER'],
      priority: BLOCK_PRIORITY.CODE_QUALITY,
      smartContextKey: 'CODE_QUALITY',
      keywords: ['quality', 'lint', 'sonar', 'refactor', 'clean', 'debt', 'smell', 'complexity', 'duplication', 'coverage', '质量', '重构', '规范', '复杂度'],
      helperFn: async (orch, opts) => {
        const result = await cbm.codeQualityHelper(orch, {
          maxIssues: opts.maxIssues || 15,
          label: opts.label || 'CodeQuality',
        });
        return (result && result.block) ? result : '';
      },
    },

    // ─── CI Status ──────────────────────────────────────────────────────
    {
      name: 'ci-status',
      label: 'CI Status',
      stages: ['DEVELOPER', 'TESTER'],
      priority: BLOCK_PRIORITY.CI_STATUS,
      smartContextKey: 'CI_STATUS',
      keywords: ['ci', 'cd', 'pipeline', 'build', 'deploy', 'github', 'gitlab', 'jenkins', 'action', 'workflow', '构建', '部署', '流水线'],
      helperFn: async (orch, opts) => {
        const result = await cbm.ciStatusHelper(orch, {
          label: opts.label || 'CIStatus',
        });
        return (result && result.block) ? result : '';
      },
    },

    // ─── Undocumented Exports (DocGen) ──────────────────────────────────
    {
      name: 'doc-gen',
      label: 'Undocumented Exports',
      stages: ['DEVELOPER'],
      priority: BLOCK_PRIORITY.UNDOCUMENTED_EXPORTS,
      smartContextKey: 'UNDOCUMENTED_EXPORTS',
      keywords: ['doc', 'document', 'jsdoc', 'tsdoc', 'readme', 'changelog', 'api doc', 'comment', 'export', '文档', '注释', '导出'],
      helperFn: async (orch, opts) => {
        const result = await cbm.docGenHelper(orch, {
          maxFiles: opts.maxFiles || 30,
          label: opts.label || 'DocGen',
        });
        return (result && result.block) ? result : '';
      },
    },

    // ─── Test Best Practices (web search) ───────────────────────────────
    {
      name: 'test-best-practices',
      label: 'Test Best Practices',
      stages: ['TESTER'],
      priority: BLOCK_PRIORITY.TEST_BEST_PRACTICES,
      smartContextKey: 'TEST_BEST_PRACTICES',
      alwaysLoad: true, // Always load for TESTER stage — test best practices are always relevant
      helperFn: async (orch, opts) => {
        const fs = require('fs');
        const path = require('path');
        const { PATHS } = require('./constants');
        const outputDir = orch._outputDir || PATHS.OUTPUT_DIR;
        const archPath = path.join(outputDir, 'architecture.md');
        if (!fs.existsSync(archPath)) return '';
        const archContent = fs.readFileSync(archPath, 'utf-8');
        const techMentions = [...new Set(
          (archContent.match(/\b(?:React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|NestJS|Django|Flask|FastAPI|Spring\s?Boot|Laravel|Rails|Jest|Vitest|Playwright|Cypress|Mocha|pytest|unittest|Storybook|Testing\s?Library|Supertest|Sinon|Chai|Go|Rust|TypeScript|Node\.js|Python|Java|C#|\.NET)\b/gi) || [])
            .map(t => t.trim())
        )].slice(0, 5);
        if (techMentions.length === 0) return '';
        const testSearchQuery = `${techMentions.join(' ')} testing best practices common mistakes test patterns 2024 2025`.slice(0, 200);
        console.log(`[Orchestrator] 🌐 Testing best practices: searching for: "${testSearchQuery.slice(0, 80)}..."`);
        const searchResult = await cbm.webSearchHelper(orch, testSearchQuery, {
          maxResults: 3,
          label: opts.label || 'Testing Best Practices',
        });
        if (searchResult) {
          return {
            block: cbm.formatWebSearchBlock(searchResult, {
              title: 'Testing Best Practices Reference',
              guidance: 'The following web results contain testing best practices for the project\'s tech stack. **Use these to improve test quality, coverage strategies, and assertion patterns**. Prioritise framework-idiomatic testing approaches.',
            }),
          };
        }
        return '';
      },
    },

    // ─── Test Infra ─────────────────────────────────────────────────────
    {
      name: 'test-infra',
      label: 'Test Infra',
      stages: ['TESTER'],
      priority: BLOCK_PRIORITY.TEST_INFRA,
      smartContextKey: 'TEST_INFRA',
      alwaysLoad: true, // Always load for TESTER stage — test infrastructure info is always needed
      helperFn: async (orch, opts) => {
        const result = await cbm.testInfraHelper(orch, {
          label: opts.label || 'TestInfra',
        });
        return (result && result.block) ? result : '';
      },
    },
  ];
}

module.exports = {
  AdapterPluginRegistry,
  createBuiltinPlugins,
  validatePlugin,
  BLOCK_PRIORITY,
};
