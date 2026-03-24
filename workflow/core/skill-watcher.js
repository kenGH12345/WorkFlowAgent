/**
 * SkillWatcher – Hot-reload skill files when they change on disk
 *
 * Watches the skills/ directory for file changes and invalidates the
 * ContextLoader's file cache so that updated skills are picked up
 * on the next resolve() call without restarting the process.
 *
 * Design constraints:
 *  - Uses fs.watch() which is available on all Node.js platforms
 *  - Debounces rapid changes (e.g. editor save-then-format) by 300ms
 *  - Only invalidates the cache entry for the changed file (surgical, not full flush)
 *  - Emits events for external consumers (e.g. hooks, logging)
 *  - Graceful degradation: if fs.watch fails, logs a warning and continues
 *
 * Usage:
 *   const watcher = new SkillWatcher(contextLoader, skillsDir);
 *   watcher.start();
 *   // ... later ...
 *   watcher.stop();
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const EventEmitter = require('events');

// ─── Configuration ────────────────────────────────────────────────────────────

/** Debounce window (ms) – ignore rapid sequential changes to the same file */
const DEBOUNCE_MS = 300;

// ─── SkillWatcher ─────────────────────────────────────────────────────────────

class SkillWatcher extends EventEmitter {
  /**
   * @param {object} contextLoader - ContextLoader instance (must expose _fileCache Map)
   * @param {string} skillsDir     - Absolute path to skills/ directory
   * @param {object} [options]
   * @param {object} [options.skillEvolution] - SkillEvolutionEngine for registry refresh
   */
  constructor(contextLoader, skillsDir, { skillEvolution = null } = {}) {
    super();
    this._contextLoader = contextLoader;
    this._skillsDir = skillsDir;
    this._skillEvolution = skillEvolution;
    /** @type {fs.FSWatcher|null} */
    this._watcher = null;
    /** @type {Map<string, NodeJS.Timeout>} Debounce timers per file */
    this._debounceTimers = new Map();
    this._running = false;
  }

  /**
   * Starts watching the skills directory for changes.
   * Safe to call multiple times (idempotent).
   *
   * P1-9 fix: fs.watch() recursive option only works on macOS/Windows.
   * On Linux (inotify), we manually walk subdirectories and create
   * a watcher for each. Also changed persistent to true to prevent
   * premature event loop exit when no other handles are active.
   *
   * @returns {boolean} true if watcher started successfully
   */
  start() {
    if (this._running) return true;

    if (!fs.existsSync(this._skillsDir)) {
      console.warn(`[SkillWatcher] ⚠️  Skills directory does not exist: ${this._skillsDir}`);
      return false;
    }

    try {
      /** @type {fs.FSWatcher[]} */
      this._watchers = [];

      const watchDir = (dir) => {
        const watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
          if (!filename || !filename.endsWith('.md')) return;
          this._handleChange(eventType, filename);
        });

        watcher.on('error', (err) => {
          console.warn(`[SkillWatcher] ⚠️  Watch error on ${dir}: ${err.message}`);
          this.emit('error', err);
        });

        this._watchers.push(watcher);
      };

      // Watch the root skills directory
      watchDir(this._skillsDir);

      // P1-9 fix: On Linux, fs.watch doesn't support recursive.
      // Manually walk immediate subdirectories and watch each.
      try {
        const entries = fs.readdirSync(this._skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            watchDir(path.join(this._skillsDir, entry.name));
          }
        }
      } catch (_) { /* ignore subdir enumeration errors */ }

      this._running = true;
      console.log(`[SkillWatcher] 👀 Watching skills directory: ${this._skillsDir} (${this._watchers.length} watcher(s))`);
      this.emit('started');
      return true;
    } catch (err) {
      console.warn(`[SkillWatcher] ⚠️  Failed to start watcher: ${err.message}`);
      return false;
    }
  }

  /**
   * Stops watching. Safe to call multiple times.
   */
  stop() {
    if (!this._running) return;

    // Clear all pending debounce timers
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    // P1-9 fix: Close all watchers (may have multiple for subdirectories)
    if (this._watchers) {
      for (const watcher of this._watchers) {
        try { watcher.close(); } catch (_) {}
      }
      this._watchers = [];
    }
    // Legacy: close single watcher if present
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }

    this._running = false;
    console.log('[SkillWatcher] Stopped watching.');
    this.emit('stopped');
  }

  /**
   * Returns whether the watcher is currently active.
   * @returns {boolean}
   */
  isRunning() {
    return this._running;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Handles a file system change event with debouncing.
   * @param {string} eventType - 'rename' | 'change'
   * @param {string} filename  - e.g. 'go-crud.md'
   */
  _handleChange(eventType, filename) {
    // Debounce: if we already have a pending timer for this file, reset it
    if (this._debounceTimers.has(filename)) {
      clearTimeout(this._debounceTimers.get(filename));
    }

    const timer = setTimeout(() => {
      this._debounceTimers.delete(filename);
      this._invalidateFile(filename, eventType);
    }, DEBOUNCE_MS);

    this._debounceTimers.set(filename, timer);
  }

  /**
   * Invalidates the cached content for a changed skill file.
   * @param {string} filename  - e.g. 'go-crud.md'
   * @param {string} eventType - 'rename' | 'change'
   */
  _invalidateFile(filename, eventType) {
    const fullPath = path.join(this._skillsDir, filename);
    const skillName = filename.replace('.md', '');

    // Invalidate ContextLoader file cache
    if (this._contextLoader && this._contextLoader._fileCache) {
      const deleted = this._contextLoader._fileCache.delete(fullPath);
      if (deleted) {
        console.log(`[SkillWatcher] 🔄 Cache invalidated: ${filename}`);
      }
    }

    // If skill file was created/renamed, check if it needs registry update
    if (eventType === 'rename' && fs.existsSync(fullPath) && this._skillEvolution) {
      // New file detected – attempt to register if not already in registry
      const existing = this._skillEvolution.registry.get(skillName);
      if (!existing) {
        console.log(`[SkillWatcher] 📝 New skill file detected: ${filename}`);
        this.emit('skill:new', { filename, skillName, path: fullPath });
      }
    }

    this.emit('skill:changed', {
      filename,
      skillName,
      path: fullPath,
      eventType,
      timestamp: Date.now(),
    });

    console.log(`[SkillWatcher] ✨ Skill file ${eventType}: ${filename}`);
  }
}

module.exports = { SkillWatcher, DEBOUNCE_MS };
