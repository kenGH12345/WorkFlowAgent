/**
 * Stage Runner: ANALYST
 *
 * Extracted from orchestrator-stages.js (P0 decomposition – ADR-33).
 * Contains: _runAnalyst, _recordPromptABOutcome (shared helper)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { AgentRole } = require('./types');
const { RequirementClarifier } = require('./requirement-clarifier');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { Observability } = require('./observability');
const { translateMdFile } = require('./i18n-translator');
const { getPromptSlotManager } = require('./prompt-builder');
const { runEvoMapFeedback } = require('./stage-runner-utils');
const {
  storeAnalyseContext,
  webSearchHelper,
  formatWebSearchBlock,
} = require('./orchestrator-stage-helpers');

// ─── Prompt A/B outcome recording helper ──────────────────────────────────────
/**
 * Records the outcome of a prompt variant usage after a QualityGate decision.
 * Called after each stage's QualityGate.evaluate() to close the A/B feedback loop.
 *
 * @param {string} agentRole       - e.g. 'analyst', 'architect', 'developer', 'tester'
 * @param {boolean} gatePassed     - Did the QualityGate pass?
 * @param {number} correctionRounds - Number of self-correction / review rounds
 * @param {number} [tokensUsed=0]  - Estimated tokens used (from obs)
 */
function _recordPromptABOutcome(agentRole, gatePassed, correctionRounds, tokensUsed = 0) {
  const mgr = getPromptSlotManager();
  if (!mgr) return;
  const variantId = mgr.getSessionVariant(agentRole, 'fixed_prefix');
  if (!variantId) return;
  mgr.recordOutcome(agentRole, 'fixed_prefix', variantId, {
    gatePassed,
    correctionRounds,
    tokensUsed,
  });
}

/**
 * Runs the ANALYSE stage: requirement clarification, enrichment, and analysis.
 *
 * P1-2 fix: Explicit @this annotation documents the implicit dependency on
 * Orchestrator properties. This enables IDE IntelliSense, makes refactoring
 * safer (renaming Orchestrator properties will surface as JSDoc warnings),
 * and serves as living documentation of the function's runtime contract.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @param {string} rawRequirement - The raw user requirement text
 * @returns {Promise<string>} Path to the generated requirements.md
 */
async function _runAnalyst(rawRequirement) {
  console.log(`\n[Orchestrator] Stage: ANALYSE (AnalystAgent)`);

  if (!this.stageCtx) {
    throw new Error('[Orchestrator] stageCtx is not initialised. This is a bug – StageContextStore should be created in the Orchestrator constructor.');
  }

  const clarifier = new RequirementClarifier({
    askUser: this.askUser,
    maxRounds: this._adaptiveStrategy?.maxClarificationRounds ?? 2,
    verbose: true,
    llmCall: this._rawLlmCall,
  });
  const clarResult = await clarifier.clarify(rawRequirement);

  if (clarResult.riskNotes && clarResult.riskNotes.length > 0) {
    try {
      const scopeDecision = this.socratic.askAsync(DECISION_QUESTIONS.SCOPE_CLARIFICATION, 2);
      console.log(`[Orchestrator] ⚡ Scope clarification (non-blocking): "${scopeDecision.optionText}"`);
      if (scopeDecision.optionIndex === 0) {
        clarResult.enrichedRequirement = `[Scope: Minimal – implement only the core feature]\n\n${clarResult.enrichedRequirement}`;
      } else if (scopeDecision.optionIndex === 1) {
        clarResult.enrichedRequirement = `[Scope: Full – implement all mentioned features]\n\n${clarResult.enrichedRequirement}`;
      }
    } catch (err) {
      this.stateMachine.recordRisk('low', `[SocraticEngine] Scope clarification skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine scope clarification skipped – proceeding automatically. Reason: ${err.message}`);
    }
  }

  for (const note of clarResult.riskNotes) {
    this.stateMachine.recordRisk('medium', note);
  }

  // ── Optimization 4: Technical Feasibility Pre-research ───────────────────
  if (clarResult.riskNotes && clarResult.riskNotes.length > 0) {
    try {
      const COMMON_WORDS = new Set([
        'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'What', 'Which',
        'With', 'From', 'Should', 'Would', 'Could', 'Each', 'Every', 'Some', 'None',
        'Only', 'Before', 'After', 'Between', 'During', 'About', 'Below', 'Above',
        'Under', 'Must', 'Also', 'Will', 'Shall', 'Note', 'Make', 'Uses', 'Used',
        'Using', 'However', 'Therefore', 'Consider', 'Ensure', 'Verify', 'Because',
        'Please', 'Implement', 'Create', 'Build', 'Need', 'Want', 'Like', 'Provide',
      ]);
      const techKeywords = clarResult.riskNotes
        .join(' ')
        .match(/\b[A-Z][a-zA-Z0-9.]+\b/g)
        || [];
      const uniqueTechTerms = [...new Set(techKeywords)]
        .filter(t => t.length >= 3)
        .filter(t => !COMMON_WORDS.has(t))
        .filter(t => /\./.test(t) || /\d/.test(t) || /[a-z][A-Z]/.test(t) || /[A-Z]{2,}/.test(t))
        .slice(0, 5);
      if (uniqueTechTerms.length > 0) {
        const reqSnippet = (clarResult.enrichedRequirement || '').slice(0, 100).replace(/\n/g, ' ');
        const searchQuery = `${uniqueTechTerms.join(' ')} latest API compatibility constraints ${reqSnippet}`.slice(0, 200);
        console.log(`[Orchestrator] \uD83C\uDF10 Tech feasibility: searching for: "${searchQuery.slice(0, 80)}..."`);
        const searchResult = await webSearchHelper(this, searchQuery, {
          maxResults: 3,
          label: 'Tech Feasibility (Analyst)',
        });
        if (searchResult) {
          const feasibilityBlock = formatWebSearchBlock(searchResult, {
            title: 'Technical Feasibility Research',
            guidance: 'The following web search results provide latest technical constraints, API changes, and compatibility info. Use these to enrich the Open Questions and Risk sections of the requirement.',
          });
          clarResult.enrichedRequirement = `${clarResult.enrichedRequirement}\n\n${feasibilityBlock}`;
          console.log(`[Orchestrator] 🌐 Tech feasibility: ${searchResult.results.length} result(s) appended to enriched requirement.`);

          // ── ADR-30 P3: Persist ANALYSE search results to project knowledge base ──
          try {
            const knowledgePath = path.join(this._outputDir, 'analyse-search-knowledge.json');
            let existing = [];
            if (fs.existsSync(knowledgePath)) {
              try { existing = JSON.parse(fs.readFileSync(knowledgePath, 'utf-8')); } catch (_) { existing = []; }
            }
            const newEntry = {
              timestamp: new Date().toISOString(),
              query: searchQuery,
              techTerms: uniqueTechTerms,
              results: searchResult.results.map(r => ({
                title: r.title,
                url: r.url,
                snippet: (r.snippet || '').slice(0, 400),
              })),
              provider: searchResult.provider,
            };
            existing = existing.filter(e => e.query !== searchQuery);
            existing.push(newEntry);
            if (existing.length > 50) existing = existing.slice(-50);
            const tmpPath = knowledgePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf-8');
            fs.renameSync(tmpPath, knowledgePath);
            console.log(`[Orchestrator] 💾 ANALYSE search results persisted (${existing.length} total entries).`);
          } catch (persistErr) {
            console.warn(`[Orchestrator] ⚠️  Failed to persist ANALYSE search results (non-fatal): ${persistErr.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[Orchestrator] \uD83C\uDF10 Tech feasibility web search failed (non-fatal): ${err.message}`);
    }
  }

  if (!clarResult.skipped && clarResult.rounds > 0) {
    console.log(`[Orchestrator] ✅ Requirement clarified in ${clarResult.rounds} round(s). Proceeding to analysis.`);
  }

  if (clarResult.qualityMetrics && this.obs) {
    this.obs.recordClarificationQuality(clarResult.qualityMetrics, clarResult.rounds);
  }

  // ── P0-1: Inject Code Graph seed information for Module Map generation ────
  // Instead of letting the LLM guess module boundaries from scratch, we provide
  // the real directory-level structure from the Code Graph. This gives the
  // AnalystAgent concrete, grounded data to base its Functional Module Map on.
  try {
    if (this.codeGraph && typeof this.codeGraph.getModuleSummaryMarkdown === 'function') {
      const moduleSeedInfo = this.codeGraph.getModuleSummaryMarkdown({ maxDirs: 15 });
      if (moduleSeedInfo && moduleSeedInfo.length > 0) {
        clarResult.enrichedRequirement = `${clarResult.enrichedRequirement}\n\n${moduleSeedInfo}`;
        console.log(`[Orchestrator] 🗺️  Code Graph seed info injected into AnalystAgent (${moduleSeedInfo.length} chars). Module Map will be grounded in real codebase structure.`);
      } else {
        console.log(`[Orchestrator] 🗺️  Code Graph has no module summary (new project or single-directory). Module Map will be generated from scratch.`);
      }
    }
  } catch (seedErr) {
    console.warn(`[Orchestrator] ⚠️  Code Graph seed injection failed (non-fatal): ${seedErr.message}`);
  }

  // ── P1 fix: Inject Experience for ANALYSE stage (was completely missing) ───
  // The ANALYSE stage now learns from past requirement analysis experiences,
  // enabling better clarification questions and risk identification over time.
  let analystInjectedExpIds = [];
  try {
    if (this.experienceStore && typeof this.experienceStore.query === 'function') {
      const analystExp = this.experienceStore.query({
        skill: 'requirement-analysis',
        limit: this._adaptiveStrategy?.maxExpInjected ?? 5,
        currentRequirement: rawRequirement || '',
      });
      if (analystExp.length > 0) {
        let expBlock = '\n\n## Requirement Analysis Experience (from ExperienceStore)\n';
        expBlock += '> The following experiences are from past successful requirement analyses. Use them to improve clarification questions and risk identification.\n\n';
        for (const exp of analystExp) {
          expBlock += `- [${exp.type || 'general'}] **${exp.title || 'Untitled'}**: ${(exp.content || '').slice(0, 200)}\n`;
          if (exp.id) analystInjectedExpIds.push(exp.id);
        }
        clarResult.enrichedRequirement = `${clarResult.enrichedRequirement}${expBlock}`;
        this.obs.recordExpUsage({ injected: analystInjectedExpIds.length });
        console.log(`[Orchestrator] 📚 ANALYSE experience injection: ${analystInjectedExpIds.length} experience(s) from ExperienceStore`);
      }
    }
  } catch (expErr) {
    console.warn(`[Orchestrator] ⚠️  ANALYSE experience injection failed (non-fatal): ${expErr.message}`);
  }

  const outputPath = await this.agents[AgentRole.ANALYST].run(null, clarResult.enrichedRequirement);

  // ── Store ANALYSE stage context for downstream stages ─────────────────────
  const analyseCtx = storeAnalyseContext(this, outputPath, clarResult);

  // ── P1 fix: EvoMap feedback loop for ANALYSE stage (was completely missing) ───
  // When the requirement analysis completes successfully, we close the learning loop.
  // This enables the ANALYSE stage to learn from successful requirement analyses.
  try {
    let analyseContent = '';
    if (outputPath && fs.existsSync(outputPath)) {
      analyseContent = fs.readFileSync(outputPath, 'utf-8');
    }
    await runEvoMapFeedback(this, {
      injectedExpIds: analystInjectedExpIds,
      errorContext: analyseContent,
      stageLabel: 'ANALYSE',
    });
  } catch (evoErr) {
    console.warn(`[Orchestrator] ⚠️  EvoMap feedback failed for ANALYSE stage (non-fatal): ${evoErr.message}`);
  }

  // ── Prompt A/B: record analyst outcome ──────────────────────────────────
  _recordPromptABOutcome('analyst', true, clarResult.rounds ?? 0);

  // ── Defect J fix: Estimate task complexity from the enriched requirement ───
  if (this.obs) {
    const requirementText = clarResult.enrichedRequirement || '';
    const complexity = Observability.estimateTaskComplexity(requirementText);
    this.obs.recordTaskComplexity(complexity);

    if (this.stageCtx) {
      const existingAnalyse = this.stageCtx.get('ANALYSE') || {};
      this.stageCtx.set('ANALYSE', {
        ...existingAnalyse,
        meta: { ...(existingAnalyse.meta || {}), complexity },
      });
    }

    console.log(`[Orchestrator] 📊 AEF Complexity Assessment: level=${complexity.level}, score=${complexity.score}`);
    if (complexity.level === 'simple') {
      console.log(`[Orchestrator] ⚡ AEF Fast-Path: Simple task detected — ARCHITECT stage will use streamlined review.`);
    } else if (complexity.level === 'moderate') {
      console.log(`[Orchestrator] ▶️  AEF Standard-Path: Moderate task detected — standard review flow.`);
    } else if (complexity.level === 'complex' || complexity.level === 'very_complex') {
      console.log(`[Orchestrator] 🔍 AEF Full-Path: ${complexity.level === 'very_complex' ? 'Very complex' : 'Complex'} task detected — enhanced review budgets will be applied.`);
    }

    const cfgAutoFix = (this._config && this._config.autoFixLoop) || {};
    const updatedStrategy = Observability.deriveStrategy(PATHS.OUTPUT_DIR, {
      maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
      maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
      maxExpInjected:  cfgAutoFix.maxExpInjected  ?? 5,
      projectId:       this.projectId,
      taskComplexity:  complexity,
    });
    if (updatedStrategy.maxFixRounds !== this._adaptiveStrategy.maxFixRounds ||
        updatedStrategy.maxReviewRounds !== this._adaptiveStrategy.maxReviewRounds) {
      console.log(`[Orchestrator] 📈 Adaptive strategy re-derived after ANALYSE (complexity=${complexity.level}, score=${complexity.score}):`);
      console.log(`[Orchestrator]    maxFixRounds: ${this._adaptiveStrategy.maxFixRounds} → ${updatedStrategy.maxFixRounds} | maxReviewRounds: ${this._adaptiveStrategy.maxReviewRounds} → ${updatedStrategy.maxReviewRounds}`);
      this._adaptiveStrategy = updatedStrategy;
    }

    // ── P1 Auto-Tier Routing ──
    if (this.llmRouter && typeof this.llmRouter.applyTierRouting === 'function') {
      const tierResult = this.llmRouter.applyTierRouting(complexity);
      if (tierResult.applied) {
        console.log(`[Orchestrator] 🎯 P1 Auto-Tier: ${tierResult.changes.length} role(s) re-routed based on complexity=${complexity.level}.`);
        if (this.stageCtx) {
          const existingAnalyseCtx = this.stageCtx.get('ANALYSE') || {};
          this.stageCtx.set('ANALYSE', {
            ...existingAnalyseCtx,
            meta: {
              ...(existingAnalyseCtx.meta || {}),
              tierRouting: { applied: true, complexity: complexity.level, changes: tierResult.changes },
            },
          });
        }
      }
    }
  }

  this.bus.publish(AgentRole.ANALYST, AgentRole.ARCHITECT, outputPath, {
    clarificationRounds: clarResult.rounds ?? 0,
    signalCount:         clarResult.allSignals?.length ?? 0,
    riskNotes:           clarResult.riskNotes ?? [],
    skipped:             clarResult.skipped ?? false,
    contextSummary:      analyseCtx.summary,
  });

  // Generate Chinese companion file for developers (non-blocking)
  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  return outputPath;
}

module.exports = { _runAnalyst, _recordPromptABOutcome };
