/**
 * File-Reference Communication Protocol
 *
 * Core principle (Requirement 3):
 *   - The orchestrator passes only FILE PATHS to agents, never raw content.
 *   - Agents self-read their input files, ensuring 100% information fidelity.
 *   - Direct text passing is detected and warned against.
 *
 * This module provides:
 *   - FileRefBus: the message bus that enforces the protocol
 *   - validateFileRef: utility to check a path before passing it
 *   - warnDirectTextPassing: emits a warning when raw content is detected
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../core/constants');
const { extractJsonBlock, validateJsonBlock } = require('../core/agent-output-schema');

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Heuristic threshold: if a "path" string is longer than this,
 * it is likely raw content rather than a file path.
 */
const MAX_PATH_LENGTH = 512;

// ─── Validation Utilities ─────────────────────────────────────────────────────

/**
 * Validates that a value looks like a file path (not raw content).
 * Emits a warning if it appears to be raw text.
 *
 * @param {string} value       - The value to validate
 * @param {string} senderRole  - Role of the sending agent (for logging)
 * @param {string} receiverRole - Role of the receiving agent (for logging)
 * @returns {{ valid: boolean, reason: string }}
 */
function validateFileRef(value, senderRole = 'unknown', receiverRole = 'unknown') {
  if (typeof value !== 'string') {
    return { valid: false, reason: `Expected a string file path, got ${typeof value}` };
  }

  if (value.length > MAX_PATH_LENGTH) {
    warnDirectTextPassing(senderRole, receiverRole, value.length);
    return {
      valid: false,
      reason: `Value length (${value.length} chars) exceeds MAX_PATH_LENGTH (${MAX_PATH_LENGTH}). ` +
              `This looks like raw content, not a file path. Use file-reference protocol instead.`,
    };
  }

  // Check for newlines – file paths never contain newlines
  if (/[\r\n]/.test(value)) {
    warnDirectTextPassing(senderRole, receiverRole, value.length);
    return {
      valid: false,
      reason: `Value contains newline characters – this is raw content, not a file path.`,
    };
  }

  return { valid: true, reason: 'ok' };
}

/**
 * Emits a standardised warning when direct text passing is detected.
 *
 * @param {string} senderRole
 * @param {string} receiverRole
 * @param {number} contentLength
 */
function warnDirectTextPassing(senderRole, receiverRole, contentLength) {
  console.warn(
    `\n⚠️  [FileRefBus] PROTOCOL VIOLATION DETECTED\n` +
    `   From: ${senderRole} → To: ${receiverRole}\n` +
    `   Raw content (${contentLength} chars) was passed instead of a file path.\n` +
    `   This causes:\n` +
    `     • Token waste (content duplicated in context)\n` +
    `     • Information distortion (truncation risk)\n` +
    `     • Context coupling (breaks agent isolation)\n` +
    `   Fix: Write content to a file first, then pass the file path.\n`
  );
}

// ─── Agent Output Contracts ───────────────────────────────────────────────────

/**
 * Defines the minimum content contract for each Agent's input file.
 *
 * Problem it solves (P2-D):
 *   FileRefBus validates file path format but not file content. If ANALYST outputs
 *   an empty or malformed requirements.md, ARCHITECT silently runs with bad input.
 *   These contracts catch that at publish() time, before the downstream Agent runs.
 *
 * P2-NEW-2 fix: requiredSections now includes Chinese equivalents for each keyword.
 *   Previously only English keywords were checked, causing false-positive contract
 *   violations for Chinese-language projects (e.g. "## 需求" was not recognised as
 *   a requirements section). Each entry now has both English and Chinese variants.
 *
 * Contract format:
 *   { requiredSections: string[], minLength: number, description: string }
 *
 * requiredSections: at least one of these strings must appear in the file content.
 *   (OR semantics – any one match is sufficient to pass the check)
 * minLength: minimum file size in characters (catches empty/stub files)
 */
const AGENT_CONTRACTS = {
  // ANALYST → ARCHITECT: requirements.md must have a requirements section
  architect: {
    requiredSections: [
      // English variants
      '## Requirements', '## Functional', '## Feature', '# Requirements', 'requirements',
      // Chinese variants (P2-NEW-2)
      '## 需求', '## 功能', '## 功能需求', '## 用户故事', '## 特性', '需求', '功能需求',
    ],
    minLength: 100,
    description: 'requirements.md for ArchitectAgent',
  },
  // ARCHITECT → PLANNER: architecture.md must have a design/component section
  planner: {
    requiredSections: [
      // English variants
      '## Architecture', '## Component', '## Design', '## System', '# Architecture', 'architecture',
      // Chinese variants (P2-NEW-2)
      '## 架构', '## 系统架构', '## 组件', '## 模块', '## 设计', '## 技术栈', '架构设计', '技术栈',
    ],
    minLength: 200,
    description: 'architecture.md for PlannerAgent',
  },
  // PLANNER → DEVELOPER: architecture.md (passed through) must have a design/component section
  developer: {
    requiredSections: [
      // English variants
      '## Architecture', '## Component', '## Design', '## System', '# Architecture', 'architecture',
      // Chinese variants (P2-NEW-2)
      '## 架构', '## 系统架构', '## 组件', '## 模块', '## 设计', '## 技术栈', '架构设计', '技术栈',
    ],
    minLength: 200,
    description: 'architecture.md for DeveloperAgent (via PlannerAgent)',
  },
  // DEVELOPER → TESTER: code.diff must look like a diff
  tester: {
    requiredSections: [
      'diff --git', '--- a/', '+++ b/', '@@', '.js', '.ts', '.py',
      // Chinese projects may use other extensions (P2-NEW-2)
      '.java', '.go', '.cs', '.lua', '.rb',
    ],
    minLength: 50,
    description: 'code.diff for TesterAgent',
  },
};

/**
 * Validates that a file's content satisfies the downstream Agent's input contract.
 *
 * P0-NEW-1 fix: Two-tier validation:
 *   Tier 1 (preferred): JSON Schema validation – if the file contains a structured
 *     JSON block (agent-output-schema.js format), validate required fields directly.
 *     This is precise and immune to keyword false-positives.
 *   Tier 2 (fallback): Keyword-based heuristic – for legacy/plain Markdown files
 *     that don't yet embed a JSON block. Same as the original P2-D implementation.
 *
 * @param {string} receiverRole - The downstream Agent role
 * @param {string} filePath     - Path to the file being published
 * @returns {{ valid: boolean, reason: string, tier: 'json-schema'|'keyword'|'no-contract' }}
 */
function validateAgentContract(receiverRole, filePath) {
  const contract = AGENT_CONTRACTS[receiverRole.toLowerCase()];
  if (!contract) return { valid: true, reason: 'no contract defined', tier: 'no-contract' };

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { valid: false, reason: `Cannot read file for contract validation: ${err.message}`, tier: 'no-contract' };
  }

  if (content.length < contract.minLength) {
    return {
      valid: false,
      reason: `Contract violation for ${contract.description}: file is too short ` +
              `(${content.length} chars, minimum ${contract.minLength}). ` +
              `The file may be empty or a stub.`,
      tier: 'keyword',
    };
  }

  // ── Tier 1: JSON Schema validation (P0-NEW-1) ─────────────────────────────
  // If the file contains a structured JSON block, validate it against the schema.
  // This is the preferred path for agents that output JSON+Markdown hybrid files.
  const jsonBlock = extractJsonBlock(content);
  if (jsonBlock) {
    // Map receiverRole to the sender's role (the file was produced by the sender)
    const senderRoleMap = {
      architect: 'analyst',
      planner:   'architect',
      developer: 'planner',
      tester:    'developer',
    };
    const senderRole = senderRoleMap[receiverRole.toLowerCase()];
    if (senderRole) {
      const schemaCheck = validateJsonBlock(jsonBlock, senderRole);
      if (!schemaCheck.valid) {
        return {
          valid: false,
          reason: `JSON Schema violation for ${contract.description}: ${schemaCheck.reason}`,
          tier: 'json-schema',
        };
      }
      // JSON block is valid – skip keyword check
      return { valid: true, reason: 'JSON schema validated', tier: 'json-schema' };
    }
  }

  // ── Tier 2: Keyword-based heuristic (fallback for legacy Markdown files) ──
  const hasRequiredSection = contract.requiredSections.some(s =>
    content.toLowerCase().includes(s.toLowerCase())
  );
  if (!hasRequiredSection) {
    return {
      valid: false,
      reason: `Contract violation for ${contract.description}: none of the required sections ` +
              `[${contract.requiredSections.slice(0, 3).join(', ')}...] found in file. ` +
              `The file may have an unexpected format or missing structured JSON block.`,
      tier: 'keyword',
    };
  }

  return { valid: true, reason: 'keyword check passed', tier: 'keyword' };
}

// ─── FileRefBus ───────────────────────────────────────────────────────────────

/**
 * FileRefBus – the message bus for inter-agent communication.
 *
 * Usage:
 *   const bus = new FileRefBus();
 *   bus.publish('analyst', 'architect', '/path/to/requirement.md');
 *   const filePath = bus.consume('architect');
 */
class FileRefBus {
  constructor() {
    /**
     * @type {Map<string, {filePath: string, meta: object|null}>}
     * receiverRole → { filePath, meta }
     *
     * Messages are NOT deleted on consume() (peek semantics).
     * This allows downstream agents to retry without losing the message.
     * Use clearMessage(receiverRole) explicitly if you need to remove a message.
     */
    this._queue = new Map();
    /** @type {Array<{from, to, filePath, meta, timestamp}>} */
    this._log = [];
    /** @type {Array<{from, to, filePath, reason, timestamp}>} */
    this._contractViolations = []; // P2-D: tracks content contract violations
  }

  /**
   * Publishes a file path from one agent to another.
   * Validates the value before storing.
   *
   * @param {string} senderRole
   * @param {string} receiverRole
   * @param {string} filePath - Must be a valid file path, not raw content
   * @param {object} [meta]   - Optional metadata to pass alongside the file path.
   *   Useful for carrying change summaries so the receiver knows what changed:
   *   e.g. { reviewRounds: 1, changedSections: ['API Design', 'Data Model'] }
   * @throws {Error} If validation fails
   */
  publish(senderRole, receiverRole, filePath, meta = null) {
    // N73 fix: guard against null/undefined filePath early (e.g. ANALYST contract
    // has inputFilePath = null because it receives a raw string, not a file path).
    // Calling validateFileRef(null, ...) would throw a confusing type error; surface
    // a clear message instead.
    if (filePath == null) {
      throw new Error(
        `[FileRefBus] publish() rejected: filePath is ${filePath}. ` +
        `Agent "${receiverRole}" may not support file-reference protocol (check AGENT_CONTRACTS).`
      );
    }

    const { valid, reason } = validateFileRef(filePath, senderRole, receiverRole);
    if (!valid) {
      throw new Error(`[FileRefBus] publish() rejected: ${reason}`);
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`[FileRefBus] File does not exist: "${filePath}" (from ${senderRole} to ${receiverRole})`);
    }

    // P2-D fix: validate file content against the downstream Agent's input contract.
    // This catches empty/malformed files before the downstream Agent runs silently
    // with bad input. Contract violations are logged as warnings (not hard errors)
    // to avoid blocking the workflow on edge cases (e.g. minimal valid files).
    const contractCheck = validateAgentContract(receiverRole, filePath);
    if (!contractCheck.valid) {
      console.warn(
        `\n⚠️  [FileRefBus] CONTRACT VIOLATION DETECTED\n` +
        `   From: ${senderRole} → To: ${receiverRole}\n` +
        `   File: ${path.basename(filePath)}\n` +
        `   Reason: ${contractCheck.reason}\n` +
        `   The downstream Agent may produce incorrect output due to malformed input.\n`
      );
      // Record as a soft warning – do not throw, as the Agent may still handle it.
      // Callers can check bus.getContractViolations() to decide whether to abort.
      this._contractViolations.push({
        from: senderRole, to: receiverRole, filePath,
        reason: contractCheck.reason, timestamp: new Date().toISOString(),
      });
    }

    this._queue.set(receiverRole, { filePath, meta });
    this._log.push({ from: senderRole, to: receiverRole, filePath, meta, timestamp: new Date().toISOString() });

    console.log(`[FileRefBus] ${senderRole} → ${receiverRole}: ${path.basename(filePath)}`);
  }

  /**
   * Consumes the file path queued for a given receiver.
   * The receiver is responsible for reading the file itself.
   *
   * NOTE: Messages are retained after consume() (peek semantics).
   * This allows the same stage to be retried on checkpoint resume without
   * losing the message. Call clearMessage(receiverRole) explicitly if you
   * need to remove a message (e.g. after a stage completes successfully).
   *
   * @param {string} receiverRole
   * @returns {string} filePath
   * @throws {Error} If no message is queued for this receiver
   */
  consume(receiverRole) {
    const entry = this._queue.get(receiverRole);
    if (!entry) {
      throw new Error(`[FileRefBus] No message queued for receiver: "${receiverRole}"`);
    }
    // Peek semantics: do NOT delete the entry so retries can re-consume it.
    return entry.filePath;
  }

  /**
   * Returns the metadata associated with the message queued for a given receiver.
   * Returns null if no message is queued or no meta was provided.
   *
   * @param {string} receiverRole
   * @returns {object|null}
   */
  getMeta(receiverRole) {
    const entry = this._queue.get(receiverRole);
    return entry ? (entry.meta ?? null) : null;
  }

  /**
   * Explicitly removes the message queued for a given receiver.
   * Use this after a stage completes successfully if you want to enforce
   * that the message cannot be re-consumed (strict once-only semantics).
   *
   * @param {string} receiverRole
   */
  clearMessage(receiverRole) {
    this._queue.delete(receiverRole);
  }

  /**
   * Clears all messages whose sender matches senderRole.
   * Called during rollback to invalidate stale downstream messages so that
   * re-run stages cannot accidentally consume messages from the previous attempt.
   *
   * Example: rolling back from CODE → ARCHITECT should clear the DEVELOPER
   * message that ARCHITECT published, so _runDeveloper cannot consume the old
   * architecture.md path when it re-runs after the rollback.
   *
   * @param {string} senderRole - The role whose outbound messages should be cleared
   * @returns {number} Number of messages cleared
   */
  clearDownstream(senderRole) {
    let cleared = 0;
    for (const [receiverRole, entry] of this._queue) {
      // The log records the sender; find all queue entries whose last publish
      // came from senderRole by checking the communication log in reverse.
      const lastPublish = [...this._log].reverse().find(l => l.to === receiverRole);
      if (lastPublish && lastPublish.from === senderRole) {
        this._queue.delete(receiverRole);
        cleared++;
        console.log(`[FileRefBus] 🧹 Cleared stale downstream message: ${senderRole} → ${receiverRole} (rollback invalidation)`);
      }
    }
    return cleared;
  }

  /**
   * Returns the full communication log for observability.
   */
  getLog() {
    return [...this._log];
  }

  /**
   * Returns all contract violations recorded during this session. (P2-D)
   * Callers can check this after each publish() to decide whether to abort
   * the workflow or record a risk.
   * @returns {Array<{from, to, filePath, reason, timestamp}>}
   */
  getContractViolations() {
    return [...this._contractViolations];
  }

  /**
   * Saves the communication log to the output directory.
   */
  saveLog() {
    const logPath = path.join(PATHS.OUTPUT_DIR, 'communication-log.json');
    if (!fs.existsSync(PATHS.OUTPUT_DIR)) fs.mkdirSync(PATHS.OUTPUT_DIR, { recursive: true });
    // N67 fix: atomic write – write to a .tmp file first, then rename over the target.
    // Prevents a process crash mid-write from corrupting communication-log.json.
    const tmpPath = logPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this._log, null, 2), 'utf-8');
    fs.renameSync(tmpPath, logPath);
    return logPath;
  }
}

module.exports = { FileRefBus, validateFileRef, warnDirectTextPassing, validateAgentContract, AGENT_CONTRACTS };
