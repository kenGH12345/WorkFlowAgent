/**
 * Stage Runner: ARCHITECT
 *
 * Extracted from orchestrator-stages.js (P0 decomposition – ADR-33).
 * Contains: _runArchitect
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { CoverageChecker } = require('./coverage-checker');
const { ArchitectureReviewAgent } = require('./architecture-review-agent');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { QualityGate } = require('./quality-gate');
const { translateMdFile } = require('./i18n-translator');
const { runEvoMapFeedback } = require('./stage-runner-utils');
const { _recordPromptABOutcome } = require('./stage-analyst');
const {
  buildArchitectUpstreamCtx,
  buildArchitectContextBlock,
  storeArchitectContext,
  webSearchHelper,
  formatWebSearchBlock,
  securityCVEHelper,
} = require('./orchestrator-stage-helpers');

// Forward reference: _runAnalyst is needed for rollback. Lazy-loaded to avoid circular deps.
let _runAnalyst = null;
function _getRunAnalyst() {
  if (!_runAnalyst) {
    _runAnalyst = require('./stage-analyst')._runAnalyst;
  }
  return _runAnalyst;
}

async function _runArchitect() {
  console.log(`\n[Orchestrator] Stage: ARCHITECT (ArchitectAgent)`);
  const inputPath = this.bus.consume(AgentRole.ARCHITECT);

  // ── Inject upstream cross-stage context ───────────────────────────────────
  const upstreamCtxForArch = buildArchitectUpstreamCtx(this);

  let techStackPrefix = '';
  try {
    const techDecision = this.socratic.askAsync(DECISION_QUESTIONS.TECH_STACK_PREFERENCE, 0);
    console.log(`[Orchestrator] ⚡ Tech stack preference (non-blocking): "${techDecision.optionText}"`);
    if (techDecision.optionIndex === 1) {
      techStackPrefix = '[Tech Stack: Minimal/Lightweight – prefer simple, low-dependency solutions]\n\n';
    } else if (techDecision.optionIndex === 2) {
      techStackPrefix = '[Tech Stack: Enterprise-grade – include full observability, logging, and monitoring]\n\n';
    }
  } catch (err) {
    this.stateMachine.recordRisk('low', `[SocraticEngine] Tech stack preference skipped (engine unavailable): ${err.message}`);
    console.warn(`[Orchestrator] ⚠️  SocraticEngine tech stack preference skipped – proceeding automatically. Reason: ${err.message}`);
  }

  // Enrich techStackPrefix with ProjectProfiler data (if available)
  try {
    const archConfig = this._config || {};
    const profile = archConfig.projectProfile;
    if (profile) {
      const enrichParts = [];
      if (profile.frameworks && profile.frameworks.length > 0) {
        enrichParts.push(`Frameworks: ${profile.frameworks.map(f => f.name).join(', ')}`);
      }
      if (profile.architecture && profile.architecture.pattern) {
        enrichParts.push(`Architecture: ${profile.architecture.pattern}`);
      }
      if (profile.dataLayer) {
        const dlParts = [];
        if (profile.dataLayer.orm && profile.dataLayer.orm.length > 0) dlParts.push(`ORM: ${profile.dataLayer.orm.join(', ')}`);
        if (profile.dataLayer.databases && profile.dataLayer.databases.length > 0) dlParts.push(`DB: ${profile.dataLayer.databases.join(', ')}`);
        if (dlParts.length > 0) enrichParts.push(`Data Layer: ${dlParts.join(', ')}`);
      }
      if (profile.communication && profile.communication.length > 0) {
        enrichParts.push(`Communication: ${profile.communication.join(', ')}`);
      }
      if (enrichParts.length > 0) {
        techStackPrefix += `[Project Profile: ${enrichParts.join(' | ')}]\n\n`;
        if (profile.lspEnhanced) {
          techStackPrefix += `[LSP-Enhanced: ${profile.lspServerName} – ${profile.lspStats?.symbolsCollected || 0} symbols analyzed]\n\n`;

          // Inject symbol inventory top 3 kinds
          if (profile.architecture && profile.architecture.symbolInventory) {
            const inv = profile.architecture.symbolInventory;
            const top3 = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 3);
            if (top3.length > 0) {
              techStackPrefix += `[Symbol Inventory: ${top3.map(([k, v]) => `${k}=${v}`).join(', ')}]\n\n`;
            }
          }

          // Inject decorator patterns summary
          if (profile.architecture && profile.architecture.decoratorPatterns) {
            const decs = Object.entries(profile.architecture.decoratorPatterns);
            if (decs.length > 0) {
              techStackPrefix += `[Decorators: ${decs.map(([layer, ds]) => `${layer}(${ds.join(',')})`).join(' | ')}]\n\n`;
            }
          }
        }
        console.log(`[Orchestrator] 📋 ProjectProfile enrichment injected into ArchitectAgent.${profile.lspEnhanced ? ' (LSP-enhanced)' : ''}`);
      }
    }
  } catch (_) { /* non-fatal: projectProfile enrichment is optional */ }

  const analystMeta = this.bus.getMeta(AgentRole.ARCHITECT);
  if (analystMeta && !analystMeta.skipped && analystMeta.clarificationRounds > 0) {
    console.log(`[Orchestrator] ℹ️  Requirement was clarified in ${analystMeta.clarificationRounds} round(s) (${analystMeta.signalCount} signal(s) resolved). Architect should read requirements.md carefully.`);
  }

  const archExpContextWithComplaints = await buildArchitectContextBlock(this, techStackPrefix, upstreamCtxForArch);
  this.obs.recordExpUsage({ injected: (archExpContextWithComplaints._injectedExpIds || []).length });

  const outputPath = await this.agents[AgentRole.ARCHITECT].run(inputPath, null, archExpContextWithComplaints);

  // ── Adapter Telemetry ─────────────────────────────────────────────────────
  if (this._adapterTelemetry && outputPath && fs.existsSync(outputPath)) {
    try {
      const archOutput = fs.readFileSync(outputPath, 'utf-8');
      this._adapterTelemetry.scanReferences(archOutput, 'ARCHITECT');
    } catch (_) { /* non-fatal */ }
  }

  const requirementPath = path.join(PATHS.OUTPUT_DIR, 'requirements.md');

  const coverageChecker = new CoverageChecker(this._rawLlmCall, { verbose: true });
  const archReviewer = new ArchitectureReviewAgent(
    this._rawLlmCall,
    {
      maxRounds: 2,
      verbose: true,
      outputDir: PATHS.OUTPUT_DIR,
      investigationTools: this._buildInvestigationTools('Architecture'),
    }
  );

  // ── Optimization 5: Tech Stack Selection Validation ─────────────────────
  try {
    if (fs.existsSync(outputPath)) {
      const archDoc = fs.readFileSync(outputPath, 'utf-8');
      const techPattern = /\b(?:React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Koa|NestJS|Django|Flask|FastAPI|Spring\s?Boot|Laravel|Rails|Prisma|TypeORM|Sequelize|Mongoose|TailwindCSS|Bootstrap|Material[- ]UI|Chakra[- ]UI|Redis|MongoDB|PostgreSQL|MySQL|SQLite|GraphQL|gRPC|Socket\.io|WebSocket|Stripe|Auth0|Firebase|Supabase|Docker|Kubernetes|Terraform|AWS\s?SDK|Vite|Webpack|esbuild|Jest|Vitest|Playwright|Cypress|Gin|Echo|Fiber|GORM|Actix|Tokio|Axum|Rocket|XLua|toLua|Cocos2d|Defold|Love2D|Unity|Unreal|Godot|Flutter|Dart|Riverpod|SwiftUI|Combine|Electron|Tauri|RabbitMQ|Kafka|NATS|Celery|Nginx|Caddy|Traefik)\b/gi;
      const techMentions = [...new Set((archDoc.match(techPattern) || []).map(t => t.trim()))].slice(0, 6);
      if (techMentions.length > 0) {
        const validationQuery = `${techMentions.join(' ')} latest version known issues deprecation 2024 2025`.slice(0, 200);
        console.log(`[Orchestrator] \uD83C\uDF10 Tech stack validation: searching for: "${validationQuery.slice(0, 80)}..."`);
        const validationResult = await webSearchHelper(this, validationQuery, {
          maxResults: 4,
          label: 'Tech Stack Validation (ArchReview)',
        });
        if (validationResult) {
          archReviewer.techStackValidationCtx = formatWebSearchBlock(validationResult, {
            title: 'Tech Stack Validation (Live Web Data)',
            guidance: 'These web search results provide the latest status of technologies used in this architecture. **Check for version mismatches, deprecated APIs, known security issues, or end-of-life announcements**. Flag any technology choice that conflicts with this real-time data.',
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] \uD83C\uDF10 Tech stack validation web search failed (non-fatal): ${err.message}`);
  }

  // ── Security CVE Audit ────────────────────────────────────────────────────
  try {
    const cveResult = await securityCVEHelper(this, null, {
      maxPackages: 10,
      label: 'Security Audit (ArchReview)',
    });
    if (cveResult && cveResult.totalVulns > 0) {
      const existingCtx = archReviewer.techStackValidationCtx || '';
      archReviewer.techStackValidationCtx = existingCtx
        ? `${existingCtx}\n\n${cveResult.block}`
        : cveResult.block;
      if (cveResult.criticalCount > 0) {
        this.stateMachine.recordRisk('high',
          `[SecurityCVE] ${cveResult.criticalCount} CRITICAL vulnerability(ies) found in project dependencies. Immediate remediation required.`,
          false
        );
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] \uD83D\uDEE1\uFE0F Security CVE audit failed (non-fatal): ${err.message}`);
  }

  const [coverageSettled, archReviewSettled] = await this.stateMachine.runParallel([
    { name: 'CoverageCheck', fn: () => coverageChecker.check(requirementPath, outputPath) },
    { name: 'ArchReview',    fn: () => archReviewer.review(outputPath, requirementPath) },
  ]);

  if (coverageSettled.status === 'rejected') {
    throw new Error(`[_runArchitect] CoverageChecker failed: ${coverageSettled.reason?.message ?? coverageSettled.reason}`);
  }
  if (archReviewSettled.status === 'rejected') {
    throw new Error(`[_runArchitect] ArchitectureReviewAgent failed: ${archReviewSettled.reason?.message ?? archReviewSettled.reason}`);
  }
  const coverageResult   = coverageSettled.value;
  const archReviewResult = archReviewSettled.value;

  const subtaskCoordinator = new RollbackCoordinator(this);
  subtaskCoordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'CoverageCheck', coverageResult);
  subtaskCoordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'ArchReview', archReviewResult);

  if (!coverageResult.skipped) {
    const coverageReport = coverageChecker.formatReport(coverageResult);
    fs.appendFileSync(outputPath, `\n\n---\n${coverageReport}`, 'utf-8');
    const evaluatedItems = coverageResult.covered + coverageResult.uncovered;
    console.log(`[Orchestrator] 📊 Coverage: ${coverageResult.covered}/${evaluatedItems} evaluated (${coverageResult.coverageRate}%) | total parsed: ${coverageResult.total}`);
  }

  for (const note of coverageResult.riskNotes) {
    this.stateMachine.recordRisk('high', note, false);
    console.warn(`[Orchestrator] ⚠️  ${note}`);
  }

  for (const note of archReviewResult.riskNotes) {
    const severity = note.includes('(high)') ? 'high' : 'medium';
    this.stateMachine.recordRisk(severity, note, false);
  }
  this.stateMachine.flushRisks();

  if (archReviewResult.failed === 0 || !archReviewResult.needsHumanReview) {
  try {
    const socraticDecision = this.socratic.askAsync(DECISION_QUESTIONS.ARCHITECTURE_APPROVAL, 0);
      if (socraticDecision.optionIndex === 1) {
        const abortMsg = '[SocraticEngine] User rejected architecture. Workflow aborted by user decision.';
        this.stateMachine.recordRisk('high', abortMsg);
        throw new Error(abortMsg);
      } else if (socraticDecision.optionIndex === 2) {
        this.stateMachine.recordRisk('medium', '[SocraticEngine] User approved architecture with reservations. Proceeding to code generation.');
        console.log(`[Orchestrator] ⚠️  Architecture approved with reservations. Proceeding.`);
      } else {
        console.log(`[Orchestrator] ✅ Architecture approved by user. Proceeding to code generation.`);
      }
    } catch (err) {
      if (err.message.includes('User rejected architecture')) throw err;
      this.stateMachine.recordRisk('low', `[SocraticEngine] Architecture approval skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine architecture approval skipped – proceeding automatically. Reason: ${err.message}`);
    }
  } else {
    const failedSummary = archReviewResult.riskNotes.slice(0, 2).join('; ');
    console.warn(`[Orchestrator] ⚠️  Architecture review FAILED: ${archReviewResult.failed} high-severity issue(s). Notifying user...`);
    try {
      const failureDecision = this.socratic.askAsync(
        DECISION_QUESTIONS.ARCHITECTURE_FAILURE_ACTION || DECISION_QUESTIONS.ARCHITECTURE_APPROVAL,
        0
      );
      console.log(`[Orchestrator] ⚡ Architecture failure action (non-blocking): "${failureDecision.optionText}"`);
      if (failureDecision.optionIndex === 1) {
        const proceedMsg = `[SocraticEngine] User chose to proceed despite architecture failure (${archReviewResult.failed} issue(s)): ${failedSummary}`;
        this.stateMachine.recordRisk('high', proceedMsg);
        console.warn(`[Orchestrator] ⚠️  User accepted architecture failure. Proceeding to CODE with high-severity risks recorded.`);
        archReviewResult.needsHumanReview = false;
      }
    } catch (err) {
      this.stateMachine.recordRisk('low', `[SocraticEngine] Architecture failure notification skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine architecture failure notification skipped – proceeding with rollback. Reason: ${err.message}`);
    }
  }

  if (archReviewResult.failed === 0) {
    console.log(`[Orchestrator] ✅ Architecture review passed.`);
  }

  // ── Quality gate decision ───────────────────────────────────────────────
  const archGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
  const archCtxMeta = this.stageCtx?.get(WorkflowState.ARCHITECT)?.meta || {};
  const rollbackCount = archCtxMeta._archRollbackCount || 0;
  const archDecision = archGate.evaluate(archReviewResult, WorkflowState.ARCHITECT, rollbackCount);
  archGate.recordExperience(archDecision, WorkflowState.ARCHITECT, archReviewResult, {
    skill: 'architecture-design',
    category: ExperienceCategory.ARCHITECTURE,
  });

  _recordPromptABOutcome('architect', archDecision.pass, archReviewResult.rounds ?? 0);

  if (!archDecision.pass && archDecision.rollback) {
    const failedNotes = archReviewResult.riskNotes.slice(0, 3).join('; ');
    console.warn(`[Orchestrator] ⚠️  ${archDecision.reason}`);

    if (this.stageCtx) {
      const existing = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
      this.stageCtx.set(WorkflowState.ARCHITECT, {
        ...existing,
        meta: { ...(existing.meta || {}), _archRollbackCount: rollbackCount + 1 },
      });
    }
    try {
      const coordinator = new RollbackCoordinator(this);
      const strategy = coordinator.analyseRollbackStrategy(
        WorkflowState.ARCHITECT, `Architecture review failed: ${failedNotes}`, 'ArchReview'
      );

      if (strategy.type === 'SUBTASK_RETRY' && strategy.cachedResults) {
        console.log(`[Orchestrator] 🎯 Defect C: Subtask-level retry for ARCHITECT. ${strategy.reason}`);

        const retryReviewer = new ArchitectureReviewAgent(
          this._rawLlmCall,
          {
            maxRounds: 2,
            verbose: true,
            outputDir: PATHS.OUTPUT_DIR,
            investigationTools: this._buildInvestigationTools('Architecture'),
          }
        );
        const requirementPathRetry = path.join(PATHS.OUTPUT_DIR, 'requirements.md');

        const retryNote = `\n\n---\n## ⚠️ Architecture Review Retry (Attempt ${rollbackCount + 1})\n\nPrevious review found these issues:\n${failedNotes}\n\nPlease address these concerns in a focused re-review.`;
        fs.appendFileSync(outputPath, retryNote, 'utf-8');

        const retryReviewResult = await retryReviewer.review(outputPath, requirementPathRetry);

        const cachedCoverage = strategy.cachedResults.get('CoverageCheck');
        const retryGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
        const retryDecision = retryGate.evaluate(retryReviewResult, WorkflowState.ARCHITECT, rollbackCount + 1);

        if (retryDecision.pass) {
          console.log(`[Orchestrator] ✅ Subtask-level retry succeeded: ArchReview passed on retry.`);
          coordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'ArchReview', retryReviewResult);

          if (this.stageCtx) {
            const existingArch = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
            this.stageCtx.set(WorkflowState.ARCHITECT, {
              ...existingArch,
              summary: `Architecture review passed on subtask retry (attempt ${rollbackCount + 1}). Original issues: ${failedNotes.slice(0, 150)}`,
              keyDecisions: [`ArchReview subtask retry succeeded after ${retryReviewResult.rounds ?? 0} round(s)`],
              artifacts: [outputPath],
              risks: retryReviewResult.riskNotes ?? [],
              meta: { ...(existingArch.meta || {}), _archRollbackCount: rollbackCount + 1, subtaskRetry: true },
            });
          }
          const archOutputCtx = storeArchitectContext(this, outputPath, retryReviewResult, cachedCoverage || coverageResult);
  this.bus.publish(AgentRole.ARCHITECT, AgentRole.PLANNER, outputPath, {
            reviewRounds:   retryReviewResult.rounds ?? 0,
            failedItems:    retryReviewResult.failed ?? 0,
            riskNotes:      retryReviewResult.riskNotes ?? [],
            contextSummary: archOutputCtx.summary,
          });
          return outputPath;
        }

        console.log(`[Orchestrator] ⚠️  Subtask-level retry failed. Falling through to full-stage rollback.`);
        coordinator.invalidateSubtaskCache(WorkflowState.ARCHITECT);
      }

      // ── Full-stage rollback ──────────────────────────────────────────────
      await coordinator.rollback(WorkflowState.ARCHITECT, `Architecture review failed: ${failedNotes.slice(0, 200)}`);

      const failureContext = `[ARCHITECTURE REVIEW FAILED – RETRY ${rollbackCount + 1}]\n\nThe previous architecture attempt failed review with these issues:\n${failedNotes}\n\nPlease re-analyse the requirements with these constraints in mind.`;
      const reanalysedPath = await _getRunAnalyst().call(this, failureContext);
      await this.stateMachine.transition(reanalysedPath, `ANALYSE → ARCHITECT (post-rollback retry ${rollbackCount + 1})`);
      console.log(`[Orchestrator] ✅ State machine advanced to ARCHITECT after post-rollback re-analysis.`);
      if (this.stageCtx) {
        const existingArch = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
        this.stageCtx.set(WorkflowState.ARCHITECT, {
          ...existingArch,
          summary: `Architecture review failed (retry ${rollbackCount + 1}): ${failedNotes.slice(0, 200)}. Re-analysis triggered.`,
          keyDecisions: [`Rollback to ANALYSE triggered after ${archReviewResult.failed} high-severity issue(s)`],
          artifacts: [outputPath],
          risks: archReviewResult.riskNotes ?? [],
          meta: { ...(existingArch.meta || {}), _archRollbackCount: rollbackCount + 1, rollbackTriggered: true },
        });
      }
      return { __alreadyTransitioned: true, artifactPath: reanalysedPath };
    } catch (rollbackErr) {
      console.warn(`[Orchestrator] Rollback failed (non-fatal): ${rollbackErr.message}. Proceeding with risks recorded.`);
    }
  } else if (!archDecision.pass && archDecision.needsHumanReview) {
    console.warn(`[Orchestrator] ⚠️  Rollback limit reached. Proceeding to CODE stage with ${archReviewResult.failed} unresolved issue(s).`);
  } else if (archDecision.pass && archReviewResult.failed > 0) {
    const lowSeverityNotes = archReviewResult.riskNotes
      .filter(n => !n.includes('(high)'))
      .slice(0, 3)
      .join('; ');
    this.stateMachine.recordRisk('low', `[ArchReview] ${archReviewResult.failed} low-severity issue(s) remain (no rollback): ${lowSeverityNotes}`);
    console.log(`[Orchestrator] ℹ️  ${archReviewResult.failed} minor architecture issue(s) remain (recorded as low-risk). Proceeding automatically.`);
  } else {
    console.log(`[Orchestrator] ℹ️  Architecture review: no issues. Proceeding automatically.`);
  }

  // ── EvoMap feedback loop ────────────────────────────────────────────────
  if (archDecision.pass) {
    await runEvoMapFeedback(this, {
      injectedExpIds: archExpContextWithComplaints._injectedExpIds || [],
      errorContext: (archReviewResult.riskNotes || []).join(' '),
      stageLabel: 'ARCHITECT',
    });
  }

  // ── Store ARCHITECT stage context ──────────────────────────────────────
  const archOutputCtx = storeArchitectContext(this, outputPath, archReviewResult, coverageResult);

  this.bus.publish(AgentRole.ARCHITECT, AgentRole.PLANNER, outputPath, {
    reviewRounds:   archReviewResult.rounds ?? 0,
    failedItems:    archReviewResult.failed ?? 0,
    riskNotes:      archReviewResult.riskNotes ?? [],
    contextSummary: archOutputCtx.summary,
  });

  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  return outputPath;
}

module.exports = { _runArchitect };
