/**
 * LlmRouter – Multi-model routing for LLM calls.
 *
 * P3 optimisation: Replaces the single-llmCall pattern where all agents share
 * the same model. LlmRouter allows different agents (roles) to use different
 * LLM models, enabling cost optimisation and quality tuning:
 *
 *   - Analyst (requirement clarification) → cheaper/faster model (e.g. GPT-4o-mini)
 *   - Architect (system design) → strongest reasoning model (e.g. Claude Opus)
 *   - Developer (code generation) → best coding model (e.g. GPT-4o or Claude Sonnet)
 *   - Tester (test report) → balanced model (e.g. GPT-4o)
 *
 * The router maintains a Map<role, llmCall> of per-role LLM functions.
 * When no role-specific override exists, it falls back to the default llmCall.
 *
 * Usage:
 *
 *   // Option 1: Simple – single model for all roles (backward compatible)
 *   const router = new LlmRouter(myLlmCall);
 *
 *   // Option 2: Per-role models
 *   const router = new LlmRouter(defaultLlmCall, {
 *     ANALYST:   cheapLlmCall,      // GPT-4o-mini for requirement analysis
 *     ARCHITECT: strongLlmCall,     // Claude Opus for architecture design
 *     DEVELOPER: codingLlmCall,     // GPT-4o for code generation
 *     TESTER:    balancedLlmCall,   // GPT-4o for test reports
 *   });
 *
 *   // Get the LLM function for a specific role
 *   const llm = router.getForRole('ARCHITECT');
 *   const response = await llm(prompt);
 *
 *   // Or call directly with role context
 *   const response = await router.call('ARCHITECT', prompt);
 *
 * Token tracking:
 *   LlmRouter wraps each call to track per-role token usage and total cost.
 *   Access via router.getUsage() or router.getUsageByRole(role).
 *
 * Dynamic reconfiguration:
 *   router.setRouteForRole('DEVELOPER', newCodingLlmCall);
 *   router.removeRouteForRole('DEVELOPER'); // falls back to default
 */

'use strict';

class LlmRouter {
  /**
   * @param {Function} defaultLlmCall - Default LLM function: async (prompt: string) => string
   * @param {Object<string, Function>} [roleRoutes] - Per-role LLM overrides.
   *   Keys are role names (e.g. 'ANALYST', 'ARCHITECT', 'DEVELOPER', 'TESTER').
   *   Values are async (prompt: string) => string functions.
   * @param {Object} [tierConfig] - P1 Tier-based routing: complexity → model tier mapping.
   *   Keys are tier names: 'fast', 'default', 'strong'.
   *   Values are async (prompt: string) => string functions.
   *   When configured, applyTierRouting(complexity) dynamically sets role routes
   *   based on the task complexity assessed after the ANALYSE stage.
   *
   *   Tier assignment rules:
   *     - 'simple'       → ARCHITECT=fast,  DEVELOPER=default, TESTER=fast
   *     - 'moderate'     → ARCHITECT=default, DEVELOPER=default, TESTER=default
   *     - 'complex'      → ARCHITECT=strong, DEVELOPER=strong, TESTER=default
   *     - 'very_complex' → ARCHITECT=strong, DEVELOPER=strong, TESTER=strong
   *
   *   Per-role overrides (roleRoutes) always take priority over tier-derived routes.
   */
  constructor(defaultLlmCall, roleRoutes = {}, tierConfig = null) {
    if (typeof defaultLlmCall !== 'function') {
      throw new Error('[LlmRouter] defaultLlmCall must be a function.');
    }
    this._default = defaultLlmCall;
    /** @type {Map<string, Function>} */
    this._routes = new Map();
    /** @type {Map<string, { calls: number, totalChars: number }>} */
    this._usage = new Map();

    // P1 Tier-based routing: store tier config and explicit role overrides
    /** @type {{ fast?: Function, default?: Function, strong?: Function }|null} */
    this._tiers = null;
    /** @type {Set<string>} - roles that have explicit per-role overrides (immune to tier routing) */
    this._explicitRoles = new Set();
    /** @type {string|null} - the complexity level that was last applied */
    this._appliedComplexityLevel = null;

    for (const [role, fn] of Object.entries(roleRoutes)) {
      if (typeof fn !== 'function') {
        throw new Error(`[LlmRouter] Route for role "${role}" must be a function.`);
      }
      this._routes.set(role, fn);
      this._explicitRoles.add(role);
    }

    // Validate and store tier config
    if (tierConfig && typeof tierConfig === 'object') {
      const validTiers = ['fast', 'default', 'strong'];
      const validatedTiers = {};
      for (const tier of validTiers) {
        if (tierConfig[tier]) {
          if (typeof tierConfig[tier] !== 'function') {
            throw new Error(`[LlmRouter] Tier "${tier}" must be a function.`);
          }
          validatedTiers[tier] = tierConfig[tier];
        }
      }
      if (Object.keys(validatedTiers).length > 0) {
        this._tiers = validatedTiers;
        console.log(`[LlmRouter] Tier routing configured: [${Object.keys(validatedTiers).join(', ')}]`);
      }
    }
  }

  /**
   * Returns the LLM function for a specific role.
   * Falls back to the default if no role-specific route is configured.
   *
   * @param {string} role - Agent role (e.g. 'ANALYST', 'ARCHITECT')
   * @returns {Function} async (prompt: string) => string
   */
  getForRole(role) {
    const fn = this._routes.get(role) || this._default;
    // Wrap with usage tracking
    return async (prompt) => {
      const result = await fn(prompt);
      this._recordUsage(role, prompt, result);
      return result;
    };
  }

  /**
   * Calls the LLM directly with role context.
   * Convenience method that combines getForRole() + invocation.
   *
   * @param {string} role   - Agent role
   * @param {string} prompt - LLM prompt
   * @returns {Promise<string>} LLM response
   */
  async call(role, prompt) {
    const fn = this._routes.get(role) || this._default;
    const result = await fn(prompt);
    this._recordUsage(role, prompt, result);
    return result;
  }

  /**
   * Returns the raw (unwrapped) LLM function for a specific role.
   * Use this when you need the function reference without usage tracking
   * (e.g. to pass to other systems that do their own tracking).
   *
   * @param {string} role
   * @returns {Function}
   */
  getRawForRole(role) {
    return this._routes.get(role) || this._default;
  }

  /**
   * Sets or replaces the LLM function for a specific role.
   *
   * @param {string}   role - Agent role
   * @param {Function} fn   - async (prompt: string) => string
   * @returns {LlmRouter} this (for chaining)
   */
  setRouteForRole(role, fn) {
    if (typeof fn !== 'function') {
      throw new Error(`[LlmRouter] Route for role "${role}" must be a function.`);
    }
    this._routes.set(role, fn);
    console.log(`[LlmRouter] Route updated for role "${role}".`);
    return this;
  }

  /**
   * Removes the role-specific route, falling back to the default.
   *
   * @param {string} role
   * @returns {LlmRouter} this (for chaining)
   */
  removeRouteForRole(role) {
    this._routes.delete(role);
    return this;
  }

  /**
   * Checks if a role has a specific (non-default) route configured.
   *
   * @param {string} role
   * @returns {boolean}
   */
  hasRouteForRole(role) {
    return this._routes.has(role);
  }

  /**
   * Checks if a role has an explicit per-role override (immune to tier routing).
   *
   * @param {string} role
   * @returns {boolean}
   */
  hasExplicitRoute(role) {
    return this._explicitRoles.has(role);
  }

  /**
   * Returns the default LLM function.
   *
   * @returns {Function}
   */
  getDefault() {
    return this._default;
  }

  /**
   * Returns usage statistics for all roles.
   *
   * @returns {Object<string, { calls: number, totalChars: number }>}
   */
  getUsage() {
    const result = {};
    for (const [role, stats] of this._usage) {
      result[role] = { ...stats };
    }
    return result;
  }

  /**
   * Returns usage statistics for a specific role.
   *
   * @param {string} role
   * @returns {{ calls: number, totalChars: number }}
   */
  getUsageByRole(role) {
    return this._usage.get(role) || { calls: 0, totalChars: 0 };
  }

  /**
   * Resets all usage counters.
   *
   * @returns {LlmRouter} this
   */
  resetUsage() {
    this._usage.clear();
    return this;
  }

  /**
   * Returns the current tier configuration (if any).
   *
   * @returns {{ fast?: Function, default?: Function, strong?: Function }|null}
   */
  getTierConfig() {
    return this._tiers;
  }

  /**
   * Returns the complexity level that was last applied via applyTierRouting().
   *
   * @returns {string|null}
   */
  getAppliedComplexityLevel() {
    return this._appliedComplexityLevel;
  }

  /**
   * P1 Auto Tier Routing: dynamically assigns model tiers to roles based on
   * task complexity. Called after the ANALYSE stage produces a complexity score.
   *
   * Tier assignment strategy (inspired by OpenCode's cost-aware routing):
   *
   *   | Complexity    | ANALYST   | ARCHITECT | DEVELOPER | TESTER  |
   *   |---------------|-----------|-----------|-----------|---------|
   *   | simple        | default   | fast      | default   | fast    |
   *   | moderate      | default   | default   | default   | default |
   *   | complex       | default   | strong    | strong    | default |
   *   | very_complex  | default   | strong    | strong    | strong  |
   *
   * Rules:
   *   - ANALYST is always 'default' (it runs BEFORE complexity is known)
   *   - Per-role explicit overrides (from constructor roleRoutes) are NEVER overwritten
   *   - If a tier function is not configured, falls back to the next lower tier
   *   - If no tier config exists at all, this is a no-op
   *
   * @param {{ score: number, level: string, factors?: object }} complexity
   *   - From Observability.estimateTaskComplexity()
   * @returns {{ applied: boolean, changes: string[] }} - Summary of applied changes
   */
  applyTierRouting(complexity) {
    if (!this._tiers || !complexity || !complexity.level) {
      return { applied: false, changes: [] };
    }

    const level = complexity.level;
    this._appliedComplexityLevel = level;

    // Tier resolution: prefer exact tier, fall back to next lower, then default LLM
    const resolveTier = (tierName) => {
      if (tierName === 'strong') {
        return this._tiers.strong || this._tiers.default || this._default;
      }
      if (tierName === 'fast') {
        return this._tiers.fast || this._tiers.default || this._default;
      }
      // 'default' tier
      return this._tiers.default || this._default;
    };

    // Define the tier mapping strategy
    const TIER_MAP = {
      simple: {
        ANALYST: 'default', ARCHITECT: 'fast', PLANNER: 'fast', DEVELOPER: 'default', TESTER: 'fast',
      },
      moderate: {
        ANALYST: 'default', ARCHITECT: 'default', PLANNER: 'default', DEVELOPER: 'default', TESTER: 'default',
      },
      complex: {
        ANALYST: 'default', ARCHITECT: 'strong', PLANNER: 'default', DEVELOPER: 'strong', TESTER: 'default',
      },
      very_complex: {
        ANALYST: 'default', ARCHITECT: 'strong', PLANNER: 'strong', DEVELOPER: 'strong', TESTER: 'strong',
      },
    };

    const mapping = TIER_MAP[level] || TIER_MAP.moderate;
    const changes = [];

    for (const [role, tierName] of Object.entries(mapping)) {
      // Never overwrite explicit per-role overrides
      if (this._explicitRoles.has(role)) {
        continue;
      }
      // Skip ANALYST – it already ran before complexity was known
      if (role === 'ANALYST') {
        continue;
      }

      const tierFn = resolveTier(tierName);
      // Only apply if the tier function differs from what's currently set
      const currentFn = this._routes.get(role) || this._default;
      if (tierFn !== currentFn) {
        this._routes.set(role, tierFn);
        changes.push(`${role}→${tierName}`);
      }
    }

    if (changes.length > 0) {
      console.log(`[LlmRouter] 🎯 Auto-tier routing applied (complexity=${level}, score=${complexity.score}): [${changes.join(', ')}]`);
    } else {
      console.log(`[LlmRouter] ℹ️  Auto-tier routing: no changes needed (complexity=${level}).`);
    }

    return { applied: changes.length > 0, changes };
  }

  // ─── Private ──────────────────────────────────────────────────────────────────

  /**
   * Records usage for a role.
   *
   * @param {string} role
   * @param {string} prompt
   * @param {string} result
   */
  _recordUsage(role, prompt, result) {
    if (!this._usage.has(role)) {
      this._usage.set(role, { calls: 0, totalChars: 0 });
    }
    const stats = this._usage.get(role);
    stats.calls += 1;
    stats.totalChars += (typeof prompt === 'string' ? prompt.length : 0) +
                        (typeof result === 'string' ? result.length : 0);
  }
}

module.exports = { LlmRouter };
