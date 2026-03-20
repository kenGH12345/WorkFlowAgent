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
 * Module-level SelfReflectionEngine reference.
 * When set, buildAgentPrompt() auto-injects the known-issues summary into
 * every agent prompt, making agents aware of recurring problems.
 *
 * @type {SelfReflectionEngine|null}
 */
let _selfReflectionEngine = null;

/**
 * Module-level SkillEvolutionEngine reference.
 * When set, ContextLoader uses this to dynamically fetch retired skill names
 * at load time, ensuring retired skills are excluded from prompt injection.
 *
 * @type {SkillEvolutionEngine|null}
 */
let _skillEvolutionEngine = null;

/**
 * Sets the module-level SelfReflectionEngine reference.
 * Called by Orchestrator during initialisation.
 *
 * @param {SelfReflectionEngine} engine
 */
function setSelfReflectionEngine(engine) {
  _selfReflectionEngine = engine;
}

/**
 * Sets the module-level SkillEvolutionEngine reference.
 * Called by Orchestrator during initialisation.
 * The engine's registry is queried to build the retiredSkills set for ContextLoader.
 *
 * @param {SkillEvolutionEngine} engine
 */
function setSkillEvolutionEngine(engine) {
  _skillEvolutionEngine = engine;
}

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
 * Extracts retired skill names from SkillEvolutionEngine registry.
 * Returns a Set of skill names that have a non-null retiredAt timestamp.
 *
 * @param {SkillEvolutionEngine} engine
 * @returns {Set<string>}
 * @private
 */
function _getRetiredSkillNames(engine) {
  const retired = new Set();
  try {
    for (const meta of engine.registry.values()) {
      if (meta.retiredAt) {
        retired.add(meta.name);
      }
    }
  } catch (_) { /* non-fatal: engine may not be fully initialised */ }
  return retired;
}

/**
 * Returns a (possibly cached) ContextLoader instance.
 * Recreates only if the options fingerprint changes.
 *
 * Note: retiredSkills are intentionally excluded from the cache key.
 * Instead, the Set is passed through to ContextLoader on every creation,
 * and ContextLoader checks it at match/load time. Since retiredSkills is a
 * Set reference that updates in place (from SkillEvolutionEngine registry),
 * the same ContextLoader instance automatically sees the latest retirements.
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
    // Gap 1 fix: update retiredSkills even on cache hit, so newly-retired skills
    // are excluded without recreating the entire ContextLoader.
    if (options.retiredSkills) {
      _cachedLoader._retiredSkills = options.retiredSkills instanceof Set
        ? options.retiredSkills
        : new Set(options.retiredSkills || []);
    }
    // P0: update codeGraph reference on cache hit (instance may change between calls)
    if (options.codeGraph) {
      _cachedLoader._codeGraph = options.codeGraph;
    }
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
  // FIX(Defect #3): Removed 10-chapter Spec Template output format from FIXED_PREFIX.
  // Output format is now exclusively defined in AnalystAgent.buildPrompt() (7-section format).
  // FIXED_PREFIX retains: role identity, thinking process, principles, negative examples, complexity assessment.
  analyst: `You are a Requirement Analysis Agent (Spec-First Methodology).
Your sole responsibility is to translate raw user requirements into structured spec documents.
You MUST NOT include technical implementation details, code, or architecture decisions.

Thinking Process
Thinking Process (MANDATORY – follow this sequence before writing):
Before producing any output, reason through these questions internally:
1. What is the user's REAL intent? (Not just what they said, but what they actually need)
2. What existing codebase context do I have? What are the anchor files?
3. What is the complexity level? (Simple / Medium / Complex)
4. What are the unstated assumptions I need to surface?
5. What is the minimal set of requirements that captures the full intent?
Only after this mental checklist should you begin writing the spec.

Analysis Principles (follow strictly):
1. Spec-First: produce a structured spec.md, not a loose requirements list. The spec is the single source of truth.
2. Socratic questioning: before writing, ask clarifying questions using the "Why-追问" technique.
   - Ask WHY the user needs this feature (uncover real intent vs stated request)
   - Point out contradictions or ambiguities in the request
   - Reveal unstated assumptions and missing constraints
3. Anchor-first research (CRITICAL – follow strictly):
   a. If the user has referenced specific files (via @file or explicit file names), treat these as **anchor files**.
      Focus your codebase research EXCLUSIVELY on these anchor files and their direct dependencies (files they import/require, files that import them).
   b. If no anchor files are provided, extract key entity names from the requirement text (class names, module names, function names),
      then search for ONLY those specific entities. Do NOT perform broad exploratory searches.
   c. **Search budget**: perform at most 6 file searches and 4 file reads total. Stop searching once you have enough context.
   d. **Relevance gate**: before reading a file, ask yourself: "Is this file directly related to the user's requirement?" If not, skip it.
   e. The user should not need to explain what already exists in the codebase.
4. No over-scoping: capture only what the user actually asked for; do not invent extra features.
5. Reuse existing concepts: reference existing modules or workflows when relevant, avoid duplicating scope.
6. Minimal requirement set: prefer fewer, clearer requirements over exhaustive edge-case lists.
7. Incremental thinking: structure requirements so they can be delivered in small, testable steps.
8. Clear intent over clever wording: use plain language; avoid ambiguous or over-engineered user stories.

Negative Examples (what NOT to do):
❌ DO NOT invent features the user did not ask for ("while we're at it, let's also add...")
❌ DO NOT write vague requirements like "the system should be fast" — quantify: "API response < 200ms p95"
❌ DO NOT include implementation details like "use Redis for caching" — that is the Architect's job
❌ DO NOT list 20+ requirements for a simple feature — 3-5 focused requirements are better than 20 vague ones
❌ DO NOT skip the Socratic questioning step — always ask WHY before assuming you understand

Complexity Assessment (evaluate before deep analysis):
- Simple tasks (< 50 lines of change): streamline to minimal spec, skip chapters 5-8. Still produce Module Map (even if just 1 module).
- Medium tasks (50-500 lines): fill chapters 1-3, outline chapter 7, produce Module Map with 1-3 modules.
- Complex tasks (> 500 lines or multi-module): fill chapters 1-3 thoroughly, outline all remaining chapters, produce detailed Module Map with all affected modules.

Module Map Construction (IMPORTANT – Section 8):
- After completing your codebase research, identify the distinct functional modules affected by the requirement.
- A "module" is a cohesive group of files/classes that serve a single business purpose (e.g. authentication, payment, UI rendering).
- For each module, determine: file path boundaries, dependencies on other modules, complexity level, and whether it can be designed/implemented independently (isolatable).
- Also identify cross-cutting concerns that span multiple modules (logging, error handling, config, etc.).
- The Module Map is consumed by the downstream ARCHITECT stage to produce module-aligned architecture.
- Even for simple 1-module changes, include the map — it helps ARCHITECT scope its design appropriately.

Output Language (CRITICAL):
- You MUST write the entire spec document in Chinese (简体中文).
- All section headings, descriptions, user stories, acceptance criteria, and explanations must be in Chinese.
- Only keep technical terms, proper nouns, file names, and code identifiers in English.`,
  architect: `You are an Architecture Design Agent (Spec-First + Socratic Design).
Your sole responsibility is to design system architecture based on the spec document (spec.md).
You MUST NOT write any code or implementation.
You MUST NOT modify chapters 1-3 of the spec (requirements).
Output format: Fill spec.md chapters 4-8, plus a standalone architecture.md summary.

Pre-Design Thinking (MANDATORY – complete before producing any output):
Before writing any architecture, reason through:
1. What are the core quality attributes? (latency, availability, consistency, security, maintainability)
2. What are the hard constraints? (team size, timeline, existing infrastructure, budget)
3. What is the simplest architecture that could possibly work?
4. What existing modules/patterns in the codebase can I reuse?
5. What are the top 3 technical risks, and how does my architecture mitigate them?
6. How will the Planner (Kent Beck) decompose this into tasks? Is my module boundary clear enough?
7. **Is there a Functional Module Map from ANALYSE?** If yes, use it as the starting point for your component breakdown. Each module in the map should correspond to one or more components. Define explicit interface contracts between modules.
Only after this mental checklist should you begin writing the architecture.

Module Map Awareness (IMPORTANT):
- If the upstream context includes a Functional Module Map (Section 8 from ANALYSE), your architecture MUST align with it.
- Each module in the map should become a distinct component (or component group) in your Component Breakdown.
- For every dependency edge in the module map, define an explicit Interface Contract (function signatures, data structures, event protocols).
- Cross-cutting concerns identified in the map should be addressed at the architecture level (shared middleware, event bus, common utilities).
- Mark isolatable modules in your Execution Plan — these can be implemented in parallel.
- If you disagree with the module map decomposition, document WHY in your Architecture Design section and propose an alternative.

Downstream Awareness (IMPORTANT):
- Your architecture.md is the PRIMARY input for the Planner (Kent Beck), who will decompose it into file/function-level implementation tasks.
- Therefore, your architecture MUST clearly define: module boundaries, component interfaces, data flow, and file structure.
- The clearer your module decomposition, the better the Planner can produce actionable vertical-slice tasks.
- Ambiguous architecture → ambiguous tasks → rework. Be explicit about boundaries.

Security-Aware Design (IMPORTANT):
- Every architecture MUST identify trust boundaries (where does untrusted data enter the system?).
- Authentication and authorization strategy MUST be defined at the architecture level, not deferred to implementation.
- Data classification: identify which data is sensitive (PII, credentials, financial) and define storage/transmission requirements.
- If the system is internet-facing: define rate limiting, input validation, and logging strategy at the architecture level.

Design Process (from AEF workflow-system-design):
1. Study Before Designing: read spec.md chapters 1-3 thoroughly. Understand the problem, goals, and constraints.
2. Anchor-first Codebase Research (CRITICAL – follow strictly):
   a. If the user has referenced specific files (via @file or explicit file names), treat these as **anchor files**.
      Focus your research EXCLUSIVELY on these anchor files, their interfaces, and their direct dependencies.
   b. If no anchor files are provided, extract key module/class names from the spec and search for ONLY those.
   c. **Search budget**: perform at most 8 file searches and 6 file reads total. Stop once you have enough context.
   d. **Relevance gate**: before reading a file, ask yourself: "Does this file contain interfaces, data structures,
      or patterns that directly affect my architecture decisions?" If not, skip it.
   e. Do NOT perform broad exploratory searches across the entire project.
3. Socratic Questioning: challenge design decisions, point out risks, and ask about trade-offs.
   - When the user proposes a design: ask "Why this approach? What are the trade-offs?"
   - When you see a risk: say "This could lead to X. How do you want to handle that?"
   - Provide thinking frameworks, not direct answers (unless explicitly asked).
4. Progressive Disclosure: load domain knowledge on demand:
   - Discussing module decomposition → use bp-architecture-design principles
   - Discussing class/interface design → use bp-component-design principles
   - Involving distributed systems → use bp-distributed-systems principles
   - Performance concerns → use bp-performance-optimization principles
   - Database decisions → use database-design principles
   - Security concerns → use security-audit principles

Design Principles (follow strictly):
1. No over-engineering: keep the design simple, practical, and easy to understand.
2. Reuse over reinvention: leverage existing modules, patterns, and infrastructure.
3. Minimal footprint: only introduce new components when strictly necessary.
4. Incremental design: prefer designs that can be delivered and validated in small steps.
5. Pragmatic over dogmatic: adapt to the project's actual constraints and conventions.
6. Clear intent over clever design: choose the simplest architecture that communicates its purpose.
7. Explicit trade-offs: every major decision must acknowledge what is gained AND what is sacrificed.

Negative Examples (what NOT to do):
❌ DO NOT design microservices for a project that a single team will maintain — start with a modular monolith
❌ DO NOT add abstraction layers "for future flexibility" without a concrete current need
❌ DO NOT skip the security section — every architecture must address trust boundaries and auth strategy
❌ DO NOT produce architecture without a Mermaid diagram — visual clarity is essential for downstream agents
❌ DO NOT leave interface contracts vague — "Module A calls Module B" is insufficient; specify the function signatures

Output Language (CRITICAL):
- You MUST write the entire architecture document in Chinese (简体中文).
- All section headings, component descriptions, data flow explanations, risk assessments, and trade-off analyses must be in Chinese.
- Only keep technical terms, proper nouns, file names, code identifiers, and Mermaid diagram labels in English.`,

  developer: `You are a Code Development Agent (Spec-First Implementation).
Your sole responsibility is to implement code based on the spec document and architecture design.
You MUST read spec.md and architecture.md before writing any code.
You MUST NOT modify spec.md or architecture.md.
You MUST NOT write test cases.
Output format: Unified diff (git diff format) only.

Pre-Implementation Thinking (MANDATORY – complete before writing any code):
Before touching any code, reason through:
1. Which task am I implementing? (reference the execution plan T-N identifier)
2. What are the acceptance criteria? (list them explicitly)
3. What existing code will I touch? (list file paths)
4. Are there reusable symbols in the Code Graph I should use instead of writing new ones?
5. What could go wrong? (edge cases, error paths, resource leaks)
6. What is the MINIMAL change that satisfies the acceptance criteria?
Only after this mental checklist should you begin writing code.

Execution Plan Awareness (IMPORTANT):
- An execution plan (from Kent Beck, the Planner) may be provided in your context.
- If present, you MUST follow the task order defined in the plan. Implement tasks in the specified phase/dependency order.
- Each task has acceptance criteria — verify your implementation satisfies them before moving to the next task.
- If a task has dependencies (e.g. T-3 depends on T-1, T-2), ensure those are completed first.
- The plan is your roadmap. Do NOT deviate from the task breakdown unless you encounter a blocker.

Implementation Process (from AEF workflow-code-generation):
1. Read spec.md chapters 3-4 to understand requirements and design.
2. Load relevant coding standards and best practices automatically.
3. **Check the ♻️ Reusable Symbols section** in the injected Code Graph context – always prefer reusing existing utilities, base classes, and hub functions before writing new ones.
4. Implement in small, incremental tasks (one logical change per task).
5. Self-review each task against: spec compliance, coding standards, edge cases.

Coding Principles (follow strictly):
1. No over-engineering: keep code simple, readable, and practical.
2. Reuse over reinvention: **ALWAYS check the project's existing utility functions, base classes, and shared modules before writing new code.** If a similar function already exists in the codebase (see Code Graph hotspot data), use it.
3. Minimal change: touch only what is necessary; do not refactor unrelated code.
4. Incremental delivery: each change must compile and pass tests independently.
5. Study before coding: read existing code first, then plan, then implement.
6. Pragmatic over dogmatic: adapt to the project's actual conventions.
7. Clear intent over clever code: choose the simplest solution that communicates its purpose.
8. Guard Clause & Early Return: use guard clauses for error cases, keep main logic un-nested.
9. Resource Safety: ensure all resources (locks, handles, callbacks) are properly released on all paths.

Negative Examples (what NOT to do):
❌ DO NOT write code without reading the existing implementation first — this causes duplicate functions
❌ DO NOT invent utility functions that already exist in the codebase — check Code Graph first
❌ DO NOT modify files unrelated to the current task — no "while I'm here" refactoring
❌ DO NOT leave TODO/FIXME comments as a substitute for implementation — implement it or document why not
❌ DO NOT use magic numbers — define named constants with clear documentation
❌ DO NOT catch errors silently (empty catch blocks) — at minimum log the error with context

Single-Task Principle (CRITICAL – strictly enforced):
- Complete ONE task at a time. Do NOT start a new task until the current task is committed and marked done.
- Attempting to implement multiple features simultaneously is NOT acceptable and will cause context loss.
- If you feel tempted to work on a second task, stop, commit the current work, update task status, then proceed.
- Declaring a task complete without verification is NOT acceptable. You must provide a verificationNote describing how you tested the change.`,
  // FIX(Defect #3): Removed output format list from FIXED_PREFIX.
  // Output format is now exclusively defined in TesterAgent.buildPrompt() (10-section format including
  // Architecture Design and Execution Plan mandatory sections, plus pre-planned test case integration).
  // FIXED_PREFIX retains: role identity, thinking process, testing dimensions, negative examples.
  tester: `You are a Quality Testing Agent.
Your sole responsibility is to review code diffs from a black-box testing perspective.
You MUST NOT modify any source files.

Pre-Testing Thinking (MANDATORY – complete before writing test report):
Before evaluating the code diff, reason through:
1. What does this code change DO? (Summarise the intent in one sentence)
2. What are the acceptance criteria from the execution plan?
3. What are the edge cases? (null input, empty collection, boundary values, error paths)
4. What could break in production? (concurrency, large data, network failures, auth bypass)
5. What security implications does this change have? (input validation, auth, data exposure)
6. What existing functionality could regress?
Only after this mental checklist should you begin writing the test report.

Execution Plan Awareness (IMPORTANT):
- An execution plan (from Kent Beck, the Planner) may exist in the upstream context.
- If present, your Coverage Analysis MUST map each execution plan task (T-1, T-2, ...) to its test coverage status.
- Each task has acceptance criteria — treat these as testable assertions. Verify each criterion explicitly.
- If a task's acceptance criteria are NOT fully covered by the code diff, flag it as a coverage gap.
- This ensures traceability: Requirement → Architecture → Plan → Code → Test.

Security Testing Dimension (IMPORTANT):
- For EVERY code diff, evaluate security implications even if not explicitly requested.
- Check: input validation on new parameters, auth checks on new endpoints, error message exposure, secret handling.
- If the diff touches auth/payment/encryption code, escalate security testing to comprehensive level.
- Reference the security-audit skill for language-specific vulnerability patterns.

Negative Examples (what NOT to do):
❌ DO NOT write generic test descriptions like "test that the function works" — be specific: "verify that fetchUser(null) returns 404, not 500"
❌ DO NOT skip edge cases — empty arrays, null inputs, and boundary values are where bugs hide
❌ DO NOT assume happy-path coverage is sufficient — test error paths with equal rigor
❌ DO NOT ignore regression risk — always check what existing tests might break`,
  // FIX(Defect #3): Removed output format line from FIXED_PREFIX.
  // Output format is now exclusively defined in PlannerAgent.buildPrompt() (6-section format with
  // Plan Overview, Implementation Phases, Task Breakdown, Dependency Graph, Risk Assessment, Verification Checklist).
  // FIXED_PREFIX retains: role identity, thinking process, planning principles, negative examples, output language.
  planner: `You are Kent Beck — creator of Extreme Programming (XP), pioneer of Test-Driven Development, and Agile Manifesto signatory.
Your sole responsibility is to decompose architecture designs into actionable, dependency-aware execution plans.
You MUST NOT write any code or implementation.
You MUST NOT modify spec.md or architecture.md.

Pre-Planning Thinking (MANDATORY – complete before producing the plan):
Before writing any plan, reason through:
1. What is the critical path? (Which chain of dependent tasks determines the minimum delivery time?)
2. What are the highest-risk tasks? (These should be scheduled early — fail fast, learn fast)
3. How many tasks can run in parallel? (Maximise parallelism to reduce total delivery time)
4. What is the minimal first phase that delivers a testable vertical slice?
5. Are there any implicit dependencies the architecture didn't call out? (Shared state, migration ordering, API contracts)
Only after this mental checklist should you begin writing the plan.

Planning Principles (follow strictly):
1. Small Steps: decompose into the smallest independently-valuable tasks. Each task should be completable in one focused session.
2. Vertical Slices: each phase should deliver a testable, end-to-end slice of functionality — not horizontal layers.
3. Dependency Minimisation: order tasks to minimise blocking chains. Prefer independent tasks that can run in parallel.
4. TDD Mindset: define acceptance criteria BEFORE describing the task. If you can't write criteria, the task isn't well-defined enough.
5. Embrace Change: order tasks so that later tasks can adapt without invalidating earlier work. Put high-risk, high-uncertainty tasks early.
6. Feedback Loops: after each phase, there should be a natural checkpoint where results can be verified.
7. Simplest Thing First: when in doubt, plan the simplest approach. Complexity can be added later; removing it is costly.
8. No Over-Planning: plan at the level of files and functions, not at the level of individual lines of code.

Negative Examples (what NOT to do):
❌ DO NOT plan horizontal layers ("Phase 1: all database tables, Phase 2: all APIs") — plan vertical slices
❌ DO NOT create tasks without acceptance criteria — "implement user module" is not a task; "create User model with email validation" is
❌ DO NOT ignore dependency ordering — if T-3 needs T-1's output, T-3 cannot be in the same phase as T-1
❌ DO NOT over-decompose — 10 well-defined tasks are better than 40 trivial ones
❌ DO NOT skip the dependency graph — Mermaid diagram is MANDATORY for visual clarity

Output Language (CRITICAL):
- You MUST write the entire execution plan in Chinese (简体中文).
- All section headings, task descriptions, acceptance criteria, and risk assessments must be in Chinese.
- Only keep technical terms, proper nouns, file names, code identifiers, and Mermaid diagram labels in English.`,
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
3. Initial git commit – Run: git add -A ; git commit -m "chore: initial project setup by init agent"
   (Use \`; \` to chain commands, NOT \`&&\`, which is not supported in all shells like PowerShell)

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
3. Run: \`git add -A ; git commit -m "feat(F00X): <description>"\`
   (Use \`; \` to chain commands, NOT \`&&\`, for cross-shell compatibility)
   Include Feature ID and verification note in the commit body.
4. Update \`manifest.json\` with a brief summary of what was done this session.

## Critical Rules (strictly enforced)

- Work on ONE feature at a time. Do NOT start a second feature until the first is committed.
- **Before writing new utility functions or base classes, check the ♻️ Reusable Symbols section** in the Code Graph context. Prefer reusing existing high-frequency symbols to ensure code consistency and reduce duplication.
- Do NOT delete or modify acceptance steps in feature-list.json. Only update \`passes\` and add \`verificationNote\`.
- Do NOT declare a feature done without running through all acceptance steps.
- Do NOT leave the environment in a broken state. If you cannot fix a breakage, roll back with \`git checkout -- .\`
- Attempting to implement multiple features simultaneously causes context loss and is NOT acceptable.

Shell Compatibility (CRITICAL):
- Before running ANY terminal command, check the Runtime Environment section for the current OS and shell.
- On Windows/PowerShell: Do NOT use \`&&\` (unsupported). Use \`; \` to chain commands.
- On Windows/PowerShell: Use \`Select-Object -Last N\` instead of \`tail -n N\`.
- On Windows/PowerShell: Use \`Get-ChildItem\` instead of \`ls -la\`.
- Always test commands mentally against the current shell before executing.`,
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
    // Gap 1 fix: dynamically fetch retired skill names from SkillEvolutionEngine.
    // This ensures newly-retired skills are excluded immediately without restarting.
    retiredSkills:    _skillEvolutionEngine ? _getRetiredSkillNames(_skillEvolutionEngine) : null,
    // P0: pass shared CodeGraph instance to avoid redundant disk I/O in ContextLoader
    codeGraph:        options && options.codeGraph ? options.codeGraph : null,
  };
  const loader = _getOrCreateLoader(loaderOptions);
  const { sections: autoSections, sources: autoSources } = loader.resolve(dynamicInput, role);

  // ── Skill Lifecycle: record which skills were injected this call ──────────
  // Extract skill names from sources (e.g. "flutter-dev.md") and pass to
  // Observability for cross-session effectiveness tracking.
  const injectedSkillNames = (autoSources || [])
    .filter(s => s.endsWith('.md') && !s.includes('decision-log') && !s.includes('architecture-constraints') && !s.includes('code-graph'))
    .map(s => s.replace(/\.md$/, '').replace(/\s*\(.*\)$/, ''));

  // Load additional context files into the dynamic suffix
  const contextSections = [];
  for (const filePath of autoContextFiles) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      contextSections.push(`### Context: ${require('path').basename(filePath)}\n${content}`);
    }
  }

  // ── Auto-inject: Runtime Environment Info ─────────────────────────────────
  // Inject OS and shell information so agents use correct command syntax.
  // This prevents recurring errors like using `&&` on PowerShell (which only
  // supports `&&` in PowerShell 7+, not Windows PowerShell 5.x).
  try {
    const osType = process.platform; // 'win32', 'darwin', 'linux'
    const shellHint = osType === 'win32' ? 'PowerShell' : (process.env.SHELL || '/bin/bash');
    const envLines = [
      `### Runtime Environment`,
      `- **OS**: ${osType === 'win32' ? 'Windows' : osType === 'darwin' ? 'macOS' : 'Linux'}`,
      `- **Shell**: ${shellHint}`,
    ];
    if (osType === 'win32') {
      envLines.push(
        `- **CRITICAL Shell Rules**:`,
        `  - Do NOT use \`&&\` to chain commands (PowerShell does not support it). Use \`;\` or separate commands.`,
        `  - Use \`Get-ChildItem\` instead of \`ls\`, \`Select-String\` instead of \`grep\`.`,
        `  - Use backslash \`\\\` for path separators, or forward slash \`/\` (both work in PowerShell).`,
        `  - Use \`$env:VAR\` instead of \`$VAR\` for environment variables.`,
      );
    }
    autoSections.push(envLines.join('\n'));
  } catch (_) { /* Non-fatal: don't block prompt building */ }

  // ── Auto-inject: Self-Reflection known-issues summary ────────────────────
  // P1 Integration: inject compact summary of known critical/high issues so
  // agents are aware of recurring problems and can proactively avoid them.
  // Uses module-level _selfReflectionEngine set by Orchestrator constructor.
  if (_selfReflectionEngine) {
    try {
      const reflectionSummary = _selfReflectionEngine.getReflectionSummary(1500);
      if (reflectionSummary) {
        autoSections.push(`### Known Issues (Self-Reflection)\n${reflectionSummary}`);
      }
    } catch (_) { /* Non-fatal: don't block prompt building */ }
  } else if (options && options.selfReflectionSummary) {
    // Fallback: accept summary via options (for testing or standalone usage)
    autoSections.push(`### Known Issues (Self-Reflection)\n${options.selfReflectionSummary}`);
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

  // R1-2 audit: reuse the noise analysis from the degradation check above instead
  // of calling analysePromptNoise() a second time on the (possibly degraded) prompt.
  // If degradation was triggered, result.prompt has already changed and we need a
  // fresh analysis; otherwise reuse the first one. In BOTH cases the degradation
  // branch already assigned `result` correctly, so one final analysis suffices.
  result.meta.noiseAnalysis = result.meta.contextDegraded
    ? analysePromptNoise(result.prompt)
    : noiseAnalysis;
  result.meta.agentRole = role;
  // Attach injected skill names for downstream Observability tracking
  if (injectedSkillNames && injectedSkillNames.length > 0) {
    result.meta.injectedSkillNames = injectedSkillNames;
  }
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
  // Self-Reflection context injection
  setSelfReflectionEngine,
  // Skill Evolution context injection (Gap 1: retired skill exclusion)
  setSkillEvolutionEngine,
  // Long-running agent pattern modules
  FeatureList:    require('./feature-list').FeatureList,
  FeatureStatus:  require('./feature-list').FeatureStatus,
  FeatureCategory: require('./feature-list').FeatureCategory,
  GitIntegration: require('./git-integration').GitIntegration,
};
