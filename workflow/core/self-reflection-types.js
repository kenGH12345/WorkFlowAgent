/**
 * Self-Reflection Types – Shared enums for the reflection subsystem
 *
 * Extracted as part of A-1 architecture fix (God Object decomposition).
 * Used by: SelfReflectionEngine, HealthAuditor, QualityGate
 */

'use strict';

const ReflectionType = {
  ISSUE_DETECTED:    'issue_detected',
  PATTERN_RECURRING: 'pattern_recurring',
  QUALITY_GATE_FAIL: 'quality_gate_fail',
  ANOMALY_DETECTED:  'anomaly_detected',
  OPTIMISATION_OPP:  'optimisation_opp',
};

const ReflectionSeverity = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
};

const ReflectionStatus = {
  OPEN:     'open',
  ANALYSED: 'analysed',
  FIXED:    'fixed',
  DEFERRED: 'deferred',
};

module.exports = {
  ReflectionType,
  ReflectionSeverity,
  ReflectionStatus,
};
