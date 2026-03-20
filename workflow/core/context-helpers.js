/**
 * Context Helpers — shared utilities for context builder modules.
 *
 * Extracted during the Stage-Helpers architecture refactor.
 * Contains the _getContextProfile() helper used by all three context builders.
 */

'use strict';

const { SmartContextSelector } = require('./smart-context-selector');

/**
 * Retrieves (or lazily creates) the ContextProfile from the Orchestrator instance.
 * The profile is cached on orch._contextProfile for reuse across stages.
 *
 * @param {Orchestrator} orch
 * @returns {import('./smart-context-selector').ContextProfile|null}
 */
function _getContextProfile(orch) {
  // Return cached profile if already computed for this requirement
  if (orch._contextProfile) return orch._contextProfile;

  try {
    // Try ServiceContainer first
    if (orch.services && orch.services.has('smartContextSelector')) {
      const selector = orch.services.resolve('smartContextSelector');
      const profile = selector.classify(orch._currentRequirement || '');
      orch._contextProfile = profile;
      console.log(`[SmartContext] ${profile.toString()}`);
      return profile;
    }
    // Fallback: create one on the fly
    const selector = new SmartContextSelector(orch.projectRoot, orch._config);
    const profile = selector.classify(orch._currentRequirement || '');
    orch._contextProfile = profile;
    console.log(`[SmartContext] ${profile.toString()}`);
    return profile;
  } catch (err) {
    console.warn(`[SmartContext] Classification failed (non-fatal): ${err.message}`);
    return null;
  }
}

module.exports = {
  _getContextProfile,
};
