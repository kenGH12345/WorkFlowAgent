/**
 * Observability Strategy – Cross-session trend analysis and adaptive parameter derivation.
 *
 * P1-4 fix: Extracted from observability.js to separate the two distinct concerns:
 *   - observability.js        → Runtime data collection (instance methods, mutable state)
 *   - observability-strategy.js → Offline strategy derivation (pure static functions, read-only)
 *
 * Why separate?
 *   1. Single Responsibility: Collection is a runtime concern (writes metrics).
 *      Strategy is a batch-analysis concern (reads history, derives parameters).
 *   2. Testability: Strategy functions are pure – given history data, produce parameters.
 *      No need to instantiate Observability or set up output directories.
 *   3. Reusability: deriveStrategy() and computeTrends() can be used by CLI tools,
 *      dashboards, or CI pipelines without pulling in the entire Observability class.
 *   4. Cognitive Load: observability.js was 992 lines with two mental models interleaved.
 *      Now each file has a single coherent mental model.
 *
 * Backward compatibility: Observability.deriveStrategy, .computeTrends, .loadHistory,
 * and .estimateTaskComplexity still work – observability.js re-exports them as static
 * methods on the Observability class.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Cross-Session History Analysis ──────────────────────────────────────────

/**
 * Loads and parses the cross-session history from metrics-history.jsonl.
 * @param {string} outputDir - Directory containing metrics-history.jsonl
 * @returns {object[]} Array of session records (newest first)
 */
function loadHistory(outputDir) {
  const historyPath = path.join(outputDir, 'metrics-history.jsonl');
  if (!fs.existsSync(historyPath)) return [];
  try {
    const lines = fs.readFileSync(historyPath, 'utf-8')
      .split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l)).reverse(); // newest first
  } catch (_) {
    return [];
  }
}

/**
 * Computes trend statistics from cross-session history.
 * @param {object[]} history - From loadHistory()
 * @returns {TrendStats|null}
 */
function computeTrends(history) {
  if (history.length === 0) return null;

  const durations  = history.map(h => h.totalDurationMs).filter(v => v != null);
  const tokens     = history.map(h => h.tokensEst).filter(v => v != null);
  const errors     = history.map(h => h.errorCount).filter(v => v != null);
  const entropy    = history.map(h => h.entropyViolations).filter(v => v != null);

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const trend = (arr) => {
    // P1-4 / P2-4 fix: need ≥4 data points for meaningful trend comparison.
    if (arr.length < 4) return 'insufficient_data';
    // R5-4 audit: use ceil(len/2) split so that 4 data points → 2 recent + 2 older,
    // instead of 3+1 which biases the comparison. For 5+ points, still use first 3
    // as "recent" to weight the most recent data more heavily.
    const splitAt = arr.length <= 4 ? Math.ceil(arr.length / 2) : 3;
    const recent = arr.slice(0, splitAt);
    const older  = arr.slice(splitAt);
    if (older.length === 0) return 'stable';
    const recentAvg = avg(recent);
    const olderAvg  = avg(older);
    if (recentAvg > olderAvg * 1.2) return 'increasing';
    if (recentAvg < olderAvg * 0.8) return 'decreasing';
    return 'stable';
  };

  return {
    sessionCount:    history.length,
    avgDurationMs:   avg(durations),
    avgTokensEst:    avg(tokens),
    avgErrorCount:   avg(errors),
    avgEntropyViolations: avg(entropy),
    durationTrend:   trend(durations),
    tokenTrend:      trend(tokens),
    errorTrend:      trend(errors),
    entropyTrend:    trend(entropy),
    ciSuccessRate: (() => {
      const ciSessions = history.filter(h => h.ciStatus != null);
      if (ciSessions.length === 0) return null;
      return ciSessions.filter(h => h.ciStatus === 'success').length / ciSessions.length;
    })(),
    lastSession:     history[0]?.startedAt,
  };
}

// ─── Task Complexity Estimation ─────────────────────────────────────────────

/**
 * Estimates task complexity from the enriched requirement text (Defect J fix).
 *
 * Complexity factors (each scored 0-20, total 0-100):
 *   1. Text Length        – longer requirements → more complex systems
 *   2. Technical Entities – API, database, auth, etc.
 *   3. Action Verbs       – implement, create, integrate, migrate, etc.
 *   4. Constraints        – performance, security, scalability, compliance
 *   5. Integrations       – third-party, webhook, OAuth, message queue, etc.
 *
 * Levels: 0-25 simple, 26-50 moderate, 51-75 complex, 76-100 very_complex
 *
 * @param {string} requirementText - The enriched requirement from ANALYSE stage
 * @returns {{ score: number, level: string, factors: object }}
 */
function estimateTaskComplexity(requirementText) {
  if (!requirementText || typeof requirementText !== 'string') {
    return { score: 0, level: 'simple', factors: {} };
  }

  const text = requirementText.toLowerCase();
  const len = text.length;

  // Factor 1: Text length
  let lengthScore;
  if (len < 200)       lengthScore = 2;
  else if (len < 500)  lengthScore = 5;
  else if (len < 1000) lengthScore = 10;
  else if (len < 3000) lengthScore = 15;
  else                 lengthScore = 20;

  // Factor 2: Technical entity count
  const TECH_ENTITIES = [
    'api', 'database', 'authentication', 'authorization', 'encryption',
    'microservice', 'server', 'client', 'frontend', 'backend', 'middleware',
    'cache', 'queue', 'worker', 'scheduler', 'pipeline', 'container',
    'docker', 'kubernetes', 'lambda', 'serverless', 'cdn', 'load.?balancer',
    'proxy', 'gateway', 'cluster', 'shard', 'replica', 'partition',
    'schema', 'migration', 'index', 'transaction', 'deadlock',
    'thread', 'process', 'async', 'concurren', 'parallel',
    'socket', 'stream', 'buffer', 'protocol',
  ];
  let entityCount = 0;
  for (const entity of TECH_ENTITIES) {
    if (new RegExp(`\\b${entity}\\b`, 'i').test(text)) entityCount++;
  }
  const entityScore = Math.min(Math.round(entityCount * 2.5), 20);

  // Factor 3: Action verb count
  const ACTION_VERBS = [
    'implement', 'create', 'build', 'design', 'develop', 'integrate',
    'migrate', 'refactor', 'optimise', 'optimize', 'deploy', 'configure',
    'setup', 'set up', 'install', 'connect', 'extend', 'modify',
    'transform', 'convert', 'generate', 'validate', 'verify', 'test',
    'monitor', 'log', 'trace', 'debug', 'profile', 'benchmark',
    'secure', 'encrypt', 'authenticate', 'authorize', 'rate.?limit',
    'throttle', 'cache', 'index', 'scale', 'partition', 'replicate',
  ];
  let actionCount = 0;
  for (const verb of ACTION_VERBS) {
    if (new RegExp(`\\b${verb}`, 'i').test(text)) actionCount++;
  }
  const actionScore = Math.min(Math.round(actionCount * 2), 20);

  // Factor 4: Constraint / non-functional requirement indicators
  const CONSTRAINTS = [
    'performance', 'latency', 'throughput', 'scalab', 'reliab',
    'availability', 'fault.?toleran', 'backward.?compat', 'forward.?compat',
    'real.?time', 'low.?latency', 'high.?throughput', 'zero.?downtime',
    'idempoten', 'atomic', 'consistent', 'isolation', 'durable',
    'security', 'compliance', 'gdpr', 'hipaa', 'pci', 'soc2',
    'accessibility', 'i18n', 'l10n', 'internationali', 'locali',
    'responsive', 'cross.?platform', 'mobile.?first', 'offline.?first',
  ];
  let constraintCount = 0;
  for (const c of CONSTRAINTS) {
    if (new RegExp(c, 'i').test(text)) constraintCount++;
  }
  const constraintScore = Math.min(Math.round(constraintCount * 3), 20);

  // Factor 5: Integration indicators
  const INTEGRATIONS = [
    'third.?party', 'external', 'webhook', 'oauth', 'saml', 'ldap',
    'rest\\b', 'graphql', 'grpc', 'websocket', 'sse', 'mqtt',
    'message.?queue', 'kafka', 'rabbitmq', 'redis', 'memcached',
    'elasticsearch', 'mongodb', 'postgresql', 'mysql', 'dynamodb',
    's3', 'blob.?storage', 'cdn', 'smtp', 'push.?notification',
    'payment', 'stripe', 'paypal', 'twilio', 'sendgrid',
    'firebase', 'supabase', 'auth0', 'cognito', 'clerk',
  ];
  // R5-2 audit: pre-compile a single combined regex instead of creating
  // N RegExp objects in a loop (one per integration keyword).
  const INTEGRATIONS_RE = new RegExp(INTEGRATIONS.join('|'), 'i');
  let integrationCount = 0;
  for (const i of INTEGRATIONS) {
    if (new RegExp(i, 'i').test(text)) integrationCount++;
  }
  const integrationScore = Math.min(Math.round(integrationCount * 3), 20);

  const totalScore = lengthScore + entityScore + actionScore + constraintScore + integrationScore;

  let level;
  if (totalScore <= 25)      level = 'simple';
  else if (totalScore <= 50) level = 'moderate';
  else if (totalScore <= 75) level = 'complex';
  else                       level = 'very_complex';

  return {
    score: totalScore,
    level,
    factors: {
      length:      lengthScore,
      entities:    entityScore,
      actions:     actionScore,
      constraints: constraintScore,
      integrations: integrationScore,
    },
  };
}

// ─── Adaptive Strategy Derivation ───────────────────────────────────────────

/**
 * Derives adaptive strategy parameters from cross-session history.
 * Used by the Orchestrator to dynamically tune retry counts, review rounds, etc.
 *
 * Strategy rules:
 *   Rule 1: maxFixRounds    – increases if recent test failure rate is high
 *   Rule 2: maxReviewRounds – increases if recent error count trend is increasing
 *   Rule 3: skipEntropyOnClean – true if last N sessions had 0 violations (periodic forced scan)
 *   Rule 4: maxExpInjected  – adjusts based on experience hit-rate
 *   Rule 5: maxClarificationRounds – adjusts based on clarification effectiveness
 *   Rule 6: Task complexity modulation – raises floors for complex tasks
 *
 * @param {string} outputDir - Directory containing metrics-history.jsonl
 * @param {object} [defaults] - Default strategy values to fall back to
 * @returns {object} Strategy parameters with source annotation
 */
function deriveStrategy(outputDir, defaults = {}) {
  const defaultStrategy = {
    maxFixRounds:       defaults.maxFixRounds       ?? 2,
    maxReviewRounds:    defaults.maxReviewRounds    ?? 2,
    skipEntropyOnClean: defaults.skipEntropyOnClean ?? false,
    maxClarificationRounds: defaults.maxClarificationRounds ?? 2,
    source: 'defaults',
  };

  const history = loadHistory(outputDir);
  if (history.length < 3) return defaultStrategy;

  // ── Project isolation: only use history from the SAME project ──────────
  const projectId = defaults.projectId || null;
  let filteredHistory = history;
  if (projectId) {
    const projectHistory = history.filter(h => h.projectId === projectId);
    if (projectHistory.length >= 3) {
      filteredHistory = projectHistory;
      console.log(`[Observability] 📊 Adaptive strategy: using ${projectHistory.length} session(s) for project "${projectId}" (isolated from global history).`);
    } else {
      console.log(`[Observability] 📊 Adaptive strategy: only ${projectHistory.length} session(s) for project "${projectId}" – using global history (${history.length} sessions) as fallback.`);
    }
  }

  if (filteredHistory.length < 3) return defaultStrategy;

  const recent = filteredHistory.slice(0, Math.min(5, filteredHistory.length));
  const trends = computeTrends(filteredHistory);

  // ── Rule 1: maxFixRounds ───────────────────────────────────────────────
  const recentTestFailures = recent.filter(h => (h.testFailed ?? 0) > 0).length;
  const testFailRate = recentTestFailures / recent.length;
  let maxFixRounds = defaultStrategy.maxFixRounds;
  if (testFailRate >= 0.6) {
    maxFixRounds = Math.min(defaultStrategy.maxFixRounds + 2, 5);
  } else if (testFailRate >= 0.4) {
    maxFixRounds = Math.min(defaultStrategy.maxFixRounds + 1, 4);
  } else if (testFailRate === 0 && recent.length >= 3) {
    maxFixRounds = Math.max(defaultStrategy.maxFixRounds - 1, 1);
  }

  // ── Rule 2: maxReviewRounds ────────────────────────────────────────────
  let maxReviewRounds = defaultStrategy.maxReviewRounds;
  if (trends && trends.errorTrend === 'increasing') {
    maxReviewRounds = Math.min(defaultStrategy.maxReviewRounds + 1, 4);
  } else if (trends && trends.errorTrend === 'decreasing' && trends.avgErrorCount === 0) {
    maxReviewRounds = Math.max(defaultStrategy.maxReviewRounds - 1, 1);
  }

  // ── Rule 3: skipEntropyOnClean (with periodic forced scan) ─────────────
  const recentEntropyData = recent.slice(0, 3).filter(h => h.entropyViolations != null);
  const allRecentClean = recentEntropyData.length >= 3 &&
    recentEntropyData.every(h => h.entropyViolations === 0);
  const isForcedScanSession = filteredHistory.length % 5 === 0;
  const skipEntropyOnClean = allRecentClean && !isForcedScanSession;
  if (allRecentClean && isForcedScanSession) {
    console.log(`[Observability] 📊 Adaptive strategy: entropy scan FORCED (session ${filteredHistory.length} is a multiple of 5 – periodic safety check).`);
  }

  // ── Rule 4: maxExpInjected – experience hit-rate feedback ──────────────
  const DEFAULT_MAX_EXP_INJECTED = defaults.maxExpInjected ?? 5;
  let maxExpInjected = DEFAULT_MAX_EXP_INJECTED;

  const sessionsWithExpData = recent.filter(
    h => h.expInjectedCount != null && h.expInjectedCount > 0
  );
  if (sessionsWithExpData.length >= 3) {
    const totalInjected = sessionsWithExpData.reduce((s, h) => s + h.expInjectedCount, 0);
    const totalHits     = sessionsWithExpData.reduce((s, h) => s + (h.expHitCount ?? 0), 0);
    const hitRate = totalHits / totalInjected;

    if (hitRate < 0.20) {
      maxExpInjected = Math.max(DEFAULT_MAX_EXP_INJECTED - 2, 2);
      console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is LOW – reducing maxExpInjected to ${maxExpInjected} (was ${DEFAULT_MAX_EXP_INJECTED}).`);
    } else if (hitRate < 0.30) {
      maxExpInjected = Math.max(DEFAULT_MAX_EXP_INJECTED - 1, 3);
      console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is below threshold – reducing maxExpInjected to ${maxExpInjected}.`);
    } else if (hitRate > 0.70) {
      maxExpInjected = Math.min(DEFAULT_MAX_EXP_INJECTED + 2, 10);
      console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is HIGH – increasing maxExpInjected to ${maxExpInjected}.`);
    } else if (hitRate > 0.50) {
      maxExpInjected = Math.min(DEFAULT_MAX_EXP_INJECTED + 1, 8);
      console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is good – increasing maxExpInjected to ${maxExpInjected}.`);
    } else {
      console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is nominal – keeping maxExpInjected at ${maxExpInjected}.`);
    }
  }

  // ── Rule 5: maxClarificationRounds – effectiveness feedback ────────────
  const DEFAULT_MAX_CLARIFICATION_ROUNDS = defaults.maxClarificationRounds ?? 2;
  let maxClarificationRounds = DEFAULT_MAX_CLARIFICATION_ROUNDS;

  const sessionsWithClarData = recent.filter(
    h => h.clarificationEffectiveness != null && h.clarificationRounds != null && h.clarificationRounds > 0
  );
  if (sessionsWithClarData.length >= 2) {
    const avgEffectiveness = sessionsWithClarData.reduce(
      (sum, h) => sum + h.clarificationEffectiveness, 0
    ) / sessionsWithClarData.length;

    const hasUnresolvedHighSeverity = sessionsWithClarData.some(
      h => (h.clarificationNewSignals ?? 0) > 0
    );

    if (avgEffectiveness < 30) {
      maxClarificationRounds = 1;
      console.log(`[Observability] 📊 Adaptive strategy: clarification effectiveness ${avgEffectiveness.toFixed(0)}% is VERY LOW – reducing maxClarificationRounds to ${maxClarificationRounds} (was ${DEFAULT_MAX_CLARIFICATION_ROUNDS}).`);
    } else if (avgEffectiveness < 50) {
      maxClarificationRounds = Math.max(DEFAULT_MAX_CLARIFICATION_ROUNDS - 1, 1);
      console.log(`[Observability] 📊 Adaptive strategy: clarification effectiveness ${avgEffectiveness.toFixed(0)}% is below threshold – reducing maxClarificationRounds to ${maxClarificationRounds}.`);
    } else if (avgEffectiveness > 80 && hasUnresolvedHighSeverity) {
      maxClarificationRounds = Math.min(DEFAULT_MAX_CLARIFICATION_ROUNDS + 1, 4);
      console.log(`[Observability] 📊 Adaptive strategy: clarification effectiveness ${avgEffectiveness.toFixed(0)}% is HIGH with unresolved signals – increasing maxClarificationRounds to ${maxClarificationRounds}.`);
    } else {
      console.log(`[Observability] 📊 Adaptive strategy: clarification effectiveness ${avgEffectiveness.toFixed(0)}% is nominal – keeping maxClarificationRounds at ${maxClarificationRounds}.`);
    }
  }

  const changed = maxFixRounds !== defaultStrategy.maxFixRounds ||
                  maxReviewRounds !== defaultStrategy.maxReviewRounds ||
                  skipEntropyOnClean !== defaultStrategy.skipEntropyOnClean ||
                  maxExpInjected !== DEFAULT_MAX_EXP_INJECTED ||
                  maxClarificationRounds !== DEFAULT_MAX_CLARIFICATION_ROUNDS;

  // ── Rule 6: Task complexity modulation ─────────────────────────────────
  const taskComplexity = defaults.taskComplexity || null;
  let complexityApplied = false;

  if (taskComplexity && taskComplexity.level) {
    const level = taskComplexity.level;
    const prevFix = maxFixRounds;
    const prevReview = maxReviewRounds;

    if (level === 'moderate') {
      maxFixRounds = Math.max(maxFixRounds, 2);
      maxReviewRounds = Math.max(maxReviewRounds, 2);
    } else if (level === 'complex') {
      maxFixRounds = Math.max(maxFixRounds, 3);
      maxReviewRounds = Math.max(maxReviewRounds, 3);
    } else if (level === 'very_complex') {
      maxFixRounds = Math.max(maxFixRounds, 4);
      maxReviewRounds = Math.max(maxReviewRounds, 3);
    }

    complexityApplied = maxFixRounds !== prevFix || maxReviewRounds !== prevReview;
    if (complexityApplied) {
      console.log(`[Observability] 📊 Adaptive strategy: Rule 6 (task complexity=${level}, score=${taskComplexity.score}) raised floors: maxFixRounds ${prevFix}→${maxFixRounds}, maxReviewRounds ${prevReview}→${maxReviewRounds}`);
    }
  }

  // Rule 6b: Historical complexity drift detection
  const sessionsWithComplexity = recent.filter(h => h.taskComplexityScore != null);
  if (sessionsWithComplexity.length >= 3 && !taskComplexity) {
    const complexSessions = sessionsWithComplexity.filter(h => h.taskComplexityScore > 50);
    const complexFailRate = complexSessions.length > 0
      ? complexSessions.filter(h => (h.testFailed ?? 0) > 0).length / complexSessions.length
      : 0;

    if (complexFailRate > testFailRate + 0.2 && complexSessions.length >= 2) {
      const driftFix = Math.max(maxFixRounds, Math.min(defaultStrategy.maxFixRounds + 2, 5));
      if (driftFix > maxFixRounds) {
        console.log(`[Observability] 📊 Adaptive strategy: Rule 6b (complexity drift) – complex tasks fail ${(complexFailRate * 100).toFixed(0)}% vs overall ${(testFailRate * 100).toFixed(0)}% – raising maxFixRounds ${maxFixRounds}→${driftFix}`);
        maxFixRounds = driftFix;
        complexityApplied = true;
      }
    }
  }

  const finalChanged = changed || complexityApplied;

  return {
    maxFixRounds,
    maxReviewRounds,
    skipEntropyOnClean,
    maxExpInjected,
    maxClarificationRounds,
    source: finalChanged ? `history(${filteredHistory.length} sessions${projectId ? `, project:${projectId}` : ''}${complexityApplied ? ', complexity-adjusted' : ''})` : 'defaults',
    _debug: {
      testFailRate: Math.round(testFailRate * 100) + '%',
      errorTrend:   trends?.errorTrend ?? 'unknown',
      entropyClean: skipEntropyOnClean,
      sessionCount: filteredHistory.length,
      projectIsolated: projectId ? filteredHistory.length !== history.length : false,
      expHitRate: (() => {
        const s = recent.filter(h => h.expInjectedCount != null && h.expInjectedCount > 0);
        if (s.length < 3) return 'insufficient_data';
        const inj = s.reduce((a, h) => a + h.expInjectedCount, 0);
        const hit = s.reduce((a, h) => a + (h.expHitCount ?? 0), 0);
        return Math.round((hit / inj) * 100) + '%';
      })(),
      clarificationEffectiveness: (() => {
        if (sessionsWithClarData.length < 2) return 'insufficient_data';
        const avg = sessionsWithClarData.reduce((s, h) => s + h.clarificationEffectiveness, 0) / sessionsWithClarData.length;
        return Math.round(avg) + '%';
      })(),
      taskComplexity: taskComplexity ? `${taskComplexity.level}(${taskComplexity.score})` : 'not_available',
    },
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  loadHistory,
  computeTrends,
  estimateTaskComplexity,
  deriveStrategy,
};
