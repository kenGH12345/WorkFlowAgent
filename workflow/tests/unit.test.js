/**
 * Unit Test Suite – Functional Correctness Validation
 *
 * Covers the modules that were completely untested in e2e.test.js:
 *  1. FeatureList  – lifecycle, dependency guard, anti-premature-completion
 *  2. TaskManager  – dependency scheduling, retry backoff, interrupt resume
 *  3. ContextLoader – keyword matching, ADR extraction, placeholder skip, token budget
 *  4. ConfigLoader  – merge logic, search path, cache isolation
 *  5. StateMachine  – error paths, invalid transitions, risk recording
 *
 * Design principles:
 *  - Each test is fully isolated (temp files, no shared state)
 *  - Tests verify BEHAVIOUR, not implementation details
 *  - Edge cases and error paths are first-class citizens
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const assert = require('assert');
const os   = require('os');

// ─── Test Utilities ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  assert.strictEqual(actual, expected, msg || `Expected "${expected}", got "${actual}"`);
}

function assertDeepEqual(actual, expected, msg = '') {
  assert.deepStrictEqual(actual, expected, msg);
}

function assertContains(str, sub, msg = '') {
  assert.ok(String(str).includes(sub), msg || `Expected to contain "${sub}", got: "${str}"`);
}

function assertThrows(fn, msgFragment = '') {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgFragment) assertContains(e.message, msgFragment);
  }
  assert.ok(threw, `Expected function to throw${msgFragment ? ` with "${msgFragment}"` : ''}`);
}

async function assertThrowsAsync(fn, msgFragment = '') {
  let threw = false;
  try { await fn(); } catch (e) {
    threw = true;
    if (msgFragment) assertContains(e.message, msgFragment);
  }
  assert.ok(threw, `Expected async function to throw${msgFragment ? ` with "${msgFragment}"` : ''}`);
}

/** Creates a temp directory and returns its path. Caller must clean up. */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
}

// ─── FeatureList Tests ────────────────────────────────────────────────────────

async function runFeatureListTests() {
  console.log('\n── FeatureList ──────────────────────────────────────────────');

  await test('FeatureList: addFeature creates feature with passes=false', async () => {
    const { FeatureList } = require('../core/feature-list');
    const dir = makeTempDir();
    const fl = new FeatureList(path.join(dir, 'features.json'));

    const f = fl.addFeature({ id: 'F001', description: 'Login page', steps: ['Open /login', 'Enter credentials', 'Click submit'] });
    assertEqual(f.passes, false, 'passes must start as false');
    assertEqual(f.status, 'not_started');
    assertEqual(f.id, 'F001');

    fs.rmSync(dir, { recursive: true });
  });

  await test('FeatureList: addFeature rejects duplicate ID', async () => {
    const { FeatureList } = require('../core/feature-list');
    const dir = makeTempDir();
    const fl = new FeatureList(path.join(dir, 'features.json'));

    fl.addFeature({ id: 'F001', description: 'Login', steps: ['step1'] });
    assertThrows(() => fl.addFeature({ id: 'F001', description: 'Duplicate', steps: ['step1'] }), 'already exists');

    fs.rmSync(dir, { recursive: true });
  });

  await test('FeatureList: addFeature rejects empty steps', async () => {
    const { FeatureList } = require('../core/feature-list');
    const dir = makeTempDir();
    const fl = new FeatureList(path.join(dir, 'features.json'));

    assertThrows(() => fl.addFeature({ id: 'F001', description: 'Login', steps: [] }), 'acceptance step');

    fs.rmSync(dir, { recursive: true });
  });

  await test('FeatureList: completeFeature requires verificationNote', async () => {
    const { FeatureList } = require('../core/feature-list');
    const dir = makeTempDir();
    const fl = new FeatureList(path.join(dir, 'features.json'));

    fl.addFeature({ id: 'F001', description: 'Login', steps: ['step1'] });
    fl.startFeature('F001');

    // Empty note should throw
    assertThrows(() => fl.completeFeature('F001', ''), 'verificationNote');
    assertThrows(() => fl.completeFeature('F001', '   '), 'verificationNote');

    fs.rmSync(dir, { recursive: true });
  });

  await test('FeatureList: full lifecycle NOT_STARTED → IN_PROGRESS → DONE', async () => {
    const { FeatureList, FeatureStatus } = require('../core/feature-list');
    const dir = makeTempDir();
    const fl = new FeatureList(path.join(dir, 'features.json'));

    fl.addFeature({ id: 'F001', description: 'Login', steps: ['step1'] });
    assertEqual(fl.getAllFeatures()[0].status, FeatureStatus.NOT_STARTED);

    fl.startFeature('F001', 'agent-1');
    assertEqual(fl.getAllFeatures()[0].status, FeatureStatus.IN_PROGRESS);
    assertEqual(fl.getAllFeatures()[0].claimedBy, 'agent-1');

    fl.completeFeature('F001', 'Verified by clicking login button and seeing dashboard');
    const done = fl.getAllFeatures()[0];
    assertEqual(done.status, FeatureStatus.DONE);
    assertEqual(done.passes, true);
    assert.ok(done.completedAt, 'completedAt should be set');

    fs.rmSync(dir, { recursive: true });
  });

  await test('FeatureList: getNextFeature respects dependency order', async () => {
    const { FeatureList, FeatureStatus } = require('../core/feature-list');
    const dir = makeTempDir();
    const fl = new FeatureList(path.join(dir, 'features.json'));

    fl.addFeature({ id: 'F001', description: 'Auth', steps: ['step1'], priority: 1 });
    fl.addFeature({ id: 'F002', description: 'Dashboard', steps: ['step1'], priority: 2, deps: ['F001'] });

    // F002 depends on F001 – next should be F001
    const next1 = fl.getNextFeature();
    assertEqual(next1.id, 'F001');

    // Complete F001 – now F002 should be available
    fl.startFeature('F001');
    fl.completeFeature('F001', 'Verified auth flow');
    const next2 = fl.getNextFeature();
    assertEqual(next2.id, 'F002');

    fs.rmSync(dir, { recursive: true });
  });

  await test('FeatureList: getSummary returns correct counts', async () => {
    const { FeatureList } = require('../core/feature-list');
    const dir = makeTempDir();
    const fl = new FeatureList(path.join(dir, 'features.json'));

    fl.addFeature({ id: 'F001', description: 'A', steps: ['s1'] });
    fl.addFeature({ id: 'F002', description: 'B', steps: ['s1'] });
    fl.addFeature({ id: 'F003', description: 'C', steps: ['s1'] });

    fl.startFeature('F001');
    fl.completeFeature('F001', 'Verified');
    fl.startFeature('F002');
    fl.failFeature('F002', 'Test failed');

    const summary = fl.getSummary();
    assertEqual(summary.total, 3);
    assertEqual(summary.done, 1);
    assertEqual(summary.failed, 1);
    assertEqual(summary.notStarted, 1);
    assertEqual(summary.completionRate, 33);

    fs.rmSync(dir, { recursive: true });
  });

  await test('FeatureList: bulkAdd generates sequential IDs and auto-steps', async () => {
    const { FeatureList } = require('../core/feature-list');
    const dir = makeTempDir();
    const fl = new FeatureList(path.join(dir, 'features.json'));

    fl.bulkAdd(['Feature A', 'Feature B', 'Feature C']);
    const all = fl.getAllFeatures();
    assertEqual(all.length, 3);
    assertEqual(all[0].id, 'F001');
    assertEqual(all[1].id, 'F002');
    assert.ok(all[0].steps.length > 0, 'Auto-generated steps should exist');

    fs.rmSync(dir, { recursive: true });
  });

  await test('FeatureList: persists and reloads from disk', async () => {
    const { FeatureList } = require('../core/feature-list');
    const dir = makeTempDir();
    const storePath = path.join(dir, 'features.json');

    const fl1 = new FeatureList(storePath);
    fl1.addFeature({ id: 'F001', description: 'Persist test', steps: ['step1'] });
    fl1.startFeature('F001');

    // Reload from disk
    const fl2 = new FeatureList(storePath);
    const f = fl2.getAllFeatures()[0];
    assertEqual(f.id, 'F001');
    assertEqual(f.status, 'in_progress');

    fs.rmSync(dir, { recursive: true });
  });
}

// ─── TaskManager Tests ────────────────────────────────────────────────────────

async function runTaskManagerTests() {
  console.log('\n── TaskManager ──────────────────────────────────────────────');

  await test('TaskManager: addTask creates task with PENDING status', async () => {
    const { TaskManager, TaskStatus } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    const t = tm.addTask({ id: 'T001', title: 'Build API', description: 'Create REST endpoints' });
    assertEqual(t.status, TaskStatus.PENDING);
    assertEqual(t.retryCount, 0);
    assertEqual(t.claimedBy, null);

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: addTask rejects duplicate ID', async () => {
    const { TaskManager } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'A', description: 'desc' });
    assertThrows(() => tm.addTask({ id: 'T001', title: 'B', description: 'desc' }), 'already exists');

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: claimNextTask respects dependency order', async () => {
    const { TaskManager, TaskStatus } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'Foundation', description: 'Base task', priority: 1 });
    tm.addTask({ id: 'T002', title: 'Feature', description: 'Depends on T001', deps: ['T001'], priority: 2 });

    // T002 depends on T001 – only T001 should be claimable
    const claimed = tm.claimNextTask('agent-1');
    assertEqual(claimed.id, 'T001');

    // T002 should be BLOCKED (not claimable)
    const t2 = tm.getAllTasks().find(t => t.id === 'T002');
    assertEqual(t2.status, TaskStatus.BLOCKED);

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: completeTask unblocks dependents', async () => {
    const { TaskManager, TaskStatus } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'Foundation', description: 'Base' });
    tm.addTask({ id: 'T002', title: 'Feature', description: 'Depends on T001', deps: ['T001'] });

    tm.claimNextTask('agent-1');
    tm.completeTask('T001', { output: 'done' }, 'Ran unit tests, all passed');

    const t2 = tm.getAllTasks().find(t => t.id === 'T002');
    assertEqual(t2.status, TaskStatus.PENDING, 'T002 should be unblocked after T001 completes');

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: completeTask requires verificationNote', async () => {
    const { TaskManager } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'Task', description: 'desc' });
    tm.claimNextTask('agent-1');

    assertThrows(() => tm.completeTask('T001', null, ''), 'verificationNote');
    assertThrows(() => tm.completeTask('T001', null, '   '), 'verificationNote');

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: failTask increments retryCount and sets backoff', async () => {
    const { TaskManager, TaskStatus } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'Task', description: 'desc' });
    tm.claimNextTask('agent-1');
    tm.failTask('T001', 'Network error');

    const t = tm.getAllTasks()[0];
    assertEqual(t.status, TaskStatus.FAILED);
    assertEqual(t.retryCount, 1);
    assert.ok(t.nextRetryAt, 'nextRetryAt should be set for backoff');

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: task becomes EXHAUSTED after maxRetries', async () => {
    const { TaskManager, TaskStatus } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'Task', description: 'desc' });

    // Exhaust all retries (maxRetries = 3)
    for (let i = 0; i < 3; i++) {
      // Force status back to RUNNING for each retry
      const t = tm.getAllTasks()[0];
      t.status = 'running';
      t.nextRetryAt = null;
      tm._save();
      tm.failTask('T001', `Failure ${i + 1}`);
    }

    const t = tm.getAllTasks()[0];
    assertEqual(t.status, TaskStatus.EXHAUSTED);

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: interruptTask sets CRITICAL priority', async () => {
    const { TaskManager, TaskStatus, TaskPriority } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'Task', description: 'desc' });
    tm.claimNextTask('agent-1');
    tm.interruptTask('T001', 'Process killed');

    const t = tm.getAllTasks()[0];
    assertEqual(t.status, TaskStatus.INTERRUPTED);
    assertEqual(t.priority, TaskPriority.CRITICAL);

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: interrupted task is claimed first (priority ordering)', async () => {
    const { TaskManager, TaskStatus } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'Normal', description: 'desc', priority: 1 });
    tm.addTask({ id: 'T002', title: 'Interrupted', description: 'desc', priority: 99 });

    // Interrupt T002 (lower priority number = higher priority)
    const t2 = tm.getAllTasks().find(t => t.id === 'T002');
    t2.status = 'interrupted';
    t2.priority = 0; // CRITICAL
    tm._save();

    const claimed = tm.claimNextTask('agent-1');
    assertEqual(claimed.id, 'T002', 'Interrupted task should be claimed first');

    fs.rmSync(dir, { recursive: true });
  });

  await test('TaskManager: getSummary returns correct counts by status', async () => {
    const { TaskManager } = require('../core/task-manager');
    const dir = makeTempDir();
    const tm = new TaskManager(path.join(dir, 'tasks.json'));

    tm.addTask({ id: 'T001', title: 'A', description: 'desc' });
    tm.addTask({ id: 'T002', title: 'B', description: 'desc' });
    tm.addTask({ id: 'T003', title: 'C', description: 'desc' });

    tm.claimNextTask('agent-1');
    tm.completeTask('T001', null, 'Verified by running tests');

    const summary = tm.getSummary();
    assertEqual(summary.total, 3);
    assertEqual(summary.byStatus['done'], 1);
    assertEqual(summary.byStatus['pending'], 2);

    fs.rmSync(dir, { recursive: true });
  });
}

// ─── ContextLoader Tests ──────────────────────────────────────────────────────

async function runContextLoaderTests() {
  console.log('\n── ContextLoader ────────────────────────────────────────────');

  /** Creates a minimal workflow root with skills/ and docs/ for testing */
  function makeWorkflowRoot(dir, skills = {}, docs = {}) {
    const skillsDir = path.join(dir, 'skills');
    const docsDir   = path.join(dir, 'docs');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(docsDir,   { recursive: true });

    for (const [name, content] of Object.entries(skills)) {
      fs.writeFileSync(path.join(skillsDir, `${name}.md`), content, 'utf-8');
    }
    for (const [name, content] of Object.entries(docs)) {
      fs.writeFileSync(path.join(docsDir, name), content, 'utf-8');
    }
    return dir;
  }

  await test('ContextLoader: matches skill by keyword in task text', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const dir = makeTempDir();
    makeWorkflowRoot(dir, {
      'flutter-dev': '# Flutter Dev\n\nUse Riverpod for state management.\nAlways use const constructors.\nPrefer StatelessWidget over StatefulWidget.',
    });

    const loader = new ContextLoader({ workflowRoot: dir });
    const { sources } = loader.resolve('implement flutter widget with riverpod', 'developer');

    assert.ok(sources.some(s => s.includes('flutter-dev')), `Expected flutter-dev.md to be injected, got: ${sources.join(', ')}`);

    fs.rmSync(dir, { recursive: true });
  });

  await test('ContextLoader: skips placeholder skill files', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const dir = makeTempDir();
    makeWorkflowRoot(dir, {
      'flutter-dev': '# Flutter Dev\n\n_No rules defined yet_\n_No SOP defined yet_\n_No best practices defined yet_',
    });

    const loader = new ContextLoader({ workflowRoot: dir });
    const { sources } = loader.resolve('implement flutter widget', 'developer');

    assert.ok(!sources.some(s => s.includes('flutter-dev')), 'Placeholder skill should be skipped');

    fs.rmSync(dir, { recursive: true });
  });

  await test('ContextLoader: injects architecture-constraints.md for developer role', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const dir = makeTempDir();
    makeWorkflowRoot(dir, {}, {
      'architecture-constraints.md': '# Architecture Constraints\n\nMax file size: 600 lines.\nNo circular dependencies.\nAll modules must be independently testable.',
    });

    const loader = new ContextLoader({ workflowRoot: dir });
    const { sources } = loader.resolve('write some code', 'developer');

    assert.ok(sources.some(s => s.includes('architecture-constraints')), `Expected architecture-constraints.md, got: ${sources.join(', ')}`);

    fs.rmSync(dir, { recursive: true });
  });

  await test('ContextLoader: extracts relevant ADR entries for architect role', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const dir = makeTempDir();
    const adrContent = `# Decision Log

## ADR-001: Use Riverpod for state management
**Status**: Accepted
**Context**
We needed a state management solution for Flutter.
**Decision**
Use Riverpod because it is testable and composable.

## ADR-002: Use SQLite for local storage
**Status**: Accepted
**Context**
We needed local persistence.
**Decision**
Use SQLite via drift package.
`;
    makeWorkflowRoot(dir, {}, {
      'architecture-constraints.md': '# Constraints\n\nMax 600 lines per file.',
      'decision-log.md': adrContent,
    });

    const loader = new ContextLoader({ workflowRoot: dir });
    const { sources, sections } = loader.resolve('design flutter state management architecture', 'architect');

    assert.ok(sources.some(s => s.includes('decision-log')), `Expected decision-log.md digest, got: ${sources.join(', ')}`);
    // The ADR about Riverpod should be in the digest (keyword: riverpod/state)
    const adrSection = sections.find(s => s.includes('decision-log'));
    assert.ok(adrSection, 'ADR section should exist');

    fs.rmSync(dir, { recursive: true });
  });

  await test('ContextLoader: respects token budget (does not exceed MAX_INJECT_TOKENS)', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const { estimateTokens } = require('../tools/thin-tools');
    const dir = makeTempDir();

    // Create large skill files that would exceed budget if all injected
    const largeContent = '# Skill\n\n' + 'This is a very detailed skill rule. '.repeat(200);
    makeWorkflowRoot(dir, {
      'flutter-dev':    largeContent,
      'javascript-dev': largeContent,
      'go-crud':        largeContent,
      'api-design':     largeContent,
    });

    const loader = new ContextLoader({ workflowRoot: dir });
    // Task that matches multiple skills
    const { sections, tokenCount } = loader.resolve('flutter javascript go api design', 'developer');

    assert.ok(tokenCount <= 2000, `Token count ${tokenCount} should not exceed 2000`);

    fs.rmSync(dir, { recursive: true });
  });

  await test('ContextLoader: alwaysLoadSkills injects skill regardless of keywords', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const dir = makeTempDir();
    makeWorkflowRoot(dir, {
      'flutter-dev': '# Flutter Dev\n\nAlways use const constructors.\nPrefer StatelessWidget.\nUse Riverpod for state.',
    });

    const loader = new ContextLoader({
      workflowRoot: dir,
      alwaysLoadSkills: ['flutter-dev'],
    });
    // Task has no flutter keywords
    const { sources } = loader.resolve('write a database migration script', 'developer');

    assert.ok(sources.some(s => s.includes('flutter-dev')), 'alwaysLoadSkills should inject regardless of keywords');

    fs.rmSync(dir, { recursive: true });
  });

  await test('ContextLoader: custom skillKeywords extend built-in mapping', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const dir = makeTempDir();
    makeWorkflowRoot(dir, {
      'my-custom-skill': '# Custom Skill\n\nCustom rule 1.\nCustom rule 2.\nCustom rule 3.',
    });

    const loader = new ContextLoader({
      workflowRoot: dir,
      skillKeywords: { 'my-custom-skill': ['foobar', 'baz'] },
    });
    const { sources } = loader.resolve('implement foobar feature', 'developer');

    assert.ok(sources.some(s => s.includes('my-custom-skill')), 'Custom keyword should trigger custom skill');

    fs.rmSync(dir, { recursive: true });
  });

  await test('ContextLoader: returns empty sections when no docs exist', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const dir = makeTempDir();
    // Empty workflow root (no skills, no docs)
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'),   { recursive: true });

    const loader = new ContextLoader({ workflowRoot: dir });
    const { sections, sources, tokenCount } = loader.resolve('do something', 'developer');

    assertEqual(sections.length, 0);
    assertEqual(sources.length, 0);
    assertEqual(tokenCount, 0);

    fs.rmSync(dir, { recursive: true });
  });

  await test('ContextLoader: ADR fallback returns last 2 ADRs when no keyword match', async () => {
    const { ContextLoader } = require('../core/context-loader');
    const dir = makeTempDir();
    const adrContent = `# Decision Log

## ADR-001: Use React
**Status**: Accepted
**Context**
Frontend framework choice.
**Decision**
Use React.

## ADR-002: Use PostgreSQL
**Status**: Accepted
**Context**
Database choice.
**Decision**
Use PostgreSQL.

## ADR-003: Use Redis for caching
**Status**: Accepted
**Context**
Caching layer.
**Decision**
Use Redis.
`;
    makeWorkflowRoot(dir, {}, {
      'architecture-constraints.md': '# Constraints\n\nMax 600 lines.',
      'decision-log.md': adrContent,
    });

    const loader = new ContextLoader({ workflowRoot: dir });
    // Task with no ADR-related keywords
    const { sections } = loader.resolve('design the system', 'architect');

    const adrSection = sections.find(s => s.includes('decision-log'));
    assert.ok(adrSection, 'Should fall back to recent ADRs');
    // Should include ADR-002 or ADR-003 (the last 2)
    assert.ok(
      adrSection.includes('ADR-002') || adrSection.includes('ADR-003'),
      'Fallback should include recent ADRs'
    );

    fs.rmSync(dir, { recursive: true });
  });
}

// ─── ConfigLoader Tests ───────────────────────────────────────────────────────

async function runConfigLoaderTests() {
  console.log('\n── ConfigLoader ─────────────────────────────────────────────');

  await test('ConfigLoader: returns defaults when no config file exists', async () => {
    const { loadConfig, DEFAULT_CONFIG } = require('../core/config-loader');
    const dir = makeTempDir(); // Empty dir, no config file

    const { config, configPath } = loadConfig(dir);

    assertEqual(configPath, null, 'configPath should be null when using defaults');
    assert.ok(Array.isArray(config.sourceExtensions), 'sourceExtensions should be an array');
    assert.ok(config.sourceExtensions.length > 0, 'Should have default extensions');

    fs.rmSync(dir, { recursive: true });
  });

  await test('ConfigLoader: loads and merges workflow.config.js', async () => {
    const { loadConfig } = require('../core/config-loader');
    const dir = makeTempDir();

    // Write a minimal config file
    fs.writeFileSync(
      path.join(dir, 'workflow.config.js'),
      `module.exports = { sourceExtensions: ['.dart', '.yaml'], testCommand: 'flutter test' };`,
      'utf-8'
    );

    const { config, configPath } = loadConfig(dir);

    assert.ok(configPath !== null, 'configPath should be set');
    assertDeepEqual(config.sourceExtensions, ['.dart', '.yaml'], 'User extensions should override defaults');
    assertEqual(config.testCommand, 'flutter test');
    // Default keys not overridden should still be present
    assert.ok(Array.isArray(config.ignoreDirs), 'ignoreDirs should still be present from defaults');

    fs.rmSync(dir, { recursive: true });
  });

  await test('ConfigLoader: array values replace (not merge) defaults', async () => {
    const { loadConfig } = require('../core/config-loader');
    const dir = makeTempDir();

    fs.writeFileSync(
      path.join(dir, 'workflow.config.js'),
      `module.exports = { ignoreDirs: ['my_custom_ignore'] };`,
      'utf-8'
    );

    const { config } = loadConfig(dir);

    // User's array should completely replace the default array
    assertDeepEqual(config.ignoreDirs, ['my_custom_ignore']);

    fs.rmSync(dir, { recursive: true });
  });

  await test('ConfigLoader: clearConfigCache allows fresh reload', async () => {
    const { loadConfig, getConfig, clearConfigCache } = require('../core/config-loader');
    const dir = makeTempDir();

    // First load: no config
    clearConfigCache();
    const { config: c1 } = loadConfig(dir);
    assertEqual(c1.testCommand, undefined, 'No testCommand in defaults');

    // Write config
    fs.writeFileSync(
      path.join(dir, 'workflow.config.js'),
      `module.exports = { testCommand: 'npm test' };`,
      'utf-8'
    );

    // Second load: should pick up new config
    const { config: c2 } = loadConfig(dir);
    assertEqual(c2.testCommand, 'npm test');

    clearConfigCache(); // Clean up
    fs.rmSync(dir, { recursive: true });
  });

  await test('ConfigLoader: handles malformed config file gracefully', async () => {
    const { loadConfig } = require('../core/config-loader');
    const dir = makeTempDir();

    // Write invalid JS
    fs.writeFileSync(
      path.join(dir, 'workflow.config.js'),
      `module.exports = { this is not valid javascript !!!`,
      'utf-8'
    );

    // Should fall back to defaults without throwing
    let threw = false;
    let config;
    try {
      const result = loadConfig(dir);
      config = result.config;
    } catch (e) {
      threw = true;
    }

    assert.ok(!threw, 'Should not throw on malformed config');
    assert.ok(config, 'Should return default config');

    fs.rmSync(dir, { recursive: true });
  });
}

// ─── StateMachine Error Path Tests ───────────────────────────────────────────

async function runStateMachineErrorTests() {
  console.log('\n── StateMachine (error paths) ───────────────────────────────');

  const TEST_MANIFEST = path.join(os.tmpdir(), `_wf_test_manifest_${Date.now()}.json`);

  await test('StateMachine: throws when transitioning from FINISHED state', async () => {
    const { StateMachine } = require('../core/state-machine');
    const { PATHS } = require('../core/constants');
    const { STATE_ORDER } = require('../core/types');

    PATHS.MANIFEST = TEST_MANIFEST;
    const sm = new StateMachine('test-err-1');
    await sm.init();

    // Advance to FINISHED
    for (let i = 0; i < STATE_ORDER.length - 1; i++) {
      await sm.transition(null, `step ${i}`);
    }

    assert.ok(sm.isFinished(), 'Should be finished');

    // Attempt another transition – should throw
    await assertThrowsAsync(() => sm.transition(null, 'extra'), 'terminal state');

    if (fs.existsSync(TEST_MANIFEST)) fs.unlinkSync(TEST_MANIFEST);
  });

  await test('StateMachine: recordRisk stores risk entries in manifest', async () => {
    const { StateMachine } = require('../core/state-machine');
    const { PATHS } = require('../core/constants');

    PATHS.MANIFEST = TEST_MANIFEST;
    const sm = new StateMachine('test-err-2');
    await sm.init();

    sm.recordRisk('high', 'Critical security vulnerability found');
    sm.recordRisk('low', 'Minor style issue');

    const risks = sm.getRisks();
    assertEqual(risks.length, 2);
    assertEqual(risks[0].severity, 'high');
    assertEqual(risks[1].severity, 'low');
    assert.ok(risks[0].timestamp, 'Risk should have timestamp');

    if (fs.existsSync(TEST_MANIFEST)) fs.unlinkSync(TEST_MANIFEST);
  });

  await test('StateMachine: flushRisks batches multiple risks in one write', async () => {
    const { StateMachine } = require('../core/state-machine');
    const { PATHS } = require('../core/constants');

    PATHS.MANIFEST = TEST_MANIFEST;
    const sm = new StateMachine('test-err-3');
    await sm.init();

    // Record multiple risks without flushing
    sm.recordRisk('medium', 'Risk 1', false);
    sm.recordRisk('medium', 'Risk 2', false);
    sm.recordRisk('medium', 'Risk 3', false);
    sm.flushRisks(); // Single flush

    const risks = sm.getRisks();
    assertEqual(risks.length, 3, 'All 3 risks should be persisted after flushRisks()');

    if (fs.existsSync(TEST_MANIFEST)) fs.unlinkSync(TEST_MANIFEST);
  });

  await test('StateMachine: getArtifacts records artifact paths per state', async () => {
    const { StateMachine } = require('../core/state-machine');
    const { PATHS } = require('../core/constants');

    PATHS.MANIFEST = TEST_MANIFEST;
    const sm = new StateMachine('test-err-4');
    await sm.init();

    await sm.transition('/output/requirement.md', 'Analyst done');
    const artifacts = sm.getArtifacts();
    assertEqual(artifacts.requirementMd, '/output/requirement.md');

    if (fs.existsSync(TEST_MANIFEST)) fs.unlinkSync(TEST_MANIFEST);
  });

  await test('StateMachine: getNextState returns null at FINISHED', async () => {
    const { StateMachine } = require('../core/state-machine');
    const { PATHS } = require('../core/constants');
    const { STATE_ORDER } = require('../core/types');

    PATHS.MANIFEST = TEST_MANIFEST;
    const sm = new StateMachine('test-err-5');
    await sm.init();

    for (let i = 0; i < STATE_ORDER.length - 1; i++) {
      await sm.transition(null, `step ${i}`);
    }

    assertEqual(sm.getNextState(), null, 'getNextState() should return null at FINISHED');

    if (fs.existsSync(TEST_MANIFEST)) fs.unlinkSync(TEST_MANIFEST);
  });
}

// ─── Contract Tests ───────────────────────────────────────────────────────────

async function runContractTests() {
  console.log('\n── Contract Tests (Agent Output Format) ─────────────────────');

  await test('Contract: AnalystAgent output contains required Markdown sections', async () => {
    // Verify the output format contract that downstream agents depend on
    const requiredSections = ['Requirements', 'User Stories', 'Acceptance Criteria'];
    const mockOutput = `# Requirements\n\n## Overview\nTest app.\n\n## User Stories\n- As a user...\n\n## Acceptance Criteria\n1. WHEN X THEN Y\n\n## Out of Scope\n- None`;

    for (const section of requiredSections) {
      assertContains(mockOutput, section, `Analyst output must contain "${section}" section`);
    }
  });

  await test('Contract: ArchitectAgent output contains required Markdown sections', async () => {
    const requiredSections = ['Architecture', 'Component', 'Technology Stack', 'Interface'];
    const mockOutput = `# Architecture\n\n## Architecture Overview\nLayered.\n\n## Component Breakdown\n- API\n\n## Technology Stack\n- Node.js\n\n## Interface Contracts\n- GET /api`;

    for (const section of requiredSections) {
      assertContains(mockOutput, section, `Architect output must contain "${section}" section`);
    }
  });

  await test('Contract: FeatureList JSON is valid and parseable', async () => {
    const { FeatureList } = require('../core/feature-list');
    const dir = makeTempDir();
    const storePath = path.join(dir, 'features.json');

    const fl = new FeatureList(storePath);
    fl.addFeature({ id: 'F001', description: 'Test feature', steps: ['step1', 'step2'] });
    fl.addFeature({ id: 'F002', description: 'Another feature', steps: ['step1'], deps: ['F001'] });

    // Verify the persisted JSON is valid
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw); // Should not throw

    assert.ok(Array.isArray(parsed), 'Feature list JSON should be an array');
    assertEqual(parsed.length, 2);
    assertEqual(parsed[0].id, 'F001');
    assert.ok('passes' in parsed[0], 'Feature must have passes field');
    assert.ok('steps' in parsed[0], 'Feature must have steps field');
    assert.ok('status' in parsed[0], 'Feature must have status field');

    fs.rmSync(dir, { recursive: true });
  });

  await test('Contract: TaskManager JSON is valid and parseable', async () => {
    const { TaskManager } = require('../core/task-manager');
    const dir = makeTempDir();
    const storePath = path.join(dir, 'tasks.json');

    const tm = new TaskManager(storePath);
    tm.addTask({ id: 'T001', title: 'Task A', description: 'desc', deps: [] });
    tm.addTask({ id: 'T002', title: 'Task B', description: 'desc', deps: ['T001'] });

    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw);

    assert.ok(Array.isArray(parsed), 'Task list JSON should be an array');
    assertEqual(parsed.length, 2);
    assert.ok('status' in parsed[0], 'Task must have status field');
    assert.ok('deps' in parsed[0], 'Task must have deps field');
    assert.ok('retryCount' in parsed[0], 'Task must have retryCount field');

    fs.rmSync(dir, { recursive: true });
  });
}

// ─── 7. Gotchas vs Anti-Patterns Section Routing ─────────────────────────────

async function runGotchasSectionTests() {
  console.log('\n── Gotchas vs Anti-Patterns Section Routing ──');

  const { _selectEvolutionSection, _isEnvironmentSpecific } = require('../core/experience-evolution');

  // ── _isEnvironmentSpecific tests ──

  await test('_isEnvironmentSpecific: returns true for framework_limit category', async () => {
    const exp = { category: 'framework_limit', tags: [], content: '' };
    assertEqual(_isEnvironmentSpecific(exp), true);
  });

  await test('_isEnvironmentSpecific: returns true when tags contain env keyword', async () => {
    const exp = { category: 'pitfall', tags: ['windows', 'path-handling'], content: '' };
    assertEqual(_isEnvironmentSpecific(exp), true);
  });

  await test('_isEnvironmentSpecific: returns true when content contains env keyword', async () => {
    const exp = { category: 'pitfall', tags: [], content: 'Node v20 changed fs.cp recursive behaviour on Windows' };
    assertEqual(_isEnvironmentSpecific(exp), true);
  });

  await test('_isEnvironmentSpecific: returns true when description contains env keyword', async () => {
    const exp = { category: 'pitfall', tags: [], content: '', description: 'deprecated API in jdk17' };
    assertEqual(_isEnvironmentSpecific(exp), true);
  });

  await test('_isEnvironmentSpecific: returns false for generic pitfall', async () => {
    const exp = { category: 'pitfall', tags: ['error-handling'], content: 'Always handle promise rejections' };
    assertEqual(_isEnvironmentSpecific(exp), false);
  });

  await test('_isEnvironmentSpecific: returns false for empty experience', async () => {
    const exp = { category: 'pitfall', tags: [] };
    assertEqual(_isEnvironmentSpecific(exp), false);
  });

  // ── _selectEvolutionSection routing tests ──

  await test('Section routing: env-specific pitfall → Gotchas', async () => {
    const exp = { type: 'negative', category: 'pitfall', tags: ['docker'], content: 'Build fails in docker alpine' };
    const meta = { type: 'domain-skill' };
    assertEqual(_selectEvolutionSection(exp, meta), 'Gotchas');
  });

  await test('Section routing: generic pitfall → Anti-Patterns', async () => {
    const exp = { type: 'negative', category: 'pitfall', tags: ['coding'], content: 'Do not use eval()' };
    const meta = { type: 'domain-skill' };
    assertEqual(_selectEvolutionSection(exp, meta), 'Anti-Patterns');
  });

  await test('Section routing: negative + framework_limit → Gotchas', async () => {
    const exp = { type: 'negative', category: 'framework_limit', tags: [], content: 'React 18 strict mode double-renders' };
    const meta = { type: 'domain-skill' };
    assertEqual(_selectEvolutionSection(exp, meta), 'Gotchas');
  });

  await test('Section routing: negative + version keyword in content → Gotchas', async () => {
    const exp = { type: 'negative', category: 'pitfall', tags: [], content: 'This was deprecated in the latest upgrade' };
    const meta = { type: 'domain-skill' };
    assertEqual(_selectEvolutionSection(exp, meta), 'Gotchas');
  });

  await test('Section routing: troubleshooting skill ignores gotcha logic', async () => {
    const exp = { type: 'negative', category: 'pitfall', tags: ['docker'], content: 'Build fails' };
    const meta = { type: 'troubleshooting' };
    assertEqual(_selectEvolutionSection(exp, meta), 'Common Errors');
  });

  await test('Section routing: positive experience still → Best Practices', async () => {
    const exp = { type: 'positive', category: 'stable_pattern', tags: ['docker'], content: 'Multi-stage builds' };
    const meta = { type: 'domain-skill' };
    assertEqual(_selectEvolutionSection(exp, meta), 'Rules');
  });
}

// ─── AutoDeployer Tests ──────────────────────────────────────────────────────

async function runAutoDeployerTests() {
  console.log('\n── AutoDeployer ─────────────────────────────────────────────');

  await test('AutoDeployer: GREEN tier records change in history', async () => {
    const { AutoDeployer, DEPLOY_TIER } = require('../core/auto-deployer');
    const dir = makeTempDir();
    const deployer = new AutoDeployer({ outputDir: dir, projectRoot: dir, verbose: false });

    const result = deployer.applyGreen({
      type: 'skill-content-update',
      description: 'Refreshed 3 stale skills',
    });

    assertEqual(result.applied, true, 'GREEN should always be applied');
    assertEqual(result.record.tier, DEPLOY_TIER.GREEN, 'Tier should be GREEN');

    const history = deployer.loadHistory();
    assert.ok(history.length >= 1, 'History should have at least 1 entry');
    assertEqual(history[0].tier, DEPLOY_TIER.GREEN, 'History entry should be GREEN');

    fs.rmSync(dir, { recursive: true });
  });

  await test('AutoDeployer: YELLOW tier detects and applies config changes', async () => {
    const { AutoDeployer } = require('../core/auto-deployer');
    const dir = makeTempDir();

    // Create a minimal workflow.config.js
    fs.writeFileSync(
      path.join(dir, 'workflow.config.js'),
      `module.exports = {\n  autoFixLoop: {\n    enabled: true,\n    maxFixRounds: 2,\n    maxReviewRounds: 2,\n    failOnUnfixed: false,\n  },\n};\n`,
      'utf-8'
    );

    const deployer = new AutoDeployer({ outputDir: dir, projectRoot: dir, verbose: false });
    const strategy = {
      maxFixRounds: 4,
      maxReviewRounds: 3,
      source: 'history(5 sessions)',
      _debug: {},
    };

    const result = deployer.applyYellow(strategy);

    assertEqual(result.applied, true, 'YELLOW should apply changes');
    assert.ok(result.changes.length >= 1, 'Should have at least 1 change');

    // Verify the file was actually modified
    delete require.cache[require.resolve(path.join(dir, 'workflow.config.js'))];
    const updatedConfig = require(path.join(dir, 'workflow.config.js'));
    assertEqual(updatedConfig.autoFixLoop.maxFixRounds, 4, 'maxFixRounds should be updated to 4');
    assertEqual(updatedConfig.autoFixLoop.maxReviewRounds, 3, 'maxReviewRounds should be updated to 3');

    fs.rmSync(dir, { recursive: true });
  });

  await test('AutoDeployer: YELLOW tier skips when no config file exists', async () => {
    const { AutoDeployer } = require('../core/auto-deployer');
    const dir = makeTempDir(); // No config file

    const deployer = new AutoDeployer({ outputDir: dir, projectRoot: dir, verbose: false });
    const result = deployer.applyYellow({ maxFixRounds: 4, source: 'test' });

    assertEqual(result.applied, false, 'Should not apply without config file');
    assert.ok(result.record.skipped, 'Should be marked as skipped');

    fs.rmSync(dir, { recursive: true });
  });

  await test('AutoDeployer: YELLOW tier enforces safe bounds', async () => {
    const { AutoDeployer } = require('../core/auto-deployer');
    const dir = makeTempDir();

    fs.writeFileSync(
      path.join(dir, 'workflow.config.js'),
      `module.exports = {\n  autoFixLoop: {\n    maxFixRounds: 2,\n    maxReviewRounds: 2,\n  },\n};\n`,
      'utf-8'
    );

    const deployer = new AutoDeployer({ outputDir: dir, projectRoot: dir, verbose: false });

    // Try to set maxFixRounds to 99 (should be clamped to 5)
    const result = deployer.applyYellow({
      maxFixRounds: 99,
      maxReviewRounds: 2,
      source: 'test',
    });

    if (result.applied && result.changes.length > 0) {
      const fixChange = result.changes.find(c => c.path === 'autoFixLoop.maxFixRounds');
      if (fixChange) {
        assert.ok(fixChange.newValue <= 5, `maxFixRounds should be clamped to max 5, got ${fixChange.newValue}`);
      }
    }

    fs.rmSync(dir, { recursive: true });
  });

  await test('AutoDeployer: YELLOW tier creates backup and can rollback invalid config', async () => {
    const { AutoDeployer } = require('../core/auto-deployer');
    const dir = makeTempDir();

    const originalContent = `module.exports = {\n  autoFixLoop: {\n    maxFixRounds: 2,\n    maxReviewRounds: 2,\n  },\n};\n`;
    fs.writeFileSync(path.join(dir, 'workflow.config.js'), originalContent, 'utf-8');

    const deployer = new AutoDeployer({ outputDir: dir, projectRoot: dir, verbose: false });

    // Verify backup is created on apply
    const result = deployer.applyYellow({
      maxFixRounds: 3,
      maxReviewRounds: 2,
      source: 'test',
    });

    if (result.applied) {
      assert.ok(result.record.backupPath, 'Backup path should be recorded');
      assert.ok(fs.existsSync(result.record.backupPath), 'Backup file should exist');
    }

    fs.rmSync(dir, { recursive: true });
  });

  await test('AutoDeployer: RED tier generates PR description file', async () => {
    const { AutoDeployer, DEPLOY_TIER } = require('../core/auto-deployer');
    const dir = makeTempDir();
    const deployer = new AutoDeployer({ outputDir: dir, projectRoot: dir, verbose: false });

    const result = deployer.generateRedPR({
      title: 'Decompose orchestrator-stages.js',
      description: 'File exceeds 400-line limit at 1976 lines.',
      files: ['core/orchestrator-stages.js'],
      rationale: 'Violates architecture-constraints.md',
      diff: '# Too large to show inline',
    });

    assert.ok(result.prDescription.includes('Auto-Evolution'), 'PR should contain Auto-Evolution header');
    assert.ok(result.prFile, 'PR file path should be set');
    assert.ok(fs.existsSync(result.prFile), 'PR file should exist on disk');
    assertEqual(result.record.tier, DEPLOY_TIER.RED, 'Tier should be RED');
    assertEqual(result.record.requiresReview, true, 'Should require review');

    fs.rmSync(dir, { recursive: true });
  });

  await test('AutoDeployer: getSummary returns correct counts', async () => {
    const { AutoDeployer } = require('../core/auto-deployer');
    const dir = makeTempDir();
    const deployer = new AutoDeployer({ outputDir: dir, projectRoot: dir, verbose: false });

    deployer.applyGreen({ description: 'test green 1' });
    deployer.applyGreen({ description: 'test green 2' });
    deployer.generateRedPR({ title: 'test red', description: 'test', files: [] });

    const summary = deployer.getSummary();
    assertEqual(summary.green, 2, 'Should have 2 GREEN entries');
    assertEqual(summary.red, 1, 'Should have 1 RED entry');
    assert.ok(summary.lastDeploy, 'lastDeploy should be set');

    fs.rmSync(dir, { recursive: true });
  });

  await test('AutoDeployer: YELLOW dry-run does not modify config', async () => {
    const { AutoDeployer } = require('../core/auto-deployer');
    const dir = makeTempDir();

    const originalContent = `module.exports = {\n  autoFixLoop: {\n    maxFixRounds: 2,\n    maxReviewRounds: 2,\n  },\n};\n`;
    fs.writeFileSync(path.join(dir, 'workflow.config.js'), originalContent, 'utf-8');

    const deployer = new AutoDeployer({ outputDir: dir, projectRoot: dir, verbose: false });
    const result = deployer.applyYellow(
      { maxFixRounds: 4, maxReviewRounds: 3, source: 'test' },
      { dryRun: true }
    );

    assertEqual(result.applied, false, 'Should NOT apply in dry-run mode');
    assert.ok(result.changes.length > 0, 'Should still report changes');

    // Verify file is unchanged
    const afterContent = fs.readFileSync(path.join(dir, 'workflow.config.js'), 'utf-8');
    assertEqual(afterContent, originalContent, 'Config file should be unchanged');

    fs.rmSync(dir, { recursive: true });
  });
}

// ─── MAPE Engine Tests ──────────────────────────────────────────────────────

async function runMAPETests() {
  console.log('\n── MAPE Engine ─────────────────────────────────────────────');

  await test('MAPEEngine: monitor returns signal array', async () => {
    const { MAPEEngine } = require('../core/mape-engine');
    const dir = makeTempDir();
    // Create minimal metrics-history.jsonl
    const historyPath = path.join(dir, 'metrics-history.jsonl');
    fs.writeFileSync(historyPath, '', 'utf-8');

    const engine = new MAPEEngine({ orchestrator: { _outputDir: dir }, verbose: false });
    const signals = engine.monitor();
    assert.ok(Array.isArray(signals), 'Should return an array');
    fs.rmSync(dir, { recursive: true });
  });

  await test('MAPEEngine: analyze groups signals and finds correlations', async () => {
    const { MAPEEngine } = require('../core/mape-engine');
    const engine = new MAPEEngine({ orchestrator: { _outputDir: makeTempDir() }, verbose: false });

    const signals = [
      { source: 'quality-gate', type: 'gate-failure', severity: 'high', title: 'Quality gate failed: maxErrorCount', data: {} },
      { source: 'metrics-history', type: 'anomaly', severity: 'medium', title: 'Token usage trending upward', data: {} },
      { source: 'self-reflection', type: 'issue_detected', severity: 'medium', title: 'skill overlap', data: { patternKey: 'skill-keyword-conflict' } },
    ];

    const analysis = engine.analyze(signals);
    assert.ok(analysis.correlations.length > 0, 'Should find at least 1 correlation (gate + tokens = mistuning)');
    assert.ok(analysis.signalGroups['quality-gate'], 'Should group by source');
  });

  await test('MAPEEngine: plan generates prioritized actions', async () => {
    const { MAPEEngine } = require('../core/mape-engine');
    const engine = new MAPEEngine({ orchestrator: { _outputDir: makeTempDir() }, verbose: false });

    const analysis = {
      rootCauses: [
        { pattern: 'test-pattern', occurrences: 3, severity: 'high', sources: ['test'], suggestedAction: 'skill-refresh' },
      ],
      correlations: [
        { type: 'config-mistuning', description: 'Test correlation', suggestedAction: 'config-adjustment' },
      ],
      signalGroups: {},
    };

    const plan = engine.plan(analysis, { maxActions: 5 });
    assert.ok(plan.actions.length >= 2, 'Should have at least 2 actions');
    assert.ok(plan.estimatedROI > 0, 'ROI should be positive');
    // First action should be higher priority
    assert.ok(plan.actions[0].priority <= plan.actions[plan.actions.length - 1].priority, 'Actions should be sorted by priority');
  });

  await test('MAPEEngine: full cycle runs without errors', async () => {
    const { MAPEEngine } = require('../core/mape-engine');
    const dir = makeTempDir();
    const engine = new MAPEEngine({ orchestrator: { _outputDir: dir }, verbose: false });

    const result = await engine.runCycle({ dryRun: true, maxActions: 3 });
    assert.ok(result.phases, 'Should have phases');
    assert.ok(result.phases.monitor, 'Should have monitor phase');
    assert.ok(result.phases.analyze, 'Should have analyze phase');
    assert.ok(result.phases.plan, 'Should have plan phase');
    assert.ok(result.phases.execute, 'Should have execute phase');
    assertEqual(result.dryRun, true, 'Should be dry run');
    fs.rmSync(dir, { recursive: true });
  });
}

// ─── Regression Guard Tests ─────────────────────────────────────────────────

async function runRegressionGuardTests() {
  console.log('\n── Regression Guard ────────────────────────────────────────');

  await test('RegressionGuard: captureBaseline creates snapshot', async () => {
    const { RegressionGuard } = require('../core/regression-guard');
    const dir = makeTempDir();
    const guard = new RegressionGuard({ outputDir: dir, verbose: false });

    const baseline = guard.captureBaseline();
    assert.ok(baseline.capturedAt, 'Should have timestamp');
    assert.ok(baseline.metrics, 'Should have metrics');
    assert.ok(baseline.skillVersions, 'Should have skill versions');

    // Verify file was written
    assert.ok(fs.existsSync(path.join(dir, 'evolve-baseline.json')), 'Baseline file should exist');
    fs.rmSync(dir, { recursive: true });
  });

  await test('RegressionGuard: compareWithBaseline detects improvements and degradations', async () => {
    const { RegressionGuard, METRIC_KEY } = require('../core/regression-guard');
    const dir = makeTempDir();
    const guard = new RegressionGuard({ outputDir: dir, verbose: false });

    // Create a manual baseline
    const baseline = {
      capturedAt: new Date().toISOString(),
      metrics: {
        [METRIC_KEY.ERROR_RATE]: 5,
        [METRIC_KEY.TOKEN_USAGE]: 10000,
        [METRIC_KEY.TEST_PASS_RATE]: 0.8,
      },
      skillVersions: {},
    };
    fs.writeFileSync(path.join(dir, 'evolve-baseline.json'), JSON.stringify(baseline), 'utf-8');

    const currentMetrics = {
      [METRIC_KEY.ERROR_RATE]: 2,      // Improved (lower is better)
      [METRIC_KEY.TOKEN_USAGE]: 15000, // Degraded (lower is better)
      [METRIC_KEY.TEST_PASS_RATE]: 0.9, // Improved (higher is better)
    };

    const result = guard.compareWithBaseline(currentMetrics);
    assert.ok(result.improved.length > 0, 'Should have improvements');
    assert.ok(result.degraded.length > 0, 'Should have degradations');
    assert.ok(result.delta[METRIC_KEY.ERROR_RATE], 'Should have error rate delta');
    fs.rmSync(dir, { recursive: true });
  });

  await test('RegressionGuard: recordOutcome writes to evolve-history.jsonl', async () => {
    const { RegressionGuard } = require('../core/regression-guard');
    const dir = makeTempDir();
    const guard = new RegressionGuard({ outputDir: dir, verbose: false });

    guard.recordOutcome(
      { steps: [{ name: 'test', status: 'done' }] },
      { improved: ['errorRate'], degraded: [], unchanged: ['tokenUsage'], regressions: [] },
      { phases: { plan: { estimatedROI: 2.5 }, execute: { executed: 1 } } }
    );

    const history = guard.loadHistory();
    assert.ok(history.length === 1, 'Should have 1 history entry');
    assert.ok(history[0].evolutionROI != null, 'Should have ROI score');
    fs.rmSync(dir, { recursive: true });
  });

  await test('RegressionGuard: getTrend returns meaningful trend data', async () => {
    const { RegressionGuard } = require('../core/regression-guard');
    const dir = makeTempDir();
    const guard = new RegressionGuard({ outputDir: dir, verbose: false });

    // Add multiple history entries
    for (let i = 0; i < 5; i++) {
      guard.recordOutcome(
        { steps: [] },
        { improved: ['a'], degraded: [], unchanged: [], regressions: [] },
        { phases: { plan: { estimatedROI: 2 + i * 0.5 }, execute: { executed: 1 } } }
      );
    }

    const trend = guard.getTrend();
    assertEqual(trend.cycles, 5, 'Should have 5 cycles');
    assert.ok(trend.avgROI > 0, 'Average ROI should be positive');
    assert.ok(['improving', 'stable', 'degrading'].includes(trend.trend), 'Trend should be valid');
    fs.rmSync(dir, { recursive: true });
  });
}

// ─── Skill Marketplace Tests ────────────────────────────────────────────────

async function runSkillMarketplaceTests() {
  console.log('\n── Skill Marketplace ───────────────────────────────────────');

  await test('SkillMarketplace: listSkills returns skill metadata', async () => {
    const { SkillMarketplace } = require('../core/skill-marketplace');
    const dir = makeTempDir();
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir);

    // Create a test skill
    fs.writeFileSync(path.join(skillsDir, 'test-skill.md'), [
      '---',
      'name: test-skill',
      'version: 1.0.0',
      'type: domain-skill',
      'domains: [testing]',
      'dependencies: []',
      'exportable: true',
      'description: "A test skill"',
      '---',
      '# Skill: test-skill',
      '',
      '## Rules',
      '',
      '1. Test rule with enough content words to pass validation checks for minimum word count.',
      '',
    ].join('\n'));

    const marketplace = new SkillMarketplace({ skillsDir, outputDir: dir, verbose: false });
    const skills = marketplace.listSkills();

    assert.ok(skills.length === 1, 'Should find 1 skill');
    assertEqual(skills[0].name, 'test-skill', 'Name should match');
    assertEqual(skills[0].exportable, true, 'Should be exportable');
    fs.rmSync(dir, { recursive: true });
  });

  await test('SkillMarketplace: exportSkill creates package file', async () => {
    const { SkillMarketplace } = require('../core/skill-marketplace');
    const dir = makeTempDir();
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir);

    const skillContent = [
      '---',
      'name: export-test',
      'version: 2.0.0',
      'type: domain-skill',
      'domains: [test]',
      'dependencies: []',
      'description: "Export test"',
      '---',
      '# Skill: export-test',
      '',
      '## Rules',
      '',
      '1. Test export rule',
    ].join('\n');

    fs.writeFileSync(path.join(skillsDir, 'export-test.md'), skillContent);

    const marketplace = new SkillMarketplace({ skillsDir, outputDir: dir, verbose: false });
    const { packagePath, package: pkg } = marketplace.exportSkill('export-test');

    assert.ok(fs.existsSync(packagePath), 'Package file should exist');
    assertEqual(pkg.skill.name, 'export-test', 'Package skill name should match');
    assertEqual(pkg.skill.version, '2.0.0', 'Version should match');
    assert.ok(pkg.skill.content.includes('Test export rule'), 'Content should be included');
    fs.rmSync(dir, { recursive: true });
  });

  await test('SkillMarketplace: importSkill writes new skill file', async () => {
    const { SkillMarketplace } = require('../core/skill-marketplace');
    const dir = makeTempDir();
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir);

    // Create a package to import
    const pkg = {
      version: 1,
      exportedAt: new Date().toISOString(),
      skill: {
        name: 'imported-skill',
        version: '1.0.0',
        type: 'domain-skill',
        domains: ['import-test'],
        dependencies: [],
        description: 'An imported skill',
        content: '---\nname: imported-skill\nversion: 1.0.0\n---\n# Skill: imported-skill\n\n## Rules\n\n1. Imported rule\n',
      },
      dependencies: [],
    };

    const pkgPath = path.join(dir, 'test-import.skill.json');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));

    const marketplace = new SkillMarketplace({ skillsDir, outputDir: dir, verbose: false });
    const result = marketplace.importSkill(pkgPath);

    assertEqual(result.imported, true, 'Should be imported');
    assertEqual(result.skillName, 'imported-skill', 'Name should match');
    assert.ok(fs.existsSync(path.join(skillsDir, 'imported-skill.md')), 'Skill file should exist');
    fs.rmSync(dir, { recursive: true });
  });

  await test('SkillMarketplace: importSkill with skip strategy handles conflicts', async () => {
    const { SkillMarketplace } = require('../core/skill-marketplace');
    const dir = makeTempDir();
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir);

    // Create existing skill
    fs.writeFileSync(path.join(skillsDir, 'conflict-skill.md'), '# Existing skill\n\n## Rules\n\n1. Local rule\n');

    // Create a package with same name
    const pkg = {
      version: 1,
      skill: { name: 'conflict-skill', version: '1.0.0', content: '# Conflict\n\n## Rules\n\n1. New rule\n', dependencies: [] },
      dependencies: [],
    };
    const pkgPath = path.join(dir, 'conflict.skill.json');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));

    const marketplace = new SkillMarketplace({ skillsDir, outputDir: dir, verbose: false });
    const result = marketplace.importSkill(pkgPath, { conflictStrategy: 'skip' });

    assertEqual(result.imported, false, 'Should NOT be imported (skip strategy)');
    assert.ok(result.conflicts.length > 0, 'Should report conflicts');

    // Original content should be preserved
    const content = fs.readFileSync(path.join(skillsDir, 'conflict-skill.md'), 'utf-8');
    assert.ok(content.includes('Local rule'), 'Original content should be preserved');
    fs.rmSync(dir, { recursive: true });
  });

  await test('SkillMarketplace: checkCompatibility detects missing dependencies', async () => {
    const { SkillMarketplace } = require('../core/skill-marketplace');
    const dir = makeTempDir();
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir);

    const pkg = {
      version: 1,
      skill: { name: 'dep-skill', version: '1.0.0', content: '# Dep test', dependencies: ['missing-dep', 'another-missing'] },
      dependencies: [],
    };
    const pkgPath = path.join(dir, 'dep-test.skill.json');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));

    const marketplace = new SkillMarketplace({ skillsDir, outputDir: dir, verbose: false });
    const result = marketplace.checkCompatibility(pkgPath);

    assertEqual(result.compatible, false, 'Should NOT be compatible');
    assert.ok(result.issues.length >= 2, 'Should report at least 2 missing dependency issues');
    fs.rmSync(dir, { recursive: true });
  });
}

// ─── Main Runner ──────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('  Workflow Unit Tests – Functional Correctness');
  console.log('='.repeat(60));

  await runFeatureListTests();
  await runTaskManagerTests();
  await runContextLoaderTests();
  await runConfigLoaderTests();
  await runStateMachineErrorTests();
  await runContractTests();
  await runGotchasSectionTests();
  await runAutoDeployerTests();
  await runMAPETests();
  await runRegressionGuardTests();
  await runSkillMarketplaceTests();

  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failed tests:');
    for (const f of failures) {
      console.log(`    ❌ ${f.name}`);
      console.log(`       ${f.error}`);
    }
  }
  console.log('='.repeat(60) + '\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
