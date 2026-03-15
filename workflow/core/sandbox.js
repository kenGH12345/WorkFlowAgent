/**
 * DryRunSandbox – File system write interception for safe preview mode.
 *
 * When dryRun: true is passed to the Orchestrator, all file-system mutations
 * (write, delete, rename) are intercepted and recorded as a pending operation
 * log instead of being executed immediately.
 *
 * This allows users to:
 *   1. Preview exactly what the workflow would change before committing.
 *   2. Selectively apply or reject individual operations.
 *   3. Run the workflow in CI "preview" mode without touching the working tree.
 *
 * Usage:
 *   const sandbox = new DryRunSandbox({ projectRoot, outputDir });
 *   sandbox.writeFile('src/foo.js', '// new content');   // recorded, not written
 *   sandbox.deleteFile('src/old.js');                    // recorded, not deleted
 *   console.log(sandbox.report());                       // print pending ops
 *   await sandbox.apply();                               // actually execute all ops
 *   sandbox.reset();                                     // clear pending ops
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Operation Types ──────────────────────────────────────────────────────────

const OpType = {
  WRITE:  'write',   // Create or overwrite a file
  PATCH:  'patch',   // Apply a find-and-replace patch to an existing file
  DELETE: 'delete',  // Delete a file
  RENAME: 'rename',  // Rename / move a file
  MKDIR:  'mkdir',   // Create a directory
};

// ─── DryRunSandbox ────────────────────────────────────────────────────────────

class DryRunSandbox {
  /**
   * @param {object} [options]
   * @param {string}  [options.projectRoot] - Project root for relative path display
   * @param {string}  [options.outputDir]   - Where to write the dry-run report file
   * @param {boolean} [options.verbose]     - Log each intercepted operation immediately
   */
  constructor({ projectRoot = null, outputDir = null, verbose = true } = {}) {
    this.projectRoot = projectRoot || process.cwd();
    this.outputDir   = outputDir   || path.join(this.projectRoot, 'workflow', 'output');
    this.verbose     = verbose;

    /** @type {Array<PendingOp>} */
    this._ops = [];
    /** @type {Map<string, string>} absPath → in-memory content (virtual FS) */
    this._virtualFS = new Map();
  }

  // ─── Intercepted Operations ───────────────────────────────────────────────────

  /**
   * Records a file write operation (create or overwrite).
   *
   * @param {string} filePath - Absolute or project-relative path
   * @param {string} content  - New file content
   */
  writeFile(filePath, content) {
    const absPath = this._resolve(filePath);
    const relPath = this._rel(absPath);

    const isNew = !fs.existsSync(absPath) && !this._virtualFS.has(absPath);
    const op = {
      type: OpType.WRITE,
      path: absPath,
      relPath,
      content,
      isNew,
      timestamp: new Date().toISOString(),
    };

    this._ops.push(op);
    this._virtualFS.set(absPath, content);

    if (this.verbose) {
      console.log(`[DryRun] 📝 ${isNew ? 'CREATE' : 'OVERWRITE'} ${relPath} (${content.length} chars)`);
    }
  }

  /**
   * Records a find-and-replace patch operation.
   *
   * @param {string} filePath   - Absolute or project-relative path
   * @param {string} findStr    - Exact string to find
   * @param {string} replaceStr - Replacement string
   */
  patchFile(filePath, findStr, replaceStr) {
    const absPath = this._resolve(filePath);
    const relPath = this._rel(absPath);

    // Apply to virtual FS for subsequent operations in the same session
    const currentContent = this._virtualFS.has(absPath)
      ? this._virtualFS.get(absPath)
      : (fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : null);

    if (currentContent !== null) {
      const patched = currentContent.replace(findStr, replaceStr);
      this._virtualFS.set(absPath, patched);
    }

    const op = {
      type: OpType.PATCH,
      path: absPath,
      relPath,
      findStr,
      replaceStr,
      timestamp: new Date().toISOString(),
    };

    this._ops.push(op);

    if (this.verbose) {
      const preview = findStr.slice(0, 60).replace(/\n/g, '↵');
      console.log(`[DryRun] 🔧 PATCH ${relPath} (find: "${preview}...")`);
    }
  }

  /**
   * Records a file deletion.
   *
   * @param {string} filePath - Absolute or project-relative path
   */
  deleteFile(filePath) {
    const absPath = this._resolve(filePath);
    const relPath = this._rel(absPath);

    this._ops.push({
      type: OpType.DELETE,
      path: absPath,
      relPath,
      timestamp: new Date().toISOString(),
    });
    this._virtualFS.delete(absPath);

    if (this.verbose) {
      console.log(`[DryRun] 🗑️  DELETE ${relPath}`);
    }
  }

  /**
   * Records a file rename/move.
   *
   * @param {string} fromPath - Source path
   * @param {string} toPath   - Destination path
   */
  renameFile(fromPath, toPath) {
    const absFrom = this._resolve(fromPath);
    const absTo   = this._resolve(toPath);

    this._ops.push({
      type: OpType.RENAME,
      path: absFrom,
      relPath: this._rel(absFrom),
      toPath: absTo,
      toRelPath: this._rel(absTo),
      timestamp: new Date().toISOString(),
    });

    if (this._virtualFS.has(absFrom)) {
      this._virtualFS.set(absTo, this._virtualFS.get(absFrom));
      this._virtualFS.delete(absFrom);
    }

    if (this.verbose) {
      console.log(`[DryRun] ✂️  RENAME ${this._rel(absFrom)} → ${this._rel(absTo)}`);
    }
  }

  /**
   * Records a directory creation.
   *
   * @param {string} dirPath - Absolute or project-relative path
   */
  mkdir(dirPath) {
    const absPath = this._resolve(dirPath);
    this._ops.push({
      type: OpType.MKDIR,
      path: absPath,
      relPath: this._rel(absPath),
      timestamp: new Date().toISOString(),
    });

    if (this.verbose) {
      console.log(`[DryRun] 📁 MKDIR ${this._rel(absPath)}`);
    }
  }

  // ─── Virtual FS Read ──────────────────────────────────────────────────────────

  /**
   * Reads a file from the virtual FS (falls back to real FS if not intercepted).
   * Use this inside dry-run mode to get the "would-be" content of a file.
   *
   * @param {string} filePath
   * @returns {string|null}
   */
  readFile(filePath) {
    const absPath = this._resolve(filePath);
    if (this._virtualFS.has(absPath)) {
      return this._virtualFS.get(absPath);
    }
    try {
      return fs.readFileSync(absPath, 'utf-8');
    } catch (_) {
      return null;
    }
  }

  // ─── Apply / Reset ────────────────────────────────────────────────────────────

  /**
   * Executes all pending operations against the real file system.
   * Call this after reviewing the dry-run report to commit the changes.
   *
   * @returns {{ applied: number, failed: number, errors: string[] }}
   */
  async apply() {
    let applied = 0;
    let failed  = 0;
    const errors = [];

    console.log(`\n[DryRunSandbox] Applying ${this._ops.length} pending operation(s)...`);

    for (const op of this._ops) {
      try {
        switch (op.type) {
          case OpType.WRITE: {
            const dir = path.dirname(op.path);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            // Atomic write: tmp → rename
            const tmp = op.path + '.sandbox_tmp';
            fs.writeFileSync(tmp, op.content, 'utf-8');
            fs.renameSync(tmp, op.path);
            console.log(`[DryRunSandbox] ✅ ${op.isNew ? 'Created' : 'Overwrote'}: ${op.relPath}`);
            applied++;
            break;
          }
          case OpType.PATCH: {
            if (!fs.existsSync(op.path)) {
              errors.push(`PATCH target not found: ${op.relPath}`);
              failed++;
              break;
            }
            const original = fs.readFileSync(op.path, 'utf-8');
            if (!original.includes(op.findStr)) {
              errors.push(`PATCH find-string not found in: ${op.relPath}`);
              failed++;
              break;
            }
            const patched = original.replace(op.findStr, op.replaceStr);
            const tmp = op.path + '.sandbox_tmp';
            fs.writeFileSync(tmp, patched, 'utf-8');
            fs.renameSync(tmp, op.path);
            console.log(`[DryRunSandbox] ✅ Patched: ${op.relPath}`);
            applied++;
            break;
          }
          case OpType.DELETE: {
            if (fs.existsSync(op.path)) {
              fs.unlinkSync(op.path);
              console.log(`[DryRunSandbox] ✅ Deleted: ${op.relPath}`);
            } else {
              console.warn(`[DryRunSandbox] ⚠️  Delete target not found (skipped): ${op.relPath}`);
            }
            applied++;
            break;
          }
          case OpType.RENAME: {
            if (!fs.existsSync(op.path)) {
              errors.push(`RENAME source not found: ${op.relPath}`);
              failed++;
              break;
            }
            const toDir = path.dirname(op.toPath);
            if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
            fs.renameSync(op.path, op.toPath);
            console.log(`[DryRunSandbox] ✅ Renamed: ${op.relPath} → ${op.toRelPath}`);
            applied++;
            break;
          }
          case OpType.MKDIR: {
            if (!fs.existsSync(op.path)) {
              fs.mkdirSync(op.path, { recursive: true });
              console.log(`[DryRunSandbox] ✅ Created dir: ${op.relPath}`);
            }
            applied++;
            break;
          }
          default:
            errors.push(`Unknown op type: ${op.type}`);
            failed++;
        }
      } catch (err) {
        errors.push(`Failed to apply ${op.type} on ${op.relPath}: ${err.message}`);
        failed++;
      }
    }

    console.log(`[DryRunSandbox] Apply complete: ${applied} applied, ${failed} failed.`);
    if (errors.length > 0) {
      console.warn(`[DryRunSandbox] Errors:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    }

    return { applied, failed, errors };
  }

  /**
   * Clears all pending operations and the virtual FS.
   */
  reset() {
    this._ops = [];
    this._virtualFS.clear();
    console.log('[DryRunSandbox] Reset: all pending operations cleared.');
  }

  // ─── Reporting ────────────────────────────────────────────────────────────────

  /**
   * Returns a human-readable markdown report of all pending operations.
   *
   * @returns {string}
   */
  report() {
    if (this._ops.length === 0) {
      return '## Dry-Run Report\n\n_No pending operations._\n';
    }

    const byType = {};
    for (const op of this._ops) {
      byType[op.type] = (byType[op.type] || 0) + 1;
    }

    const lines = [
      '## Dry-Run Report',
      '',
      `**Total operations:** ${this._ops.length}`,
      Object.entries(byType).map(([t, n]) => `- ${t.toUpperCase()}: ${n}`).join('\n'),
      '',
      '### Pending Operations',
      '',
    ];

    for (let i = 0; i < this._ops.length; i++) {
      const op = this._ops[i];
      const idx = String(i + 1).padStart(3, '0');

      switch (op.type) {
        case OpType.WRITE:
          lines.push(`**[${idx}] ${op.isNew ? '🆕 CREATE' : '✏️  OVERWRITE'}** \`${op.relPath}\``);
          lines.push(`> ${op.content.split('\n').length} lines, ${op.content.length} chars`);
          // Show first 5 lines as preview
          const preview = op.content.split('\n').slice(0, 5).join('\n');
          lines.push('```');
          lines.push(preview);
          if (op.content.split('\n').length > 5) lines.push('...');
          lines.push('```');
          break;
        case OpType.PATCH:
          lines.push(`**[${idx}] 🔧 PATCH** \`${op.relPath}\``);
          lines.push(`> Find: \`${op.findStr.slice(0, 80).replace(/\n/g, '↵')}\``);
          lines.push(`> Replace: \`${op.replaceStr.slice(0, 80).replace(/\n/g, '↵')}\``);
          break;
        case OpType.DELETE:
          lines.push(`**[${idx}] 🗑️  DELETE** \`${op.relPath}\``);
          break;
        case OpType.RENAME:
          lines.push(`**[${idx}] ✂️  RENAME** \`${op.relPath}\` → \`${op.toRelPath}\``);
          break;
        case OpType.MKDIR:
          lines.push(`**[${idx}] 📁 MKDIR** \`${op.relPath}\``);
          break;
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Generated at ${new Date().toISOString()}*`);

    return lines.join('\n');
  }

  /**
   * Saves the dry-run report to output/dry-run-report.md.
   *
   * @returns {string} path to the saved report file
   */
  saveReport() {
    const reportPath = path.join(this.outputDir, 'dry-run-report.md');
    try {
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }
      fs.writeFileSync(reportPath, this.report(), 'utf-8');
      console.log(`[DryRunSandbox] Report saved to: ${reportPath}`);
    } catch (err) {
      console.warn(`[DryRunSandbox] Could not save report: ${err.message}`);
    }
    return reportPath;
  }

  /**
   * Returns the list of pending operations (read-only copy).
   *
   * @returns {Array<PendingOp>}
   */
  getPendingOps() {
    return [...this._ops];
  }

  /**
   * Returns the count of pending operations.
   *
   * @returns {number}
   */
  get pendingCount() {
    return this._ops.length;
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────────

  _resolve(filePath) {
    return path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);
  }

  _rel(absPath) {
    return path.relative(this.projectRoot, absPath).replace(/\\/g, '/');
  }
}

module.exports = { DryRunSandbox, OpType };
