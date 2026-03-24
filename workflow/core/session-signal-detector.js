/**
 * Session Signal Detector – Automatic capture of "pitfall moments" from workflow sessions
 *
 * ADR-43: Signal-Driven Experience Capture
 *
 * Inspired by the insight that "1% of sessions contain real knowledge":
 * - Most workflow sessions are routine and produce no novel experience
 * - Only sessions with "pitfall signals" (errors, retries, contradictions) contain
 *   actionable knowledge worth capturing
 *
 * Signal Types:
 *   1. ERROR_KEYWORD  – Explicit error/exception/failure mentions
 *   2. NEGATION       – "doesn't work", "not supported", "can't do"
 *   3. RETRY_PATTERN  – Same file edited multiple times in short succession
 *   4. TOOL_DENSITY   – High tool call density (indicating debugging session)
 *   5. COMPLAINT_FILED – ComplaintWall.file() was called during session
 *
 * Design Principles:
 *   - Zero daemon: only runs during _finalizeWorkflow()
 *   - Token-efficient: regex-based detection, LLM only for extraction
 *   - IDE-First compliant: no background processes
 *
 * @module workflow/core/session-signal-detector
 */

'use strict';

// ─── Signal Types ──────────────────────────────────────────────────────────

const SignalType = {
  ERROR_KEYWORD: 'error_keyword',
  NEGATION: 'negation',
  RETRY_PATTERN: 'retry_pattern',
  TOOL_DENSITY: 'tool_density',
  COMPLAINT_FILED: 'complaint_filed',
};

const SignalSeverity = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

// ─── Signal Detection Patterns ─────────────────────────────────────────────

/**
 * Keyword-based signal patterns.
 * Fast regex detection, no LLM needed for initial screening.
 */
const SIGNAL_PATTERNS = [
  // ── Error Keywords (HIGH) ───────────────────────────────────────────────
  {
    type: SignalType.ERROR_KEYWORD,
    severity: SignalSeverity.HIGH,
    patterns: [
      /\b(error|exception|failed|failure|崩溃|报错|异常|失败)\b/i,
      /\b(cannot|can't|unable to|couldn't|无法|不能)\s+\w+/i,
      /\b(unsupported|not supported|不支持)\b/i,
      /\b(timeout|timed out|超时)\b/i,
    ],
    weight: 1.0,
  },

  // ── Negation Patterns (MEDIUM) ──────────────────────────────────────────
  {
    type: SignalType.NEGATION,
    severity: SignalSeverity.MEDIUM,
    patterns: [
      /\b(doesn't work|didn't work|not working|不工作|没用)\b/i,
      /\b(no solution|no way|没办法|无法解决)\b/i,
      /\b(workaround|绕过|规避)\b/i,
      /\b(gotcha|陷阱|坑|注意)\b/i,
    ],
    weight: 0.7,
  },

  // ── Debugging Indicators (MEDIUM) ───────────────────────────────────────
  {
    type: SignalType.TOOL_DENSITY,
    severity: SignalSeverity.MEDIUM,
    patterns: [
      /\b(debug|调试|排查|定位)\b/i,
      /\b(investigate|分析|诊断)\b/i,
      /\b(root cause|根本原因|原因)\b/i,
    ],
    weight: 0.6,
  },
];

// ─── Session Signal Detector Class ────────────────────────────────────────

class SessionSignalDetector {
  /**
   * @param {object} opts
   * @param {object} [opts.orchestrator] - Orchestrator instance for context
   * @param {boolean} [opts.verbose=false]
   */
  constructor(opts = {}) {
    this._orch = opts.orchestrator || null;
    this._verbose = opts.verbose || false;

    // Session state tracking
    this._fileEditCounts = new Map();  // filePath → edit count
    this._toolCallCount = 0;
    this._complaintFiled = false;
    this._sessionStartTime = Date.now();
    this._detectedSignals = [];
  }

  // ─── Public API: Event Tracking ─────────────────────────────────────────

  /**
   * Track a file edit event. Called by Orchestrator on each file modification.
   * High edit count on same file indicates debugging/struggle pattern.
   *
   * @param {string} filePath - Path to the edited file
   */
  trackFileEdit(filePath) {
    const count = this._fileEditCounts.get(filePath) || 0;
    this._fileEditCounts.set(filePath, count + 1);
  }

  /**
   * Track a tool call event. Called by Orchestrator on each tool invocation.
   * High tool density indicates active debugging session.
   */
  trackToolCall() {
    this._toolCallCount++;
  }

  /**
   * Mark that a complaint was filed during this session.
   * This is a strong signal that something went wrong.
   */
  markComplaintFiled() {
    this._complaintFiled = true;
  }

  // ─── Public API: Signal Detection ───────────────────────────────────────

  /**
   * Detect signals from session artifacts (logs, decisions, outputs).
   * Called during _finalizeWorkflow() to determine if experience capture is warranted.
   *
   * @param {object} sessionContext
   * @param {string} [sessionContext.decisionLog] - Decision trail content
   * @param {string} [sessionContext.errorLog] - Error messages from session
   * @param {string} [sessionContext.outputSummary] - Summary of outputs produced
   * @returns {{ signals: object[], score: number, shouldCapture: boolean }}
   */
  detectSignals(sessionContext = {}) {
    const signals = [];
    const seenTypes = new Set();

    // 1. Check complaint filed flag (highest priority)
    if (this._complaintFiled) {
      signals.push({
        type: SignalType.COMPLAINT_FILED,
        severity: SignalSeverity.HIGH,
        weight: 1.0,
        source: 'complaint-wall',
        evidence: 'Complaint was filed during this session',
      });
      seenTypes.add(SignalType.COMPLAINT_FILED);
    }

    // 2. Check retry pattern (same file edited multiple times)
    for (const [filePath, count] of this._fileEditCounts) {
      if (count >= 3) {
        signals.push({
          type: SignalType.RETRY_PATTERN,
          severity: SignalSeverity.HIGH,
          weight: 0.9,
          source: 'file-edit-tracker',
          evidence: `File "${filePath}" edited ${count} times (retry pattern)`,
          filePath,
          editCount: count,
        });
        seenTypes.add(SignalType.RETRY_PATTERN);
        break; // Only report once
      }
    }

    // 3. Check tool density (high tool call count indicates debugging)
    const sessionDurationMin = (Date.now() - this._sessionStartTime) / 60000;
    const toolDensity = sessionDurationMin > 0 ? this._toolCallCount / sessionDurationMin : 0;
    if (toolDensity > 5) { // More than 5 tool calls per minute
      signals.push({
        type: SignalType.TOOL_DENSITY,
        severity: SignalSeverity.MEDIUM,
        weight: 0.6,
        source: 'tool-call-tracker',
        evidence: `High tool density: ${this._toolCallCount} calls in ${sessionDurationMin.toFixed(1)}min (${toolDensity.toFixed(1)}/min)`,
        toolCallCount: this._toolCallCount,
        toolDensity: toolDensity.toFixed(2),
      });
      seenTypes.add(SignalType.TOOL_DENSITY);
    }

    // 4. Scan text content for keyword patterns
    const textToScan = [
      sessionContext.decisionLog || '',
      sessionContext.errorLog || '',
      sessionContext.outputSummary || '',
    ].join('\n');

    for (const detector of SIGNAL_PATTERNS) {
      if (seenTypes.has(detector.type)) continue; // Skip already detected

      for (const pattern of detector.patterns) {
        const match = textToScan.match(pattern);
        if (match) {
          signals.push({
            type: detector.type,
            severity: detector.severity,
            weight: detector.weight,
            source: 'keyword-pattern',
            evidence: match[0],
            pattern: pattern.source,
          });
          seenTypes.add(detector.type);
          break; // Only report first match per detector
        }
      }
    }

    // 5. Calculate composite score
    const score = signals.reduce((sum, s) => sum + s.weight, 0);

    // 6. Determine if capture is warranted
    // Threshold: score >= 1.0 OR any HIGH severity signal
    const shouldCapture = score >= 1.0 || signals.some(s => s.severity === SignalSeverity.HIGH);

    this._detectedSignals = signals;

    if (this._verbose && signals.length > 0) {
      console.log(`[SessionSignalDetector] 🎯 Detected ${signals.length} signal(s), score=${score.toFixed(2)}, shouldCapture=${shouldCapture}`);
      for (const s of signals) {
        console.log(`  - [${s.severity.toUpperCase()}] ${s.type}: ${s.evidence.slice(0, 60)}`);
      }
    }

    return { signals, score, shouldCapture };
  }

  /**
   * Build an LLM prompt to extract structured experience from detected signals.
   * Only called when shouldCapture is true.
   *
   * @param {object} sessionContext
   * @returns {string} LLM prompt for experience extraction
   */
  buildExtractionPrompt(sessionContext = {}) {
    const signalSummary = this._detectedSignals.map(s =>
      `- [${s.severity.toUpperCase()}] ${s.type}: ${s.evidence}`
    ).join('\n');

    const fileEditSummary = Array.from(this._fileEditCounts.entries())
      .filter(([_, count]) => count > 1)
      .map(([file, count]) => `${file} (${count} edits)`)
      .join(', ');

    return [
      `You are an expert software engineer extracting actionable experience from a workflow session.`,
      ``,
      `## Session Context`,
      `Duration: ${((Date.now() - this._sessionStartTime) / 60000).toFixed(1)} minutes`,
      `Tool calls: ${this._toolCallCount}`,
      `Complaint filed: ${this._complaintFiled ? 'Yes' : 'No'}`,
      fileEditSummary ? `Files with multiple edits: ${fileEditSummary}` : '',
      ``,
      `## Detected Signals`,
      signalSummary,
      ``,
      `## Task`,
      `Based on the signals above, extract 1-2 actionable experiences.`,
      `Focus on WHAT WENT WRONG and HOW IT WAS RESOLVED (or what the blocker is).`,
      ``,
      `## Output Format`,
      `Return ONLY a JSON object:`,
      `{`,
      `  "experiences": [`,
      `    {`,
      `      "type": "negative" or "positive",`,
      `      "category": "pitfall" | "stable_pattern" | "debug_technique" | "framework_limit",`,
      `      "title": "<concise title, max 60 chars>",`,
      `      "content": "<2-3 sentence actionable description>",`,
      `      "tags": ["<relevant>", "<keywords>"]`,
      `    }`,
      `  ]`,
      `}`,
      ``,
      `## Rules`,
      `- Only extract if there's a CLEAR, ACTIONABLE lesson`,
      `- Negative experiences should describe the pitfall AND the solution/workaround`,
      `- Positive experiences should describe a pattern that worked well`,
      `- If no clear lesson, return empty experiences array`,
      ``,
      sessionContext.decisionLog ? `## Decision Log\n${sessionContext.decisionLog.slice(0, 3000)}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Get session statistics for reporting.
   *
   * @returns {object} Session stats
   */
  getStats() {
    return {
      durationMs: Date.now() - this._sessionStartTime,
      toolCallCount: this._toolCallCount,
      fileEditCount: this._fileEditCounts.size,
      totalEdits: Array.from(this._fileEditCounts.values()).reduce((a, b) => a + b, 0),
      complaintFiled: this._complaintFiled,
      signalCount: this._detectedSignals.length,
      signalScore: this._detectedSignals.reduce((sum, s) => sum + s.weight, 0),
    };
  }

  /**
   * Reset detector state for a new session.
   */
  reset() {
    this._fileEditCounts.clear();
    this._toolCallCount = 0;
    this._complaintFiled = false;
    this._sessionStartTime = Date.now();
    this._detectedSignals = [];
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────

module.exports = {
  SessionSignalDetector,
  SignalType,
  SignalSeverity,
  SIGNAL_PATTERNS,
};
