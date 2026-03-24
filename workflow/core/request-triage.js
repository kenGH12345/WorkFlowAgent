/**
 * RequestTriage – Intelligent Request Routing & Best Practice Enforcement
 *
 * Implements auto-detection of task complexity to route requests optimally:
 *   - Simple tasks → suggest IDE direct handling (skip workflow overhead)
 *   - Medium tasks → lightweight workflow mode (StageSmartSkip auto-skips stages)
 *   - Complex tasks → full pipeline (ANALYSE → ARCHITECT → PLAN → CODE → TEST)
 *
 * Also includes:
 *   - InitStateGuard: checks if /wf init has been run
 *   - StalenessDetector: checks if CodeGraph/project profile are outdated
 *
 * Design principles:
 *   - Zero LLM calls (pure rule engine, <1ms execution)
 *   - Always overridable via --force flag
 *   - MCP-friendly: results can be returned as MCP tool responses
 *
 * @module request-triage
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Complexity Scoring Signals ─────────────────────────────────────────────

/**
 * Scoring rules for request complexity assessment.
 * Positive scores indicate higher complexity; negative indicate simplicity.
 * Total score determines routing: <15 = IDE suggested, 15-40 = slim, >=40 = full.
 */
const SCORING_RULES = [
  // ── Simplicity signals (negative scores) ────────────────────────────────
  { test: (req) => req.length < 50,                           score: -10, tag: 'short_requirement' },
  { test: (req) => /\b(fix|typo|spelling|rename)\b|修复|拼写|重命名/i.test(req),  score: -15, tag: 'simple_fix' },
  { test: (req) => (/\b(update|change|tweak|adjust)\b|更新|改/i.test(req)) && req.length < 80, score: -8, tag: 'minor_update' },
  { test: (req) => (/\b(comment|doc|readme)\b|注释|文档/i.test(req)) && !(/\b(generate|create)\b|生成|创建/i.test(req)), score: -12, tag: 'doc_only' },
  { test: (req) => (/\b(remove|delete|drop)\b|删除/i.test(req)) && req.length < 60, score: -10, tag: 'simple_removal' },

  // ── Complexity signals (positive scores) ────────────────────────────────
  { test: (req) => /\b(refactor|redesign)\b|重构|重新设计/i.test(req),            score: 20, tag: 'refactor' },
  { test: (req) => /\b(new module|new feature|implement|build)\b|新模块|新功能|实现|构建/i.test(req), score: 15, tag: 'new_feature' },
  { test: (req) => /\b(API|endpoint|route)\b|接口|路由/i.test(req),               score: 10, tag: 'api_work' },
  { test: (req) => /\b(database|migration|schema)\b|数据库|迁移/i.test(req),       score: 10, tag: 'database' },
  { test: (req) => /\b(auth|OAuth|JWT|login|permission)\b|认证|登录|权限/i.test(req), score: 12, tag: 'auth' },
  { test: (req) => /\b(security|vulnerability|encrypt)\b|安全|漏洞|加密/i.test(req), score: 10, tag: 'security' },
  { test: (req) => /\b(performance|optimize|cache)\b|性能|优化|缓存/i.test(req),   score: 10, tag: 'performance' },
  { test: (req) => /\b(test|coverage|e2e|integration)\b|测试|覆盖率/i.test(req),   score: 8,  tag: 'testing' },
  { test: (req) => /\b(architecture|design pattern)\b|架构|设计模式/i.test(req),   score: 15, tag: 'architecture' },
  { test: (req) => req.length > 200,                                               score: 10, tag: 'long_requirement' },
  { test: (req) => req.length > 500,                                               score: 10, tag: 'very_long_requirement' },
  { test: (req) => /\band\b|和|同时|以及|并且/.test(req) && req.length > 100,      score: 15, tag: 'multi_concern' },
  { test: (req) => (req.match(/\b(module|component|service)\b|模块|组件|服务/gi) || []).length >= 2, score: 20, tag: 'multi_module' },
  { test: (req) => /\b(CI|CD|pipeline|deploy|docker|kubernetes|k8s)\b|部署/i.test(req), score: 10, tag: 'devops' },
  { test: (req) => /\b(cross-project|multi-repo|monorepo)\b|跨项目/i.test(req),   score: 15, tag: 'cross_project' },
];

// ─── Routing Thresholds ─────────────────────────────────────────────────────

const THRESHOLDS = {
  /** Below this score: suggest IDE direct handling */
  IDE_SUGGEST: 15,
  /** Below this score: lightweight workflow mode */
  SLIM_MODE: 40,
  /** At or above this: full pipeline */
  // FULL_MODE: implicit (>= SLIM_MODE)
};

// ─── Staleness Configuration ────────────────────────────────────────────────

const STALENESS = {
  /** Days after which CodeGraph is considered stale */
  CODE_GRAPH_MAX_AGE_DAYS: 14,
  /** Days after which project profile is considered stale */
  PROJECT_PROFILE_MAX_AGE_DAYS: 14,
  /** Minimum interval between init reminders (prevent nagging) */
  MIN_REMINDER_INTERVAL_MS: 60 * 60 * 1000, // 1 hour
};

// ─── RequestTriage Class ────────────────────────────────────────────────────

class RequestTriage {
  /**
   * @param {object} [opts]
   * @param {object} [opts.thresholds]    - Override default thresholds
   * @param {object} [opts.stalenessConfig] - Override staleness settings
   */
  constructor(opts = {}) {
    this._thresholds = { ...THRESHOLDS, ...(opts.thresholds || {}) };
    this._stalenessConfig = { ...STALENESS, ...(opts.stalenessConfig || {}) };
    this._lastReminderTime = null;
  }

  // ─── Core API: Triage a Requirement ───────────────────────────────────

  /**
   * Evaluates a requirement string and returns a routing recommendation.
   * Zero LLM calls — pure rule engine, <1ms execution.
   *
   * @param {string} requirement - The raw requirement text
   * @param {object} [context]   - Optional context for init state checking
   * @param {string} [context.projectRoot] - Project root directory
   * @returns {TriageResult}
   */
  triage(requirement, context = {}) {
    const trimmed = (requirement || '').trim();

    // ── Step 1: Score complexity ──────────────────────────────────────────
    const { score, matchedRules } = this._scoreComplexity(trimmed);

    // ── Step 2: Determine routing ─────────────────────────────────────────
    let suggestion, mode, message;

    if (score < this._thresholds.IDE_SUGGEST) {
      suggestion = 'ide_direct';
      mode = 'none';
      message = `💡 This looks like a simple change (complexity: ${score}/100). Consider using IDE Agent directly for faster results. Add --force to use the workflow anyway.`;
    } else if (score < this._thresholds.SLIM_MODE) {
      suggestion = 'slim_pipeline';
      mode = 'sequential';
      message = `⚡ Lightweight workflow mode (complexity: ${score}/100). Non-essential stages may be auto-skipped by StageSmartSkip.`;
    } else {
      suggestion = 'full_pipeline';
      mode = 'sequential';
      message = `🔄 Full pipeline mode (complexity: ${score}/100). ANALYSE → ARCHITECT → PLAN → CODE → TEST.`;
    }

    // ── Step 3: Check init state (if context provided) ────────────────────
    const initState = context.projectRoot
      ? this.checkInitState(context.projectRoot)
      : null;

    // ── Step 4: Check staleness ──────────────────────────────────────────
    const staleness = context.projectRoot
      ? this.checkStaleness(context.projectRoot)
      : null;

    return {
      score,
      suggestion,
      mode,
      message,
      matchedRules,
      initState,
      staleness,
      shouldProceed: suggestion !== 'ide_direct',
      requiresInit: initState ? !initState.isInitialized : false,
    };
  }

  // ─── InitStateGuard ─────────────────────────────────────────────────────

  /**
   * Checks whether a project has been initialized with /wf init.
   * Detects: workflow.config.js existence, project-profile, code-graph.
   *
   * @param {string} projectRoot - Project root directory
   * @returns {InitStateResult}
   */
  checkInitState(projectRoot) {
    if (!projectRoot) {
      return { isInitialized: false, reason: 'No project root specified', details: {} };
    }

    const checks = {
      hasConfig: false,
      hasCodeGraph: false,
      hasProjectProfile: false,
      hasAgentsMd: false,
      configPath: null,
      codeGraphPath: null,
    };

    // Check workflow.config.js
    const configPaths = [
      path.join(projectRoot, 'workflow.config.js'),
      path.join(projectRoot, 'workflow', 'workflow.config.js'),
    ];
    for (const cp of configPaths) {
      if (fs.existsSync(cp)) {
        checks.hasConfig = true;
        checks.configPath = cp;
        break;
      }
    }

    // Check code-graph.json
    const codeGraphPaths = [
      path.join(projectRoot, 'workflow', 'output', 'code-graph.json'),
      path.join(projectRoot, 'output', 'code-graph.json'),
    ];
    for (const cgp of codeGraphPaths) {
      if (fs.existsSync(cgp)) {
        checks.hasCodeGraph = true;
        checks.codeGraphPath = cgp;
        break;
      }
    }

    // Check project profile in config
    if (checks.hasConfig) {
      try {
        delete require.cache[require.resolve(checks.configPath)];
        const config = require(checks.configPath);
        checks.hasProjectProfile = !!(config.projectProfile);
      } catch (_) { /* ignore load errors */ }
    }

    // Check AGENTS.md
    const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
    checks.hasAgentsMd = fs.existsSync(agentsMdPath);

    // Determine initialization state
    const isInitialized = checks.hasConfig; // Minimum: config exists
    const isFullyInitialized = checks.hasConfig && checks.hasCodeGraph;

    let reason = '';
    if (!isInitialized) {
      reason = 'Project not initialized. Run `/wf init` first to set up the workflow.';
    } else if (!isFullyInitialized) {
      reason = 'Partial initialization detected. CodeGraph may be missing. Consider running `/wf init` to complete setup.';
    }

    return {
      isInitialized,
      isFullyInitialized,
      reason,
      details: checks,
    };
  }

  // ─── StalenessDetector ──────────────────────────────────────────────────

  /**
   * Checks whether project artifacts (CodeGraph, config) are stale.
   *
   * @param {string} projectRoot - Project root directory
   * @returns {StalenessResult}
   */
  checkStaleness(projectRoot) {
    const warnings = [];
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Check CodeGraph staleness
    const codeGraphPaths = [
      path.join(projectRoot, 'workflow', 'output', 'code-graph.json'),
      path.join(projectRoot, 'output', 'code-graph.json'),
    ];
    for (const cgp of codeGraphPaths) {
      if (fs.existsSync(cgp)) {
        try {
          const stat = fs.statSync(cgp);
          const ageDays = Math.round((now - stat.mtimeMs) / dayMs);
          if (ageDays > this._stalenessConfig.CODE_GRAPH_MAX_AGE_DAYS) {
            warnings.push({
              type: 'code_graph_stale',
              message: `⚠️ CodeGraph is ${ageDays} days old (threshold: ${this._stalenessConfig.CODE_GRAPH_MAX_AGE_DAYS} days). Consider running \`/wf init\` to refresh.`,
              ageDays,
            });
          }
        } catch (_) { /* ignore stat errors */ }
        break;
      }
    }

    // Check workflow.config.js staleness
    const configPaths = [
      path.join(projectRoot, 'workflow.config.js'),
      path.join(projectRoot, 'workflow', 'workflow.config.js'),
    ];
    for (const cp of configPaths) {
      if (fs.existsSync(cp)) {
        try {
          const stat = fs.statSync(cp);
          const ageDays = Math.round((now - stat.mtimeMs) / dayMs);
          if (ageDays > this._stalenessConfig.PROJECT_PROFILE_MAX_AGE_DAYS) {
            warnings.push({
              type: 'config_stale',
              message: `⚠️ Project config is ${ageDays} days old. Consider refreshing with \`/wf init\`.`,
              ageDays,
            });
          }
        } catch (_) { /* ignore stat errors */ }
        break;
      }
    }

    return {
      isStale: warnings.length > 0,
      warnings,
    };
  }

  // ─── Format for User Display ──────────────────────────────────────────

  /**
   * Formats a triage result for human-readable display (console/chat output).
   *
   * @param {TriageResult} result
   * @returns {string} Formatted message
   */
  formatTriageResult(result) {
    const lines = [];

    // Init state warning (highest priority)
    if (result.requiresInit && result.initState) {
      lines.push(`❌ **Project Not Initialized**`);
      lines.push(``);
      lines.push(result.initState.reason);
      lines.push(``);
      lines.push(`Run \`/wf init\` or \`/wf init --path <project-dir>\` to set up the workflow.`);
      return lines.join('\n');
    }

    // Main routing message
    lines.push(result.message);

    // Staleness warnings
    if (result.staleness && result.staleness.isStale) {
      lines.push(``);
      for (const w of result.staleness.warnings) {
        lines.push(w.message);
      }
    }

    // Matched rules (debug info)
    if (result.matchedRules && result.matchedRules.length > 0) {
      const tags = result.matchedRules.map(r => r.tag).join(', ');
      lines.push(``);
      lines.push(`_Signals: ${tags}_`);
    }

    return lines.join('\n');
  }

  // ─── Format for MCP Response ──────────────────────────────────────────

  /**
   * Formats a triage result as a structured MCP tool response.
   *
   * @param {TriageResult} result
   * @returns {object} MCP-compatible response object
   */
  formatMCPResponse(result) {
    return {
      complexity: {
        score: result.score,
        level: result.score < this._thresholds.IDE_SUGGEST ? 'simple'
             : result.score < this._thresholds.SLIM_MODE ? 'moderate'
             : 'complex',
      },
      routing: {
        suggestion: result.suggestion,
        mode: result.mode,
        shouldProceed: result.shouldProceed,
        requiresInit: result.requiresInit,
      },
      message: result.message,
      initState: result.initState,
      staleness: result.staleness,
      matchedSignals: (result.matchedRules || []).map(r => r.tag),
    };
  }

  // ─── Private: Complexity Scoring ──────────────────────────────────────

  /**
   * Scores requirement complexity using rule-based signals.
   *
   * @param {string} requirement
   * @returns {{ score: number, matchedRules: Array<{tag: string, score: number}> }}
   * @private
   */
  _scoreComplexity(requirement) {
    let score = 25; // Base score: moderate default
    const matchedRules = [];

    for (const rule of SCORING_RULES) {
      try {
        if (rule.test(requirement)) {
          score += rule.score;
          matchedRules.push({ tag: rule.tag, score: rule.score });
        }
      } catch (_) {
        // Rule evaluation error — skip silently
      }
    }

    // Clamp to [0, 100]
    score = Math.max(0, Math.min(100, score));

    return { score, matchedRules };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

/** Module-level singleton for convenience */
const defaultTriage = new RequestTriage();

module.exports = {
  RequestTriage,
  SCORING_RULES,
  THRESHOLDS,
  STALENESS,
  defaultTriage,
};
