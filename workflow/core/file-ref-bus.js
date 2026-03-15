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
   * Returns the full communication log for observability.
   */
  getLog() {
    return [...this._log];
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

module.exports = { FileRefBus, validateFileRef, warnDirectTextPassing };
