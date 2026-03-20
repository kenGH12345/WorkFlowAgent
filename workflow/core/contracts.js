/**
 * Core Module Contracts — Explicit Interface Definitions (P2-4, Fowler)
 *
 * Problem: The CodexForge codebase uses a lot of duck typing. Modules depend on
 * implicit interfaces — if an object quacks like a duck, it's a duck. This works
 * but makes it hard to:
 *   1. Know what methods a module expects from its dependencies
 *   2. Swap implementations without reading all call sites
 *   3. Write adapters or mocks for testing
 *   4. Document the architectural boundaries
 *
 * This module defines explicit contracts (interface specifications) for all core
 * modules. Each contract is:
 *   - A plain object describing the expected methods and their signatures
 *   - A runtime validator function: `assertContract(name, instance)` throws if violated
 *   - Usable as documentation AND runtime guard
 *
 * Contracts do NOT enforce types (JavaScript limitation). They verify that:
 *   1. Required methods exist and are functions
 *   2. Required properties exist
 *   3. Method arity (parameter count) is within expected range
 *
 * This is inspired by Go's implicit interfaces — if a struct implements all methods,
 * it satisfies the interface. We verify at registration time, not call time.
 */

'use strict';

// ─── Contract Definitions ───────────────────────────────────────────────────

/**
 * @typedef {object} MethodSpec
 * @property {string}  name       - Method name
 * @property {number}  [minArity] - Minimum parameter count (default 0)
 * @property {number}  [maxArity] - Maximum parameter count (default Infinity)
 * @property {boolean} [optional] - If true, method is not required (default false)
 */

/**
 * @typedef {object} PropertySpec
 * @property {string}  name       - Property name
 * @property {string}  [type]     - Expected typeof value (e.g. 'string', 'object')
 * @property {boolean} [optional] - If true, property is not required
 */

/**
 * @typedef {object} ContractSpec
 * @property {string}         name        - Contract name (e.g. 'IStateMachine')
 * @property {string}         description - Human-readable description
 * @property {MethodSpec[]}   methods     - Required/optional methods
 * @property {PropertySpec[]} [properties] - Required/optional properties
 */

// ─── IStateMachine ──────────────────────────────────────────────────────────

const IStateMachine = {
  name: 'IStateMachine',
  description: 'State machine for workflow state transitions and manifest persistence.',
  methods: [
    { name: 'getState',         minArity: 0 },
    { name: 'getNextState',     minArity: 0 },
    { name: 'getPreviousState', minArity: 0 },
    { name: 'transition',       minArity: 0, maxArity: 2 },
    { name: 'rollback',         minArity: 0, maxArity: 1 },
    { name: 'jumpTo',           minArity: 1, maxArity: 2 },
    { name: 'isTerminal',       minArity: 0 },
    { name: 'recordRisk',       minArity: 2, maxArity: 3 },
    { name: 'flushRisks',       minArity: 0 },
  ],
  properties: [
    { name: 'projectId',  type: 'string' },
    { name: 'manifest',   type: 'object' },
  ],
};

// ─── IHookSystem ────────────────────────────────────────────────────────────

const IHookSystem = {
  name: 'IHookSystem',
  description: 'Event system for lifecycle hooks and human review injection.',
  methods: [
    { name: 'register',       minArity: 2, maxArity: 3 },
    { name: 'emit',           minArity: 2 },
    { name: 'listRegistered', minArity: 0 },
    { name: 'on',             minArity: 2, optional: true },
  ],
};

// ─── IExperienceStore ───────────────────────────────────────────────────────

const IExperienceStore = {
  name: 'IExperienceStore',
  description: 'Persistent experience storage with search, record, and transfer capabilities.',
  methods: [
    { name: 'record',           minArity: 1 },
    { name: 'search',           minArity: 0, maxArity: 1 },
    { name: 'getStats',         minArity: 0 },
    { name: 'exportPortable',   minArity: 0, maxArity: 1 },
    { name: 'importFrom',       minArity: 1, maxArity: 2 },
    { name: 'findByTitle',      minArity: 1 },
    { name: 'getSynonymStats',  minArity: 0, optional: true },
  ],
  properties: [
    { name: 'experiences', type: 'object' },
  ],
};

// ─── IStageRunner ───────────────────────────────────────────────────────────

const IStageRunner = {
  name: 'IStageRunner',
  description: 'Pipeline stage execution unit. Implements execute() for one workflow stage.',
  methods: [
    { name: 'getName',  minArity: 0 },
    { name: 'execute',  minArity: 1 },
    { name: 'log',      minArity: 1, optional: true },
    { name: 'warn',     minArity: 1, optional: true },
  ],
};

// ─── IMCPAdapter ────────────────────────────────────────────────────────────

const IMCPAdapter = {
  name: 'IMCPAdapter',
  description: 'MCP protocol adapter for external system integration.',
  methods: [
    { name: 'getName',    minArity: 0 },
    { name: 'connect',    minArity: 0 },
    { name: 'disconnect', minArity: 0, optional: true },
    { name: 'query',      minArity: 1, optional: true },
    { name: 'notify',     minArity: 2, optional: true },
  ],
  properties: [
    { name: 'isConnected', type: 'boolean', optional: true },
  ],
};

// ─── ILogger ────────────────────────────────────────────────────────────────

const ILogger = {
  name: 'ILogger',
  description: 'Structured logging interface.',
  methods: [
    { name: 'debug', minArity: 2 },
    { name: 'info',  minArity: 2 },
    { name: 'warn',  minArity: 2 },
    { name: 'error', minArity: 2 },
    { name: 'flush', minArity: 0 },
  ],
};

// ─── IStageContextStore ─────────────────────────────────────────────────────

const IStageContextStore = {
  name: 'IStageContextStore',
  description: 'Cross-stage semantic context propagation store.',
  methods: [
    { name: 'set',         minArity: 2 },
    { name: 'get',         minArity: 1 },
    { name: 'delete',      minArity: 1 },
    { name: 'getAll',      minArity: 0, maxArity: 3 },
    { name: 'getRelevant', minArity: 1, maxArity: 2 },
    { name: 'getLogLine',  minArity: 0 },
  ],
};

// ─── INegotiationEngine ─────────────────────────────────────────────────────

const INegotiationEngine = {
  name: 'INegotiationEngine',
  description: 'Agent negotiation protocol for inter-agent concern resolution.',
  methods: [
    { name: 'negotiate', minArity: 1 },
    { name: 'getLog',    minArity: 0 },
    { name: 'flush',     minArity: 0 },
    { name: 'reset',     minArity: 0 },
  ],
};

// ─── IExperienceRouter ──────────────────────────────────────────────────────

const IExperienceRouter = {
  name: 'IExperienceRouter',
  description: 'Cross-project experience discovery, scoring, and auto-import.',
  methods: [
    { name: 'registerProject',   minArity: 1 },
    { name: 'discoverRelevant',  minArity: 0, maxArity: 1 },
    { name: 'autoImport',        minArity: 0, maxArity: 1 },
    { name: 'publish',           minArity: 0, maxArity: 1 },
    { name: 'getRegistrySummary', minArity: 0 },
  ],
};

// ─── All Contracts ──────────────────────────────────────────────────────────

const ALL_CONTRACTS = {
  IStateMachine,
  IHookSystem,
  IExperienceStore,
  IStageRunner,
  IMCPAdapter,
  ILogger,
  IStageContextStore,
  INegotiationEngine,
  IExperienceRouter,
};

// ─── Runtime Validator ──────────────────────────────────────────────────────

/**
 * Validates that an instance satisfies a contract specification.
 *
 * @param {ContractSpec} contract - The contract to validate against
 * @param {object}       instance - The object to validate
 * @param {object}       [opts]
 * @param {boolean}      [opts.strict=false] - If true, throws on first violation. If false, returns violations array.
 * @returns {{ valid: boolean, violations: string[] }}
 * @throws {Error} If strict=true and a violation is found
 */
function assertContract(contract, instance, { strict = false } = {}) {
  const violations = [];

  if (!instance || typeof instance !== 'object') {
    const msg = `[Contract:${contract.name}] Instance is null or not an object.`;
    if (strict) throw new Error(msg);
    return { valid: false, violations: [msg] };
  }

  // Check methods
  for (const method of contract.methods) {
    if (method.optional) continue;

    if (typeof instance[method.name] !== 'function') {
      violations.push(`Missing required method: ${method.name}`);
      continue;
    }

    const arity = instance[method.name].length;
    if (method.minArity !== undefined && arity < method.minArity) {
      // Note: this is a heuristic check; default params and rest params affect .length
      // We use it as a soft warning, not a hard failure
      violations.push(`Method ${method.name}: expected minArity=${method.minArity}, got ${arity} (may be false positive with default/rest params)`);
    }
  }

  // Check properties
  if (contract.properties) {
    for (const prop of contract.properties) {
      if (prop.optional) continue;

      if (!(prop.name in instance)) {
        violations.push(`Missing required property: ${prop.name}`);
        continue;
      }

      if (prop.type && typeof instance[prop.name] !== prop.type) {
        violations.push(`Property ${prop.name}: expected type "${prop.type}", got "${typeof instance[prop.name]}"`);
      }
    }
  }

  const valid = violations.length === 0;

  if (!valid && strict) {
    throw new Error(
      `[Contract:${contract.name}] ${violations.length} violation(s):\n  - ${violations.join('\n  - ')}`
    );
  }

  return { valid, violations };
}

/**
 * Validates an instance against a contract by name.
 *
 * @param {string} contractName - e.g. 'IStateMachine'
 * @param {object} instance
 * @param {object} [opts]
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateContract(contractName, instance, opts = {}) {
  const contract = ALL_CONTRACTS[contractName];
  if (!contract) {
    throw new Error(`[Contracts] Unknown contract: "${contractName}". Available: ${Object.keys(ALL_CONTRACTS).join(', ')}`);
  }
  return assertContract(contract, instance, opts);
}

/**
 * Returns all available contract names.
 * @returns {string[]}
 */
function listContracts() {
  return Object.keys(ALL_CONTRACTS);
}

module.exports = {
  // Individual contracts
  IStateMachine,
  IHookSystem,
  IExperienceStore,
  IStageRunner,
  IMCPAdapter,
  ILogger,
  IStageContextStore,
  INegotiationEngine,
  IExperienceRouter,
  // Registry
  ALL_CONTRACTS,
  // Validation
  assertContract,
  validateContract,
  listContracts,
};
