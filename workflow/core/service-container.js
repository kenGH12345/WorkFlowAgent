/**
 * ServiceContainer – Dependency Injection container for Orchestrator
 *
 * P1-a optimisation: Replaces the Orchestrator's God Object pattern where 20+
 * subsystems are instantiated directly in the constructor. The ServiceContainer
 * provides:
 *
 *   1. **Lazy initialisation**: Services are created on first access, not at construction.
 *      This means unused services (e.g. CIIntegration in non-CI environments) are never
 *      instantiated, saving memory and startup time.
 *
 *   2. **Testability**: In tests, register mock implementations via register(name, factory)
 *      before calling resolve(name). No need to construct a full Orchestrator with 20+ deps.
 *
 *   3. **Replaceability**: Swap any subsystem at runtime via register(name, factory, { force: true }).
 *      Useful for plugin systems, A/B testing different implementations, etc.
 *
 *   4. **Explicit dependency graph**: Each service declares its dependencies in the factory
 *      function's `container` parameter, making the dependency graph visible and auditable.
 *
 * Usage:
 *   const container = new ServiceContainer();
 *   container.register('stateMachine', (c) => new StateMachine(c.resolve('projectId'), c.resolve('hookEmitter')));
 *   container.registerValue('projectId', 'my-project');
 *   const sm = container.resolve('stateMachine'); // lazy-created on first access
 *   const sm2 = container.resolve('stateMachine'); // returns cached instance (singleton)
 */

'use strict';

class ServiceContainer {
  constructor() {
    /** @type {Map<string, { factory: Function, instance: any, singleton: boolean }>} */
    this._services = new Map();
    /** @type {Set<string>} Track services currently being resolved (circular dep detection) */
    this._resolving = new Set();
  }

  /**
   * Registers a service factory.
   *
   * @param {string}   name    - Unique service name (e.g. 'stateMachine', 'experienceStore')
   * @param {Function} factory - (container: ServiceContainer) => serviceInstance
   * @param {object}   [opts]
   * @param {boolean}  [opts.singleton=true] - If true, factory is called once and result cached.
   *   If false, factory is called on every resolve() (transient lifetime).
   * @param {boolean}  [opts.force=false] - If true, overwrites an existing registration.
   *   Without force, re-registering an existing name throws (prevents accidental overwrites).
   * @returns {ServiceContainer} this (for chaining)
   */
  register(name, factory, { singleton = true, force = false } = {}) {
    if (typeof name !== 'string' || !name) {
      throw new Error(`[ServiceContainer] Service name must be a non-empty string.`);
    }
    if (typeof factory !== 'function') {
      throw new Error(`[ServiceContainer] Factory for "${name}" must be a function.`);
    }
    if (this._services.has(name) && !force) {
      throw new Error(`[ServiceContainer] Service "${name}" is already registered. Use { force: true } to overwrite.`);
    }
    this._services.set(name, { factory, instance: null, singleton });
    return this;
  }

  /**
   * Registers a pre-created value (not a factory).
   * Useful for primitives and configuration objects.
   *
   * @param {string} name  - Service name
   * @param {*}      value - The value to register
   * @param {object}  [opts]
   * @param {boolean}  [opts.force=false] - If true, overwrites existing registration.
   * @returns {ServiceContainer} this (for chaining)
   */
  registerValue(name, value, { force = false } = {}) {
    return this.register(name, () => value, { singleton: true, force });
  }

  /**
   * Resolves a service by name. Creates it via factory on first access (lazy init).
   *
   * @param {string} name - Service name
   * @returns {*} The service instance
   * @throws {Error} If the service is not registered or a circular dependency is detected
   */
  resolve(name) {
    const entry = this._services.get(name);
    if (!entry) {
      throw new Error(`[ServiceContainer] Service "${name}" is not registered. Available: [${[...this._services.keys()].join(', ')}]`);
    }

    // Singleton: return cached instance if already created
    if (entry.singleton && entry.instance !== null) {
      return entry.instance;
    }

    // Circular dependency detection
    if (this._resolving.has(name)) {
      const chain = [...this._resolving, name].join(' → ');
      throw new Error(`[ServiceContainer] Circular dependency detected: ${chain}`);
    }

    this._resolving.add(name);
    try {
      const instance = entry.factory(this);
      if (entry.singleton) {
        entry.instance = instance;
      }
      return instance;
    } finally {
      this._resolving.delete(name);
    }
  }

  /**
   * Checks if a service is registered (regardless of whether it's been resolved).
   *
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._services.has(name);
  }

  /**
   * Returns all registered service names.
   *
   * @returns {string[]}
   */
  getRegisteredNames() {
    return [...this._services.keys()];
  }

  /**
   * Resets a service, clearing its cached instance so the next resolve() re-creates it.
   * Useful in tests for resetting state between test cases.
   *
   * @param {string} name
   * @returns {ServiceContainer} this
   */
  reset(name) {
    const entry = this._services.get(name);
    if (entry) {
      entry.instance = null;
    }
    return this;
  }

  /**
   * Resets all services, clearing all cached instances.
   *
   * @returns {ServiceContainer} this
   */
  resetAll() {
    for (const entry of this._services.values()) {
      entry.instance = null;
    }
    return this;
  }
}

module.exports = { ServiceContainer };
