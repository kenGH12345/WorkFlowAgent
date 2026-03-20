/**
 * DevTools Adapter – connects to developer tooling (CI/CD, code review, etc.)
 * Allows the workflow to trigger builds, post PR comments, and query CI status.
 */

'use strict';

const { MCPAdapter } = require('./base');

class DevToolsAdapter extends MCPAdapter {
  constructor(config = {}) {
    super('devtools', config);
    // config: { ciApiBase, repoUrl, authToken }
  }

  async connect() {
    console.log(`[MCPAdapter:devtools] Connecting to DevTools: ${this.config.ciApiBase || 'N/A'}`);
    this._connected = true;
    console.log(`[MCPAdapter:devtools] Connected (stub mode).`);
  }

  /**
   * Triggers a CI build for the given branch.
   * @param {string} branch
   */
  async triggerBuild(branch = 'main') {
    this._assertConnected();
    console.log(`[MCPAdapter:devtools] Triggering CI build for branch: ${branch}`);
    return { buildId: `BUILD-STUB-${Date.now()}`, branch, status: 'queued' };
  }

  /**
   * Posts a comment to a pull request.
   * @param {string} prId
   * @param {string} comment
   */
  async postPRComment(prId, comment) {
    this._assertConnected();
    console.log(`[MCPAdapter:devtools] Posting comment to PR #${prId}`);
    return { commentId: `COMMENT-STUB-${Date.now()}` };
  }

  async notify(event, payload) {
    this._assertConnected();
    console.log(`[MCPAdapter:devtools] Notify event "${event}":`, JSON.stringify(payload).slice(0, 100));
  }

  async query(query, params = {}) {
    this._assertConnected();
    console.log(`[MCPAdapter:devtools] Query: "${query}"`, params);
    return { results: [], stub: true };
  }

  _assertConnected() {
    if (!this._connected) throw new Error(`[MCPAdapter:devtools] Not connected. Call connect() first.`);
  }
}

module.exports = { DevToolsAdapter };
