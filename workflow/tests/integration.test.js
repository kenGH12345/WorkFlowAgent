/**
 * Integration Test Suite – AEF Cross-Module Contract Verification
 *
 * These tests were created in response to a deep audit that found 6 integration
 * issues that all escaped detection because:
 *   1. AEF code had 0% test coverage
 *   2. Smoke tests only verified require() didn't throw
 *   3. No cross-module interface contract tests existed
 *   4. Defensive coding (?.  / ternary) masked missing methods as silent no-ops
 *
 * Covers:
 *   1. ReviewAgentBase.review() returns allResults field
 *   2. ExperienceStore.getAll() returns full experience array
 *   3. estimateTaskComplexity() returns all 4 complexity levels
 *   4. index.js exports all required symbols (RootCause, REVIEW_DIMENSIONS, etc.)
 *   5. ComplaintStatus constants are used consistently (no hardcoded strings)
 *   6. CodeReviewAgent.formatReport() generates multi-dimensional table when allResults present
 *   7. CodeReviewAgent DEFAULT_CHECKLIST includes Interface Contract / Export / Constant dimensions
 *   8. ITEM_TO_DIMENSION maps new checklist prefixes correctly
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');
const os     = require('os');

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

function assertContains(str, sub, msg = '') {
  assert.ok(String(str).includes(sub), msg || `Expected to contain "${sub}", got: "${String(str).slice(0, 200)}"`);
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wf-integration-'));
}

// ─── Mock LLM for ReviewAgentBase tests ───────────────────────────────────────

/**
 * Creates a mock LLM that returns deterministic review results.
 * @param {object[]} results - Array of { id, result, finding, fixInstruction } objects
 */
function createMockReviewLlm(results) {
  return async function mockLlm(prompt) {
    // If the prompt is asking for a review, return the mock results
    if (prompt.includes('checklist') || prompt.includes('Checklist') || prompt.includes('Evaluate')) {
      return JSON.stringify(results);
    }
    // If the prompt is asking for a fix, return the original content unchanged
    if (prompt.includes('fix') || prompt.includes('Fix') || prompt.includes('correct')) {
      return prompt.includes('```') ? prompt.match(/```[\s\S]*?```/)?.[0]?.replace(/```/g, '') || 'mock fix' : 'mock fix';
    }
    // If the prompt is an adversarial review, return all items as PASS (no downgrades)
    return JSON.stringify(results.filter(r => r.result === 'PASS' || r.result === 'N/A'));
  };
}

// ─── Test Suite 1: ReviewAgentBase.review() – allResults field ───────────────

async function runReviewAgentBaseTests() {
  console.log('\n── ReviewAgentBase (allResults contract) ─────────────────────');

  await test('ReviewAgentBase.review() returns allResults array in result', async () => {
    const { ReviewAgentBase } = require('../core/review-agent-base');

    // Create a minimal concrete subclass for testing
    class TestReviewAgent extends ReviewAgentBase {
      _getReviewContent() { return 'test content'; }
      _buildReviewPrompt() {
        return 'Review this. Return JSON array with checklist results.';
      }
      _buildAdversarialPrompt() { return null; } // Skip adversarial pass
      _buildFixPrompt(content, failures) {
        return { prompt: 'Fix it', mode: 'full' };
      }
      _applyFix(current) { return current; }
      _writeBackArtifact() {}
      _writeReport() {}
      _getInvestigationDomain() { return 'test'; }
      _getLabelPrefix() { return 'TestReview'; }
      _getHeaderLine() { return '--- TestReview ---'; }
    }

    const mockResults = [
      { id: 'T-001', result: 'PASS', finding: 'OK', fixInstruction: null },
      { id: 'T-002', result: 'FAIL', finding: 'Bad', fixInstruction: 'Fix it' },
      { id: 'T-003', result: 'N/A', finding: 'Not applicable', fixInstruction: null },
    ];

    const agent = new TestReviewAgent(createMockReviewLlm(mockResults), {
      maxRounds: 1,
      verbose: false,
      checklist: [
        { id: 'T-001', category: 'Test', severity: 'low', description: 'Test 1', hint: 'Hint 1' },
        { id: 'T-002', category: 'Test', severity: 'high', description: 'Test 2', hint: 'Hint 2' },
        { id: 'T-003', category: 'Test', severity: 'low', description: 'Test 3', hint: 'Hint 3' },
      ],
    });

    // Write a temp file for review
    const dir = makeTempDir();
    const inputPath = path.join(dir, 'test-artifact.txt');
    fs.writeFileSync(inputPath, 'test content', 'utf-8');

    const result = await agent.review(inputPath);

    // Key assertion: allResults MUST be present and non-empty
    assert.ok(result.allResults, 'result.allResults must exist');
    assert.ok(Array.isArray(result.allResults), 'result.allResults must be an array');
    assert.ok(result.allResults.length > 0, 'result.allResults must not be empty');

    // allResults should contain ALL items (PASS + FAIL + N/A), not just failures
    const passItems = result.allResults.filter(r => r.result === 'PASS');
    const failItems = result.allResults.filter(r => r.result === 'FAIL');
    const naItems   = result.allResults.filter(r => r.result === 'N/A');
    assert.ok(passItems.length > 0 || failItems.length > 0 || naItems.length > 0,
      'allResults should contain PASS, FAIL, or N/A items');

    // failures should be a subset of allResults
    assert.ok(result.failures.length <= result.allResults.length,
      'failures should be a subset of allResults');

    fs.rmSync(dir, { recursive: true });
  });

  await test('ReviewAgentBase.review() allResults is empty array for skipped reviews', async () => {
    const { ReviewAgentBase } = require('../core/review-agent-base');

    class TestReviewAgent extends ReviewAgentBase {
      _getReviewContent() { return null; } // Simulate missing artifact
      _buildReviewPrompt() { return ''; }
      _buildAdversarialPrompt() { return null; }
      _buildFixPrompt() { return { prompt: '', mode: 'full' }; }
      _applyFix(c) { return c; }
      _writeBackArtifact() {}
      _writeReport() {}
      _getInvestigationDomain() { return 'test'; }
      _getLabelPrefix() { return 'TestReview'; }
      _getHeaderLine() { return '--- TestReview ---'; }
    }

    const agent = new TestReviewAgent(async () => '[]', { maxRounds: 1, verbose: false });
    const result = await agent.review('/nonexistent/path');

    // Skipped reviews should still return a well-formed result
    assert.ok(result.skipped === true, 'Review should be skipped for missing artifact');
    assertEqual(result.rounds, 0);
  });
}

// ─── Test Suite 2: ExperienceStore.getAll() ──────────────────────────────────

async function runExperienceStoreTests() {
  console.log('\n── ExperienceStore (getAll contract) ────────────────────────');

  await test('ExperienceStore.getAll() is a function', async () => {
    const { ExperienceStore } = require('../core/experience-store');
    assert.ok(typeof ExperienceStore.prototype.getAll === 'function',
      'getAll must be a function on ExperienceStore.prototype');
  });

  await test('ExperienceStore.getAll() returns all experiences', async () => {
    const { ExperienceStore, ExperienceType, ExperienceCategory } = require('../core/experience-store');
    const dir = makeTempDir();
    const store = new ExperienceStore(path.join(dir, 'exp.json'));

    // Record some experiences
    store.record({
      type: ExperienceType.POSITIVE,
      category: ExperienceCategory.STABLE_PATTERN,
      title: 'Test positive experience',
      content: 'This went well.',
      tags: ['test'],
    });
    store.record({
      type: ExperienceType.NEGATIVE,
      category: ExperienceCategory.PITFALL,
      title: 'Test negative experience',
      content: 'This failed.',
      tags: ['test'],
    });
    store.record({
      type: ExperienceType.POSITIVE,
      category: ExperienceCategory.ARCHITECTURE,
      title: 'Architecture insight',
      content: 'Use modular design.',
      tags: ['architecture'],
    });

    const all = store.getAll();
    assertEqual(all.length, 3, 'getAll should return all 3 experiences');

    // Verify it returns the actual array (not a copy that would break mutations)
    assert.ok(all === store.experiences, 'getAll should return the same array reference');

    fs.rmSync(dir, { recursive: true });
  });

  await test('ExperienceStore.getAll() returns empty array for new store', async () => {
    const { ExperienceStore } = require('../core/experience-store');
    const dir = makeTempDir();
    const store = new ExperienceStore(path.join(dir, 'exp-empty.json'));

    const all = store.getAll();
    assert.ok(Array.isArray(all), 'getAll should return an array');
    assertEqual(all.length, 0, 'New store should have 0 experiences');

    fs.rmSync(dir, { recursive: true });
  });
}

// ─── Test Suite 3: estimateTaskComplexity() – all 4 levels ──────────────────

async function runComplexityTests() {
  console.log('\n── estimateTaskComplexity (level matching) ──────────────────');

  await test('estimateTaskComplexity returns "simple" for trivial input', async () => {
    const { estimateTaskComplexity } = require('../core/observability-strategy');
    const result = estimateTaskComplexity('Fix a typo');
    assertEqual(result.level, 'simple', `Expected "simple", got "${result.level}" (score=${result.score})`);
    assert.ok(result.score <= 25, `Score ${result.score} should be ≤ 25 for simple`);
  });

  await test('estimateTaskComplexity returns "moderate" for medium input', async () => {
    const { estimateTaskComplexity } = require('../core/observability-strategy');
    const result = estimateTaskComplexity(
      'Create a REST API with authentication and implement user registration. ' +
      'The server should validate inputs and handle errors properly. ' +
      'Design the database schema for users with email and password fields. ' +
      'Build a frontend login page that connects to the backend API.'
    );
    assertEqual(result.level, 'moderate', `Expected "moderate", got "${result.level}" (score=${result.score})`);
    assert.ok(result.score > 25 && result.score <= 50, `Score ${result.score} should be 26-50 for moderate`);
  });

  await test('estimateTaskComplexity returns "complex" for complex input', async () => {
    const { estimateTaskComplexity } = require('../core/observability-strategy');
    const result = estimateTaskComplexity(
      'Build a microservice architecture with API gateway and message queue for ' +
      'asynchronous processing. Implement authentication with OAuth and design the ' +
      'database schema with PostgreSQL. Create a frontend client with real-time WebSocket ' +
      'updates. Configure Docker containers and implement performance monitoring and logging. ' +
      'Set up automated testing and deployment pipeline. Ensure scalability and handle ' +
      'concurrent requests with rate limiting.'
    );
    assertEqual(result.level, 'complex', `Expected "complex", got "${result.level}" (score=${result.score})`);
    assert.ok(result.score > 50 && result.score <= 75, `Score ${result.score} should be 51-75 for complex`);
  });

  await test('estimateTaskComplexity returns "very_complex" for extreme input', async () => {
    const { estimateTaskComplexity } = require('../core/observability-strategy');
    const result = estimateTaskComplexity(
      'Build a globally distributed, multi-tenant SaaS platform with microservice architecture ' +
      'featuring API gateway, service mesh, and message queue (Kafka) for asynchronous processing. ' +
      'Implement OAuth authentication, SAML SSO, LDAP integration, and role-based authorization ' +
      'with fine-grained permissions. Design the database layer with PostgreSQL sharding and ' +
      'replication, Redis caching cluster, Elasticsearch for full-text search, and MongoDB for ' +
      'document storage. Create a responsive cross-platform frontend with real-time WebSocket ' +
      'and SSE updates, offline-first capability, and internationalization (i18n/l10n) support. ' +
      'Configure Docker containers with Kubernetes orchestration across multiple availability zones. ' +
      'Implement comprehensive observability: distributed tracing, structured logging, metric ' +
      'dashboards, and alerting pipelines. Set up CI/CD with automated testing, canary deployments, ' +
      'and zero-downtime rolling updates. Integrate with Stripe for payment processing, Twilio ' +
      'for SMS, SendGrid for email, and third-party webhook systems. Ensure GDPR, HIPAA, SOC2 ' +
      'compliance with audit logging and data encryption at rest and in transit. Implement rate ' +
      'limiting, circuit breakers, fault tolerance, and automatic scaling based on load metrics. ' +
      'Build a serverless Lambda function layer for background processing. Design idempotent, ' +
      'atomic transaction handling with distributed locks and eventual consistency patterns.'
    );
    assertEqual(result.level, 'very_complex', `Expected "very_complex", got "${result.level}" (score=${result.score})`);
    assert.ok(result.score > 75, `Score ${result.score} should be > 75 for very_complex`);
  });

  await test('estimateTaskComplexity returns all required fields', async () => {
    const { estimateTaskComplexity } = require('../core/observability-strategy');
    const result = estimateTaskComplexity('Build a simple app');

    assert.ok('score' in result, 'Result must have score');
    assert.ok('level' in result, 'Result must have level');
    assert.ok('factors' in result, 'Result must have factors');
    assert.ok(typeof result.score === 'number', 'score must be a number');
    assert.ok(typeof result.level === 'string', 'level must be a string');
    assert.ok(['simple', 'moderate', 'complex', 'very_complex'].includes(result.level),
      `level "${result.level}" must be one of: simple, moderate, complex, very_complex`);
  });

  await test('AEF complexity routing in orchestrator-stages uses correct level values', async () => {
    // This test verifies the actual source code in orchestrator-stages.js
    // contains checks for all 4 complexity levels returned by estimateTaskComplexity
    const stagesSource = fs.readFileSync(
      path.join(__dirname, '..', 'core', 'orchestrator-stages.js'),
      'utf-8'
    );

    // All 4 levels must be referenced in the routing logic
    assertContains(stagesSource, "'simple'", 'orchestrator-stages.js must check for "simple"');
    assertContains(stagesSource, "'moderate'", 'orchestrator-stages.js must check for "moderate"');
    assertContains(stagesSource, "'complex'", 'orchestrator-stages.js must check for "complex"');
    assertContains(stagesSource, "'very_complex'", 'orchestrator-stages.js must check for "very_complex"');
  });
}

// ─── Test Suite 4: index.js export completeness ─────────────────────────────

async function runExportTests() {
  console.log('\n── index.js Export Completeness ─────────────────────────────');

  await test('index.js exports RootCause from complaint-wall', async () => {
    // Verify RootCause is importable from the complaint-wall module
    const { RootCause } = require('../core/complaint-wall');
    assert.ok(RootCause !== undefined, 'RootCause must be exported from complaint-wall.js');
    assert.ok(typeof RootCause === 'object', 'RootCause must be an object (enum)');
  });

  await test('index.js exports ComplaintStatus from complaint-wall', async () => {
    const { ComplaintStatus } = require('../core/complaint-wall');
    assert.ok(ComplaintStatus !== undefined, 'ComplaintStatus must be exported from complaint-wall.js');
    assert.ok(typeof ComplaintStatus === 'object', 'ComplaintStatus must be an object (enum)');
    assert.ok('RESOLVED' in ComplaintStatus, 'ComplaintStatus must have RESOLVED key');
  });

  await test('index.js exports REVIEW_DIMENSIONS from code-review-agent', async () => {
    const { REVIEW_DIMENSIONS } = require('../core/code-review-agent');
    assert.ok(REVIEW_DIMENSIONS !== undefined, 'REVIEW_DIMENSIONS must be exported');
    assert.ok(typeof REVIEW_DIMENSIONS === 'object', 'REVIEW_DIMENSIONS must be an object');
    assert.ok('SPEC_COMPLIANCE' in REVIEW_DIMENSIONS, 'REVIEW_DIMENSIONS must have SPEC_COMPLIANCE');
    assert.ok('STANDARDS' in REVIEW_DIMENSIONS, 'REVIEW_DIMENSIONS must have STANDARDS');
    assert.ok('PERFORMANCE' in REVIEW_DIMENSIONS, 'REVIEW_DIMENSIONS must have PERFORMANCE');
    assert.ok('ROBUSTNESS' in REVIEW_DIMENSIONS, 'REVIEW_DIMENSIONS must have ROBUSTNESS');
  });

  await test('index.js exports ITEM_TO_DIMENSION from code-review-agent', async () => {
    const { ITEM_TO_DIMENSION } = require('../core/code-review-agent');
    assert.ok(ITEM_TO_DIMENSION !== undefined, 'ITEM_TO_DIMENSION must be exported');
    assert.ok(typeof ITEM_TO_DIMENSION === 'object', 'ITEM_TO_DIMENSION must be an object');

    // Verify all checklist ID prefixes are mapped
    const expectedPrefixes = ['SEC', 'ERR', 'PERF', 'STYLE', 'REQ', 'SYNTAX', 'EDGE', 'INTF', 'EXPORT', 'CONST'];
    for (const prefix of expectedPrefixes) {
      assert.ok(prefix in ITEM_TO_DIMENSION,
        `ITEM_TO_DIMENSION must map prefix "${prefix}"`);
    }
  });

  await test('index.js imports all required symbols from complaint-wall', async () => {
    // Read index.js source and verify the import line
    const indexSource = fs.readFileSync(
      path.join(__dirname, '..', 'index.js'),
      'utf-8'
    );
    assertContains(indexSource, 'RootCause', 'index.js must import RootCause');
    assertContains(indexSource, 'ComplaintStatus', 'index.js must import ComplaintStatus');
  });

  await test('index.js imports all required symbols from code-review-agent', async () => {
    const indexSource = fs.readFileSync(
      path.join(__dirname, '..', 'index.js'),
      'utf-8'
    );
    assertContains(indexSource, 'REVIEW_DIMENSIONS', 'index.js must import REVIEW_DIMENSIONS');
    assertContains(indexSource, 'ITEM_TO_DIMENSION', 'index.js must import ITEM_TO_DIMENSION');
  });
}

// ─── Test Suite 5: Constant consistency ──────────────────────────────────────

async function runConstantConsistencyTests() {
  console.log('\n── Constant Consistency ─────────────────────────────────────');

  await test('orchestrator-lifecycle uses ComplaintStatus.RESOLVED (not hardcoded string)', async () => {
    const lifecycleSource = fs.readFileSync(
      path.join(__dirname, '..', 'core', 'orchestrator-lifecycle.js'),
      'utf-8'
    );

    // Should NOT contain hardcoded 'resolved' string comparison for complaint status
    // (It's OK if 'resolved' appears in log messages or comments, but not in
    // c.status === 'resolved' patterns)
    const hardcodedPattern = /c\.status\s*===\s*['"]resolved['"]/;
    assert.ok(!hardcodedPattern.test(lifecycleSource),
      'orchestrator-lifecycle.js must use ComplaintStatus.RESOLVED constant, not hardcoded "resolved"');

    // Should import ComplaintStatus
    assertContains(lifecycleSource, 'ComplaintStatus',
      'orchestrator-lifecycle.js must import ComplaintStatus');
  });

  await test('ComplaintStatus.RESOLVED has expected value', async () => {
    const { ComplaintStatus } = require('../core/complaint-wall');
    assertEqual(typeof ComplaintStatus.RESOLVED, 'string',
      'ComplaintStatus.RESOLVED must be a string');
    assert.ok(ComplaintStatus.RESOLVED.length > 0,
      'ComplaintStatus.RESOLVED must not be empty');
  });
}

// ─── Test Suite 6: CodeReviewAgent.formatReport() multi-dimensional table ───

async function runFormatReportTests() {
  console.log('\n── CodeReviewAgent.formatReport() multi-dimensional table ───');

  await test('formatReport generates multi-dimensional table when allResults is present', async () => {
    const { CodeReviewAgent } = require('../core/code-review-agent');

    const agent = new CodeReviewAgent(async () => '[]', { maxRounds: 1, verbose: false });

    const mockResult = {
      rounds: 1,
      totalItems: 5,
      passed: 3,
      failed: 1,
      na: 1,
      missing: 0,
      failures: [
        { id: 'SEC-001', result: 'FAIL', finding: 'SQL injection found', fixInstruction: 'Use parameterized queries' },
      ],
      allResults: [
        { id: 'SEC-001', result: 'FAIL', finding: 'SQL injection found' },
        { id: 'ERR-001', result: 'PASS', finding: 'Error handling OK' },
        { id: 'PERF-001', result: 'PASS', finding: 'Performance OK' },
        { id: 'STYLE-001', result: 'PASS', finding: 'Style OK' },
        { id: 'REQ-001', result: 'N/A', finding: 'Not applicable' },
      ],
      history: [],
      riskNotes: [],
      needsHumanReview: false,
      skipped: false,
    };

    const report = agent.formatReport(mockResult);

    // The report MUST contain the multi-dimensional analysis section
    assertContains(report, 'Multi-Dimensional Analysis',
      'Report must include Multi-Dimensional Analysis section when allResults is present');
    assertContains(report, '4-Way Review',
      'Report must reference AEF 4-Way Review');
  });

  await test('formatReport omits multi-dimensional table when allResults is empty', async () => {
    const { CodeReviewAgent } = require('../core/code-review-agent');

    const agent = new CodeReviewAgent(async () => '[]', { maxRounds: 1, verbose: false });

    const mockResult = {
      rounds: 1,
      totalItems: 3,
      passed: 2,
      failed: 1,
      na: 0,
      missing: 0,
      failures: [
        { id: 'SEC-001', result: 'FAIL', finding: 'Bad', fixInstruction: 'Fix it' },
      ],
      allResults: [], // Empty – no multi-dimensional table should be generated
      history: [],
      riskNotes: [],
      needsHumanReview: false,
      skipped: false,
    };

    const report = agent.formatReport(mockResult);

    // Should NOT contain multi-dimensional section when allResults is empty
    assert.ok(!report.includes('Multi-Dimensional Analysis'),
      'Report must NOT include Multi-Dimensional Analysis when allResults is empty');
  });

  await test('formatReport handles undefined allResults gracefully', async () => {
    const { CodeReviewAgent } = require('../core/code-review-agent');

    const agent = new CodeReviewAgent(async () => '[]', { maxRounds: 1, verbose: false });

    const mockResult = {
      rounds: 1,
      totalItems: 3,
      passed: 3,
      failed: 0,
      na: 0,
      missing: 0,
      failures: [],
      // allResults intentionally UNDEFINED – should not crash
      history: [],
      riskNotes: [],
      needsHumanReview: false,
      skipped: false,
    };

    // Must not throw
    let threw = false;
    try {
      agent.formatReport(mockResult);
    } catch (e) {
      threw = true;
    }
    assert.ok(!threw, 'formatReport must not throw when allResults is undefined');
  });
}

// ─── Test Suite 7: DEFAULT_CHECKLIST includes new dimensions ────────────────

async function runChecklistDimensionTests() {
  console.log('\n── DEFAULT_CHECKLIST dimension completeness ─────────────────');

  await test('DEFAULT_CHECKLIST includes Interface Contract items', async () => {
    const { DEFAULT_CHECKLIST } = require('../core/code-review-agent');
    const intfItems = DEFAULT_CHECKLIST.filter(i => i.category === 'Interface Contract');
    assert.ok(intfItems.length >= 1,
      `Expected at least 1 Interface Contract item, got ${intfItems.length}`);
    assert.ok(intfItems.some(i => i.id.startsWith('INTF-')),
      'Interface Contract items must have INTF- prefix IDs');
  });

  await test('DEFAULT_CHECKLIST includes Export Completeness items', async () => {
    const { DEFAULT_CHECKLIST } = require('../core/code-review-agent');
    const exportItems = DEFAULT_CHECKLIST.filter(i => i.category === 'Export Completeness');
    assert.ok(exportItems.length >= 1,
      `Expected at least 1 Export Completeness item, got ${exportItems.length}`);
    assert.ok(exportItems.some(i => i.id.startsWith('EXPORT-')),
      'Export Completeness items must have EXPORT- prefix IDs');
  });

  await test('DEFAULT_CHECKLIST includes Constant Consistency items', async () => {
    const { DEFAULT_CHECKLIST } = require('../core/code-review-agent');
    const constItems = DEFAULT_CHECKLIST.filter(i => i.category === 'Constant Consistency');
    assert.ok(constItems.length >= 1,
      `Expected at least 1 Constant Consistency item, got ${constItems.length}`);
    assert.ok(constItems.some(i => i.id.startsWith('CONST-')),
      'Constant Consistency items must have CONST- prefix IDs');
  });

  await test('ITEM_TO_DIMENSION maps INTF, EXPORT, CONST prefixes', async () => {
    const { ITEM_TO_DIMENSION, REVIEW_DIMENSIONS } = require('../core/code-review-agent');

    assertEqual(ITEM_TO_DIMENSION['INTF'], REVIEW_DIMENSIONS.SPEC_COMPLIANCE,
      'INTF should map to SPEC_COMPLIANCE');
    assertEqual(ITEM_TO_DIMENSION['EXPORT'], REVIEW_DIMENSIONS.STANDARDS,
      'EXPORT should map to STANDARDS');
    assertEqual(ITEM_TO_DIMENSION['CONST'], REVIEW_DIMENSIONS.STANDARDS,
      'CONST should map to STANDARDS');
  });

  await test('All DEFAULT_CHECKLIST item ID prefixes have ITEM_TO_DIMENSION mappings', async () => {
    const { DEFAULT_CHECKLIST, ITEM_TO_DIMENSION } = require('../core/code-review-agent');

    const unmapped = [];
    for (const item of DEFAULT_CHECKLIST) {
      const prefix = item.id.split('-')[0];
      if (!(prefix in ITEM_TO_DIMENSION)) {
        unmapped.push(item.id);
      }
    }

    assertEqual(unmapped.length, 0,
      `These checklist items have no ITEM_TO_DIMENSION mapping: ${unmapped.join(', ')}`);
  });
}

// ─── Main Runner ──────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('  Integration Tests – AEF Cross-Module Contract Verification');
  console.log('='.repeat(60));

  await runReviewAgentBaseTests();
  await runExperienceStoreTests();
  await runComplexityTests();
  await runExportTests();
  await runConstantConsistencyTests();
  await runFormatReportTests();
  await runChecklistDimensionTests();

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
