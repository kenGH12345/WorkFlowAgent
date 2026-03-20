/**
 * MCP Adapter – Base classes and Registry.
 *
 * Provides:
 *   - MCPAdapter     – abstract base class for all adapters
 *   - HttpMixin      – shared HTTP GET/POST helpers (zero external deps)
 *   - MCPRegistry    – adapter registry with connect-all / broadcast-notify
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

    /**
     * P2 Optimisation: Tool Use Examples.
     * Subclasses can populate this array with example tool invocations
     * to help LLMs understand how to call the adapter's tools correctly.
     *
     * Each example is: { input: object, output: object|string, description: string }
     *
     * @type {Array<{ description: string, input: object, output: object|string }>}
     * @protected
     */
    this._toolExamples = [];
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

  /**
   * P2 Optimisation: Tool Use Examples — Enhanced tool description.
   *
   * Returns the adapter's tool definition enriched with usage examples.
   * LLMs use these examples to construct more precise tool call parameters,
   * reducing hallucinated arguments and retry loops.
   *
   * Subclasses can override this to provide domain-specific tool schemas.
   * The default implementation returns a generic descriptor with any
   * registered examples.
   *
   * @returns {{ name: string, description: string, methods: string[], examples: Array<{ description: string, input: object, output: object|string }> }}
   */
  describeWithExamples() {
    return {
      name: this.name,
      description: `MCP Adapter: ${this.name}`,
      methods: ['connect', 'disconnect', 'notify', 'query'],
      examples: this._toolExamples || [],
    };
  }

  /**
   * P2 Optimisation: Register a tool usage example.
   *
   * Call this in subclass constructors to provide LLMs with concrete
   * examples of how to invoke this adapter's tools.
   *
   * @param {string} description - What this example demonstrates
   * @param {object} input       - Example input parameters
   * @param {object|string} output - Expected output (can be truncated/summarised)
   */
  addToolExample(description, input, output) {
    if (!this._toolExamples) this._toolExamples = [];
    this._toolExamples.push({ description, input, output });
  }

  get isConnected() {
    return this._connected;
  }
}

// ─── HTTP Mixin (shared by PackageRegistry, SecurityCVE, WebSearch, LSP) ──────

/**
 * Reusable HTTP helpers using Node.js built-in https/http (zero external deps).
 * Attach to an adapter via: Object.assign(MyAdapter.prototype, HttpMixin);
 */
const HttpMixin = {
  /**
   * HTTP GET with redirect, gzip, and timeout support.
   * @param {string} url
   * @param {object} [options] - { headers, timeout }
   * @returns {Promise<string>}
   */
  _httpGet(url, options = {}) {
    const timeout = options.timeout || this.timeout || 15000;
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? require('https') : require('http');
      const req = mod.get(url, {
        headers: options.headers || {},
        timeout,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._httpGet(res.headers.location, options).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let stream = res;
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          stream = res.pipe(require('zlib').createGunzip());
        } else if (encoding === 'deflate') {
          stream = res.pipe(require('zlib').createInflate());
        }
        let body = '';
        stream.on('data', chunk => { body += chunk; });
        stream.on('end', () => resolve(body));
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    });
  },

  /**
   * HTTP POST with timeout support.
   * @param {string} url
   * @param {string} body
   * @param {object} [options] - { headers, timeout }
   * @returns {Promise<string>}
   */
  _httpPost(url, body, options = {}) {
    const timeout = options.timeout || this.timeout || 15000;
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? require('https') : require('http');
      const parsed = new URL(url);
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          ...options.headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout,
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} for POST ${url}`));
        }
        let responseBody = '';
        res.on('data', chunk => { responseBody += chunk; });
        res.on('end', () => resolve(responseBody));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout posting ${url}`)); });
      req.write(body);
      req.end();
    });
  },

  /**
   * Guard: throw if adapter is not connected.
   */
  _assertConnected() {
    if (!this._connected) throw new Error(`[MCPAdapter:${this.name}] Not connected. Call connect() first.`);
  },
};

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
   * Each adapter's connect() is wrapped in an independent try/catch so a
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

  /**
   * P2 Optimisation: Returns enriched tool descriptions for all registered adapters.
   * This provides LLMs with a comprehensive tool catalog including usage examples,
   * enabling more accurate tool selection and invocation.
   *
   * @returns {Array<{ name: string, description: string, methods: string[], examples: Array }>}
   */
  describeAllTools() {
    const descriptions = [];
    for (const adapter of this._adapters.values()) {
      if (adapter.isConnected && typeof adapter.describeWithExamples === 'function') {
        descriptions.push(adapter.describeWithExamples());
      }
    }
    return descriptions;
  }

  /**
   * P2 Optimisation: Searches registered adapters by capability keywords.
   * Implements the "Tool Search Tool" pattern at the registry level —
   * instead of exposing all adapter descriptions upfront, consumers can
   * search for relevant adapters by keyword.
   *
   * @param {string} query - Keyword(s) to search for in adapter names and descriptions
   * @returns {Array<{ name: string, description: string, methods: string[], examples: Array }>}
   */
  searchTools(query) {
    if (!query || typeof query !== 'string') return [];
    const lowerQuery = query.toLowerCase();
    const results = [];
    for (const adapter of this._adapters.values()) {
      if (!adapter.isConnected) continue;
      const desc = typeof adapter.describeWithExamples === 'function'
        ? adapter.describeWithExamples()
        : { name: adapter.name, description: '', methods: [], examples: [] };
      // Match against name, description, and method names
      const searchable = `${desc.name} ${desc.description} ${desc.methods.join(' ')}`.toLowerCase();
      if (searchable.includes(lowerQuery)) {
        results.push(desc);
      }
    }
    return results;
  }
}

module.exports = { MCPAdapter, HttpMixin, MCPRegistry };
