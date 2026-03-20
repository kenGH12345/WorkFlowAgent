## Code Graph (1774 symbols, 116255 call edges)

> Generated: 2026-03-20
> Query: `/graph search <keyword>` | `/graph file <path>` | `/graph calls <symbol>` | `/graph hotspot [N]`

### 🔥 Hotspot Analysis (Top referenced symbols)

> Categories: 🔧 Utility(131) | 🏗️ Foundation(108) | 🔀 Hub(102) | 🚪 Entry(168) | 🍃 Leaf(1035) | 👻 Orphan(0)

- 🔧 **block**(active.find(b ) `[Utility]` ← 860 refs, → 43 calls | `workflow/core/token-budget.js`:113
- 🔧 **high**(open.filter(e ) `[Utility]` ← 826 refs, → 96 calls | `workflow/core/self-reflection-engine.js`:723
- 🔧 **existing**(registry.findIndex(e ) `[Utility]` ← 810 refs, → 34 calls | `workflow/core/experience-router.js`:127
- 🔧 **entry**(this._reflections.find(e ) `[Utility]` ← 765 refs, → 96 calls | `workflow/core/self-reflection-engine.js`:756 // Marks a reflection as fixed or deferred.
- 🔀 **Orchestrator** `[Hub]` ← 718 refs, → 184 calls | `workflow/index.js`:87
- 🔧 **issues**(results.filter(r ) `[Utility]` ← 628 refs, → 62 calls | `workflow/core/mcp-adapter-helpers.js`:97
- 🔀 **search**(query, { kind = null, file = null, limit) `[Hub]` ← 600 refs, → 178 calls | `workflow/core/code-graph.js`:540 // Search symbols by name or keyword (case-insensitiv
- 🔧 **missing**(deps.filter(d ) `[Utility]` ← 546 refs, → 24 calls | `workflow/commands/commands-doctor.js`:73
- 🔧 **blocks**(results.map(r ) `[Utility]` ← 520 refs, → 60 calls | `workflow/core/adapter-plugin-registry.js`:264
- 🔧 **ExperienceStore** `[Utility]` ← 476 refs, → 36 calls | `workflow/core/experience-store.js`:26
- 🔧 **generate** `[Utility]` ← 475 refs, → 33 calls | `workflow/core/test-case-generator.js`:41 // Generates test-cases.md from requirements + archit
- 🔧 **main** `[Utility]` ← 443 refs, → 18 calls | `workflow/gen-agents.js`:64
- 🔧 **correct**(content, stageLabel = 'Review') `[Utility]` ← 440 refs, → 68 calls | `workflow/core/clarification-engine.js`:504 // Runs the self-correction loop on an artifact.
- 🔧 **matches**(pat.dirPatterns.filter(d ) `[Utility]` ← 435 refs, → 70 calls | `workflow/core/project-profiler.js`:933
- 🔧 **relevant**(lines.filter(l ) `[Utility]` ← 401 refs, → 43 calls | `workflow/core/tester-context-builder.js`:117

### ♻️ Recommended for Reuse

> **When writing new code, prefer reusing these widely-used symbols over creating new ones.**

- **block** (860 refs) in `workflow/core/token-budget.js`:113
- **high** (826 refs) in `workflow/core/self-reflection-engine.js`:723
- **existing** (810 refs) in `workflow/core/experience-router.js`:127
- **entry** (765 refs) in `workflow/core/self-reflection-engine.js`:756 – Marks a reflection as fixed or deferred.
- **Orchestrator** (718 refs) in `workflow/index.js`:87
- **issues** (628 refs) in `workflow/core/mcp-adapter-helpers.js`:97
- **search** (600 refs) in `workflow/core/code-graph.js`:540 – Search symbols by name or keyword (case-insensitiv
- **missing** (546 refs) in `workflow/commands/commands-doctor.js`:73
- **blocks** (520 refs) in `workflow/core/adapter-plugin-registry.js`:264
- **ExperienceStore** (476 refs) in `workflow/core/experience-store.js`:26

### 📦 Module Summary (by directory)

| Module | Files | Classes | Functions | Description |
|--------|-------|---------|-----------|-------------|
| `workflow/core` | 89 | 56 | 1234 | Core business logic |
| `workflow/hooks/adapters` | 15 | 17 | 232 | Adapter/integration layer |
| `workflow/tests` | 4 | 1 | 65 | Test suites |
| `workflow/commands` | 8 | 0 | 43 | Command handlers |
| `workflow` | 5 | 1 | 41 | Applies a rule table to classify a file. |
| `workflow/agents` | 6 | 6 | 30 | Agents |
| `workflow/tools` | 2 | 0 | 18 | Tool implementations |
| `workflow/core/stages` | 5 | 5 | 10 | Stages |
| `workflow/hooks` | 1 | 1 | 7 | Hook adapters and extensions |
| `workflow/scripts` | 2 | 0 | 7 | Build and utility scripts |

### 📁 Symbol Index (by file)

#### workflow/agents/analyst-agent.js
- `function` **extractAnchorFiles**(text) → 39 call(s) // anchorNames  – just the base names (for display and search h
- `function` **anchorNames**(anchorFiles.map(f ) → 39 call(s)
- `class` **AnalystAgent** → 39 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 39 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 39 call(s) // Enforces strict role boundary: no technical details, no code
- `method` **parseResponse**(llmResponse) → 39 call(s) // Validates that no code blocks or technical keywords slipped 
- `function` **missingSections**(mandatorySections.filter(s ) → 39 call(s)

#### workflow/agents/architect-agent.js
- `class` **ArchitectAgent** → 36 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 36 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 36 call(s) // Input content is the full text of requirement.md.
- `method` **parseResponse**(llmResponse) → 36 call(s) // Warns if actual code implementations are detected.
- `function` **missingSections**(mandatorySections.filter(s ) → 36 call(s)

#### workflow/agents/base-agent.js
- `class` **BaseAgent** → 23 call(s)
- `method` **run**(inputFilePath = null, rawInput = null, e) → 23 call(s) // Pass null for the analyst (raw user input).
- `method` **buildPrompt**(inputContent, expContext = null) → 23 call(s) // Build the LLM prompt from the input content.
- `method` **parseResponse**(llmResponse) → 23 call(s) // Parse the raw LLM response into the content to write to the 
- `method` **assertAllowed**(action) → 23 call(s) // Emits AGENT_BOUNDARY_VIOLATION hook before throwing.
- `method` **_readInput**(inputFilePath, rawInput) → 23 call(s) // Enforces the file-reference protocol: always prefer file pat
- `method` **_writeOutput**(content) → 23 call(s) // Ensures the output directory exists.

#### workflow/agents/developer-agent.js
- `class` **DeveloperAgent** → 35 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 35 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 35 call(s) // Input content is the full text of architecture.md.
- `method` **parseResponse**(llmResponse) → 35 call(s) // Extracts the diff content from code blocks if wrapped.
- `function` **missingSections**(mandatorySections.filter(s ) → 35 call(s)

#### workflow/agents/planner-agent.js
- `class` **PlannerAgent** → 28 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 28 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 28 call(s) // Input content is the full text of architecture.md.
- `method` **parseResponse**(llmResponse) → 28 call(s) // Validates JSON block and checks for mandatory sections.
- `function` **missingSections**(mandatorySections.filter(s ) → 28 call(s)

#### workflow/agents/tester-agent.js
- `class` **TesterAgent** → 40 call(s)
- `method` **constructor**(llmCall, hookEmitter, opts = {}) → 40 call(s)
- `method` **buildPrompt**(inputContent, expContext = null) → 40 call(s) // Black-box approach: tester evaluates observable behaviour, n
- `method` **parseResponse**(llmResponse) → 40 call(s) // Validates that the report contains required sections.
- `function` **missingSections**(requiredSections.filter(s ) → 40 call(s)
- `function` **missingMandatory**(mandatorySections.filter(s ) → 40 call(s)
- `function` **coveredIds**(plannedIds.filter(id ) → 40 call(s)

#### workflow/commands/command-router.js
- `function` **registerCommand**(name, description, handler) → 20 call(s) // Registers a command handler.
- `function` **dispatch**(input, context = {}) → 20 call(s) // Parses and dispatches a slash command string.

#### workflow/commands/commands-agentflow.js
- `function` **registerAgentFlowCommands**(registerCommand) → 39 call(s) // Registers AgentFlow commands into the shared command registr
- `function` **sorted**(entries.sort((a, b) → 39 call(s)

#### workflow/commands/commands-analyze.js
- `function` **registerAnalyzeCommands**(registerCommand) → 28 call(s) // Registers analyze commands into the shared command registry.

#### workflow/commands/commands-devtools.js
- `function` **registerDevToolsCommands**(registerCommand) → 117 call(s) // Registers devtools commands into the shared command registry
- `function` **loadGraph** → 117 call(s)
- `function` **trendIcon**(t) → 117 call(s)
- `function` **bodyLines**(lines.filter(l ) → 117 call(s)
- `function` **concurrencyFlag**(flags.find(f ) → 117 call(s)
- `function` **skillNames**(targetSkills.map(s ) → 117 call(s)
- `function` **batchPromises**(batch.map(async (name) → 117 call(s)
- `function` **successCount**(results.filter(r ) → 117 call(s)
- `function` **failCount**(results.filter(r ) → 117 call(s)
- `function` **totalEntries**(results.reduce((sum, r) → 117 call(s)
- `function` **highValue**(result.evaluations.filter(e ) → 117 call(s)
- `function` **topPriority**(result.findings.filter(f ) → 117 call(s)
- `function` **others**(result.findings.filter(f ) → 117 call(s)
- `function` **log**(msg) → 117 call(s)
- `function` **step2Promise**(async () → 117 call(s)
- `function` **step3Promise**(async () → 117 call(s)
- `function` **auditStep**(report.steps.find(s ) → 117 call(s)
- `function` **staleStep**(report.steps.find(s ) → 117 call(s)
- `function` **scoutStep**(report.steps.find(s ) → 117 call(s)
- `function` **healthStep**(report.steps.find(s ) → 117 call(s)
- `function` **deployStep**(report.steps.find(s ) → 117 call(s)
- `function` **mapeStep**(report.steps.find(s ) → 117 call(s)

#### workflow/commands/commands-doctor.js
- `function` **registerDoctorCommands**(registerCommand) → 24 call(s) // Registers the /workflow-doctor command.
- `function` **check**(name, fn) → 24 call(s)
- `function` **missing**(deps.filter(d ) → 24 call(s)
- `function` **connected**(adapters.filter(a ) → 24 call(s)
- `function` **passed**(checks.filter(c ) → 24 call(s)
- `function` **warnings**(checks.filter(c ) → 24 call(s)
- `function` **errors**(checks.filter(c ) → 24 call(s)

#### workflow/commands/commands-marketplace.js
- `function` **registerMarketplaceCommands**(registerCommand, COMMANDS) → 17 call(s) // Registers marketplace commands into the shared command regis
- `function` **skillName**(parts.find(p ) → 17 call(s)
- `function` **sourcePath**(parts.find(p ) → 17 call(s)
- `function` **exportableCount**(skills.filter(s ) → 17 call(s)

#### workflow/commands/commands-server.js
- `function` **registerServerCommands**(registerCommand) → 9 call(s) // /serve --host 127.0.0.1     – Bind to specific host
- `function` **orchestratorFactory**(opts) → 9 call(s)

#### workflow/commands/commands-workflow.js
- `function` **registerWorkflowCommands**(registerCommand) → 37 call(s) // Registers workflow commands into the shared command registry
- `function` **taskDefs**(rawTasks.map((raw, i) → 37 call(s)
- `function` **taskSummary**(taskDefs.map((t, i) → 37 call(s)

#### workflow/core/adapter-plugin-registry.js
- `function` **validatePlugin**(plugin) → 60 call(s) // Validates a plugin manifest.
- `class` **AdapterPluginRegistry** → 60 call(s)
- `method` **constructor** → 60 call(s)
- `method` **register**(plugin) → 60 call(s) // Registers a context plugin.
- `method` **unregister**(name) → 60 call(s) // Unregisters a plugin by name.
- `method` **getPluginsForStage**(stage) → 60 call(s) // Returns all enabled plugins for a given stage, sorted by pri
- `method` **getPluginNames** → 60 call(s) // Returns all registered plugin names.
- `method` **get**(name) → 60 call(s) // Gets a plugin by name.
- `method` **collectPluginBlocks**(orch, stage, profile = null, startOrder ) → 60 call(s) // Plugins with `alwaysLoad: true` or no `keywords` array bypas
- `function` **promises**(plugins.map(async (plugin, idx) → 60 call(s)
- `function` **hasRelevantKeyword**(plugin.keywords.some(kw ) → 60 call(s)
- `function` **blocks**(results.map(r ) → 60 call(s)
- `function` **activeCount**(blocks.filter(b ) → 60 call(s)
- `function` **createBuiltinPlugins** → 60 call(s) // without requiring any changes to the adapter implementations
- `function` **formattedResults**(searchResult.results.map((r, i) → 60 call(s)

#### workflow/core/adapter-telemetry.js
- `class` **AdapterTelemetry** → 42 call(s)
- `method` **constructor** → 42 call(s)
- `method` **recordInjection**(label, stage, chars) → 42 call(s) // Records that a block was injected into the context.
- `method` **recordCompression**(label, stage, originalChars, compressedC) → 42 call(s) // Records that a block was compressed.
- `method` **recordTruncation**(label, stage, removedChars) → 42 call(s) // Records that a block was truncated by the token budget.
- `method` **recordDrop**(label, stage) → 42 call(s) // Records that a block was entirely dropped by the token budge
