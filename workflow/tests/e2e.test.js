/**
 * End-to-End Test Suite for the Multi-Agent Workflow
 *
 * Covers:
 *  1. Full six-stage pipeline (INIT → FINISHED)
 *  2. Checkpoint resume (interrupt and restart)
 *  3. Agent boundary violation detection
 *  4. File-reference communication protocol enforcement
 *  5. Socratic engine decision persistence
 *  6. Tool strategy selection (thin vs thick)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ─── Test Utilities ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message = '') {
  assert.strictEqual(actual, expected, message || `Expected "${expected}", got "${actual}"`);
}

function assertExists(filePath, message = '') {
  assert.ok(fs.existsSync(filePath), message || `File should exist: ${filePath}`);
}

function assertContains(str, substring, message = '') {
  assert.ok(str.includes(substring), message || `Expected string to contain "${substring}"`);
}

// ─── Mock LLM ─────────────────────────────────────────────────────────────────

/**
 * Mock LLM that returns deterministic responses based on prompt content.
 * Allows testing without a real LLM API.
 */
async function mockLlmCall(prompt) {
  if (prompt.includes('Requirement Analysis Agent') || prompt.includes('requirement')) {
    return `# Requirements\n\n## Overview\nA test application.\n\n## User Stories\n- As a user, I want to test the workflow.\n\n## Acceptance Criteria\n1. WHEN the workflow runs THEN it produces all artifacts.\n\n## Out of Scope\n- Production deployment\n\n## Open Questions\n- None`;
  }
  if (prompt.includes('Architecture Design Agent') || prompt.includes('architecture')) {
    return `# Architecture\n\n## Architecture Overview\nSimple layered architecture.\n\n## Component Breakdown\n- API Layer\n- Service Layer\n- Data Layer\n\n## Data Flow\nClient → API → Service → Data\n\n## Technology Stack\n- Node.js\n\n## Interface Contracts\n- GET /api/items\n\n## Non-Functional Requirements\n- Response time < 200ms\n\n## Risk Assessment\n- Low risk\n\n## Open Architecture Questions\n- None`;
  }
  if (prompt.includes('Code Development Agent') || prompt.includes('diff')) {
    return `--- a/src/api.js\n+++ b/src/api.js\n@@ -0,0 +1,5 @@\n+const express = require('express');\n+const app = express();\n+app.get('/api/items', (req, res) => res.json([]));\n+app.listen(3000);\n+module.exports = app;`;
  }
  if (prompt.includes('Quality Testing Agent') || prompt.includes('test')) {
    return `# Test Report\n\n## Test Summary\nAll tests passed. Confidence: 95%\n\n## Test Cases Executed\n| ID | Description | Status |\n|----|-------------|--------|\n| T1 | API returns 200 | PASS |\n\n## Defects Found\nNo defects found.\n\n## Coverage Analysis\nAll acceptance criteria covered.\n\n## Risk Assessment\nLow risk.\n\n## Recommendations\nNone.\n\n## Regression Checklist\n- [ ] Verify API endpoint`;
  }
  return `Mock LLM response for: ${prompt.slice(0, 50)}...`;
}

// ─── Test Setup / Teardown ────────────────────────────────────────────────────

const TEST_OUTPUT_DIR = path.join(__dirname, '..', 'output', '_test');
const TEST_MANIFEST = path.join(__dirname, '..', '_test_manifest.json');

function cleanupTestFiles() {
  if (fs.existsSync(TEST_MANIFEST)) fs.unlinkSync(TEST_MANIFEST);
  if (fs.existsSync(TEST_OUTPUT_DIR)) fs.rmSync(TEST_OUTPUT_DIR, { recursive: true });
}

// ─── Test Cases ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('  Multi-Agent Workflow – End-to-End Test Suite');
  console.log('='.repeat(60) + '\n');

  // ── Test 1: StateMachine – fresh start ──────────────────────────────────────
  await test('StateMachine: creates fresh manifest on init', async () => {
    const { StateMachine } = require('../core/state-machine');
    const { PATHS } = require('../core/constants');

    // Use a temp manifest path
    const origManifest = PATHS.MANIFEST;
    PATHS.MANIFEST = TEST_MANIFEST;

    const sm = new StateMachine('test-project-1');
    const state = await sm.init();
    assertEqual(state, 'INIT');
    assertExists(TEST_MANIFEST);

    const manifest = JSON.parse(fs.readFileSync(TEST_MANIFEST, 'utf-8'));
    assertEqual(manifest.currentState, 'INIT');
    assertEqual(manifest.projectId, 'test-project-1');

    PATHS.MANIFEST = origManifest;
    fs.unlinkSync(TEST_MANIFEST);
  });

  // ── Test 2: StateMachine – state transitions ─────────────────────────────────
  await test('StateMachine: transitions through all states correctly', async () => {
    const { StateMachine } = require('../core/state-machine');
    const { PATHS } = require('../core/constants');
    const { STATE_ORDER } = require('../core/types');

    PATHS.MANIFEST = TEST_MANIFEST;
    const sm = new StateMachine('test-project-2');
    await sm.init();

    for (let i = 0; i < STATE_ORDER.length - 1; i++) {
      const newState = await sm.transition(null, `Test transition ${i}`);
      assertEqual(newState, STATE_ORDER[i + 1]);
    }

    assert.ok(sm.isFinished(), 'Should be finished after all transitions');
    PATHS.MANIFEST = require('../core/constants').PATHS.MANIFEST;
    fs.unlinkSync(TEST_MANIFEST);
  });

  // ── Test 3: StateMachine – checkpoint resume ─────────────────────────────────
  await test('StateMachine: resumes from existing manifest', async () => {
    const { StateMachine } = require('../core/state-machine');
    const { PATHS } = require('../core/constants');

    PATHS.MANIFEST = TEST_MANIFEST;

    // First run: advance to ANALYSE
    const sm1 = new StateMachine('test-project-3');
    await sm1.init();
    await sm1.transition(null, 'First transition');

    // Second run: should resume from ANALYSE
    const sm2 = new StateMachine('test-project-3');
    const resumeState = await sm2.init();
    assertEqual(resumeState, 'ANALYSE', 'Should resume from ANALYSE state');

    PATHS.MANIFEST = require('../core/constants').PATHS.MANIFEST;
    fs.unlinkSync(TEST_MANIFEST);
  });

  // ── Test 4: FileRefBus – protocol enforcement ────────────────────────────────
  await test('FileRefBus: rejects raw content (direct text passing)', async () => {
    const { FileRefBus } = require('../core/file-ref-bus');
    const bus = new FileRefBus();

    // Create a temp file to publish
    const tmpFile = path.join(__dirname, '..', 'output', '_test_file.md');
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, 'test content', 'utf-8');

    // Valid: file path
    bus.publish('analyst', 'architect', tmpFile);
    const consumed = bus.consume('architect');
    assertEqual(consumed, tmpFile);

    // Invalid: raw content (long string with newlines)
    let threw = false;
    try {
      bus.publish('analyst', 'architect', 'This is raw content\nwith newlines\nthat should be rejected');
    } catch (err) {
      threw = true;
      assertContains(err.message, 'rejected');
    }
    assert.ok(threw, 'Should throw when raw content is passed');

    fs.unlinkSync(tmpFile);
  });

  // ── Test 5: Agent boundary violation ────────────────────────────────────────
  await test('BaseAgent: throws on forbidden action', async () => {
    const { BaseAgent } = require('../agents/base-agent');
    const { AgentRole } = require('../core/types');

    const agent = new BaseAgent(AgentRole.ANALYST, mockLlmCall);
    let threw = false;
    try {
      await agent.assertAllowed('write_code'); // Forbidden for analyst
    } catch (err) {
      threw = true;
      assertContains(err.message, 'Boundary violation');
    }
    assert.ok(threw, 'Should throw on forbidden action');
  });

  // ── Test 6: AnalystAgent – output validation ─────────────────────────────────
  await test('AnalystAgent: produces requirement.md with correct content', async () => {
    const { AnalystAgent } = require('../agents/analyst-agent');
    const { PATHS } = require('../core/constants');

    // Redirect output to test dir
    const origOutputDir = PATHS.OUTPUT_DIR;
    PATHS.OUTPUT_DIR = TEST_OUTPUT_DIR;
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

    const agent = new AnalystAgent(mockLlmCall);
    const outputPath = await agent.run(null, 'Build a simple todo app');

    assertExists(outputPath);
    const content = fs.readFileSync(outputPath, 'utf-8');
    assertContains(content, 'Requirements');

    PATHS.OUTPUT_DIR = origOutputDir;
    fs.rmSync(TEST_OUTPUT_DIR, { recursive: true });
  });

  // ── Test 7: Tool strategy selection ─────────────────────────────────────────
  await test('selectToolStrategy: returns thin for small project', async () => {
    const { selectToolStrategy } = require('../tools/thick-tools');
    const result = selectToolStrategy(path.join(__dirname, '..', 'core'));
    assertEqual(result.strategy, 'thin');
  });

  // ── Test 8: PromptBuilder – KV cache structure ───────────────────────────────
  await test('PromptBuilder: KV cache boundary present in prompt', async () => {
    const { buildKVCacheFriendlyPrompt } = require('../core/prompt-builder');
    const { prompt } = buildKVCacheFriendlyPrompt('Fixed prefix', 'Dynamic suffix');
    assertContains(prompt, 'KV_CACHE_BOUNDARY');
    assertContains(prompt, 'Fixed prefix');
    assertContains(prompt, 'Dynamic suffix');
  });

  // ── Test 9: PromptBuilder – noise detection ──────────────────────────────────
  await test('PromptBuilder: detects high token count and sets risk level', async () => {
    const { analysePromptNoise } = require('../core/prompt-builder');
    const longPrompt = 'x'.repeat(40000); // ~10000 tokens
    const analysis = analysePromptNoise(longPrompt);
    assert.ok(analysis.isHighRisk, 'Should flag as high risk');
    assert.ok(['high', 'critical'].includes(analysis.riskLevel));
  });

  // ── Test 10: SocraticEngine – decision persistence ───────────────────────────
  await test('SocraticEngine: persists and replays decisions', async () => {
    const { SocraticEngine, buildQuestion } = require('../core/socratic-engine');
    const decisionsFile = path.join(__dirname, '..', 'output', '_test_decisions.json');
    fs.mkdirSync(path.dirname(decisionsFile), { recursive: true });

    const engine = new SocraticEngine(decisionsFile);
    engine.clearDecisions();

    // Manually inject a decision (simulating a previous answer)
    const q = buildQuestion('test_q', 'Test question?', ['Option A', 'Option B']);
    engine._decisions['test_q'] = { optionIndex: 0, optionText: 'Option A', timestamp: new Date().toISOString() };
    engine._saveDecisions();

    // Second engine instance should load the cached decision
    const engine2 = new SocraticEngine(decisionsFile);
    const answer = await engine2.ask(q); // Should NOT prompt – uses cached answer
    assertEqual(answer.optionText, 'Option A');

    fs.unlinkSync(decisionsFile);
  });

  // ── Test 11: CommandRouter – dispatch ────────────────────────────────────────
  await test('CommandRouter: dispatches /help command', async () => {
    const { dispatch } = require('../commands/command-router');
    const result = await dispatch('/help', {});
    assertContains(result, 'Available Commands');
    assertContains(result, 'ask-workflow-agent');
  });

  // ── Test 12: CommandRouter – unknown command ─────────────────────────────────
  await test('CommandRouter: throws on unknown command', async () => {
    const { dispatch } = require('../commands/command-router');
    let threw = false;
    try {
      await dispatch('/nonexistent-command', {});
    } catch (err) {
      threw = true;
      assertContains(err.message, 'Unknown command');
    }
    assert.ok(threw);
  });

  // ── Test 13: TestRunner – passing command ────────────────────────────────────
  await test('TestRunner: detects passing test command (exit 0)', async () => {
    const { TestRunner } = require('../core/test-runner');
    const runner = new TestRunner({
      projectRoot: path.join(__dirname, '..'),
      testCommand: process.platform === 'win32' ? 'cmd /c exit 0' : 'exit 0',
      timeoutMs: 5000,
      verbose: false,
    });
    const result = runner.run();
    assert.ok(result.passed, 'Should report passed for exit code 0');
    assertEqual(result.exitCode, 0);
  });

  // ── Test 14: TestRunner – failing command ────────────────────────────────────
  await test('TestRunner: detects failing test command (exit 1)', async () => {
    const { TestRunner } = require('../core/test-runner');
    const runner = new TestRunner({
      projectRoot: path.join(__dirname, '..'),
      testCommand: process.platform === 'win32' ? 'cmd /c exit 1' : 'sh -c "exit 1"',
      timeoutMs: 5000,
      verbose: false,
    });
    const result = runner.run();
    assert.ok(!result.passed, 'Should report failed for exit code 1');
    assert.ok(result.exitCode !== 0, 'Exit code should be non-zero');
  });

  // ── Test 15: TestRunner – output parsing (Jest format) ───────────────────────
  await test('TestRunner: parses Jest-style test output correctly', async () => {
    const { TestRunner } = require('../core/test-runner');
    const runner = new TestRunner({
      projectRoot: path.join(__dirname, '..'),
      testCommand: 'echo dummy',
      timeoutMs: 5000,
      verbose: false,
    });
    // Test the parser directly
    const parsed = runner._parseOutput('Tests: 3 failed, 12 passed, 15 total\n● failing test 1\n● failing test 2');
    assertEqual(parsed.totalTests, 15);
    assertEqual(parsed.failedTests, 3);
    assert.ok(parsed.failureSummary.length > 0, 'Should extract failure messages');
  });

  // ── Test 16: TestRunner – formatResultAsMarkdown ─────────────────────────────
  await test('TestRunner: formatResultAsMarkdown produces valid Markdown', async () => {
    const { TestRunner } = require('../core/test-runner');
    const mockResult = {
      passed: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Error: test failed',
      output: 'Error: test failed',
      totalTests: 5,
      failedTests: 2,
      failureSummary: ['● test A failed', '● test B failed'],
      durationMs: 1234,
      command: 'npm test',
    };
    const md = TestRunner.formatResultAsMarkdown(mockResult);
    assertContains(md, '❌ FAILED');
    assertContains(md, 'npm test');
    assertContains(md, 'Failure Summary');
    assertContains(md, 'test A failed');
  });

  // ── Test 17: _applyFileReplacements – successful replacement ─────────────────
  await test('_applyFileReplacements: applies REPLACE_IN_FILE block to actual file', async () => {
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-apply-test-'));
    const targetFile = path.join(tmpDir, 'src', 'utils.js');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(targetFile, `function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n`, 'utf-8');

    // Simulate an Orchestrator instance with just the method we need
    const { Orchestrator } = require('../index');
    const orch = Object.create(Orchestrator.prototype);
    orch.projectRoot = tmpDir;

    const llmResponse = `
[REPLACE_IN_FILE]
file: src/utils.js
find: |
  function add(a, b) {
    return a + b;
  }
replace: |
  function add(a, b) {
    if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('Expected numbers');
    return a + b;
  }
[/REPLACE_IN_FILE]
`;

    const result = orch._applyFileReplacements(llmResponse);
    assertEqual(result.applied, 1, `Expected 1 applied, got ${result.applied}. Errors: ${result.errors.join(', ')}`);
    assertEqual(result.failed, 0);

    const updated = fs.readFileSync(targetFile, 'utf-8');
    assertContains(updated, 'TypeError');
    assertContains(updated, 'Expected numbers');

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ── Test 18: _applyFileReplacements – find text not found ────────────────────
  await test('_applyFileReplacements: reports failure when find text not in file', async () => {
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-apply-test-'));
    const targetFile = path.join(tmpDir, 'app.js');
    fs.writeFileSync(targetFile, `console.log('hello');\n`, 'utf-8');

    const { Orchestrator } = require('../index');
    const orch = Object.create(Orchestrator.prototype);
    orch.projectRoot = tmpDir;

    const llmResponse = `
[REPLACE_IN_FILE]
file: app.js
find: |
  function doesNotExist() {}
replace: |
  function doesNotExist() { return 42; }
[/REPLACE_IN_FILE]
`;

    const result = orch._applyFileReplacements(llmResponse);
    assertEqual(result.applied, 0);
    assertEqual(result.failed, 1);
    assertContains(result.errors[0], 'not found');

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ── Test 19: _applyFileReplacements – multiple blocks in one response ─────────
  await test('_applyFileReplacements: applies multiple blocks from one LLM response', async () => {
    const os = require('os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-apply-test-'));
    fs.writeFileSync(path.join(tmpDir, 'a.js'), `const x = 1;\n`, 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), `const y = 2;\n`, 'utf-8');

    const { Orchestrator } = require('../index');
    const orch = Object.create(Orchestrator.prototype);
    orch.projectRoot = tmpDir;

    const llmResponse = `
[REPLACE_IN_FILE]
file: a.js
find: |
  const x = 1;
replace: |
  const x = 100;
[/REPLACE_IN_FILE]

[REPLACE_IN_FILE]
file: b.js
find: |
  const y = 2;
replace: |
  const y = 200;
[/REPLACE_IN_FILE]
`;

    const result = orch._applyFileReplacements(llmResponse);
    assertEqual(result.applied, 2, `Expected 2 applied, got ${result.applied}. Errors: ${result.errors.join(', ')}`);
    assertEqual(result.failed, 0);

    assertContains(fs.readFileSync(path.join(tmpDir, 'a.js'), 'utf-8'), 'const x = 100');
    assertContains(fs.readFileSync(path.join(tmpDir, 'b.js'), 'utf-8'), 'const y = 200');

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ── Test 20: _applyFileReplacements – no blocks in response ──────────────────
  await test('_applyFileReplacements: reports failure when no blocks in response', async () => {
    const { Orchestrator } = require('../index');
    const orch = Object.create(Orchestrator.prototype);
    orch.projectRoot = process.cwd();

    const result = orch._applyFileReplacements('Sorry, I cannot fix this issue.');
    assertEqual(result.applied, 0);
    assertEqual(result.failed, 1);
    assertContains(result.errors[0], 'No [REPLACE_IN_FILE] blocks');
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60) + '\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
cleanupTestFiles();
runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
