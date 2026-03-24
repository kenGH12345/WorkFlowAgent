/**
 * Core type definitions for the multi-agent workflow system.
 * Defines workflow states, manifest structure, and agent interface contracts.
 */

// ─── Workflow States ───────────────────────────────────────────────────────────

/**
 * All valid states of the central state machine.
 * Transition order: INIT → ANALYSE → ARCHITECT → PLAN → CODE → TEST → FINISHED
 */
const WorkflowState = {
  INIT: 'INIT',
  ANALYSE: 'ANALYSE',
  ARCHITECT: 'ARCHITECT',
  PLAN: 'PLAN',
  CODE: 'CODE',
  TEST: 'TEST',
  FINISHED: 'FINISHED',
};

/** Ordered list of states for sequential transition validation */
const STATE_ORDER = [
  WorkflowState.INIT,
  WorkflowState.ANALYSE,
  WorkflowState.ARCHITECT,
  WorkflowState.PLAN,
  WorkflowState.CODE,
  WorkflowState.TEST,
  WorkflowState.FINISHED,
];

/**
 * P1-b: Builds a dynamic STATE_ORDER from a StageRegistry.
 * When custom stages are registered (e.g. SECURITY_AUDIT between CODE and TEST),
 * StateMachine needs an updated STATE_ORDER to validate transitions and jumps.
 *
 * @param {string[]} stageNames - Ordered array of registered stage names from StageRegistry
 * @returns {string[]} Full state order: [INIT, ...stageNames, FINISHED]
 */
function buildStateOrder(stageNames) {
  return [WorkflowState.INIT, ...stageNames, WorkflowState.FINISHED];
}

// ─── Agent Role Identifiers ────────────────────────────────────────────────────

const AgentRole = {
  ANALYST: 'analyst',       // Requirement analysis agent
  ARCHITECT: 'architect',   // Architecture design agent
  PLANNER: 'planner',       // Execution planning agent
  DEVELOPER: 'developer',   // Code development agent
  TESTER: 'tester',         // Quality testing agent
};

// ─── Manifest Schema ───────────────────────────────────────────────────────────

/**
 * Creates a fresh manifest object.
 * Written to manifest.json at every state transition for checkpoint/resume.
 *
 * @param {string} projectId - Unique identifier for this workflow run
 * @returns {ManifestSchema}
 */
function createManifest(projectId) {
  return {
    version: '1.0.0',
    projectId,
    currentState: WorkflowState.INIT,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    /** Array of state transition history entries */
    history: [],
    /** Paths to all artifact files produced so far */
    artifacts: {
      requirementMd: null,
      architectureMd: null,
      codeDiff: null,
      executionPlanMd: null,
      testReportMd: null,
    },
    /** Risk flags recorded during execution */
    risks: [],
    /** Arbitrary metadata for extensibility */
    meta: {},
  };
}

/**
 * Creates a single history entry appended on each state transition.
 *
 * @param {string} fromState
 * @param {string} toState
 * @param {string|null} artifactPath - Output file path produced in this transition
 * @param {string} [note]
 */
function createHistoryEntry(fromState, toState, artifactPath = null, note = '') {
  return {
    fromState,
    toState,
    timestamp: new Date().toISOString(),
    artifactPath,
    note,
  };
}

// ─── Agent Interface Contract ──────────────────────────────────────────────────

/**
 * Defines the interface every Agent implementation must satisfy.
 *
 * Input/output are always FILE PATHS, never raw content.
 * This enforces the file-reference communication protocol (Requirement 3).
 *
 * IMPORTANT — inputFilePath / outputFilePath semantics (Arch-Fix-1):
 *   • `outputFilePath` is ENFORCED at runtime — BaseAgent._writeOutput() uses it
 *     to construct the actual file path.
 *   • `inputFilePath` is ADVISORY (documentation-only) — it declares the
 *     *canonical* upstream artifact this agent expects. At runtime, the Stage
 *     layer may pass an enriched temp file (containing the canonical content
 *     plus cross-stage context) via agent.run(dynamicPath, ...).
 *     BaseAgent.run() logs a diagnostic when the runtime path diverges from
 *     the canonical declaration.
 *
 * @typedef {Object} AgentContract
 * @property {string}        role             - One of AgentRole values
 * @property {string|null}   inputFilePath    - ADVISORY: canonical upstream artifact path (null for analyst)
 * @property {string}        outputFilePath   - ENFORCED: output file path (relative to output dir)
 * @property {string[]}      allowedActions   - Whitelist of permitted operations
 * @property {string[]}      forbiddenActions - Operations this agent must never perform
 * @property {Function}      run              - async (inputFilePath: string) => outputFilePath: string
 */

/**
 * Builds a standard agent contract descriptor.
 *
 * @param {string} role
 * @param {string} inputFilePath
 * @param {string} outputFilePath
 * @param {string[]} allowedActions
 * @param {string[]} forbiddenActions
 * @returns {AgentContract}
 */
function createAgentContract(role, inputFilePath, outputFilePath, allowedActions, forbiddenActions) {
  return { role, inputFilePath, outputFilePath, allowedActions, forbiddenActions };
}

// ─── Pre-defined Agent Contracts ──────────────────────────────────────────────

const AGENT_CONTRACTS = {
  [AgentRole.ANALYST]: createAgentContract(
    AgentRole.ANALYST,
    null,                          // Receives raw user requirement string
    'output/requirement.md',
    ['run', 'read_user_input', 'write_requirement_md'],
    ['write_code', 'write_architecture_md', 'write_test_report', 'modify_manifest'],
  ),
  [AgentRole.ARCHITECT]: createAgentContract(
    AgentRole.ARCHITECT,
    'output/requirement.md',
    'output/architecture.md',
    ['run', 'read_requirement_md', 'write_architecture_md'],
    ['write_code', 'write_test_report', 'modify_requirement_md', 'modify_manifest'],
  ),
  [AgentRole.PLANNER]: createAgentContract(
    AgentRole.PLANNER,
    'output/architecture.md',
    'output/execution-plan.md',
    ['run', 'read_architecture_md', 'write_execution_plan_md'],
    ['write_code', 'write_test_report', 'modify_requirement_md', 'modify_architecture_md', 'modify_manifest'],
  ),
  // P0-3 fix: Developer actually reads execution-plan.md (enriched with architecture context),
  // not architecture.md directly. Updated inputFilePath and allowedActions accordingly.
  [AgentRole.DEVELOPER]: createAgentContract(
    AgentRole.DEVELOPER,
    'output/execution-plan.md',
    'output/code.diff',
    ['run', 'read_architecture_md', 'read_execution_plan_md', 'write_code_diff', 'read_existing_code'],
    ['modify_requirement_md', 'modify_architecture_md', 'write_test_report', 'modify_manifest'],
  ),
  [AgentRole.TESTER]: createAgentContract(
    AgentRole.TESTER,
    'output/code.diff',
    'output/test-report.md',
    ['run', 'read_code_diff', 'run_tests', 'write_test_report'],
    ['modify_requirement_md', 'modify_architecture_md', 'modify_code', 'modify_manifest'],
  ),
};

// ─── P1-3: Unified StageResult Type ────────────────────────────────────────────
//
// Reference: Prefect's typed result system (Completed/Failed/Cached).
// Replaces the ad-hoc { __alreadyTransitioned } pattern with a discriminated union.
//
// Usage:
//   const result = StageResult.completed('output/architecture.md');
//   const result = StageResult.rolledBack('output/requirement.md');
//   const result = StageResult.cached('output/test-report.md', 'CoverageCheck');
//   const result = StageResult.failed(new Error('...'));
//
//   if (StageResult.isRolledBack(result)) { /* rollback chain handling */ }
//   if (StageResult.isCompleted(result))   { /* normal completion */ }

const StageResultType = {
  COMPLETED:   'completed',    // Stage produced an artifact normally
  ROLLED_BACK: 'rolled_back',  // Stage triggered a rollback chain and re-produced an artifact
  CACHED:      'cached',       // Stage result was served from cache (subtask cache hit)
  FAILED:      'failed',       // Stage failed (for structured error propagation)
};

const StageResult = {
  /**
   * Creates a Completed result — stage ran normally and produced an artifact.
   * @param {string} artifactPath - Path to the output file
   * @returns {{ __stageResult: true, type: 'completed', artifactPath: string }}
   */
  completed(artifactPath) {
    return { __stageResult: true, type: StageResultType.COMPLETED, artifactPath };
  },

  /**
   * Creates a RolledBack result — stage triggered rollback and re-ran upstream.
   * Equivalent to the old `{ __alreadyTransitioned: true, artifactPath }` pattern.
   * @param {string} artifactPath - Path to the re-produced artifact
   * @returns {{ __stageResult: true, type: 'rolled_back', artifactPath: string, __alreadyTransitioned: true }}
   */
  rolledBack(artifactPath) {
    return {
      __stageResult: true,
      type: StageResultType.ROLLED_BACK,
      artifactPath,
      // Backward compatibility: consumers that check __alreadyTransitioned still work
      __alreadyTransitioned: true,
    };
  },

  /**
   * Creates a Cached result — stage result was served from subtask cache.
   * @param {string} artifactPath - Path to the cached artifact
   * @param {string} cacheSource  - Which cache served this (e.g. 'subtaskCache:CoverageCheck')
   * @returns {{ __stageResult: true, type: 'cached', artifactPath: string, cacheSource: string }}
   */
  cached(artifactPath, cacheSource) {
    return { __stageResult: true, type: StageResultType.CACHED, artifactPath, cacheSource };
  },

  /**
   * Creates a Failed result — stage encountered an error.
   * @param {Error}  error     - The error that caused the failure
   * @param {string} [context] - Additional context (stage name, subtask, etc.)
   * @returns {{ __stageResult: true, type: 'failed', error: Error, context: string }}
   */
  failed(error, context = '') {
    return { __stageResult: true, type: StageResultType.FAILED, error, context };
  },

  // ── Type Guards ──────────────────────────────────────────────────────────

  /** @param {*} r @returns {boolean} */
  isStageResult(r)  { return !!(r && r.__stageResult === true); },
  /** @param {*} r @returns {boolean} */
  isCompleted(r)    { return !!(r && r.__stageResult === true && r.type === StageResultType.COMPLETED); },
  /** @param {*} r @returns {boolean} */
  isRolledBack(r)   { return !!(r && r.__stageResult === true && r.type === StageResultType.ROLLED_BACK); },
  /** @param {*} r @returns {boolean} */
  isCached(r)       { return !!(r && r.__stageResult === true && r.type === StageResultType.CACHED); },
  /** @param {*} r @returns {boolean} */
  isFailed(r)       { return !!(r && r.__stageResult === true && r.type === StageResultType.FAILED); },

  /**
   * Extracts the artifact path from any StageResult variant.
   * For Failed results, returns null.
   * @param {*} r
   * @returns {string|null}
   */
  getArtifactPath(r) {
    if (!r || !r.__stageResult) return typeof r === 'string' ? r : null;
    if (r.type === StageResultType.FAILED) return null;
    return r.artifactPath || null;
  },
};

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  WorkflowState,
  STATE_ORDER,
  buildStateOrder,
  AgentRole,
  AGENT_CONTRACTS,
  createManifest,
  createHistoryEntry,
  createAgentContract,
  StageResult,
  StageResultType,
};
