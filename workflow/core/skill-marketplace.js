/**
 * Skill Marketplace — Cross-Project Skill Export/Import (ADR-35, P2c)
 *
 * Extends the existing ExperienceTransfer concept to SKILLS.
 * While experience-transfer.js handles Experience records (structured data),
 * Skill Marketplace handles Skill FILES (markdown with frontmatter).
 *
 * Capabilities:
 *   1. Export: Package a skill as a portable archive (JSON + markdown)
 *   2. Import: Fetch a skill from file/URL and merge into local skills/
 *   3. List:   Browse exportable skills with metadata
 *   4. Compatibility check: Verify dependency resolution before import
 *
 * Frontmatter extension: adds `exportable: true` flag to mark
 * skills that are safe for cross-project sharing.
 *
 * Commands:
 *   /skill-export <name> [--all]     — Export skill(s) to output/skill-exports/
 *   /skill-import <path-or-url>      — Import skill from package
 *   /skill-list   [--exportable]     — List skills with export status
 *
 * Design: File-based packaging. No network required (URL support is future).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Export Package Format ──────────────────────────────────────────────────

const PACKAGE_VERSION = 1;

// ─── SkillMarketplace Class ─────────────────────────────────────────────────

class SkillMarketplace {
  /**
   * @param {object} opts
   * @param {string} opts.skillsDir  — Path to skills directory
   * @param {string} opts.outputDir  — Path to output directory
   * @param {object} [opts.skillEvolution] — SkillEvolution instance (for registry)
   * @param {boolean} [opts.verbose]
   */
  constructor(opts = {}) {
    this._skillsDir = opts.skillsDir || path.join(process.cwd(), 'workflow', 'skills');
    this._outputDir = opts.outputDir || path.join(process.cwd(), 'workflow', 'output');
    this._exportDir = path.join(this._outputDir, 'skill-exports');
    this._skillEvolution = opts.skillEvolution || null;
    this._verbose = opts.verbose ?? false;
  }

  // ─── List Skills ──────────────────────────────────────────────────────

  /**
   * Lists all skills with their export status and metadata.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.exportableOnly=false]
   * @returns {object[]} Array of skill info objects
   */
  listSkills(opts = {}) {
    const { exportableOnly = false } = opts;
    const skills = [];

    if (!fs.existsSync(this._skillsDir)) return skills;

    const files = fs.readdirSync(this._skillsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const skillName = file.replace('.md', '');
      const fullPath = path.join(this._skillsDir, file);

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const meta = this._parseFrontmatter(content);
        const stat = fs.statSync(fullPath);

        const info = {
          name: skillName,
          version: meta.version || '0.0.0',
          type: meta.type || 'unknown',
          domains: meta.domains || [],
          dependencies: meta.dependencies || [],
          exportable: meta.exportable === true || meta.exportable === 'true',
          loadLevel: meta.load_level || meta.loadLevel || 'task',
          description: meta.description || '',
          size: stat.size,
          lastModified: stat.mtime.toISOString(),
          wordCount: this._countWords(content),
          sectionCount: (content.match(/^## /gm) || []).length,
        };

        if (exportableOnly && !info.exportable) continue;
        skills.push(info);
      } catch (_) { /* skip unreadable files */ }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ─── Export Skill ─────────────────────────────────────────────────────

  /**
   * Exports a skill as a portable package.
   * The package includes the skill markdown + metadata + dependency list.
   *
   * @param {string} skillName
   * @param {object} [opts]
   * @param {boolean} [opts.includeDependencies=true] — Also export dependency skills
   * @returns {{ packagePath: string, package: object }}
   */
  exportSkill(skillName, opts = {}) {
    const { includeDependencies = true } = opts;

    const skillPath = path.join(this._skillsDir, `${skillName}.md`);
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill "${skillName}" not found at ${skillPath}`);
    }

    const content = fs.readFileSync(skillPath, 'utf-8');
    const meta = this._parseFrontmatter(content);

    // Build the package
    const pkg = {
      version: PACKAGE_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: 'WorkFlowAgent/SkillMarketplace',
      skill: {
        name: skillName,
        version: meta.version || '0.0.0',
        type: meta.type || 'domain-skill',
        domains: meta.domains || [],
        dependencies: meta.dependencies || [],
        description: meta.description || '',
        content,
      },
      dependencies: [],
    };

    // Optionally include dependency skill content
    if (includeDependencies && meta.dependencies && meta.dependencies.length > 0) {
      for (const depName of meta.dependencies) {
        const depPath = path.join(this._skillsDir, `${depName}.md`);
        if (fs.existsSync(depPath)) {
          const depContent = fs.readFileSync(depPath, 'utf-8');
          const depMeta = this._parseFrontmatter(depContent);
          pkg.dependencies.push({
            name: depName,
            version: depMeta.version || '0.0.0',
            content: depContent,
          });
        }
      }
    }

    // Write package to disk
    if (!fs.existsSync(this._exportDir)) {
      fs.mkdirSync(this._exportDir, { recursive: true });
    }

    const packageFileName = `${skillName}-v${meta.version || '0.0.0'}.skill.json`;
    const packagePath = path.join(this._exportDir, packageFileName);
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2), 'utf-8');

    if (this._verbose) {
      console.log(`[SkillMarketplace] 📦 Exported: ${skillName} → ${packageFileName} (${pkg.dependencies.length} dep(s))`);
    }

    return { packagePath, package: pkg };
  }

  /**
   * Exports ALL exportable skills (those with `exportable: true` in frontmatter).
   *
   * @returns {{ exported: number, packages: string[] }}
   */
  exportAll() {
    const exportable = this.listSkills({ exportableOnly: true });
    const packages = [];

    for (const skill of exportable) {
      try {
        const { packagePath } = this.exportSkill(skill.name);
        packages.push(packagePath);
      } catch (err) {
        console.warn(`[SkillMarketplace] ⚠️ Failed to export "${skill.name}": ${err.message}`);
      }
    }

    return { exported: packages.length, packages };
  }

  // ─── Import Skill ─────────────────────────────────────────────────────

  /**
   * Imports a skill from a package file.
   *
   * @param {string} sourcePath — Path to the .skill.json package file
   * @param {object} [opts]
   * @param {string} [opts.conflictStrategy='skip'] — 'skip' | 'overwrite' | 'merge'
   * @param {boolean} [opts.importDependencies=true]
   * @returns {{ imported: boolean, skillName: string, conflicts: string[], dependenciesImported: number }}
   */
  importSkill(sourcePath, opts = {}) {
    const { conflictStrategy = 'skip', importDependencies = true } = opts;

    // Load and validate package
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Package file not found: ${sourcePath}`);
    }

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
    } catch (err) {
      throw new Error(`Invalid package format: ${err.message}`);
    }

    if (!pkg.skill || !pkg.skill.name || !pkg.skill.content) {
      throw new Error('Package missing required fields: skill.name, skill.content');
    }

    const conflicts = [];
    let dependenciesImported = 0;

    // Check for local conflicts
    const targetPath = path.join(this._skillsDir, `${pkg.skill.name}.md`);
    const exists = fs.existsSync(targetPath);

    if (exists) {
      if (conflictStrategy === 'skip') {
        conflicts.push(`Skill "${pkg.skill.name}" already exists — skipped`);
        return { imported: false, skillName: pkg.skill.name, conflicts, dependenciesImported: 0 };
      }

      if (conflictStrategy === 'merge') {
        // Merge: append new sections that don't exist locally
        const localContent = fs.readFileSync(targetPath, 'utf-8');
        const mergedContent = this._mergeSkillContent(localContent, pkg.skill.content);
        fs.writeFileSync(targetPath, mergedContent, 'utf-8');
        conflicts.push(`Skill "${pkg.skill.name}" merged with existing content`);
      } else {
        // Overwrite
        fs.writeFileSync(targetPath, pkg.skill.content, 'utf-8');
        conflicts.push(`Skill "${pkg.skill.name}" overwritten`);
      }
    } else {
      // New skill — write directly
      if (!fs.existsSync(this._skillsDir)) {
        fs.mkdirSync(this._skillsDir, { recursive: true });
      }
      fs.writeFileSync(targetPath, pkg.skill.content, 'utf-8');
    }

    // Import dependencies
    if (importDependencies && pkg.dependencies && pkg.dependencies.length > 0) {
      for (const dep of pkg.dependencies) {
        const depPath = path.join(this._skillsDir, `${dep.name}.md`);
        if (!fs.existsSync(depPath)) {
          fs.writeFileSync(depPath, dep.content, 'utf-8');
          dependenciesImported++;
        }
      }
    }

    // Update skill registry if available
    if (this._skillEvolution && typeof this._skillEvolution.registerSkill === 'function') {
      try {
        this._skillEvolution.registerSkill(pkg.skill.name, {
          name: pkg.skill.name,
          version: pkg.skill.version,
          type: pkg.skill.type,
          domains: pkg.skill.domains,
          dependencies: pkg.skill.dependencies,
          description: pkg.skill.description,
          _importedFrom: sourcePath,
          _importedAt: new Date().toISOString(),
        });
      } catch (_) { /* non-fatal: registry update optional */ }
    }

    if (this._verbose) {
      console.log(`[SkillMarketplace] 📥 Imported: ${pkg.skill.name} v${pkg.skill.version} (${dependenciesImported} dep(s))`);
    }

    return {
      imported: true,
      skillName: pkg.skill.name,
      conflicts,
      dependenciesImported,
    };
  }

  // ─── Compatibility Check ──────────────────────────────────────────────

  /**
   * Checks if a skill package is compatible with the local environment.
   * Verifies dependency resolution and potential conflicts.
   *
   * @param {string} sourcePath — Path to the .skill.json package
   * @returns {{ compatible: boolean, issues: string[] }}
   */
  checkCompatibility(sourcePath) {
    const issues = [];

    try {
      const pkg = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));

      // Check package version
      if (pkg.version > PACKAGE_VERSION) {
        issues.push(`Package format version ${pkg.version} is newer than supported ${PACKAGE_VERSION}`);
      }

      // Check dependencies
      for (const depName of (pkg.skill.dependencies || [])) {
        const localPath = path.join(this._skillsDir, `${depName}.md`);
        const inPackage = (pkg.dependencies || []).some(d => d.name === depName);

        if (!fs.existsSync(localPath) && !inPackage) {
          issues.push(`Missing dependency: "${depName}" (not local, not in package)`);
        }
      }

      // Check for name conflicts
      const targetPath = path.join(this._skillsDir, `${pkg.skill.name}.md`);
      if (fs.existsSync(targetPath)) {
        const localMeta = this._parseFrontmatter(fs.readFileSync(targetPath, 'utf-8'));
        if (localMeta.version && pkg.skill.version) {
          const localVer = localMeta.version.split('.').map(Number);
          const pkgVer = pkg.skill.version.split('.').map(Number);
          if (localVer[0] > pkgVer[0]) {
            issues.push(`Local version (${localMeta.version}) is newer than package (${pkg.skill.version})`);
          }
        }
      }
    } catch (err) {
      issues.push(`Cannot read package: ${err.message}`);
    }

    return { compatible: issues.length === 0, issues };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /**
   * Parses YAML frontmatter from skill content.
   * @param {string} content
   * @returns {object}
   */
  _parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const meta = {};
    const lines = match[1].split('\n');

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      // Parse arrays
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      }
      // Parse booleans
      else if (value === 'true') value = true;
      else if (value === 'false') value = false;
      // Parse numbers
      else if (/^\d+$/.test(value)) value = Number(value);
      // Strip quotes
      else if ((value.startsWith('"') && value.endsWith('"')) ||
               (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      meta[key] = value;
    }

    return meta;
  }

  /**
   * Merges two skill contents by combining their sections.
   * Sections in newContent that don't exist in localContent are appended.
   *
   * @param {string} localContent
   * @param {string} newContent
   * @returns {string}
   */
  _mergeSkillContent(localContent, newContent) {
    // Extract sections from both
    const localSections = this._extractSections(localContent);
    const newSections = this._extractSections(newContent);

    // Find sections in new that don't exist locally
    const localTitles = new Set(localSections.map(s => s.title.toLowerCase()));
    const toAppend = newSections.filter(s => !localTitles.has(s.title.toLowerCase()));

    if (toAppend.length === 0) return localContent;

    // Append new sections
    let merged = localContent.trimEnd();
    for (const section of toAppend) {
      merged += '\n\n' + section.raw;
    }

    return merged + '\n';
  }

  /**
   * Extracts ## sections from markdown content.
   * @param {string} content
   * @returns {object[]} Array of { title, raw }
   */
  _extractSections(content) {
    const sections = [];
    const lines = content.split('\n');
    let currentTitle = null;
    let currentLines = [];

    for (const line of lines) {
      if (line.startsWith('## ')) {
        if (currentTitle) {
          sections.push({ title: currentTitle, raw: currentLines.join('\n').trim() });
        }
        currentTitle = line.replace('## ', '').trim();
        currentLines = [line];
      } else if (currentTitle) {
        currentLines.push(line);
      }
    }

    if (currentTitle) {
      sections.push({ title: currentTitle, raw: currentLines.join('\n').trim() });
    }

    return sections;
  }

  _countWords(content) {
    return content
      .split('\n')
      .filter(l => {
        const t = l.trim();
        return t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('|')
          && !t.startsWith('---') && !t.startsWith('_No ');
      })
      .join(' ')
      .split(/\s+/)
      .filter(w => w.length > 0)
      .length;
  }
}

module.exports = { SkillMarketplace, PACKAGE_VERSION };
