/**
 * TAPD Adapter – connects to Tencent TAPD project management system.
 * Allows the workflow to create stories, tasks, and bugs automatically.
 */

'use strict';

const { MCPAdapter } = require('./base');

class TAPDAdapter extends MCPAdapter {
  constructor(config = {}) {
    super('tapd', config);
    // config: { apiBase, accessToken, workspaceId }
  }

  async connect() {
    console.log(`[MCPAdapter:tapd] Connecting to TAPD workspace: ${this.config.workspaceId || 'N/A'}`);
    this._connected = true;
    console.log(`[MCPAdapter:tapd] Connected (stub mode – replace with real API calls).`);
  }

  /**
   * Creates a TAPD story from a requirement document.
   * @param {string} title
   * @param {string} description
   * @returns {Promise<{storyId: string}>}
   */
  async createStory(title, description) {
    this._assertConnected();
    console.log(`[MCPAdapter:tapd] Creating story: "${title}"`);
    return { storyId: `TAPD-STUB-${Date.now()}`, title, description };
  }

  /**
   * Creates a TAPD bug from a test report defect.
   * @param {string} title
   * @param {string} description
   * @param {string} severity - 'fatal'|'serious'|'normal'|'tips'
   */
  async createBug(title, description, severity = 'normal') {
    this._assertConnected();
    console.log(`[MCPAdapter:tapd] Creating bug: "${title}" [${severity}]`);
    return { bugId: `BUG-STUB-${Date.now()}`, title, severity };
  }

  async notify(event, payload) {
    this._assertConnected();
    console.log(`[MCPAdapter:tapd] Notify event "${event}":`, JSON.stringify(payload).slice(0, 100));
  }

  async query(query, params = {}) {
    this._assertConnected();
    console.log(`[MCPAdapter:tapd] Query: "${query}"`, params);
    return { results: [], stub: true };
  }

  _assertConnected() {
    if (!this._connected) throw new Error(`[MCPAdapter:tapd] Not connected. Call connect() first.`);
  }
}

module.exports = { TAPDAdapter };
