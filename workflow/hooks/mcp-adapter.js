/**
 * MCP Adapter – Model Context Protocol integration
 *
 * Implements Requirement 6.5: connect to external systems via MCP protocol.
 * Provides a pluggable adapter layer for TAPD, DevTools, and other external tools.
 *
 * Architecture:
 *   MCPAdapter (base) ← TAPDAdapter, DevToolsAdapter, CustomAdapter
 *
 * The adapter exposes a unified interface regardless of the underlying system.
 */

'use strict';

// ─── Base MCP Adapter ─────────────────────────────────────────────────────────

class MCPAdapter {
  /**
   * @param {string} name    - Adapter name (e.g. 'tapd', 'devtools')
   * @param {object} config  - Adapter-specific configuration
   */
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this._connected = false;
  }

  /** Establishes connection to the external system */
  async connect() {
    throw new Error(`[MCPAdapter:${this.name}] connect() must be implemented by subclass`);
  }

  /** Disconnects from the external system */
  async disconnect() {
    this._connected = false;
    console.log(`[MCPAdapter:${this.name}] Disconnected.`);
  }

  /**
   * Sends a notification to the external system.
   * @param {string} event   - Event type
   * @param {object} payload - Event data
   */
  async notify(event, payload) {
    throw new Error(`[MCPAdapter:${this.name}] notify() must be implemented by subclass`);
  }

  /**
   * Queries data from the external system.
   * @param {string} query
   * @param {object} [params]
   */
  async query(query, params = {}) {
    throw new Error(`[MCPAdapter:${this.name}] query() must be implemented by subclass`);
  }

  get isConnected() {
    return this._connected;
  }
}

// ─── TAPD Adapter ─────────────────────────────────────────────────────────────

/**
 * TAPDAdapter – connects to Tencent TAPD project management system.
 * Allows the workflow to create stories, tasks, and bugs automatically.
 */
class TAPDAdapter extends MCPAdapter {
  constructor(config = {}) {
    super('tapd', config);
    // config: { apiBase, accessToken, workspaceId }
  }

  async connect() {
    // In production: validate credentials and test API connectivity
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
    // Stub: replace with actual TAPD REST API call
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

// ─── DevTools Adapter ─────────────────────────────────────────────────────────

/**
 * DevToolsAdapter – connects to developer tooling (CI/CD, code review, etc.)
 * Allows the workflow to trigger builds, post PR comments, and query CI status.
 */
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

// ─── MCP Registry ─────────────────────────────────────────────────────────────

/**
 * MCPRegistry – manages all registered MCP adapters.
 * Provides a unified interface for the orchestrator to interact with external systems.
 */
class MCPRegistry {
  constructor() {
    /** @type {Map<string, MCPAdapter>} */
    this._adapters = new Map();
  }

  /**
   * Registers an adapter.
   * @param {MCPAdapter} adapter
   */
  register(adapter) {
    this._adapters.set(adapter.name, adapter);
    console.log(`[MCPRegistry] Registered adapter: ${adapter.name}`);
  }

  /**
   * Connects all registered adapters.
   * N82 fix: each adapter's connect() is wrapped in an independent try/catch so a
   * single failing adapter does not abort the connection of subsequent adapters.
   */
  async connectAll() {
    for (const adapter of this._adapters.values()) {
      try {
        await adapter.connect();
      } catch (err) {
        console.warn(`[MCPRegistry] Adapter "${adapter.name}" failed to connect: ${err.message}`);
      }
    }
  }

  /**
   * Broadcasts an event to all connected adapters.
   * @param {string} event
   * @param {object} payload
   */
  async broadcastNotify(event, payload) {
    for (const adapter of this._adapters.values()) {
      if (adapter.isConnected) {
        await adapter.notify(event, payload).catch(err =>
          console.warn(`[MCPRegistry] Adapter "${adapter.name}" notify failed: ${err.message}`)
        );
      }
    }
  }

  /**
   * Gets a specific adapter by name.
   * @param {string} name
   * @returns {MCPAdapter}
   */
  get(name) {
    const adapter = this._adapters.get(name);
    if (!adapter) throw new Error(`[MCPRegistry] Adapter not found: "${name}"`);
    return adapter;
  }
}

module.exports = { MCPAdapter, TAPDAdapter, DevToolsAdapter, MCPRegistry };
