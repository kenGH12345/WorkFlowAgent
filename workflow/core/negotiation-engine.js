/**
 * Agent Negotiation Protocol (P1-2, Karpathy)
 *
 * Implements structured inter-agent negotiation to reduce wasteful rollbacks.
 * When a downstream agent (e.g., DeveloperAgent) discovers an incompatibility
 * with an upstream artifact (e.g., architecture.md), it can raise a negotiation
 * request instead of triggering a full rollback.
 *
 * The orchestrator mediates between agents, either auto-resolving minor
 * concerns or escalating to human review via the Socratic engine.
 *
 * Design: Hook-based, zero coupling to specific agent implementations.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Concern Types ──────────────────────────────────────────────────────────

const ConcernType = {
  INTERFACE_MISMATCH: 'interface_mismatch',
  TECH_CONSTRAINT:    'tech_constraint',
  SCOPE_OVERFLOW:     'scope_overflow',
  QUALITY_THRESHOLD:  'quality_threshold',
};

// ─── Resolution Strategies ──────────────────────────────────────────────────

const Resolution = {
  AUTO_APPROVE:       'auto_approve',
  TARGETED_ROLLBACK:  'targeted_rollback',
  HUMAN_REVIEW:       'human_review',
  SUGGESTION_APPLIED: 'suggestion_applied',
  NEGOTIATION_FAILED: 'negotiation_failed',
};

// ─── Negotiation Engine ─────────────────────────────────────────────────────

class NegotiationEngine {
  /**
   * @param {object} opts
   * @param {string}   opts.outputDir - Directory for negotiation log
   * @param {number}   [opts.maxRounds=2] - Max negotiation rounds per stage
   */
  constructor({ outputDir, maxRounds = 2 } = {}) {
    this._outputDir = outputDir;
    this._maxRounds = maxRounds;
    this._log = []; // In-memory negotiation history for current session
    this._roundCounters = new Map(); // stageKey → round count
  }

  /**
   * Handles a negotiation request from a downstream agent.
   *
   * @param {object} request
   * @param {string} request.fromStage  - The downstream stage raising the concern (e.g. 'CODE')
   * @param {string} request.toStage    - The upstream stage to negotiate with (e.g. 'ARCHITECT')
   * @param {string} request.concernType - One of ConcernType values
   * @param {string} request.description - Human-readable description of the concern
   * @param {string} [request.suggestion] - Proposed resolution from the downstream agent
   * @param {object} [request.context]   - Additional context (file paths, line numbers, etc.)
   * @returns {{ resolution: string, action: string, detail: string }}
   */
  negotiate(request) {
    const { fromStage, toStage, concernType, description, suggestion, context } = request;
    const stageKey = `${fromStage}->${toStage}`;
    const round = (this._roundCounters.get(stageKey) || 0) + 1;

    // Guard: max negotiation rounds
    if (round > this._maxRounds) {
      const entry = this._createLogEntry(request, round, {
        resolution: Resolution.NEGOTIATION_FAILED,
        action: 'rollback',
        detail: `Max negotiation rounds (${this._maxRounds}) exceeded. Falling back to rollback.`,
      });
      this._log.push(entry);
      return entry.result;
    }

    this._roundCounters.set(stageKey, round);

    // ── Resolution Strategy Selection ──────────────────────────────────
    let result;

    switch (concernType) {
      case ConcernType.INTERFACE_MISMATCH:
        // Minor mismatches can be auto-resolved if a suggestion is provided
        if (suggestion) {
          result = {
            resolution: Resolution.SUGGESTION_APPLIED,
            action: 'adjust_downstream',
            detail: `Interface mismatch resolved via downstream suggestion: ${suggestion}`,
          };
        } else {
          result = {
            resolution: Resolution.TARGETED_ROLLBACK,
            action: 'rollback_upstream',
            detail: `Interface mismatch requires upstream stage (${toStage}) to revise output.`,
          };
        }
        break;

      case ConcernType.TECH_CONSTRAINT:
        // Tech constraints usually need upstream acknowledgement
        result = suggestion
          ? {
              resolution: Resolution.AUTO_APPROVE,
              action: 'adjust_downstream',
              detail: `Tech constraint resolved with alternative: ${suggestion}`,
            }
          : {
              resolution: Resolution.TARGETED_ROLLBACK,
              action: 'rollback_upstream',
              detail: `Tech constraint requires architecture revision.`,
            };
        break;

      case ConcernType.SCOPE_OVERFLOW:
        // Always escalate to human — scope changes need human approval
        result = {
          resolution: Resolution.HUMAN_REVIEW,
          action: 'escalate',
          detail: `Scope overflow: "${description}". Requires human decision.`,
        };
        break;

      case ConcernType.QUALITY_THRESHOLD:
        // Quality thresholds: auto-approve with warning if within tolerance
        result = {
          resolution: Resolution.AUTO_APPROVE,
          action: 'adjust_threshold',
          detail: `Quality threshold concern noted. Proceeding with adjusted expectations.`,
        };
        break;

      default:
        result = {
          resolution: Resolution.HUMAN_REVIEW,
          action: 'escalate',
          detail: `Unknown concern type "${concernType}". Escalating to human review.`,
        };
    }

    const entry = this._createLogEntry(request, round, result);
    this._log.push(entry);
    console.log(`[Negotiation] ${stageKey} Round ${round}: ${result.resolution} → ${result.action}`);

    return result;
  }

  /**
   * Returns the full negotiation log for the current session.
   */
  getLog() {
    return [...this._log];
  }

  /**
   * Persists the negotiation log to disk.
   */
  flush() {
    if (this._log.length === 0) return;
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      const logPath = path.join(this._outputDir, 'negotiation-log.json');
      const existing = fs.existsSync(logPath)
        ? JSON.parse(fs.readFileSync(logPath, 'utf-8'))
        : [];
      const merged = [...existing, ...this._log];
      fs.writeFileSync(logPath, JSON.stringify(merged, null, 2), 'utf-8');
      console.log(`[Negotiation] 📋 ${this._log.length} entry/entries written to ${logPath}`);
    } catch (err) {
      console.warn(`[Negotiation] ⚠️ Failed to write negotiation log: ${err.message}`);
    }
  }

  /**
   * Resets round counters for a new workflow run.
   */
  reset() {
    this._roundCounters.clear();
  }

  // ─── Private ──────────────────────────────────────────────────────────

  _createLogEntry(request, round, result) {
    return {
      timestamp: new Date().toISOString(),
      fromStage: request.fromStage,
      toStage: request.toStage,
      round,
      concernType: request.concernType,
      description: request.description,
      suggestion: request.suggestion || null,
      result,
    };
  }
}

module.exports = { NegotiationEngine, ConcernType, Resolution };
