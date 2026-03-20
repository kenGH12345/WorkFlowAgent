## Code Graph (947 symbols, 31533 call edges)

> Generated: 2026-03-17
> Query: `/graph search <keyword>` | `/graph file <path>` | `/graph calls <symbol>` | `/graph hotspot [N]`

### 🔥 Hotspot Analysis (Top referenced symbols)

> Categories: 🔧 Utility(74) | 🏗️ Foundation(124) | 🔀 Hub(52) | 🚪 Entry(98) | 🍃 Leaf(474) | 👻 Orphan(0)

- 🔧 **ExperienceStore** `[Utility]` ← 190 refs, → 24 calls | `workflow/core/experience-store.js`:26
- 🔀 **search**(query, { kind = null, file = null, limit) `[Hub]` ← 138 refs, → 70 calls | `workflow/core/code-graph.js`:320
- 🔧 **CodeReviewAgent** `[Utility]` ← 131 refs, → 39 calls | `workflow/core/code-review-agent.js`:375
- 🔧 **SelfCorrectionEngine** `[Utility]` ← 115 refs, → 29 calls | `workflow/core/clarification-engine.js`:384
- 🔀 **CodeGraph** `[Hub]` ← 112 refs, → 70 calls | `workflow/core/code-graph.js`:62
- 🔀 **Orchestrator** `[Hub]` ← 111 refs, → 100 calls | `workflow/index.js`:72
- 🔧 **getAll** `[Utility]` ← 109 refs, → 24 calls | `workflow/core/experience-store.js`:216
- 🔧 **ArchitectureReviewAgent** `[Utility]` ← 99 refs, → 30 calls | `workflow/core/architecture-review-agent.js`:372
- 🔧 **getStats** `[Utility]` ← 98 refs, → 24 calls | `workflow/core/complaint-wall.js`:227
- 🔧 **missing**(reviewResults.filter(r ) `[Utility]` ← 97 refs, → 43 calls | `workflow/core/review-agent-base.js`:159
- 🔧 **buildAgentPrompt**(role, dynamicInput, contextFiles = [], o) `[Utility]` ← 95 refs, → 35 calls | `workflow/core/prompt-builder.js`:518 // Builds a complete, optimised prompt for a specific
- 🔧 **formatReport**(result) `[Utility]` ← 95 refs, → 30 calls | `workflow/core/architecture-review-agent.js`:452
- 🔧 **translateMdFile**(mdPath, llmCall) `[Utility]` ← 93 refs, → 5 calls | `workflow/core/i18n-translator.js`:18 // - If llmCall is not provided, the translation is s
- 🔀 **querySymbolsAsMarkdown**(symbolNames) `[Hub]` ← 89 refs, → 70 calls | `workflow/core/code-graph.js`:674
- 🔧 **assert**(condition, msg) `[Utility]` ← 88 refs, → 8 calls | `workflow/tests/prompt-slot-manager.test.js`:14

### ♻️ Recommended for Reuse

> **When writing new code, prefer reusing these widely-used symbols over creating new ones.**

- **ExperienceStore** (190 refs) in `workflow/core/experience-store.js`:26
- **search** (138 refs) in `workflow/core/code-graph.js`:320
- **CodeReviewAgent** (131 refs) in `workflow/core/code-review-agent.js`:375
- **SelfCorrectionEngine** (115 refs) in `workflow/core/clarification-engine.js`:384
- **CodeGraph** (112 refs) in `workflow/core/code-graph.js`:62
- **Orchestrator** (111 refs) in `workflow/index.js`:72
- **getAll** (109 refs) in `workflow/core/experience-store.js`:216
- **ArchitectureReviewAgent** (99 refs) in `workflow/core/architecture-review-agent.js`:372
- **getStats** (98 refs) in `workflow/core/complaint-wall.js`:227
- **missing** (97 refs) in `workflow/core/review-agent-base.js`:159

### 📁 Symbol Index (by file)

#### test-hotspot.js
- `function` **main** → 7 call(s)

#### workflow/agents/analyst-agent.js
- `class` **AnalystAgent** → 14 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 13 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 13 call(s)
- `method` **parseResponse**(llmResponse) → 13 call(s)
- `function` **missingSections**(mandatorySections.filter(s ) → 13 call(s)

#### workflow/agents/architect-agent.js
- `class` **ArchitectAgent** → 14 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 13 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 13 call(s)
- `method` **parseResponse**(llmResponse) → 13 call(s)
- `function` **missingSections**(mandatorySections.filter(s ) → 13 call(s)

#### workflow/agents/base-agent.js
- `class` **BaseAgent** → 17 call(s)
- `method` **run**(inputFilePath = null, rawInput = null, e) → 16 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 16 call(s)
- `method` **parseResponse**(llmResponse) → 16 call(s)
- `method` **assertAllowed**(action) → 16 call(s)
- `method` **_readInput**(inputFilePath, rawInput) → 16 call(s)
- `method` **_writeOutput**(content) → 16 call(s)

#### workflow/agents/developer-agent.js
- `class` **DeveloperAgent** → 14 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 13 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 13 call(s)
- `method` **parseResponse**(llmResponse) → 13 call(s)
- `function` **missingSections**(mandatorySections.filter(s ) → 13 call(s)

#### workflow/agents/tester-agent.js
- `class` **TesterAgent** → 21 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 20 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 20 call(s)
- `method` **parseResponse**(llmResponse) → 20 call(s)
- `function` **missingSections**(requiredSections.filter(s ) → 20 call(s)
- `function` **missingMandatory**(mandatorySections.filter(s ) → 20 call(s)
- `function` **coveredIds**(plannedIds.filter(id ) → 20 call(s)

#### workflow/commands/command-router.js
- `function` **registerCommand**(name, description, handler) → 56 call(s) // Registers a command handler.
- `function` **dispatch**(input, context = {}) → 56 call(s) // Parses and dispatches a slash command string.
- `function` **taskDefs**(rawTasks.map((raw, i) → 56 call(s)
- `function` **taskSummary**(taskDefs.map((t, i) → 57 call(s)
- `function` **sorted**(entries.sort((a, b) → 57 call(s)
- `function` **loadGraph** → 56 call(s)
- `function` **trendIcon**(t) → 56 call(s)

#### workflow/core/agent-output-schema.js
- `function` **extractJsonBlock**(content) → 13 call(s) // ## Full Markdown narrative follows...
- `function` **validateJsonBlock**(jsonBlock, role) → 13 call(s) // Validates a parsed JSON block against the expected schema fo
- `function` **buildJsonBlockInstruction**(role) → 13 call(s) // Injected into agent prompts to instruct the LLM to output st
- `function` **extractKeyDecisions**(jsonBlock) → 13 call(s) // Falls back to empty array if the block is missing or malform
- `function` **extractSummary**(jsonBlock, stageName) → 13 call(s) // Extracts a summary string from a structured JSON block.

#### workflow/core/architecture-review-agent.js
- `function` **buildArchReviewPrompt**(checklist, archContent, requirementText ) → 30 call(s)
- `function` **buildAdversarialArchPrompt**(checklist, archContent, mainResults, req) → 30 call(s)
- `function` **passedItems**(mainResults.filter(r ) → 30 call(s)
- `function` **item**(checklist.find(c ) → 30 call(s)
- `function` **buildArchFixPrompt**(originalContent, failures) → 30 call(s)
- `function` **applyArchPatches**(originalContent, patchResponse) → 30 call(s)
- `class` **ArchitectureReviewAgent** → 30 call(s)
- `method` **constructor**(llmCall, options = {}) → 30 call(s)
- `method` **_getReviewContent**(inputPath) → 30 call(s)
- `method` **_buildReviewPrompt**(content, requirementText) → 30 call(s)
- `method` **_buildAdversarialPrompt**(content, mainResults, requirementText) → 30 call(s)
- `method` **_buildFixPrompt**(content, failures) → 30 call(s)
- `method` **_applyFix**(currentContent, rawFixed, mode) → 30 call(s)
- `method` **_writeBackArtifact**(inputPath, content) → 30 call(s)
- `method` **_writeReport**(result) → 30 call(s)
- `method` **_getInvestigationDomain** → 30 call(s)
- `method` **_getLabelPrefix** → 30 call(s)
- `method` **_getHeaderLine** → 30 call(s)
- `method` **_getFailureDefault** → 30 call(s)
- `method` **formatReport**(result) → 30 call(s)

#### workflow/core/ci-integration.js
- `class` **CIIntegration** → 31 call(s)
- `method` **_detectProvider** → 30 call(s)
- `method` **_detectRepoSlug** → 30 call(s)
- `method` **runLocalPipeline**({ skipLint = false, skipTest = false, sk) → 30 call(s)
- `function` **allPassed**(steps.every(s ) → 31 call(s)
- `method` **_runSyntaxCheck** → 30 call(s)
- `method` **_runStep**(name, command) → 30 call(s)
- `method` **_buildResult**(status, steps, startedAt, message = null) → 30 call(s)
- `method` **pollGitHub**({ branch = null, workflowName = null, wa) → 30 call(s)
- `function` **poll** → 30 call(s)
- `method` **_mapGitHubStatus**(status, conclusion) → 30 call(s)
- `method` **pollGitLab**({ branch = null, wait = false } = {}) → 30 call(s)
- `method` **_mapGitLabStatus**(status) → 30 call(s)
- `method` **_waitForCompletion**(pollFn) → 30 call(s)
- `method` **_httpGet**(url, headers = {}) → 30 call(s)
- `function` **req**(lib.request(options, (res) → 30 call(s)
- `method` **_getCurrentBranch** → 30 call(s)
- `method` **getSummary**(result) → 30 call(s)

#### workflow/core/clarification-engine.js
- `function` **isMitigated**(mitigationPrefixes.some(p ) → 30 call(s)
- `function` **detectSignals**(text) → 29 call(s) // Fast, no LLM needed. Used as fallback when semantic mode is 
- `function` **buildSemanticDetectionPrompt**(text, stageLabel) → 29 call(s) // 3. Understands context: "default" in a config example ≠ unve
- `function` **buildSemanticVerificationPrompt**(text, stageLabel) → 29 call(s) // or glossed over. This breaks the self-validation loop.
- `function` **parseSemanticSignals**(response) → 29 call(s) // Falls back to empty array on parse error.
- `function` **buildRefinementPrompt**(originalContent, signals, stageLabel) → 29 call(s) // Builds a refinement prompt that instructs the Agent to fix d
- `class` **SelfCorrectionEngine** → 29 call(s)
- `method` **constructor**(llmCall, { maxRounds = 3, verbose = true) → 29 call(s)
- `method` **correct**(content, stageLabel = 'Review') → 29 call(s)
- `function` **currentSignalKey**(signals.map(s ) → 30 call(s)
- `function` **curTypes**(signals.map(s ) → 30 call(s)
- `function` **highSeverityRemaining**(remainingSignals.filter(s ) → 29 call(s)
- `method` **_deepInvestigate**(content, highSignals, stageLabel) → 29 call(s)
- `method` **_detectSignals**(text, stageLabel, { verificationMode = f) → 29 call(s)
- `method` **_log**(msg) → 29 call(s)
- `class` **ClarificationEngine** → 29 call(s) // Kept so existing callers don't break during migration.
- `method` **analyse**(proposalText, stageLabel = 'Review') → 29 call(s)
- `function` **formatClarificationReport**(result) → 29 call(s) // Formats self-correction results as a Markdown block for inje

#### workflow/core/code-review-agent.js
- `function` **buildReviewPrompt**(checklist, codeDiff, requirementText = ') → 39 call(s)
- `function` **buildFixPrompt**(originalDiff, failures) → 39 call(s)
