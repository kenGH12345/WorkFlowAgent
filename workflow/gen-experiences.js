#!/usr/bin/env node
/**
 * gen-experiences.js – Scan project code and populate the experience store
 *
 * Scans C# and Lua source files to extract:
 *  - Utility/helper classes → utility_class
 *  - Interface definitions  → interface_def
 *  - Framework modules      → framework_module
 *  - UI components          → ui_pattern
 *  - Entity systems         → entity_system
 *  - Event systems          → event_system
 *  - Resource loading       → resource_load
 *  - Object pools           → object_pool
 *  - Procedure/FSM steps    → procedure
 *  - Network protocols      → network_protocol
 *  - Config/DataTable       → config_system
 *  - Sound systems          → sound_system
 *  - Lua patterns           → lua_pattern
 *  - C# patterns            → csharp_pattern
 *
 * Usage:
 *   node workflow/gen-experiences.js
 *   node workflow/gen-experiences.js --path D:\MyProject
 *   node workflow/gen-experiences.js --path D:\MyProject --ext .js,.ts --dry-run
 *
 * Options:
 *   --path <dir>     Target project root (default: process.cwd())
 *   --ext <exts>     File extensions, comma-separated (default: all supported)
 *   --max-files <n>  Max files per extension (default: 200)
 *   --dry-run        Print what would be recorded without writing
 *   --help           Show help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ExperienceStore, ExperienceType, ExperienceCategory } = require('./core/experience-store');
const { getConfig, clearConfigCache } = require('./core/config-loader');

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { path: null, ext: null, maxFiles: 200, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help': case '-h': args.help = true; break;
      case '--path': case '-p': args.path = argv[++i]; break;
      case '--ext':  case '-e': args.ext = argv[++i]; break;
      case '--max-files': case '-m': args.maxFiles = parseInt(argv[++i], 10); break;
      case '--dry-run': args.dryRun = true; break;
    }
  }
  return args;
}

// ─── Category Detection Rules ─────────────────────────────────────────────────

/**
 * Rule-table driven classification.
 * Rules are loaded from workflow.config.js (classificationRules).
 * Each rule: { ext, test: (path, content) => bool, result: { category, skill, tags, extra? } | fn }
 * Rules are evaluated in order; first match wins.
 *
 * Built-in fallback rules are used only when no config rules are provided.
 */
const BUILTIN_CSHARP_RULES = [
  {
    test: (_p, c) => /\binterface\s+I[A-Z]/.test(c),
    result: (_p, c) => {
      const ifaces = (c.match(/interface\s+(I\w+)/g) || []).map(m => m.replace('interface ', ''));
      return {
        category: ExperienceCategory.INTERFACE_DEF,
        skill: 'unity-csharp',
        tags: ['interface', 'contract', ...ifaces.slice(0, 3)],
        extra: `Interfaces: ${ifaces.join(', ')}`,
      };
    },
  },
  {
    test: (p, c) => p.includes('utility') || p.includes('helper') || p.includes('util') || p.includes('extension')
      || /class\s+\w*(Utility|Helper|Util|Extension|Utils|Tools)\b/.test(c),
    result: { category: ExperienceCategory.UTILITY_CLASS, skill: 'unity-csharp', tags: ['utility', 'helper', 'csharp'] },
  },
  {
    test: (p, c) => p.includes('/editor/') || c.includes('editorwindow') || c.includes('menuitem')
      || c.includes('assetpostprocessor') || c.includes('[customeditor') || c.includes('editorguiutility'),
    result: { category: ExperienceCategory.UTILITY_CLASS, skill: 'unity-csharp', tags: ['editor', 'tool', 'unity', 'csharp'] },
  },
  {
    test: (p, c) => p.includes('/ui/') || p.includes('form') || p.includes('widget') || p.includes('panel')
      || c.includes('uiform') || c.includes('uicomponent') || c.includes('openui') || c.includes('closeui'),
    result: { category: ExperienceCategory.UI_PATTERN, skill: 'unity-csharp', tags: ['ui', 'form', 'panel', 'unity'] },
  },
  {
    test: (p, c) => p.includes('/entity/') || c.includes('entitylogic') || c.includes('entitydata')
      || c.includes('showentity') || c.includes('hideentity') || c.includes('ientitygroup'),
    result: { category: ExperienceCategory.ENTITY_SYSTEM, skill: 'unity-csharp', tags: ['entity', 'gameobject', 'unity'] },
  },
  {
    test: (p, c) => p.includes('/event/') || c.includes('gameeventargs') || c.includes('subscribeevent')
      || c.includes('fireevent') || c.includes('unsubscribeevent') || /class\s+\w+EventArgs/.test(c),
    result: { category: ExperienceCategory.EVENT_SYSTEM, skill: 'unity-csharp', tags: ['event', 'subscribe', 'dispatch', 'unity'] },
  },
  {
    test: (p, c) => p.includes('/resource/') || c.includes('loadasset') || c.includes('resourcecomponent')
      || c.includes('assetbundle') || c.includes('unloadasset') || c.includes('iresourcemanager'),
    result: { category: ExperienceCategory.RESOURCE_LOAD, skill: 'unity-csharp', tags: ['resource', 'asset', 'load', 'unity'] },
  },
  {
    test: (p, c) => p.includes('objectpool') || p.includes('referencepool') || c.includes('referencepool')
      || c.includes('objectpool') || c.includes('ireference') || c.includes('iobjectpool'),
    result: { category: ExperienceCategory.OBJECT_POOL, skill: 'unity-csharp', tags: ['pool', 'reference', 'memory', 'unity'] },
  },
  {
    test: (p, c) => p.includes('/procedure/') || p.includes('/fsm/') || c.includes('procedurebase')
      || c.includes('fsmstate') || c.includes('ifsm') || c.includes('procedurecomponent')
      || /class\s+Procedure\w+/.test(c),
    result: { category: ExperienceCategory.PROCEDURE, skill: 'unity-csharp', tags: ['procedure', 'fsm', 'state', 'unity'] },
  },
  {
    test: (p, c) => p.includes('/network/') || c.includes('networkcomponent') || c.includes('packetbase')
      || c.includes('ipackethandler') || c.includes('inetworkchannelhelper') || c.includes('networkmanager'),
    result: { category: ExperienceCategory.NETWORK_PROTOCOL, skill: 'unity-csharp', tags: ['network', 'packet', 'protocol', 'unity'] },
  },
  {
    test: (p, c) => p.includes('/config/') || p.includes('/datatable/') || c.includes('idatarow')
      || c.includes('configcomponent') || c.includes('datatablecomponent') || c.includes('datatablemanager')
      || /class\s+DR\w+/.test(c) || /class\s+\w+DataRow/.test(c),
    result: { category: ExperienceCategory.CONFIG_SYSTEM, skill: 'unity-csharp', tags: ['config', 'datatable', 'data', 'unity'] },
  },
  {
    test: (p, c) => p.includes('/sound/') || c.includes('soundcomponent') || c.includes('playsound')
      || c.includes('soundagent') || c.includes('isoundagenthelper'),
    result: { category: ExperienceCategory.SOUND_SYSTEM, skill: 'unity-csharp', tags: ['sound', 'audio', 'unity'] },
  },
  {
    test: (p, c) => c.includes('gameframeworklinkedlist') || c.includes('gameframeworkmultidictionary')
      || p.includes('datastruct') || p.includes('linkedlist') || p.includes('dictionary'),
    result: { category: ExperienceCategory.DATA_STRUCTURE, skill: 'unity-csharp', tags: ['data-structure', 'collection', 'csharp'] },
  },
  {
    test: (p, c) => p.includes('gameframework') || p.includes('runtime/') || c.includes('gameframeworkmodule')
      || c.includes('gameframeworkcomponent') || c.includes('gameframeworkentry')
      || /class\s+\w+Manager\s*:/.test(c) || /class\s+\w+Component\s*:/.test(c),
    result: { category: ExperienceCategory.FRAMEWORK_MODULE, skill: 'unity-csharp', tags: ['framework', 'module', 'gameframework', 'unity'] },
  },
  {
    test: (p) => p.includes('gamemain') || p.includes('/game/') || p.includes('/base/'),
    result: { category: ExperienceCategory.CSHARP_PATTERN, skill: 'unity-csharp', tags: ['game', 'logic', 'csharp', 'unity'] },
  },
];

const BUILTIN_LUA_RULES = [
  {
    test: (p, c) => p.includes('/ui/') || p.includes('panel') || p.includes('form') || p.includes('view')
      || c.includes('uibase') || c.includes('uimanager'),
    result: { category: ExperienceCategory.UI_PATTERN, skill: 'lua-scripting', tags: ['ui', 'panel', 'lua'] },
  },
  {
    test: (_p, c) => c.includes('eventemitter') || c.includes('addeventlistener')
      || c.includes('dispatchevent') || c.includes('eventmanager'),
    result: { category: ExperienceCategory.EVENT_SYSTEM, skill: 'lua-scripting', tags: ['event', 'listener', 'lua'] },
  },
  {
    test: (p) => p.includes('util') || p.includes('helper') || p.includes('tool') || p.includes('common'),
    result: { category: ExperienceCategory.UTILITY_CLASS, skill: 'lua-scripting', tags: ['utility', 'helper', 'lua'] },
  },
  {
    test: (p) => p.includes('config') || p.includes('data') || p.includes('table') || p.includes('cfg'),
    result: { category: ExperienceCategory.CONFIG_SYSTEM, skill: 'lua-scripting', tags: ['config', 'data', 'lua'] },
  },
  {
    test: (p, c) => p.includes('network') || p.includes('proto') || p.includes('msg')
      || c.includes('sendmessage') || c.includes('onmessage'),
    result: { category: ExperienceCategory.NETWORK_PROTOCOL, skill: 'lua-scripting', tags: ['network', 'message', 'lua'] },
  },
  {
    test: (_p, c) => c.includes('baseclass') || c.includes('class(') || c.includes('= {}'),
    result: { category: ExperienceCategory.COMPONENT, skill: 'lua-scripting', tags: ['component', 'module', 'lua'] },
  },
];

/**
 * Applies a rule table to classify a file.
 * @param {Array} rules
 * @param {string} p - lowercased relative path
 * @param {string} c - lowercased content
 * @param {string} rawContent - original content (for regex tests)
 * @returns {{ category, skill, tags, extra? }}
 */
function applyRules(rules, p, c, rawContent) {
  for (const rule of rules) {
    const matched = rule.test(p, c, rawContent);
    if (matched) {
      return typeof rule.result === 'function' ? rule.result(p, rawContent) : { ...rule.result };
    }
  }
  return null;
}

/**
 * Returns the effective rule list for a given extension.
 * Priority: config rules (filtered by ext) → built-in fallback rules.
 *
 * @param {string} ext - File extension (e.g. '.cs')
 * @param {Array}  configRules - Rules from workflow.config.js
 * @param {Array}  builtinRules - Built-in fallback rules
 * @returns {Array}
 */
function getRulesForExt(ext, configRules, builtinRules) {
  const filtered = configRules.filter(r => r.ext === ext || r.ext === '*');
  return filtered.length > 0 ? filtered : builtinRules;
}

/**
 * Determines the ExperienceCategory for a C# file based on path + content signals.
 * Returns { category, skill, tags } for precise classification.
 *
 * @param {string} relativePath
 * @param {string} content
 * @param {Array}  configRules - Rules from workflow.config.js
 * @param {object} defaultSkills - Default skill map from config
 */
function classifyCSharpFile(relativePath, content, configRules = [], defaultSkills = {}) {
  const p = relativePath.toLowerCase();
  const c = content.toLowerCase();
  const rules = getRulesForExt('.cs', configRules, BUILTIN_CSHARP_RULES);
  const defaultSkill = defaultSkills['.cs'] || 'csharp-dev';
  return applyRules(rules, p, c, content)
    || { category: ExperienceCategory.CSHARP_PATTERN, skill: defaultSkill, tags: ['csharp'] };
}

/**
 * Determines the ExperienceCategory for a Lua file based on path + content signals.
 *
 * @param {string} relativePath
 * @param {string} content
 * @param {Array}  configRules - Rules from workflow.config.js
 * @param {object} defaultSkills - Default skill map from config
 */
function classifyLuaFile(relativePath, content, configRules = [], defaultSkills = {}) {
  const p = relativePath.toLowerCase();
  const c = content.toLowerCase();
  const rules = getRulesForExt('.lua', configRules, BUILTIN_LUA_RULES);
  const defaultSkill = defaultSkills['.lua'] || 'lua-scripting';
  return applyRules(rules, p, c, content)
    || { category: ExperienceCategory.LUA_PATTERN, skill: defaultSkill, tags: ['lua'] };
}

/**
 * Classifies a file of any extension using config rules.
 * Falls back to a generic category if no rule matches.
 *
 * @param {string} ext
 * @param {string} relativePath
 * @param {string} content
 * @param {Array}  configRules
 * @param {object} defaultSkills
 */
function classifyGenericFile(ext, relativePath, content, configRules = [], defaultSkills = {}) {
  const p = relativePath.toLowerCase();
  const c = content.toLowerCase();
  const rules = getRulesForExt(ext, configRules, []);
  const defaultSkill = defaultSkills[ext] || `${ext.replace('.', '')}-dev`;
  return applyRules(rules, p, c, content)
    || { category: ExperienceCategory.CSHARP_PATTERN, skill: defaultSkill, tags: [ext.replace('.', '')] };
}

// ─── Symbol Extraction ────────────────────────────────────────────────────────

/**
 * Extracts key symbols from C# file for experience title/content generation.
 */
function extractCSharpInfo(content, relativePath) {
  const nsMatch = content.match(/^\s*namespace\s+([\w.]+)/m);
  const namespace = nsMatch ? nsMatch[1] : null;

  const classes = [];
  const methods = [];
  const interfaces = [];

  for (const line of content.split('\n')) {
    const t = line.trim();
    // Class/struct/interface/enum
    const typeMatch = t.match(/^(?:public|internal|protected)?\s*(?:abstract|sealed|static|partial)?\s*(?:abstract|sealed|static|partial)?\s*(class|struct|interface|enum)\s+(\w+)/);
    if (typeMatch) {
      if (typeMatch[1] === 'interface') interfaces.push(typeMatch[2]);
      else classes.push(`${typeMatch[1]} ${typeMatch[2]}`);
    }
    // Public methods
    const methodMatch = t.match(/^public\s+(?:static\s+|override\s+|virtual\s+|async\s+)*([\w<>\[\]?,\s]+?)\s+(\w+)\s*\(/);
    if (methodMatch) {
      const name = methodMatch[2];
      if (!['if', 'while', 'for', 'foreach', 'switch', 'using', 'return', 'new'].includes(name)) {
        methods.push(name);
      }
    }
  }

  return { namespace, classes, methods: methods.slice(0, 8), interfaces };
}

/**
 * Extracts key symbols from Lua file.
 */
function extractLuaInfo(content) {
  const modules = [];
  const functions = [];

  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.startsWith('--')) continue;

    const globalFn = t.match(/^function\s+([\w.:]+)\s*\(/);
    if (globalFn) { functions.push(globalFn[1]); continue; }

    const tableFn = t.match(/^([\w]+\.[\w.]+)\s*=\s*function\s*\(/);
    if (tableFn) { functions.push(tableFn[1]); continue; }

    const classMatch = t.match(/^(?:local\s+)?(\w+)\s*=\s*(?:class\s*\(|BaseClass\s*\(|\{\})/);
    if (classMatch && classMatch[1] !== '_' && classMatch[1].length > 1) {
      modules.push(classMatch[1]);
    }
  }

  return { modules, functions: functions.slice(0, 8) };
}

// ─── File Scanner ─────────────────────────────────────────────────────────────

// Default ignore dirs – overridden by config.ignoreDirs at runtime
const DEFAULT_IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', 'output', 'Library', 'Temp', 'obj', 'Packages', '.vs'];

function scanFiles(dirPath, extensions, maxFiles, ignoreDirs = DEFAULT_IGNORE_DIRS) {
  const resultsByExt = {};
  for (const ext of extensions) resultsByExt[ext] = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (ignoreDirs.includes(entry.name) || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!extensions.includes(ext)) continue;
        if (resultsByExt[ext].length >= maxFiles) continue;
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          resultsByExt[ext].push({ fullPath, content });
        } catch (_) { /* skip unreadable */ }
      }
    }
  }

  walk(dirPath);
  return resultsByExt;
}

// ─── Experience Builder ───────────────────────────────────────────────────────

/**
 * Builds an experience record for any non-C#/non-Lua file extension.
 * Uses config rules for classification; falls back to a generic record.
 */
function buildExperienceFromGeneric(ext, relativePath, content, configRules = [], defaultSkills = {}) {
  const { category, skill, tags } = classifyGenericFile(ext, relativePath, content, configRules, defaultSkills);
  const baseName = path.basename(relativePath, ext);
  const title = `[${ext.replace('.', '').toUpperCase()}] ${baseName} (${category.replace(/_/g, ' ')})`;

  const lines = [];
  lines.push(`**File**: \`${relativePath}\``);

  return {
    type: ExperienceType.POSITIVE,
    category,
    title,
    content: lines.join('\n'),
    skill,
    tags,
    sourceFile: relativePath,
  };
}

/**
 * Converts a scanned file into an experience record.
 */
function buildExperienceFromCSharp(relativePath, content, projectRoot, configRules = [], defaultSkills = {}) {
  const { namespace, classes, methods, interfaces } = extractCSharpInfo(content, relativePath);
  const { category, skill, tags, extra } = classifyCSharpFile(relativePath, content, configRules, defaultSkills);

  // Build a meaningful title
  const mainClass = classes[0] || path.basename(relativePath, '.cs');
  const title = interfaces.length > 0
    ? `[Interface] ${interfaces[0]} – ${path.basename(relativePath, '.cs')}`
    : `[C#] ${mainClass} (${category.replace(/_/g, ' ')})`;

  // Build content description
  const lines = [];
  if (namespace) lines.push(`**Namespace**: \`${namespace}\``);
  lines.push(`**File**: \`${relativePath}\``);
  if (classes.length > 0) lines.push(`**Types**: ${classes.join(', ')}`);
  if (interfaces.length > 0) lines.push(`**Interfaces**: ${interfaces.join(', ')}`);
  if (methods.length > 0) lines.push(`**Key Methods**: \`${methods.join('()\`, \`')}()\``);
  if (extra) lines.push(extra);

  // Add usage hint based on category
  const hints = {
    [ExperienceCategory.UTILITY_CLASS]:    'Use these utility methods directly; avoid reimplementing.',
    [ExperienceCategory.INTERFACE_DEF]:    'Implement this interface to integrate with the framework.',
    [ExperienceCategory.FRAMEWORK_MODULE]: 'Access via GameEntry.<ModuleName>Component in Unity.',
    [ExperienceCategory.EVENT_SYSTEM]:     'Subscribe with GameEntry.Event.Subscribe(); fire with GameEntry.Event.Fire().',
    [ExperienceCategory.RESOURCE_LOAD]:    'Use GameEntry.Resource.LoadAsset() with callback pattern.',
    [ExperienceCategory.OBJECT_POOL]:      'Use ReferencePool.Acquire<T>() / ReferencePool.Release(obj).',
    [ExperienceCategory.PROCEDURE]:        'Inherit ProcedureBase; register in ProcedureComponent.',
    [ExperienceCategory.UI_PATTERN]:       'Open UI with GameEntry.UI.OpenUIForm(); close with CloseUIForm().',
    [ExperienceCategory.ENTITY_SYSTEM]:    'Show entity with GameEntry.Entity.ShowEntity(); hide with HideEntity().',
    [ExperienceCategory.CONFIG_SYSTEM]:    'Load config with GameEntry.Config.GetString(); DataTable with GetDataTable<T>().',
    [ExperienceCategory.SOUND_SYSTEM]:     'Play sound with GameEntry.Sound.PlaySound(soundId).',
    [ExperienceCategory.NETWORK_PROTOCOL]: 'Register handler with GameEntry.Network.RegisterHandler().',
  };
  if (hints[category]) lines.push(`\n💡 **Usage**: ${hints[category]}`);

  return {
    type: ExperienceType.POSITIVE,
    category,
    title,
    content: lines.join('\n'),
    skill,
    tags: [...new Set([...tags, ...classes.map(c => c.split(' ')[1]).filter(Boolean).slice(0, 2)])],
    sourceFile: relativePath,
    namespace,
  };
}

function buildExperienceFromLua(relativePath, content, configRules = [], defaultSkills = {}) {
  const { modules, functions } = extractLuaInfo(content);
  const { category, skill, tags } = classifyLuaFile(relativePath, content, configRules, defaultSkills);

  const mainModule = modules[0] || path.basename(relativePath, '.lua');
  const title = `[Lua] ${mainModule} (${category.replace(/_/g, ' ')})`;

  const lines = [];
  lines.push(`**File**: \`${relativePath}\``);
  if (modules.length > 0) lines.push(`**Modules/Classes**: ${modules.join(', ')}`);
  if (functions.length > 0) lines.push(`**Key Functions**: \`${functions.join('()\`, \`')}()\``);

  const hints = {
    [ExperienceCategory.UI_PATTERN]:    'Inherit UIBase; register in UIManager.',
    [ExperienceCategory.EVENT_SYSTEM]:  'Use EventManager:AddEventListener() / DispatchEvent().',
    [ExperienceCategory.UTILITY_CLASS]: 'Require this module and call utility functions directly.',
    [ExperienceCategory.CONFIG_SYSTEM]: 'Access config data via require("config.xxx").',
    [ExperienceCategory.COMPONENT]:     'Instantiate with ClassName.new(); call methods on instance.',
  };
  if (hints[category]) lines.push(`\n💡 **Usage**: ${hints[category]}`);

  return {
    type: ExperienceType.POSITIVE,
    category,
    title,
    content: lines.join('\n'),
    skill,
    tags: [...new Set([...tags, ...modules.slice(0, 2)])],
    sourceFile: relativePath,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Usage: node workflow/gen-experiences.js [options]

Options:
  --path, -p <dir>       Target project root (default: cwd)
  --ext,  -e <exts>      File extensions, comma-separated (default: all supported)
  --max-files, -m <n>    Max files per extension (default: 200)
  --dry-run              Print what would be recorded without writing
  --help, -h             Show help
`);
    process.exit(0);
  }

  const projectRoot = args.path ? path.resolve(args.path) : process.cwd();

  // Load project config (workflow.config.js)
  clearConfigCache();
  const config = getConfig(projectRoot, true);
  const configRules   = config.classificationRules || [];
  const defaultSkills = config.defaultSkills || {};

  const extensions = args.ext
    ? args.ext.split(',').map(e => e.trim().startsWith('.') ? e.trim() : `.${e.trim()}`)
    : (config.sourceExtensions || ['.js', '.ts', '.py', '.go', '.java', '.cs', '.lua', '.dart']);
  const maxFiles = args.maxFiles;
  const dryRun = args.dryRun;

  if (config.projectName) {
    console.log(`[gen-experiences] Project : ${config.projectName}`);
  }
  console.log(`[gen-experiences] Config rules: ${configRules.length} (${configRules.length > 0 ? 'from workflow.config.js' : 'using built-in fallback'})`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Experience Generator`);
  console.log(`  Target : ${projectRoot}`);
  console.log(`  Exts   : ${extensions.join(', ')}`);
  console.log(`  MaxFiles: ${maxFiles} per extension`);
  console.log(`  DryRun : ${dryRun}`);
  console.log(`${'='.repeat(60)}\n`);

  // Scan files
  console.log('[gen-experiences] Scanning files...');
  const ignoreDirs = config.ignoreDirs || DEFAULT_IGNORE_DIRS;
  const filesByExt = scanFiles(projectRoot, extensions, maxFiles, ignoreDirs);

  const store = dryRun ? null : new ExperienceStore();
  const toRecord = [];

  // Process all files by extension
  for (const ext of extensions) {
    const files = filesByExt[ext] || [];
    const label = { '.cs': 'C#', '.lua': 'Lua', '.js': 'JavaScript', '.ts': 'TypeScript', '.py': 'Python', '.go': 'Go', '.java': 'Java', '.dart': 'Dart' }[ext] || ext;
    console.log(`[gen-experiences] Processing ${files.length} ${label} files...`);
    for (const { fullPath, content } of files) {
      const relativePath = path.relative(projectRoot, fullPath).replace(/\\/g, '/');
      try {
        let exp;
        if (ext === '.cs') {
          exp = buildExperienceFromCSharp(relativePath, content, projectRoot, configRules, defaultSkills);
        } else if (ext === '.lua') {
          exp = buildExperienceFromLua(relativePath, content, configRules, defaultSkills);
        } else {
          exp = buildExperienceFromGeneric(ext, relativePath, content, configRules, defaultSkills);
        }
        toRecord.push(exp);
      } catch (_) { /* skip */ }
    }
  }

  console.log(`\n[gen-experiences] Generated ${toRecord.length} experience entries`);

  if (dryRun) {
    // Print preview
    const byCategory = {};
    for (const e of toRecord) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    }
    console.log('\n📊 Category breakdown:');
    for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${cat.padEnd(25)} ${count}`);
    }
    console.log('\n📋 Sample entries (first 5):');
    for (const e of toRecord.slice(0, 5)) {
      console.log(`\n  [${e.category}] ${e.title}`);
      console.log(`  Tags: ${e.tags.join(', ')}`);
    }
    console.log('\n✅ Dry run complete. Use without --dry-run to write to experience store.');
    return;
  }

  // Batch write to experience store
  const { added, skipped } = store.batchRecord(toRecord);

  const stats = store.getStats();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ✅ Experience Store Updated`);
  console.log(`  Added   : ${added}`);
  console.log(`  Skipped : ${skipped} (duplicates)`);
  console.log(`  Total   : ${stats.total} (✅${stats.positive} / ❌${stats.negative})`);
  console.log(`\n  By Category:`);
  for (const [cat, count] of Object.entries(stats.byCategory).sort((a, b) => b - a)) {
    console.log(`    ${cat.padEnd(25)} ${count}`);
  }
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
