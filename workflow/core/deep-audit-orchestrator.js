/**
 * Deep Audit Orchestrator (ADR-31)
 *
 * Unified deep-inspection layer that orchestrates ALL existing audit components
 * into a single, comprehensive module-level health assessment.
 *
 * Existing audit components run independently as "islands":
 *   - SelfReflectionEngine  – runtime metrics audit (9 checks)
 *   - EntropyGC             – static scan (6 checks)
 *   - CodeGraph             – dependency / coupling analysis
 *   - QualityGate           – per-stage pass/fail decisions
 *   - ArchitectureReviewAgent – architecture compliance
 *
 * This orchestrator adds:
 *   1. Cross-module logic consistency checks
 *   2. Configuration consistency checks (hardcoded values across files)
 *   3. Module-level functional completeness (skill fill-rate, experience coverage)
 *   4. Dependency coupling analysis (CodeGraph → module health)
 *   5. Unified report generation with prioritised findings
 *   6. Auto-injection of findings into ExperienceStore
 *
 * Trigger:
 *   - `/deep-audit` command (manual, on-demand)
 *   - `_finalizeWorkflow()` integration (automatic, fire-and-forget)
 *
 * Output:
 *   - output/deep-audit-report.json  (machine-readable)
 *   - output/deep-audit-report.md    (human-readable)
 *   - Findings → ExperienceStore (auto-recorded)
 *
 * Design: zero new dependencies. Calls into existing modules' public APIs.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Finding Severity ───────────────────────────────────────────────────────

const AuditSeverity = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
  INFO:     'info',
};

// ─── Finding Categories ─────────────────────────────────────────────────────

const AuditCategory = {
  LOGIC:       'logic-consistency',
  CONFIG:      'config-consistency',
  FUNCTION:    'functional-completeness',
  COUPLING:    'module-coupling',
  ARCHITECTURE:'architecture-compliance',
  PERFORMANCE: 'performance-efficiency',
  KNOWLEDGE:   'knowledge-quality',
};

// ─── Expert Review Panel (P1 fix: fixed panel for self-evolution audits) ────

/**
 * Fixed expert panel for self-evolution deep audits.
 * Each expert is assigned specific audit dimensions that match their expertise.
 * This panel is automatically included in every deep audit run.
 *
 * When the audit generates its LLM-powered review prompts, each expert's
 * identity and perspective are injected into the system prompt to produce
 * domain-specific, high-quality feedback.
 */
const EXPERT_PANEL = [
  {
    name: 'Andrej Karpathy',
    title: 'Former OpenAI Research Scientist & Tesla AI Director',
    role: 'chair',
    expertise: 'Agent architecture, system design, LLM integration',
    dimensions: ['logic-consistency', 'knowledge-quality'],
    promptPersona: 'You are Andrej Karpathy, renowned for deep systems thinking and Agent architecture design. Evaluate this module from the perspective of AI agent collaboration, boundary enforcement, and knowledge flow efficiency.',
  },
  {
    name: 'Martin Fowler',
    title: 'ThoughtWorks Chief Scientist',
    role: 'reviewer',
    expertise: 'Software architecture patterns, maintainability, refactoring',
    dimensions: ['architecture-compliance', 'module-coupling'],
    promptPersona: 'You are Martin Fowler, expert in software architecture patterns and code maintainability. Evaluate this module for SOLID violations, excessive coupling, God Objects, and adherence to the project\'s own architecture constraints.',
  },
  {
    name: 'Kelsey Hightower',
    title: 'Former Google Principal Engineer',
    role: 'reviewer',
    expertise: 'Engineering practices, operations, portability, developer experience',
    dimensions: ['config-consistency', 'performance-efficiency'],
    promptPersona: 'You are Kelsey Hightower, known for pragmatic engineering and zero-config philosophy. Evaluate this module for operational readiness, configuration hygiene, error handling robustness, and developer experience friction.',
  },
  {
    name: 'Sanjay Ghemawat',
    title: 'Google Fellow, MapReduce/Bigtable co-author',
    role: 'reviewer',
    expertise: 'State management, reliability, concurrency, data integrity',
    dimensions: ['logic-consistency', 'functional-completeness'],
    promptPersona: 'You are Sanjay Ghemawat, expert in distributed systems and data integrity. Evaluate this module for state management correctness, concurrency safety, checkpoint/recovery robustness, and data migration concerns.',
  },
  {
    name: 'Lea Verou',
    title: 'MIT HCI Researcher & Web Standards Expert',
    role: 'reviewer',
    expertise: 'Developer experience, API design, documentation quality',
    dimensions: ['knowledge-quality', 'functional-completeness'],
    promptPersona: 'You are Lea Verou, expert in developer experience and API usability. Evaluate this module for API clarity, error message quality, documentation completeness, and TypeScript integration friendliness.',
  },
];

// ─── Deep Audit Orchestrator ────────────────────────────────────────────────

class DeepAuditOrchestrator {
  /**
   * @param {object} opts
   * @param {object}   opts.orchestrator    - Orchestrator instance (provides services + context)
   * @param {string}   [opts.outputDir]     - Directory for audit reports
   * @param {boolean}  [opts.verbose=false] - Enable verbose logging
   */
  constructor({ orchestrator, outputDir, verbose = false } = {}) {
    this._orch = orchestrator;
    this._outputDir = outputDir || (orchestrator && orchestrator._outputDir)
      || path.join(__dirname, '..', 'output');
    this._verbose = verbose;
    this._findings = [];
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Run the full deep audit. Orchestrates all audit dimensions in parallel
   * where possible, then generates a unified report.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.dimensions] - Subset of dimensions to run (default: all)
   * @param {boolean}  [opts.autoInjectExperience=true] - Auto-record findings in ExperienceStore
   * @returns {Promise<DeepAuditResult>}
   */
  async run(opts = {}) {
    const {
      dimensions = Object.values(AuditCategory),
      autoInjectExperience = true,
    } = opts;
    const startTime = Date.now();
    this._findings = [];

    console.log(`\n[DeepAudit] 🔍 Starting deep audit across ${dimensions.length} dimension(s)...`);

    // ── Phase 1: Run independent checks in parallel ─────────────────────
    const checks = [];

    if (dimensions.includes(AuditCategory.LOGIC)) {
      checks.push(this._checkLogicConsistency());
    }
    if (dimensions.includes(AuditCategory.CONFIG)) {
      checks.push(this._checkConfigConsistency());
    }
    if (dimensions.includes(AuditCategory.FUNCTION)) {
      checks.push(this._checkFunctionalCompleteness());
    }
    if (dimensions.includes(AuditCategory.COUPLING)) {
      checks.push(this._checkModuleCoupling());
    }
    if (dimensions.includes(AuditCategory.ARCHITECTURE)) {
      checks.push(this._checkArchitectureCompliance());
    }
    if (dimensions.includes(AuditCategory.PERFORMANCE)) {
      checks.push(this._checkPerformanceEfficiency());
    }
    if (dimensions.includes(AuditCategory.KNOWLEDGE)) {
      checks.push(this._checkKnowledgeQuality());
    }

    await Promise.allSettled(checks);

    // ── Phase 2: Correlate and de-duplicate findings ────────────────────
    this._deduplicateFindings();

    // ── Phase 3: Prioritise ─────────────────────────────────────────────
    this._findings.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5);
    });

    // ── Phase 4: Generate reports ───────────────────────────────────────
    const report = this._generateReport(startTime);
    this._writeReports(report);

    // ── Phase 5: Auto-inject high-value findings into ExperienceStore ───
    if (autoInjectExperience) {
      this._injectIntoExperienceStore();
    }

    // ── Phase 6: Expert Panel Review ────────────────────────────────────
    // Enrich findings with expert-specific perspectives. Each expert reviews
    // findings in their assigned dimensions and adds commentary/priorities.
    this._enrichWithExpertPerspectives();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stats = this._computeStats();
    console.log(`[DeepAudit] ✅ Deep audit complete in ${elapsed}s: ${this._findings.length} finding(s)`);
    console.log(`[DeepAudit]    Critical: ${stats.critical} | High: ${stats.high} | Medium: ${stats.medium} | Low: ${stats.low} | Info: ${stats.info}`);

    return {
      findings: this._findings,
      stats,
      reportPath: path.join(this._outputDir, 'deep-audit-report.md'),
      elapsedMs: Date.now() - startTime,
    };
  }

  // ─── Dimension 1: Cross-Module Logic Consistency ──────────────────────

  async _checkLogicConsistency() {
    const label = AuditCategory.LOGIC;
    this._log(label, 'Checking cross-module logic consistency...');

    try {
      // 1a. Check: maxRollbacks consistency across files
      const rollbackValues = this._findHardcodedValues('maxRollbacks', /maxRollbacks\s*[:=]\s*(\d+)/g);
      if (rollbackValues.uniqueValues.size > 1) {
        this._addFinding({
          severity: AuditSeverity.MEDIUM,
          category: label,
          title: 'Inconsistent maxRollbacks values across modules',
          description: `maxRollbacks is hardcoded with different values: ${[...rollbackValues.uniqueValues].join(', ')}. Found in: ${rollbackValues.locations.map(l => l.file).join(', ')}`,
          suggestion: 'Extract maxRollbacks into constants.js or config-loader.js as a single source of truth.',
          locations: rollbackValues.locations,
        });
      }

      // 1b. Check: Token budget consistency
      const tokenBudgets = this._findHardcodedValues('STAGE_TOKEN_BUDGET', /STAGE_TOKEN_BUDGET[_A-Z]*\s*[:=]\s*(\d+)/g);
      if (tokenBudgets.uniqueValues.size > 1) {
        this._addFinding({
          severity: AuditSeverity.LOW,
          category: label,
          title: 'Multiple STAGE_TOKEN_BUDGET variants with different values',
          description: `Found ${tokenBudgets.uniqueValues.size} different token budget values: ${[...tokenBudgets.uniqueValues].join(', ')}`,
          suggestion: 'Verify all token budget variants are intentional (per-stage budgets are expected).',
          locations: tokenBudgets.locations,
        });
      }

      // 1c. Check: Duplicate error handling patterns (catch + console.warn but no re-throw)
      const silentCatches = this._countPattern(/catch\s*\([^)]*\)\s*\{\s*\/\*[^}]*\*\/\s*\}/g);
      if (silentCatches.total > 20) {
        this._addFinding({
          severity: AuditSeverity.LOW,
          category: label,
          title: `${silentCatches.total} completely silent catch blocks`,
          description: 'Silent catch blocks (empty or comment-only) may hide important errors. While fire-and-forget patterns are intentional, excessive use can mask bugs.',
          suggestion: 'Audit silent catch blocks. Ensure at minimum a console.warn for non-trivial operations.',
          locations: silentCatches.topFiles.map(f => ({ file: f.file, count: f.count })),
        });
      }

      // 1d. Check: require() circular dependency risk
      this._checkCircularRequires();

    } catch (err) {
      this._log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 2: Configuration Consistency ───────────────────────────

  async _checkConfigConsistency() {
    const label = AuditCategory.CONFIG;
    this._log(label, 'Checking configuration consistency...');

    try {
      const { PATHS } = require('./constants');

      // 2a. Check: All PATHS entries point to existing parent directories
      for (const [key, filePath] of Object.entries(PATHS)) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir) && !dir.includes('output')) {
          this._addFinding({
            severity: AuditSeverity.MEDIUM,
            category: label,
            title: `PATHS.${key} parent directory does not exist`,
            description: `PATHS.${key} = "${filePath}" but parent directory "${dir}" does not exist.`,
            suggestion: 'Create the directory or update the PATHS constant.',
          });
        }
      }

      // 2b. Check: architecture-constraints.md file size limits vs actual
      const constraintsPath = path.join(__dirname, '..', 'docs', 'architecture-constraints.md');
      if (fs.existsSync(constraintsPath)) {
        const constraints = fs.readFileSync(constraintsPath, 'utf-8');
        const limitMatches = constraints.matchAll(/\|\s*`([^`]+)`[^|]*\|\s*(\d+)\s*lines/g);
        for (const match of limitMatches) {
          const pattern = match[1];
          const maxLines = parseInt(match[2], 10);
          const files = this._findMatchingFiles(pattern);
          for (const filePath of files) {
            const lineCount = this._countFileLines(filePath);
            if (lineCount > maxLines) {
              this._addFinding({
                severity: lineCount > maxLines * 1.5 ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
                category: label,
                title: `File exceeds architecture constraint: ${path.basename(filePath)}`,
                description: `${path.basename(filePath)} has ${lineCount} lines (limit: ${maxLines}). This violates the architecture-constraints.md rule for "${pattern}".`,
                suggestion: `Split into smaller modules. Extract helpers or sub-components. ${lineCount > maxLines * 2 ? 'URGENT: file is 2× over limit.' : ''}`,
                locations: [{ file: path.relative(path.join(__dirname, '..'), filePath), lines: lineCount, limit: maxLines }],
              });
            }
          }
        }
      }

      // 2c. Check: Module boundary violations (core/ importing from agents/)
      this._checkModuleBoundaryViolations();

    } catch (err) {
      this._log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 3: Functional Completeness ─────────────────────────────

  async _checkFunctionalCompleteness() {
    const label = AuditCategory.FUNCTION;
    this._log(label, 'Checking functional completeness...');

    try {
      // 3a. Skill fill-rate analysis
      const skillsDir = path.join(__dirname, '..', 'skills');
      if (fs.existsSync(skillsDir)) {
        const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
        let hollow = 0;
        const hollowNames = [];
        for (const f of skillFiles) {
          const content = fs.readFileSync(path.join(skillsDir, f), 'utf-8');
          const expectedSections = ['Rules', 'Anti-Patterns', 'Gotchas', 'Best Practices', 'Context Hints'];
          let filled = 0;
          for (const sec of expectedSections) {
            const secRegex = new RegExp(`^##\\s+.*${sec.replace(/-/g, '[- ]')}`, 'im');
            const secMatch = content.match(secRegex);
            if (secMatch) {
              const secIdx = content.indexOf(secMatch[0]);
              const afterHeader = content.slice(secIdx + secMatch[0].length, secIdx + secMatch[0].length + 300);
              const sectionContent = afterHeader.split(/^##\s/m)[0].trim();
              const words = sectionContent.split(/\s+/).filter(w => w.length > 1 && !w.startsWith('_No')).length;
              if (words >= 10) filled++;
            }
          }
          if (filled / expectedSections.length < 0.4) {
            hollow++;
            hollowNames.push(f.replace('.md', ''));
          }
        }
        if (hollow > 0) {
          this._addFinding({
            severity: hollow > skillFiles.length * 0.3 ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
            category: label,
            title: `${hollow}/${skillFiles.length} skills have thin content (< 40% section fill-rate)`,
            description: `Hollow skills: [${hollowNames.slice(0, 8).join(', ')}${hollowNames.length > 8 ? `, +${hollowNames.length - 8} more` : ''}]. Run \`/skill-enrich\` to auto-populate from external knowledge.`,
            suggestion: 'Run `/skill-enrich <name>` for each hollow skill, or batch enrich all.',
          });
        }
      }

      // 3b. Experience store coverage
      if (this._orch && this._orch.experienceStore) {
        const stats = this._orch.experienceStore.getStats();
        if (stats.total < 5) {
          this._addFinding({
            severity: AuditSeverity.MEDIUM,
            category: label,
            title: 'Experience store has very few entries',
            description: `Only ${stats.total} experience(s) recorded. The system learns from accumulated experiences — fewer entries mean less guidance for future runs.`,
            suggestion: 'Run more workflow sessions to accumulate experiences, or use cold-start preheating (`preheatExperienceStore`).',
          });
        }
        // Check for expired experiences
        if (stats.expired > stats.total * 0.3 && stats.expired > 3) {
          this._addFinding({
            severity: AuditSeverity.LOW,
            category: label,
            title: `${stats.expired} expired experience(s) in store`,
            description: `${stats.expired} of ${stats.total} experiences have expired. Expired experiences are not injected into prompts.`,
            suggestion: 'Run `experienceStore.purgeExpired()` to clean up, or review if TTL values are too short.',
          });
        }
      }

      // 3c. Complaint wall coverage
      if (this._orch && this._orch._complaintWall) {
        try {
          const complaints = this._orch._complaintWall.getAll();
          const unresolved = complaints.filter(c => c.status === 'open' || c.status === 'acknowledged');
          if (unresolved.length > 5) {
            this._addFinding({
              severity: unresolved.length > 10 ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
              category: label,
              title: `${unresolved.length} unresolved complaints in ComplaintWall`,
              description: `There are ${unresolved.length} open/acknowledged complaints that haven't been addressed.`,
              suggestion: 'Review unresolved complaints with `/complaints`. High-severity complaints should be prioritised.',
            });
          }
        } catch (_) { /* non-fatal */ }
      }

    } catch (err) {
      this._log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 4: Module Coupling Analysis ────────────────────────────

  async _checkModuleCoupling() {
    const label = AuditCategory.COUPLING;
    this._log(label, 'Checking module coupling...');

    try {
      if (!this._orch || !this._orch.codeGraph) {
        this._log(label, 'CodeGraph not available, skipping coupling analysis.');
        return;
      }

      const cg = this._orch.codeGraph;
      // Ensure graph is loaded
      if (cg._symbols && cg._symbols.size === 0) {
        cg._loadFromDisk();
      }
      if (!cg._symbols || cg._symbols.size === 0) {
        this._log(label, 'Code graph has no symbols. Run a build first.');
        return;
      }

      // 4a. Hub analysis — symbols with both high fan-in AND fan-out are risk
      const hotspots = cg.getHotspots({ topN: 30, includeOrphans: false });
      const hubs = hotspots.filter(h => h.category === 'hub');
      if (hubs.length > 5) {
        this._addFinding({
          severity: AuditSeverity.MEDIUM,
          category: label,
          title: `${hubs.length} hub symbols detected (high coupling risk)`,
          description: `Hubs have both high fan-in and fan-out: ${hubs.slice(0, 5).map(h => `${h.symbol.name} (${h.calledByCount}↓ ${h.callsOutCount}↑)`).join(', ')}. These are architecture bottlenecks.`,
          suggestion: 'Consider splitting hub symbols into smaller focused functions to reduce coupling.',
          locations: hubs.slice(0, 5).map(h => ({ file: h.symbol.file, symbol: h.symbol.name })),
        });
      }

      // 4b. Orphan detection — symbols with 0 connections may be dead code
      const orphans = hotspots.filter(h => h.category === 'orphan');
      // Only flag orphans from our own code (not test files)
      const realOrphans = orphans.filter(h =>
        !h.symbol.file.includes('test') && !h.symbol.file.includes('spec')
      );
      if (realOrphans.length > 10) {
        this._addFinding({
          severity: AuditSeverity.LOW,
          category: label,
          title: `${realOrphans.length} orphan symbols (potential dead code)`,
          description: `Symbols with 0 incoming refs AND 0 outgoing calls: ${realOrphans.slice(0, 5).map(h => h.symbol.name).join(', ')}...`,
          suggestion: 'Review orphan symbols. Remove truly unused code to reduce entropy.',
        });
      }

      // 4c. File-level coupling — files with too many imports
      const importCounts = new Map();
      if (cg._importEdges) {
        for (const [file, imports] of cg._importEdges) {
          importCounts.set(file, (imports || []).length);
        }
      }
      const highImportFiles = [...importCounts.entries()]
        .filter(([, count]) => count > 10)
        .sort((a, b) => b[1] - a[1]);
      if (highImportFiles.length > 0) {
        this._addFinding({
          severity: AuditSeverity.MEDIUM,
          category: label,
          title: `${highImportFiles.length} file(s) with high import count (>10)`,
          description: `Files with many imports: ${highImportFiles.slice(0, 3).map(([f, c]) => `${f} (${c} imports)`).join(', ')}. High import count suggests the file has too many responsibilities.`,
          suggestion: 'Consider splitting these files or introducing a facade/helper module.',
          locations: highImportFiles.slice(0, 5).map(([file, count]) => ({ file, imports: count })),
        });
      }

    } catch (err) {
      this._log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 5: Architecture Compliance ─────────────────────────────

  async _checkArchitectureCompliance() {
    const label = AuditCategory.ARCHITECTURE;
    this._log(label, 'Checking architecture compliance...');

    try {
      // 5a. Dual-path unification — check that _initWorkflow/_finalizeWorkflow exist
      const indexPath = path.join(__dirname, '..', 'index.js');
      if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        const hasRun = /async\s+run\s*\(/.test(indexContent);
        const hasRunTaskBased = /async\s+runTaskBased\s*\(/.test(indexContent) ||
                                /async\s+runAuto\s*\(/.test(indexContent);
        if (hasRun && hasRunTaskBased) {
          // Check shared methods exist
          const sharedMethods = ['_initWorkflow', '_finalizeWorkflow'];
          for (const method of sharedMethods) {
            if (!indexContent.includes(method)) {
              this._addFinding({
                severity: AuditSeverity.HIGH,
                category: label,
                title: `Missing shared method: ${method}`,
                description: `Both run() and runTaskBased() paths should use ${method}() for unification, but it was not found in index.js.`,
                suggestion: `Implement ${method}() as required by architecture-constraints.md "Dual-Path Unification Rule".`,
              });
            }
          }
        }
      }

      // 5b. Check output directory existence
      if (!fs.existsSync(this._outputDir)) {
        this._addFinding({
          severity: AuditSeverity.LOW,
          category: label,
          title: 'Output directory does not exist',
          description: `The output directory "${this._outputDir}" does not exist. It should be created during initialization.`,
          suggestion: 'Ensure _initWorkflow() creates the output directory.',
        });
      }

      // 5c. Check naming conventions (Agents = XxxAgent, Services = XxxManager/Engine/Store)
      const agentsDir = path.join(__dirname, '..', 'agents');
      if (fs.existsSync(agentsDir)) {
        const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.js'));
        for (const f of agentFiles) {
          const content = fs.readFileSync(path.join(agentsDir, f), 'utf-8');
          const classMatch = content.match(/class\s+(\w+)/);
          if (classMatch && !classMatch[1].endsWith('Agent') && !f.includes('base') && !f.includes('helper')) {
            this._addFinding({
              severity: AuditSeverity.LOW,
              category: label,
              title: `Agent class naming violation: ${classMatch[1]} in ${f}`,
              description: `Class "${classMatch[1]}" in agents/ should follow the XxxAgent naming convention.`,
              suggestion: `Rename to ${classMatch[1]}Agent or move to core/ if it's a service.`,
            });
          }
        }
      }

    } catch (err) {
      this._log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 6: Performance / Efficiency ────────────────────────────

  async _checkPerformanceEfficiency() {
    const label = AuditCategory.PERFORMANCE;
    this._log(label, 'Checking performance efficiency...');

    try {
      // 6a. Leverage SelfReflection's existing health audit
      if (this._orch && this._orch._selfReflection) {
        const auditResult = this._orch._selfReflection.auditHealth();
        if (auditResult.findings && auditResult.findings.length > 0) {
          for (const f of auditResult.findings) {
            this._addFinding({
              severity: f.severity || AuditSeverity.MEDIUM,
              category: label,
              title: `[SelfReflection] ${f.title}`,
              description: f.description,
              suggestion: f.suggestedFix || 'See self-reflection engine for details.',
              source: 'self-reflection-engine',
            });
          }
        }
      }

      // 6b. Leverage EntropyGC's existing scan (if recent report exists)
      const entropyReportPath = path.join(this._outputDir, 'entropy-report.json');
      if (fs.existsSync(entropyReportPath)) {
        try {
          const entropyReport = JSON.parse(fs.readFileSync(entropyReportPath, 'utf-8'));
          const highViolations = (entropyReport.violations || []).filter(v => v.severity === 'high');
          if (highViolations.length > 0) {
            this._addFinding({
              severity: AuditSeverity.HIGH,
              category: label,
              title: `${highViolations.length} high-severity entropy violation(s) from last scan`,
              description: `EntropyGC found: ${highViolations.slice(0, 3).map(v => `${v.type}: ${v.detail}`).join('; ')}`,
              suggestion: 'Run `/gc` and fix high-severity violations.',
              source: 'entropy-gc',
            });
          }
        } catch (_) { /* malformed report */ }
      }

      // 6c. Check for large files that impact load time
      const coreDir = path.join(__dirname);
      const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
      for (const f of coreFiles) {
        const size = fs.statSync(path.join(coreDir, f)).size;
        if (size > 50000) { // > 50KB
          this._addFinding({
            severity: size > 80000 ? AuditSeverity.MEDIUM : AuditSeverity.LOW,
            category: label,
            title: `Large core module: ${f} (${(size / 1024).toFixed(0)}KB)`,
            description: `${f} is ${(size / 1024).toFixed(0)}KB. Large modules increase memory footprint and make maintenance harder.`,
            suggestion: 'Consider extracting helper functions into separate modules.',
            locations: [{ file: `core/${f}`, sizeKB: Math.round(size / 1024) }],
          });
        }
      }

    } catch (err) {
      this._log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 7: Knowledge Quality ───────────────────────────────────

  async _checkKnowledgeQuality() {
    const label = AuditCategory.KNOWLEDGE;
    this._log(label, 'Checking knowledge quality...');

    try {
      // 7a. Skill version consistency — all skills should have version in frontmatter
      const skillsDir = path.join(__dirname, '..', 'skills');
      if (fs.existsSync(skillsDir)) {
        const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
        let noVersion = 0;
        for (const f of skillFiles) {
          const content = fs.readFileSync(path.join(skillsDir, f), 'utf-8');
          if (!content.match(/version:\s*[\d.]+/)) {
            noVersion++;
          }
        }
        if (noVersion > 0) {
          this._addFinding({
            severity: AuditSeverity.LOW,
            category: label,
            title: `${noVersion} skill file(s) missing version in frontmatter`,
            description: 'Skills without version tracking cannot be audited for staleness.',
            suggestion: 'Add `version: 1.0.0` to skill frontmatter.',
          });
        }
      }

      // 7b. Check for stale analyse-search-knowledge.json entries
      const searchKnowledgePath = path.join(this._outputDir, 'analyse-search-knowledge.json');
      if (fs.existsSync(searchKnowledgePath)) {
        try {
          const entries = JSON.parse(fs.readFileSync(searchKnowledgePath, 'utf-8'));
          const staleThresholdMs = 90 * 24 * 60 * 60 * 1000; // 90 days
          const staleEntries = entries.filter(e =>
            e.timestamp && (Date.now() - new Date(e.timestamp).getTime()) > staleThresholdMs
          );
          if (staleEntries.length > entries.length * 0.5 && staleEntries.length > 3) {
            this._addFinding({
              severity: AuditSeverity.LOW,
              category: label,
              title: `${staleEntries.length}/${entries.length} search knowledge entries are >90 days old`,
              description: 'Stale search knowledge may contain outdated technology references.',
              suggestion: 'Consider re-running ANALYSE with fresh searches to update the knowledge base.',
            });
          }
        } catch (_) { /* malformed file */ }
      }

      // 7c. Experience-to-Skill feedback loop health
      if (this._orch && this._orch.experienceStore) {
        const exps = this._orch.experienceStore.experiences || [];
        const negativeExps = exps.filter(e => e.type === 'negative' && !e.expiresAt);
        const evolvedCount = exps.filter(e => e.evolutionCount > 0).length;
        if (negativeExps.length > 5 && evolvedCount === 0) {
          this._addFinding({
            severity: AuditSeverity.MEDIUM,
            category: label,
            title: 'Negative experiences accumulating but no skill evolution triggered',
            description: `${negativeExps.length} negative experiences have been recorded but 0 have triggered skill evolution. The experience→skill feedback loop may be broken.`,
            suggestion: 'Check ExperienceEvolution hitCount thresholds and triggerEvolutions() invocation.',
          });
        }
      }

    } catch (err) {
      this._log(label, `Error: ${err.message}`);
    }
  }

  // ─── Helper: Find Hardcoded Values ────────────────────────────────────

  _findHardcodedValues(name, regex) {
    const coreDir = path.join(__dirname);
    const locations = [];
    const uniqueValues = new Set();

    const jsFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
    for (const f of jsFiles) {
      const content = fs.readFileSync(path.join(coreDir, f), 'utf-8');
      let match;
      const localRegex = new RegExp(regex.source, regex.flags);
      while ((match = localRegex.exec(content)) !== null) {
        const value = match[1];
        uniqueValues.add(value);
        locations.push({ file: `core/${f}`, value, line: content.substring(0, match.index).split('\n').length });
      }
    }

    return { uniqueValues, locations };
  }

  // ─── Helper: Count Pattern ────────────────────────────────────────────

  _countPattern(regex) {
    const coreDir = path.join(__dirname);
    const jsFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
    let total = 0;
    const fileMap = new Map();

    for (const f of jsFiles) {
      const content = fs.readFileSync(path.join(coreDir, f), 'utf-8');
      const localRegex = new RegExp(regex.source, regex.flags);
      const matches = content.match(localRegex);
      if (matches) {
        total += matches.length;
        fileMap.set(f, matches.length);
      }
    }

    const topFiles = [...fileMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, count]) => ({ file: `core/${file}`, count }));

    return { total, topFiles };
  }

  // ─── Helper: Find Matching Files ──────────────────────────────────────

  _findMatchingFiles(pattern) {
    const workflowDir = path.join(__dirname, '..');
    const results = [];

    // Handle patterns like `core/*.js`, `index.js`, etc.
    if (pattern.includes('*')) {
      const [dir, glob] = pattern.split('/');
      const dirPath = path.join(workflowDir, dir);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        const ext = glob.replace('*', '');
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith(ext));
        for (const f of files) {
          results.push(path.join(dirPath, f));
        }
      }
    } else if (pattern.includes('/')) {
      // Direct path like `commands/command-router.js`
      const filePath = path.join(workflowDir, pattern);
      if (fs.existsSync(filePath)) results.push(filePath);
    } else {
      // Filename like `index.js`
      const filePath = path.join(workflowDir, pattern);
      if (fs.existsSync(filePath)) results.push(filePath);
    }

    return results;
  }

  // ─── Helper: Count File Lines ─────────────────────────────────────────

  _countFileLines(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n').length;
    } catch (_) {
      return 0;
    }
  }

  // ─── Helper: Check Circular Requires ──────────────────────────────────

  _checkCircularRequires() {
    const coreDir = path.join(__dirname);
    const jsFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
    const requireMap = new Map();

    for (const f of jsFiles) {
      const content = fs.readFileSync(path.join(coreDir, f), 'utf-8');
      const requires = [...content.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)]
        .map(m => m[1].replace(/\.js$/, '') + '.js');
      requireMap.set(f, requires);
    }

    // Simple cycle detection (depth 2)
    const cycles = [];
    for (const [fileA, reqsA] of requireMap) {
      for (const reqB of reqsA) {
        const reqsB = requireMap.get(reqB) || [];
        if (reqsB.includes(fileA)) {
          const pair = [fileA, reqB].sort().join('↔');
          if (!cycles.includes(pair)) cycles.push(pair);
        }
      }
    }

    if (cycles.length > 3) {
      this._addFinding({
        severity: AuditSeverity.MEDIUM,
        category: AuditCategory.LOGIC,
        title: `${cycles.length} circular require() dependency pairs detected`,
        description: `Circular dependencies: ${cycles.slice(0, 5).join(', ')}. These can cause partial module loading and subtle bugs.`,
        suggestion: 'Break cycles by extracting shared logic into a common module, or use lazy require() inside functions.',
      });
    }
  }

  // ─── Helper: Check Module Boundary Violations ─────────────────────────

  _checkModuleBoundaryViolations() {
    const coreDir = path.join(__dirname);
    const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));

    for (const f of coreFiles) {
      const content = fs.readFileSync(path.join(coreDir, f), 'utf-8');
      // core/ should not import from agents/
      const agentImports = content.match(/require\(['"]\.\.\/agents\//g);
      if (agentImports && agentImports.length > 0) {
        this._addFinding({
          severity: AuditSeverity.MEDIUM,
          category: AuditCategory.CONFIG,
          title: `Module boundary violation: core/${f} imports from agents/`,
          description: `core/${f} has ${agentImports.length} import(s) from agents/. Architecture constraints require: Types → Constants → Core → Agents (core should NOT import agents).`,
          suggestion: 'Move shared logic to core/ or invert the dependency.',
        });
      }
    }
  }

  // ─── Finding Management ───────────────────────────────────────────────

  _addFinding(finding) {
    this._findings.push({
      id: `DA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ...finding,
      timestamp: new Date().toISOString(),
    });
  }

  _deduplicateFindings() {
    const seen = new Set();
    this._findings = this._findings.filter(f => {
      const key = `${f.category}:${f.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _computeStats() {
    const stats = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
    for (const f of this._findings) {
      stats[f.severity] = (stats[f.severity] || 0) + 1;
      stats.total++;
    }
    return stats;
  }

  // ─── Report Generation ────────────────────────────────────────────────

  _generateReport(startTime) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stats = this._computeStats();
    const byCategory = {};
    for (const f of this._findings) {
      if (!byCategory[f.category]) byCategory[f.category] = [];
      byCategory[f.category].push(f);
    }

    const lines = [
      `# Deep Audit Report`,
      ``,
      `> Generated: ${new Date().toISOString()}`,
      `> Duration: ${elapsed}s`,
      `> Total findings: ${stats.total} (Critical: ${stats.critical} | High: ${stats.high} | Medium: ${stats.medium} | Low: ${stats.low} | Info: ${stats.info})`,
      ``,
      `---`,
      ``,
    ];

    if (stats.total === 0) {
      lines.push(`## ✅ No Issues Found`, ``, `All audit dimensions passed. The system is in good health.`);
    } else {
      // Top priority items
      const topPriority = this._findings.filter(f =>
        f.severity === AuditSeverity.CRITICAL || f.severity === AuditSeverity.HIGH
      );
      if (topPriority.length > 0) {
        lines.push(`## 🔴 Top Priority (${topPriority.length})`);
        lines.push(``);
        for (const f of topPriority) {
          lines.push(`### [${f.severity.toUpperCase()}] ${f.title}`);
          lines.push(`- **Category**: ${f.category}`);
          lines.push(`- **Description**: ${f.description}`);
          lines.push(`- **Suggestion**: ${f.suggestion}`);
          if (f.locations) {
            lines.push(`- **Locations**: ${JSON.stringify(f.locations).slice(0, 200)}`);
          }
          lines.push(``);
        }
      }

      // By category
      for (const [cat, findings] of Object.entries(byCategory)) {
        const catFindings = findings.filter(f =>
          f.severity !== AuditSeverity.CRITICAL && f.severity !== AuditSeverity.HIGH
        );
        if (catFindings.length === 0) continue;
        lines.push(`## ${this._categoryEmoji(cat)} ${cat} (${catFindings.length})`);
        lines.push(``);
        for (const f of catFindings) {
          lines.push(`- **[${f.severity}]** ${f.title}: ${f.description.slice(0, 150)}${f.description.length > 150 ? '...' : ''}`);
          if (f.suggestion) lines.push(`  > 💡 ${f.suggestion}`);
        }
        lines.push(``);
      }
    }

    return lines.join('\n');
  }

  _categoryEmoji(cat) {
    const map = {
      [AuditCategory.LOGIC]: '🔀',
      [AuditCategory.CONFIG]: '⚙️',
      [AuditCategory.FUNCTION]: '📋',
      [AuditCategory.COUPLING]: '🔗',
      [AuditCategory.ARCHITECTURE]: '🏗️',
      [AuditCategory.PERFORMANCE]: '⚡',
      [AuditCategory.KNOWLEDGE]: '📚',
    };
    return map[cat] || '📌';
  }

  _writeReports(markdownReport) {
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      // Markdown report
      const mdPath = path.join(this._outputDir, 'deep-audit-report.md');
      fs.writeFileSync(mdPath, markdownReport, 'utf-8');

      // JSON report (machine-readable)
      const jsonPath = path.join(this._outputDir, 'deep-audit-report.json');
      fs.writeFileSync(jsonPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        stats: this._computeStats(),
        findings: this._findings,
      }, null, 2), 'utf-8');

      console.log(`[DeepAudit] 📄 Reports written: ${mdPath}`);
    } catch (err) {
      console.warn(`[DeepAudit] ⚠️  Failed to write reports: ${err.message}`);
    }
  }

  // ─── Experience Store Injection ───────────────────────────────────────

  _injectIntoExperienceStore() {
    if (!this._orch || !this._orch.experienceStore) return;

    const highValue = this._findings.filter(f =>
      f.severity === AuditSeverity.CRITICAL ||
      f.severity === AuditSeverity.HIGH ||
      f.severity === AuditSeverity.MEDIUM
    );

    let injected = 0;
    for (const f of highValue.slice(0, 10)) { // Cap at 10 to avoid flooding
      try {
        this._orch.experienceStore.recordIfAbsent(`[DeepAudit] ${f.title}`, {
          type: 'negative',
          category: 'pitfall',
          title: `[DeepAudit] ${f.title}`,
          content: `[${f.severity}] ${f.description}\nSuggestion: ${f.suggestion || 'N/A'}\n> _Source: deep-audit (${f.category})_`,
          tags: ['deep-audit', f.category, f.severity],
        });
        injected++;
      } catch (_) { /* non-fatal */ }
    }

    if (injected > 0) {
      console.log(`[DeepAudit] 💉 ${injected} finding(s) injected into ExperienceStore.`);
    }
  }

  // ─── Expert Panel Integration ─────────────────────────────────────────

  /**
   * Enriches audit findings with expert panel perspectives.
   * Each finding is annotated with the expert(s) who would review it
   * based on their assigned dimensions, plus their review persona
   * for use in LLM-powered review prompts.
   */
  _enrichWithExpertPerspectives() {
    for (const finding of this._findings) {
      // Match experts whose dimensions cover this finding's category
      const matchedExperts = EXPERT_PANEL.filter(expert =>
        expert.dimensions.includes(finding.category)
      );

      if (matchedExperts.length > 0) {
        finding.expertReviewers = matchedExperts.map(e => ({
          name: e.name,
          role: e.role,
          perspective: e.expertise,
        }));
        // Primary reviewer is the first matched expert (or the chair if present)
        const chair = matchedExperts.find(e => e.role === 'chair');
        finding.primaryReviewer = chair ? chair.name : matchedExperts[0].name;
      }
    }

    if (this._verbose) {
      const assigned = this._findings.filter(f => f.expertReviewers).length;
      console.log(`[DeepAudit] 👥 Expert panel: ${assigned}/${this._findings.length} finding(s) assigned to reviewers`);
    }
  }

  /**
   * Returns the fixed expert panel configuration.
   * Useful for generating LLM review prompts with expert personas.
   *
   * @returns {Array<{ name: string, title: string, role: string, expertise: string, dimensions: string[], promptPersona: string }>}
   */
  getExpertPanel() {
    return [...EXPERT_PANEL];
  }

  /**
   * Returns expert-enriched prompt for a specific finding.
   * Used by the /evolve command to generate expert-quality fix suggestions.
   *
   * @param {object} finding - An audit finding object
   * @returns {string} Expert-contextualised review prompt
   */
  buildExpertReviewPrompt(finding) {
    const experts = EXPERT_PANEL.filter(e =>
      e.dimensions.includes(finding.category)
    );
    if (experts.length === 0) return null;

    const primary = experts.find(e => e.role === 'chair') || experts[0];
    return [
      primary.promptPersona,
      '',
      `## Finding to Review`,
      `- **Severity**: ${finding.severity}`,
      `- **Category**: ${finding.category}`,
      `- **Title**: ${finding.title}`,
      `- **Description**: ${finding.description}`,
      finding.suggestion ? `- **Current Suggestion**: ${finding.suggestion}` : '',
      finding.locations ? `- **Locations**: ${JSON.stringify(finding.locations).slice(0, 300)}` : '',
      '',
      `Please provide:`,
      `1. Your assessment of the severity (agree/disagree, with reasoning)`,
      `2. A specific, actionable fix with code example if applicable`,
      `3. Any related issues this finding might indicate`,
    ].filter(Boolean).join('\n');
  }

  // ─── Logging ──────────────────────────────────────────────────────────

  _log(category, message) {
    if (this._verbose) {
      console.log(`[DeepAudit:${category}] ${message}`);
    }
  }
}

module.exports = { DeepAuditOrchestrator, AuditSeverity, AuditCategory, EXPERT_PANEL };
