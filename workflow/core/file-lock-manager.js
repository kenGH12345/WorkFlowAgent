/**
 * FileLockManager – Optimistic locking for concurrent file edits.
 *
 * Problem: In task-based parallel mode (runTaskBased), multiple AgentWorkers
 * can claim independent tasks that may modify the same file. Without coordination,
 * one worker's edits can silently overwrite another's changes.
 *
 * Solution: Optimistic locking based on content hashes (not file locks).
 * Before editing a file, a worker acquires a "version stamp" (SHA-256 hash of
 * the file's current content). Before writing, it verifies the stamp still
 * matches the file on disk. If another worker modified the file in between,
 * the stamp check fails and the edit is rejected (not silently lost).
 *
 * This is "optimistic" because no exclusive locks are held – concurrent reads
 * are always allowed, and conflicts are detected at write time rather than
 * prevented at read time. This matches the typical AgentWorker pattern where
 * most tasks edit different files, and same-file conflicts are rare.
 *
 * Design: zero-dependency, thread-safe within a single Node.js process
 * (sufficient because AgentWorkers are Promise-based, not multi-process).
 *
 * Integration points:
 *   - orchestrator-helpers.js: _applyFileReplacements() calls acquireVersion()
 *     before reading and verifyVersion() before writing.
 *   - sandbox.js: DryRunSandbox.patchFile() uses acquireVersion() to track
 *     virtual FS consistency.
 */

'use strict';

const fs   = require('fs');
const crypto = require('crypto');

// ─── FileLockManager ──────────────────────────────────────────────────────────

class FileLockManager {
  constructor() {
    /**
     * Map of absPath → { hash: string, acquiredBy: string, acquiredAt: number }
     * @type {Map<string, {hash: string, acquiredBy: string, acquiredAt: number}>}
     */
    this._versions = new Map();

    /**
     * Conflict log for observability / debugging.
     * @type {Array<{file: string, acquiredBy: string, conflictBy: string, ts: number}>}
     */
    this._conflicts = [];
  }

  /**
   * Computes a fast content hash for a file's content.
   * Uses SHA-256 truncated to 16 hex chars for a good balance of speed and collision resistance.
   *
   * @param {string} content - File content
   * @returns {string} Truncated hash
   */
  static contentHash(content) {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
  }

  /**
   * Acquires a version stamp for a file. Call this BEFORE reading the file
   * for editing purposes. The stamp records the file's current content hash
   * and the identity of the acquiring agent.
   *
   * If the file is already stamped by a different agent, this does NOT block –
   * it overwrites the stamp (optimistic: we assume no conflict until write time).
   *
   * @param {string} absPath   - Absolute file path
   * @param {string} content   - Current file content (already read by caller)
   * @param {string} [agentId] - Identity of the acquiring agent/worker
   * @returns {{ hash: string, acquiredBy: string }} The version stamp
   */
  acquireVersion(absPath, content, agentId = 'default') {
    const hash = FileLockManager.contentHash(content);
    const stamp = { hash, acquiredBy: agentId, acquiredAt: Date.now() };
    this._versions.set(absPath, stamp);
    return stamp;
  }

  /**
   * Verifies that a file has not been modified since the version was acquired.
   * Call this BEFORE writing the patched content.
   *
   * @param {string} absPath        - Absolute file path
   * @param {string} currentContent - Current file content on disk (re-read by caller)
   * @param {string} [agentId]      - Identity of the verifying agent/worker
   * @returns {{ valid: boolean, reason?: string, expectedHash?: string, actualHash?: string }}
   */
  verifyVersion(absPath, currentContent, agentId = 'default') {
    const stamp = this._versions.get(absPath);
    if (!stamp) {
      // No stamp exists – allow the write (backward compatibility: non-stamped edits pass through)
      return { valid: true };
    }

    const currentHash = FileLockManager.contentHash(currentContent);
    if (currentHash === stamp.hash) {
      return { valid: true };
    }

    // Conflict detected
    const conflict = {
      file: absPath,
      acquiredBy: stamp.acquiredBy,
      conflictBy: agentId,
      expectedHash: stamp.hash,
      actualHash: currentHash,
      ts: Date.now(),
    };
    this._conflicts.push(conflict);

    return {
      valid: false,
      reason: stamp.acquiredBy !== agentId
        ? `File modified by another worker ("${stamp.acquiredBy}") since version was acquired`
        : `File modified externally since version was acquired`,
      expectedHash: stamp.hash,
      actualHash: currentHash,
    };
  }

  /**
   * Releases the version stamp for a file (after successful write).
   * Optionally updates the stamp to reflect the new content.
   *
   * @param {string} absPath    - Absolute file path
   * @param {string} [newContent] - If provided, updates the stamp to reflect the post-write content
   * @param {string} [agentId]    - Identity of the releasing agent
   */
  releaseVersion(absPath, newContent = null, agentId = 'default') {
    if (newContent !== null) {
      // Update stamp to reflect the new content (so subsequent edits by the same
      // or different agent will use the correct baseline)
      const hash = FileLockManager.contentHash(newContent);
      this._versions.set(absPath, { hash, acquiredBy: agentId, acquiredAt: Date.now() });
    } else {
      this._versions.delete(absPath);
    }
  }

  /**
   * Convenience method: acquire + verify + release in one atomic check.
   * Use when you read a file, prepare a patch, and want to verify before writing.
   *
   * @param {string} absPath        - Absolute file path
   * @param {string} originalContent - Content that was read before patch preparation
   * @param {string} currentContent  - Content re-read just before writing
   * @param {string} [agentId]       - Agent identity
   * @returns {{ valid: boolean, reason?: string }}
   */
  checkAndStamp(absPath, originalContent, currentContent, agentId = 'default') {
    const originalHash = FileLockManager.contentHash(originalContent);
    const currentHash  = FileLockManager.contentHash(currentContent);

    if (originalHash !== currentHash) {
      const conflict = {
        file: absPath,
        acquiredBy: agentId,
        conflictBy: 'external',
        expectedHash: originalHash,
        actualHash: currentHash,
        ts: Date.now(),
      };
      this._conflicts.push(conflict);
      return {
        valid: false,
        reason: `File was modified between read and write (hash ${originalHash.slice(0, 8)}→${currentHash.slice(0, 8)})`,
      };
    }
    return { valid: true };
  }

  /**
   * Returns the conflict log for observability.
   * @returns {Array<object>}
   */
  getConflicts() {
    return [...this._conflicts];
  }

  /**
   * Returns a summary of tracked files and conflicts.
   * @returns {{ trackedFiles: number, conflicts: number }}
   */
  getStats() {
    return {
      trackedFiles: this._versions.size,
      conflicts: this._conflicts.length,
    };
  }

  /**
   * Clears all version stamps and the conflict log.
   */
  reset() {
    this._versions.clear();
    this._conflicts = [];
  }
}

// Singleton instance – shared across all orchestrator modules within one process
const _globalInstance = new FileLockManager();

module.exports = { FileLockManager, fileLockManager: _globalInstance };
