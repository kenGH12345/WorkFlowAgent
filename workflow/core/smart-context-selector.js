/**
 * SmartContextSelector — Dynamic context block selection for MCP adapter data.
 *
 * Problem: With 15+ MCP adapters injecting context blocks, the 60K char token budget
 * is nearly saturated. Low-priority blocks are frequently truncated or dropped, wasting
 * HTTP round-trip time for data the LLM never sees.
 *
 * Solution: Before each stage's parallel adapter calls, classify the project and task
 * into profiles. Each profile defines which adapter blocks are ESSENTIAL, USEFUL, or
 * IRRELEVANT. Irrelevant blocks are skipped entirely (saving HTTP calls), and useful
 * blocks get priority adjustments so the token budget is spent on the most relevant data.
 *
 * Signal sources (zero LLM calls, all local heuristics):
 *   1. workflow.config.js techStack field
 *   2. package.json / requirements.txt / Cargo.toml dependencies
 *   3. Requirement text keyword analysis
 *   4. Project file structure (presence of src/components, tests/, etc.)
 *
 * Usage:
 *   const selector = new SmartContextSelector(projectRoot, config);
 *   const profile = selector.classify(requirementText);
 *   // profile.projectType  → 'frontend' | 'backend' | 'fullstack' | 'mobile' | 'systems' | 'gamedev' | 'general'
 *   // profile.taskType     → 'feature' | 'bugfix' | 'performance' | 'security' | 'ui' | 'refactor' | 'docs' | 'general'
 *   // profile.shouldSkip('FIGMA_DESIGN')         → true/false
 *   // profile.getPriorityDelta('SECURITY_CVE')   → +10 / 0 / -15
 *   // profile.getActiveBlocks('ARCHITECT')        → Set of block labels to include
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { ideHasSemanticSearch } = require('./ide-detection');

// ─── Project Type Detection ──────────────────────────────────────────────────

/**
 * Frontend framework indicators in package.json dependencies.
 */
const FRONTEND_INDICATORS = new Set([
  'react', 'react-dom', 'vue', 'svelte', '@angular/core', 'next', 'nuxt',
  'gatsby', 'solid-js', '@sveltejs/kit', 'remix', 'astro', 'vite',
  'tailwindcss', '@mui/material', '@chakra-ui/react', 'antd',
  'storybook', '@storybook/react', 'styled-components', 'emotion',
]);

/**
 * Backend framework indicators in package.json dependencies.
 */
const BACKEND_INDICATORS = new Set([
  'express', 'fastify', 'koa', 'nestjs', '@nestjs/core', 'hapi',
  'mongoose', 'sequelize', 'prisma', '@prisma/client', 'typeorm',
  'pg', 'mysql2', 'redis', 'ioredis', 'bull', 'bullmq',
  'passport', 'jsonwebtoken', 'bcrypt', 'helmet', 'cors',
  'grpc', '@grpc/grpc-js', 'socket.io', 'ws',
]);

/**
 * Mobile framework indicators.
 */
const MOBILE_INDICATORS = new Set([
  'react-native', 'expo', '@react-navigation/native',
  'react-native-gesture-handler', 'react-native-reanimated',
]);

// ─── Task Type Keywords ──────────────────────────────────────────────────────

const TASK_TYPE_KEYWORDS = {
  ui: [
    /\bUI\b/i, /\buser\s*interface/i, /\bfrontend\b/i, /前端/, /界面/, /样式/,
    /\bCSS\b/, /\bstyl/i, /\blayout\b/i, /\bdesign\b/i, /\bcomponent\b/i, /组件/,
    /\bresponsive\b/i, /自适应/, /\btheme\b/i, /主题/, /\bicon\b/i, /图标/,
    /\bpage\b/i, /页面/, /\bwidget\b/i, /\bform\b/i, /表单/,
  ],
  performance: [
    /\bperformance\b/i, /性能/, /\boptimiz/i, /优化/, /\blatency\b/i, /延迟/,
    /\bcaching?\b/i, /缓存/, /\bbenchmark\b/i, /基准/, /\bprofile\b/i,
    /\bmemory\s*leak\b/i, /内存泄漏/, /\bCPU\b/, /\bthroughput\b/i, /吞吐/,
    /\bbottleneck\b/i, /瓶颈/, /\bscalability\b/i, /可扩展/,
  ],
  security: [
    /\bsecurity\b/i, /安全/, /\bvulnerabilit/i, /漏洞/, /\bCVE\b/,
    /\bauthenticat/i, /认证/, /\bauthoriz/i, /授权/, /\bencrypt/i, /加密/,
    /\bXSS\b/, /\bCSRF\b/, /\bSQL\s*injection\b/i, /注入/, /\bfirewall\b/i,
    /\bOWASP\b/, /\bpenetration\b/i, /渗透/, /\btoken\b/i, /\bOAuth\b/i,
  ],
  bugfix: [
    /\bbug\b/i, /\bfix\b/i, /\bdefect\b/i, /修复/, /修改/, /\berror\b/i,
    /错误/, /\bcrash\b/i, /崩溃/, /\bissue\b/i, /问题/,
    /\bregression\b/i, /回归/, /\bhotfix\b/i, /\bpatch\b/i,
  ],
  refactor: [
    /\brefactor\b/i, /重构/, /\brestructure\b/i, /\bcleanup\b/i, /清理/,
    /\bmodulariz/i, /模块化/, /\bdecouple\b/i, /解耦/, /\bextract\b/i,
    /抽取/, /\bsimplify\b/i, /简化/, /\bmigrat/i, /迁移/,
  ],
  docs: [
    /\bdocument/i, /文档/, /\bREADME\b/, /\bchangelog\b/i, /变更日志/,
    /\bAPI\s*doc/i, /\bJSDoc\b/i, /\bswagger\b/i, /\bOpenAPI\b/i,
  ],
};

// ─── Adapter Relevance Profiles ──────────────────────────────────────────────

/**
 * Defines how each adapter block relates to each (projectType × taskType) combination.
 *
 * Values:
 *   'essential'   → priority boost +15, always included
 *   'useful'      → no change (default priority)
 *   'low'         → priority reduced by -10
 *   'irrelevant'  → skip entirely (don't even make the HTTP call)
 *
 * Block names match BLOCK_PRIORITY keys in orchestrator-stage-helpers.js.
 */
const ADAPTER_RELEVANCE = {
  // ── Figma Design ──────────────────────────────────────────────────────────
  FIGMA_DESIGN: {
    _default: 'irrelevant',
    frontend:  { _default: 'useful', ui: 'essential' },
    fullstack: { _default: 'low', ui: 'useful' },
    mobile:    { _default: 'useful', ui: 'essential' },
  },

  // ── Security CVE ──────────────────────────────────────────────────────────
  SECURITY_CVE: {
    _default: 'useful',
    frontend:  { _default: 'useful', security: 'essential', ui: 'low' },
    backend:   { _default: 'essential', security: 'essential' },
    systems:   { _default: 'essential', security: 'essential' },
    gamedev:   { _default: 'low' },
  },

  // ── License Compliance ────────────────────────────────────────────────────
  LICENSE_COMPLIANCE: {
    _default: 'useful',
    gamedev:   { _default: 'low' },
    general:   { _default: 'low' },
  },

  // ── Package Registry ──────────────────────────────────────────────────────
  PACKAGE_REGISTRY: {
    _default: 'useful',
    systems:   { _default: 'low', security: 'useful' },
    gamedev:   { _default: 'low' },
  },

  // ── Code Quality ──────────────────────────────────────────────────────────
  CODE_QUALITY: {
    _default: 'useful',
    _taskOverrides: {
      refactor: 'essential',
      bugfix: 'essential',
      performance: 'essential',
      docs: 'low',
      ui: 'low',
    },
  },

  // ── CI Status ─────────────────────────────────────────────────────────────
  CI_STATUS: {
    _default: 'useful',
    _taskOverrides: {
      bugfix: 'essential',
      performance: 'useful',
      docs: 'irrelevant',
      ui: 'low',
    },
  },

  // ── Test Infra ────────────────────────────────────────────────────────────
  TEST_INFRA: {
    _default: 'useful',
    _taskOverrides: {
      performance: 'essential',
      bugfix: 'essential',
      docs: 'irrelevant',
      ui: 'low',
    },
  },

  // ── DocGen (Undocumented Exports) ─────────────────────────────────────────
  UNDOCUMENTED_EXPORTS: {
    _default: 'useful',
    _taskOverrides: {
      docs: 'essential',
      ui: 'low',
      performance: 'low',
      security: 'low',
    },
  },

  // ── LLM Cost Router ──────────────────────────────────────────────────────
  LLM_COST: {
    _default: 'useful',
    // Always useful regardless of project/task type — it's meta-information
  },

  // ── API Research (Web Search) ─────────────────────────────────────────────
  API_RESEARCH: {
    _default: 'useful',
    _taskOverrides: {
      docs: 'low',
      bugfix: 'useful',
      security: 'low',
    },
  },

  // ── Industry Research (Web Search) ────────────────────────────────────────
  INDUSTRY_RESEARCH: {
    _default: 'useful',
    _taskOverrides: {
      bugfix: 'low',
      docs: 'irrelevant',
      performance: 'low',
    },
  },

  // ── External Experience ───────────────────────────────────────────────────
  EXTERNAL_EXPERIENCE: {
    _default: 'useful',
    // Always useful as cold-start fallback — relevance is self-regulating
    // (only fires when local experience is empty)
  },

  // ── Code Graph (symbol index & search) ────────────────────────────────────
  // IDE-First principle (ADR-37): When running inside an IDE, the AI Agent
  // should prefer IDE-native tools (codebase_search, grep_search, view_code_item)
  // over CodeGraph search. CodeGraph remains valuable for unique capabilities
  // (hotspot analysis, module summary, reusable symbols) that the IDE doesn't provide.
  // Priority is automatically reduced when IDE is detected (see ContextProfile).
  CODE_GRAPH: {
    _default: 'essential',     // Essential when no IDE is available
    _taskOverrides: {
      docs: 'useful',          // Docs tasks don't need heavy code context
    },
  },

  // ── Test Best Practices (TESTER stage only) ───────────────────────────────
  TEST_BEST_PRACTICES: {
    _default: 'useful',
    _taskOverrides: {
      docs: 'irrelevant',
      ui: 'low',
    },
  },
};

/**
 * Priority delta values for each relevance level.
 */
const RELEVANCE_TO_DELTA = {
  essential:  +15,
  useful:       0,
  low:        -10,
  irrelevant: -Infinity, // Signal to skip entirely
};

// ─── SmartContextSelector Class ──────────────────────────────────────────────

class SmartContextSelector {
  /**
   * @param {string} projectRoot - Project root directory
   * @param {object} [config]    - workflow.config.js contents (optional, auto-loaded if null)
   */
  constructor(projectRoot, config = null) {
    this.projectRoot = projectRoot;
    this._config = config;
    this._cachedProfile = null;
  }

  /**
   * Classifies the project and current task to produce a ContextProfile.
   * Results are cached per (projectRoot + requirementText hash) — safe within a single run.
   *
   * @param {string} requirementText - The current task/requirement text
   * @returns {ContextProfile}
   */
  classify(requirementText) {
    const reqHash = _simpleHash(requirementText || '');

    // Return cached profile if requirement hasn't changed
    if (this._cachedProfile && this._cachedProfile._reqHash === reqHash) {
      return this._cachedProfile;
    }

    const projectType = this._detectProjectType();
    const taskType = this._detectTaskType(requirementText || '');

    console.log(`[SmartContext] 🧠 Project type: ${projectType}, Task type: ${taskType}`);

    const profile = new ContextProfile(projectType, taskType, reqHash);
    this._cachedProfile = profile;
    return profile;
  }

  /**
   * Detects the project type from file system signals.
   * @returns {'frontend' | 'backend' | 'fullstack' | 'mobile' | 'systems' | 'gamedev' | 'general'}
   */
  _detectProjectType() {
    const root = this.projectRoot;
    const configTechStack = (this._config && this._config.techStack) || '';

    // Unity / Game development
    if (configTechStack.toLowerCase().includes('unity') ||
        configTechStack.toLowerCase().includes('game') ||
        fs.existsSync(path.join(root, 'Assets')) && fs.existsSync(path.join(root, 'Packages'))) {
      return 'gamedev';
    }

    // Rust / Go / C++ → systems
    if (configTechStack.toLowerCase().includes('rust') ||
        configTechStack.toLowerCase().includes('c++') ||
        fs.existsSync(path.join(root, 'Cargo.toml'))) {
      return 'systems';
    }

    // Config techStack string analysis (e.g. "React + TypeScript", "Express + Node.js")
    const tsLower = configTechStack.toLowerCase();
    const FRONTEND_TS_KEYWORDS = ['react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt', 'gatsby', 'tailwind'];
    const BACKEND_TS_KEYWORDS = ['express', 'fastify', 'koa', 'nestjs', 'django', 'flask', 'fastapi', 'spring', 'laravel', 'rails'];
    const MOBILE_TS_KEYWORDS = ['flutter', 'react native', 'expo', 'swift', 'kotlin'];
    const hasTsFrontend = FRONTEND_TS_KEYWORDS.some(k => tsLower.includes(k));
    const hasTsBackend = BACKEND_TS_KEYWORDS.some(k => tsLower.includes(k));
    const hasTsMobile = MOBILE_TS_KEYWORDS.some(k => tsLower.includes(k));
    if (hasTsMobile) return 'mobile';
    if (hasTsFrontend && hasTsBackend) return 'fullstack';
    if (hasTsFrontend) return 'frontend';
    if (hasTsBackend) return 'backend';

    // Check package.json for frontend/backend/mobile/fullstack
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

        const hasFrontend = allDeps.some(d => FRONTEND_INDICATORS.has(d));
        const hasBackend  = allDeps.some(d => BACKEND_INDICATORS.has(d));
        const hasMobile   = allDeps.some(d => MOBILE_INDICATORS.has(d));

        if (hasMobile) return 'mobile';
        if (hasFrontend && hasBackend) return 'fullstack';
        if (hasFrontend) return 'frontend';
        if (hasBackend)  return 'backend';
      } catch (_) { /* ignore parse errors */ }
    }

    // Python backend detection
    if (fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'))) {
      return 'backend';
    }

    // Go backend detection
    if (fs.existsSync(path.join(root, 'go.mod'))) {
      return 'backend';
    }

    // Java backend detection
    if (fs.existsSync(path.join(root, 'pom.xml')) || fs.existsSync(path.join(root, 'build.gradle'))) {
      return 'backend';
    }

    // Flutter / Dart → mobile
    if (fs.existsSync(path.join(root, 'pubspec.yaml'))) {
      return 'mobile';
    }

    return 'general';
  }

  /**
   * Detects the task type from the requirement text via keyword matching.
   * Uses a scoring system — the category with the most keyword hits wins.
   *
   * P1-4 fix: pre-compiled regex patterns are used directly instead of creating
   * new RegExp objects with 'g' flag on each call. The previous approach of
   * `new RegExp(pattern.source, pattern.flags + 'g')` caused unbounded regex
   * compilation and potential performance issues on large requirement texts.
   *
   * @param {string} text - Requirement / task description text
   * @returns {'feature' | 'bugfix' | 'performance' | 'security' | 'ui' | 'refactor' | 'docs' | 'general'}
   */
  _detectTaskType(text) {
    if (!text || text.length < 5) return 'general';

    const scores = {};
    for (const [type, patterns] of Object.entries(TASK_TYPE_KEYWORDS)) {
      scores[type] = 0;
      for (const pattern of patterns) {
        // P1-4 fix: use test() for simple match check instead of creating new
        // global RegExp and calling match(). test() is faster and avoids creating
        // match result arrays. For counting multiple hits, use a while loop
        // with exec() on a fresh global regex only when test() succeeds.
        if (pattern.test(text)) {
          // Count occurrences with a global regex only after confirming a match
          const globalRe = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
          const matches = text.match(globalRe);
          scores[type] += matches ? matches.length : 1;
        }
      }
    }

    // Find the highest scoring type
    let bestType = 'general';
    let bestScore = 0;
    for (const [type, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }

    // Require at least 2 keyword hits to avoid false positives
    // (e.g. a single mention of "fix" shouldn't classify the whole task as "bugfix")
    if (bestScore < 2) return 'general';

    // If "feature" is not explicitly scored but no other type won, default to "feature"
    return bestType;
  }
}

// ─── ContextProfile Class ────────────────────────────────────────────────────

/**
 * Immutable profile produced by SmartContextSelector.classify().
 * Provides per-block decisions: skip, priority delta, active blocks per stage.
 */
class ContextProfile {
  /**
   * @param {'frontend' | 'backend' | 'fullstack' | 'mobile' | 'systems' | 'gamedev' | 'general'} projectType
   * @param {'feature' | 'bugfix' | 'performance' | 'security' | 'ui' | 'refactor' | 'docs' | 'general'} taskType
   * @param {string} reqHash
   */
  constructor(projectType, taskType, reqHash) {
    this.projectType = projectType;
    this.taskType = taskType;
    this._reqHash = reqHash;

    // Pre-compute relevance map for all known adapter blocks
    /** @type {Map<string, string>} blockName → 'essential' | 'useful' | 'low' | 'irrelevant' */
    this._relevanceMap = new Map();
    for (const [blockName, rules] of Object.entries(ADAPTER_RELEVANCE)) {
      this._relevanceMap.set(blockName, _resolveRelevance(rules, projectType, taskType));
    }

    // ── IDE-First adjustment (ADR-37) ──────────────────────────────────────
    // When running inside an IDE with semantic search, CodeGraph's search
    // results are less important (Agent should use codebase_search instead).
    // However, CodeGraph's unique capabilities (hotspot, module summary,
    // reusable symbols digest) are still valuable and always injected.
    // We reduce CODE_GRAPH priority from 'essential' to 'useful' so that
    // if token budget is tight, IDE-provided search results take precedence.
    try {
      if (ideHasSemanticSearch()) {
        const currentRelevance = this._relevanceMap.get('CODE_GRAPH');
        if (currentRelevance === 'essential') {
          this._relevanceMap.set('CODE_GRAPH', 'useful');
          console.log(`[SmartContext] 🏠 IDE semantic search detected — CodeGraph priority reduced to 'useful' (fallback role)`);
        }
      }
    } catch (_) { /* IDE detection failure is non-fatal */ }
  }

  /**
   * Whether the given adapter block should be skipped entirely (don't make the HTTP call).
   * @param {string} blockName - BLOCK_PRIORITY key (e.g. 'FIGMA_DESIGN', 'SECURITY_CVE')
   * @returns {boolean}
   */
  shouldSkip(blockName) {
    const relevance = this._relevanceMap.get(blockName) || 'useful';
    return relevance === 'irrelevant';
  }

  /**
   * Gets the priority delta for a given block.
   * @param {string} blockName
   * @returns {number} Positive = boost, negative = demote, 0 = no change
   */
  getPriorityDelta(blockName) {
    const relevance = this._relevanceMap.get(blockName) || 'useful';
    return RELEVANCE_TO_DELTA[relevance] ?? 0;
  }

  /**
   * Gets the relevance level for a given block.
   * @param {string} blockName
   * @returns {'essential' | 'useful' | 'low' | 'irrelevant'}
   */
  getRelevance(blockName) {
    return this._relevanceMap.get(blockName) || 'useful';
  }

  /**
   * Adjusts an array of labelled blocks in-place:
   *   - Removes blocks that should be skipped (relevance = 'irrelevant')
   *   - Adjusts priority values based on the profile
   *
   * @param {Array<{label: string, content: string, priority: number, _order: number}>} blocks
   * @returns {Array<{label: string, content: string, priority: number, _order: number}>} Filtered blocks
   */
  applyToBlocks(blocks) {
    const stats = { boosted: [], demoted: [], skipped: [] };

    const filtered = blocks.filter(block => {
      // Map label → BLOCK_PRIORITY key
      const blockKey = _labelToBlockKey(block.label);
      if (!blockKey) return true; // Unknown block, keep as-is

      const relevance = this._relevanceMap.get(blockKey);
      if (!relevance) return true; // No rule for this block, keep as-is

      if (relevance === 'irrelevant') {
        stats.skipped.push(block.label);
        return false; // Remove from array
      }

      const delta = RELEVANCE_TO_DELTA[relevance] ?? 0;
      if (delta !== 0) {
        block.priority += delta;
        if (delta > 0) stats.boosted.push(`${block.label}(+${delta})`);
        if (delta < 0) stats.demoted.push(`${block.label}(${delta})`);
      }

      return true;
    });

    // Log adjustments
    if (stats.skipped.length > 0 || stats.boosted.length > 0 || stats.demoted.length > 0) {
      const parts = [];
      if (stats.boosted.length > 0) parts.push(`boosted=[${stats.boosted.join(',')}]`);
      if (stats.demoted.length > 0) parts.push(`demoted=[${stats.demoted.join(',')}]`);
      if (stats.skipped.length > 0) parts.push(`skipped=[${stats.skipped.join(',')}]`);
      console.log(`[SmartContext] 📊 Block adjustments: ${parts.join(', ')}`);
    }

    return filtered;
  }

  /**
   * Returns a summary string for logging.
   * @returns {string}
   */
  toString() {
    const essentials = [];
    const skips = [];
    for (const [block, relevance] of this._relevanceMap.entries()) {
      if (relevance === 'essential') essentials.push(block);
      if (relevance === 'irrelevant') skips.push(block);
    }
    return `ContextProfile(project=${this.projectType}, task=${this.taskType}, essential=[${essentials.join(',')}], skip=[${skips.join(',')}])`;
  }
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Resolves the relevance level for a block given the project type and task type.
 * Lookup order:
 *   1. ADAPTER_RELEVANCE[block][projectType][taskType]
 *   2. ADAPTER_RELEVANCE[block][projectType]._default
 *   3. ADAPTER_RELEVANCE[block]._taskOverrides[taskType]
 *   4. ADAPTER_RELEVANCE[block]._default
 *
 * @param {object} rules
 * @param {string} projectType
 * @param {string} taskType
 * @returns {'essential' | 'useful' | 'low' | 'irrelevant'}
 */
function _resolveRelevance(rules, projectType, taskType) {
  // Check project-specific rules
  const projectRules = rules[projectType];
  if (projectRules && typeof projectRules === 'object') {
    // Check project + task combo
    if (projectRules[taskType]) return projectRules[taskType];
    // Check project default
    if (projectRules._default) return projectRules._default;
  }

  // Check task-only overrides (project-agnostic)
  if (rules._taskOverrides && rules._taskOverrides[taskType]) {
    return rules._taskOverrides[taskType];
  }

  // Global default
  return rules._default || 'useful';
}

/**
 * Maps a human-readable block label to its BLOCK_PRIORITY key.
 *
 * P1-7 fix: previously this was a hardcoded MAP object that silently failed
 * for any new adapter block label not explicitly listed. Now it also attempts
 * automatic derivation: uppercase, replace spaces with underscores.
 * This makes the mapping self-extending for new adapters.
 *
 * @param {string} label
 * @returns {string|null}
 */
function _labelToBlockKey(label) {
  const MAP = {
    'Figma Design':        'FIGMA_DESIGN',
    'Security CVE':        'SECURITY_CVE',
    'License Compliance':  'LICENSE_COMPLIANCE',
    'Package Registry':    'PACKAGE_REGISTRY',
    'Code Quality':        'CODE_QUALITY',
    'CI Status':           'CI_STATUS',
    'Test Infra':          'TEST_INFRA',
    'Undocumented Exports': 'UNDOCUMENTED_EXPORTS',
    'LLM Cost':            'LLM_COST',
    'API Research':        'API_RESEARCH',
    'Industry Research':   'INDUSTRY_RESEARCH',
    'External Experience': 'EXTERNAL_EXPERIENCE',
    'Test Best Practices': 'TEST_BEST_PRACTICES',
    'Real Execution':      'REAL_EXECUTION',
    'Code Graph':          'CODE_GRAPH',
    'Upstream Context':    'UPSTREAM_CTX',
    'Experience':          'EXPERIENCE',
    'Complaints':          'COMPLAINTS',
  };
  // P1-7 fix: fallback to automatic derivation for unknown labels
  return MAP[label] || label.toUpperCase().replace(/\s+/g, '_') || null;
}

/**
 * Simple non-crypto hash for cache keying.
 * @param {string} str
 * @returns {string}
 */
function _simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32-bit integer
  }
  return String(hash);
}

module.exports = {
  SmartContextSelector,
  ContextProfile,
  // Exported for testing
  ADAPTER_RELEVANCE,
  TASK_TYPE_KEYWORDS,
  FRONTEND_INDICATORS,
  BACKEND_INDICATORS,
  MOBILE_INDICATORS,
  _resolveRelevance,
  _labelToBlockKey,
};
