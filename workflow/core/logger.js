/**
 * Structured Logger (P1-4)
 *
 * Replaces raw console.log/warn/error with structured JSON Lines logging.
 * Provides both human-readable console output and machine-parseable JSONL
 * output for CI environments and log aggregation tools.
 *
 * Design: Zero new dependencies. Wraps console.* with structured metadata.
 *
 * Usage:
 *   const { logger } = require('./logger');
 *   logger.info('StateMachine', 'Transition complete', { from: 'INIT', to: 'ANALYSE' });
 *   logger.warn('Orchestrator', 'Rollback triggered', { stage: 'CODE', reason: '...' });
 *   logger.error('Agent', 'LLM call failed', { role: 'DEVELOPER', err: err.message });
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Log Levels ──────────────────────────────────────────────────────────────

const LogLevel = {
  DEBUG: 'debug',
  INFO:  'info',
  WARN:  'warn',
  ERROR: 'error',
};

const LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };

// ─── Logger ──────────────────────────────────────────────────────────────────

class Logger {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.outputDir]      - Directory for log files
   * @param {string}  [opts.minLevel='info'] - Minimum level to emit
   * @param {boolean} [opts.jsonMode=false]  - Force JSON-only output (no console pretty-print)
   * @param {boolean} [opts.fileLogging=true] - Write JSONL log file
   * @param {string}  [opts.sessionId]       - Unique session identifier
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || null;
    this._minLevel = opts.minLevel || LogLevel.INFO;
    this._jsonMode = opts.jsonMode || (process.env.CODEXFORGE_LOG_FORMAT === 'json');
    this._fileLogging = opts.fileLogging !== false;
    this._sessionId = opts.sessionId || null;
    this._logStream = null;
    this._entryCount = 0;
  }

  /**
   * Set the output directory for JSONL log files.
   * Called lazily when the output directory becomes available.
   */
  setOutputDir(outputDir) {
    this._outputDir = outputDir;
    // Close existing stream if any
    if (this._logStream) {
      try { this._logStream.end(); } catch (_) {}
      this._logStream = null;
    }
  }

  /**
   * Set the session ID for correlating log entries.
   */
  setSessionId(sessionId) {
    this._sessionId = sessionId;
  }

  // ─── Public Logging Methods ───────────────────────────────────────────

  debug(component, message, data = {}) {
    this._emit(LogLevel.DEBUG, component, message, data);
  }

  info(component, message, data = {}) {
    this._emit(LogLevel.INFO, component, message, data);
  }

  warn(component, message, data = {}) {
    this._emit(LogLevel.WARN, component, message, data);
  }

  error(component, message, data = {}) {
    this._emit(LogLevel.ERROR, component, message, data);
  }

  // ─── Core Emit ────────────────────────────────────────────────────────

  _emit(level, component, message, data) {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this._minLevel]) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg: message,
      ...(this._sessionId ? { session: this._sessionId } : {}),
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };

    this._entryCount++;

    // Console output
    if (this._jsonMode) {
      // Pure JSON mode (for CI/log aggregation)
      process.stdout.write(JSON.stringify(entry) + '\n');
    } else {
      // Human-readable mode (default)
      const icon = { debug: '🔍', info: 'ℹ️', warn: '⚠️', error: '❌' }[level] || '';
      const prefix = `[${component}]`;
      const dataStr = Object.keys(data).length > 0
        ? ` ${JSON.stringify(data)}`
        : '';
      const consoleFn = level === 'error' ? console.error
                       : level === 'warn'  ? console.warn
                       : console.log;
      consoleFn(`${icon} ${prefix} ${message}${dataStr}`);
    }

    // File output (JSONL)
    if (this._fileLogging && this._outputDir) {
      this._writeToFile(entry);
    }
  }

  // ─── File Output ──────────────────────────────────────────────────────

  _writeToFile(entry) {
    try {
      if (!this._logStream) {
        if (!fs.existsSync(this._outputDir)) {
          fs.mkdirSync(this._outputDir, { recursive: true });
        }
        const logPath = path.join(this._outputDir, 'workflow.log.jsonl');
        this._logStream = fs.createWriteStream(logPath, { flags: 'a' });
      }
      this._logStream.write(JSON.stringify(entry) + '\n');
    } catch (_) {
      // File logging must never break the workflow
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  /**
   * Flushes and closes the log file stream.
   * Call this during _finalizeWorkflow().
   */
  flush() {
    if (this._logStream) {
      try { this._logStream.end(); } catch (_) {}
      this._logStream = null;
    }
    return this._entryCount;
  }

  /**
   * Returns a summary of log activity for the current session.
   */
  getStats() {
    return {
      entryCount: this._entryCount,
      sessionId: this._sessionId,
      minLevel: this._minLevel,
      jsonMode: this._jsonMode,
      fileLogging: this._fileLogging,
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

const logger = new Logger();

module.exports = { Logger, logger, LogLevel };
