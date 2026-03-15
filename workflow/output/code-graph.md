## Code Graph (517 symbols, 13292 call edges)

> Generated: 2026-03-15
> Query: `/graph search <keyword>` | `/graph file <path>` | `/graph calls <symbol>`

### agents/analyst-agent.js
- `class` **AnalystAgent** → 6 call(s) // - MUST focus solely on clarifying WHAT the user wants, not H
- `method` **constructor**(llmCall, hookEmitter) → 5 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 5 call(s)
- `method` **parseResponse**(llmResponse) → 5 call(s)

### agents/architect-agent.js
- `class` **ArchitectAgent** → 6 call(s) // - MUST focus on system design: components, interfaces, data 
- `method` **constructor**(llmCall, hookEmitter) → 5 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 5 call(s)
- `method` **parseResponse**(llmResponse) → 5 call(s)

### agents/base-agent.js
- `class` **BaseAgent** → 10 call(s)
- `method` **run**(inputFilePath = null, rawInput = null, e) → 9 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 9 call(s)
- `method` **parseResponse**(llmResponse) → 9 call(s)
- `method` **assertAllowed**(action) → 9 call(s)
- `method` **_readInput**(inputFilePath, rawInput) → 9 call(s)
- `method` **_writeOutput**(content) → 9 call(s)

### agents/developer-agent.js
- `class` **DeveloperAgent** → 6 call(s) // - MUST strictly follow the architecture document
- `method` **constructor**(llmCall, hookEmitter) → 5 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 5 call(s)
- `method` **parseResponse**(llmResponse) → 5 call(s)

### agents/tester-agent.js
- `class` **TesterAgent** → 7 call(s)
- `method` **constructor**(llmCall, hookEmitter) → 6 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 6 call(s)
- `method` **parseResponse**(llmResponse) → 6 call(s)
- `function` **missingSections**(requiredSections.filter(s ) → 6 call(s) // Validates that the report contains required sections.

### commands/command-router.js
- `function` **registerCommand**(name, description, handler) → 31 call(s) // Registers a command handler.
- `function` **dispatch**(input, context = {}) → 31 call(s) // Parses and dispatches a slash command string.
- `function` **loadGraph** → 31 call(s)
- `function` **trendIcon**(t) → 31 call(s)

### core/architecture-review-agent.js
- `function` **buildArchReviewPrompt**(checklist, archContent, requirementText ) → 30 call(s) // Uses evaluationGuide to give LLM precise instructions per it
- `function` **buildArchFixPrompt**(originalContent, failures) → 30 call(s) // then merges them back. This avoids LLM output truncation on 
- `function` **applyArchPatches**(originalContent, patchResponse) → 30 call(s) // Finds each "### PATCH: <heading>" block and replaces or appe
- `function` **extractJsonArray**(response) → 30 call(s)
- `class` **ArchitectureReviewAgent** → 30 call(s)
- `method` **review**(archPath, requirementPath = null) → 30 call(s)
- `function` **failures**(reviewResults.filter(r ) → 30 call(s)
- `function` **passes**(reviewResults.filter(r ) → 30 call(s)
- `function` **nas**(reviewResults.filter(r ) → 30 call(s)
- `function` **highFailures**(failures.filter(f ) → 30 call(s)
- `function` **item**(this.checklist.find(c ) → 30 call(s)
- `function` **finalFailures**(lastReviewResults.filter(r ) → 31 call(s)
- `function` **finalMissing**(lastReviewResults.filter(r ) → 30 call(s)
- `function` **riskNotes**(allFailed.map(f ) → 30 call(s)
- `method` **_runReview**(archContent, requirementText) → 30 call(s)
- `function` **resultMap**(new Map(parsed.map(r ) → 30 call(s)
- `method` **formatReport**(result) → 30 call(s)
- `method` **_emptyResult**(skipReason) → 30 call(s)
- `method` **_log**(msg) → 30 call(s)

### core/ci-integration.js
- `class` **CIIntegration** → 23 call(s)
- `method` **_detectProvider** → 22 call(s)
- `method` **_detectRepoSlug** → 22 call(s)
- `method` **runLocalPipeline**({ skipLint = false, skipTest = false, sk) → 22 call(s)
- `function` **allPassed**(steps.every(s ) → 23 call(s)
- `method` **_runStep**(name, command) → 22 call(s)
- `method` **_buildResult**(status, steps, startedAt, message = null) → 22 call(s)
- `method` **pollGitHub**({ branch = null, workflowName = null, wa) → 22 call(s)
- `function` **poll** → 22 call(s)
- `method` **_mapGitHubStatus**(status, conclusion) → 22 call(s)
- `method` **pollGitLab**({ branch = null, wait = false } = {}) → 22 call(s)
- `method` **_mapGitLabStatus**(status) → 22 call(s)
- `method` **_waitForCompletion**(pollFn) → 22 call(s)
- `method` **_httpGet**(url, headers = {}) → 22 call(s)
- `function` **req**(lib.request(options, (res) → 22 call(s)
- `method` **_getCurrentBranch** → 22 call(s)
- `method` **getSummary**(result) → 22 call(s)

### core/clarification-engine.js
- `function` **detectSignals**(text) → 20 call(s) // Fast, no LLM needed. Used as fallback when semantic mode is 
- `function` **buildSemanticDetectionPrompt**(text, stageLabel) → 20 call(s) // 3. Understands context: "default" in a config example ≠ unve
- `function` **parseSemanticSignals**(response) → 20 call(s) // Falls back to empty array on parse error.
- `function` **buildRefinementPrompt**(originalContent, signals, stageLabel) → 20 call(s) // Builds a refinement prompt that instructs the Agent to fix d
- `class` **SelfCorrectionEngine** → 20 call(s)
- `method` **constructor**(llmCall, { maxRounds = 3, verbose = true) → 20 call(s)
- `method` **correct**(content, stageLabel = 'Review') → 20 call(s)
- `function` **highSeverityRemaining**(remainingSignals.filter(s ) → 20 call(s)
- `method` **_deepInvestigate**(content, highSignals, stageLabel) → 20 call(s)
- `method` **_detectSignals**(text, stageLabel) → 20 call(s)
- `method` **_log**(msg) → 20 call(s)
- `class` **ClarificationEngine** → 20 call(s) // Kept so existing callers don't break during migration.
- `method` **analyse**(proposalText, stageLabel = 'Review') → 20 call(s)
- `function` **formatClarificationReport**(result) → 20 call(s) // Formats self-correction results as a Markdown block for inje

### core/code-graph.js
- `class` **CodeGraph** → 32 call(s)
- `method` **build** → 31 call(s)
- `method` **search**(query, { kind = null, file = null, limit) → 31 call(s)
- `method` **getFileSymbols**(filePath) → 31 call(s)
- `method` **getCallGraph**(symbolName) → 31 call(s)
- `method` **toMarkdown**({ maxSymbols = 100 } = {}) → 31 call(s)
- `method` **_extractSymbols**(content, relPath, ext) → 31 call(s)
- `method` **_addSymbol**(kind, name, file, line, signature = '', ) → 31 call(s)
- `method` **_extractJsSymbols**(lines, file) → 31 call(s)
- `method` **_extractCsSymbols**(lines, file) → 31 call(s)
- `method` **_extractLuaSymbols**(lines, file) → 31 call(s)
- `method` **_extractGoSymbols**(lines, file) → 31 call(s)
- `method` **_extractPySymbols**(lines, file) → 31 call(s)
- `method` **_extractDartSymbols**(lines, file) → 31 call(s)
- `method` **_extractJsDocSummary**(lines, fnLine) → 31 call(s)
- `method` **_extractXmlDocSummary**(lines, fnLine) → 31 call(s)
- `method` **_extractLuaCommentSummary**(lines, fnLine) → 31 call(s)
- `method` **_extractGoDocSummary**(lines, fnLine) → 31 call(s)
- `method` **_extractPyDocSummary**(lines, fnLine) → 31 call(s)
- `method` **_extractImports**(content, relPath, ext) → 31 call(s)
- `method` **_extractCallEdges**(content, relPath, ext) → 31 call(s)
- `method` **_findByName**(name) → 31 call(s)
