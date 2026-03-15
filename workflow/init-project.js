#!/usr/bin/env node
/**
 * init-project.js – One-command project initialisation for the workflow
 *
 * Usage (from any project root):
 *   node workflow/init-project.js
 *   node workflow/init-project.js --path D:\MyProject
 *   node workflow/init-project.js --validate
 *
 * What it does (fully automatic):
 *  1. Detects workflow.config.js; if missing, auto-scans the project to infer
 *     the tech stack and generates the config file automatically
 *  2. Validates the config structure
 *  3. Builds AGENTS.md (global project context)
 *  4. Generates initial experience store from source files
 *  5. Registers all built-in skills
 *  6. Prints a summary of what was imported
 *
 * No manual steps required – just run once and the workflow is ready.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getConfig, getConfigPath, clearConfigCache } = require('./core/config-loader');
const { MemoryManager } = require('./core/memory-manager');
const { SkillEvolutionEngine } = require('./core/skill-evolution');

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { path: null, validate: false, help: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':     case '-h': args.help     = true; break;
      case '--validate': case '-v': args.validate = true; break;
      case '--dry-run':             args.dryRun   = true; break;
      case '--path':     case '-p': args.path = argv[++i]; break;
    }
  }
  return args;
}

// ─── Tech Stack Detection ─────────────────────────────────────────────────────

/**
 * Known tech stack profiles.
 * Each profile: { id, name, techStack, extensions, ignoreDirs, skills, defaultSkills }
 * Matched by detecting characteristic files/dirs in the project root.
 */
const TECH_PROFILES = [
  {
    id: 'flutter',
    name: 'Flutter / Dart',
    techStack: 'Flutter + Dart',
    detect: (root) => {
      return fs.existsSync(path.join(root, 'pubspec.yaml'))
        && _countFilesWithExt(root, '.dart', ['lib', 'test']) > 0;
    },
    extensions: ['.dart'],
    ignoreDirs: ['node_modules', '.git', '.dart_tool', 'build', '.flutter-plugins', 'output'],
    testCommand: 'flutter test',
    platforms: (root) => _detectFlutterPlatforms(root),
    namingConvention: 'PascalCase for classes/widgets, camelCase for functions/variables, snake_case for files',
    stateManagement: (root) => _detectFlutterStateManagement(root),
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'flutter-dev',            description: 'Flutter/Dart development patterns', domains: ['flutter', 'dart', 'mobile'] },
    ],
    defaultSkills: { '.dart': 'flutter-dev' },
  },
  {
    id: 'unity-csharp-lua',
    name: 'Unity + C# + Lua',
    techStack: 'Unity + GameFramework + Lua',
    detect: (root) => {
      const hasAssets   = fs.existsSync(path.join(root, 'Assets'));
      const hasPackages = fs.existsSync(path.join(root, 'Packages'));
      const hasLua      = _countFilesWithExt(root, '.lua', ['Assets', 'Scripts', 'Lua']) > 0;
      return hasAssets && hasPackages && hasLua;
    },
    extensions: ['.cs', '.lua'],
    ignoreDirs: ['node_modules', '.git', 'Library', 'Temp', 'obj', 'Packages', '.vs', 'output'],
    testCommand: null,  // Unity tests run inside the Editor; set to 'dotnet test' if using NUnit CLI
    platforms: () => 'PC, Mobile (Unity Editor)',
    namingConvention: 'PascalCase for C# classes/methods, camelCase for Lua functions, UPPER_SNAKE_CASE for constants',
    stateManagement: () => 'Unity GameFramework FSM (Procedure/State pattern)',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'unity-csharp',           description: 'Unity C# development patterns and pitfalls', domains: ['unity', 'csharp', 'game'] },
      { name: 'lua-scripting',          description: 'Lua scripting patterns for game engines', domains: ['lua', 'game', 'scripting'] },
    ],
    defaultSkills: { '.cs': 'unity-csharp', '.lua': 'lua-scripting' },
  },
  {
    id: 'unity-csharp',
    name: 'Unity + C#',
    techStack: 'Unity + C#',
    detect: (root) => {
      return fs.existsSync(path.join(root, 'Assets')) && fs.existsSync(path.join(root, 'Packages'));
    },
    extensions: ['.cs'],
    ignoreDirs: ['node_modules', '.git', 'Library', 'Temp', 'obj', 'Packages', '.vs', 'output'],
    testCommand: null,  // Unity tests run inside the Editor; set to 'dotnet test' if using NUnit CLI
    platforms: () => 'PC, Mobile (Unity Editor)',
    namingConvention: 'PascalCase for classes/methods, camelCase for fields/variables',
    stateManagement: () => 'Unity MonoBehaviour / GameFramework FSM',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'unity-csharp',           description: 'Unity C# development patterns and pitfalls', domains: ['unity', 'csharp', 'game'] },
    ],
    defaultSkills: { '.cs': 'unity-csharp' },
  },
  {
    id: 'go',
    name: 'Go',
    techStack: 'Go',
    detect: (root) => {
      return fs.existsSync(path.join(root, 'go.mod')) || _countFilesWithExt(root, '.go', ['.']) > 0;
    },
    extensions: ['.go'],
    ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'vendor'],
    testCommand: 'go test ./...',
    platforms: () => 'Server / CLI',
    namingConvention: 'PascalCase for exported, camelCase for unexported, snake_case for files',
    stateManagement: () => 'Stateless services; use context.Context for request-scoped state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'go-dev',                 description: 'Go language development patterns', domains: ['backend', 'go'] },
    ],
    defaultSkills: { '.go': 'go-dev' },
  },
  {
    id: 'typescript',
    name: 'TypeScript / Node.js',
    techStack: 'TypeScript + Node.js',
    detect: (root) => {
      return fs.existsSync(path.join(root, 'tsconfig.json'));
    },
    extensions: ['.ts', '.tsx'],
    ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],
    testCommand: 'npm test',
    platforms: (root) => _detectNodePlatform(root),
    namingConvention: 'PascalCase for classes/interfaces, camelCase for functions/variables, kebab-case for files',
    stateManagement: (root) => _detectJsStateManagement(root),
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'typescript-dev',         description: 'TypeScript development patterns', domains: ['frontend', 'backend', 'typescript'] },
    ],
    defaultSkills: { '.ts': 'typescript-dev', '.tsx': 'typescript-dev' },
  },
  {
    id: 'javascript',
    name: 'JavaScript / Node.js',
    techStack: 'JavaScript + Node.js',
    detect: (root) => {
      return fs.existsSync(path.join(root, 'package.json'));
    },
    extensions: ['.js', '.mjs'],
    ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],
    testCommand: 'npm test',
    platforms: (root) => _detectNodePlatform(root),
    namingConvention: 'camelCase for functions/variables, PascalCase for classes, kebab-case for files',
    stateManagement: (root) => _detectJsStateManagement(root),
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'javascript-dev',         description: 'JavaScript development patterns', domains: ['frontend', 'backend', 'javascript'] },
    ],
    defaultSkills: { '.js': 'javascript-dev' },
  },
  {
    id: 'python',
    name: 'Python',
    techStack: 'Python',
    detect: (root) => {
      return fs.existsSync(path.join(root, 'requirements.txt'))
        || fs.existsSync(path.join(root, 'setup.py'))
        || fs.existsSync(path.join(root, 'pyproject.toml'));
    },
    extensions: ['.py'],
    ignoreDirs: ['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'],
    testCommand: 'pytest',
    platforms: () => 'Server / CLI',
    namingConvention: 'snake_case for functions/variables/files, PascalCase for classes, UPPER_SNAKE_CASE for constants',
    stateManagement: () => 'Stateless functions preferred; use dataclasses/Pydantic for structured state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'python-dev',             description: 'Python development patterns', domains: ['backend', 'python'] },
    ],
    defaultSkills: { '.py': 'python-dev' },
  },
  {
    id: 'java',
    name: 'Java',
    techStack: 'Java',
    detect: (root) => {
      return fs.existsSync(path.join(root, 'pom.xml'))
        || fs.existsSync(path.join(root, 'build.gradle'));
    },
    extensions: ['.java'],
    ignoreDirs: ['node_modules', '.git', 'target', 'build', '.gradle'],
    testCommand: fs.existsSync('pom.xml') ? 'mvn test' : 'gradle test',
    platforms: () => 'Server / JVM',
    namingConvention: 'PascalCase for classes, camelCase for methods/variables, UPPER_SNAKE_CASE for constants',
    stateManagement: () => 'Spring beans (singleton); use immutable DTOs for data transfer',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'java-dev',               description: 'Java development patterns', domains: ['backend', 'java'] },
    ],
    defaultSkills: { '.java': 'java-dev' },
  },
  {
    id: 'rust',
    name: 'Rust',
    techStack: 'Rust',
    detect: (root) => {
      return fs.existsSync(path.join(root, 'Cargo.toml'));
    },
    extensions: ['.rs'],
    ignoreDirs: ['node_modules', '.git', 'target'],
    testCommand: 'cargo test',
    platforms: () => 'Server / CLI / Systems',
    namingConvention: 'snake_case for functions/variables/files, PascalCase for types/traits, SCREAMING_SNAKE_CASE for constants',
    stateManagement: () => 'Ownership model; use Arc<Mutex<T>> for shared mutable state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'rust-dev',               description: 'Rust development patterns', domains: ['systems', 'rust'] },
    ],
    defaultSkills: { '.rs': 'rust-dev' },
  },
  {
    id: 'dotnet',
    name: '.NET / C#',
    techStack: '.NET + C#',
    detect: (root) => {
      return _countFilesWithExt(root, '.csproj', ['.', 'src']) > 0
        || _countFilesWithExt(root, '.sln', ['.']) > 0;
    },
    extensions: ['.cs'],
    ignoreDirs: ['node_modules', '.git', 'bin', 'obj', '.vs'],
    testCommand: 'dotnet test',
    platforms: () => 'Server / Desktop / Web',
    namingConvention: 'PascalCase for classes/methods/properties, camelCase for local variables, _camelCase for private fields',
    stateManagement: () => 'Dependency injection (IServiceCollection); use immutable records for DTOs',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'dotnet-dev',             description: '.NET/C# development patterns', domains: ['backend', 'dotnet', 'csharp'] },
    ],
    defaultSkills: { '.cs': 'dotnet-dev' },
  },
];

// ─── Project Auto-Detection Helpers ─────────────────────────────────────────

/**
 * Detects Flutter target platforms from pubspec.yaml and platform directories.
 */
function _detectFlutterPlatforms(root) {
  const platformDirs = {
    android: 'Android',
    ios: 'iOS',
    web: 'Web',
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
  };
  const found = [];
  for (const [dir, label] of Object.entries(platformDirs)) {
    if (fs.existsSync(path.join(root, dir))) found.push(label);
  }
  return found.length > 0 ? found.join(', ') : 'iOS, Android';
}

/**
 * Detects Flutter state management library from pubspec.yaml dependencies.
 */
function _detectFlutterStateManagement(root) {
  const pubspecPath = path.join(root, 'pubspec.yaml');
  if (!fs.existsSync(pubspecPath)) return 'StatefulWidget (default)';
  try {
    const content = fs.readFileSync(pubspecPath, 'utf-8');
    if (content.includes('riverpod'))   return 'Riverpod';
    if (content.includes('bloc'))       return 'BLoC / flutter_bloc';
    if (content.includes('provider'))   return 'Provider';
    if (content.includes('get:') || content.includes('getx')) return 'GetX';
    if (content.includes('mobx'))       return 'MobX';
    if (content.includes('redux'))      return 'Redux';
  } catch (_) {}
  return 'StatefulWidget (default)';
}

/**
 * Detects Node.js deployment platform from package.json.
 */
function _detectNodePlatform(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'Node.js';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['react-native'] || deps['expo']) return 'iOS, Android (React Native)';
    if (deps['electron'])                     return 'Desktop (Electron)';
    if (deps['next'] || deps['nuxt'])         return 'Web (SSR)';
    if (deps['react'] || deps['vue'] || deps['svelte']) return 'Web (SPA)';
    if (deps['express'] || deps['fastify'] || deps['koa']) return 'Server (Node.js)';
  } catch (_) {}
  return 'Node.js';
}

/**
 * Detects JS/TS state management library from package.json.
 */
function _detectJsStateManagement(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'Module-level state';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['zustand'])  return 'Zustand';
    if (deps['redux'] || deps['@reduxjs/toolkit']) return 'Redux Toolkit';
    if (deps['mobx'])     return 'MobX';
    if (deps['jotai'])    return 'Jotai';
    if (deps['recoil'])   return 'Recoil';
    if (deps['pinia'])    return 'Pinia (Vue)';
    if (deps['vuex'])     return 'Vuex';
    if (deps['react'])    return 'React useState / useContext';
  } catch (_) {}
  return 'Module-level state';
}

/**
 * Generates a compact directory tree (depth ≤ 2) for the project root.
 * Skips ignored dirs and hidden dirs.
 */
function _generateDirectoryTree(root, ignoreDirs) {
  const ignore = new Set([...(ignoreDirs || []), 'node_modules', '.git', '.dart_tool',
    'Library', 'Temp', 'obj', 'Packages', '.vs', 'build', 'dist', 'output',
    '__pycache__', '.venv', 'venv', 'target', 'bin']);

  const lines = [`${path.basename(root)}/`];

  function walk(dir, prefix, depth) {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }

    // Dirs first, then files; skip hidden and ignored
    const dirs  = entries.filter(e => e.isDirectory() && !ignore.has(e.name) && !e.name.startsWith('.'));
    const files = entries.filter(e => !e.isDirectory() && !e.name.startsWith('.'));
    const all   = [...dirs, ...files].slice(0, 20); // cap at 20 per level

    all.forEach((e, i) => {
      const isLast    = i === all.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPfx  = isLast ? '    ' : '│   ';
      const label     = e.isDirectory() ? `${e.name}/` : e.name;
      lines.push(`${prefix}${connector}${label}`);
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + childPfx, depth + 1);
    });

    if (entries.length > 20) lines.push(`${prefix}    ... (${entries.length - 20} more)`);
  }

  walk(root, '', 1);
  return lines.join('\n');
}

/**
 * Counts files with a given extension in specific subdirs (shallow check, fast).
 */
function _countFilesWithExt(root, ext, subdirs) {
  let count = 0;
  for (const sub of subdirs) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      count += entries.filter(e => e.endsWith(ext)).length;
    } catch (_) {}
  }
  return count;
}

/**
 * Auto-detects the project tech stack by scanning characteristic files/dirs.
 * Returns the best matching TECH_PROFILE, or null if nothing matches.
 *
 * @param {string} projectRoot
 * @returns {{ profile: object, projectName: string }}
 */
function detectTechStack(projectRoot) {
  const projectName = path.basename(projectRoot);

  for (const profile of TECH_PROFILES) {
    try {
      if (profile.detect(projectRoot)) {
        return { profile, projectName };
      }
    } catch (_) {}
  }

  // Fallback: count file extensions to pick the most common one
  const extCounts = {};
  const knownExts = ['.cs', '.lua', '.go', '.ts', '.js', '.py', '.java', '.cpp', '.rs'];
  const ignoreFallback = ['node_modules', '.git', 'Library', 'Temp', 'Packages'];

  function walkCount(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (ignoreFallback.includes(e.name) || e.name.startsWith('.')) continue;
      if (e.isDirectory()) { walkCount(path.join(dir, e.name), depth + 1); }
      else {
        const ext = path.extname(e.name).toLowerCase();
        if (knownExts.includes(ext)) extCounts[ext] = (extCounts[ext] || 0) + 1;
      }
    }
  }
  walkCount(projectRoot, 0);

  const topExt = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0];
  if (topExt) {
    return {
      profile: {
        id: 'generic',
        name: `Generic (${topExt[0]})`,
        techStack: topExt[0].replace('.', '').toUpperCase(),
        extensions: [topExt[0]],
        ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],
        skills: [
          { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow'] },
          { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality'] },
        ],
        defaultSkills: {},
      },
      projectName,
    };
  }

  return { profile: null, projectName };
}

/**
 * Generates a workflow.config.js file from a detected tech profile.
 *
 * @param {string} projectRoot
 * @param {object} profile  - Matched TECH_PROFILE
 * @param {string} projectName
 * @returns {string} Path of the written config file
 */
function generateConfigFromProfile(projectRoot, profile, projectName) {
  const skillsJson = JSON.stringify(profile.skills, null, 4)
    .replace(/"name"/g, 'name')
    .replace(/"description"/g, 'description')
    .replace(/"domains"/g, 'domains');

  const defaultSkillsJson = JSON.stringify(profile.defaultSkills, null, 4);

  const extList = profile.extensions.map(e => `'${e}'`).join(', ');
  const ignoreDirsList = profile.ignoreDirs.map(d => `'${d}'`).join(', ');

  // Resolve testCommand: use profile value, or null for unknown stacks
  const testCmd = profile.testCommand !== undefined ? profile.testCommand : null;
  const testCommandLine = testCmd
    ? `testCommand: '${testCmd}',`
    : `testCommand: null,  // TODO: set your test command (e.g. 'npm test', 'flutter test', 'pytest')`;

  const content = `/**
 * workflow.config.js – Project Workflow Configuration
 *
 * Auto-generated by: node workflow/init-project.js
 * Detected tech stack: ${profile.name}
 * Generated at: ${new Date().toISOString()}
 *
 * You can customise this file at any time.
 * Re-run: node workflow/init-project.js  to apply changes.
 */

'use strict';

module.exports = {
  // ─── Project Identity ────────────────────────────────────────────────────
  projectName: '${projectName}',
  techStack: '${profile.techStack}',

  // ─── Source Scanning ─────────────────────────────────────────────────────
  sourceExtensions: [${extList}],
  ignoreDirs: [${ignoreDirsList}],

  // ─── Automated Verification Loop ─────────────────────────────────────────
  //
  // testCommand: Shell command to run the project's real test suite.
  // When set, the workflow will:
  //   1. Run your real test suite after code generation
  //   2. If tests fail, automatically invoke DeveloperAgent to fix them
  //   3. Re-run tests (up to maxFixRounds times)
  //
  ${testCommandLine}

  autoFixLoop: {
    enabled: true,       // Set to false to disable auto-fix (report only)
    maxFixRounds: 2,     // Max fix-and-retest cycles before giving up
    failOnUnfixed: false, // true = fail workflow if tests still fail after all rounds
  },

  // ─── Built-in Skills ─────────────────────────────────────────────────────
  builtinSkills: ${skillsJson},

  // ─── Default Skills ───────────────────────────────────────────────────────
  defaultSkills: ${defaultSkillsJson},

  // ─── Classification Rules ─────────────────────────────────────────────────
  // Auto-detection uses built-in fallback rules for this tech stack.
  // Add custom rules here to override or extend them:
  classificationRules: [],
};
`;

  const configPath = path.join(projectRoot, 'workflow.config.js');
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}
// ─── Validation ───────────────────────────────────────────────────────────────

function validateConfig(config, configPath) {
  const errors = [];
  const warnings = [];

  // Required fields
  if (!config.sourceExtensions || !Array.isArray(config.sourceExtensions) || config.sourceExtensions.length === 0) {
    errors.push('`sourceExtensions` must be a non-empty array (e.g. [\'.cs\', \'.lua\'])');
  }
  if (!config.ignoreDirs || !Array.isArray(config.ignoreDirs)) {
    errors.push('`ignoreDirs` must be an array');
  }
  if (!config.builtinSkills || !Array.isArray(config.builtinSkills)) {
    errors.push('`builtinSkills` must be an array');
  }

  // Warnings
  if (!config.projectName) {
    warnings.push('`projectName` is not set. Consider adding it for better logging.');
  }
  if (!config.techStack) {
    warnings.push('`techStack` is not set. Consider adding it for documentation.');
  }
  if (!config.classificationRules || config.classificationRules.length === 0) {
    warnings.push('`classificationRules` is empty. Experience generation will use generic fallback rules.');
  }

  // Validate each rule
  if (Array.isArray(config.classificationRules)) {
    config.classificationRules.forEach((rule, i) => {
      if (!rule.ext) errors.push(`Rule[${i}]: missing \`ext\` field`);
      if (typeof rule.test !== 'function') errors.push(`Rule[${i}]: \`test\` must be a function`);
      if (!rule.result) errors.push(`Rule[${i}]: missing \`result\` field`);
    });
  }

  return { errors, warnings };
}

// ─── Long-running Agent Helpers ───────────────────────────────────────────────

/**
 * Generates an init.sh script tailored to the detected tech stack.
 * This script is run at the start of every Coding Agent session to:
 *  1. Start the development server
 *  2. Run a basic smoke test to verify the environment is healthy
 *
 * @param {object} config      - Workflow config
 * @param {string} projectRoot - Project root path
 * @returns {string} Shell script content
 */
function _generateInitSh(config, projectRoot) {
  const stack = (config.techStack || '').toLowerCase();
  const projectName = config.projectName || 'project';

  // Detect start command based on tech stack
  let startCmd = '# TODO: add your dev server start command here';
  let smokeTest = '# TODO: add a basic smoke test command here';
  let stopCmd = '# TODO: add your dev server stop command here (optional)';

  if (stack.includes('node') || stack.includes('javascript') || stack.includes('typescript')) {
    const hasPkg = fs.existsSync(path.join(projectRoot, 'package.json'));
    if (hasPkg) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        if (pkg.scripts && pkg.scripts.dev)   startCmd = 'npm run dev &';
        else if (pkg.scripts && pkg.scripts.start) startCmd = 'npm start &';
        else startCmd = 'node index.js &';
      } catch (_) { startCmd = 'npm start &'; }
      smokeTest = 'sleep 2 && curl -sf http://localhost:3000/health || echo "Warning: health check failed"';
      stopCmd = 'pkill -f "node" || true';
    }
  } else if (stack.includes('python')) {
    startCmd = 'python -m uvicorn main:app --reload &';
    smokeTest = 'sleep 2 && curl -sf http://localhost:8000/health || echo "Warning: health check failed"';
    stopCmd = 'pkill -f "uvicorn" || true';
  } else if (stack.includes('go')) {
    startCmd = 'go run . &';
    smokeTest = 'sleep 2 && curl -sf http://localhost:8080/health || echo "Warning: health check failed"';
    stopCmd = 'pkill -f "go run" || true';
  } else if (stack.includes('java')) {
    startCmd = './mvnw spring-boot:run &';
    smokeTest = 'sleep 5 && curl -sf http://localhost:8080/actuator/health || echo "Warning: health check failed"';
    stopCmd = 'pkill -f "spring-boot" || true';
  } else if (stack.includes('unity')) {
    startCmd = '# Unity projects do not have a dev server – open in Unity Editor';
    smokeTest = 'echo "Unity project – manual testing required"';
    stopCmd = '# No server to stop';
  }

  return `#!/usr/bin/env bash
# init.sh – ${projectName} Development Environment Startup
#
# Generated by: node workflow/init-project.js
# Generated at: ${new Date().toISOString()}
# Tech stack:   ${config.techStack || 'unknown'}
#
# PURPOSE: This script is run at the START of every Coding Agent session.
#   1. Stops any existing dev server (clean slate)
#   2. Starts the development server
#   3. Runs a basic smoke test to verify the environment is healthy
#
# If the smoke test fails, the Coding Agent MUST fix the environment
# before starting new feature work.
#
# Usage:
#   bash init.sh          # Start dev server
#   bash init.sh --test   # Start + run smoke test only (no server restart)

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo "=================================================="
echo "  ${projectName} – Init Agent Startup"
echo "  $(date)"
echo "=================================================="

# ── Step 1: Stop existing server (clean slate) ─────────────────────────────
echo ""
echo "[1/3] Stopping existing dev server..."
${stopCmd}
echo "      Done"

# ── Step 2: Start dev server ───────────────────────────────────────────────
echo ""
echo "[2/3] Starting dev server..."
${startCmd}
echo "      Server started (PID: $!)"

# ── Step 3: Smoke test ─────────────────────────────────────────────────────
echo ""
echo "[3/3] Running smoke test..."
${smokeTest}
echo "      Smoke test complete"

echo ""
echo "=================================================="
echo "  ✅ Environment ready – proceed with feature work"
echo "=================================================="
`;
}

/**
 * Generates a feature-list.json template with example entries.
 * All features start with passes:false – this is intentional.
 *
 * @param {object} config - Workflow config
 * @returns {object[]} Feature list array
 */
function _generateFeatureListTemplate(config) {
  const projectName = config.projectName || 'Project';
  return [
    {
      id: 'F001',
      category: 'functional',
      description: `[EXAMPLE] ${projectName} starts up without errors`,
      steps: [
        'Run bash init.sh',
        'Verify the server starts without errors',
        'Check that the main entry point is accessible',
        'Verify no errors in logs',
      ],
      passes: false,
      priority: 1,
      deps: [],
      verificationNote: null,
      status: 'not_started',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'F002',
      category: 'functional',
      description: '[EXAMPLE] Replace this with your actual feature description',
      steps: [
        'Navigate to the relevant UI or endpoint',
        'Perform the user action',
        'Verify the expected outcome',
        'Confirm no errors in console or logs',
      ],
      passes: false,
      priority: 2,
      deps: ['F001'],
      verificationNote: null,
      status: 'not_started',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
}

// ─── Project Template Copy ────────────────────────────────────────────────────

/**
 * Copies project-init-template/ files into the target project root,
 * replacing {PLACEHOLDER} tokens with actual project values.
 *
 * Files copied:
 *   AGENTS.md                → <projectRoot>/AGENTS.md
 *   docs/architecture.md     → <projectRoot>/docs/architecture.md
 *   init-checklist.md        → <projectRoot>/docs/init-checklist.md  (reference only)
 *
 * Skips files that already exist (never overwrites).
 *
 * @param {string} projectRoot
 * @param {object} config - Workflow config (projectName, techStack, etc.)
 */
function _copyProjectTemplates(projectRoot, config) {
  const templateDir = path.join(__dirname, 'project-init-template');
  if (!fs.existsSync(templateDir)) {
    console.log(`      ⏭️  project-init-template/ not found, skipping\n`);
    return;
  }

  const projectName = config.projectName || path.basename(projectRoot);
  const techStack   = config.techStack   || 'Unknown';
  const today       = new Date().toISOString().slice(0, 10);

  // ── Auto-infer project-specific values from profile & project files ────────
  const profile = TECH_PROFILES.find(p => p.techStack === techStack);

  // Platforms
  let platforms = 'TBD';
  if (profile && profile.platforms) {
    platforms = typeof profile.platforms === 'function'
      ? profile.platforms(projectRoot)
      : profile.platforms;
  }

  // Naming convention
  const namingConvention = profile ? profile.namingConvention || 'Follow language conventions' : 'Follow language conventions';

  // State management
  let stateManagement = 'TBD';
  if (profile && profile.stateManagement) {
    stateManagement = typeof profile.stateManagement === 'function'
      ? profile.stateManagement(projectRoot)
      : profile.stateManagement;
  }

  // Directory tree (auto-generated)
  const directoryTree = _generateDirectoryTree(projectRoot, config.ignoreDirs);

  // Infer max lines from tech stack
  const maxLinesMap = {
    'flutter': '800', 'dart': '800',
    'unity': '600', 'c#': '600', 'csharp': '600',
    'lua': '400',
    'go': '500',
    'typescript': '600', 'javascript': '600',
    'python': '500',
    'java': '700',
  };
  const stackLower = techStack.toLowerCase();
  const maxLines = Object.entries(maxLinesMap).find(([k]) => stackLower.includes(k))?.[1] || '600';

  // User journeys: infer from tech stack
  const journeys = _inferUserJourneys(projectRoot, profile, projectName);

  /**
   * Replace all {PLACEHOLDER} tokens in a template string.
   */
  function fillTemplate(content) {
    let result = content
      .replace(/\{PROJECT_NAME\}/g, projectName)
      .replace(/\{ONE_LINE_DESCRIPTION\}/g, `${projectName} – ${techStack} project`)
      .replace(/\{TECH_STACK\}/g, techStack)
      .replace(/\{PLATFORMS\}/g, platforms)
      .replace(/\{DATE\}/g, today)
      .replace(/\{MAX_LINES\}/g, maxLines)
      .replace(/\{LANGUAGE_SPECIFIC_LIMIT\}/g, `No single file > ${maxLines} lines`)
      .replace(/\{NAMING_CONVENTION\}/g, namingConvention)
      .replace(/\{NAMING_RULE\}/g, namingConvention)
      .replace(/\{STATE_MANAGEMENT_APPROACH\}/g, stateManagement)
      .replace(/\{STATE_MANAGEMENT_RULE\}/g, stateManagement)
      .replace(/\{PASTE_YOUR_DIRECTORY_TREE_HERE\}/g, directoryTree)
      .replace(/\{BRIEF_DESCRIPTION\}/g, `${techStack} project`)
      .replace(/\{FIRST_DECISION_TITLE\}/g, `Adopt ${techStack} as primary tech stack`)
      .replace(/\{WHY_THIS_DECISION_WAS_NEEDED\}/g, `Project was initialized with the /wf workflow. Tech stack auto-detected as ${techStack}.`)
      .replace(/\{WHAT_WAS_DECIDED\}/g, `Use ${techStack} as the primary tech stack. State management: ${stateManagement}.`)
      .replace(/\{POSITIVE_CONSEQUENCE\}/g, 'Workflow is ready to use. All project-specific config auto-generated.')
      .replace(/\{TRADEOFF_IF_ANY\}/g, 'Review auto-generated values and update if needed.');

    // Replace user journey placeholders with inferred journeys
    result = _injectUserJourneys(result, journeys);
    return result;
  }

  // Files to copy: [templateRelPath, destRelPath]
  // Note: workflow.config.js is NOT copied here – it is generated by
  // generateConfigFromProfile() with the correct testCommand already filled in.
  // The template copy is only used when a config already exists (no auto-generation).
  const filesToCopy = [
    ['AGENTS.md',            'AGENTS.md'],
    ['docs/architecture.md', 'docs/architecture.md'],
    ['init-checklist.md',    'docs/init-checklist.md'],
  ];

  let copied = 0;
  let skipped = 0;

  for (const [srcRel, destRel] of filesToCopy) {
    const srcPath  = path.join(templateDir, srcRel);
    const destPath = path.join(projectRoot, destRel);

    if (!fs.existsSync(srcPath)) {
      console.log(`      ⚠️  Template not found: ${srcRel}`);
      continue;
    }

    if (fs.existsSync(destPath)) {
      console.log(`      ⏭️  Already exists, skipping: ${destRel}`);
      skipped++;
      continue;
    }

    // Ensure destination directory exists
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const templateContent = fs.readFileSync(srcPath, 'utf-8');
    const filledContent   = fillTemplate(templateContent);
    fs.writeFileSync(destPath, filledContent, 'utf-8');
    console.log(`      ✅ Created: ${destRel}`);
    copied++;
  }

  if (copied > 0) {
    console.log(`      📝 ${copied} file(s) created. Edit them to fill in project-specific details.`);
  }
  if (skipped > 0) {
    console.log(`      ℹ️  ${skipped} file(s) already existed, not overwritten.`);
  }
  console.log('');
}

/**
 * Infers plausible user journeys from the project structure and tech stack.
 * Returns an array of { name, steps[] } objects.
 */
function _inferUserJourneys(projectRoot, profile, projectName) {
  const journeys = [];

  if (!profile) {
    return [
      { name: 'Core User Journey', steps: ['User opens the application', 'User performs the main action', 'User sees the expected result'] },
    ];
  }

  if (profile.id === 'flutter') {
    // Scan lib/ for screen/page files to infer journeys
    const screens = _findScreenFiles(projectRoot, ['.dart'], ['lib']);
    if (screens.length > 0) {
      journeys.push({
        name: 'App Launch',
        steps: ['Run the app on target device/emulator', 'Verify splash/loading screen appears', 'Verify main screen loads without errors', 'Check no exceptions in console'],
      });
      if (screens.length > 1) {
        journeys.push({
          name: `Navigate to ${screens[1]}`,
          steps: [`From main screen, navigate to ${screens[1]}`, 'Verify screen renders correctly', 'Verify all interactive elements respond', 'Navigate back and confirm no state leak'],
        });
      }
    } else {
      journeys.push({ name: 'App Launch', steps: ['Run flutter run', 'Verify app starts without errors', 'Verify main screen renders'] });
    }
  } else if (profile.id.startsWith('unity')) {
    journeys.push(
      { name: 'Game Launch', steps: ['Open project in Unity Editor', 'Press Play in the Editor', 'Verify no compile errors', 'Verify main scene loads'] },
      { name: 'Core Gameplay Loop', steps: ['Start a game session', 'Perform the primary game action', 'Verify game state updates correctly', 'End session and verify cleanup'] },
    );
  } else if (profile.id === 'go' || profile.id === 'python' || profile.id === 'java' || profile.id === 'dotnet') {
    journeys.push(
      { name: 'Service Startup', steps: ['Run the service', 'Verify it starts without errors', 'Check health endpoint responds 200', 'Verify logs show no errors'] },
      { name: 'Core API Flow', steps: ['Send a valid request to the primary endpoint', 'Verify response status 200', 'Verify response body matches expected schema', 'Verify no errors in service logs'] },
    );
  } else if (profile.id === 'typescript' || profile.id === 'javascript') {
    journeys.push(
      { name: 'Application Start', steps: ['Run npm start / npm run dev', 'Verify no startup errors', 'Verify main entry point is accessible'] },
      { name: 'Core Feature Flow', steps: ['Trigger the primary feature', 'Verify expected output/response', 'Verify no errors in console'] },
    );
  } else {
    journeys.push(
      { name: 'Application Start', steps: ['Start the application', 'Verify it runs without errors', 'Verify main functionality is accessible'] },
      { name: 'Core Feature', steps: ['Trigger the primary feature', 'Verify expected output', 'Verify no errors'] },
    );
  }

  return journeys;
}

/**
 * Scans for screen/page/view files in the project to infer journey names.
 */
function _findScreenFiles(root, exts, subdirs) {
  const results = [];
  const screenPatterns = [/screen/i, /page/i, /view/i, /scene/i];

  for (const sub of subdirs) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    try {
      function walk(d) {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
          const ext = path.extname(e.name);
          if (!exts.includes(ext)) continue;
          if (screenPatterns.some(p => p.test(e.name))) {
            // Convert file name to readable label: iching_oracle_screen.dart → IchingOracleScreen
            const label = e.name.replace(ext, '')
              .split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
            results.push(label);
          }
        }
      }
      walk(dir);
    } catch (_) {}
  }
  return results.slice(0, 5); // cap at 5
}

/**
 * Replaces {JOURNEY_NAME}, {STEP_1}, {STEP_2}, {STEP_3} placeholders
 * with inferred journey content. Handles multiple journey blocks.
 */
function _injectUserJourneys(content, journeys) {
  if (!journeys || journeys.length === 0) return content;

  // Replace the first occurrence of the journey block pattern
  // Pattern: ### Journey N: {JOURNEY_NAME}\n1. {STEP_1}\n2. {STEP_2}\n3. {STEP_3}
  let result = content;

  // Build replacement block for all journeys
  const journeyBlocks = journeys.map((j, idx) => {
    const steps = j.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return `### Journey ${idx + 1}: ${j.name}\n${steps}`;
  }).join('\n\n');

  // Replace the entire journey section (from first Journey to end of last step)
  const journeyPattern = new RegExp('### Journey 1: \\{JOURNEY_NAME\\}[\\s\\S]*?(?=\\n---|\\n## ADR|$)');
  result = result.replace(journeyPattern, journeyBlocks + '\n');
  // Clean up any remaining single placeholders
  result = result
    .replace(/\{JOURNEY_NAME\}/g, journeys[0]?.name || 'Core User Journey')
    .replace(/\{STEP_1\}/g, journeys[0]?.steps[0] || 'User opens the application')
    .replace(/\{STEP_2\}/g, journeys[0]?.steps[1] || 'User performs the main action')
    .replace(/\{STEP_3\}/g, journeys[0]?.steps[2] || 'User sees the expected result');

  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Usage: node workflow/init-project.js [options]

Options:
  --path, -p <dir>   Project root directory (default: cwd)
  --validate, -v     Only validate config, do not run initialisation
  --dry-run          Show what would be done without writing any files
  --help, -h         Show this help

Examples:
  node workflow/init-project.js                        # Init current project (fully automatic)
  node workflow/init-project.js --path D:\\MyProject   # Init a specific project
  node workflow/init-project.js --validate             # Validate config only

How it works:
  1. If workflow.config.js exists  → use it directly
  2. If not found                  → auto-detect tech stack, generate config, then init
  No manual steps required.
`);
    process.exit(0);
  }

  const projectRoot = args.path ? path.resolve(args.path) : process.cwd();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Workflow Project Initialiser`);
  console.log(`  Project Root: ${projectRoot}`);
  console.log(`${'='.repeat(60)}\n`);

  // ── Auto-detect or load config ────────────────────────────────────────────
  clearConfigCache();
  let config = getConfig(projectRoot, true);
  let configPath = getConfigPath();

  if (configPath) {
    // Config already exists – use it
    console.log(`📋 Config file: ${configPath} (existing)`);
  } else {
    // No config found – auto-detect tech stack and generate one
    console.log(`📋 No workflow.config.js found. Auto-detecting tech stack...\n`);

    const { profile, projectName } = detectTechStack(projectRoot);

    if (!profile) {
      console.warn(`   ⚠️  Could not detect tech stack. Generating a generic config.`);
    } else {
      console.log(`   🔍 Detected: ${profile.name}`);
    }

    if (!args.dryRun) {
      const generatedPath = generateConfigFromProfile(
        projectRoot,
        profile || TECH_PROFILES[TECH_PROFILES.length - 1],  // fallback to last (js)
        projectName
      );
      console.log(`   ✅ Generated: ${generatedPath}\n`);

      // Reload config from the newly generated file
      clearConfigCache();
      config = getConfig(projectRoot, true);
      configPath = getConfigPath();
    } else {
      console.log(`   [dry-run] Would generate workflow.config.js for: ${profile ? profile.name : 'generic'}\n`);
    }
  }

  if (config.projectName) console.log(`   Project : ${config.projectName}`);
  if (config.techStack)   console.log(`   Stack   : ${config.techStack}`);
  console.log(`   Exts    : ${config.sourceExtensions.join(', ')}`);
  console.log(`   Rules   : ${config.classificationRules.length} classification rules`);
  console.log(`   Skills  : ${config.builtinSkills.length} built-in skills\n`);

  // ── Validate ───────────────────────────────────────────────────────────────
  const { errors, warnings } = validateConfig(config, configPath);

  if (warnings.length > 0) {
    console.log(`⚠️  Warnings (${warnings.length}):`);
    warnings.forEach(w => console.log(`   • ${w}`));
    console.log('');
  }

  if (errors.length > 0) {
    console.error(`❌ Config validation failed (${errors.length} error(s)):`);
    errors.forEach(e => console.error(`   • ${e}`));
    process.exit(1);
  }

  if (args.validate) {
    console.log(`✅ Config is valid.`);
    return;
  }

  // ── Step 0: Copy project-init-template files ──────────────────────────────
  console.log(`[0/5] Copying project knowledge templates...`);
  if (!args.dryRun) {
    _copyProjectTemplates(projectRoot, config);
  } else {
    console.log(`      [dry-run] Would copy project-init-template/ files to: ${projectRoot}\n`);
  }

  // ── Step 1: Build AGENTS.md ────────────────────────────────────────────────
  console.log(`[1/5] Building AGENTS.md (global project context)...`);
  if (!args.dryRun) {
    try {
      const memory = new MemoryManager(projectRoot);
      await memory.buildGlobalContext();
      console.log(`      ✅ AGENTS.md written\n`);
    } catch (err) {
      console.warn(`      ⚠️  AGENTS.md build warning: ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would build AGENTS.md at: ${path.join(projectRoot, 'AGENTS.md')}\n`);
  }

  // ── Step 2: Generate experiences from source files ─────────────────────────
  console.log(`[2/5] Generating experience store from source files...`);
  if (!args.dryRun) {
    try {
      // Dynamically require gen-experiences to avoid circular deps
      const genExpPath = path.join(__dirname, 'gen-experiences.js');
      // Run as child process to isolate argv
      const { execSync } = require('child_process');
      const extArg = config.sourceExtensions.join(',');
      const cmd = `node "${genExpPath}" --path "${projectRoot}" --ext "${extArg}"`;
      console.log(`      Running: ${cmd}`);
      execSync(cmd, { stdio: 'inherit' });
      console.log(`      ✅ Experience store populated\n`);
    } catch (err) {
      console.warn(`      ⚠️  Experience generation warning: ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would run: node gen-experiences.js --path "${projectRoot}" --ext "${config.sourceExtensions.join(',')}"\n`);
  }

  // ── Step 3: Register built-in skills ──────────────────────────────────────
  console.log(`[3/5] Registering built-in skills...`);
  if (!args.dryRun) {
    try {
      const skillEngine = new SkillEvolutionEngine();
      let registered = 0;
      for (const skill of config.builtinSkills) {
        try {
          skillEngine.registerSkill(skill);
          registered++;
        } catch (err) {
          if (!err.message.includes('already registered') && !err.message.includes('already exists')) {
            console.warn(`      ⚠️  Skill "${skill.name}": ${err.message}`);
          }
        }
      }
      console.log(`      ✅ ${registered} skill(s) registered\n`);
    } catch (err) {
      console.warn(`      ⚠️  Skill registration warning: ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would register ${config.builtinSkills.length} skills:\n`);
    config.builtinSkills.forEach(s => console.log(`        • ${s.name}`));
    console.log('');
  }

  // ── Step 4: Generate init.sh (long-running agent pattern) ─────────────────
  console.log(`[4/6] Generating init.sh (dev server startup script)...`);
  const initShPath = path.join(projectRoot, 'init.sh');
  if (!args.dryRun) {
    if (fs.existsSync(initShPath)) {
      console.log(`      ⏭️  init.sh already exists, skipping\n`);
    } else {
      try {
        const initShContent = _generateInitSh(config, projectRoot);
        fs.writeFileSync(initShPath, initShContent, 'utf-8');
        // Make executable on Unix-like systems
        try { fs.chmodSync(initShPath, 0o755); } catch (_) {}
        console.log(`      ✅ init.sh written to: ${initShPath}\n`);
      } catch (err) {
        console.warn(`      ⚠️  init.sh generation warning: ${err.message}\n`);
      }
    }
  } else {
    console.log(`      [dry-run] Would generate: ${initShPath}\n`);
  }

  // ── Step 5: Generate feature-list.json template ────────────────────────────
  console.log(`[5/6] Generating feature-list.json template...`);
  const outputDir = path.join(projectRoot, 'output');
  const featureListPath = path.join(outputDir, 'feature-list.json');
  if (!args.dryRun) {
    if (fs.existsSync(featureListPath)) {
      console.log(`      ⏭️  feature-list.json already exists, skipping\n`);
    } else {
      try {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const featureListTemplate = _generateFeatureListTemplate(config);
        fs.writeFileSync(featureListPath, JSON.stringify(featureListTemplate, null, 2), 'utf-8');
        console.log(`      ✅ feature-list.json written to: ${featureListPath}`);
        console.log(`      ℹ️  Edit this file to add your project's features (all start with passes:false)\n`);
      } catch (err) {
        console.warn(`      ⚠️  feature-list.json generation warning: ${err.message}\n`);
      }
    }
  } else {
    console.log(`      [dry-run] Would generate: ${featureListPath}\n`);
  }

  // ── Step 6: Build initial code graph ──────────────────────────────────────
  console.log(`[6/6] Building initial code graph (symbol index + call relationships)...`);
  if (!args.dryRun) {
    try {
      const { CodeGraph } = require('./core/code-graph');
      const outputDir = path.join(projectRoot, 'output');
      const cfg = config || {};
      const graph = new CodeGraph({
        projectRoot,
        outputDir,
        extensions: cfg.sourceExtensions,
        ignoreDirs: cfg.ignoreDirs,
      });
      const result = await graph.build();
      console.log(`      ✅ Code graph built: ${result.symbolCount} symbols, ${result.edgeCount} call edges, ${result.fileCount} files`);
      console.log(`      📄 Index: ${path.join(outputDir, 'code-graph.json')}`);
      console.log(`      📄 Summary: ${path.join(outputDir, 'code-graph.md')}\n`);
    } catch (err) {
      console.warn(`      ⚠️  Code graph generation warning (non-fatal): ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would build code graph for: ${projectRoot}\n`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`${'='.repeat(60)}`);
  console.log(`  ✅ Project initialisation complete!`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n  The workflow is now configured for: ${config.projectName || projectRoot}`);
  console.log(`  Project knowledge files:`);
  console.log(`    • AGENTS.md                  – Project context entry point (edit to fill details)`);
  console.log(`    • docs/architecture.md        – Architecture decisions & acceptance criteria`);
  console.log(`    • docs/init-checklist.md      – Onboarding checklist for reference`);
  console.log(`  Long-running agent files:`);
  console.log(`    • init.sh                    – Run at the start of every Coding Agent session`);
  console.log(`    • output/feature-list.json   – Track feature completion (all start passes:false)`);
  console.log(`  Code intelligence files:`);
  console.log(`    • output/code-graph.json     – Structured symbol index + call graph (auto-updated)`);
  console.log(`    • output/code-graph.md       – Human-readable code graph summary`);
  console.log(`  You can now run: node workflow/index.js\n`);
}

main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
