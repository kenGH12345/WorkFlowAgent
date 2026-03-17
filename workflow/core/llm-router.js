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
   */
  constructor(defaultLlmCall, roleRoutes = {}) {
    if (typeof defaultLlmCall !== 'function') {
      throw new Error('[LlmRouter] defaultLlmCall must be a function.');
    }
    this._default = defaultLlmCall;
    /** @type {Map<string, Function>} */
    this._routes = new Map();
    /** @type {Map<string, { calls: number, totalChars: number }>} */
    this._usage = new Map();

    for (const [role, fn] of Object.entries(roleRoutes)) {
      if (typeof fn !== 'function') {
        throw new Error(`[LlmRouter] Route for role "${role}" must be a function.`);
      }
      this._routes.set(role, fn);
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
