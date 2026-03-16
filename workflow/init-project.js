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
const { TECH_PROFILES, detectTechStack } = require('./core/tech-profiles');
const { generateConfigFromProfile, _generateInitSh, _generateFeatureListTemplate } = require('./core/project-generators');
const { _copyProjectTemplates } = require('./core/project-template');

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
