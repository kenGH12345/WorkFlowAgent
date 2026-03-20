'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { extractJsonBlock, validateJsonBlock, ANALYST_SCHEMA } = require('../core/agent-output-schema');
const { StageContextStore } = require('../core/stage-context-store');
const { storeAnalyseContext } = require('../core/orchestrator-stage-helpers');

const tmpDir = path.join(os.tmpdir(), 'wfa-test-module-map-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ PASS: ${msg}`); }
  else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

// ─── Test 1: ANALYST_SCHEMA includes moduleMap field ────────────────────────
console.log('\n=== Test 1: ANALYST_SCHEMA ===');
assert(ANALYST_SCHEMA.version === '1.1', 'Schema version is 1.1');
assert(ANALYST_SCHEMA.fields.moduleMap, 'moduleMap field exists');
assert(ANALYST_SCHEMA.fields.moduleMap.type === 'object', 'moduleMap type is object');

// ─── Test 2: extractJsonBlock parses moduleMap from output ──────────────────
console.log('\n=== Test 2: extractJsonBlock ===');
const mockJsonBlock = {
  role: 'analyst',
  version: '1.1',
  requirements: ['R1: User login', 'R2: User registration'],
  moduleMap: {
    modules: [
      {
        id: 'mod-auth',
        name: 'Authentication Module',
        description: 'User login, registration, token management',
        boundaries: ['src/auth/*', 'src/middleware/auth*'],
        dependencies: ['mod-db', 'mod-config'],
        complexity: 'high',
        isolatable: true,
      },
      {
        id: 'mod-db',
        name: 'Database Layer',
        description: 'Data persistence and querying',
        boundaries: ['src/db/*'],
        dependencies: [],
        complexity: 'medium',
        isolatable: false,
      },
    ],
    crossCuttingConcerns: ['logging', 'error-handling', 'config'],
  },
};

const mockFileContent =
  '```json\n' +
  JSON.stringify(mockJsonBlock, null, 2) +
  '\n```\n\n' +
  '# Requirements\n\n' +
  'This is the full requirement document with enough content to test Architecture Design and technical decisions and Execution Plan.\n\n' +
  '## Architecture Design\n\nKey entities and relationships.\n\n' +
  '## Execution Plan\n\nStep-by-step plan.\n\n' +
  '## Functional Module Map\n\nSee JSON block above.\n';

const parsed = extractJsonBlock(mockFileContent);
assert(parsed !== null, 'JSON block was extracted');
assert(parsed.moduleMap !== undefined, 'moduleMap field present in parsed JSON');
assert(parsed.moduleMap.modules.length === 2, 'Two modules found');
assert(parsed.moduleMap.modules[0].id === 'mod-auth', 'First module ID is mod-auth');
assert(parsed.moduleMap.modules[0].isolatable === true, 'mod-auth is isolatable');
assert(parsed.moduleMap.modules[1].id === 'mod-db', 'Second module ID is mod-db');
assert(parsed.moduleMap.crossCuttingConcerns.length === 3, 'Three cross-cutting concerns');

const validation = validateJsonBlock(parsed, 'analyst');
assert(validation.valid === true, 'JSON block validates against analyst schema');

// ─── Test 3: storeAnalyseContext extracts moduleMap into stageCtx ───────────
console.log('\n=== Test 3: storeAnalyseContext ===');
const reqPath = path.join(tmpDir, 'requirement.md');
fs.writeFileSync(reqPath, mockFileContent);

const store = new StageContextStore({ outputDir: tmpDir });
const mockOrch = { stageCtx: store };
const clarResult = { riskNotes: [], rounds: 0, allSignals: [], skipped: false };

storeAnalyseContext(mockOrch, reqPath, clarResult);

const analyseCtx = store.get('ANALYSE');
assert(analyseCtx !== null, 'ANALYSE context stored');
assert(analyseCtx.meta.moduleMap !== null, 'moduleMap stored in meta');
assert(analyseCtx.meta.moduleMap.modules.length === 2, 'Two modules in stored moduleMap');
assert(analyseCtx.meta.moduleMap.modules[0].id === 'mod-auth', 'Stored mod-auth correctly');
assert(analyseCtx.meta.moduleMap.modules[0].complexity === 'high', 'Complexity preserved');
assert(analyseCtx.meta.moduleMap.modules[0].isolatable === true, 'Isolatable preserved');
assert(analyseCtx.meta.moduleMap.modules[0].boundaries.length === 2, 'Boundaries preserved');
assert(analyseCtx.meta.moduleMap.modules[0].dependencies.length === 2, 'Dependencies preserved');
assert(analyseCtx.meta.moduleMap.crossCuttingConcerns.length === 3, 'Cross-cutting preserved');

// ─── Test 4: buildArchitectUpstreamCtx includes Module Map section ──────────
console.log('\n=== Test 4: buildArchitectUpstreamCtx ===');
const { buildArchitectUpstreamCtx } = require('../core/architect-context-builder');

// Mock orchestrator with stageCtx
const mockOrch2 = { stageCtx: store };
const upstreamCtx = buildArchitectUpstreamCtx(mockOrch2);

assert(upstreamCtx.includes('Functional Module Map'), 'Upstream context includes Module Map section');
assert(upstreamCtx.includes('mod-auth'), 'Upstream context includes mod-auth');
assert(upstreamCtx.includes('mod-db'), 'Upstream context includes mod-db');
assert(upstreamCtx.includes('Authentication Module'), 'Upstream context includes module name');
assert(upstreamCtx.includes('logging'), 'Upstream context includes cross-cutting concerns');
assert(upstreamCtx.includes('isolatable'), 'Upstream context includes isolatable info');

// ─── Test 5: Module Map absent (backward compat) ───────────────────────────
console.log('\n=== Test 5: No moduleMap (backward compat) ===');
const noMapContent =
  '```json\n' +
  JSON.stringify({ role: 'analyst', version: '1.0', requirements: ['R1'] }) +
  '\n```\n\n' +
  '# Requirements\nSome content about Architecture Design and Execution Plan with enough text.\n';

const noMapPath = path.join(tmpDir, 'requirement-nomap.md');
fs.writeFileSync(noMapPath, noMapContent);

const store2 = new StageContextStore({ outputDir: tmpDir });
const mockOrch3 = { stageCtx: store2 };
storeAnalyseContext(mockOrch3, noMapPath, clarResult);

const ctx2 = store2.get('ANALYSE');
assert(ctx2.meta.moduleMap === null, 'moduleMap is null when absent from output');

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`  Module Map Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
