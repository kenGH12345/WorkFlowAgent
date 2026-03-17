/**
 * Complaint Wall – Error correction feedback loop (吐槽墙)
 *
 * Inspired by AgentFlow's complaint/correction mechanism:
 *  - Agents can challenge incorrect experiences, skills, or workflow rules
 *  - Prevents knowledge base from solidifying errors
 *  - Forms the closed loop: task → experience → complaint → rule correction → evolution
 *  - Severity levels: frustrating > annoying > minor
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./constants');

// Lazy-loaded to avoid circular dependency (ExperienceStore → ComplaintWall → ExperienceStore).
// Resolved on first use inside methods that need ExperienceType/ExperienceCategory.
let _experienceTypes = null;
function _getExpTypes() {
  if (!_experienceTypes) {
    _experienceTypes = require('./experience-store');
  }
  return _experienceTypes;
}

// ─── Complaint Severity ───────────────────────────────────────────────────────

const ComplaintSeverity = {
  FRUSTRATING: 'frustrating',  // Blocks progress, must fix immediately
  ANNOYING:    'annoying',     // Causes repeated errors, should fix soon
  MINOR:       'minor',        // Small inconsistency, fix when convenient
};

// ─── AEF Root Cause Classification ────────────────────────────────────────────
// From AEF self-refinement: every error has one of four root causes.
// Used for structured error analysis and targeted skill evolution.

const RootCause = {
  SPEC_MISSING:    'spec-missing',     // No rule/skill covers this scenario
  KNOWLEDGE_GAP:   'knowledge-gap',    // AI lacks project-specific domain knowledge
  PROCESS_SKIP:    'process-skip',     // Workflow skill missing a critical step or checkpoint
  PATTERN_WRONG:   'pattern-wrong',    // AI applied wrong reasoning pattern (analogy vs first principles)
};

// ─── Complaint Target Types ───────────────────────────────────────────────────

const ComplaintTarget = {
  EXPERIENCE: 'experience',  // A specific experience entry is wrong
  SKILL:      'skill',       // A skill's rule/SOP is incorrect
  WORKFLOW:   'workflow',    // A workflow process/rule is problematic
  TOOL:       'tool',        // A tool behaves unexpectedly
};

// ─── Complaint Status ─────────────────────────────────────────────────────────

const ComplaintStatus = {
  OPEN:     'open',      // Not yet addressed
  RESOLVED: 'resolved',  // Fixed and verified
  WONTFIX:  'wontfix',   // Acknowledged but won't be changed
};

// ─── Complaint Wall ───────────────────────────────────────────────────────────

class ComplaintWall {
  /**
   * @param {string} [storePath] - Path to persist complaints JSON
   */
  /**
   * @param {string} [storePath] - Path to persist complaints JSON
   * @param {object} [options]
   * @param {object} [options.experienceStore] - ExperienceStore instance for bidirectional sync.
   *   Defect F fix: when provided, enables two automatic bridges:
   *   1. resolve() → creates a POSITIVE experience capturing the resolution (knowledge extraction)
   *   2. ExperienceStore negative records → auto-filed as complaints (problem tracking)
   *   Both bridges are idempotent and safe to call multiple times.
   */
  constructor(storePath = null, { experienceStore = null } = {}) {
    this.storePath = storePath || path.join(PATHS.OUTPUT_DIR, 'complaints.json');
    /** @type {Complaint[]} */
    this.complaints = [];
    // N44 fix: monotonic counter to guarantee unique IDs even within the same millisecond.
    this._idSeq = 0;
    // Defect F fix: optional ExperienceStore reference for bidirectional sync
    this._experienceStore = experienceStore;
    this._load();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Files a new complaint.
   *
   * @param {object} options
   * @param {string}   options.targetType   - ComplaintTarget value
   * @param {string}   options.targetId     - ID of the target (experience ID, skill name, etc.)
   * @param {string}   options.severity     - ComplaintSeverity value
   * @param {string}   options.description  - What is wrong
   * @param {string}   options.suggestion   - Proposed correction
   * @param {string}   [options.agentId]    - Agent filing the complaint
   * @param {string}   [options.taskId]     - Task where the issue was encountered
   * @returns {Complaint}
   */
  file({ targetType, targetId, severity, description, suggestion, agentId = 'unknown', taskId = null, rootCause = null }) {
    // N44 fix: include a monotonic sequence number to avoid ID collisions within the same ms.
    const id = `CMP-${Date.now()}-${String(this._idSeq++).padStart(4, '0')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const complaint = {
      id,
      targetType,
      targetId,
      severity,
      description,
      suggestion,
      rootCause: rootCause || null,   // AEF root cause classification
      agentId,
      taskId,
      status: ComplaintStatus.OPEN,
      resolution: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.complaints.push(complaint);
    this._save();
    console.warn(`[ComplaintWall] 🗣️ Complaint filed [${severity}]: ${description.length > 80 ? description.slice(0, 80) + '...' : description}`);
    return complaint;
  }

  /**
   * Resolves a complaint with a resolution note.
   *
   * @param {string} complaintId
   * @param {string} resolution - What was done to fix it
   * @param {string} [status]   - ComplaintStatus.RESOLVED or WONTFIX
   */
  resolve(complaintId, resolution, status = ComplaintStatus.RESOLVED) {
    const complaint = this._getComplaint(complaintId);
    complaint.status = status;
    complaint.resolution = resolution;
    complaint.updatedAt = new Date().toISOString();
    this._save();
    console.log(`[ComplaintWall] Complaint resolved: ${complaintId}`);

    // ── Defect F fix: bridge resolved complaint → positive experience ──────────
    // When a complaint is RESOLVED (not WONTFIX), the resolution contains actionable
    // knowledge that should be preserved in ExperienceStore as a POSITIVE experience.
    // This closes the loop: problem (complaint) → solution (experience) → prevention.
    //
    // The experience title is derived from the complaint to enable dedup:
    //   "Resolved: [target] description" — if the same complaint is resolved again
    //   (e.g. after reopening), recordIfAbsent() prevents duplicate entries.
    if (status === ComplaintStatus.RESOLVED && this._experienceStore) {
      try {
        const { ExperienceType, ExperienceCategory } = _getExpTypes();
        const title = `Resolved: [${complaint.targetType}:${complaint.targetId}] ${complaint.description.slice(0, 80)}`;
        this._experienceStore.recordIfAbsent(title, {
          type:     ExperienceType.POSITIVE,
          category: ExperienceCategory.STABLE_PATTERN,
          title,
          content:  [
            `Problem: ${complaint.description}`,
            `Target: ${complaint.targetType}:${complaint.targetId} (severity: ${complaint.severity})`,
            `Resolution: ${resolution}`,
            `Suggestion that led to fix: ${complaint.suggestion}`,
          ].join('\n'),
          skill:    complaint.targetId,
          tags:     [complaint.targetType, complaint.targetId, 'complaint-resolved', complaint.severity],
        });
        console.log(`[ComplaintWall] 🔗 Experience created from resolved complaint: ${complaintId}`);
      } catch (err) {
        // Non-fatal: complaint resolution succeeds even if experience creation fails
        console.warn(`[ComplaintWall] ⚠️  Failed to create experience from complaint: ${err.message}`);
      }
    }
  }

  /**
   * Returns all open complaints, sorted by severity.
   *
   * @returns {Complaint[]}
   */
  getOpenComplaints() {
    const severityOrder = {
      [ComplaintSeverity.FRUSTRATING]: 0,
      [ComplaintSeverity.ANNOYING]:    1,
      [ComplaintSeverity.MINOR]:       2,
    };
    return this.complaints
      .filter(c => c.status === ComplaintStatus.OPEN)
      .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }

  /**
   * Returns open complaints for a specific target type and target ID, sorted by severity.
   * N27 fix: convenience method to avoid callers manually filtering with wrong field names.
   *
   * @param {string} targetType - ComplaintTarget value (e.g. ComplaintTarget.SKILL)
   * @param {string} targetId   - Target identifier (e.g. skill name)
   * @returns {Complaint[]}
   */
  getOpenComplaintsFor(targetType, targetId) {
    const severityOrder = {
      [ComplaintSeverity.FRUSTRATING]: 0,
      [ComplaintSeverity.ANNOYING]:    1,
      [ComplaintSeverity.MINOR]:       2,
    };
    return this.complaints
      .filter(c => c.status === ComplaintStatus.OPEN && c.targetType === targetType && c.targetId === targetId)
      .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }

  /**
   * Returns complaints targeting a specific experience or skill.
   *
   * @param {string} targetType
   * @param {string} targetId
   * @returns {Complaint[]}
   */
  getComplaintsFor(targetType, targetId) {
    return this.complaints.filter(c => c.targetType === targetType && c.targetId === targetId);
  }

  /**
   * Returns statistics about the complaint wall.
   *
   * @returns {object}
   */
  getStats() {
    const open = this.complaints.filter(c => c.status === ComplaintStatus.OPEN).length;
    const resolved = this.complaints.filter(c => c.status === ComplaintStatus.RESOLVED).length;
    const bySeverity = {};
    for (const sev of Object.values(ComplaintSeverity)) {
      bySeverity[sev] = this.complaints.filter(c => c.severity === sev).length;
    }
    return {
      total: this.complaints.length,
      open,
      resolved,
      bySeverity,
    };
  }

  /**
   * Returns a formatted summary for display.
   *
   * @returns {string}
   */
  getSummaryText() {
    const stats = this.getStats();
    const open = this.getOpenComplaints();
    const lines = [
      `## 🗣️ Complaint Wall`,
      `- Total: ${stats.total} | Open: ${stats.open} | Resolved: ${stats.resolved}`,
      `- By severity: 😤 frustrating=${stats.bySeverity[ComplaintSeverity.FRUSTRATING]} | 😒 annoying=${stats.bySeverity[ComplaintSeverity.ANNOYING]} | 🙄 minor=${stats.bySeverity[ComplaintSeverity.MINOR]}`,
    ];
    if (open.length > 0) {
      lines.push('\n### Open Complaints (needs attention)');
      for (const c of open.slice(0, 5)) {
        lines.push(`- [${c.severity.toUpperCase()}] [${c.targetType}:${c.targetId}] ${c.description}`);
        lines.push(`  → Suggestion: ${c.suggestion}`);
      }
    }
    return lines.join('\n');
  }

  // ─── Bidirectional Sync ─────────────────────────────────────────────────────

  /**
   * Sets or replaces the ExperienceStore reference for bidirectional sync.
   * Call this after construction if the store wasn't available at construction time.
   *
   * @param {object} experienceStore - ExperienceStore instance
   */
  setExperienceStore(experienceStore) {
    this._experienceStore = experienceStore;
  }

  /**
   * Defect F fix: creates a complaint from a NEGATIVE experience.
   *
   * Call this when a new negative experience is recorded in ExperienceStore.
   * The complaint serves as a visible "problem ticket" that needs attention,
   * while the experience serves as the knowledge record. Together they form
   * a closed loop: experience (knowledge) ↔ complaint (action item).
   *
   * Idempotent: if an open complaint already exists for the same experience ID,
   * no duplicate is created.
   *
   * @param {object} experience - The negative experience object from ExperienceStore
   * @returns {object|null} The created complaint, or null if skipped (duplicate)
   */
  fileFromNegativeExperience(experience) {
    if (!experience || experience.type !== 'negative') return null;

    // Dedup: check if an open complaint already targets this experience ID
    const existing = this.complaints.find(
      c => c.targetType === ComplaintTarget.EXPERIENCE
        && c.targetId === experience.id
        && c.status === ComplaintStatus.OPEN
    );
    if (existing) return null;

    // Map experience category to complaint severity
    const severity = experience.category === 'pitfall' ? ComplaintSeverity.ANNOYING : ComplaintSeverity.MINOR;

    return this.file({
      targetType:  ComplaintTarget.EXPERIENCE,
      targetId:    experience.id,
      severity,
      description: `[Auto] Negative experience recorded: ${experience.title}`,
      suggestion:  `Review and address the pitfall described in experience ${experience.id}. Once resolved, the resolution will be captured as a positive experience.`,
      agentId:     'system:experience-bridge',
      taskId:      experience.taskId || null,
    });
  }

  // ─── Troubleshooting Export ──────────────────────────────────────────────────

  /**
   * Exports resolved complaints as structured troubleshooting entries.
   * These entries can be fed into the SkillEvolutionEngine to auto-populate
   * a troubleshooting skill file.
   *
   * @param {object} [options]
   * @param {string}   [options.targetType] - Filter by target type
   * @param {number}   [options.since]      - Only include complaints resolved after this timestamp (ms)
   * @returns {{ entries: Array<{ title: string, error: string, rootCause: string, fix: string, prevention: string }>, count: number }}
   */
  exportToTroubleshooting({ targetType = null, since = 0 } = {}) {
    const resolved = this.complaints.filter(c => {
      if (c.status !== ComplaintStatus.RESOLVED) return false;
      if (targetType && c.targetType !== targetType) return false;
      if (since && new Date(c.updatedAt).getTime() < since) return false;
      return true;
    });

    const entries = resolved.map(c => ({
      title: `${c.targetType}:${c.targetId} — ${c.description.slice(0, 80)}`,
      error: c.description,
      rootCause: `Identified via complaint ${c.id} (severity: ${c.severity})`,
      fix: c.resolution || c.suggestion,
      prevention: c.suggestion,
      sourceComplaintId: c.id,
    }));

    return { entries, count: entries.length };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _getComplaint(id) {
    const c = this.complaints.find(c => c.id === id);
    if (!c) throw new Error(`[ComplaintWall] Complaint not found: "${id}"`);
    return c;
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        this.complaints = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        console.log(`[ComplaintWall] Loaded ${this.complaints.length} complaints`);
        // N54 fix: restore _idSeq from the highest seq number found in existing IDs
        // so the counter remains monotonically increasing across restarts.
        // ID format: CMP-{ts}-{seq}-{rand} (N44 fix). Parse the seq field (index 2).
        let maxSeq = -1;
        for (const c of this.complaints) {
          if (typeof c.id === 'string') {
            const parts = c.id.split('-');
            // parts: ['CMP', ts, seq, rand] – seq is at index 2
            if (parts.length >= 4) {
              const seq = parseInt(parts[2], 10);
              if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
            }
          }
        }
        if (maxSeq >= 0) {
          this._idSeq = maxSeq + 1;
        }
      }
    } catch (err) {
      console.warn(`[ComplaintWall] Could not load complaints: ${err.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // N37 fix: atomic write – write to a .tmp file first, then rename over the target.
      const tmpPath = this.storePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.complaints, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.storePath);
    } catch (err) {
      console.warn(`[ComplaintWall] Could not save complaints: ${err.message}`);
    }
  }
}

module.exports = { ComplaintWall, ComplaintSeverity, ComplaintTarget, ComplaintStatus, RootCause };
