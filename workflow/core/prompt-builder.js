/**
 * Prompt Builder – LLM Prompt Engineering & Context Optimisation
 *
 * Implements Requirement 8: LLM bottom-layer principle optimisation.
 *
 * Key principles applied:
 *  1. KV Cache friendly: fixed prefix + dynamic suffix separation
 *  2. Full context loading: load all relevant context, avoid truncation
 *  3. Noise detection: warn when token count exceeds hallucination risk threshold
 *  4. Signal-to-noise maximisation: structured, clean prompts
 */

'use strict';

const fs = require('fs');
const { LLM } = require('../core/constants');
const { getConfig } = require('../core/config-loader');
const { estimateTokens } = require('../tools/thin-tools');
const { ContextLoader } = require('./context-loader');
const { PromptSlotManager } = require('./prompt-slot-manager');

// ─── KV Cache Friendly Prompt Structure ──────────────────────────────────────

/**
 * Builds a KV-Cache-optimised prompt by separating:
 *  - FIXED PREFIX: system role, constraints, output format (cached across calls)
 *  - DYNAMIC SUFFIX: the actual input content (changes each call)
 *
 * This structure maximises KV Cache hit rate, reducing compute cost.
 *
 * @param {string} fixedPrefix  - Static system instructions (role, constraints, format)
 * @param {string} dynamicSuffix - Dynamic input content (changes per call)
 * @returns {{ prompt: string, meta: PromptMeta }}
 */
function buildKVCacheFriendlyPrompt(fixedPrefix, dynamicSuffix) {
  // Separator clearly marks the boundary for KV cache optimisation
  const KV_CACHE_BOUNDARY = '\n\n<!-- KV_CACHE_BOUNDARY: dynamic content below -->\n\n';
  const prompt = fixedPrefix + KV_CACHE_BOUNDARY + dynamicSuffix;

  return _annotatePrompt(prompt, { kvCacheOptimised: true, fixedPrefixLength: fixedPrefix.length });
}

// ─── Full Context Loader ──────────────────────────────────────────────────────

/**
 * Loads all relevant context files and assembles them into a single prompt.
 * Implements "load full context, avoid truncation" principle.
 *
 * @param {string}   basePrompt      - The core task prompt
 * @param {string[]} contextFilePaths - Paths to context files to include
 * @param {object}   [options]
 * @param {boolean}  [options.includeAgentsMd=true] - Whether to prepend AGENTS.md
 * @returns {{ prompt: string, meta: PromptMeta }}
 */
function buildFullContextPrompt(basePrompt, contextFilePaths = [], options = {}) {
  const { includeAgentsMd = true } = options;
  const sections = [];

  // 1. Global context (AGENTS.md) – always first for KV cache efficiency
  if (includeAgentsMd) {
    const agentsMdPath = require('../core/constants').PATHS.AGENTS_MD;
    if (fs.existsSync(agentsMdPath)) {
      const agentsMd = fs.readFileSync(agentsMdPath, 'utf-8');
      sections.push(`## Global Project Context (AGENTS.md)\n\n${agentsMd}`);
    }
  }

  // 2. Additional context files
  for (const filePath of contextFilePaths) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const fileName = require('path').basename(filePath);
      sections.push(`## Context: ${fileName}\n\n${content}`);
    } else {
      console.warn(`[PromptBuilder] Context file not found, skipping: "${filePath}"`);
    }
  }

  // 3. Base prompt (dynamic – goes last)
  sections.push(`## Task\n\n${basePrompt}`);

  const prompt = sections.join('\n\n---\n\n');
  return _annotatePrompt(prompt, { fullContextLoaded: true, contextFileCount: contextFilePaths.length });
}

// ─── Noise Detection ──────────────────────────────────────────────────────────

/**
 * Analyses a prompt for noise and hallucination risk.
 * Emits warnings when token count exceeds the threshold.
 *
 * @param {string} prompt
 * @returns {NoiseAnalysis}
 */
function analysePromptNoise(prompt) {
  const estimatedTokens = estimateTokens(prompt);
  const isHighRisk = estimatedTokens > LLM.HALLUCINATION_RISK_THRESHOLD;

  const analysis = {
    estimatedTokens,
    isHighRisk,
    riskLevel: _getRiskLevel(estimatedTokens),
    recommendations: [],
  };

  if (isHighRisk) {
    analysis.recommendations.push(
      `Token count (${estimatedTokens}) exceeds hallucination risk threshold (${LLM.HALLUCINATION_RISK_THRESHOLD}).`
    );
    analysis.recommendations.push(`Consider: (1) Use thick tools to summarise context, (2) Remove irrelevant sections, (3) Split into multiple focused prompts.`);

    console.warn(
      `\n⚠️  [PromptBuilder] HALLUCINATION RISK DETECTED\n` +
      `   Estimated tokens: ${estimatedTokens}\n` +
      `   Threshold: ${LLM.HALLUCINATION_RISK_THRESHOLD}\n` +
      `   Risk level: ${analysis.riskLevel}\n` +
      `   Recommendation: ${analysis.recommendations[1]}\n`
    );
  }

  return analysis;
}

function _getRiskLevel(tokens) {
  if (tokens < LLM.HALLUCINATION_RISK_THRESHOLD * 0.5) return 'low';
  if (tokens < LLM.HALLUCINATION_RISK_THRESHOLD) return 'medium';
  if (tokens < LLM.HALLUCINATION_RISK_THRESHOLD * 2) return 'high';
  return 'critical';
}

// ─── Cached ContextLoader instance (D1 optimisation) ─────────────────────────
// buildAgentPrompt() is called once per LLM invocation. Previously, each call
// created a brand-new ContextLoader, which meant scanning skill files from disk
// every time. Now we cache the loader and only recreate it when options change.
let _cachedLoader = null;
let _cachedLoaderKey = '';

/**
 * Callback list for one-shot notifications when _cachedLoader is first created.
 * Used by orchestrator-lifecycle.js to start SkillWatcher once ContextLoader exists.
 * @type {Function[]}
 */
let _onLoaderCreatedCallbacks = [];

/**
 * Module-level PromptSlotManager instance.
 * Initialised lazily on first buildAgentPrompt() call, or eagerly via
 * setPromptSlotManager(). When set, buildAgentPrompt() resolves the fixed
 * prefix from the variant registry instead of using the hardcoded
 * AGENT_FIXED_PREFIXES constant.
 *
 * @type {PromptSlotManager|null}
 */
let _promptSlotManager = null;

/**
 * Sets the module-level PromptSlotManager instance.
 * Called by Orchestrator during initialisation.
 *
 * @param {PromptSlotManager} mgr
 */
function setPromptSlotManager(mgr) {
  _promptSlotManager = mgr;
}

/**
 * Returns the current PromptSlotManager instance (or null).
 * Exposed so orchestrator-stages.js can call recordOutcome().
 *
 * @returns {PromptSlotManager|null}
 */
function getPromptSlotManager() {
  return _promptSlotManager;
}

/**
 * Returns the cached ContextLoader instance (or null if none exists yet).
 * Exposed so orchestrator-lifecycle.js can pass it to SkillWatcher for
 * cache invalidation without creating a second ContextLoader.
 *
 * @returns {ContextLoader|null}
 */
function getCachedLoader() {
  return _cachedLoader;
}

/**
 * Registers a one-shot callback that fires when _cachedLoader is first created.
 * If _cachedLoader already exists, the callback fires synchronously.
 * Used by orchestrator-lifecycle.js to start SkillWatcher after ContextLoader is ready.
 *
 * @param {Function} cb - (loader: ContextLoader) => void
 */
function onLoaderReady(cb) {
  if (typeof cb !== 'function') return;
  if (_cachedLoader) {
    // Already created – fire immediately
    cb(_cachedLoader);
  } else {
    _onLoaderCreatedCallbacks.push(cb);
  }
}

/**
 * Returns a (possibly cached) ContextLoader instance.
 * Recreates only if the options fingerprint changes.
 * @private
 */
function _getOrCreateLoader(options) {
  const key = JSON.stringify([
    options.workflowRoot,
    options.projectRoot,
    Object.keys(options.skillKeywords || {}),
    options.alwaysLoadSkills,
    options.globalSkills,
    options.projectSkills,
  ]);
  if (_cachedLoader && _cachedLoaderKey === key) {
    return _cachedLoader;
  }
  const isFirstCreation = !_cachedLoader;
  _cachedLoader = new ContextLoader(options);
  _cachedLoaderKey = key;

  // Fire one-shot callbacks when ContextLoader is first created.
  // This allows deferred SkillWatcher startup from orchestrator-lifecycle.js.
  if (isFirstCreation && _onLoaderCreatedCallbacks.length > 0) {
    const cbs = _onLoaderCreatedCallbacks;
    _onLoaderCreatedCallbacks = [];
    for (const cb of cbs) {
      try { cb(_cachedLoader); } catch (_) { /* non-fatal */ }
    }
  }

  return _cachedLoader;
}

// ─── Agent Prompt Templates ───────────────────────────────────────────────────

/**
 * Pre-built KV-Cache-optimised fixed prefixes for each agent role.
 * These are the STATIC parts that benefit most from KV caching.
 */
const AGENT_FIXED_PREFIXES = {
  analyst: `You are a Requirement Analysis Agent (Spec-First Methodology).
Your sole responsibility is to translate raw user requirements into structured spec documents.
You MUST NOT include technical implementation details, code, or architecture decisions.

Output format: Structured spec.md following the 10-chapter Spec Template:
  1. Background (problem, current state, use cases)
  2. Goals & Non-Goals
  3. Requirements (functional + non-functional)
  4. Design (to be filled by Architect – leave empty)
  5. Alternatives Considered (to be filled later)
  6. Industry Research (to be filled later)
  7. Test Plan (to be filled later)
  8. Observability & Operations (to be filled later)
  9. Changelog
  10. References

Your job is to fill chapters 1-3 thoroughly, then hand off to the Architect.

Analysis Principles (follow strictly):
1. Spec-First: produce a structured spec.md, not a loose requirements list. The spec is the single source of truth.
2. Socratic questioning: before writing, ask clarifying questions using the "Why-追问" technique.
   - Ask WHY the user needs this feature (uncover real intent vs stated request)
   - Point out contradictions or ambiguities in the request
   - Reveal unstated assumptions and missing constraints
3. Codebase-first research: study existing code and modules BEFORE asking the user questions.
   The user should not need to explain what already exists in the codebase.
4. No over-scoping: capture only what the user actually asked for; do not invent extra features.
5. Reuse existing concepts: reference existing modules or workflows when relevant, avoid duplicating scope.
6. Minimal requirement set: prefer fewer, clearer requirements over exhaustive edge-case lists.
7. Incremental thinking: structure requirements so they can be delivered in small, testable steps.
8. Clear intent over clever wording: use plain language; avoid ambiguous or over-engineered user stories.

Complexity Assessment (evaluate before deep analysis):
- Simple tasks (< 50 lines of change): streamline to minimal spec, skip chapters 5-8.
- Medium tasks (50-500 lines): fill chapters 1-3, outline chapter 7.
- Complex tasks (> 500 lines or multi-module): fill chapters 1-3 thoroughly, outline all remaining chapters.`,

  architect: `You are an Architecture Design Agent (Spec-First + Socratic Design).
Your sole responsibility is to design system architecture based on the spec document (spec.md).
You MUST NOT write any code or implementation.
You MUST NOT modify chapters 1-3 of the spec (requirements).
Output format: Fill spec.md chapters 4-8, plus a standalone architecture.md summary.

Design Process (from AEF workflow-system-design):
1. Study Before Designing: read spec.md chapters 1-3 thoroughly. Understand the problem, goals, and constraints.
2. Codebase Research: analyse existing code modules, interfaces, and dependencies before proposing changes.
3. Socratic Questioning: challenge design decisions, point out risks, and ask about trade-offs.
   - When the user proposes a design: ask "Why this approach? What are the trade-offs?"
   - When you see a risk: say "This could lead to X. How do you want to handle that?"
   - Provide thinking frameworks, not direct answers (unless explicitly asked).
4. Progressive Disclosure: load domain knowledge on demand:
   - Discussing module decomposition → use bp-architecture-design principles
   - Discussing class/interface design → use bp-component-design principles
   - Involving distributed systems → use bp-distributed-systems principles
   - Performance concerns → use bp-performance-optimization principles

Design Principles (follow strictly):
1. No over-engineering: keep the design simple, practical, and easy to understand.
2. Reuse over reinvention: leverage existing modules, patterns, and infrastructure.
3. Minimal footprint: only introduce new components when strictly necessary.
4. Incremental design: prefer designs that can be delivered and validated in small steps.
5. Pragmatic over dogmatic: adapt to the project's actual constraints and conventions.
6. Clear intent over clever design: choose the simplest architecture that communicates its purpose.
7. Explicit trade-offs: every major decision must acknowledge what is gained AND what is sacrificed.`,

  developer: `You are a Code Development Agent (Spec-First Implementation).
Your sole responsibility is to implement code based on the spec document and architecture design.
You MUST read spec.md and architecture.md before writing any code.
You MUST NOT modify spec.md or architecture.md.
You MUST NOT write test cases.
Output format: Unified diff (git diff format) only.

Implementation Process (from AEF workflow-code-generation):
1. Read spec.md chapters 3-4 to understand requirements and design.
2. Load relevant coding standards and best practices automatically.
3. Implement in small, incremental tasks (one logical change per task).
4. Self-review each task against: spec compliance, coding standards, edge cases.

Coding Principles (follow strictly):
1. No over-engineering: keep code simple, readable, and practical.
2. Reuse over reinvention: prefer existing utilities, modules, and patterns.
3. Minimal change: touch only what is necessary; do not refactor unrelated code.
4. Incremental delivery: each change must compile and pass tests independently.
5. Study before coding: read existing code first, then plan, then implement.
6. Pragmatic over dogmatic: adapt to the project's actual conventions.
7. Clear intent over clever code: choose the simplest solution that communicates its purpose.
8. Guard Clause & Early Return: use guard clauses for error cases, keep main logic un-nested.
9. Resource Safety: ensure all resources (locks, handles, callbacks) are properly released on all paths.

Single-Task Principle (CRITICAL – strictly enforced):
- Complete ONE task at a time. Do NOT start a new task until the current task is committed and marked done.
- Attempting to implement multiple features simultaneously is NOT acceptable and will cause context loss.
- If you feel tempted to work on a second task, stop, commit the current work, update task status, then proceed.
- Declaring a task complete without verification is NOT acceptable. You must provide a verificationNote describing how you tested the change.`,

  tester: `You are a Quality Testing Agent.
Your sole responsibility is to review code diffs from a black-box testing perspective.
You MUST NOT modify any source files.
Output format: Markdown test report with sections: Test Summary, Test Cases Executed, Defects Found, Coverage Analysis, Architecture Compliance, Risk Assessment, Recommendations, Regression Checklist.`,

  // ─── Long-running Agent Roles ─────────────────────────────────────────────
  // These two roles implement the dual-agent pattern from Anthropic's research
  // on long-running agents across multiple context windows.

  /**
   * INIT AGENT – First session only.
   * Responsible for setting up the environment so that subsequent Coding Agent
   * sessions can work incrementally without losing context.
   *
   * Outputs:
   *  - init.sh          : script to start the dev server / test environment
   *  - feature-list.json: structured JSON with ALL features, all passes:false
   *  - Initial git commit: "chore: initial project setup by init agent"
   */
  'init-agent': `You are the Init Agent – you run ONCE at the very beginning of a project.
Your sole responsibility is to set up the environment so that subsequent Coding Agent sessions can work incrementally.

You MUST produce the following outputs before finishing:
1. init.sh            – A shell script that starts the development server and runs a basic smoke test.
                        This script will be run at the start of every future Coding Agent session.
2. feature-list.json  – A structured JSON file listing ALL features required by the specification.
                        Every feature MUST start with "passes": false.
                        Every feature MUST have "steps": [...] describing end-to-end acceptance criteria.
                        Do NOT mark any feature as passes:true – that is the Coding Agent's job.
3. Initial git commit – Run: git add -A && git commit -m "chore: initial project setup by init agent"

Feature list format (each entry):
{
  "id": "F001",
  "category": "functional",
  "description": "User can open a new chat and send a message",
  "steps": [
    "Navigate to main interface",
    "Click the New Chat button",
    "Type a message and press Enter",
    "Verify AI response appears within 10 seconds",
    "Verify no errors in browser console"
  ],
  "passes": false
}

Init Agent Rules (CRITICAL):
- Be comprehensive: list EVERY feature, not just the obvious ones. Aim for 20+ features for any non-trivial project.
- Use JSON format for feature-list.json (not Markdown) – models are less likely to accidentally overwrite JSON.
- Do NOT implement any features yourself. Your job is setup only.
- Do NOT mark any feature as passes:true.
- The init.sh script must be executable and idempotent (safe to run multiple times).
- Commit everything before finishing – the next agent will use git log to orient itself.`,

  /**
   * CODING AGENT – All sessions after the first.
   * Responsible for incremental feature implementation, one feature at a time.
   * Must leave the environment clean at the end of each session.
   */
  'coding-agent': `You are a Coding Agent – you run in every session AFTER the Init Agent has set up the environment.
Your responsibility is to implement ONE feature per session, then leave the environment clean for the next session.

## Mandatory Session Start Sequence

Every session MUST begin with these steps in order:

1. Run \`pwd\` – confirm your working directory. You may ONLY edit files within this directory.
2. Read \`manifest.json\` and \`output/tasks.json\` to understand what has been done and what remains.
   Also read \`output/feature-list.json\` for the feature completion status.
3. Run \`git log --oneline -20\` – identify what was done in previous sessions.
4. Read and execute \`init.sh\` – start the development server.
5. Run a basic smoke test to verify the environment is healthy.
   If the environment is BROKEN, fix it BEFORE starting new feature work.
6. Read \`output/feature-list.json\`, find the highest-priority feature where \`passes: false\`.
   Work on that feature ONLY.

## Mandatory Session End Sequence

Every session MUST end with these steps in order:

1. Verify the feature works end-to-end (follow the acceptance steps in feature-list.json).
2. Update \`output/feature-list.json\`: set \`"passes": true\` for the completed feature.
   Include a \`"verificationNote"\` field describing how you tested it.
3. Run: \`git add -A && git commit -m "feat(F00X): <description>"\`
   Include Feature ID and verification note in the commit body.
4. Update \`manifest.json\` with a brief summary of what was done this session.

## Critical Rules (strictly enforced)

- Work on ONE feature at a time. Do NOT start a second feature until the first is committed.
- Do NOT delete or modify acceptance steps in feature-list.json. Only update \`passes\` and add \`verificationNote\`.
- Do NOT declare a feature done without running through all acceptance steps.
- Do NOT leave the environment in a broken state. If you cannot fix a breakage, roll back with \`git checkout -- .\`
- Attempting to implement multiple features simultaneously causes context loss and is NOT acceptable.`,
};

// ─── Session Start Checklist ─────────────────────────────────────────────────

/**
 * Builds a structured Session Start Checklist prompt section.
 * Inspired by the "long-running agent" pattern: each coding session must begin
 * with a fixed orientation sequence to prevent context loss across sessions.
 *
 * The checklist enforces:
 *  1. Confirm working directory
 *  2. Read progress file + task list to understand current state
 *  3. Check recent git log for undocumented changes
 *  4. Run init script to start dev server (if applicable)
 *  5. Run basic smoke test to verify environment health
 *  6. Select ONE pending task to work on
 *
 * @param {object} [options]
 * @param {string}  [options.progressFile]  - Path to progress/manifest file (default: manifest.json)
 * @param {string}  [options.taskFile]      - Path to task list file (default: tasks.json)
 * @param {string}  [options.initScript]    - Path to init script (default: none)
 * @param {boolean} [options.requireSmokeTest=false] - Whether to require a smoke test step
 * @returns {string} - The checklist prompt section (plain text, ready to inject)
 */
function buildSessionStartChecklist(options = {}) {
  const {
    progressFile = 'manifest.json',
    taskFile = 'output/tasks.json',
    featureListFile = null,
    initScript = null,
    requireSmokeTest = false,
  } = options;

  const steps = [
    `STEP 1 – Confirm working directory: Run \`pwd\` (or \`cd\` on Windows). You may ONLY edit files within this directory.`,
    `STEP 2 – Read progress state: Read \`${progressFile}\` and \`${taskFile}\` to understand what has been done and what remains.` +
      (featureListFile ? ` Also read \`${featureListFile}\` for the feature completion status.` : ''),
    `STEP 3 – Review recent git history: Run \`git log --oneline -20\` to identify any undocumented changes from previous sessions.`,
  ];

  if (initScript) {
    steps.push(`STEP 4 – Start environment: Read and execute \`${initScript}\` to start the development server before making any changes.`);
  }

  if (requireSmokeTest) {
    const stepNum = initScript ? 5 : 4;
    steps.push(`STEP ${stepNum} – Smoke test: Run a basic end-to-end test to verify the environment is healthy. If the environment is broken, fix it BEFORE starting new work.`);
  }

  const lastStep = steps.length + 1;
  const featureOrTask = featureListFile
    ? `Read \`${featureListFile}\`, find the highest-priority feature where \`passes: false\`, and work on it exclusively.`
    : `Read the task list, identify the highest-priority pending task, and work on it exclusively.`;
  steps.push(
    `STEP ${lastStep} – Select ONE task: ${featureOrTask}` +
    ` Do NOT claim or start a second task until the first is committed and marked done.`
  );

  const checklist = [
    `## Session Start Checklist (MANDATORY)`,
    ``,
    `Every session MUST begin with the following steps in order. Do not skip any step.`,
    ``,
    ...steps.map(s => `- ${s}`),
    ``,
    `⚠️  CRITICAL RULES:`,
    `- Work on ONE task at a time. Attempting multiple tasks simultaneously causes context loss and is NOT acceptable.`,
    `- Do NOT mark a task as done without providing a verificationNote describing how you tested the change.`,
    `- If the environment is broken at session start, fix it first before implementing new features.`,
  ].join('\n');

  return checklist;
}

/**
 * Builds a complete, optimised prompt for a specific agent role.
 *
 * @param {string} role         - Agent role (analyst|architect|developer|tester)
 * @param {string} dynamicInput - The dynamic input content for this call
 * @param {string[]} [contextFiles] - Additional context file paths
 * @returns {{ prompt: string, meta: PromptMeta }}
 */
function buildAgentPrompt(role, dynamicInput, contextFiles = [], options = {}) {
  // ── Prompt Slot A/B resolution ───────────────────────────────────────────
  // If PromptSlotManager is initialised and has a variant for this role,
  // use the resolved variant instead of the hardcoded AGENT_FIXED_PREFIXES.
  // This is the core integration point for Prefix-Level A/B testing.
  let fixedPrefix = AGENT_FIXED_PREFIXES[role];
  let _resolvedVariantId = null;
  let _isExploration = false;

  if (_promptSlotManager) {
    const resolved = _promptSlotManager.resolve(role, 'fixed_prefix');
    if (resolved && resolved.content) {
      fixedPrefix = resolved.content;
      _resolvedVariantId = resolved.variantId;
      _isExploration = resolved.isExploration;
      if (_isExploration) {
        console.log(`[PromptBuilder] 🔬 A/B exploration: using variant "${resolved.variantId}" for ${role}`);
      }
    }
  }

  if (!fixedPrefix) {
    const validRoles = Object.keys(AGENT_FIXED_PREFIXES).join(', ');
    throw new Error(`[PromptBuilder] Unknown agent role: "${role}". Valid roles: ${validRoles}`);
  }

  // For coding-agent: auto-inject feature-list.json if available.
  // Resolution order:
  //  1. Caller explicitly passes the path in contextFiles – use as-is.
  //  2. options.projectRoot is provided – look in <projectRoot>/output/feature-list.json.
  //  3. Fallback to PATHS.OUTPUT_DIR (workflow's own output dir) for backward-compat.
  const autoContextFiles = [...contextFiles];
  if (role === 'coding-agent') {
    const nodePath = require('path');
    const projectRoot = (options && options.projectRoot)
      ? options.projectRoot
      : require('../core/constants').WORKFLOW_ROOT;
    const featureListPath = nodePath.join(projectRoot, 'output', 'feature-list.json');
    const alreadyIncluded = autoContextFiles.some(f => nodePath.basename(f) === 'feature-list.json');
    if (!alreadyIncluded && fs.existsSync(featureListPath)) {
      autoContextFiles.unshift(featureListPath); // Prepend so it appears first
    }
  }

  // ── Auto-inject: skills + ADR digest via ContextLoader ─────────────────────
  // This is the fix for "Agent won't read skills/ or decision-log.md unless prompted".
  // ContextLoader matches task keywords → relevant skill files + ADR entries,
  // then injects them into the dynamic suffix automatically.
  // D1 optimisation: uses _getOrCreateLoader() to cache the ContextLoader instance
  // across multiple buildAgentPrompt() calls, avoiding redundant disk I/O.
  const loaderOptions = {
    workflowRoot:     require('../core/constants').WORKFLOW_ROOT,
    projectRoot:      options && options.projectRoot ? options.projectRoot : null,
    skillKeywords:    options && options.skillKeywords ? options.skillKeywords : {},
    alwaysLoadSkills: options && options.alwaysLoadSkills ? options.alwaysLoadSkills : [],
    globalSkills:     options && options.globalSkills ? options.globalSkills : (getConfig().globalSkills || []),
    projectSkills:    options && options.projectSkills ? options.projectSkills : (getConfig().projectSkills || []),
  };
  const loader = _getOrCreateLoader(loaderOptions);
  const { sections: autoSections } = loader.resolve(dynamicInput, role);

  // Load additional context files into the dynamic suffix
  const contextSections = [];
  for (const filePath of autoContextFiles) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      contextSections.push(`### Context: ${require('path').basename(filePath)}\n${content}`);
    }
  }

  // Build dynamic suffix: auto-injected context first, then explicit context, then input
  let dynamicSuffix = [...autoSections, ...contextSections, `### Input\n${dynamicInput}`].join('\n\n');
  let result = buildKVCacheFriendlyPrompt(fixedPrefix, dynamicSuffix);

  // Run noise analysis with automatic degradation strategy (D5 optimisation).
  // When the total prompt exceeds the hallucination risk threshold, automatically
  // drop the lowest-priority context sections (auto-injected skills/ADRs first,
  // then explicit context files) until we're back under budget.
  // This prevents the "warn but do nothing" anti-pattern where the system logs a
  // ⚠️ warning but still sends an oversized prompt, leading to hallucination.
  const noiseAnalysis = analysePromptNoise(result.prompt);
  if (noiseAnalysis.isHighRisk && (autoSections.length > 0 || contextSections.length > 0)) {
    // Strategy: progressively drop sections from lowest to highest priority.
    // Priority order (highest → lowest):
    //   1. ### Input (NEVER drop – this is the actual task)
    //   2. Explicit context files (high priority – caller explicitly requested these)
    //   3. Auto-injected skills/ADRs (lowest – these are supplementary)
    const degradedAutoSections = [];
    const inputSection = `### Input\n${dynamicInput}`;

    // Phase 1: try dropping all auto-injected sections
    let degradedSuffix = [...contextSections, inputSection].join('\n\n');
    let degradedResult = buildKVCacheFriendlyPrompt(fixedPrefix, degradedSuffix);
    let degradedNoise = analysePromptNoise(degradedResult.prompt);

    if (!degradedNoise.isHighRisk) {
      // Dropping auto-sections was sufficient. Now try to add back as many as fit.
      let restoredBudget = LLM.HALLUCINATION_RISK_THRESHOLD - degradedNoise.estimatedTokens;
      for (const section of autoSections) {
        const sectionTokens = estimateTokens(section);
        if (sectionTokens <= restoredBudget) {
          degradedAutoSections.push(section);
          restoredBudget -= sectionTokens;
        }
      }
      const droppedCount = autoSections.length - degradedAutoSections.length;
      if (droppedCount > 0) {
        console.log(`[PromptBuilder] 🔽 Context degradation: dropped ${droppedCount}/${autoSections.length} auto-injected section(s) to stay under hallucination threshold.`);
      }
      dynamicSuffix = [...degradedAutoSections, ...contextSections, inputSection].join('\n\n');
      result = buildKVCacheFriendlyPrompt(fixedPrefix, dynamicSuffix);
    } else {
      // Phase 2: still over budget even without auto-sections.
      // Drop explicit context files from the end (least relevant first).
      const keptContextSections = [];
      let contextBudget = LLM.HALLUCINATION_RISK_THRESHOLD - estimateTokens(fixedPrefix) - estimateTokens(inputSection) - 200; // 200 token safety margin
      for (const section of contextSections) {
        const sectionTokens = estimateTokens(section);
        if (sectionTokens <= contextBudget) {
          keptContextSections.push(section);
          contextBudget -= sectionTokens;
        }
      }
      const droppedContext = contextSections.length - keptContextSections.length;
      console.log(`[PromptBuilder] 🔽 Context degradation (phase 2): dropped all auto-injected sections + ${droppedContext}/${contextSections.length} context file(s).`);
      dynamicSuffix = [...keptContextSections, inputSection].join('\n\n');
      result = buildKVCacheFriendlyPrompt(fixedPrefix, dynamicSuffix);
    }
    result.meta.contextDegraded = true;
  }

  result.meta.noiseAnalysis = analysePromptNoise(result.prompt);
  result.meta.agentRole = role;
  // Attach A/B variant info for downstream outcome tracking
  if (_resolvedVariantId) {
    result.meta.promptVariantId = _resolvedVariantId;
    result.meta.promptVariantExploration = _isExploration;
  }

  return result;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _annotatePrompt(prompt, extraMeta = {}) {
  const estimatedTokens = estimateTokens(prompt);
  return {
    prompt,
    meta: {
      estimatedTokens,
      charCount: prompt.length,
      ...extraMeta,
    },
  };
}

module.exports = {
  buildKVCacheFriendlyPrompt,
  buildFullContextPrompt,
  analysePromptNoise,
  buildAgentPrompt,
  buildSessionStartChecklist,
  AGENT_FIXED_PREFIXES,
  // Prompt A/B testing
  setPromptSlotManager,
  getPromptSlotManager,
  // ContextLoader access (for SkillWatcher integration)
  getCachedLoader,
  // Deferred SkillWatcher startup
  onLoaderReady,
  // Long-running agent pattern modules
  FeatureList:    require('./feature-list').FeatureList,
  FeatureStatus:  require('./feature-list').FeatureStatus,
  FeatureCategory: require('./feature-list').FeatureCategory,
  GitIntegration: require('./git-integration').GitIntegration,
};
