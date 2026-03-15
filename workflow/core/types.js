/**
 * Core type definitions for the multi-agent workflow system.
 * Defines workflow states, manifest structure, and agent interface contracts.
 */

// ─── Workflow States ───────────────────────────────────────────────────────────

/**
 * All valid states of the central state machine.
 * Transition order: INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED
 */
const WorkflowState = {
  INIT: 'INIT',
  ANALYSE: 'ANALYSE',
  ARCHITECT: 'ARCHITECT',
  CODE: 'CODE',
  TEST: 'TEST',
  FINISHED: 'FINISHED',
};

/** Ordered list of states for sequential transition validation */
const STATE_ORDER = [
  WorkflowState.INIT,
  WorkflowState.ANALYSE,
  WorkflowState.ARCHITECT,
  WorkflowState.CODE,
  WorkflowState.TEST,
  WorkflowState.FINISHED,
];

// ─── Agent Role Identifiers ────────────────────────────────────────────────────

const AgentRole = {
  ANALYST: 'analyst',       // Requirement analysis agent
  ARCHITECT: 'architect',   // Architecture design agent
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
 * @typedef {Object} AgentContract
 * @property {string}   role            - One of AgentRole values
 * @property {string}   inputFilePath   - Path to the file this agent reads
 * @property {string}   outputFilePath  - Path to the file this agent writes
 * @property {string[]} allowedActions  - Whitelist of permitted operations
 * @property {string[]} forbiddenActions - Operations this agent must never perform
 * @property {Function} run             - async (inputFilePath: string) => outputFilePath: string
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
    ['read_user_input', 'write_requirement_md'],
    ['write_code', 'write_architecture_md', 'write_test_report', 'modify_manifest'],
  ),
  [AgentRole.ARCHITECT]: createAgentContract(
    AgentRole.ARCHITECT,
    'output/requirement.md',
    'output/architecture.md',
    ['read_requirement_md', 'write_architecture_md'],
    ['write_code', 'write_test_report', 'modify_requirement_md', 'modify_manifest'],
  ),
  [AgentRole.DEVELOPER]: createAgentContract(
    AgentRole.DEVELOPER,
    'output/architecture.md',
    'output/code.diff',
    ['read_architecture_md', 'write_code_diff', 'read_existing_code'],
    ['modify_requirement_md', 'modify_architecture_md', 'write_test_report', 'modify_manifest'],
  ),
  [AgentRole.TESTER]: createAgentContract(
    AgentRole.TESTER,
    'output/code.diff',
    'output/test-report.md',
    ['read_code_diff', 'run_tests', 'write_test_report'],
    ['modify_requirement_md', 'modify_architecture_md', 'modify_code', 'modify_manifest'],
  ),
};

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  WorkflowState,
  STATE_ORDER,
  AgentRole,
  AGENT_CONTRACTS,
  createManifest,
  createHistoryEntry,
  createAgentContract,
};
