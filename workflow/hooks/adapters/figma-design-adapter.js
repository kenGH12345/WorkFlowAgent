/**
 * FigmaDesignAdapter – Extracts UI design specifications from Figma files.
 *
 * Connects to Figma REST API to extract design tokens (colors, typography,
 * spacing, component hierarchy) and formats them as structured Markdown for
 * injection into ARCHITECT and DEVELOPER stage prompts.
 *
 * This enables "data-driven UI generation" — DeveloperAgent receives precise
 * design specifications instead of guessing from vague text descriptions.
 *
 * Features:
 *   - Design token extraction (colors, fonts, spacing, border radius, shadows)
 *   - Component tree traversal (Frame → Auto Layout → nested components)
 *   - Responsive breakpoint inference from multiple top-level Frames
 *   - Asset export URL generation (SVG/PNG icons)
 *   - Markdown formatting optimised for LLM consumption
 *
 * Prerequisites:
 *   - Figma Personal Access Token (free: https://www.figma.com/developers/api)
 *   - Figma file key (from the file URL: figma.com/file/<FILE_KEY>/...)
 *
 * Usage:
 *   const adapter = new FigmaDesignAdapter({
 *     accessToken: 'figd_xxx',
 *     fileKey: 'abc123',
 *   });
 *   await adapter.connect();
 *   const spec = await adapter.extractDesignSpec();
 *   const block = adapter.formatDesignBlock(spec);
 *
 * Opt-in only: disabled by default. Enable via workflow.config.js:
 *   mcp: { figmaDesign: { accessToken: '...', fileKey: '...' } }
 */

'use strict';

const { MCPAdapter, HttpMixin } = require('./base');

// ─── Constants ────────────────────────────────────────────────────────────────

const FIGMA_API_BASE = 'https://api.figma.com/v1';

/**
 * Max depth for recursive component tree traversal.
 * Prevents runaway recursion on deeply nested Figma files.
 */
const MAX_TREE_DEPTH = 8;

/**
 * Max number of child nodes to process per parent.
 * Prevents token explosion on complex design files.
 */
const MAX_CHILDREN_PER_NODE = 30;

/**
 * Max total nodes to include in the component tree output.
 */
const MAX_TOTAL_NODES = 100;

// ─── Adapter ──────────────────────────────────────────────────────────────────

class FigmaDesignAdapter extends MCPAdapter {
  /**
   * @param {object} config
   * @param {string} config.accessToken - Figma Personal Access Token
   * @param {string} config.fileKey     - Figma file key (from URL)
   * @param {string} [config.nodeId]    - Specific node/page ID to extract (optional)
   * @param {number} [config.timeout]   - HTTP request timeout in ms (default: 15000)
   */
  constructor(config = {}) {
    super('figma-design', config);
    this.accessToken = config.accessToken || process.env.FIGMA_ACCESS_TOKEN || '';
    this.fileKey = config.fileKey || process.env.FIGMA_FILE_KEY || '';
    this.nodeId = config.nodeId || '';
    this.timeout = config.timeout || 15000;
    /** @type {object|null} Cached file data */
    this._fileData = null;
    /** @type {object|null} Cached design spec */
    this._cachedSpec = null;
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  async connect() {
    if (!this.accessToken) {
      console.warn('[FigmaDesignAdapter] No access token provided. Set figmaDesign.accessToken in workflow.config.js or FIGMA_ACCESS_TOKEN env var.');
      return; // Graceful degradation – adapter stays disconnected
    }
    if (!this.fileKey) {
      console.warn('[FigmaDesignAdapter] No file key provided. Set figmaDesign.fileKey in workflow.config.js or FIGMA_FILE_KEY env var.');
      return;
    }

    try {
      // Validate token + file key by fetching file metadata (lightweight call)
      const url = `${FIGMA_API_BASE}/files/${this.fileKey}?depth=1`;
      const data = await this._figmaGet(url);
      const parsed = JSON.parse(data);
      this._fileData = parsed;
      this._connected = true;
      console.log(`[FigmaDesignAdapter] ✅ Connected to Figma file: "${parsed.name}" (last modified: ${parsed.lastModified || 'unknown'}).`);
    } catch (err) {
      console.warn(`[FigmaDesignAdapter] Failed to connect: ${err.message}`);
      // Non-fatal: adapter stays disconnected, workflow continues without design data
    }
  }

  // ── Core: Extract Design Specification ──────────────────────────────────────

  /**
   * Extracts a comprehensive design specification from the Figma file.
   * Caches results to avoid redundant API calls within the same workflow run.
   *
   * @returns {Promise<DesignSpec>}
   */
  async extractDesignSpec() {
    this._assertConnected();

    if (this._cachedSpec) return this._cachedSpec;

    // Fetch full file tree (or specific node)
    const nodeParam = this.nodeId ? `?ids=${this.nodeId}` : '';
    const url = `${FIGMA_API_BASE}/files/${this.fileKey}${nodeParam}`;
    const data = await this._figmaGet(url);
    const file = JSON.parse(data);

    const document = file.document || {};
    const pages = (document.children || []);

    // Extract design tokens from all pages
    const colors = new Map();
    const fonts = new Map();
    const spacings = new Set();
    const borderRadii = new Set();
    const shadows = [];
    const components = [];
    let nodeCount = 0;

    for (const page of pages) {
      this._traverseNode(page, 0, { colors, fonts, spacings, borderRadii, shadows, components, nodeCount: { value: nodeCount } });
      nodeCount = components.length; // Track via components as proxy
    }

    // Infer responsive breakpoints from top-level frame widths
    const breakpoints = this._inferBreakpoints(pages);

    // Build spec object
    const spec = {
      fileName: file.name || 'Untitled',
      lastModified: file.lastModified || '',
      pages: pages.map(p => p.name),
      designTokens: {
        colors: this._deduplicateColors(colors),
        typography: this._formatTypography(fonts),
        spacing: [...spacings].sort((a, b) => a - b),
        borderRadius: [...borderRadii].sort((a, b) => a - b),
        shadows: shadows.slice(0, 10),
      },
      componentTree: components.slice(0, MAX_TOTAL_NODES),
      breakpoints,
    };

    this._cachedSpec = spec;
    return spec;
  }

  // ── Formatting ──────────────────────────────────────────────────────────────

  /**
   * Formats the design spec into a Markdown block suitable for LLM prompt injection.
   *
   * @param {DesignSpec} spec
   * @returns {string} Markdown-formatted design specification
   */
  formatDesignBlock(spec) {
    if (!spec) return '';

    const sections = [];

    sections.push(`## 🎨 Figma Design Specification`);
    sections.push(`> Extracted from: **${spec.fileName}** (last modified: ${spec.lastModified || 'unknown'})`);
    sections.push(`> Pages: ${spec.pages.join(', ')}`);
    sections.push(`> **Use these design tokens and component structure to generate pixel-accurate UI code.**`);
    sections.push(`> Match colors, fonts, spacing, and layout exactly. Do NOT use arbitrary values.`);

    // Colors
    if (spec.designTokens.colors.length > 0) {
      sections.push(`\n### 🎨 Color Palette`);
      sections.push('| Name | Hex | RGB | Usage |');
      sections.push('|------|-----|-----|-------|');
      for (const c of spec.designTokens.colors.slice(0, 20)) {
        sections.push(`| ${c.name} | \`${c.hex}\` | rgb(${c.r}, ${c.g}, ${c.b}) | ${c.usage || '-'} |`);
      }
    }

    // Typography
    if (spec.designTokens.typography.length > 0) {
      sections.push(`\n### 🔤 Typography`);
      sections.push('| Style | Font Family | Size | Weight | Line Height |');
      sections.push('|-------|-------------|------|--------|-------------|');
      for (const t of spec.designTokens.typography.slice(0, 15)) {
        sections.push(`| ${t.name} | ${t.fontFamily} | ${t.fontSize}px | ${t.fontWeight} | ${t.lineHeight || 'auto'} |`);
      }
    }

    // Spacing
    if (spec.designTokens.spacing.length > 0) {
      sections.push(`\n### 📏 Spacing Scale`);
      sections.push(`Values (px): ${spec.designTokens.spacing.join(', ')}`);
    }

    // Border Radius
    if (spec.designTokens.borderRadius.length > 0) {
      sections.push(`\n### 🔘 Border Radius`);
      sections.push(`Values (px): ${spec.designTokens.borderRadius.join(', ')}`);
    }

    // Shadows
    if (spec.designTokens.shadows.length > 0) {
      sections.push(`\n### 🌑 Shadows`);
      for (const s of spec.designTokens.shadows) {
        sections.push(`- \`${s.css}\` (${s.context || 'general'})`);
      }
    }

    // Breakpoints
    if (spec.breakpoints.length > 0) {
      sections.push(`\n### 📱 Responsive Breakpoints`);
      sections.push('| Name | Width | Frame |');
      sections.push('|------|-------|-------|');
      for (const bp of spec.breakpoints) {
        sections.push(`| ${bp.name} | ${bp.width}px | ${bp.frameName} |`);
      }
    }

    // Component Tree
    if (spec.componentTree.length > 0) {
      sections.push(`\n### 🧩 Component Hierarchy`);
      sections.push('```');
      for (const c of spec.componentTree) {
        const indent = '  '.repeat(c.depth);
        const dims = c.width && c.height ? ` (${Math.round(c.width)}×${Math.round(c.height)})` : '';
        const layout = c.layoutMode ? ` [${c.layoutMode}${c.itemSpacing ? ` gap:${c.itemSpacing}` : ''}]` : '';
        const padding = c.padding ? ` pad:${c.padding}` : '';
        sections.push(`${indent}${c.type}: ${c.name}${dims}${layout}${padding}`);
      }
      sections.push('```');
    }

    return sections.join('\n');
  }

  // ── MCPAdapter interface ──────────────────────────────────────────────────

  async query(queryStr, params = {}) {
    this._assertConnected();
    const spec = await this.extractDesignSpec();
    return spec;
  }

  async notify(event, payload) {
    // Design extraction is read-only; no-op for notifications
  }

  // ── Private: Figma API helpers ────────────────────────────────────────────

  /**
   * Authenticated GET request to Figma API.
   */
  async _figmaGet(url) {
    return this._httpGet(url, {
      headers: {
        'X-FIGMA-TOKEN': this.accessToken,
        'User-Agent': 'WorkFlowAgent/1.0 (FigmaDesign)',
      },
      timeout: this.timeout,
    });
  }

  // ── Private: Tree Traversal ───────────────────────────────────────────────

  /**
   * Recursively traverses a Figma node tree, extracting design tokens
   * and building the component hierarchy.
   *
   * @param {object} node - Figma node object
   * @param {number} depth - Current recursion depth
   * @param {object} acc  - Accumulator for extracted data
   */
  _traverseNode(node, depth, acc) {
    if (depth > MAX_TREE_DEPTH) return;
    if (acc.components.length >= MAX_TOTAL_NODES) return;

    // Extract fills (colors)
    if (node.fills && Array.isArray(node.fills)) {
      for (const fill of node.fills) {
        if (fill.type === 'SOLID' && fill.color) {
          const hex = this._rgbaToHex(fill.color);
          if (!acc.colors.has(hex)) {
            acc.colors.set(hex, {
              hex,
              r: Math.round((fill.color.r || 0) * 255),
              g: Math.round((fill.color.g || 0) * 255),
              b: Math.round((fill.color.b || 0) * 255),
              a: fill.color.a != null ? fill.color.a : 1,
              name: node.name || 'unnamed',
              usage: node.type === 'TEXT' ? 'text' : 'fill',
            });
          }
        }
      }
    }

    // Extract typography
    if (node.type === 'TEXT' && node.style) {
      const s = node.style;
      const key = `${s.fontFamily}-${s.fontSize}-${s.fontWeight}`;
      if (!acc.fonts.has(key)) {
        acc.fonts.set(key, {
          fontFamily: s.fontFamily || 'unknown',
          fontSize: s.fontSize || 16,
          fontWeight: s.fontWeight || 400,
          lineHeight: s.lineHeightPx ? `${Math.round(s.lineHeightPx)}px` : 'auto',
          letterSpacing: s.letterSpacing || 0,
          name: node.name || 'Text',
        });
      }
    }

    // Extract spacing from auto-layout
    if (node.layoutMode) {
      if (node.itemSpacing != null) acc.spacings.add(Math.round(node.itemSpacing));
      if (node.paddingTop != null) acc.spacings.add(Math.round(node.paddingTop));
      if (node.paddingRight != null) acc.spacings.add(Math.round(node.paddingRight));
      if (node.paddingBottom != null) acc.spacings.add(Math.round(node.paddingBottom));
      if (node.paddingLeft != null) acc.spacings.add(Math.round(node.paddingLeft));
    }

    // Extract border radius
    if (node.cornerRadius != null && node.cornerRadius > 0) {
      acc.borderRadii.add(Math.round(node.cornerRadius));
    }
    if (node.rectangleCornerRadii) {
      for (const r of node.rectangleCornerRadii) {
        if (r > 0) acc.borderRadii.add(Math.round(r));
      }
    }

    // Extract shadows
    if (node.effects && Array.isArray(node.effects)) {
      for (const effect of node.effects) {
        if ((effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') && effect.visible !== false) {
          const c = effect.color || {};
          const rgba = `rgba(${Math.round((c.r || 0) * 255)}, ${Math.round((c.g || 0) * 255)}, ${Math.round((c.b || 0) * 255)}, ${(c.a || 0).toFixed(2)})`;
          const css = `${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${effect.offset?.x || 0}px ${effect.offset?.y || 0}px ${effect.radius || 0}px ${effect.spread || 0}px ${rgba}`;
          acc.shadows.push({ css, context: node.name });
        }
      }
    }

    // Build component tree entry
    const isStructural = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION'].includes(node.type);
    if (isStructural && depth > 0) { // Skip document/page level
      const entry = {
        type: node.type,
        name: node.name || 'unnamed',
        depth: Math.max(0, depth - 1), // Normalize depth (page = 0)
        width: node.absoluteBoundingBox?.width || null,
        height: node.absoluteBoundingBox?.height || null,
      };
      if (node.layoutMode) {
        entry.layoutMode = node.layoutMode; // 'HORIZONTAL' | 'VERTICAL'
        if (node.itemSpacing) entry.itemSpacing = Math.round(node.itemSpacing);
      }
      // Compact padding representation
      const pads = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
        .filter(p => p != null)
        .map(p => Math.round(p));
      if (pads.length > 0 && pads.some(p => p > 0)) {
        entry.padding = pads.join('/');
      }
      acc.components.push(entry);
    }

    // Recurse into children
    if (node.children && Array.isArray(node.children)) {
      const limit = Math.min(node.children.length, MAX_CHILDREN_PER_NODE);
      for (let i = 0; i < limit; i++) {
        this._traverseNode(node.children[i], depth + 1, acc);
      }
    }
  }

  // ── Private: Breakpoint Inference ─────────────────────────────────────────

  /**
   * Infers responsive breakpoints from top-level Frame widths.
   * Common pattern: designers create separate frames for Desktop (1440px),
   * Tablet (768px), and Mobile (375px).
   */
  _inferBreakpoints(pages) {
    const breakpoints = [];
    const KNOWN_WIDTHS = {
      320: 'Mobile S', 360: 'Mobile M', 375: 'Mobile', 390: 'Mobile',
      414: 'Mobile L', 428: 'Mobile L',
      768: 'Tablet', 834: 'Tablet',
      1024: 'Tablet L', 1280: 'Desktop S',
      1366: 'Desktop', 1440: 'Desktop', 1536: 'Desktop L',
      1920: 'Desktop XL',
    };

    for (const page of pages) {
      if (!page.children) continue;
      for (const frame of page.children) {
        if (frame.type !== 'FRAME') continue;
        const w = Math.round(frame.absoluteBoundingBox?.width || 0);
        if (w < 200 || w > 3000) continue;

        // Find closest known width (within 20px tolerance)
        let label = null;
        for (const [known, name] of Object.entries(KNOWN_WIDTHS)) {
          if (Math.abs(w - Number(known)) <= 20) {
            label = name;
            break;
          }
        }
        breakpoints.push({
          name: label || `${w}px`,
          width: w,
          frameName: frame.name,
        });
      }
    }

    // Sort by width ascending and deduplicate
    breakpoints.sort((a, b) => a.width - b.width);
    const seen = new Set();
    return breakpoints.filter(bp => {
      if (seen.has(bp.width)) return false;
      seen.add(bp.width);
      return true;
    });
  }

  // ── Private: Color Helpers ────────────────────────────────────────────────

  /**
   * Converts Figma RGBA (0-1 range) to hex string.
   */
  _rgbaToHex(color) {
    const r = Math.round((color.r || 0) * 255);
    const g = Math.round((color.g || 0) * 255);
    const b = Math.round((color.b || 0) * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  }

  /**
   * Deduplicates colors and converts Map to array.
   */
  _deduplicateColors(colorMap) {
    return [...colorMap.values()];
  }

  /**
   * Formats typography Map to sorted array.
   */
  _formatTypography(fontMap) {
    return [...fontMap.values()].sort((a, b) => b.fontSize - a.fontSize);
  }
}

// Attach shared HTTP helpers
Object.assign(FigmaDesignAdapter.prototype, HttpMixin);

module.exports = { FigmaDesignAdapter };
