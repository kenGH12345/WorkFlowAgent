/**
 * P2 Review Fix Tests
 *
 * Covers:
 *   A. code-graph.js parser mixin extraction — parsers still work via mixin
 *   B. (P2-B deferred to future iteration — Orchestrator Mediator refactor)
 *   C. ExperienceStore distillation/merge mechanism
 *   D. StateMachine conditional transitions
 */

'use strict';

const assert = require('assert');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. CodeGraph Parser Mixin (P2-A)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── A. CodeGraph Parser Mixin (P2-A) ─────────────────────────');

test('CodeGraphParsersMixin exports correctly', () => {
  const { CodeGraphParsersMixin, SymbolKind } = require('../core/code-graph-parsers');
  assert.ok(CodeGraphParsersMixin, 'Mixin should be exported');
  assert.ok(typeof CodeGraphParsersMixin._extractSymbols === 'function', '_extractSymbols should be a function');
  assert.ok(typeof CodeGraphParsersMixin._extractJsSymbols === 'function', '_extractJsSymbols should be a function');
  assert.ok(typeof CodeGraphParsersMixin._extractCsSymbols === 'function', '_extractCsSymbols should be a function');
  assert.ok(typeof CodeGraphParsersMixin._extractLuaSymbols === 'function', '_extractLuaSymbols should be a function');
  assert.ok(typeof CodeGraphParsersMixin._extractGoSymbols === 'function', '_extractGoSymbols should be a function');
  assert.ok(typeof CodeGraphParsersMixin._extractPySymbols === 'function', '_extractPySymbols should be a function');
  assert.ok(typeof CodeGraphParsersMixin._extractDartSymbols === 'function', '_extractDartSymbols should be a function');
  assertEqual(SymbolKind.CLASS, 'class', 'SymbolKind.CLASS');
  assertEqual(SymbolKind.FUNCTION, 'function', 'SymbolKind.FUNCTION');
});

test('CodeGraph has parser methods after mixin applied', () => {
  const { CodeGraph } = require('../core/code-graph');
  // Verify that the mixin methods are available on the prototype
  assert.ok(typeof CodeGraph.prototype._extractSymbols === 'function', '_extractSymbols on prototype');
  assert.ok(typeof CodeGraph.prototype._extractJsSymbols === 'function', '_extractJsSymbols on prototype');
  assert.ok(typeof CodeGraph.prototype._extractImports === 'function', '_extractImports on prototype');
  assert.ok(typeof CodeGraph.prototype._extractCallEdges === 'function', '_extractCallEdges on prototype');
  assert.ok(typeof CodeGraph.prototype._extractJsDocSummary === 'function', '_extractJsDocSummary on prototype');
});

test('Parser mixin: _extractJsSymbols works on mock instance', () => {
  const { CodeGraphParsersMixin } = require('../core/code-graph-parsers');
  // Create a minimal mock instance
  const mock = {
    _symbols: new Map(),
    _addSymbol: CodeGraphParsersMixin._addSymbol,
    _extractJsSymbols: CodeGraphParsersMixin._extractJsSymbols,
    _extractJsDocSummary: CodeGraphParsersMixin._extractJsDocSummary,
  };

  const code = [
    'class UserService {',
    '  async getUser(id) {',
    '    return db.find(id);',
    '  }',
    '}',
    '',
    'function formatDate(date) {',
    '  return date.toISOString();',
    '}',
  ];

  mock._extractJsSymbols(code, 'test/user-service.js');
  assert.ok(mock._symbols.size >= 2, `Should find at least 2 symbols, found ${mock._symbols.size}`);
  assert.ok(mock._symbols.has('test/user-service.js::UserService'), 'Should find UserService class');
  assert.ok(mock._symbols.has('test/user-service.js::formatDate'), 'Should find formatDate function');
});

test('Parser mixin: _extractPySymbols works on mock instance', () => {
  const { CodeGraphParsersMixin } = require('../core/code-graph-parsers');
  const mock = {
    _symbols: new Map(),
    _addSymbol: CodeGraphParsersMixin._addSymbol,
    _extractPySymbols: CodeGraphParsersMixin._extractPySymbols,
    _extractPyDocSummary: CodeGraphParsersMixin._extractPyDocSummary,
  };

  const code = [
    'class DataProcessor:',
    '    """Processes raw data."""',
    '    def process(self, data):',
    '        """Process the data pipeline."""',
    '        return data.transform()',
    '',
    'async def fetch_data(url):',
    '    """Fetch data from API."""',
    '    return await http.get(url)',
  ];

  mock._extractPySymbols(code, 'pipeline.py');
  assert.ok(mock._symbols.has('pipeline.py::DataProcessor'), 'Should find DataProcessor class');
  assert.ok(mock._symbols.has('pipeline.py::fetch_data'), 'Should find fetch_data function');
});

test('code-graph.js reduced in size after parser extraction', () => {
  const cgPath = path.join(__dirname, '..', 'core', 'code-graph.js');
  const stat = fs.statSync(cgPath);
  const sizeKB = stat.size / 1024;
  // Should be significantly smaller after extracting ~250 lines of parsers
  console.log(`    [info] code-graph.js size: ${sizeKB.toFixed(1)} KB`);
  assert.ok(sizeKB < 155, `code-graph.js should be < 155KB after extraction, was ${sizeKB.toFixed(1)} KB`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. Experience Distillation (P2-C)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── C. Experience Distillation (P2-C) ────────────────────────');

const { computeSimilarity, ExperienceDistillationMixin } = require('../core/experience-distillation');

test('computeSimilarity: identical experiences score ~1.0', () => {
  const a = { title: 'Slow API response', tags: ['api', 'performance'], category: 'performance', type: 'negative' };
  const b = { title: 'Slow API response', tags: ['api', 'performance'], category: 'performance', type: 'negative' };
  const sim = computeSimilarity(a, b);
  assert.ok(sim > 0.95, `Expected > 0.95, got ${sim}`);
});

test('computeSimilarity: completely different experiences score low', () => {
  const a = { title: 'Database connection timeout', tags: ['db', 'error'], category: 'error_handling', type: 'negative' };
  const b = { title: 'Beautiful UI component', tags: ['ui', 'design'], category: 'code_quality', type: 'positive' };
  const sim = computeSimilarity(a, b);
  assert.ok(sim < 0.3, `Expected < 0.3, got ${sim}`);
});

test('computeSimilarity: similar titles + same category score high', () => {
  const a = { title: 'API response time too slow', tags: ['api'], category: 'performance', type: 'negative' };
  const b = { title: 'API response time degraded', tags: ['api', 'latency'], category: 'performance', type: 'negative' };
  const sim = computeSimilarity(a, b);
  assert.ok(sim > 0.5, `Expected > 0.5, got ${sim}`);
});

test('distill: merges similar experiences in a mock store', () => {
  const store = {
    experiences: [
      { id: 'E1', title: 'Slow API response in auth', content: 'Auth endpoint takes 2s', category: 'performance', type: 'negative', tags: ['api', 'auth'], hitCount: 5, updatedAt: '2025-01-01', createdAt: '2025-01-01', evolutionCount: 0 },
      { id: 'E2', title: 'Slow API response in user', content: 'User endpoint takes 3s', category: 'performance', type: 'negative', tags: ['api', 'user'], hitCount: 2, updatedAt: '2025-01-02', createdAt: '2025-01-02', evolutionCount: 0 },
      { id: 'E3', title: 'Slow API response in payment', content: 'Payment endpoint takes 4s', category: 'performance', type: 'negative', tags: ['api', 'payment'], hitCount: 1, updatedAt: '2025-01-03', createdAt: '2025-01-03', evolutionCount: 0 },
      { id: 'E4', title: 'Beautiful CSS layout pattern', content: 'Flexbox grid', category: 'code_quality', type: 'positive', tags: ['css'], hitCount: 0, updatedAt: '2025-01-01', createdAt: '2025-01-01', evolutionCount: 0 },
    ],
    _titleIndex: new Set(),
    _save: function() {},
  };
  store._titleIndex = new Set(store.experiences.map(e => e.title));
  Object.assign(store, ExperienceDistillationMixin);

  const result = store.distill({ similarityThreshold: 0.5 });
  assert.ok(result.merged >= 1, `Expected at least 1 merge cluster, got ${result.merged}`);
  assert.ok(result.removed >= 1, `Expected at least 1 removed, got ${result.removed}`);
  // CSS experience should not be merged with API experiences
  assert.ok(store.experiences.some(e => e.id === 'E4'), 'CSS experience should survive (different category)');
});

test('distill: dry-run does not modify store', () => {
  const store = {
    experiences: [
      { id: 'E1', title: 'Slow API response in auth', content: 'Content 1', category: 'performance', type: 'negative', tags: ['api'], hitCount: 5, updatedAt: '2025-01-01', createdAt: '2025-01-01', evolutionCount: 0 },
      { id: 'E2', title: 'Slow API response in user', content: 'Content 2', category: 'performance', type: 'negative', tags: ['api'], hitCount: 2, updatedAt: '2025-01-02', createdAt: '2025-01-02', evolutionCount: 0 },
    ],
    _titleIndex: new Set(['Slow API response in auth', 'Slow API response in user']),
    _save: function() {},
  };
  Object.assign(store, ExperienceDistillationMixin);

  const before = store.experiences.length;
  const result = store.distill({ dryRun: true });
  assertEqual(store.experiences.length, before, 'Dry-run should not remove experiences');
  assert.ok(result.removed >= 1, `Dry-run should report removable count, got ${result.removed}`);
});

test('distill: empty store returns no-op result', () => {
  const store = {
    experiences: [],
    _titleIndex: new Set(),
    _save: function() {},
  };
  Object.assign(store, ExperienceDistillationMixin);

  const result = store.distill();
  assertEqual(result.merged, 0, 'No merges on empty store');
  assertEqual(result.removed, 0, 'No removals on empty store');
});

test('distill: accumulates hitCount from merged members', () => {
  const store = {
    experiences: [
      { id: 'E1', title: 'Slow database query', content: 'Content 1', category: 'performance', type: 'negative', tags: ['db'], hitCount: 10, updatedAt: '2025-03-01', createdAt: '2025-01-01', evolutionCount: 0 },
      { id: 'E2', title: 'Slow database queries', content: 'Content 2', category: 'performance', type: 'negative', tags: ['db'], hitCount: 5, updatedAt: '2025-02-01', createdAt: '2025-02-01', evolutionCount: 0 },
    ],
    _titleIndex: new Set(),
    _save: function() {},
  };
  store._titleIndex = new Set(store.experiences.map(e => e.title));
  Object.assign(store, ExperienceDistillationMixin);

  store.distill({ similarityThreshold: 0.5 });
  // The surviving experience should have accumulated hitCount
  assert.ok(store.experiences.length === 1, `Expected 1 surviving experience, got ${store.experiences.length}`);
  const survivor = store.experiences[0];
  assertEqual(survivor.hitCount, 15, 'hitCount should be accumulated (10 + 5)');
  assert.ok(survivor.distillation && survivor.distillation.length > 0, 'Should have distillation metadata');
});

test('ExperienceStore has distill method after mixin', () => {
  const { ExperienceStore } = require('../core/experience-store');
  assert.ok(typeof ExperienceStore.prototype.distill === 'function', 'distill should be on prototype');
  assert.ok(typeof ExperienceStore.prototype.autoDistill === 'function', 'autoDistill should be on prototype');
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. StateMachine Conditional Transitions (P2-D)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── D. StateMachine Conditional Transitions (P2-D) ──────────');

const { StateMachine } = require('../core/state-machine');
const { WorkflowState } = require('../core/types');

function createTestSM(stateOrder = undefined) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-'));
  const manifestPath = path.join(tmpDir, 'manifest.json');
  const sm = new StateMachine('test-p2d', async () => {}, {
    manifestPath,
    stateOrder,
  });
  return sm;
}

test('addConditionalTransition registers a rule', async () => {
  const sm = createTestSM();
  await sm.init();

  sm.addConditionalTransition('ARCHITECT', {
    name: 'ArchReview',
    condition: (manifest, ctx) => ctx.passed ? 'pass' : 'fail',
    targets: { pass: 'PLAN', fail: 'ANALYSE' },
  });

  const rules = sm.getConditionalRules();
  assert.ok(rules.has('ARCHITECT'), 'Should have rules for ARCHITECT');
  assertEqual(rules.get('ARCHITECT').length, 1, 'Should have 1 rule');
  assertEqual(rules.get('ARCHITECT')[0].name, 'ArchReview', 'Rule name');
});

test('addConditionalTransition rejects invalid fromState', async () => {
  const sm = createTestSM();
  await sm.init();

  let threw = false;
  try {
    sm.addConditionalTransition('INVALID_STATE', {
      name: 'test',
      condition: () => 'x',
      targets: { x: 'PLAN' },
    });
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('invalid fromState'), 'Error message mentions invalid fromState');
  }
  assert.ok(threw, 'Should throw for invalid fromState');
});

test('addConditionalTransition rejects invalid target state', async () => {
  const sm = createTestSM();
  await sm.init();

  let threw = false;
  try {
    sm.addConditionalTransition('ARCHITECT', {
      name: 'test',
      condition: () => 'x',
      targets: { x: 'NONEXISTENT' },
    });
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('not a valid state'), 'Error message mentions invalid target');
  }
  assert.ok(threw, 'Should throw for invalid target state');
});

test('transitionConditional: forward pass condition', async () => {
  const sm = createTestSM();
  await sm.init();

  // Advance to ARCHITECT
  await sm.transition(null, 'to ANALYSE');  // INIT → ANALYSE
  await sm.transition(null, 'to ARCHITECT'); // ANALYSE → ARCHITECT

  sm.addConditionalTransition('ARCHITECT', {
    name: 'ArchReview',
    condition: (manifest, ctx) => ctx.reviewPassed ? 'pass' : 'fail',
    targets: { pass: 'PLAN', fail: 'ANALYSE' },
  });

  const newState = await sm.transitionConditional({ reviewPassed: true });
  assertEqual(newState, 'PLAN', 'Should transition to PLAN on pass');
});

test('transitionConditional: backward fail condition (rollback)', async () => {
  const sm = createTestSM();
  await sm.init();

  await sm.transition(null, 'to ANALYSE');
  await sm.transition(null, 'to ARCHITECT');

  sm.addConditionalTransition('ARCHITECT', {
    name: 'ArchReview',
    condition: (manifest, ctx) => ctx.reviewPassed ? 'pass' : 'fail',
    targets: { pass: 'PLAN', fail: 'ANALYSE' },
  });

  const newState = await sm.transitionConditional({ reviewPassed: false });
  assertEqual(newState, 'ANALYSE', 'Should jump back to ANALYSE on fail');
});

test('transitionConditional: no rules falls back to sequential', async () => {
  const sm = createTestSM();
  await sm.init();

  await sm.transition(null, 'to ANALYSE');

  // No conditional rules registered for ANALYSE
  const newState = await sm.transitionConditional({});
  assertEqual(newState, 'ARCHITECT', 'Should fall back to sequential (ANALYSE → ARCHITECT)');
});

test('hasConditionalTransition reflects registration', async () => {
  const sm = createTestSM();
  await sm.init();

  assertEqual(sm.hasConditionalTransition(), false, 'No rules at INIT');

  await sm.transition(); // → ANALYSE
  sm.addConditionalTransition('ANALYSE', {
    name: 'test',
    condition: () => 'go',
    targets: { go: 'ARCHITECT' },
  });
  assertEqual(sm.hasConditionalTransition(), true, 'Should have rules at ANALYSE');
});

test('transitionConditional: skip-forward jump', async () => {
  const sm = createTestSM();
  await sm.init();

  await sm.transition(null, 'to ANALYSE');

  // Register a rule that skips ARCHITECT and PLAN, jumping to CODE
  sm.addConditionalTransition('ANALYSE', {
    name: 'SmallTask',
    condition: (manifest, ctx) => ctx.isSmall ? 'skip' : 'normal',
    targets: { skip: 'CODE', normal: 'ARCHITECT' },
  });

  const newState = await sm.transitionConditional({ isSmall: true });
  assertEqual(newState, 'CODE', 'Should jump forward to CODE (skip ARCHITECT and PLAN)');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(60)}`);
console.log(`  P2 Review Fix Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
