<div align="center">

# 🤖 WorkFlowAgent

**A production-grade AI Agent Runtime (Harness) for automated software development**

**面向自动化软件开发的生产级 AI Agent 运行时系统（Harness）**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-62%20passed-brightgreen)](https://github.com/kenGH12345/WorkFlowAgent)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kenGH12345/WorkFlowAgent/pulls)

**[English](#english-version)** · **[中文](#chinese-version)**

</div>

---

<a name="english-version"></a>

## 🇬🇧 English

### What is WorkFlowAgent?

WorkFlowAgent is a **portable, LLM-agnostic, production-grade AI Agent Runtime** — commonly called a **Harness** — that transforms a single natural-language requirement into production-ready code through a structured pipeline of specialised AI agents.

> *"An Agent's capability comes from the model, but an Agent's stability comes from the Harness."*

Unlike simple Agent Loops (`while not finished: think → act`), WorkFlowAgent implements a **complete 5-layer Harness architecture** — Environment, Tool, Control, Memory, and Evaluation — ensuring that multi-step AI workflows remain stable, observable, and self-correcting over long-running tasks.

```
                              ┌─────────────────────────────────────────┐
                              │         WorkFlowAgent Harness           │
                              │                                         │
  User Requirement ──────────▶│  ┌─────────┐  ┌───────────┐            │
                              │  │ Analyst  │─▶│ Architect │            │
                              │  │ (Cockburn│  │ (Fowler)  │            │
                              │  └─────────┘  └─────┬─────┘            │
                              │                      │                  │
                              │               ┌──────▼──────┐          │
                              │               │  Developer  │          │
                              │               │ (Kent Beck) │          │
                              │               └──────┬──────┘          │
                              │                      │                  │
                              │               ┌──────▼──────┐          │──────▶ Production Code
                              │               │   Tester    │          │        + Test Report
                              │               │  (Bolton)   │          │        + Architecture Doc
                              │               └─────────────┘          │
                              │                                         │
                              │  ┌─────────────────────────────────┐   │
                              │  │ Control │ Memory │ Evaluation   │   │
                              │  │ Rollback│ Exp.   │ SelfCorrect  │   │
                              │  │ QGate   │ Skill  │ QualityGate  │   │
                              │  └─────────────────────────────────┘   │
                              └─────────────────────────────────────────┘
```

---

### 🏗️ 5-Layer Harness Architecture

WorkFlowAgent implements a complete **Harness Engineering** architecture with five layers:

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Layer</th><th>Purpose</th><th>Key Modules</th></tr>
  <tr><td>🌍 <b>Environment</b></td><td>Provides a controlled execution world for AI</td><td><code>DryRunSandbox</code> (virtual FS with preview→confirm→apply), <code>CIIntegration</code> (syntax/lint/entropy)</td></tr>
  <tr><td>🔧 <b>Tool</b></td><td>Gives AI the ability to act</td><td><code>thin-tools</code> (ls/read, ≤1 param each), <code>thick-tools</code> (project structure/code symbols), <code>MCPAdapter</code></td></tr>
  <tr><td>🎛️ <b>Control</b></td><td>Keeps the system under control</td><td><code>RollbackCoordinator</code> (subtask-level rollback), <code>QualityGate</code> (4-way decisions), oscillation detection, timeout management</td></tr>
  <tr><td>🧠 <b>Memory</b></td><td>Manages long-term state &amp; knowledge</td><td><code>StateMachine</code> (atomic checkpoints), <code>ExperienceStore</code> (hit-count tracking), <code>StageContextStore</code> (cross-stage propagation), <code>SkillEvolution</code></td></tr>
  <tr><td>✅ <b>Evaluation</b></td><td>Automatically validates output quality</td><td><code>SelfCorrectionEngine</code> (3-round + deep investigation), adversarial review (Schneier/Taleb personas), <code>CIIntegration</code></td></tr>
</table>

```
┌────────────────────────────────────────────────────────────────────┐
│                        Agent Runtime (Harness)                     │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Environment   │  │    Tool      │  │       Control            │ │
│  │ • Sandbox     │  │ • thin-tools │  │ • RollbackCoordinator    │ │
│  │ • CIInteg.   │  │ • thick-tools│  │ • QualityGate            │ │
│  │ • FileRefBus  │  │ • MCPAdapter │  │ • Oscillation Detection  │ │
│  └──────────────┘  └──────────────┘  │ • Timeout / MaxRetries   │ │
│                                       │ • AgentContract Boundary │ │
│  ┌──────────────┐  ┌──────────────┐  └──────────────────────────┘ │
│  │   Memory      │  │  Evaluation  │                               │
│  │ • StateMachine│  │ • SelfCorrect│  ┌──────────────────────────┐ │
│  │ • Experience  │  │ • Adversarial│  │   Observability           │ │
│  │ • StageCtx    │  │ • QualityGate│  │ • Cross-session trends   │ │
│  │ • SkillEvol.  │  │ • CI Pipeline│  │ • Adaptive strategy      │ │
│  └──────────────┘  └──────────────┘  │ • Auto parameter tuning  │ │
│                                       └──────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  LLM calls (any provider)
                              ▼
                    ┌──────────────────┐
                    │  LLM (any model) │
                    │  OpenAI / Claude │
                    │  Gemini / Ollama │
                    └──────────────────┘
```

---

### ✨ Core Features

#### 🔄 Multi-Agent Pipeline

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Stage</th><th>Agent</th><th>Expert Persona</th><th>Output</th></tr>
  <tr><td><b>ANALYSE</b></td><td>AnalystAgent</td><td>Alistair Cockburn</td><td><code>requirement.md</code></td></tr>
  <tr><td><b>ARCHITECT</b></td><td>ArchitectAgent</td><td>Martin Fowler</td><td><code>architecture.md</code></td></tr>
  <tr><td><b>CODE</b></td><td>DeveloperAgent</td><td>Kent Beck</td><td>Code files + <code>code.diff</code></td></tr>
  <tr><td><b>TEST</b></td><td>TesterAgent</td><td>Michael Bolton</td><td><code>test-report.md</code></td></tr>
</table>

Each agent operates within **strict role boundaries** enforced by `AgentContract` — an agent cannot perform actions outside its scope.

#### 🛡️ Self-Correction Engine (3-Layer Verification)

```
Layer 1: SelfCorrectionEngine
  ├── Up to 3 rounds of semantic signal detection + refinement
  ├── Oscillation detection (80% signal-type overlap → early termination)
  └── Deep investigation (search + readSource + queryExperience)

Layer 2: Adversarial Review
  ├── Architecture: Grady Booch (lead) + Fred Brooks (adversarial)
  ├── Code: Uncle Bob (lead) + Bruce Schneier (adversarial)
  └── Quality: Deming (lead) + Nassim Taleb (adversarial)

Layer 3: QualityGate (4-way decision)
  ├── ✅ PASS → proceed to next stage
  ├── ⏪ ROLLBACK → fine-grained subtask-level retry
  ├── 👤 HUMAN_REVIEW → escalate to human
  └── ⚡ AUTO_PASS → skip when adaptive strategy allows
```

#### 🧠 4-Tier Memory Architecture

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Tier</th><th>Scope</th><th>Module</th><th>Purpose</th></tr>
  <tr><td><b>Short-term</b></td><td>Single LLM call</td><td>Agent Prompt Context</td><td>~4K tokens per call</td></tr>
  <tr><td><b>Cross-stage</b></td><td>Within one run</td><td><code>StageContextStore</code></td><td>≤600 chars/stage, crash-recoverable</td></tr>
  <tr><td><b>Checkpoint</b></td><td>Run lifetime</td><td><code>StateMachine</code> → <code>manifest.json</code></td><td>Atomic write (<code>.tmp</code> → <code>rename</code>), auto-resume</td></tr>
  <tr><td><b>Long-term</b></td><td>Across sessions</td><td><code>ExperienceStore</code> + <code>SkillEvolution</code></td><td>Hit-count tracking, adaptive evolution thresholds</td></tr>
</table>

#### 📊 Self-Adaptive Observability

The system **automatically tunes its own parameters** based on cross-session history:

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Rule</th><th>Signal</th><th>Adaptation</th></tr>
  <tr><td>Rule 1</td><td>Test failure rate ≥ 60%</td><td>Increase <code>maxFixRounds</code> (up to 5)</td></tr>
  <tr><td>Rule 2</td><td>Error trend increasing</td><td>Increase <code>maxReviewRounds</code> (up to 4)</td></tr>
  <tr><td>Rule 3</td><td>3 consecutive clean sessions</td><td>Skip entropy scan (with periodic forced scan every 5th session)</td></tr>
  <tr><td>Rule 4</td><td>Experience hit rate &lt; 20%</td><td>Reduce <code>maxExpInjected</code> to cut prompt noise</td></tr>
  <tr><td>Rule 5</td><td>Clarification effectiveness &lt; 30%</td><td>Reduce <code>maxClarificationRounds</code></td></tr>
  <tr><td>Rule 6</td><td>High-complexity tasks failing more</td><td>Raise fix/review rounds for complex tasks</td></tr>
</table>

#### 🎯 Fine-Grained Rollback

Unlike traditional "restart from scratch" approaches, `RollbackCoordinator` analyses failure context:

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Failure Type</th><th>Condition</th><th>Strategy</th></tr>
  <tr><td><b>Systemic</b></td><td>Timeout, OOM, rate limit</td><td>Full-stage rollback</td></tr>
  <tr><td><b>Local</b></td><td>Single subtask failure</td><td>Retry only the failed subtask, reuse cached results (valid for 10 min)</td></tr>
</table>

**Subtask Mapping:**

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Stage</th><th>Subtasks</th></tr>
  <tr><td><code>ARCHITECT</code></td><td>CoverageCheck + ArchReview</td></tr>
  <tr><td><code>CODE</code></td><td>CodeGeneration + CodeReview</td></tr>
  <tr><td><code>TEST</code></td><td>TestCaseGen + TestExecution + TestReportReview</td></tr>
</table>

#### 📋 Full Feature List

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Feature</th><th>Description</th></tr>
  <tr><td>🧩 <b>Multi-Agent Pipeline</b></td><td>Analyst → Architect → Developer → Tester with strict role boundaries</td></tr>
  <tr><td>📁 <b>File-Reference Protocol</b></td><td>Agents communicate via file paths — zero raw-content token waste</td></tr>
  <tr><td>♻️ <b>Checkpoint Resume</b></td><td>Atomic persistence to <code>manifest.json</code>; interrupted runs resume automatically</td></tr>
  <tr><td>🔍 <b>Socratic Decision Engine</b></td><td>Structured multiple-choice checkpoints replace free-form review prompts</td></tr>
  <tr><td>🧠 <b>KV-Cache Optimised Prompts</b></td><td>Fixed prefix + dynamic suffix maximises LLM cache hit rate</td></tr>
  <tr><td>📦 <b>Thin / Thick Tools</b></td><td>Auto-selects summarised tools for large monorepos (≥500 files)</td></tr>
  <tr><td>🌿 <b>Git PR Automation</b></td><td>Auto-creates feature branches, commits artifacts, and opens GitHub PRs</td></tr>
  <tr><td>🏖️ <b>Dry-Run / Sandbox</b></td><td>Preview all file changes in virtual FS before applying to real filesystem</td></tr>
  <tr><td>🔌 <b>MCP Integration</b></td><td>Plug in TAPD, CI systems, or any external tool via the MCP adapter layer</td></tr>
  <tr><td>🚀 <b>One-Command Init</b></td><td>Auto-detects tech stack and bootstraps the full workflow in one command</td></tr>
  <tr><td>📚 <b>Experience Store</b></td><td>Accumulates project-specific knowledge with hit-count tracking</td></tr>
  <tr><td>🎯 <b>Skill Evolution</b></td><td>Domain skills auto-evolve from high-frequency experiences (with dedup)</td></tr>
  <tr><td>🔁 <b>Self-Correction</b></td><td>3-round correction + oscillation detection + deep investigation</td></tr>
  <tr><td>⚖️ <b>Quality Gate</b></td><td>4-way decision engine (pass / rollback / human review / auto pass)</td></tr>
  <tr><td>📊 <b>Adaptive Strategy</b></td><td>Cross-session metrics drive automatic parameter tuning (6 rules)</td></tr>
  <tr><td>🔄 <b>Fine-Grained Rollback</b></td><td>Subtask-level retry with cached result reuse</td></tr>
  <tr><td>🧭 <b>Goal-Aware Execution</b></td><td>Global objective injected into every task prompt to prevent drift</td></tr>
  <tr><td>📈 <b>Code Graph</b></td><td>AST-based symbol index with call graph for intelligent code navigation</td></tr>
  <tr><td>🔬 <b>Entropy GC</b></td><td>Detects code bloat, circular dependencies, and architecture violations</td></tr>
  <tr><td>💬 <b>Complaint Wall</b></td><td>Error correction feedback loop for experience/skill refinement</td></tr>
  <tr><td>🌍 <b>Requirement Clarifier</b></td><td>Multi-round interactive clarification before analysis begins</td></tr>
  <tr><td>✅ <b>Coverage Checker</b></td><td>Traces requirement → architecture → code → test traceability</td></tr>
  <tr><td>🏗️ <b>Extensible Stage Registry</b></td><td>Add custom stages (e.g. SECURITY_AUDIT) without modifying core code</td></tr>
  <tr><td>🔀 <b>LLM Router</b></td><td>Route different tasks to different models (e.g. analysis→Claude, code→GPT-4)</td></tr>
</table>

---

### 🆚 Comparison with Similar Frameworks

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th></th><th>WorkFlowAgent</th><th>AutoGen</th><th>CrewAI</th><th>Devin / SWE-agent</th><th>Cursor / Copilot</th></tr>
  <tr><td><b>Primary focus</b></td><td>Production-grade software dev Harness</td><td>General multi-agent conversations</td><td>Role-based task crews</td><td>Autonomous coding agent</td><td>IDE code completion</td></tr>
  <tr><td><b>Agent roles</b></td><td>Fixed pipeline with expert personas</td><td>Flexible, user-defined</td><td>Flexible, user-defined</td><td>Single agent loop</td><td>Single assistant</td></tr>
  <tr><td><b>Communication</b></td><td>File-reference protocol (zero token waste)</td><td>In-memory message passing</td><td>In-memory message passing</td><td>Tool calls + scratchpad</td><td>Context window</td></tr>
  <tr><td><b>Self-correction</b></td><td>✅ 3-layer (SelfCorrection + Adversarial + QualityGate)</td><td>❌</td><td>❌</td><td>❌ Basic retry</td><td>❌</td></tr>
  <tr><td><b>Rollback</b></td><td>✅ Subtask-level with cache reuse</td><td>❌</td><td>❌</td><td>❌</td><td>N/A</td></tr>
  <tr><td><b>Adaptive tuning</b></td><td>✅ 6-rule cross-session auto-tuning</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td></tr>
  <tr><td><b>Checkpoint / resume</b></td><td>✅ Atomic <code>manifest.json</code> per stage</td><td>❌</td><td>❌</td><td>❌</td><td>N/A</td></tr>
  <tr><td><b>Experience learning</b></td><td>✅ Per-project + skill evolution</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td></tr>
  <tr><td><b>Token efficiency</b></td><td>✅ KV-cache + thin/thick tools + file-ref</td><td>❌ Full history</td><td>❌ Full history</td><td>❌ Long scratchpad</td><td>✅ IDE trimming</td></tr>
  <tr><td><b>LLM agnostic</b></td><td>✅ Bring your own <code>llmCall</code></td><td>✅</td><td>✅</td><td>❌ Proprietary</td><td>❌ Proprietary</td></tr>
  <tr><td><b>Observability</b></td><td>✅ Structured metrics + trend analysis</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td></tr>
  <tr><td><b>Portability</b></td><td>✅ Copy one folder anywhere</td><td>❌ Framework dep.</td><td>❌ Framework dep.</td><td>❌ Cloud service</td><td>❌ IDE plugin</td></tr>
</table>

---

### 🚀 Quick Start

**Prerequisites:**

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Dependency</th><th>Version</th><th>Required</th></tr>
  <tr><td>Node.js</td><td>≥ 16.0.0</td><td>✅ Yes</td></tr>
  <tr><td>Git</td><td>any</td><td>✅ Yes</td></tr>
  <tr><td><a href="https://cli.github.com">GitHub CLI</a> <code>gh</code></td><td>any</td><td>⭕ Optional (for PR automation)</td></tr>
</table>

```bash
# 1. Clone & install
git clone https://github.com/kenGH12345/WorkFlowAgent.git
cd WorkFlowAgent/workflow && npm install

# 2. Initialise for your project (auto-detects tech stack)
node workflow/init-project.js
```

```javascript
// 3. Run a workflow
const { Orchestrator } = require('./workflow');

const orchestrator = new Orchestrator({
  projectId: 'my-project-001',
  llmCall: async (prompt) => {
    // Plug in any LLM: OpenAI, Claude, Gemini, Ollama…
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    return (await res.json()).choices[0].message.content;
  },
  projectRoot: '/path/to/your/project',
  git: { enabled: true, autoPush: true },
  dryRun: false,
});

await orchestrator.run('Build a REST API for user management with CRUD operations');
```

---

### 📦 Migrate to Another Project

```bash
# 1. Copy the workflow folder
cp -r WorkFlowAgent/workflow /path/to/your-project/

# 2. Install dependencies
cd /path/to/your-project/workflow && npm install

# 3. One-command init (auto-detects tech stack)
node workflow/init-project.js
```

---

### 📁 Project Structure

```
WorkFlowAgent/
├── workflow/                          # The portable Harness engine
│   ├── index.js                       # Orchestrator (main entry point)
│   ├── init-project.js                # One-command project initialiser
│   ├── package.json
│   ├── workflow.config.js             # Project-specific configuration
│   │
│   ├── agents/                        # Specialist agents (strict boundaries)
│   │   ├── base-agent.js              #   Abstract base (AgentContract enforcement)
│   │   ├── analyst-agent.js           #   Requirement Analysis (Cockburn)
│   │   ├── architect-agent.js         #   Architecture Design (Fowler)
│   │   ├── developer-agent.js         #   Code Development (Kent Beck)
│   │   └── tester-agent.js            #   Quality Testing (Bolton)
│   │
│   ├── core/                          # Core Harness services
│   │   ├── state-machine.js           #   State management + atomic checkpoint
│   │   ├── rollback-coordinator.js    #   Fine-grained subtask-level rollback
│   │   ├── quality-gate.js            #   4-way stage pass/fail/rollback/human gate
│   │   ├── clarification-engine.js    #   SelfCorrectionEngine (3-round + oscillation)
│   │   ├── observability.js           #   Cross-session metrics + adaptive strategy
│   │   ├── experience-store.js        #   Persistent experience with hit-count tracking
│   │   ├── skill-evolution.js         #   Auto skill evolution from experience
│   │   ├── stage-context-store.js     #   Cross-stage context propagation
│   │   ├── prompt-builder.js          #   KV-cache optimised prompt assembly
│   │   ├── context-loader.js          #   Skill/ADR injection (≤2800 tokens budget)
│   │   ├── requirement-clarifier.js   #   Multi-round requirement clarification
│   │   ├── coverage-checker.js        #   Requirement → code traceability
│   │   ├── code-review-agent.js       #   Code review (Uncle Bob + Schneier)
│   │   ├── architecture-review-agent.js  # Arch review (Booch + Brooks)
│   │   ├── code-graph.js              #   AST-based symbol index + call graph
│   │   ├── entropy-gc.js              #   Code bloat / circular dep scanner
│   │   ├── ci-integration.js          #   Syntax check + lint + entropy scan
│   │   ├── git-integration.js         #   Branch / commit / PR automation
│   │   ├── sandbox.js                 #   Dry-run virtual filesystem
│   │   ├── file-ref-bus.js            #   File-reference communication protocol
│   │   ├── socratic-engine.js         #   Structured decision engine
│   │   ├── complaint-wall.js          #   Error correction feedback loop
│   │   ├── memory-manager.js          #   AGENTS.md builder + file watcher
│   │   ├── task-manager.js            #   Task decomposition + dependency DAG
│   │   ├── service-container.js       #   Dependency injection container
│   │   ├── stage-runner.js            #   Extensible stage registration
│   │   ├── llm-router.js             #   Multi-model routing
│   │   └── stages/                    #   Individual stage implementations
│   │
│   ├── tools/                         # Tool layer
│   │   ├── thin-tools.js              #   ls/read with token cost annotation
│   │   └── thick-tools.js             #   Summarised tools for large repos
│   │
│   ├── hooks/                         # Lifecycle hooks
│   │   ├── hook-system.js             #   Event bus + human review prompt
│   │   └── mcp-adapter.js            #   TAPD / DevTools MCP adapters
│   │
│   ├── skills/                        # Auto-evolving domain skills
│   ├── commands/                      # Slash command dispatcher
│   ├── docs/                          # Architecture constraints & decision log
│   ├── tests/                         # Unit (42) + E2E (20) test suite
│   └── output/                        # All artifacts + metrics + experience
│
├── AGENTS.md                          # AI agent entry point index
└── README.md
```

---

### ⚙️ Configuration

`workflow.config.js` is auto-generated by `init-project.js`. Key options:

```javascript
module.exports = {
  projectName: 'MyProject',
  techStack: 'TypeScript / Node.js',
  sourceExtensions: ['.ts', '.tsx'],
  ignoreDirs: ['node_modules', '.git', 'dist'],
  git: {
    enabled: true,
    baseBranch: 'main',
    autoPush: true,
    draft: false,
    labels: ['ai-generated'],
  },
  sandbox: { dryRun: false },
  autoFixLoop: {
    maxFixRounds: 2,       // Adaptive: auto-tuned by Observability
    maxReviewRounds: 2,    // Adaptive: auto-tuned by Observability
    maxExpInjected: 5,     // Adaptive: auto-tuned by hit rate
  },
};
```

---

### 🧪 Running Tests

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Command</th><th>Description</th></tr>
  <tr><td><code>npm test</code></td><td>Run all tests (42 unit + 20 E2E)</td></tr>
  <tr><td><code>npm run test:unit</code></td><td>Unit tests only</td></tr>
  <tr><td><code>npm run test:e2e</code></td><td>E2E tests only</td></tr>
  <tr><td><code>npm run lint</code></td><td>Syntax check</td></tr>
</table>

```bash
cd workflow
npm test
```

---

### 🤝 Contributing

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>Step</th><th>Action</th></tr>
  <tr><td>1</td><td>Fork the repository</td></tr>
  <tr><td>2</td><td>Create your feature branch: <code>git checkout -b feat/amazing-feature</code></td></tr>
  <tr><td>3</td><td>Commit your changes: <code>git commit -m 'feat: add amazing feature'</code></td></tr>
  <tr><td>4</td><td>Push and open a Pull Request</td></tr>
</table>

---

---

<a name="chinese-version"></a>

## 🇨🇳 中文文档

### 项目简介

WorkFlowAgent 是一个**可移植、与 LLM 无关的生产级 AI Agent 运行时系统**（通常称为 **Harness**），通过结构化的专业 AI 智能体流水线，将一句自然语言需求转化为可直接投入生产的代码。

> *"Agent 的能力来自模型，但 Agent 的稳定性来自 Harness。"*

与简单的 Agent 循环（`while not finished: think → act`）不同，WorkFlowAgent 实现了完整的 **5 层 Harness 架构** — 环境层、工具层、控制层、记忆层和评估层 — 确保多步骤 AI 工作流在长时间运行中保持稳定、可观测且能够自我修正。

```
                              ┌─────────────────────────────────────────┐
                              │       WorkFlowAgent Harness 运行时      │
                              │                                         │
  用户需求 ─────────────────▶│  ┌─────────┐  ┌───────────┐            │
                              │  │  分析师  │─▶│  架构师   │            │
                              │  │(Cockburn)│  │ (Fowler)  │            │
                              │  └─────────┘  └─────┬─────┘            │
                              │                      │                  │
                              │               ┌──────▼──────┐          │
                              │               │   开发者    │          │
                              │               │ (Kent Beck) │          │
                              │               └──────┬──────┘          │
                              │                      │                  │
                              │               ┌──────▼──────┐          │──────▶ 生产代码
                              │               │   测试员    │          │        + 测试报告
                              │               │  (Bolton)   │          │        + 架构文档
                              │               └─────────────┘          │
                              │                                         │
                              │  ┌─────────────────────────────────┐   │
                              │  │ 控制层  │ 记忆层  │ 评估层     │   │
                              │  │ 回滚    │ 经验    │ 自纠正     │   │
                              │  │ 质量门  │ 技能    │ 质量门控   │   │
                              │  └─────────────────────────────────┘   │
                              └─────────────────────────────────────────┘
```

---

### 🏗️ 五层 Harness 架构

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>层级</th><th>职责</th><th>核心模块</th></tr>
  <tr><td>🌍 <b>环境层 (Environment)</b></td><td>为 AI 提供可操作的受控世界</td><td><code>DryRunSandbox</code>（虚拟文件系统，支持预览→确认→应用）、<code>CIIntegration</code>（语法/Lint/熵扫描）</td></tr>
  <tr><td>🔧 <b>工具层 (Tool)</b></td><td>赋予 AI 行动能力</td><td><code>thin-tools</code>（ls/read，每个仅 1 个参数）、<code>thick-tools</code>（项目结构/代码符号索引）、<code>MCPAdapter</code></td></tr>
  <tr><td>🎛️ <b>控制层 (Control)</b></td><td>保持系统在可控范围内运行</td><td><code>RollbackCoordinator</code>（子任务级回滚）、<code>QualityGate</code>（四路决策）、振荡检测、超时管理</td></tr>
  <tr><td>🧠 <b>记忆层 (Memory)</b></td><td>管理长期状态与知识</td><td><code>StateMachine</code>（原子检查点）、<code>ExperienceStore</code>（命中率追踪）、<code>StageContextStore</code>（跨阶段传播）、<code>SkillEvolution</code></td></tr>
  <tr><td>✅ <b>评估层 (Evaluation)</b></td><td>自动验证输出质量</td><td><code>SelfCorrectionEngine</code>（3轮+深度调查）、对抗性评审（Schneier/Taleb）、<code>CIIntegration</code></td></tr>
</table>
```
┌────────────────────────────────────────────────────────────────────┐
│                    Agent 运行时系统 (Harness)                      │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │   环境层      │  │   工具层      │  │       控制层              │ │
│  │ • 沙箱        │  │ • 精简工具    │  │ • 回滚协调器             │ │
│  │ • CI 集成     │  │ • 厚工具      │  │ • 质量门控               │ │
│  │ • 文件引用总线 │  │ • MCP 适配器  │  │ • 振荡检测               │ │
│  └──────────────┘  └──────────────┘  │ • 超时/最大重试           │ │
│                                       │ • Agent 边界强制          │ │
│  ┌──────────────┐  ┌──────────────┐  └──────────────────────────┘ │
│  │   记忆层      │  │   评估层      │                               │
│  │ • 状态机      │  │ • 自纠正引擎  │  ┌──────────────────────────┐ │
│  │ • 经验库      │  │ • 对抗性评审  │  │      可观测性             │ │
│  │ • 阶段上下文  │  │ • 质量门控    │  │ • 跨会话趋势分析         │ │
│  │ • 技能进化    │  │ • CI 流水线   │  │ • 自适应策略             │ │
│  └──────────────┘  └──────────────┘  │ • 自动参数调优            │ │
│                                       └──────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  LLM 调用（任意供应商）
                              ▼
                    ┌──────────────────┐
                    │  LLM（任意模型）  │
                    │  OpenAI / Claude │
                    │  Gemini / Ollama │
                    └──────────────────┘
```

---

### ✨ 核心特性

#### 🔄 多智能体流水线

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>阶段</th><th>智能体</th><th>专家人格</th><th>输出</th></tr>
  <tr><td><b>分析 (ANALYSE)</b></td><td>AnalystAgent</td><td>Alistair Cockburn（用例方法论之父）</td><td><code>requirement.md</code></td></tr>
  <tr><td><b>架构 (ARCHITECT)</b></td><td>ArchitectAgent</td><td>Martin Fowler（ThoughtWorks 首席科学家）</td><td><code>architecture.md</code></td></tr>
  <tr><td><b>编码 (CODE)</b></td><td>DeveloperAgent</td><td>Kent Beck（TDD 之父）</td><td>代码文件 + <code>code.diff</code></td></tr>
  <tr><td><b>测试 (TEST)</b></td><td>TesterAgent</td><td>Michael Bolton（探索性测试专家）</td><td><code>test-report.md</code></td></tr>
</table>

每个智能体在 `AgentContract` 强制执行的**严格角色边界**内运行 — 智能体不能执行其职责范围之外的操作。

#### 🛡️ 自纠正引擎（三层验证体系）

```
第1层: SelfCorrectionEngine
  ├── 最多 3 轮语义信号检测 + 精炼修正
  ├── 振荡检测（80% 信号类型重叠 → 提前终止）
  └── 深度调查（search + readSource + queryExperience）

第2层: 对抗性评审
  ├── 架构评审: Grady Booch（主评审）+ Fred Brooks（对抗性评审）
  ├── 代码评审: Uncle Bob（主评审）+ Bruce Schneier（对抗性评审）
  └── 质量分析: Deming（主分析）+ Nassim Taleb（对抗性检查）

第3层: QualityGate（四路决策）
  ├── ✅ 通过 → 进入下一阶段
  ├── ⏪ 回滚 → 细粒度子任务级重试
  ├── 👤 人工评审 → 升级到人工处理
  └── ⚡ 自动通过 → 自适应策略允许时跳过
```

#### 🧠 四层记忆架构

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>层级</th><th>范围</th><th>模块</th><th>用途</th></tr>
  <tr><td><b>短期</b></td><td>单次 LLM 调用</td><td>Agent Prompt 上下文</td><td>每次调用约 4K tokens</td></tr>
  <tr><td><b>跨阶段</b></td><td>单次运行</td><td><code>StageContextStore</code></td><td>每阶段 ≤600 字符，支持崩溃恢复</td></tr>
  <tr><td><b>检查点</b></td><td>运行生命周期</td><td><code>StateMachine</code> → <code>manifest.json</code></td><td>原子写入（<code>.tmp</code> → <code>rename</code>），自动恢复</td></tr>
  <tr><td><b>长期</b></td><td>跨会话</td><td><code>ExperienceStore</code> + <code>SkillEvolution</code></td><td>命中率追踪，自适应进化阈值</td></tr>
</table>

#### 📊 自适应可观测性

系统**基于跨会话历史数据自动调优参数**：

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>规则</th><th>信号</th><th>自适应调整</th></tr>
  <tr><td>规则 1</td><td>测试失败率 ≥ 60%</td><td>增加 <code>maxFixRounds</code>（最高 5）</td></tr>
  <tr><td>规则 2</td><td>错误趋势上升</td><td>增加 <code>maxReviewRounds</code>（最高 4）</td></tr>
  <tr><td>规则 3</td><td>连续 3 次会话 0 违规</td><td>跳过熵扫描（每 5 次会话强制扫描一次）</td></tr>
  <tr><td>规则 4</td><td>经验命中率 &lt; 20%</td><td>减少 <code>maxExpInjected</code> 以降低 prompt 噪声</td></tr>
  <tr><td>规则 5</td><td>澄清有效性 &lt; 30%</td><td>减少 <code>maxClarificationRounds</code></td></tr>
  <tr><td>规则 6</td><td>高复杂度任务失败率偏高</td><td>为复杂任务提升修复/评审轮数</td></tr>
</table>
#### 🎯 细粒度回滚

与传统的 "从头重来" 不同，`RollbackCoordinator` 会分析失败上下文：

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>故障类型</th><th>触发条件</th><th>回滚策略</th></tr>
  <tr><td><b>系统性故障</b></td><td>超时、OOM、限流</td><td>全阶段回滚</td></tr>
  <tr><td><b>局部故障</b></td><td>单个子任务失败</td><td>仅重试失败的子任务，复用缓存结果（10分钟有效期）</td></tr>
</table>

**子任务映射：**

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>阶段</th><th>子任务</th></tr>
  <tr><td><code>ARCHITECT</code></td><td>覆盖率检查 + 架构评审</td></tr>
  <tr><td><code>CODE</code></td><td>代码生成 + 代码评审</td></tr>
  <tr><td><code>TEST</code></td><td>用例生成 + 用例执行 + 报告评审</td></tr>
</table>

#### 📋 完整特性列表

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>特性</th><th>说明</th></tr>
  <tr><td>🧩 <b>多智能体流水线</b></td><td>分析师 → 架构师 → 开发者 → 测试员，各角色边界严格隔离</td></tr>
  <tr><td>📁 <b>文件引用协议</b></td><td>智能体间仅传递文件路径，彻底消除原始内容的 Token 浪费</td></tr>
  <tr><td>♻️ <b>断点续跑</b></td><td>每次状态转换原子持久化到 <code>manifest.json</code>，中断后自动恢复</td></tr>
  <tr><td>🔍 <b>苏格拉底决策引擎</b></td><td>结构化多选检查点替代自由格式审查提示</td></tr>
  <tr><td>🧠 <b>KV 缓存优化提示词</b></td><td>固定前缀 + 动态后缀结构，最大化 LLM 缓存命中率</td></tr>
  <tr><td>📦 <b>精简/完整工具自适应</b></td><td>大型 Monorepo（≥500 文件）自动切换摘要工具</td></tr>
  <tr><td>🌿 <b>Git PR 自动化</b></td><td>自动创建功能分支、提交产物并发起 GitHub PR</td></tr>
  <tr><td>🏖️ <b>沙箱/预演模式</b></td><td>在虚拟文件系统中预览所有变更再写入真实文件</td></tr>
  <tr><td>🔌 <b>MCP 集成</b></td><td>通过 MCP 适配层接入 TAPD、CI 系统或任意外部工具</td></tr>
  <tr><td>🚀 <b>一键初始化</b></td><td>自动检测技术栈，一条命令完成全套配置</td></tr>
  <tr><td>📚 <b>经验积累库</b></td><td>跨会话积累项目专属知识，带命中率追踪</td></tr>
  <tr><td>🎯 <b>技能进化</b></td><td>高频经验自动升级为领域技能（含去重机制）</td></tr>
  <tr><td>🔁 <b>自纠正引擎</b></td><td>3 轮修正 + 振荡检测 + 深度调查</td></tr>
  <tr><td>⚖️ <b>质量门控</b></td><td>四路决策引擎（通过/回滚/人工评审/自动通过）</td></tr>
  <tr><td>📊 <b>自适应策略</b></td><td>跨会话指标驱动自动参数调优（6 条规则）</td></tr>
  <tr><td>🔄 <b>细粒度回滚</b></td><td>子任务级重试，复用缓存结果</td></tr>
  <tr><td>🧭 <b>目标感知执行</b></td><td>全局目标注入每个任务 prompt，防止任务漂移</td></tr>
  <tr><td>📈 <b>代码图谱</b></td><td>基于 AST 的符号索引 + 调用图，智能代码导航</td></tr>
  <tr><td>🔬 <b>熵扫描 (Entropy GC)</b></td><td>检测代码膨胀、循环依赖和架构违规</td></tr>
  <tr><td>💬 <b>投诉墙</b></td><td>错误纠正反馈回路，用于经验/技能优化</td></tr>
  <tr><td>🌍 <b>需求澄清器</b></td><td>分析前进行多轮交互式需求澄清</td></tr>
  <tr><td>✅ <b>覆盖率检查</b></td><td>追溯 需求→架构→代码→测试 完整链路</td></tr>
  <tr><td>🏗️ <b>可扩展阶段注册</b></td><td>无需修改核心代码即可添加自定义阶段（如安全审计）</td></tr>
  <tr><td>🔀 <b>LLM 路由器</b></td><td>不同任务路由到不同模型（如分析→Claude，编码→GPT-4）</td></tr>
</table>
---

### 🆚 与同类框架对比

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th></th><th>WorkFlowAgent</th><th>AutoGen</th><th>CrewAI</th><th>Devin / SWE-agent</th><th>Cursor / Copilot</th></tr>
  <tr><td><b>核心定位</b></td><td>生产级软件开发 Harness</td><td>通用多智能体对话</td><td>角色制任务团队</td><td>自主编程 Agent</td><td>IDE 代码补全</td></tr>
  <tr><td><b>智能体角色</b></td><td>固定流水线 + 专家人格</td><td>灵活自定义</td><td>灵活自定义</td><td>单 Agent 循环</td><td>单助手</td></tr>
  <tr><td><b>通信方式</b></td><td>文件引用协议（零 Token 浪费）</td><td>内存消息传递</td><td>内存消息传递</td><td>工具调用+草稿本</td><td>上下文窗口</td></tr>
  <tr><td><b>自纠正</b></td><td>✅ 三层（自纠正+对抗评审+质量门控）</td><td>❌</td><td>❌</td><td>❌ 基本重试</td><td>❌</td></tr>
  <tr><td><b>回滚</b></td><td>✅ 子任务级 + 缓存复用</td><td>❌</td><td>❌</td><td>❌</td><td>N/A</td></tr>
  <tr><td><b>自适应调优</b></td><td>✅ 6 规则跨会话自动调优</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td></tr>
  <tr><td><b>断点续跑</b></td><td>✅ 原子 <code>manifest.json</code></td><td>❌</td><td>❌</td><td>❌</td><td>N/A</td></tr>
  <tr><td><b>经验学习</b></td><td>✅ 项目级 + 技能进化</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td></tr>
  <tr><td><b>Token 效率</b></td><td>✅ KV缓存 + 精简工具 + 文件引用</td><td>❌ 完整历史</td><td>❌ 完整历史</td><td>❌ 超长草稿本</td><td>✅ IDE 裁剪</td></tr>
  <tr><td><b>LLM 无关</b></td><td>✅ 自带 <code>llmCall</code> 接口</td><td>✅</td><td>✅</td><td>❌ 专有</td><td>❌ 专有</td></tr>
  <tr><td><b>可观测性</b></td><td>✅ 结构化指标 + 趋势分析</td><td>❌</td><td>❌</td><td>❌</td><td>❌</td></tr>
  <tr><td><b>可移植性</b></td><td>✅ 复制一个文件夹即可</td><td>❌ 框架依赖</td><td>❌ 框架依赖</td><td>❌ 云服务</td><td>❌ IDE 插件</td></tr>
</table>

---

### 🚀 快速开始

**前置条件：**

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>依赖项</th><th>版本要求</th><th>是否必需</th></tr>
  <tr><td>Node.js</td><td>≥ 16.0.0</td><td>✅ 必需</td></tr>
  <tr><td>Git</td><td>任意</td><td>✅ 必需</td></tr>
  <tr><td><a href="https://cli.github.com">GitHub CLI</a> <code>gh</code></td><td>任意</td><td>⭕ 可选（用于 PR 自动化）</td></tr>
</table>

```bash
# 1. 克隆并安装依赖
git clone https://github.com/kenGH12345/WorkFlowAgent.git
cd WorkFlowAgent/workflow && npm install

# 2. 初始化到你的项目（自动检测技术栈）
node workflow/init-project.js
```

```javascript
// 3. 运行工作流
const { Orchestrator } = require('./workflow');

const orchestrator = new Orchestrator({
  projectId: 'my-project-001',
  llmCall: async (prompt) => {
    // 接入任意 LLM：OpenAI、Claude、Gemini、本地 Ollama…
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    return (await res.json()).choices[0].message.content;
  },
  projectRoot: '/path/to/your/project',
  git: { enabled: true, autoPush: true },  // 可选：自动发起 PR
  dryRun: false,                            // 设为 true 可预览变更
});

await orchestrator.run('为用户管理构建一个包含 CRUD 操作的 REST API');
```

---

### ⚙️ 配置说明

`workflow.config.js` 由 `init-project.js` 自动生成，可按需定制：

```javascript
module.exports = {
  projectName: 'MyProject',
  techStack: 'TypeScript / Node.js',
  sourceExtensions: ['.ts', '.tsx'],
  ignoreDirs: ['node_modules', '.git', 'dist'],
  git: {
    enabled: true,
    baseBranch: 'main',
    autoPush: true,
    draft: false,
    labels: ['ai-generated'],
  },
  sandbox: { dryRun: false },
  autoFixLoop: {
    maxFixRounds: 2,       // 自适应：由 Observability 自动调优
    maxReviewRounds: 2,    // 自适应：由 Observability 自动调优
    maxExpInjected: 5,     // 自适应：基于命中率自动调优
  },
};
```

---

### 🧪 运行测试

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>命令</th><th>说明</th></tr>
  <tr><td><code>npm test</code></td><td>运行全部测试（42 单元 + 20 端到端）</td></tr>
  <tr><td><code>npm run test:unit</code></td><td>仅单元测试</td></tr>
  <tr><td><code>npm run test:e2e</code></td><td>仅端到端测试</td></tr>
  <tr><td><code>npm run lint</code></td><td>语法检查</td></tr>
</table>

```bash
cd workflow
npm test
```

---

### 📦 迁移到其他项目

```bash
# 1. 复制 workflow 文件夹
cp -r WorkFlowAgent/workflow /path/to/your-project/

# 2. 安装依赖
cd /path/to/your-project/workflow && npm install

# 3. 一键初始化（自动检测技术栈）
node workflow/init-project.js
```

---

### 🤝 参与贡献

欢迎提交 Pull Request！重大变更请先开 Issue 讨论。

<table border="1" cellpadding="8" cellspacing="0">
  <tr><th>步骤</th><th>操作</th></tr>
  <tr><td>1</td><td>Fork 本仓库</td></tr>
  <tr><td>2</td><td>创建功能分支：<code>git checkout -b feat/amazing-feature</code></td></tr>
  <tr><td>3</td><td>提交变更：<code>git commit -m 'feat: add amazing feature'</code></td></tr>
  <tr><td>4</td><td>推送并发起 Pull Request</td></tr>
</table>

---

## 📄 License

[MIT](LICENSE) © 2026 WorkFlowAgent Contributors
