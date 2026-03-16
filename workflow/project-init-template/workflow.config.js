/**
 * workflow.config.js – Project Workflow Configuration Template
 *
 * Copy this file to your project root and fill in the placeholders.
 * Replace all {PLACEHOLDER} values before use.
 */

'use strict';

module.exports = {
  // ─── Project Identity ────────────────────────────────────────────────────
  projectName: '{PROJECT_NAME}',
  techStack: '{TECH_STACK}',  // e.g. 'Flutter/Dart', 'Go', 'Python', 'Node.js'

  // ─── Source Scanning ─────────────────────────────────────────────────────
  sourceExtensions: ['{EXT1}', '{EXT2}'],  // e.g. ['.dart'], ['.go'], ['.py']
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],

  // ─── Automated Verification Loop ─────────────────────────────────────────
  //
  // IMPORTANT: Set testCommand to enable the automated verification loop.
  // When set, the workflow will:
  //   1. Run your real test suite after code generation
  //   2. If tests fail, automatically invoke DeveloperAgent to fix them
  //   3. Re-run tests (up to maxFixRounds times)
  //   4. Append real test results to the AI-generated test report
  //
  // Common examples:
  //   'npm test'           – Node.js / Jest / Mocha
  //   'flutter test'       – Flutter / Dart
  //   'pytest'             – Python
  //   'go test ./...'      – Go
  //   'dotnet test'        – .NET / C#
  //   'mvn test'           – Java / Maven
  //   'cargo test'         – Rust
  //
  testCommand: null,  // TODO: replace with your actual test command

  // testFramework: Hint for TestCaseExecutor to generate the correct test script format.
  //   'auto'   – auto-detect from package.json / project files (default, recommended)
  //   'jest'   – Jest (Node.js)
  //   'mocha'  – Mocha (Node.js)
  //   'vitest' – Vitest (Node.js)
  //   'pytest' – pytest (Python)
  //   'go'     – go test (Go)
  //
  testFramework: 'auto',

  autoFixLoop: {
    enabled: true,       // Set to false to disable auto-fix (report only)
    maxFixRounds: 2,     // Max fix-and-retest cycles before giving up
    failOnUnfixed: false, // true = fail workflow if tests still fail after all rounds
  },

  // ─── Built-in Skills ─────────────────────────────────────────────────────
  builtinSkills: [
    // Add project-specific skills here
    // { name: 'flutter-dev', description: 'Flutter development patterns', domains: ['flutter', 'dart'] }
  ],

  // ─── Default Skills ───────────────────────────────────────────────────────
  defaultSkills: {
    // Map file extensions to skill names
    // '{EXT}': '{SKILL_NAME}'
  },

  // ─── Context Loader: Skill Auto-injection ────────────────────────────────
  //
  // ContextLoader automatically injects relevant skill files and ADR entries
  // into every Agent prompt based on keyword matching. No manual reading needed.
  //
  // alwaysLoadSkills: Skills to inject into EVERY prompt, regardless of keywords.
  //   Use for project-wide conventions that all agents must always know.
  //   Example: ['flutter-dev'] for a Flutter project
  //
  // skillKeywords: Extra keyword→skill mappings to extend the built-in defaults.
  //   Key = skill file name (without .md), Value = array of trigger keywords.
  //   Example: { 'flutter-dev': ['widget', 'riverpod', 'bloc', 'provider'] }
  //
  alwaysLoadSkills: [],   // TODO: add project-wide skills, e.g. ['flutter-dev']
  skillKeywords: {},      // TODO: add custom keyword mappings if needed

  // ─── Classification Rules ─────────────────────────────────────────────────
  classificationRules: [],

  // ─── Git PR Workflow ──────────────────────────────────────────────────────
  //
  // When enabled, the Orchestrator will automatically create a feature branch,
  // commit all workflow artifacts, and create a PR/MR at the end of each run.
  //
  // Prerequisites: git repository + GitHub CLI (gh) or GitLab CLI (glab)
  //
  git: {
    enabled:    false,        // Set to true to activate
    baseBranch: 'main',       // Target branch for the PR
    branchType: 'feat',       // Branch prefix: feat | fix | chore | refactor
    autoPush:   false,        // Push branch to remote before creating PR
    draft:      false,        // Create PR as draft
    labels:     [],           // e.g. ['ai-generated', 'needs-review']
    reviewers:  [],           // e.g. ['alice', 'bob']
  },

  // ─── Dry-Run / Sandbox Mode ───────────────────────────────────────────────
  //
  // When dryRun: true, ALL file writes are intercepted and recorded as pending
  // operations. The real FS is never touched. Call sandbox.apply() to commit.
  //
  sandbox: {
    dryRun: false,            // Set to true to enable dry-run / preview mode
  },
};
