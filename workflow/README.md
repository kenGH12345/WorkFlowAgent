# CODEX FORGE

An AI-driven automated software development workflow powered by multiple specialised agents.

## Architecture

```
INIT → ANALYSE → ARCHITECT → CODE → TEST → FINISHED
```

Each stage is handled by a dedicated agent with strict role boundaries. All inter-agent communication uses **file path references only** (never raw content).

```
workflow/
├── index.js                    # Orchestrator (main entry point)
├── package.json
├── core/
│   ├── types.js                # Type definitions, WorkflowState, AgentRole
│   ├── constants.js            # Global constants (paths, thresholds)
│   ├── state-machine.js        # Central state machine + manifest.json
│   ├── file-ref-bus.js         # File-reference communication protocol
│   ├── memory-manager.js       # AGENTS.md builder + file watcher
│   ├── socratic-engine.js      # Socratic decision engine
│   └── prompt-builder.js       # KV-cache optimised prompt builder
├── agents/
│   ├── base-agent.js           # Abstract base class (boundary enforcement)
│   ├── analyst-agent.js        # Requirement Analysis Agent
│   ├── architect-agent.js      # Architecture Design Agent
│   ├── developer-agent.js      # Code Development Agent
│   └── tester-agent.js         # Quality Testing Agent
├── tools/
│   ├── thin-tools.js           # ls/read adapters with token cost annotation
│   └── thick-tools.js          # Summarisation scripts + tool strategy selector
├── skills/
│   └── workflow-orchestration.md  # SOP for the full workflow
├── commands/
│   └── command-router.js       # Slash command dispatcher
├── hooks/
│   ├── hook-system.js          # Lifecycle event bus + human review prompt
│   └── mcp-adapter.js          # TAPD / DevTools MCP adapters
├── output/                     # All agent-produced artifacts land here
│   ├── requirement.md
│   ├── architecture.md
│   ├── code.diff
│   ├── test-report.md
│   └── communication-log.json
└── tests/
    └── e2e.test.js             # End-to-end test suite
```

## Quick Start

### 1. Install dependencies

```bash
cd workflow
npm install
```

### 2. Start a new workflow

```javascript
const { Orchestrator } = require('./index');

// Provide your LLM adapter
async function myLlmCall(prompt) {
  // Call your LLM API here (OpenAI, Claude, etc.)
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  return data.choices[0].message.content;
}

const orchestrator = new Orchestrator({
  projectId: 'my-project-001',
  llmCall: myLlmCall,
  projectRoot: '/path/to/your/project',
});

await orchestrator.run('Build a REST API for user management with CRUD operations');
```

### 3. Use slash commands

```javascript
const { dispatch } = require('./commands/command-router');

// Start workflow
await dispatch('/ask-workflow-agent Build a todo app', { orchestrator });

// Check status
const status = await dispatch('/workflow-status', {});
console.log(status);

// List artifacts
const artifacts = await dispatch('/workflow-artifacts', {});
console.log(artifacts);

// Reset workflow
await dispatch('/workflow-reset', {});
```

### 4. Run tests

```bash
cd workflow
npm test
```

## Key Concepts

### File-Reference Communication Protocol
Agents never pass raw content to each other. The orchestrator passes only **file paths**. Each agent reads its own input file, ensuring 100% information fidelity and zero token waste.

### Checkpoint Resume
Every state transition writes to `manifest.json`. If the workflow is interrupted, restart it with the same `projectId` and it will resume from the last completed stage.

### Socratic Decision Engine
At key decision points (e.g., architecture approval), the system presents structured multiple-choice questions instead of asking for free-form review. Answers are persisted to `output/decisions.json`.

### Thin vs Thick Tools
- **Thin tools** (`ls`, `read`): raw file operations, high token cost, use for small projects
- **Thick tools** (`getUnfinishedChanges`, `getProjectStructure`): summarised output, low token cost, auto-selected for large Monorepos (≥500 files)

### KV Cache Optimisation
All prompts are structured with a **fixed prefix** (system role + constraints) and a **dynamic suffix** (input content). The fixed prefix benefits from KV cache, reducing compute cost on repeated calls.

## Agent Role Boundaries

| Agent | Allowed | Forbidden |
|-------|---------|-----------|
| **AnalystAgent** | Write requirement.md | Write code, architecture, tests |
| **ArchitectAgent** | Write architecture.md | Write code, modify requirements |
| **DeveloperAgent** | Write code diff | Modify requirements, architecture, tests |
| **TesterAgent** | Write test report | Modify any source files |

## Workflow State Machine

```
INIT ──→ ANALYSE ──→ ARCHITECT ──→ CODE ──→ TEST ──→ FINISHED
  │          │            │           │        │
  └──────────┴────────────┴───────────┴────────┘
                    manifest.json (checkpoint)
```

## MCP Integration

Connect external systems by registering adapters:

```javascript
const { MCPRegistry, TAPDAdapter, DevToolsAdapter } = require('./hooks/mcp-adapter');

const registry = new MCPRegistry();
registry.register(new TAPDAdapter({ workspaceId: 'your-workspace', accessToken: 'token' }));
registry.register(new DevToolsAdapter({ ciApiBase: 'https://ci.example.com' }));
await registry.connectAll();
```

---

## 迁移到其他项目

工作流的核心逻辑与项目无关，可以直接复制 `workflow/` 目录到任意项目中使用。  
迁移后只需执行**一条命令**，工作流会自动完成所有配置。

### 迁移步骤

#### 第一步：复制 workflow 目录

将整个 `workflow/` 目录复制到目标项目根目录下：

```
目标项目/
├── workflow/          ← 复制过来的工作流目录
├── src/               ← 目标项目的源码
├── ...
```

#### 第二步：安装依赖

```bash
cd 目标项目/workflow
npm install
```

#### 第三步：一键初始化（全自动）

```bash
# 在目标项目根目录执行
node workflow/init-project.js
```

**就这一条命令，无需任何手动配置。**

---

### 初始化做了什么

`init-project.js` 会自动完成以下全部工作：

```
node workflow/init-project.js
        │
        ▼
  ① 检测 workflow.config.js 是否存在
        │
        ├─ 存在 → 直接加载
        │
        └─ 不存在 → 自动扫描项目特征文件，推断技术栈
                        │
                        ▼
                  生成 workflow.config.js（自动写入项目根目录）
        │
        ▼
  ② 验证配置结构（字段完整性检查）
        │
        ▼
  ③ 构建 AGENTS.md（扫描代码符号，生成全局项目上下文）
        │
        ▼
  ④ 生成经验库（从源文件提取初始经验条目）
        │
        ▼
  ⑤ 注册内置技能（workflow-orchestration、code-review 及技术栈专属技能）
        │
        ▼
  ✅ 完成，可以开始使用工作流
```

---

### 技术栈自动检测规则

`init-project.js` 通过扫描项目根目录的特征文件来推断技术栈，**按优先级从高到低**依次匹配：

| 优先级 | 技术栈 | 检测条件 | 扫描文件类型 |
|--------|--------|----------|-------------|
| 1 | Unity + C# + Lua | `Assets/` + `Packages/` + `.lua` 文件 | `.cs` `.lua` |
| 2 | Unity + C# | `Assets/` + `Packages/` | `.cs` |
| 3 | Go | `go.mod` 存在 或 根目录有 `.go` 文件 | `.go` |
| 4 | TypeScript / Node.js | `tsconfig.json` 存在 | `.ts` `.tsx` |
| 5 | JavaScript / Node.js | `package.json` 存在 | `.js` `.mjs` |
| 6 | Python | `requirements.txt` / `setup.py` / `pyproject.toml` | `.py` |
| 7 | Java | `pom.xml` / `build.gradle` | `.java` |
| 兜底 | 通用（Generic） | 统计文件扩展名分布，选最多的那种 | 最多的扩展名 |

> 匹配到技术栈后，自动生成对应的 `workflow.config.js`，包含合适的扫描参数、忽略目录和内置技能列表。

---

### 生成的 workflow.config.js 结构

自动生成的配置文件包含以下字段，可以在初始化后随时手动调整：

```javascript
// workflow.config.js（自动生成，可手动修改）
module.exports = {
  // 项目标识
  projectName: 'MyProject',
  techStack: 'Unity + GameFramework + Lua',

  // 源码扫描范围
  sourceExtensions: ['.cs', '.lua'],
  ignoreDirs: ['node_modules', '.git', 'Library', 'Temp', 'obj', 'Packages', '.vs', 'output'],

  // 内置技能列表（自动注册）
  builtinSkills: [
    { name: 'workflow-orchestration', description: '...', domains: ['workflow'] },
    { name: 'unity-csharp',           description: '...', domains: ['unity', 'csharp'] },
    { name: 'lua-scripting',          description: '...', domains: ['lua', 'game'] },
  ],

  // 文件扩展名 → 默认技能的映射
  defaultSkills: { '.cs': 'unity-csharp', '.lua': 'lua-scripting' },

  // 自定义分类规则（可选，留空则使用内置规则）
  classificationRules: [],
};
```

修改配置后，重新运行 `node workflow/init-project.js` 即可应用更改。

---

### 命令行参数

```bash
node workflow/init-project.js [options]
```

| 参数 | 简写 | 说明 | 默认值 |
|------|------|------|--------|
| `--path <dir>` | `-p` | 目标项目根目录 | 当前工作目录 |
| `--validate` | `-v` | 仅验证配置，不执行初始化 | — |
| `--dry-run` | — | 预览将要执行的操作，不写入任何文件 | — |
| `--help` | `-h` | 显示帮助信息 | — |

#### 常用示例

```bash
# 初始化当前目录的项目（最常用）
node workflow/init-project.js

# 初始化指定路径的项目（Windows）
node workflow/init-project.js --path D:\MyOtherProject

# 初始化指定路径的项目（macOS / Linux）
node workflow/init-project.js --path /Users/me/MyOtherProject

# 预览将要执行的操作（不写入任何文件）
node workflow/init-project.js --dry-run

# 仅验证 workflow.config.js 配置是否合法
node workflow/init-project.js --validate

# 通过 npm script 调用
cd workflow && npm run init
```

---

### 自定义配置（可选）

如果自动检测的结果不符合预期，可以手动编辑 `workflow.config.js`，然后重新运行初始化：

#### 场景 1：添加自定义分类规则

```javascript
classificationRules: [
  {
    ext: '.cs',
    test: (filePath, content) => content.includes('IGameModule'),
    result: { category: 'game_module', skill: 'unity-csharp', tags: ['module', 'framework'] },
  },
  {
    ext: '.lua',
    test: (filePath, content) => filePath.includes('/UI/') || content.includes('UIBase'),
    result: { category: 'ui_logic', skill: 'lua-scripting', tags: ['ui', 'view'] },
  },
],
```

#### 场景 2：多语言混合项目

```javascript
sourceExtensions: ['.cs', '.lua', '.ts'],
defaultSkills: {
  '.cs':  'unity-csharp',
  '.lua': 'lua-scripting',
  '.ts':  'typescript-dev',
},
```

#### 场景 3：添加项目专属技能

```javascript
builtinSkills: [
  { name: 'workflow-orchestration', description: 'Multi-agent workflow SOP', domains: ['workflow'] },
  { name: 'code-review',            description: 'Code review best practices', domains: ['quality'] },
  // 项目专属技能
  { name: 'my-framework',           description: 'MyFramework patterns and conventions', domains: ['framework', 'backend'] },
],
```

---

### 单独更新 AGENTS.md

如果只需要更新项目上下文（不重新初始化），可以单独运行 `gen-agents.js`：

```bash
# 更新当前项目的 AGENTS.md
node workflow/gen-agents.js

# 更新指定项目的 AGENTS.md
node workflow/gen-agents.js --path D:\OtherProject

# 指定扫描的文件类型
node workflow/gen-agents.js --path D:\OtherProject --ext .js,.ts
```

| 参数 | 简写 | 说明 | 默认值 |
|------|------|------|--------|
| `--path <dir>` | `-p` | 目标项目根目录 | 当前工作目录 |
| `--ext <exts>` | `-e` | 扫描的文件扩展名（逗号分隔） | all supported |
| `--max-files <n>` | `-m` | 每种扩展名最多扫描文件数 | `80` |
| `--help` | `-h` | 显示帮助信息 | — |

> `AGENTS.md` 每次运行都是**完全覆盖**，始终保持最新。

---

### 常见问题

**Q：迁移后需要修改工作流的任何代码吗？**  
A：不需要。工作流核心代码与项目完全解耦，所有项目相关配置都在 `workflow.config.js` 中。

**Q：workflow.config.js 应该提交到 Git 吗？**  
A：建议提交。它记录了项目的技术栈配置，团队成员 clone 后直接运行 `node workflow/init-project.js` 即可完成初始化。

**Q：自动检测的技术栈不对怎么办？**  
A：直接编辑生成的 `workflow.config.js`，修改 `sourceExtensions`、`builtinSkills` 等字段，然后重新运行 `node workflow/init-project.js`。

**Q：重复运行 init 会覆盖已有数据吗？**  
A：`AGENTS.md` 会被覆盖更新（始终保持最新）；经验库和技能库是**增量更新**，不会丢失已有数据。

**Q：支持哪些文件类型的代码扫描？**  
A：理论上支持任意文本文件扩展名，通过 `sourceExtensions` 配置即可。常用组合：
- Unity C# 项目：`['.cs']`
- KartRider Lua 项目：`['.lua']`
- 全栈 TypeScript 项目：`['.ts', '.tsx']`
- 混合项目：`['.cs', '.lua', '.ts']`
