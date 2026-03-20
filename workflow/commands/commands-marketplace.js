/**
 * Skill Marketplace Commands (ADR-35) – Export, import, and manage portable skill packages.
 *
 * Commands:
 *   /skill-export  – Export skill(s) to portable packages
 *   /skill-import  – Import a skill from a portable package
 *   /skill-list    – List all skills with metadata (marketplace version)
 *   /help          – List all available commands
 */

'use strict';

const path = require('path');
const { PATHS } = require('../core/constants');

/**
 * Registers marketplace commands into the shared command registry.
 *
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 * @param {object} COMMANDS - The shared COMMANDS registry object (needed by /help)
 */
function registerMarketplaceCommands(registerCommand, COMMANDS) {

// ─── P2c: Skill Marketplace Commands (ADR-35) ──────────────────────────────

registerCommand(
  'skill-export',
  'Export skill(s) to portable packages. Usage: /skill-export <name> [--all] [--include-deps]',
  async (args, context) => {
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);
    const exportAll = parts.includes('--all');
    const includeDeps = parts.includes('--include-deps');
    const skillName = parts.find(p => !p.startsWith('--'));

    if (!exportAll && !skillName) {
      return '❌ Usage: `/skill-export <name>` or `/skill-export --all`';
    }

    const { SkillMarketplace } = require('../core/skill-marketplace');
    const orch = context.orchestrator;
    const marketplace = new SkillMarketplace({
      skillsDir: path.join(orch?.projectRoot || process.cwd(), 'workflow', 'skills'),
      outputDir: orch?._outputDir || PATHS.OUTPUT_DIR,
      skillEvolution: orch?.skillEvolution,
      verbose: true,
    });

    if (exportAll) {
      const result = marketplace.exportAll();
      return `## 📦 Skill Export (All Exportable)\n\n` +
        `Exported **${result.exported}** skill(s):\n` +
        result.packages.map(p => `- \`${path.basename(p)}\``).join('\n') +
        `\n\n> 💡 Mark skills as exportable by adding \`exportable: true\` to their YAML frontmatter.`;
    }

    try {
      const { packagePath, package: pkg } = marketplace.exportSkill(skillName, { includeDependencies: includeDeps });
      return `## 📦 Skill Exported: ${skillName}\n\n` +
        `| Field | Value |\n|-------|-------|\n` +
        `| Package | \`${path.basename(packagePath)}\` |\n` +
        `| Version | ${pkg.skill.version} |\n` +
        `| Domains | ${(pkg.skill.domains || []).join(', ')} |\n` +
        `| Dependencies | ${pkg.dependencies.length} included |\n` +
        `| Size | ${JSON.stringify(pkg).length} bytes |\n\n` +
        `Path: \`${packagePath}\``;
    } catch (err) {
      return `❌ Export failed: ${err.message}`;
    }
  }
);

registerCommand(
  'skill-import',
  'Import a skill from a portable package. Usage: /skill-import <path> [--overwrite] [--merge]',
  async (args, context) => {
    const parts = (args || '').trim().split(/\s+/).filter(Boolean);
    const overwrite = parts.includes('--overwrite');
    const merge = parts.includes('--merge');
    const sourcePath = parts.find(p => !p.startsWith('--'));

    if (!sourcePath) {
      return '❌ Usage: `/skill-import <path-to-skill-package.json>` [--overwrite] [--merge]';
    }

    const { SkillMarketplace } = require('../core/skill-marketplace');
    const orch = context.orchestrator;
    const marketplace = new SkillMarketplace({
      skillsDir: path.join(orch?.projectRoot || process.cwd(), 'workflow', 'skills'),
      outputDir: orch?._outputDir || PATHS.OUTPUT_DIR,
      skillEvolution: orch?.skillEvolution,
      verbose: true,
    });

    // Compatibility check first
    const compat = marketplace.checkCompatibility(sourcePath);
    if (!compat.compatible) {
      return `## ⚠️ Compatibility Issues\n\n${compat.issues.map(i => `- ${i}`).join('\n')}\n\n> Use \`--overwrite\` to force import despite compatibility issues.`;
    }

    const conflictStrategy = overwrite ? 'overwrite' : merge ? 'merge' : 'skip';

    try {
      const result = marketplace.importSkill(sourcePath, { conflictStrategy });

      if (!result.imported) {
        return `⚠️ Skill "${result.skillName}" not imported: ${result.conflicts.join(', ')}\n\n> Use \`--overwrite\` or \`--merge\` to handle conflicts.`;
      }

      return `## 📥 Skill Imported: ${result.skillName}\n\n` +
        `| Field | Value |\n|-------|-------|\n` +
        `| Status | ✅ Imported |\n` +
        `| Dependencies | ${result.dependenciesImported} imported |\n` +
        (result.conflicts.length > 0 ? `| Notes | ${result.conflicts.join('; ')} |\n` : '') +
        `\nThe skill is now available in \`skills/${result.skillName}.md\``;
    } catch (err) {
      return `❌ Import failed: ${err.message}`;
    }
  }
);

registerCommand(
  'skill-list',
  'List all skills with metadata. Usage: /skill-list [--exportable]',
  async (args, context) => {
    const exportableOnly = (args || '').includes('--exportable');

    const { SkillMarketplace } = require('../core/skill-marketplace');
    const orch = context.orchestrator;
    const marketplace = new SkillMarketplace({
      skillsDir: path.join(orch?.projectRoot || process.cwd(), 'workflow', 'skills'),
      outputDir: orch?._outputDir || PATHS.OUTPUT_DIR,
      verbose: false,
    });

    const skills = marketplace.listSkills({ exportableOnly });

    if (skills.length === 0) {
      return exportableOnly
        ? '📋 No exportable skills found. Add `exportable: true` to skill frontmatter to enable export.'
        : '📋 No skills found.';
    }

    const lines = [
      `## 📋 Skill Registry${exportableOnly ? ' (Exportable Only)' : ''}`,
      ``,
      `| Skill | Version | Type | Domains | Words | Sections | Exportable |`,
      `|-------|---------|------|---------|-------|----------|------------|`,
    ];

    for (const s of skills) {
      lines.push(`| ${s.name} | ${s.version} | ${s.type} | ${s.domains.join(', ')} | ${s.wordCount} | ${s.sectionCount} | ${s.exportable ? '✅' : '❌'} |`);
    }

    lines.push(``);
    lines.push(`**Total**: ${skills.length} skill(s)`);
    if (!exportableOnly) {
      const exportableCount = skills.filter(s => s.exportable).length;
      lines.push(`**Exportable**: ${exportableCount} skill(s)`);
    }

    return lines.join('\n');
  }
);

registerCommand(
  'help',
  'List all available commands with descriptions',
  async () => {
    const lines = [`## Available Commands\n`];
    for (const [name, cmd] of Object.entries(COMMANDS)) {
      lines.push(`- **/${name}** – ${cmd.description}`);
    }
    return lines.join('\n');
  }
);

}

module.exports = { registerMarketplaceCommands };