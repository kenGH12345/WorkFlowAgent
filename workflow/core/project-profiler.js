/**
 * ProjectProfiler – Deep Project Architecture Inference Engine
 *
 * Analyses project structure through static file detection, config file parsing,
 * and directory/naming pattern recognition to produce a structured Project Profile.
 *
 * Phase 1 (baseline): file system detection + config file content matching
 * Phase 2 (LSP-enhanced): compiler-accurate symbols, decorators, diagnostics
 *   via LSPProfileEnhancer integration (optional, graceful fallback).
 *
 * The output is consumed by:
 *   1. workflow.config.js → projectProfile field
 *   2. AGENTS.md → Architecture Profile section
 *   3. output/project-profile.md → ContextLoader injection
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Framework Detection Rules ────────────────────────────────────────────────
// Each rule: { name, category, evidence: (root, deps) => boolean }
// deps = merged dependencies + devDependencies from package.json (or equivalent)

const FRAMEWORK_RULES = [
  // ── JavaScript / TypeScript Backend ──────────────────────────────────────
  { name: 'NestJS',       category: 'backend',  lang: 'typescript', detect: (_r, d) => !!d['@nestjs/core'] },
  { name: 'Express',      category: 'backend',  lang: 'javascript', detect: (_r, d) => !!d['express'] && !d['@nestjs/core'] },
  { name: 'Fastify',      category: 'backend',  lang: 'javascript', detect: (_r, d) => !!d['fastify'] },
  { name: 'Koa',          category: 'backend',  lang: 'javascript', detect: (_r, d) => !!d['koa'] },
  { name: 'Hono',         category: 'backend',  lang: 'javascript', detect: (_r, d) => !!d['hono'] },
  { name: 'Elysia',       category: 'backend',  lang: 'typescript', detect: (_r, d) => !!d['elysia'] },

  // ── JavaScript / TypeScript Frontend ─────────────────────────────────────
  { name: 'Next.js',      category: 'frontend', lang: 'typescript', detect: (_r, d) => !!d['next'] },
  { name: 'Nuxt',         category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['nuxt'] || !!d['nuxt3'] },
  { name: 'React',        category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['react'] && !d['next'] && !d['react-native'] },
  { name: 'Vue',          category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['vue'] && !d['nuxt'] && !d['nuxt3'] },
  { name: 'Svelte',       category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['svelte'] },
  { name: 'Angular',      category: 'frontend', lang: 'typescript', detect: (_r, d) => !!d['@angular/core'] },
  { name: 'SolidJS',      category: 'frontend', lang: 'javascript', detect: (_r, d) => !!d['solid-js'] },

  // ── Mobile ──────────────────────────────────────────────────────────────
  { name: 'React Native', category: 'mobile',   lang: 'javascript', detect: (_r, d) => !!d['react-native'] },
  { name: 'Expo',         category: 'mobile',   lang: 'javascript', detect: (_r, d) => !!d['expo'] },
  { name: 'Flutter',      category: 'mobile',   lang: 'dart',       detect: (r) => _fileExists(r, 'pubspec.yaml') },
  { name: 'SwiftUI',      category: 'mobile',   lang: 'swift',      detect: (r) => _fileExists(r, 'Package.swift') || _hasExt(r, '.xcodeproj') },

  // ── Python Backend ──────────────────────────────────────────────────────
  { name: 'Django',       category: 'backend',  lang: 'python',     detect: (r, d) => !!d['django'] || !!d['Django'] || _fileExists(r, 'manage.py') },
  { name: 'FastAPI',      category: 'backend',  lang: 'python',     detect: (_r, d) => !!d['fastapi'] },
  { name: 'Flask',        category: 'backend',  lang: 'python',     detect: (_r, d) => !!d['flask'] || !!d['Flask'] },

  // ── Go Backend ──────────────────────────────────────────────────────────
  { name: 'Gin',          category: 'backend',  lang: 'go',         detect: (r) => _goModContains(r, 'github.com/gin-gonic/gin') },
  { name: 'Echo',         category: 'backend',  lang: 'go',         detect: (r) => _goModContains(r, 'github.com/labstack/echo') },
  { name: 'Fiber',        category: 'backend',  lang: 'go',         detect: (r) => _goModContains(r, 'github.com/gofiber/fiber') },

  // ── Java Backend ────────────────────────────────────────────────────────
  { name: 'Spring Boot',  category: 'backend',  lang: 'java',       detect: (r) => _pomContains(r, 'spring-boot') || _gradleContains(r, 'spring-boot') },
  { name: 'Quarkus',      category: 'backend',  lang: 'java',       detect: (r) => _pomContains(r, 'quarkus') || _gradleContains(r, 'quarkus') },

  // ── Rust Backend ────────────────────────────────────────────────────────
  { name: 'Actix',        category: 'backend',  lang: 'rust',       detect: (r) => _cargoContains(r, 'actix-web') },
  { name: 'Axum',         category: 'backend',  lang: 'rust',       detect: (r) => _cargoContains(r, 'axum') },
  { name: 'Rocket',       category: 'backend',  lang: 'rust',       detect: (r) => _cargoContains(r, 'rocket') },

  // ── .NET Backend ────────────────────────────────────────────────────────
  { name: 'ASP.NET Core', category: 'backend',  lang: 'csharp',     detect: (r) => _csprojContains(r, 'Microsoft.AspNetCore') },
  { name: 'Blazor',       category: 'frontend', lang: 'csharp',     detect: (r) => _csprojContains(r, 'Microsoft.AspNetCore.Components') },

  // ── Game Engines ────────────────────────────────────────────────────────
  { name: 'Unity',        category: 'game',     lang: 'csharp',     detect: (r) => _fileExists(r, 'Assets') && _fileExists(r, 'ProjectSettings') },
  { name: 'Unreal',       category: 'game',     lang: 'cpp',        detect: (r) => _hasExt(r, '.uproject') },
  { name: 'Godot',        category: 'game',     lang: 'gdscript',   detect: (r) => _fileExists(r, 'project.godot') },

  // ── Desktop ─────────────────────────────────────────────────────────────
  { name: 'Electron',     category: 'desktop',  lang: 'javascript', detect: (_r, d) => !!d['electron'] },
  { name: 'Tauri',        category: 'desktop',  lang: 'rust',       detect: (r) => _fileExists(r, 'src-tauri') },

  // ── Kotlin ──────────────────────────────────────────────────────────────
  { name: 'Ktor',         category: 'backend',  lang: 'kotlin',     detect: (r) => _gradleContains(r, 'io.ktor') },
  { name: 'Compose Multiplatform', category: 'frontend', lang: 'kotlin', detect: (r) => _gradleContains(r, 'compose') && _gradleContains(r, 'kotlin') },
  { name: 'Spring Boot (Kotlin)', category: 'backend', lang: 'kotlin', detect: (r) => _gradleContains(r, 'spring-boot') && (_hasExt(r, '.kt') || _gradleContains(r, 'kotlin')) },

  // ── PHP ──────────────────────────────────────────────────────────────────
  { name: 'Laravel',      category: 'backend',  lang: 'php',        detect: (r) => _composerContains(r, 'laravel/framework') },
  { name: 'Symfony',      category: 'backend',  lang: 'php',        detect: (r) => _composerContains(r, 'symfony/framework-bundle') },
  { name: 'WordPress',    category: 'backend',  lang: 'php',        detect: (r) => _fileExists(r, 'wp-config.php') || _fileExists(r, 'wp-content') },
  { name: 'CodeIgniter',  category: 'backend',  lang: 'php',        detect: (r) => _composerContains(r, 'codeigniter4/framework') },

  // ── Ruby ─────────────────────────────────────────────────────────────────
  { name: 'Rails',        category: 'backend',  lang: 'ruby',       detect: (r) => _gemfileContains(r, 'rails') || _fileExists(r, 'config/routes.rb') },
  { name: 'Sinatra',      category: 'backend',  lang: 'ruby',       detect: (r) => _gemfileContains(r, 'sinatra') },
  { name: 'Hanami',       category: 'backend',  lang: 'ruby',       detect: (r) => _gemfileContains(r, 'hanami') },

  // ── Swift (expanded) ────────────────────────────────────────────────────
  { name: 'Vapor',        category: 'backend',  lang: 'swift',      detect: (r) => _readFileContent(r, 'Package.swift').includes('vapor') },

  // ── C / C++ ─────────────────────────────────────────────────────────────
  { name: 'Qt',           category: 'desktop',  lang: 'cpp',        detect: (r) => _fileExists(r, 'CMakeLists.txt') && _readFileContent(r, 'CMakeLists.txt').includes('Qt') },
  { name: 'CMake Project',category: 'systems',  lang: 'cpp',        detect: (r) => _fileExists(r, 'CMakeLists.txt') && !_hasExt(r, '.uproject') },

  // ── Scala ───────────────────────────────────────────────────────────────
  { name: 'Play Framework', category: 'backend', lang: 'scala',     detect: (r) => _sbtContains(r, 'play') || _sbtContains(r, 'playframework') },
  { name: 'Akka',         category: 'backend',  lang: 'scala',      detect: (r) => _sbtContains(r, 'akka') },
  { name: 'Spark',        category: 'data',     lang: 'scala',      detect: (r) => _sbtContains(r, 'spark') },

  // ── Elixir ──────────────────────────────────────────────────────────────
  { name: 'Phoenix',      category: 'backend',  lang: 'elixir',     detect: (r) => _mixExsContains(r, 'phoenix') },
  { name: 'LiveView',     category: 'frontend', lang: 'elixir',     detect: (r) => _mixExsContains(r, 'phoenix_live_view') },
];

// ─── ORM / Data Layer Detection Rules ─────────────────────────────────────────

const DATA_LAYER_RULES = [
  // ── JavaScript / TypeScript ─────────────────────────────────────────────
  { name: 'Prisma',       lang: 'javascript', detect: (_r, d) => !!d['prisma'] || !!d['@prisma/client'], configFile: 'prisma/schema.prisma' },
  { name: 'TypeORM',      lang: 'javascript', detect: (_r, d) => !!d['typeorm'], configFile: 'ormconfig.json' },
  { name: 'Drizzle',      lang: 'javascript', detect: (_r, d) => !!d['drizzle-orm'] },
  { name: 'Sequelize',    lang: 'javascript', detect: (_r, d) => !!d['sequelize'] },
  { name: 'Mongoose',     lang: 'javascript', detect: (_r, d) => !!d['mongoose'] },
  { name: 'Knex',         lang: 'javascript', detect: (_r, d) => !!d['knex'] },

  // ── Python ──────────────────────────────────────────────────────────────
  { name: 'Django ORM',   lang: 'python',     detect: (r, d) => !!d['django'] || !!d['Django'] || _fileExists(r, 'manage.py') },
  { name: 'SQLAlchemy',   lang: 'python',     detect: (_r, d) => !!d['sqlalchemy'] || !!d['SQLAlchemy'] },
  { name: 'Tortoise ORM', lang: 'python',     detect: (_r, d) => !!d['tortoise-orm'] },

  // ── Go ──────────────────────────────────────────────────────────────────
  { name: 'GORM',         lang: 'go',         detect: (r) => _goModContains(r, 'gorm.io/gorm') },
  { name: 'sqlx',         lang: 'go',         detect: (r) => _goModContains(r, 'github.com/jmoiron/sqlx') },
  { name: 'Ent',          lang: 'go',         detect: (r) => _goModContains(r, 'entgo.io/ent') },

  // ── Java ────────────────────────────────────────────────────────────────
  { name: 'JPA/Hibernate',lang: 'java',       detect: (r) => _pomContains(r, 'hibernate') || _pomContains(r, 'spring-data-jpa') },
  { name: 'MyBatis',      lang: 'java',       detect: (r) => _pomContains(r, 'mybatis') },

  // ── Rust ────────────────────────────────────────────────────────────────
  { name: 'Diesel',       lang: 'rust',       detect: (r) => _cargoContains(r, 'diesel') },
  { name: 'SeaORM',       lang: 'rust',       detect: (r) => _cargoContains(r, 'sea-orm') },

  // ── .NET ────────────────────────────────────────────────────────────────
  { name: 'Entity Framework', lang: 'csharp', detect: (r) => _csprojContains(r, 'Microsoft.EntityFrameworkCore') },
  { name: 'Dapper',       lang: 'csharp',     detect: (r) => _csprojContains(r, 'Dapper') },

  // ── Dart / Flutter ──────────────────────────────────────────────────────
  { name: 'Drift',        lang: 'dart',       detect: (r) => _pubspecContains(r, 'drift') },
  { name: 'Isar',         lang: 'dart',       detect: (r) => _pubspecContains(r, 'isar') },
  { name: 'Hive',         lang: 'dart',       detect: (r) => _pubspecContains(r, 'hive') },

  // ── Kotlin ──────────────────────────────────────────────────────────────
  { name: 'Exposed',      lang: 'kotlin',     detect: (r) => _gradleContains(r, 'exposed') },
  { name: 'Room',         lang: 'kotlin',     detect: (r) => _gradleContains(r, 'room') },
  { name: 'Ktorm',        lang: 'kotlin',     detect: (r) => _gradleContains(r, 'ktorm') },

  // ── PHP ──────────────────────────────────────────────────────────────────
  { name: 'Eloquent',     lang: 'php',        detect: (r) => _composerContains(r, 'laravel/framework') || _composerContains(r, 'illuminate/database') },
  { name: 'Doctrine',     lang: 'php',        detect: (r) => _composerContains(r, 'doctrine/orm') },
  { name: 'RedBeanPHP',   lang: 'php',        detect: (r) => _composerContains(r, 'gabordemooij/redbean') },

  // ── Ruby ─────────────────────────────────────────────────────────────────
  { name: 'ActiveRecord', lang: 'ruby',       detect: (r) => _gemfileContains(r, 'activerecord') || _gemfileContains(r, 'rails') },
  { name: 'Sequel',       lang: 'ruby',       detect: (r) => _gemfileContains(r, 'sequel') },

  // ── Swift ───────────────────────────────────────────────────────────────
  { name: 'CoreData',     lang: 'swift',      detect: (r) => _readFileContent(r, 'Package.swift').includes('CoreData') || _hasExt(r, '.xcdatamodeld') },
  { name: 'GRDB',         lang: 'swift',      detect: (r) => _readFileContent(r, 'Package.swift').includes('GRDB') },

  // ── C / C++ ─────────────────────────────────────────────────────────────
  { name: 'SQLiteCpp',    lang: 'cpp',        detect: (r) => _readFileContent(r, 'CMakeLists.txt').includes('SQLiteCpp') },

  // ── Scala ───────────────────────────────────────────────────────────────
  { name: 'Slick',        lang: 'scala',      detect: (r) => _sbtContains(r, 'slick') },
  { name: 'Doobie',       lang: 'scala',      detect: (r) => _sbtContains(r, 'doobie') },

  // ── Elixir ──────────────────────────────────────────────────────────────
  { name: 'Ecto',         lang: 'elixir',     detect: (r) => _mixExsContains(r, 'ecto') },
];

// ─── Database Detection ───────────────────────────────────────────────────────

const DATABASE_INDICATORS = [
  { name: 'PostgreSQL',  indicators: ['postgres', 'pg', 'postgresql', 'psycopg'] },
  { name: 'MySQL',       indicators: ['mysql', 'mysql2', 'mariadb'] },
  { name: 'SQLite',      indicators: ['sqlite', 'sqlite3', 'better-sqlite3'] },
  { name: 'MongoDB',     indicators: ['mongodb', 'mongoose', 'mongoclient'] },
  { name: 'Redis',       indicators: ['redis', 'ioredis', 'bull', 'bullmq'] },
  { name: 'DynamoDB',    indicators: ['dynamodb', 'aws-sdk'] },
  { name: 'Elasticsearch', indicators: ['elasticsearch', '@elastic/elasticsearch'] },
  { name: 'Firebase',    indicators: ['firebase', 'firestore'] },
  { name: 'Supabase',    indicators: ['@supabase/supabase-js', 'supabase'] },
];

// ─── Test Framework Detection Rules ───────────────────────────────────────────

const TEST_FRAMEWORK_RULES = [
  { name: 'Jest',         lang: 'javascript', detect: (_r, d) => !!d['jest'] || !!d['@jest/core'] },
  { name: 'Vitest',       lang: 'javascript', detect: (_r, d) => !!d['vitest'] },
  { name: 'Mocha',        lang: 'javascript', detect: (_r, d) => !!d['mocha'] },
  { name: 'Playwright',   lang: 'javascript', detect: (_r, d) => !!d['@playwright/test'] || !!d['playwright'] },
  { name: 'Cypress',      lang: 'javascript', detect: (_r, d) => !!d['cypress'] },
  { name: 'Supertest',    lang: 'javascript', detect: (_r, d) => !!d['supertest'] },
  { name: 'pytest',       lang: 'python',     detect: (_r, d) => !!d['pytest'] },
  { name: 'unittest',     lang: 'python',     detect: (r) => _dirExists(r, 'tests') || _dirExists(r, 'test') },
  { name: 'JUnit',        lang: 'java',       detect: (r) => _pomContains(r, 'junit') || _gradleContains(r, 'junit') },
  { name: 'xUnit',        lang: 'csharp',     detect: (r) => _csprojContains(r, 'xunit') },
  { name: 'NUnit',        lang: 'csharp',     detect: (r) => _csprojContains(r, 'NUnit') },
  { name: 'flutter_test', lang: 'dart',       detect: (r) => _pubspecContains(r, 'flutter_test') },
  { name: 'go test',      lang: 'go',         detect: (r) => _fileExists(r, 'go.mod') },
  { name: 'cargo test',   lang: 'rust',       detect: (r) => _fileExists(r, 'Cargo.toml') },

  // ── Kotlin ──────────────────────────────────────────────────────────────
  { name: 'Kotest',       lang: 'kotlin',     detect: (r) => _gradleContains(r, 'kotest') },

  // ── PHP ──────────────────────────────────────────────────────────────────
  { name: 'PHPUnit',      lang: 'php',        detect: (r) => _composerContains(r, 'phpunit') || _fileExists(r, 'phpunit.xml') },
  { name: 'Pest',         lang: 'php',        detect: (r) => _composerContains(r, 'pestphp/pest') },

  // ── Ruby ─────────────────────────────────────────────────────────────────
  { name: 'RSpec',        lang: 'ruby',       detect: (r) => _gemfileContains(r, 'rspec') || _dirExists(r, 'spec') },
  { name: 'Minitest',     lang: 'ruby',       detect: (r) => _gemfileContains(r, 'minitest') },

  // ── Swift ───────────────────────────────────────────────────────────────
  { name: 'XCTest',       lang: 'swift',      detect: (r) => _readFileContent(r, 'Package.swift').includes('XCTest') || _dirExists(r, 'Tests') },

  // ── C / C++ ─────────────────────────────────────────────────────────────
  { name: 'GoogleTest',   lang: 'cpp',        detect: (r) => _readFileContent(r, 'CMakeLists.txt').includes('gtest') || _readFileContent(r, 'CMakeLists.txt').includes('GTest') },
  { name: 'Catch2',       lang: 'cpp',        detect: (r) => _readFileContent(r, 'CMakeLists.txt').includes('Catch2') },

  // ── Scala ───────────────────────────────────────────────────────────────
  { name: 'ScalaTest',    lang: 'scala',      detect: (r) => _sbtContains(r, 'scalatest') },

  // ── Elixir ──────────────────────────────────────────────────────────────
  { name: 'ExUnit',       lang: 'elixir',     detect: (r) => _fileExists(r, 'mix.exs') },
];

// ─── Architecture Pattern Rules ───────────────────────────────────────────────
// Inference based on directory structure + naming patterns

const ARCHITECTURE_PATTERNS = [
  {
    name: 'Clean Architecture',
    confidence: 0,
    dirPatterns: ['domain', 'usecases', 'infrastructure', 'presentation', 'application'],
    minMatch: 3,
  },
  {
    name: 'MVC',
    confidence: 0,
    dirPatterns: ['controllers', 'models', 'views', 'controller', 'model', 'view'],
    minMatch: 2,
  },
  {
    name: 'MVVM',
    confidence: 0,
    dirPatterns: ['viewmodels', 'viewmodel', 'view_models', 'view_model', 'views', 'models'],
    minMatch: 2,
  },
  {
    name: 'Layered (Service-Repository)',
    confidence: 0,
    dirPatterns: ['services', 'repositories', 'entities', 'dtos', 'service', 'repository'],
    minMatch: 2,
  },
  {
    name: 'Feature-based Modules',
    confidence: 0,
    // Detected by finding multiple sibling dirs that each contain similar sub-structures
    dirPatterns: ['modules', 'features', 'packages'],
    minMatch: 1,
  },
  {
    name: 'Hexagonal (Ports & Adapters)',
    confidence: 0,
    dirPatterns: ['ports', 'adapters', 'domain', 'core'],
    minMatch: 3,
  },
  {
    name: 'Component-based (Unity/Game)',
    confidence: 0,
    dirPatterns: ['Scripts', 'Components', 'Prefabs', 'Scenes', 'GameFramework'],
    minMatch: 2,
  },
];

// ─── File System Helpers ──────────────────────────────────────────────────────

/**
 * Per-analysis file read cache. Prevents the same config file (pom.xml, go.mod,
 * Cargo.toml, etc.) from being read from disk multiple times when multiple
 * detection rules check the same file.
 * Key: absolute path, Value: file content string (empty string for non-existent).
 * The cache is module-scoped and cleared at the start of each analyze() call.
 */
let _fileContentCache = new Map();

/** Clears the file content cache. Called at the start of each analyze(). */
function _clearFileContentCache() {
  _fileContentCache = new Map();
}

function _fileExists(root, relPath) {
  try { return fs.existsSync(path.join(root, relPath)); } catch { return false; }
}

function _dirExists(root, relPath) {
  try {
    const stat = fs.statSync(path.join(root, relPath));
    return stat.isDirectory();
  } catch { return false; }
}

function _hasExt(root, ext) {
  try {
    const entries = fs.readdirSync(root);
    return entries.some(e => e.endsWith(ext));
  } catch { return false; }
}

/**
 * Reads file content with per-analysis caching.
 * Eliminates redundant disk I/O when multiple rules check the same file
 * (e.g. pom.xml read by Spring Boot, Quarkus, Hibernate, MyBatis, JUnit rules).
 */
function _readFileContent(root, relPath) {
  const fullPath = path.join(root, relPath);
  if (_fileContentCache.has(fullPath)) return _fileContentCache.get(fullPath);
  try {
    if (!fs.existsSync(fullPath)) {
      _fileContentCache.set(fullPath, '');
      return '';
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    _fileContentCache.set(fullPath, content);
    return content;
  } catch {
    _fileContentCache.set(fullPath, '');
    return '';
  }
}

function _goModContains(root, dep) {
  return _readFileContent(root, 'go.mod').includes(dep);
}

function _pomContains(root, dep) {
  return _readFileContent(root, 'pom.xml').toLowerCase().includes(dep.toLowerCase());
}

function _gradleContains(root, dep) {
  const content = _readFileContent(root, 'build.gradle') + _readFileContent(root, 'build.gradle.kts');
  return content.toLowerCase().includes(dep.toLowerCase());
}

function _cargoContains(root, dep) {
  return _readFileContent(root, 'Cargo.toml').includes(dep);
}

function _csprojContains(root, dep) {
  // Check all .csproj files in root and src/
  const dirs = ['.', 'src'];
  for (const dir of dirs) {
    try {
      const dirPath = path.join(root, dir);
      if (!fs.existsSync(dirPath)) continue;
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        if (entry.endsWith('.csproj')) {
          if (_readFileContent(dirPath, entry).includes(dep)) return true;
        }
      }
    } catch { /* ignore */ }
  }
  return false;
}

function _pubspecContains(root, dep) {
  return _readFileContent(root, 'pubspec.yaml').includes(dep);
}

function _composerContains(root, dep) {
  return _readFileContent(root, 'composer.json').toLowerCase().includes(dep.toLowerCase());
}

function _gemfileContains(root, dep) {
  return _readFileContent(root, 'Gemfile').toLowerCase().includes(dep.toLowerCase());
}

function _mixExsContains(root, dep) {
  return _readFileContent(root, 'mix.exs').toLowerCase().includes(dep.toLowerCase());
}

function _sbtContains(root, dep) {
  return _readFileContent(root, 'build.sbt').toLowerCase().includes(dep.toLowerCase());
}

// ─── Dependency Reader ────────────────────────────────────────────────────────

/**
 * Reads merged dependencies from the project's package manifest.
 * Returns a flat object { packageName: version } for quick lookups.
 */
function _readDependencies(root) {
  const deps = {};

  // JavaScript / TypeScript: package.json
  const pkgContent = _readFileContent(root, 'package.json');
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      Object.assign(deps, pkg.dependencies || {}, pkg.devDependencies || {});
    } catch { /* ignore */ }
  }

  // Python: requirements.txt / pyproject.toml
  const reqContent = _readFileContent(root, 'requirements.txt');
  if (reqContent) {
    try {
      const lines = reqContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const name = trimmed.split(/[>=<!\[]/)[0].trim().toLowerCase();
        if (name) deps[name] = '*';
      }
    } catch { /* ignore */ }
  }

  const pyprojectContent = _readFileContent(root, 'pyproject.toml');
  if (pyprojectContent) {
    try {
      // Simple extraction of dependency names from pyproject.toml
      const depSection = pyprojectContent.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (depSection) {
        const depList = depSection[1].match(/"([^"]+)"/g) || [];
        for (const d of depList) {
          const name = d.replace(/"/g, '').split(/[>=<!\[]/)[0].trim().toLowerCase();
          if (name) deps[name] = '*';
        }
      }
    } catch { /* ignore */ }
  }

  // PHP: composer.json
  const composerContent = _readFileContent(root, 'composer.json');
  if (composerContent) {
    try {
      const composer = JSON.parse(composerContent);
      const allDeps = { ...composer.require, ...composer['require-dev'] };
      for (const name of Object.keys(allDeps)) {
        deps[name.toLowerCase()] = '*';
      }
    } catch { /* ignore */ }
  }

  // Ruby: Gemfile (simple line-based extraction)
  const gemfileContent = _readFileContent(root, 'Gemfile');
  if (gemfileContent) {
    try {
      const lines = gemfileContent.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*gem\s+['"]([^'"]+)/);
        if (match) deps[match[1].toLowerCase()] = '*';
      }
    } catch { /* ignore */ }
  }

  // Elixir: mix.exs (extract {:dep_name, "version"} patterns)
  const mixContent = _readFileContent(root, 'mix.exs');
  if (mixContent) {
    try {
      const depMatches = mixContent.match(/\{:(\w+)/g) || [];
      for (const m of depMatches) {
        const name = m.replace('{:', '');
        if (name) deps[name.toLowerCase()] = '*';
      }
    } catch { /* ignore */ }
  }

  // Scala: build.sbt (extract "org" %% "artifact" patterns)
  const sbtContent = _readFileContent(root, 'build.sbt');
  if (sbtContent) {
    try {
      const sbtMatches = sbtContent.match(/"([^"]+)"\s*%%?\s*"([^"]+)"/g) || [];
      for (const m of sbtMatches) {
        const parts = m.match(/"([^"]+)"\s*%%?\s*"([^"]+)"/);
        if (parts) deps[parts[2].toLowerCase()] = '*';
      }
    } catch { /* ignore */ }
  }

  return deps;
}

// ─── Directory Scanner ────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.dart_tool', 'build', 'dist', 'output',
  'Library', 'Temp', 'obj', 'Packages', '.vs', '__pycache__', '.venv',
  'venv', 'target', 'bin', '.gradle', '.idea', '.next', '.nuxt',
  '.svelte-kit', 'coverage', '.turbo', '.cache',
]);

/**
 * Collects all directory names (depth ≤ maxDepth) in the project.
 */
function _collectDirNames(root, maxDepth = 4) {
  const names = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      names.add(e.name.toLowerCase());
      walk(path.join(dir, e.name), depth + 1);
    }
  }

  walk(root, 1);
  return names;
}

// ─── Communication Pattern Detection ──────────────────────────────────────────

function _detectCommunicationPatterns(root, deps) {
  const patterns = [];

  // Dependency Injection
  if (deps['@nestjs/core'] || deps['inversify'] || deps['tsyringe'] || deps['awilix']) {
    patterns.push('Dependency Injection');
  }
  if (_csprojContains(root, 'Microsoft.Extensions.DependencyInjection')) {
    patterns.push('Dependency Injection (.NET)');
  }
  if (_pomContains(root, 'spring-context') || _pomContains(root, 'spring-boot')) {
    patterns.push('Dependency Injection (Spring)');
  }

  // Event-driven
  if (deps['eventemitter3'] || deps['eventemitter2'] || deps['mitt'] || deps['rxjs']) {
    patterns.push('Event-driven');
  }
  if (deps['bull'] || deps['bullmq'] || deps['amqplib'] || deps['kafkajs']) {
    patterns.push('Message Queue');
  }

  // WebSocket
  if (deps['socket.io'] || deps['ws'] || deps['@nestjs/websockets']) {
    patterns.push('WebSocket');
  }

  // gRPC
  if (deps['@grpc/grpc-js'] || deps['grpc'] || _goModContains(root, 'google.golang.org/grpc')) {
    patterns.push('gRPC');
  }

  // GraphQL
  if (deps['graphql'] || deps['apollo-server'] || deps['@apollo/server'] || deps['type-graphql']) {
    patterns.push('GraphQL');
  }

  // REST (inferred from having a web framework)
  if (deps['express'] || deps['fastify'] || deps['koa'] || deps['@nestjs/core'] ||
      deps['fastapi'] || deps['flask'] || deps['django'] ||
      deps['laravel/framework'] || deps['symfony/framework-bundle'] ||
      deps['rails'] || deps['sinatra'] || deps['phoenix'] ||
      _goModContains(root, 'github.com/gin-gonic/gin') ||
      _goModContains(root, 'github.com/labstack/echo') ||
      _goModContains(root, 'github.com/gofiber/fiber')) {
    patterns.push('REST API');
  }

  return patterns;
}

// ─── Infrastructure Detection ─────────────────────────────────────────────────

function _detectInfrastructure(root) {
  const infra = {};

  // Containerization
  if (_fileExists(root, 'Dockerfile') || _fileExists(root, 'dockerfile')) {
    infra.containerized = true;
  }
  if (_fileExists(root, 'docker-compose.yml') || _fileExists(root, 'docker-compose.yaml') || _fileExists(root, 'compose.yml')) {
    infra.orchestration = 'docker-compose';
  }
  if (_dirExists(root, 'k8s') || _dirExists(root, 'kubernetes') || _dirExists(root, 'helm')) {
    infra.orchestration = 'Kubernetes';
  }

  // CI/CD
  if (_dirExists(root, '.github/workflows')) infra.ci = 'GitHub Actions';
  else if (_fileExists(root, '.gitlab-ci.yml')) infra.ci = 'GitLab CI';
  else if (_fileExists(root, 'Jenkinsfile')) infra.ci = 'Jenkins';
  else if (_fileExists(root, '.circleci/config.yml')) infra.ci = 'CircleCI';
  else if (_fileExists(root, 'azure-pipelines.yml')) infra.ci = 'Azure Pipelines';
  else if (_fileExists(root, 'bitbucket-pipelines.yml')) infra.ci = 'Bitbucket Pipelines';

  // IaC
  if (_dirExists(root, 'terraform') || _hasExt(root, '.tf')) infra.iac = 'Terraform';
  else if (_fileExists(root, 'serverless.yml') || _fileExists(root, 'serverless.ts')) infra.iac = 'Serverless Framework';
  else if (_fileExists(root, 'cdk.json')) infra.iac = 'AWS CDK';
  else if (_fileExists(root, 'pulumi.yaml')) infra.iac = 'Pulumi';

  return infra;
}

// ─── Monorepo Detection ───────────────────────────────────────────────────────

function _detectMonorepo(root, deps) {
  const result = { isMonorepo: false, tool: null, packages: [] };

  // Check package.json workspaces
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.workspaces) {
        result.isMonorepo = true;
        if (deps['lerna']) result.tool = 'Lerna';
        else if (deps['turbo']) result.tool = 'Turborepo';
        else if (deps['nx']) result.tool = 'Nx';
        else result.tool = 'npm/yarn workspaces';
      }
    } catch { /* ignore */ }
  }

  // Check for pnpm workspace
  if (_fileExists(root, 'pnpm-workspace.yaml')) {
    result.isMonorepo = true;
    result.tool = result.tool || 'pnpm workspace';
  }

  // Check for Nx
  if (_fileExists(root, 'nx.json')) {
    result.isMonorepo = true;
    result.tool = 'Nx';
  }

  // List package directories
  if (result.isMonorepo) {
    for (const dir of ['packages', 'apps', 'libs', 'services', 'modules']) {
      const dirPath = path.join(root, dir);
      if (_dirExists(root, dir)) {
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory() && !e.name.startsWith('.')) {
              result.packages.push(`${dir}/${e.name}`);
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  return result;
}

// ─── API Detection ────────────────────────────────────────────────────────────

function _detectAPIs(root) {
  const apis = [];

  // OpenAPI / Swagger
  for (const f of ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json']) {
    if (_fileExists(root, f)) { apis.push('OpenAPI/Swagger'); break; }
  }
  if (_dirExists(root, 'docs/api') || _dirExists(root, 'api-docs')) {
    if (!apis.includes('OpenAPI/Swagger')) apis.push('API docs');
  }

  // GraphQL schema
  for (const f of ['schema.graphql', 'schema.gql']) {
    if (_fileExists(root, f) || _fileExists(root, `src/${f}`)) { apis.push('GraphQL Schema'); break; }
  }

  // gRPC / Protobuf
  if (_dirExists(root, 'proto') || _dirExists(root, 'protos')) {
    apis.push('gRPC/Protobuf');
  }

  return apis;
}

// ─── Database Detection from Config Files ─────────────────────────────────────

function _detectDatabases(root, deps) {
  const databases = [];
  const allContent = _gatherConfigContent(root);

  for (const db of DATABASE_INDICATORS) {
    for (const indicator of db.indicators) {
      if (deps[indicator] || allContent.includes(indicator)) {
        databases.push(db.name);
        break;
      }
    }
  }

  return [...new Set(databases)];
}

function _gatherConfigContent(root) {
  // Gather content from common config files for keyword searching
  const configFiles = [
    '.env', '.env.example', '.env.development', '.env.local',
    'docker-compose.yml', 'docker-compose.yaml', 'compose.yml',
    'ormconfig.json', 'ormconfig.js',
    'prisma/schema.prisma',
    'knexfile.js', 'knexfile.ts',
  ];
  let content = '';
  for (const f of configFiles) {
    content += _readFileContent(root, f).toLowerCase() + '\n';
  }
  return content;
}

// ─── Entry Point Detection ────────────────────────────────────────────────────

function _detectEntryPoints(root) {
  const candidates = [
    // JavaScript / TypeScript
    'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
    'src/app.ts', 'src/app.js', 'src/server.ts', 'src/server.js',
    'index.ts', 'index.js', 'main.ts', 'main.js',
    'app.ts', 'app.js', 'server.ts', 'server.js',
    // Python
    'main.py', 'app.py', 'manage.py',
    // Go
    'main.go', 'cmd/main.go', 'cmd/server/main.go',
    // Rust
    'src/main.rs', 'src/lib.rs',
    // Dart / Flutter
    'lib/main.dart',
    // C# / .NET / Unity
    'Program.cs', 'src/Program.cs',
    'Assets/Scripts/Main.cs', 'Assets/Scripts/GameEntry.cs',
    // PHP
    'public/index.php', 'index.php', 'artisan',
    // Ruby
    'config.ru', 'config/application.rb', 'bin/rails',
    // Kotlin
    'src/main/kotlin/Main.kt', 'src/main/kotlin/Application.kt',
    // Scala
    'src/main/scala/Main.scala', 'src/main/scala/App.scala',
    // Elixir
    'lib/application.ex', 'lib/app.ex',
    // Swift
    'Sources/main.swift', 'Sources/App/main.swift',
    // C / C++
    'src/main.cpp', 'src/main.c', 'main.cpp', 'main.c',
  ];

  return candidates.filter(c => _fileExists(root, c));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ProjectProfiler Class ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

class ProjectProfiler {
  /**
   * @param {string} projectRoot - Absolute path to the project root
   * @param {object} [options]
   * @param {string[]} [options.ignoreDirs] - Additional dirs to ignore during scanning
   */
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot;
    this.ignoreDirs = options.ignoreDirs || [];
  }

  /**
   * Runs all detectors and produces a structured Project Profile.
   *
   * @returns {object} The complete project profile
   */
  analyze() {
    console.log(`[ProjectProfiler] Analyzing project: ${this.projectRoot}`);
    // P0 perf: clear per-analysis file content cache to ensure fresh reads
    // while avoiding redundant I/O within the same analysis run.
    _clearFileContentCache();
    const root = this.projectRoot;
    const deps = _readDependencies(root);
    const dirNames = _collectDirNames(root);

    // ── 1. Framework Detection ────────────────────────────────────────────
    const frameworks = [];
    for (const rule of FRAMEWORK_RULES) {
      try {
        if (rule.detect(root, deps)) {
          frameworks.push({ name: rule.name, category: rule.category, lang: rule.lang });
        }
      } catch { /* ignore detection errors */ }
    }
    console.log(`[ProjectProfiler]   Frameworks: ${frameworks.map(f => f.name).join(', ') || 'none detected'}`);

    // ── 2. Architecture Pattern Inference ─────────────────────────────────
    const architecture = this._inferArchitecture(dirNames, frameworks);
    console.log(`[ProjectProfiler]   Architecture: ${architecture.pattern || 'unknown'}`);

    // ── 3. Data Layer Detection ───────────────────────────────────────────
    const dataLayer = { orm: [], databases: [] };
    for (const rule of DATA_LAYER_RULES) {
      try {
        if (rule.detect(root, deps)) {
          dataLayer.orm.push(rule.name);
        }
      } catch { /* ignore */ }
    }
    dataLayer.databases = _detectDatabases(root, deps);
    console.log(`[ProjectProfiler]   Data Layer: ORM=${dataLayer.orm.join(', ') || 'none'}, DB=${dataLayer.databases.join(', ') || 'none'}`);

    // ── 4. Communication Patterns ─────────────────────────────────────────
    const communication = _detectCommunicationPatterns(root, deps);
    console.log(`[ProjectProfiler]   Communication: ${communication.join(', ') || 'none detected'}`);

    // ── 5. Test Strategy ──────────────────────────────────────────────────
    const testing = { frameworks: [] };
    for (const rule of TEST_FRAMEWORK_RULES) {
      try {
        if (rule.detect(root, deps)) {
          testing.frameworks.push(rule.name);
        }
      } catch { /* ignore */ }
    }
    console.log(`[ProjectProfiler]   Testing: ${testing.frameworks.join(', ') || 'none detected'}`);

    // ── 6. API Detection ──────────────────────────────────────────────────
    const apis = _detectAPIs(root);

    // ── 7. Infrastructure Detection ───────────────────────────────────────
    const infrastructure = _detectInfrastructure(root);

    // ── 8. Monorepo Detection ─────────────────────────────────────────────
    const monorepo = _detectMonorepo(root, deps);

    // ── 9. Entry Points ───────────────────────────────────────────────────
    const entryPoints = _detectEntryPoints(root);

    // ── Assemble Profile ──────────────────────────────────────────────────
    const profile = {
      frameworks,
      architecture,
      dataLayer,
      communication,
      testing,
      apis,
      infrastructure,
      monorepo,
      entryPoints,
      analyzedAt: new Date().toISOString(),
    };

    console.log(`[ProjectProfiler] ✅ Analysis complete.`);
    return profile;
  }

  /**
   * Runs analyze() and writes results to output/project-profile.md and
   * returns the profile object for injection into workflow.config.js.
   *
   * @param {string} [outputDir] - Output directory (default: <projectRoot>/output)
   * @returns {{ profile: object, mdPath: string }}
   */
  analyzeAndWrite(outputDir) {
    const profile = this.analyze();
    const outDir = outputDir || path.join(this.projectRoot, 'output');

    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const mdContent = this._renderProfileMarkdown(profile);
    const mdPath = path.join(outDir, 'project-profile.md');
    fs.writeFileSync(mdPath, mdContent, 'utf-8');
    console.log(`[ProjectProfiler] 📄 Written: ${mdPath}`);

    return { profile, mdPath };
  }

  /**
   * Runs analyze() + LSP enhancement + writes results.
   * This is the recommended entry point when LSP is available.
   *
   * @param {string} [outputDir] - Output directory (default: <projectRoot>/output)
   * @param {object} [lspConfig] - LSP configuration (server, command, args, timeout, maxFiles)
   * @returns {Promise<{ profile: object, mdPath: string }>}
   */
  async analyzeWithLSP(outputDir, lspConfig = {}) {
    const profile = this.analyze();

    // Phase 2: Attempt LSP enhancement
    try {
      const { enhanceProfileWithLSP } = require('./lsp-profile-enhancer');
      console.log(`[ProjectProfiler] 🔬 Phase 2: Attempting LSP enhancement...`);
      await enhanceProfileWithLSP(profile, this.projectRoot, lspConfig);
      if (profile.lspEnhanced) {
        console.log(`[ProjectProfiler] ✅ LSP enhancement applied (server: ${profile.lspServerName}).`);
      }
    } catch (err) {
      console.log(`[ProjectProfiler] ℹ️  LSP enhancement not available: ${err.message}`);
    }

    // Write output
    const outDir = outputDir || path.join(this.projectRoot, 'output');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const mdContent = this._renderProfileMarkdown(profile);
    const mdPath = path.join(outDir, 'project-profile.md');
    fs.writeFileSync(mdPath, mdContent, 'utf-8');
    console.log(`[ProjectProfiler] 📄 Written: ${mdPath}`);

    return { profile, mdPath };
  }

  // ─── Architecture Inference ─────────────────────────────────────────────

  _inferArchitecture(dirNames, frameworks) {
    const result = { pattern: null, layers: [], moduleStructure: null, confidence: 0 };

    // Score each architecture pattern
    const scored = ARCHITECTURE_PATTERNS.map(pat => {
      const matches = pat.dirPatterns.filter(d => dirNames.has(d));
      const score = matches.length;
      return { ...pat, score, matchedDirs: matches };
    }).filter(p => p.score >= p.minMatch);

    // Sort by score, pick the best
    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      result.pattern = best.name;
      result.confidence = Math.min(1, best.score / (best.dirPatterns.length * 0.7));
    }

    // Detect layers from common directory names
    const layerMapping = {
      controllers: 'Controller', controller: 'Controller',
      routes: 'Router', router: 'Router',
      services: 'Service', service: 'Service',
      repositories: 'Repository', repository: 'Repository',
      models: 'Model', model: 'Model', entities: 'Entity', entity: 'Entity',
      dtos: 'DTO', dto: 'DTO',
      views: 'View', view: 'View',
      viewmodels: 'ViewModel', viewmodel: 'ViewModel',
      middleware: 'Middleware', middlewares: 'Middleware',
      guards: 'Guard', pipes: 'Pipe', interceptors: 'Interceptor',
      utils: 'Utility', helpers: 'Helper', lib: 'Library',
      components: 'Component', widgets: 'Widget',
      pages: 'Page', screens: 'Screen',
      hooks: 'Hook',
    };

    for (const [dirName, layer] of Object.entries(layerMapping)) {
      if (dirNames.has(dirName) && !result.layers.includes(layer)) {
        result.layers.push(layer);
      }
    }

    // Detect module structure type
    if (dirNames.has('modules') || dirNames.has('features')) {
      result.moduleStructure = 'feature-based';
    } else if (result.layers.length >= 3) {
      result.moduleStructure = 'layer-based';
    }

    // Framework-specific overrides
    const frameworkNames = frameworks.map(f => f.name);
    if (frameworkNames.includes('NestJS')) {
      result.pattern = result.pattern || 'Module-based (NestJS)';
      if (!result.layers.includes('Controller')) result.layers.push('Controller');
      if (!result.layers.includes('Service')) result.layers.push('Service');
      result.moduleStructure = 'feature-based';
    }
    if (frameworkNames.includes('Unity')) {
      result.pattern = result.pattern || 'Component-based (Unity/Game)';
      result.moduleStructure = 'component-based';
    }
    if (frameworkNames.includes('Django')) {
      result.pattern = result.pattern || 'MVT (Django)';
      result.moduleStructure = 'app-based';
    }
    if (frameworkNames.includes('Spring Boot')) {
      result.pattern = result.pattern || 'Layered (Spring)';
      result.moduleStructure = result.moduleStructure || 'layer-based';
    }

    return result;
  }

  // ─── Markdown Renderer ──────────────────────────────────────────────────

  _renderProfileMarkdown(profile) {
    const lines = [
      `# Project Architecture Profile`,
      ``,
      `> Auto-generated by ProjectProfiler. Last updated: ${profile.analyzedAt}`,
      `> This file is consumed by AI agents for context. Do not edit manually.`,
      ``,
    ];

    // Frameworks
    if (profile.frameworks.length > 0) {
      lines.push(`## Frameworks`);
      lines.push(``);
      const byCategory = {};
      for (const f of profile.frameworks) {
        if (!byCategory[f.category]) byCategory[f.category] = [];
        byCategory[f.category].push(f.name);
      }
      for (const [cat, names] of Object.entries(byCategory)) {
        lines.push(`- **${cat}**: ${names.join(', ')}`);
      }
      lines.push(``);
    }

    // Architecture
    if (profile.architecture.pattern) {
      lines.push(`## Architecture`);
      lines.push(``);
      lines.push(`- **Pattern**: ${profile.architecture.pattern}`);
      if (profile.architecture.layers.length > 0) {
        lines.push(`- **Layers**: ${profile.architecture.layers.join(' → ')}`);
      }
      if (profile.architecture.moduleStructure) {
        lines.push(`- **Module Structure**: ${profile.architecture.moduleStructure}`);
      }
      lines.push(``);
    }

    // Data Layer
    if (profile.dataLayer.orm.length > 0 || profile.dataLayer.databases.length > 0) {
      lines.push(`## Data Layer`);
      lines.push(``);
      if (profile.dataLayer.orm.length > 0) {
        lines.push(`- **ORM/Query Builder**: ${profile.dataLayer.orm.join(', ')}`);
      }
      if (profile.dataLayer.databases.length > 0) {
        lines.push(`- **Databases**: ${profile.dataLayer.databases.join(', ')}`);
      }
      lines.push(``);
    }

    // Communication
    if (profile.communication.length > 0) {
      lines.push(`## Communication Patterns`);
      lines.push(``);
      for (const p of profile.communication) {
        lines.push(`- ${p}`);
      }
      lines.push(``);
    }

    // Testing
    if (profile.testing.frameworks.length > 0) {
      lines.push(`## Testing`);
      lines.push(``);
      lines.push(`- **Frameworks**: ${profile.testing.frameworks.join(', ')}`);
      lines.push(``);
    }

    // APIs
    if (profile.apis.length > 0) {
      lines.push(`## API Definitions`);
      lines.push(``);
      for (const a of profile.apis) {
        lines.push(`- ${a}`);
      }
      lines.push(``);
    }

    // Infrastructure
    if (Object.keys(profile.infrastructure).length > 0) {
      lines.push(`## Infrastructure`);
      lines.push(``);
      if (profile.infrastructure.containerized) lines.push(`- **Container**: Docker`);
      if (profile.infrastructure.orchestration) lines.push(`- **Orchestration**: ${profile.infrastructure.orchestration}`);
      if (profile.infrastructure.ci)            lines.push(`- **CI/CD**: ${profile.infrastructure.ci}`);
      if (profile.infrastructure.iac)           lines.push(`- **IaC**: ${profile.infrastructure.iac}`);
      lines.push(``);
    }

    // Monorepo
    if (profile.monorepo.isMonorepo) {
      lines.push(`## Monorepo`);
      lines.push(``);
      lines.push(`- **Tool**: ${profile.monorepo.tool}`);
      if (profile.monorepo.packages.length > 0) {
        lines.push(`- **Packages**: ${profile.monorepo.packages.join(', ')}`);
      }
      lines.push(``);
    }

    // Entry Points
    if (profile.entryPoints.length > 0) {
      lines.push(`## Entry Points`);
      lines.push(``);
      for (const ep of profile.entryPoints) {
        lines.push(`- \`${ep}\``);
      }
      lines.push(``);
    }

    // ── LSP-Enhanced Sections ──────────────────────────────────────────────

    if (profile.lspEnhanced) {
      lines.push(`## LSP-Enhanced Analysis`);
      lines.push(``);
      lines.push(`> Enhanced by Language Server: **${profile.lspServerName || 'auto'}**`);
      if (profile.lspStats) {
        lines.push(`> ${profile.lspStats.filesAnalyzed} files analyzed, ${profile.lspStats.symbolsCollected} symbols, ${profile.lspStats.timeTakenMs}ms`);
      }
      lines.push(``);

      // Symbol Inventory
      if (profile.architecture.symbolInventory) {
        const inv = profile.architecture.symbolInventory;
        const invEntries = Object.entries(inv).sort((a, b) => b[1] - a[1]);
        if (invEntries.length > 0) {
          lines.push(`### Symbol Inventory`);
          lines.push(``);
          lines.push(`| Kind | Count |`);
          lines.push(`|------|-------|`);
          for (const [kind, count] of invEntries) {
            lines.push(`| ${kind} | ${count} |`);
          }
          lines.push(``);
        }
      }

      // Decorator Patterns
      if (profile.architecture.decoratorPatterns) {
        const decs = profile.architecture.decoratorPatterns;
        if (Object.keys(decs).length > 0) {
          lines.push(`### Decorator Patterns`);
          lines.push(``);
          for (const [layer, decorators] of Object.entries(decs)) {
            lines.push(`- **${layer}**: ${decorators.join(', ')}`);
          }
          lines.push(``);
        }
      }

      // Module Map
      if (profile.architecture.moduleMap) {
        const mmap = profile.architecture.moduleMap;
        const entries = Object.entries(mmap).sort((a, b) => b[1].total - a[1].total).slice(0, 15);
        if (entries.length > 0) {
          lines.push(`### Module Density Map`);
          lines.push(``);
          lines.push(`| Directory | Classes | Functions | Interfaces | Total |`);
          lines.push(`|-----------|---------|-----------|------------|-------|`);
          for (const [dir, counts] of entries) {
            lines.push(`| ${dir} | ${counts.classes} | ${counts.functions} | ${counts.interfaces} | ${counts.total} |`);
          }
          lines.push(``);
        }
      }

      // Diagnostics
      if (profile.diagnostics) {
        lines.push(`### Compiler Diagnostics`);
        lines.push(``);
        lines.push(`- **Errors**: ${profile.diagnostics.errors}`);
        lines.push(`- **Warnings**: ${profile.diagnostics.warnings}`);
        if (profile.diagnostics.errorFiles && profile.diagnostics.errorFiles.length > 0) {
          lines.push(`- **Error Files**:`);
          for (const ef of profile.diagnostics.errorFiles) {
            lines.push(`  - \`${ef.file}\` (${ef.errors} errors)`);
          }
        }
        lines.push(``);
      }
    }

    return lines.join('\n');
  }
}

// ─── Utility: Compact profile summary for AGENTS.md ──────────────────────────

/**
 * Generates a compact Markdown summary of the project profile,
 * suitable for injection into AGENTS.md.
 *
 * @param {object} profile - Output of ProjectProfiler.analyze()
 * @returns {string} Compact Markdown section
 */
function renderCompactProfileSummary(profile) {
  if (!profile) return '';

  const lines = [`## Project Architecture Profile`, ``];

  // Frameworks (one-liner)
  if (profile.frameworks && profile.frameworks.length > 0) {
    const fwNames = profile.frameworks.map(f => f.name);
    lines.push(`- **Frameworks**: ${fwNames.join(', ')}`);
  }

  // Architecture
  if (profile.architecture && profile.architecture.pattern) {
    lines.push(`- **Architecture**: ${profile.architecture.pattern}`);
    if (profile.architecture.layers && profile.architecture.layers.length > 0) {
      lines.push(`- **Layers**: ${profile.architecture.layers.join(' → ')}`);
    }
  }

  // Data Layer (one-liner)
  if (profile.dataLayer) {
    const parts = [];
    if (profile.dataLayer.orm && profile.dataLayer.orm.length > 0) parts.push(profile.dataLayer.orm.join(', '));
    if (profile.dataLayer.databases && profile.dataLayer.databases.length > 0) parts.push(profile.dataLayer.databases.join(', '));
    if (parts.length > 0) lines.push(`- **Data Layer**: ${parts.join(' + ')}`);
  }

  // Communication (one-liner)
  if (profile.communication && profile.communication.length > 0) {
    lines.push(`- **Communication**: ${profile.communication.join(', ')}`);
  }

  // Testing (one-liner)
  if (profile.testing && profile.testing.frameworks && profile.testing.frameworks.length > 0) {
    lines.push(`- **Testing**: ${profile.testing.frameworks.join(', ')}`);
  }

  // Infrastructure (one-liner)
  if (profile.infrastructure) {
    const parts = [];
    if (profile.infrastructure.containerized) parts.push('Docker');
    if (profile.infrastructure.ci) parts.push(profile.infrastructure.ci);
    if (profile.infrastructure.orchestration) parts.push(profile.infrastructure.orchestration);
    if (parts.length > 0) lines.push(`- **Infrastructure**: ${parts.join(', ')}`);
  }

  // Monorepo
  if (profile.monorepo && profile.monorepo.isMonorepo) {
    lines.push(`- **Monorepo**: ${profile.monorepo.tool} (${profile.monorepo.packages.length} packages)`);
  }

  // Entry points
  if (profile.entryPoints && profile.entryPoints.length > 0) {
    lines.push(`- **Entry Points**: ${profile.entryPoints.map(e => '`' + e + '`').join(', ')}`);
  }

  // LSP enhancement marker + compact data summary
  if (profile.lspEnhanced) {
    const stats = profile.lspStats || {};
    lines.push(`- **LSP Enhanced**: ${profile.lspServerName || 'auto'} (${stats.symbolsCollected || 0} symbols, ${stats.filesAnalyzed || 0} files)`);

    // Symbol inventory: show top 3 symbol kinds by count
    if (profile.architecture && profile.architecture.symbolInventory) {
      const inv = profile.architecture.symbolInventory;
      const top3 = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (top3.length > 0) {
        lines.push(`- **Symbol Inventory (top)**: ${top3.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      }
    }

    // Decorator patterns: one-liner summary
    if (profile.architecture && profile.architecture.decoratorPatterns) {
      const decs = profile.architecture.decoratorPatterns;
      const decEntries = Object.entries(decs);
      if (decEntries.length > 0) {
        lines.push(`- **Decorator Patterns**: ${decEntries.map(([layer, ds]) => `${layer}(${ds.join(', ')})`).join(' | ')}`);
      }
    }

    // Diagnostics: one-liner summary
    if (profile.diagnostics) {
      const diag = profile.diagnostics;
      lines.push(`- **Compiler Diagnostics**: ${diag.errors || 0} errors, ${diag.warnings || 0} warnings`);
    }
  }

  lines.push(``);
  return lines.join('\n');
}

module.exports = {
  ProjectProfiler,
  renderCompactProfileSummary,
  IGNORE_DIRS,
};
