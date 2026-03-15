#!/usr/bin/env node
/**
 * gen-agents.js – 为任意项目生成/更新 AGENTS.md
 *
 * Usage:
 *   node workflow/gen-agents.js                          # 扫描当前工作目录
 *   node workflow/gen-agents.js --path D:\MyProject      # 扫描指定项目
 *   node workflow/gen-agents.js --path D:\MyProject --ext .cs,.lua,.ts
 *   node workflow/gen-agents.js --path D:\MyProject --max-files 120
 *
 * Options:
 *   --path <dir>        目标项目根目录（默认：process.cwd()）
 *   --ext <exts>        扫描的文件扩展名，逗号分隔（默认：.cs,.lua）
 *   --max-files <n>     每种扩展名最多扫描文件数（默认：80）
 *   --help              显示帮助
 */

'use strict';

const path = require('path');
const { MemoryManager } = require('./core/memory-manager');
const { scanCodeSymbols } = require('./tools/thick-tools');
const { ExperienceStore, ExperienceType, ExperienceCategory } = require('./core/experience-store');

// ─── Parse CLI args ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { path: null, ext: null, maxFiles: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help': case '-h':
        args.help = true; break;
      case '--path': case '-p':
        args.path = argv[++i]; break;
      case '--ext': case '-e':
        args.ext = argv[++i]; break;
      case '--max-files': case '-m':
        args.maxFiles = parseInt(argv[++i], 10); break;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node workflow/gen-agents.js [options]

Options:
  --path, -p <dir>       目标项目根目录（默认：当前工作目录）
  --ext,  -e <exts>      扫描扩展名，逗号分隔（默认：.cs,.lua）
  --max-files, -m <n>    每种扩展名最多扫描文件数（默认：80）
  --help, -h             显示帮助

Examples:
  node workflow/gen-agents.js
  node workflow/gen-agents.js --path D:\\MyProject
  node workflow/gen-agents.js --path D:\\MyProject --ext .cs,.lua,.ts
  node workflow/gen-agents.js --path ../OtherProject --max-files 120
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Resolve target project root
  const projectRoot = args.path
    ? path.resolve(args.path)
    : process.cwd();

  // Parse extensions
  const extensions = args.ext
    ? args.ext.split(',').map(e => e.trim().startsWith('.') ? e.trim() : `.${e.trim()}`)
    : ['.cs', '.lua'];

  const maxFiles = args.maxFiles || 80;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  AGENTS.md Generator`);
  console.log(`  Target : ${projectRoot}`);
  console.log(`  Exts   : ${extensions.join(', ')}`);
  console.log(`  MaxFiles: ${maxFiles} per extension`);
  console.log(`${'='.repeat(60)}\n`);

  // Patch MemoryManager to use custom scan options for this run
  const manager = new MemoryManager(projectRoot);

  // Override buildGlobalContext to use custom extensions/maxFiles
  const origBuild = manager.buildGlobalContext.bind(manager);
  manager.buildGlobalContext = async function () {
    const { getProjectStructure, selectToolStrategy } = require('./tools/thick-tools');
    const fs = require('fs');

    const { strategy } = selectToolStrategy(projectRoot);
    console.log(`[gen-agents] Strategy: ${strategy}`);

    const { summary: structureSummary } = getProjectStructure(projectRoot, strategy === 'thick' ? 2 : 4);
    const packageList = manager._detectPackages();

    console.log(`[gen-agents] Scanning code symbols (${extensions.join(', ')})...`);
    const { summary: symbolsSummary } = scanCodeSymbols(projectRoot, {
      extensions,
      ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output', 'Library', 'Temp', 'obj', 'Packages'],
      maxFiles,
    });

    const content = manager._renderAgentsMd(structureSummary, packageList, strategy, symbolsSummary);
    fs.writeFileSync(manager.agentsMdPath, content, 'utf-8');
    console.log(`[gen-agents] AGENTS.md written: ${manager.agentsMdPath}`);
    return manager.agentsMdPath;
  };

  try {
    const outputPath = await manager.buildGlobalContext();
    const fs = require('fs');
    const stat = fs.statSync(outputPath);
    console.log(`\n✅ Done!`);
    console.log(`   File : ${outputPath}`);
    console.log(`   Size : ${(stat.size / 1024).toFixed(1)} KB`);

    // Auto-populate experience store from scanned code
    console.log(`\n[gen-agents] Populating experience store from scanned code...`);
    try {
      const { execSync } = require('child_process');
      const genExpScript = path.join(__dirname, 'workflow', 'gen-experiences.js');
      const scriptPath = path.join(__dirname, 'gen-experiences.js');
      const target = fs.existsSync(scriptPath) ? scriptPath : genExpScript;
      if (fs.existsSync(target)) {
        execSync(`node "${target}" --path "${projectRoot}" --ext "${extensions.join(',')}" --max-files ${maxFiles}`, {
          stdio: 'inherit',
          cwd: path.dirname(target),
        });
      }
    } catch (expErr) {
      console.warn(`[gen-agents] Experience store update skipped: ${expErr.message}`);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
