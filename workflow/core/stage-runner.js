/**
 * StageRunner – Base class for all pipeline stage implementations.
 *
 * P0 optimisation: Each pipeline stage (ANALYSE, ARCHITECT, CODE, TEST) is now
 * an independent module that extends StageRunner. This replaces the monolithic
 * orchestrator-stages.js (1701 lines) with four focused, independently testable files.
 *
 * P1-b optimisation: Stage registration. New stages can be added by:
 *   1. Creating a class that extends StageRunner
 *   2. Calling orchestrator.registerStage(name, runner)
 *   No changes to STATE_ORDER, StateMachine, or RollbackCoordinator are needed.
 *
 * StageRunner contract:
 *   - constructor(services: ServiceContainer) — receives all dependencies via DI
 *   - async execute(context: StageContext) — runs the stage logic
 *   - getName() — returns the stage name (e.g. 'ANALYSE')
 *
 * StageContext is a lightweight object passed to execute():
 *   - rawRequirement: string (only for ANALYSE stage)
 *   - orchestrator: Orchestrator reference (for accessing shared state like bus, stageCtx)
 *   - services: ServiceContainer reference
 *
 * The base class provides common utilities:
 *   - this.services: ServiceContainer reference
 *   - this.log(msg): stage-prefixed logging
 *   - this.warn(msg): stage-prefixed warning
 */

'use strict';

/**
 * @typedef {object} StageContext
 * @property {string}   [rawRequirement] - User requirement text (ANALYSE stage)
 * @property {object}   orchestrator     - Orchestrator instance reference
 * @property {import('./service-container').ServiceContainer} services - DI container
 */

class StageRunner {
  /**
   * @param {string} stageName - The name of this stage (e.g. 'ANALYSE')
   */
  constructor(stageName) {
    if (new.target === StageRunner) {
      throw new Error('StageRunner is abstract and cannot be instantiated directly.');
    }
    this._stageName = stageName;
  }

  /**
   * Returns the stage name.
   * @returns {string}
   */
  getName() {
    return this._stageName;
  }

  /**
   * Executes the stage logic.
   * Must be overridden by subclasses.
   *
   * @param {StageContext} context
   * @returns {Promise<string|object>} The output artifact path, or a sentinel object
   *   like { __alreadyTransitioned: true, artifactPath } for rollback chains.
   */
  async execute(context) {
    throw new Error(`[${this._stageName}] StageRunner.execute() must be overridden by subclass.`);
  }

  /**
   * Stage-prefixed log.
   * @param {string} msg
   */
  log(msg) {
    console.log(`[${this._stageName}] ${msg}`);
  }

  /**
   * Stage-prefixed warning.
   * @param {string} msg
   */
  warn(msg) {
    console.warn(`[${this._stageName}] ⚠️  ${msg}`);
  }
}

/**
 * StageRegistry – Manages the ordered collection of pipeline stages.
 *
 * P1-b optimisation: Replaces the hardcoded STATE_ORDER + _runStage switch pattern.
 * New stages can be inserted at arbitrary positions in the pipeline without modifying
 * any existing file (except the registration call in index.js).
 *
 * The registry maintains:
 *   1. An ordered list of stage names (defines execution order)
 *   2. A Map<stageName, StageRunner> for O(1) lookup
 *
 * Built-in stages are registered in order: ANALYSE → ARCHITECT → CODE → TEST
 * Custom stages can be inserted before/after any existing stage.
 */
class StageRegistry {
  constructor() {
    /** @type {string[]} Ordered stage names */
    this._order = [];
    /** @type {Map<string, StageRunner>} */
    this._runners = new Map();
  }

  /**
   * Registers a stage runner at the end of the pipeline.
   *
   * @param {StageRunner} runner - Must extend StageRunner
   * @param {object} [opts]
   * @param {string} [opts.before] - Insert before this existing stage name
   * @param {string} [opts.after]  - Insert after this existing stage name
   * @returns {StageRegistry} this (for chaining)
   */
  register(runner, { before = null, after = null } = {}) {
    if (!(runner instanceof StageRunner)) {
      throw new Error(`[StageRegistry] Runner must be an instance of StageRunner.`);
    }
    const name = runner.getName();
    if (this._runners.has(name)) {
      throw new Error(`[StageRegistry] Stage "${name}" is already registered.`);
    }

    this._runners.set(name, runner);

    if (before) {
      const idx = this._order.indexOf(before);
      if (idx === -1) throw new Error(`[StageRegistry] Cannot insert before "${before}": stage not found.`);
      this._order.splice(idx, 0, name);
    } else if (after) {
      const idx = this._order.indexOf(after);
      if (idx === -1) throw new Error(`[StageRegistry] Cannot insert after "${after}": stage not found.`);
      this._order.splice(idx + 1, 0, name);
    } else {
      this._order.push(name);
    }

    return this;
  }

  /**
   * Returns the StageRunner for a given stage name.
   *
   * @param {string} name
   * @returns {StageRunner|null}
   */
  get(name) {
    return this._runners.get(name) || null;
  }

  /**
   * Returns all registered stage names in pipeline order.
   *
   * @returns {string[]}
   */
  getOrder() {
    return [...this._order];
  }

  /**
   * Returns the ordered list of stages as { name, runner } pairs.
   * Used by Orchestrator.run() to iterate through stages.
   *
   * @returns {{ name: string, runner: StageRunner }[]}
   */
  getStages() {
    return this._order.map(name => ({ name, runner: this._runners.get(name) }));
  }

  /**
   * Checks if a stage is registered.
   *
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._runners.has(name);
  }

  /**
   * Returns the count of registered stages.
   *
   * @returns {number}
   */
  get size() {
    return this._runners.size;
  }
}

module.exports = { StageRunner, StageRegistry };
