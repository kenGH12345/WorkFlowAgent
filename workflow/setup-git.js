#!/usr/bin/env node
/**
 * setup-git.js – One-command interactive Git PR workflow setup
 *
 * Usage:
 *   node workflow/setup-git.js
 *   npm run setup:git   (from workflow/ directory)
 *
 * What it does:
 *  1. Checks if git and gh CLI are installed
 *  2. Checks if gh is authenticated (runs gh auth status)
 *  3. Prompts user for Git PR config options
 *  4. Writes the git section into workflow.config.js
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');
const inquirer = require('inquirer');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryExec(cmd) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] }).trim() };
  } catch (e) {
    return { ok: false, output: e.message };
  }
}

function colorize(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green  = t => colorize(t, '32');
const yellow = t => colorize(t, '33');
const red    = t => colorize(t, '31');
const bold   = t => colorize(t, '1');
const cyan   = t => colorize(t, '36');

// ─── Pre-flight Checks ────────────────────────────────────────────────────────

function checkPrerequisites() {
  console.log('\n' + bold('🔍 Checking prerequisites...\n'));

  // Check git
  const git = tryExec('git --version');
  if (git.ok) {
    console.log(green('  ✅ git:'), git.output);
  } else {
    console.log(red('  ❌ git: not found. Please install Git first.'));
    process.exit(1);
  }

  // Check gh CLI
  const gh = tryExec('gh --version');
  if (gh.ok) {
    console.log(green('  ✅ gh CLI:'), gh.output.split('\n')[0]);
  } else {
    console.log(yellow('  ⚠️  gh CLI: not found.'));
    console.log(yellow('     Install from: https://cli.github.com/'));
    console.log(yellow('     Git config will be saved, but auto PR creation will be disabled.\n'));
    return { ghAvailable: false };
  }

  // Check gh auth status
  const ghAuth = tryExec('gh auth status');
  if (ghAuth.ok) {
    console.log(green('  ✅ gh auth: authenticated'));
  } else {
    console.log(yellow('  ⚠️  gh auth: not logged in.'));
    console.log(yellow('     Run: gh auth login'));
    console.log(yellow('     Auto PR creation will fail until you authenticate.\n'));
    return { ghAvailable: true, ghAuthed: false };
  }

  console.log('');
  return { ghAvailable: true, ghAuthed: true };
}

// ─── Config File Helpers ──────────────────────────────────────────────────────

function findConfigFile() {
  // Search from cwd upward for workflow.config.js
  const candidates = [
    path.join(process.cwd(), 'workflow.config.js'),
    path.join(process.cwd(), 'workflow', 'workflow.config.js'),
    path.join(__dirname, 'workflow.config.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function patchConfigFile(configPath, answers) {
  let content = fs.readFileSync(configPath, 'utf-8');

  const labels    = answers.labels
    ? answers.labels.split(',').map(s => `'${s.trim()}'`).filter(Boolean).join(', ')
    : '';
  const reviewers = answers.reviewers
    ? answers.reviewers.split(',').map(s => `'${s.trim()}'`).filter(Boolean).join(', ')
    : '';

  const newGitBlock = `  git: {
    enabled:    true,
    baseBranch: '${answers.baseBranch}',
    branchType: '${answers.branchType}',
    autoPush:   ${answers.autoPush},
    draft:      ${answers.draft},
    labels:     [${labels}],
    reviewers:  [${reviewers}],
  },`;

  // Replace existing git block
  const gitBlockRegex = /\/\/\s*─+\s*Git PR Workflow[\s\S]*?git:\s*\{[\s\S]*?\},/;
  if (gitBlockRegex.test(content)) {
    content = content.replace(gitBlockRegex, (match) => {
      // Keep the comment header, replace only the git: { ... } object
      return match.replace(/git:\s*\{[\s\S]*?\},/, newGitBlock);
    });
  } else {
    // Fallback: replace just the git: block
    const simpleRegex = /git:\s*\{[\s\S]*?\},/;
    if (simpleRegex.test(content)) {
      content = content.replace(simpleRegex, newGitBlock);
    } else {
      console.log(yellow('\n  ⚠️  Could not find git: block in config. Please update manually.'));
      console.log(cyan('\n  Add this to your workflow.config.js:\n'));
      console.log(cyan(newGitBlock));
      return false;
    }
  }

  fs.writeFileSync(configPath, content, 'utf-8');
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold(cyan('\n╔══════════════════════════════════════════╗')));
  console.log(bold(cyan('║   WorkFlowAgent – Git PR Setup Wizard    ║')));
  console.log(bold(cyan('╚══════════════════════════════════════════╝')));

  const { ghAvailable, ghAuthed } = checkPrerequisites();

  // Prompt user for config
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseBranch',
      message: 'Target base branch for PRs:',
      default: 'main',
    },
    {
      type: 'list',
      name: 'branchType',
      message: 'Default branch type prefix:',
      choices: ['feat', 'fix', 'chore', 'refactor'],
      default: 'feat',
    },
    {
      type: 'confirm',
      name: 'autoPush',
      message: 'Auto-push branch to remote before creating PR?',
      default: true,
    },
    {
      type: 'confirm',
      name: 'draft',
      message: 'Create PRs as draft by default?',
      default: false,
    },
    {
      type: 'input',
      name: 'labels',
      message: 'Default PR labels (comma-separated, leave blank to skip):',
      default: '',
    },
    {
      type: 'input',
      name: 'reviewers',
      message: 'Default PR reviewers (GitHub usernames, comma-separated, leave blank to skip):',
      default: '',
    },
  ]);

  // Find and patch config file
  const configPath = findConfigFile();
  if (!configPath) {
    console.log(red('\n❌ workflow.config.js not found.'));
    console.log(yellow('   Run: node workflow/init-project.js  first to generate the config.\n'));
    process.exit(1);
  }

  const patched = patchConfigFile(configPath, answers);

  // Summary
  console.log('\n' + bold('─'.repeat(50)));
  if (patched) {
    console.log(green('\n✅ Git PR workflow configured successfully!\n'));
    console.log(`   Config file: ${cyan(configPath)}`);
    console.log(`   Base branch: ${cyan(answers.baseBranch)}`);
    console.log(`   Branch type: ${cyan(answers.branchType)}`);
    console.log(`   Auto push:   ${cyan(String(answers.autoPush))}`);
    console.log(`   Draft PRs:   ${cyan(String(answers.draft))}`);
  }

  if (!ghAvailable) {
    console.log(yellow('\n⚠️  Next step: Install GitHub CLI to enable auto PR creation'));
    console.log(yellow('   https://cli.github.com/\n'));
  } else if (!ghAuthed) {
    console.log(yellow('\n⚠️  Next step: Authenticate GitHub CLI'));
    console.log(cyan('   gh auth login\n'));
  } else {
    console.log(green('\n🚀 All set! The workflow will auto-create PRs on next run.\n'));
  }
}

main().catch(err => {
  console.error(red('\n❌ Setup failed: ' + err.message));
  process.exit(1);
});
