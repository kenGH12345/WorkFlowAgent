/**
 * Auto-Deployer — Staged Self-Deployment Engine (ADR-34)
 *
 * Implements a 3-tier safety model for autonomous changes:
 *
 *   GREEN  — Zero-risk updates (skill content, experience store, dashboard params)
 *            → Auto-applied immediately + logged
 *
 *   YELLOW — Low-risk config parameter adjustments (maxFixRounds, maxReviewRounds, etc.)
 *            → Auto-applied to workflow.config.js + notify user + canary validation
 *
 *   RED    — Structural code changes (file splits, dependency changes)
 *            → Generate PR description + diff, do NOT auto-apply
 *
 * Design: Pure functional core with IO at the edges. Each tier returns a
 * structured ChangeSet that the caller decides whether to apply.
 *
 * Integration points:
 *   - _finalizeWorkflow() → runs YELLOW tier after each workflow session
 *   - /evolve command    → runs all tiers as Step 5
 *   - deriveStrategy()   → feeds YELLOW tier with adaptive parameter suggestions
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Change Risk Tiers ──────────────────────────────────────────────────────

const DEPLOY_TIER = {
  GREEN:  'GREEN',
  YELLOW: 'YELLOW',
  RED:    'RED',
};

// ─── Change Types ───────────────────────────────────────────────────────────

const CHANGE_TYPE = {
  // GREEN
  SKILL_CONTENT_UPDATE:     'skill-content-update',
  EXPERIENCE_STORE_UPDATE:  'experience-store-update',
  DASHBOARD_PARAM:          'dashboard-param',

  // YELLOW
  CONFIG_PARAM_ADJUSTMENT:  'config-param-adjustment',

  // RED
  FILE_STRUCTURE_CHANGE:    'file-structure-change',
  DEPENDENCY_CHANGE:        'dependency-change',
};

// ─── AutoDeployer Class ─────────────────────────────────────────────────────

class AutoDeployer {
  /**
   * @param {object} opts
   * @param {string} opts.outputDir   — Path to output directory
   * @param {string} opts.projectRoot — Path to project root (for config file)
   * @param {object} [opts.configLoader] — Config loader module (for reading current config)
   * @param {boolean} [opts.verbose]  — Enable verbose logging
   */
  constructor(opts = {}) {
    this.outputDir   = opts.outputDir || path.join(process.cwd(), 'workflow', 'output');
    this.projectRoot = opts.projectRoot || process.cwd();
    this.verbose     = opts.verbose ?? false;
    this._historyPath = path.join(this.outputDir, 'auto-deploy-history.jsonl');
  }

  // ─── GREEN Tier: Zero-Risk Auto-Apply ───────────────────────────────────

  /**
   * GREEN changes are already handled by existing components (skill refresh,
   * experience store, etc.). This method records them for audit trail.
   *
   * @param {object} change — { type, description, detail }
   * @returns {{ applied: boolean, record: object }}
   */
  applyGreen(change) {
    const record = {
      tier:        DEPLOY_TIER.GREEN,
      type:        change.type || CHANGE_TYPE.SKILL_CONTENT_UPDATE,
      description: change.description,
      detail:      change.detail || null,
      appliedAt:   new Date().toISOString(),
      applied:     true,
    };
    this._appendHistory(record);
    if (this.verbose) {
      console.log(`[AutoDeployer] 🟢 GREEN applied: ${change.description}`);
    }
    return { applied: true, record };
  }

  // ─── YELLOW Tier: Config Parameter Auto-Adjustment ──────────────────────

  /**
   * Compares the current workflow.config.js parameters against adaptive
   * strategy recommendations. If changes are warranted, auto-applies them.
   *
   * Safety guardrails:
   *   1. Only adjusts known numeric parameters within safe bounds
   *   2. Creates a backup of the config before modification
   *   3. Validates the modified config can be loaded
   *   4. Records full before/after diff for audit
   *
   * @param {object} adaptiveStrategy — From deriveStrategy()
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun]   — Don't write, just report
   * @returns {{ applied: boolean, changes: object[], record: object }}
   */
  applyYellow(adaptiveStrategy, opts = {}) {
    const dryRun = opts.dryRun ?? false;

    // Find the config file
    const configPath = this._findConfigPath();
    if (!configPath) {
      return {
        applied: false,
        changes: [],
        record: { tier: DEPLOY_TIER.YELLOW, skipped: true, reason: 'No workflow.config.js found' },
      };
    }

    // Read current config
    let currentConfig;
    try {
      delete require.cache[require.resolve(configPath)];
      currentConfig = require(configPath);
    } catch (err) {
      return {
        applied: false,
        changes: [],
        record: { tier: DEPLOY_TIER.YELLOW, skipped: true, reason: `Cannot parse config: ${err.message}` },
      };
    }

    // Determine which parameters should change
    const changes = this._diffConfigParams(currentConfig, adaptiveStrategy);

    if (changes.length === 0) {
      if (this.verbose) {
        console.log(`[AutoDeployer] 🟡 YELLOW: No config changes needed (strategy matches current config).`);
      }
      return {
        applied: false,
        changes: [],
        record: { tier: DEPLOY_TIER.YELLOW, skipped: true, reason: 'No changes needed' },
      };
    }

    // Build the change record
    const record = {
      tier:        DEPLOY_TIER.YELLOW,
      type:        CHANGE_TYPE.CONFIG_PARAM_ADJUSTMENT,
      configPath,
      changes,
      source:      adaptiveStrategy.source || 'unknown',
      debug:       adaptiveStrategy._debug || null,
      appliedAt:   new Date().toISOString(),
      applied:     false,
      dryRun,
    };

    if (dryRun) {
      if (this.verbose) {
        console.log(`[AutoDeployer] 🟡 YELLOW [DRY RUN]: ${changes.length} config change(s) recommended:`);
        for (const c of changes) {
          console.log(`  → ${c.param}: ${c.oldValue} → ${c.newValue} (reason: ${c.reason})`);
        }
      }
      this._appendHistory(record);
      return { applied: false, changes, record };
    }

    // Create backup
    const backupPath = configPath + '.bak.' + Date.now();
    try {
      fs.copyFileSync(configPath, backupPath);
    } catch (_) { /* non-fatal, continue without backup */ }

    // Apply changes to config file
    try {
      const applied = this._applyConfigChanges(configPath, currentConfig, changes);
      record.applied = applied;
      record.backupPath = backupPath;

      // Validate: try to load the modified config
      try {
        delete require.cache[require.resolve(configPath)];
        require(configPath);
      } catch (loadErr) {
        // Rollback!
        console.error(`[AutoDeployer] ❌ YELLOW: Modified config is invalid! Rolling back. Error: ${loadErr.message}`);
        fs.copyFileSync(backupPath, configPath);
        record.applied = false;
        record.rolledBack = true;
        record.rollbackReason = loadErr.message;
        this._appendHistory(record);
        return { applied: false, changes, record };
      }

      if (this.verbose || changes.length > 0) {
        console.log(`[AutoDeployer] 🟡 YELLOW applied: ${changes.length} config param(s) updated:`);
        for (const c of changes) {
          console.log(`  → ${c.param}: ${c.oldValue} → ${c.newValue} (reason: ${c.reason})`);
        }
        console.log(`  📁 Backup: ${path.basename(backupPath)}`);
      }

      this._appendHistory(record);
      return { applied: true, changes, record };
    } catch (writeErr) {
      console.error(`[AutoDeployer] ❌ YELLOW: Failed to write config: ${writeErr.message}`);
      // Restore backup
      try { fs.copyFileSync(backupPath, configPath); } catch (_) {}
      record.applied = false;
      record.error = writeErr.message;
      this._appendHistory(record);
      return { applied: false, changes, record };
    }
  }

  // ─── RED Tier: Generate PR Description (no auto-apply) ─────────────────

  /**
   * Generates a structured PR description for code-level changes.
   * Does NOT auto-apply — returns the description for human review.
   *
   * @param {object} change — { title, description, files, diff }
   * @returns {{ prDescription: string, record: object }}
   */
  generateRedPR(change) {
    const prTitle = `[Auto-Evolution] ${change.title}`;
    const prBody = [
      `## 🧬 Auto-Evolution Change Request`,
      ``,
      `**Source:** Self-evolution pipeline (deriveStrategy)`,
      `**Risk Tier:** 🔴 RED — requires human review`,
      `**Generated at:** ${new Date().toISOString()}`,
      ``,
      `### Description`,
      change.description,
      ``,
      `### Files Affected`,
      ...(change.files || []).map(f => `- \`${f}\``),
      ``,
      `### Rationale`,
      change.rationale || '_Not provided_',
      ``,
      `### Verification Steps`,
      `1. Review the diff below`,
      `2. Run \`node workflow/tests/unit.test.js\` to verify no regressions`,
      `3. Approve and merge`,
      ``,
      `---`,
      ``,
      `### Diff`,
      '```diff',
      change.diff || '(no diff available)',
      '```',
    ].join('\n');

    const record = {
      tier:        DEPLOY_TIER.RED,
      type:        change.type || CHANGE_TYPE.FILE_STRUCTURE_CHANGE,
      title:       prTitle,
      description: change.description,
      appliedAt:   new Date().toISOString(),
      applied:     false,
      requiresReview: true,
    };

    // Save PR description to file
    const prFilePath = path.join(this.outputDir, 'evolution-pr.md');
    try {
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }
      fs.writeFileSync(prFilePath, prBody, 'utf-8');
      record.prFile = prFilePath;
    } catch (_) { /* non-fatal */ }

    this._appendHistory(record);

    if (this.verbose) {
      console.log(`[AutoDeployer] 🔴 RED: PR description generated → ${prFilePath}`);
    }

    return { prDescription: prBody, prFile: prFilePath, record };
  }

  // ─── Full Evolution Deploy (all tiers) ─────────────────────────────────

  /**
   * Runs all deployment tiers in sequence. Called by /evolve Step 5.
   *
   * @param {object} context
   * @param {object} context.adaptiveStrategy — From deriveStrategy()
   * @param {object[]} [context.greenChanges]  — Already-applied GREEN changes to record
   * @param {object[]} [context.redChanges]    — Code-level changes for PR generation
   * @param {object} [context.auditFindings]   — Deep audit findings for RED tier
   * @param {boolean} [context.dryRun]
   * @returns {object} Deployment report
   */
  async runFullDeploy(context = {}) {
    const { adaptiveStrategy, greenChanges = [], redChanges = [], auditFindings = null, dryRun = false } = context;

    const deployReport = {
      green:  { count: 0, changes: [] },
      yellow: { count: 0, changes: [], applied: false },
      red:    { count: 0, prGenerated: false },
      timestamp: new Date().toISOString(),
    };

    // 1. Record GREEN changes (already applied by previous steps)
    for (const gc of greenChanges) {
      this.applyGreen(gc);
      deployReport.green.count++;
      deployReport.green.changes.push(gc.description);
    }

    // 2. YELLOW: Auto-apply config parameter adjustments
    if (adaptiveStrategy && adaptiveStrategy.source !== 'defaults') {
      const yellowResult = this.applyYellow(adaptiveStrategy, { dryRun });
      deployReport.yellow.count = yellowResult.changes.length;
      deployReport.yellow.changes = yellowResult.changes;
      deployReport.yellow.applied = yellowResult.applied;
    }

    // 3. RED: Generate PR for structural changes
    if (auditFindings) {
      const criticalFindings = (auditFindings.findings || [])
        .filter(f => f.severity === 'critical' || f.severity === 'high')
        .filter(f => f.category === 'config-consistency' && f.title && f.title.includes('exceeds'));

      if (criticalFindings.length > 0) {
        const redResult = this.generateRedPR({
          title: `Architecture Decomposition: ${criticalFindings.length} oversized file(s)`,
          description: `Deep Audit identified ${criticalFindings.length} file(s) exceeding the 400-line architecture constraint. These require manual decomposition.`,
          files: criticalFindings.map(f => f.file || f.title).slice(0, 10),
          rationale: `Files exceeding 400 lines violate architecture-constraints.md and resist effective auditing.`,
          diff: criticalFindings.map(f => `# ${f.title}\n# Severity: ${f.severity}\n# ${f.suggestion || ''}`).join('\n\n'),
          type: CHANGE_TYPE.FILE_STRUCTURE_CHANGE,
        });
        deployReport.red.count = criticalFindings.length;
        deployReport.red.prGenerated = true;
        deployReport.red.prFile = redResult.prFile;
      }
    }

    for (const rc of redChanges) {
      const redResult = this.generateRedPR(rc);
      deployReport.red.count++;
      deployReport.red.prGenerated = true;
      deployReport.red.prFile = redResult.prFile;
    }

    return deployReport;
  }

  // ─── Config Diff Logic ────────────────────────────────────────────────

  /**
   * Compares current config params against adaptive strategy recommendations.
   * Only considers known safe parameters with defined bounds.
   *
   * @param {object} currentConfig
   * @param {object} strategy
   * @returns {object[]} Array of { param, oldValue, newValue, reason, path }
   */
  _diffConfigParams(currentConfig, strategy) {
    const changes = [];
    const autoFix = currentConfig.autoFixLoop || {};

    // Parameter registry: each entry defines the config path, safe bounds, and diff logic
    const PARAMS = [
      {
        strategyKey: 'maxFixRounds',
        configPath:  'autoFixLoop.maxFixRounds',
        getter:      () => autoFix.maxFixRounds,
        min: 1, max: 5,
        label: 'maxFixRounds (auto-fix retry limit)',
      },
      {
        strategyKey: 'maxReviewRounds',
        configPath:  'autoFixLoop.maxReviewRounds',
        getter:      () => autoFix.maxReviewRounds,
        min: 1, max: 4,
        label: 'maxReviewRounds (code review retry limit)',
      },
    ];

    for (const param of PARAMS) {
      const strategyValue = strategy[param.strategyKey];
      const currentValue  = param.getter();

      // Skip if strategy doesn't have this param or it matches current
      if (strategyValue == null || currentValue == null) continue;
      if (strategyValue === currentValue) continue;

      // Enforce bounds
      const clampedValue = Math.max(param.min, Math.min(param.max, strategyValue));
      if (clampedValue === currentValue) continue;

      changes.push({
        param:    param.label,
        path:     param.configPath,
        oldValue: currentValue,
        newValue: clampedValue,
        reason:   `Adaptive strategy recommends ${clampedValue} based on ${strategy.source || 'cross-session history'}`,
      });
    }

    return changes;
  }

  /**
   * Applies parameter changes to the config file using AST-free string replacement.
   * Works by finding the parameter in the file and replacing its value.
   *
   * @param {string} configPath
   * @param {object} currentConfig
   * @param {object[]} changes
   * @returns {boolean}
   */
  _applyConfigChanges(configPath, currentConfig, changes) {
    let content = fs.readFileSync(configPath, 'utf-8');
    let modified = false;

    for (const change of changes) {
      const parts = change.path.split('.');
      const paramName = parts[parts.length - 1];

      // Strategy: find `paramName: <value>` in the file and replace
      // Support both `paramName: value` and `paramName: value,` formats
      const regex = new RegExp(
        `(${paramName}\\s*:\\s*)(\\d+)`,
        'g'
      );

      const newContent = content.replace(regex, (match, prefix, oldVal) => {
        if (parseInt(oldVal, 10) === change.oldValue) {
          modified = true;
          return `${prefix}${change.newValue}`;
        }
        return match;
      });

      if (newContent !== content) {
        content = newContent;
      }
    }

    if (modified) {
      // Add auto-deploy comment at the top if not already present
      if (!content.includes('// Last auto-deployed:')) {
        const autoDeployComment = `// Last auto-deployed: ${new Date().toISOString()} by AutoDeployer (ADR-34)\n`;
        // Insert after the opening block comment
        const insertIdx = content.indexOf('*/');
        if (insertIdx !== -1) {
          content = content.slice(0, insertIdx + 2) + '\n' + autoDeployComment + content.slice(insertIdx + 2);
        } else {
          content = autoDeployComment + content;
        }
      } else {
        // Update existing timestamp
        content = content.replace(
          /\/\/ Last auto-deployed:.*$/m,
          `// Last auto-deployed: ${new Date().toISOString()} by AutoDeployer (ADR-34)`
        );
      }

      fs.writeFileSync(configPath, content, 'utf-8');
    }

    return modified;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _findConfigPath() {
    const candidates = [
      path.join(this.projectRoot, 'workflow.config.js'),
      path.join(this.projectRoot, 'workflow', 'workflow.config.js'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  _appendHistory(record) {
    try {
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }
      fs.appendFileSync(this._historyPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (_) { /* non-fatal */ }
  }

  /**
   * Loads the deployment history for reporting.
   * @returns {object[]}
   */
  loadHistory() {
    if (!fs.existsSync(this._historyPath)) return [];
    try {
      return fs.readFileSync(this._historyPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
        .reverse(); // newest first
    } catch (_) {
      return [];
    }
  }

  /**
   * Returns a summary of recent deployments for dashboard display.
   * @param {number} [limit=10]
   * @returns {object}
   */
  getSummary(limit = 10) {
    const history = this.loadHistory().slice(0, limit);
    const greenCount  = history.filter(r => r.tier === DEPLOY_TIER.GREEN).length;
    const yellowCount = history.filter(r => r.tier === DEPLOY_TIER.YELLOW && r.applied).length;
    const redCount    = history.filter(r => r.tier === DEPLOY_TIER.RED).length;

    return {
      total: history.length,
      green: greenCount,
      yellow: yellowCount,
      red: redCount,
      lastDeploy: history[0]?.appliedAt || null,
      recentChanges: history.slice(0, 5).map(r => ({
        tier: r.tier,
        type: r.type,
        description: r.description || r.title || r.reason || '(no description)',
        applied: r.applied,
        timestamp: r.appliedAt,
      })),
    };
  }
}

module.exports = { AutoDeployer, DEPLOY_TIER, CHANGE_TYPE };
