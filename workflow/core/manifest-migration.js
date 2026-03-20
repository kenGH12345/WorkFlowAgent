/**
 * Manifest Version Migration (P1-5, Ghemawat)
 *
 * Provides forward-only schema migration for manifest.json.
 * When the manifest schema evolves (new fields, renamed fields, etc.),
 * this module applies incremental migrations to bring old manifests up to date.
 *
 * Design:
 *   - Each migration is a pure function: (manifest) => manifest
 *   - Migrations are ordered by version and applied sequentially
 *   - The current version is stored in manifest.version
 *   - Migrations are idempotent — running them twice is safe
 *   - Original manifest is backed up before migration
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Current manifest schema version
const CURRENT_VERSION = '1.1.0';

// ─── Migration Registry ─────────────────────────────────────────────────────

/**
 * Each migration transforms the manifest from one version to the next.
 * Order matters: they are applied sequentially.
 */
const MIGRATIONS = [
  {
    from: '1.0.0',
    to: '1.1.0',
    description: 'Add risks array, lastRollback field, and version field',
    migrate(manifest) {
      // Ensure risks array exists
      if (!Array.isArray(manifest.risks)) {
        manifest.risks = [];
      }
      // Add lastRollback tracking
      if (!manifest.lastRollback) {
        manifest.lastRollback = null;
      }
      // Add version field
      manifest.version = '1.1.0';
      return manifest;
    },
  },
  // Future migrations go here:
  // {
  //   from: '1.1.0',
  //   to: '1.2.0',
  //   description: '...',
  //   migrate(manifest) { ... return manifest; },
  // },
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Migrates a manifest object to the current schema version.
 *
 * @param {object} manifest - The parsed manifest object
 * @param {object} [opts]
 * @param {string} [opts.manifestPath] - Path to manifest file (for backup)
 * @param {boolean} [opts.backup=true] - Whether to backup before migration
 * @returns {{ manifest: object, migrated: boolean, fromVersion: string, toVersion: string, appliedMigrations: string[] }}
 */
function migrateManifest(manifest, opts = {}) {
  const backup = opts.backup !== false;
  const manifestPath = opts.manifestPath || null;

  const originalVersion = manifest.version || '1.0.0';
  let currentVer = originalVersion;
  const appliedMigrations = [];

  // Nothing to do if already current
  if (currentVer === CURRENT_VERSION) {
    return {
      manifest,
      migrated: false,
      fromVersion: originalVersion,
      toVersion: CURRENT_VERSION,
      appliedMigrations: [],
    };
  }

  // Backup original manifest before applying migrations
  if (backup && manifestPath && fs.existsSync(manifestPath)) {
    const backupPath = manifestPath + `.backup-v${currentVer}`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(manifestPath, backupPath);
      console.log(`[ManifestMigration] Backup created: ${backupPath}`);
    }
  }

  // Apply migrations sequentially
  for (const migration of MIGRATIONS) {
    if (migration.from === currentVer) {
      console.log(`[ManifestMigration] Applying: ${migration.from} → ${migration.to} (${migration.description})`);
      manifest = migration.migrate(manifest);
      currentVer = migration.to;
      appliedMigrations.push(`${migration.from} → ${migration.to}`);
    }
  }

  // Safety check: if we couldn't reach current version, something is wrong
  if (currentVer !== CURRENT_VERSION) {
    console.warn(`[ManifestMigration] ⚠️ Migration chain incomplete: reached v${currentVer}, expected v${CURRENT_VERSION}`);
  }

  manifest.version = currentVer;

  return {
    manifest,
    migrated: appliedMigrations.length > 0,
    fromVersion: originalVersion,
    toVersion: currentVer,
    appliedMigrations,
  };
}

/**
 * Returns the current manifest schema version.
 */
function getCurrentVersion() {
  return CURRENT_VERSION;
}

/**
 * Lists all available migrations for diagnostic purposes.
 */
function listMigrations() {
  return MIGRATIONS.map(m => ({
    from: m.from,
    to: m.to,
    description: m.description,
  }));
}

module.exports = { migrateManifest, getCurrentVersion, listMigrations, CURRENT_VERSION };
