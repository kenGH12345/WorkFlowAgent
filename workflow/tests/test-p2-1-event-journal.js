/**
 * P2-1 EventJournal Tests
 *
 * Covers:
 *   A. Core EventJournal: creation, append, flush, close, query
 *   B. HookSystem integration: universal event capture via emit() wrapping
 *   C. Event categories: correct categorization of all HOOK_EVENTS
 *   D. Payload sanitization: truncation, circular ref handling, depth limiting
 *   E. Static helpers: loadJournal, listJournals
 *   F. Edge cases: disabled journal, empty journal, malformed lines
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  \u2705 PASS: ' + name);
    passed++;
  } catch (err) {
    console.error('  \u274c FAIL: ' + name);
    console.error('     ' + err.message);
    failed++;
  }
}

function asyncTest(name, fn) {
  return fn()
    .then(() => {
      console.log('  \u2705 PASS: ' + name);
      passed++;
    })
    .catch(err => {
      console.error('  \u274c FAIL: ' + name);
      console.error('     ' + err.message);
      failed++;
    });
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ej-test-'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. Core EventJournal
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 A. Core EventJournal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

const { EventJournal, EventCategory, EVENT_CATEGORY_MAP, loadJournal, listJournals } = require('../core/event-journal');

test('EventJournal exports all expected symbols', () => {
  assert.ok(EventJournal, 'EventJournal class');
  assert.ok(EventCategory, 'EventCategory enum');
  assert.ok(EVENT_CATEGORY_MAP, 'EVENT_CATEGORY_MAP');
  assert.ok(typeof loadJournal === 'function', 'loadJournal function');
  assert.ok(typeof listJournals === 'function', 'listJournals function');
});

test('EventCategory has all expected categories', () => {
  const expected = ['LIFECYCLE', 'STAGE', 'LLM', 'ARTIFACT', 'AGENT', 'EXPERIENCE',
    'CI', 'GIT', 'ERROR', 'DRYRUN', 'PROMPT', 'CODE_GRAPH', 'COMPLAINT', 'NEGOTIATION', 'SYSTEM'];
  for (const cat of expected) {
    assert.ok(EventCategory[cat], 'Missing category: ' + cat);
  }
});

test('EVENT_CATEGORY_MAP covers all known HOOK_EVENTS', () => {
  const { HOOK_EVENTS } = require('../core/constants');
  const mappedEvents = new Set(Object.keys(EVENT_CATEGORY_MAP));
  const hookEventValues = new Set(Object.values(HOOK_EVENTS));

  // Every HOOK_EVENT should be in the map
  for (const ev of hookEventValues) {
    assert.ok(mappedEvents.has(ev), 'Missing mapping for HOOK_EVENT: ' + ev);
  }
});

test('EventJournal constructor creates journal with session ID', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'test-001' });
  assertEqual(ej.sessionId, 'test-001', 'Session ID');
  assert.ok(ej.journalPath.endsWith('.jsonl'), 'Journal path ends with .jsonl');
  assert.ok(ej.journalPath.includes('event-journal-test-001'), 'Journal path contains session ID');
  ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventJournal auto-generates session ID when not provided', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir });
  assert.ok(ej.sessionId.length > 10, 'Auto-generated session ID should be non-trivial');
  assert.ok(/^\d{8}-\d{6,7}-[a-f0-9]{4}$/.test(ej.sessionId), 'Session ID format: YYYYMMDD-HHmmss-xxxx, got: ' + ej.sessionId);
  ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventJournal append and flush writes to JSONL file', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'flush-test', maxBufferSize: 2 });

  // Append 3 events (buffer size 2 triggers a flush after 2nd event)
  ej.append('test_event_1', { key: 'value1' });
  ej.append('test_event_2', { key: 'value2' });
  ej.append('test_event_3', { key: 'value3' });

  ej.close();

  const events = loadJournal(ej.journalPath);
  // journal_start + 3 appended + journal_end = 5
  assertEqual(events.length, 5, 'Total events (start + 3 + end)');
  assertEqual(events[0].event, 'journal_start', 'First event is journal_start');
  assertEqual(events[1].event, 'test_event_1', 'Second event');
  assertEqual(events[4].event, 'journal_end', 'Last event is journal_end');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventJournal query filters by event type', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'query-test' });

  ej.append('stage_started', { stage: 'ANALYSE' });
  ej.append('llm_call_recorded', { role: 'analyst', tokens: 1000 });
  ej.append('stage_ended', { stage: 'ANALYSE' });
  ej.append('llm_call_recorded', { role: 'architect', tokens: 2000 });
  ej.close();

  const llmEvents = ej.query({ event: 'llm_call_recorded' });
  assertEqual(llmEvents.length, 2, 'Should find 2 LLM events');

  const stageEvents = ej.query({ category: 'stage' });
  assertEqual(stageEvents.length, 2, 'Should find 2 stage events');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventJournal query filters by time range', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'time-test' });

  const before = Date.now();
  ej.append('event_a', {});
  const middle = Date.now();
  ej.append('event_b', {});
  ej.close();

  const afterMiddle = ej.query({ since: middle });
  // Should include event_b and journal_end (both at or after middle)
  assert.ok(afterMiddle.length >= 1, 'Should find events after middle timestamp');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventJournal getStats tracks event counts', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'stats-test' });

  ej.append('stage_started', { stage: 'CODE' });
  ej.append('llm_call_recorded', { role: 'dev' });
  ej.append('llm_call_recorded', { role: 'dev' });

  const stats = ej.getStats();
  // journal_start (1) + 3 appended = 4
  assertEqual(stats.totalEvents, 4, 'Total events count');
  assert.ok(stats.eventsByCategory.stage >= 1, 'Stage category count');
  assert.ok(stats.eventsByCategory.llm >= 2, 'LLM category count');
  assert.ok(stats.firstEventTs !== null, 'First event timestamp set');
  assert.ok(stats.lastEventTs !== null, 'Last event timestamp set');

  ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventJournal getSummary returns markdown', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'summary-test' });

  ej.append('stage_started', { stage: 'PLAN' });
  ej.close();

  const summary = ej.getSummary();
  assert.ok(summary.includes('Event Journal Summary'), 'Summary has title');
  assert.ok(summary.includes('summary-test'), 'Summary has session ID');
  assert.ok(summary.includes('Events by Category'), 'Summary has category table');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. HookSystem Integration
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 B. HookSystem Integration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

const { HookSystem } = require('../hooks/hook-system');

const hookTests = [];

hookTests.push(asyncTest('attachToHookSystem captures emitted events', async () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'hook-test' });
  const hs = new HookSystem();

  ej.attachToHookSystem(hs);

  await hs.emit('before_state_transition', { fromState: 'INIT', toState: 'ANALYSE' });
  await hs.emit('stage_started', { stage: 'ANALYSE' });
  await hs.emit('llm_call_recorded', { role: 'analyst', tokens: 2000 });
  await hs.emit('stage_ended', { stage: 'ANALYSE', status: 'ok' });
  await hs.emit('after_state_transition', { fromState: 'INIT', toState: 'ANALYSE' });

  await ej.close();

  const events = loadJournal(ej.journalPath);
  // journal_start + 5 hook events + journal_end = 7
  assertEqual(events.length, 7, 'Total events (start + 5 hooks + end)');

  // Verify categories
  const lifecycle = events.filter(e => e.category === 'lifecycle');
  const stage = events.filter(e => e.category === 'stage');
  const llm = events.filter(e => e.category === 'llm');
  assertEqual(lifecycle.length, 2, 'Lifecycle events (before + after transition)');
  assertEqual(stage.length, 2, 'Stage events (started + ended)');
  assertEqual(llm.length, 1, 'LLM events');

  fs.rmSync(dir, { recursive: true, force: true });
}));

hookTests.push(asyncTest('attachToHookSystem preserves original emit behavior', async () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'preserve-test' });
  const hs = new HookSystem();

  let handlerCalled = false;
  hs.on('stage_started', async () => {
    handlerCalled = true;
  });

  ej.attachToHookSystem(hs);

  await hs.emit('stage_started', { stage: 'CODE' });

  assert.ok(handlerCalled, 'Original handler should still be called after journal attachment');

  await ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
}));

hookTests.push(asyncTest('attachToHookSystem tracks current stage context', async () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'stage-ctx-test' });
  const hs = new HookSystem();

  ej.attachToHookSystem(hs);

  await hs.emit('stage_started', { stage: 'ARCHITECT' });
  await hs.emit('llm_call_recorded', { role: 'architect', tokens: 5000 });
  await hs.emit('stage_ended', { stage: 'ARCHITECT' });

  await ej.close();

  const events = loadJournal(ej.journalPath);
  const llmEvent = events.find(e => e.event === 'llm_call_recorded');
  assertEqual(llmEvent.stage, 'ARCHITECT', 'LLM event should inherit stage context from stage_started');

  fs.rmSync(dir, { recursive: true, force: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// C. Payload Sanitization
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 C. Payload Sanitization \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

test('Payload sanitization truncates long strings', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'sanitize-long' });

  const longString = 'x'.repeat(1000);
  const sanitized = ej._sanitizePayload({ text: longString });
  assert.ok(sanitized.text.length < 600, 'Long string should be truncated');
  assert.ok(sanitized.text.includes('truncated'), 'Truncation marker present');

  ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Payload sanitization handles functions', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'sanitize-fn' });

  const sanitized = ej._sanitizePayload({ fn: () => {}, name: 'test' });
  assertEqual(sanitized.fn, '[function]', 'Function replaced with marker');
  assertEqual(sanitized.name, 'test', 'Normal value preserved');

  ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Payload sanitization handles errors', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'sanitize-err' });

  const err = new Error('test error');
  const sanitized = ej._sanitizePayload({ error: err });
  assert.ok(sanitized.error.message === 'test error', 'Error message preserved');
  assert.ok(sanitized.error.name === 'Error', 'Error name preserved');

  ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Payload sanitization limits depth', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'sanitize-depth' });

  const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
  const sanitized = ej._sanitizePayload(deep);
  // depth limit is 3, so d should be depth-limited
  assertEqual(sanitized.a.b.c.d, '[depth-limited]', 'Deep nesting should be limited');

  ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Payload sanitization handles null and primitives', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'sanitize-prim' });

  assertEqual(ej._sanitizePayload(null), null, 'null preserved');
  assertEqual(ej._sanitizePayload(undefined), undefined, 'undefined preserved');
  assertEqual(ej._sanitizePayload(42), 42, 'number preserved');
  assertEqual(ej._sanitizePayload('hello'), 'hello', 'string preserved');

  ej.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. Static Helpers
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 D. Static Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

test('loadJournal returns empty array for non-existent file', () => {
  const result = loadJournal('/non/existent/file.jsonl');
  assert.ok(Array.isArray(result), 'Should return array');
  assertEqual(result.length, 0, 'Should be empty');
});

test('loadJournal applies filters', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'load-filter' });

  ej.append('stage_started', { stage: 'PLAN' });
  ej.append('llm_call_recorded', { role: 'planner' });
  ej.append('stage_ended', { stage: 'PLAN' });
  ej.close();

  const all = loadJournal(ej.journalPath);
  assert.ok(all.length >= 4, 'Should have at least 4 events');

  const stageOnly = loadJournal(ej.journalPath, { category: 'stage' });
  assertEqual(stageOnly.length, 2, 'Stage filter should return 2');

  const limited = loadJournal(ej.journalPath, { limit: 2 });
  assertEqual(limited.length, 2, 'Limit should cap results');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('listJournals finds journal files in directory', () => {
  const dir = tmpDir();

  // Create some fake journal files
  fs.writeFileSync(path.join(dir, 'event-journal-session-a.jsonl'), '{}', 'utf-8');
  fs.writeFileSync(path.join(dir, 'event-journal-session-b.jsonl'), '{}', 'utf-8');
  fs.writeFileSync(path.join(dir, 'other-file.txt'), 'not a journal', 'utf-8');

  const journals = listJournals(dir);
  assertEqual(journals.length, 2, 'Should find 2 journal files');
  assert.ok(journals[0].sessionId === 'session-b' || journals[0].sessionId === 'session-a', 'Session ID extracted');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('listJournals returns empty for non-existent directory', () => {
  const result = listJournals('/non/existent/dir');
  assertEqual(result.length, 0, 'Should return empty array');
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 E. Edge Cases \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

test('Disabled journal is a no-op', () => {
  const ej = new EventJournal({ enabled: false });
  ej.append('test', { data: 'ignored' });
  ej.close();
  assertEqual(ej.getStats().totalEvents, 0, 'Should have 0 events');
});

test('Disabled journal attachToHookSystem does nothing', () => {
  const ej = new EventJournal({ enabled: false });
  const mockHooks = { emit: async () => {} };
  const originalEmit = mockHooks.emit;
  ej.attachToHookSystem(mockHooks);
  assert.ok(mockHooks.emit === originalEmit, 'Should not wrap emit when disabled');
});

test('loadJournal handles malformed JSON lines gracefully', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'malformed.jsonl');
  fs.writeFileSync(filePath, '{"seq":0}\nnot json\n{"seq":2}\n', 'utf-8');

  const events = loadJournal(filePath);
  assertEqual(events.length, 2, 'Should skip malformed line and parse valid ones');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventJournal sequence numbers are monotonically increasing', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'seq-test' });

  ej.append('event_a', {});
  ej.append('event_b', {});
  ej.append('event_c', {});
  ej.close();

  const events = loadJournal(ej.journalPath);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq > events[i - 1].seq,
      'seq[' + i + ']=' + events[i].seq + ' should be > seq[' + (i - 1) + ']=' + events[i - 1].seq);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('EventJournal events have ISO timestamp', () => {
  const dir = tmpDir();
  const ej = new EventJournal({ outputDir: dir, sessionId: 'iso-test' });

  ej.append('test_event', {});
  ej.close();

  const events = loadJournal(ej.journalPath);
  for (const e of events) {
    assert.ok(e.iso, 'Event should have iso field');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(e.iso), 'ISO timestamp format: ' + e.iso);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

Promise.all(hookTests).then(() => {
  console.log('\n' + '='.repeat(60));
  console.log('  P2-1 EventJournal Tests: ' + passed + ' passed, ' + failed + ' failed');
  console.log('='.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
});
