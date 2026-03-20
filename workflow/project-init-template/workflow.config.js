/**
 * workflow.config.js – Project Workflow Configuration Template
 *
 * Copy this file to your project root and customise as needed.
 * Most fields are auto-detected at runtime — only override when needed.
 *
 * Auto-detected fields (no config needed):
 *   - projectName        → from directory name
 *   - techStack          → from project files (package.json, pubspec.yaml, go.mod, etc.)
 *   - sourceExtensions   → from detected tech stack
 *   - ignoreDirs         → from detected tech stack
 *
 * CodeGraph auto-scans ALL supported languages (.js, .ts, .cs, .lua, .go, .py, .dart).
 * No manual extension configuration is required.
 */

'use strict';

module.exports = {
  // ─── Runtime-Detected (uncomment only to override auto-detection) ─────
  // projectName: '{PROJECT_NAME}',
  // techStack: '{TECH_STACK}',
  // sourceExtensions: ['{EXT1}', '{EXT2}'],
  // ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],

  // ─── Code Graph ──────────────────────────────────────────────────────────
  codeGraph: {
    scopeDirs: [],             // Large monorepo only: ['packages/core']. Empty = full scan
  },

  // ─── Automated Verification Loop ─────────────────────────────────────────
  //
  // Set testCommand to enable the automated verification loop.
  // Examples:
  //   'npm test'           – Node.js / Jest / Mocha
  //   'flutter test'       – Flutter / Dart
  //   'pytest'             – Python
  //   'go test ./...'      – Go
  //   'dotnet test'        – .NET / C#
  //
  testCommand: null,  // TODO: replace with your actual test command

  testFramework: 'auto',

  autoFixLoop: {
    enabled: true,
    maxFixRounds: 2,
    failOnUnfixed: false,
  },

  // ─── Built-in Skills ─────────────────────────────────────────────────────
  builtinSkills: [],

  // ─── Default Skills ───────────────────────────────────────────────────────
  defaultSkills: {},

  // ─── Skill Auto-injection ────────────────────────────────────────────────
  globalSkills: ['standards', 'troubleshooting'],
  projectSkills: [],
  alwaysLoadSkills: [],
  skillKeywords: {},

  // ─── Classification Rules ─────────────────────────────────────────────────
  classificationRules: [],

  // ─── Git PR Workflow ──────────────────────────────────────────────────────
  git: {
    enabled:    false,
    baseBranch: 'main',
    branchType: 'feat',
    autoPush:   false,
    draft:      false,
    labels:     [],
    reviewers:  [],
  },

  // ─── Dry-Run / Sandbox Mode ───────────────────────────────────────────────
  sandbox: {
    dryRun: false,
  },
};
