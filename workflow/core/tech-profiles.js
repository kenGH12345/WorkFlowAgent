'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Project Auto-Detection Helpers ──────────────────────────────────────────

function _detectFlutterPlatforms(root) {
  const platformDirs = { android: 'Android', ios: 'iOS', web: 'Web', windows: 'Windows', macos: 'macOS', linux: 'Linux' };
  const found = [];
  for (const [dir, label] of Object.entries(platformDirs)) {
    if (fs.existsSync(path.join(root, dir))) found.push(label);
  }
  return found.length > 0 ? found.join(', ') : 'iOS, Android';
}

function _detectFlutterStateManagement(root) {
  const pubspecPath = path.join(root, 'pubspec.yaml');
  if (!fs.existsSync(pubspecPath)) return 'StatefulWidget (default)';
  try {
    const content = fs.readFileSync(pubspecPath, 'utf-8');
    if (content.includes('riverpod'))                       return 'Riverpod';
    if (content.includes('bloc'))                           return 'BLoC / flutter_bloc';
    if (content.includes('provider'))                       return 'Provider';
    if (content.includes('get:') || content.includes('getx')) return 'GetX';
    if (content.includes('mobx'))                           return 'MobX';
    if (content.includes('redux'))                          return 'Redux';
  } catch (err) { console.warn(`[TechProfiles] Failed to read pubspec.yaml: ${err.message}`); }
  return 'StatefulWidget (default)';
}

function _detectNodePlatform(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'Node.js';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['react-native'] || deps['expo'])                       return 'iOS, Android (React Native)';
    if (deps['electron'])                                           return 'Desktop (Electron)';
    if (deps['next'] || deps['nuxt'])                               return 'Web (SSR)';
    if (deps['react'] || deps['vue'] || deps['svelte'])             return 'Web (SPA)';
    if (deps['express'] || deps['fastify'] || deps['koa'])          return 'Server (Node.js)';
  } catch (err) { console.warn(`[TechProfiles] Failed to detect Node platform: ${err.message}`); }
  return 'Node.js';
}

function _detectJsStateManagement(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'Module-level state';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['zustand'])                              return 'Zustand';
    if (deps['redux'] || deps['@reduxjs/toolkit'])    return 'Redux Toolkit';
    if (deps['mobx'])                                 return 'MobX';
    if (deps['jotai'])                                return 'Jotai';
    if (deps['recoil'])                               return 'Recoil';
    if (deps['pinia'])                                return 'Pinia (Vue)';
    if (deps['vuex'])                                 return 'Vuex';
    if (deps['react'])                                return 'React useState / useContext';
  } catch (err) { console.warn(`[TechProfiles] Failed to detect JS state management: ${err.message}`); }
  return 'Module-level state';
}

/**
 * Counts files with a given extension in specific subdirs (shallow check, fast).
 */
function _countFilesWithExt(root, ext, subdirs) {
  let count = 0;
  for (const sub of subdirs) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      count += entries.filter(e => e.endsWith(ext)).length;
    } catch (err) { console.warn(`[TechProfiles] Failed to count files in ${sub}: ${err.message}`); }
  }
  return count;
}

/**
 * Generates a compact directory tree (depth ≤ 2) for the project root.
 */
function _generateDirectoryTree(root, ignoreDirs) {
  const ignore = new Set([...(ignoreDirs || []), 'node_modules', '.git', '.dart_tool',
    'Library', 'Temp', 'obj', 'Packages', '.vs', 'build', 'dist', 'output',
    '__pycache__', '.venv', 'venv', 'target', 'bin']);

  const lines = [`${path.basename(root)}/`];

  function walk(dir, prefix, depth) {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }

    const dirs  = entries.filter(e => e.isDirectory() && !ignore.has(e.name) && !e.name.startsWith('.'));
    const files = entries.filter(e => !e.isDirectory() && !e.name.startsWith('.'));
    const all   = [...dirs, ...files].slice(0, 20);

    all.forEach((e, i) => {
      const isLast    = i === all.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPfx  = isLast ? '    ' : '│   ';
      const label     = e.isDirectory() ? `${e.name}/` : e.name;
      lines.push(`${prefix}${connector}${label}`);
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + childPfx, depth + 1);
    });

    if (entries.length > 20) lines.push(`${prefix}    ... (${entries.length - 20} more)`);
  }

  walk(root, '', 1);
  return lines.join('\n');
}

// ─── Tech Stack Profiles ──────────────────────────────────────────────────────

const TECH_PROFILES = [
  {
    id: 'flutter',
    name: 'Flutter / Dart',
    techStack: 'Flutter + Dart',
    detect: (root) => fs.existsSync(path.join(root, 'pubspec.yaml')) && _countFilesWithExt(root, '.dart', ['lib', 'test']) > 0,
    extensions: ['.dart'],
    ignoreDirs: ['node_modules', '.git', '.dart_tool', 'build', '.flutter-plugins', 'output'],
    testCommand: 'flutter test',
    platforms: (root) => _detectFlutterPlatforms(root),
    namingConvention: 'PascalCase for classes/widgets, camelCase for functions/variables, snake_case for files',
    stateManagement: (root) => _detectFlutterStateManagement(root),
    // CLI command to scaffold a standard Flutter project structure
    // Delegates to the official Flutter CLI — always up-to-date, zero maintenance
    cliInitCommand: (projectRoot, projectName) => `flutter create --project-name ${projectName} "${projectRoot}"`,

    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'flutter-dev',            description: 'Flutter/Dart development patterns', domains: ['flutter', 'dart', 'mobile'] },
    ],
    defaultSkills: { '.dart': 'flutter-dev' },
  },
  {
    id: 'unity-csharp-lua',
    name: 'Unity + C# + Lua',
    techStack: 'Unity + GameFramework + Lua',
    detect: (root) => {
      const hasAssets   = fs.existsSync(path.join(root, 'Assets'));
      const hasPackages = fs.existsSync(path.join(root, 'Packages'));
      const hasLua      = _countFilesWithExt(root, '.lua', ['Assets', 'Scripts', 'Lua']) > 0;
      return hasAssets && hasPackages && hasLua;
    },
    extensions: ['.cs', '.lua'],
    ignoreDirs: ['node_modules', '.git', 'Library', 'Temp', 'obj', 'Packages', '.vs', 'output'],
    testCommand: null,
    platforms: () => 'PC, Mobile (Unity Editor)',
    namingConvention: 'PascalCase for C# classes/methods, camelCase for Lua functions, UPPER_SNAKE_CASE for constants',
    stateManagement: () => 'Unity GameFramework FSM (Procedure/State pattern)',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'unity-csharp',           description: 'Unity C# development patterns and pitfalls', domains: ['unity', 'csharp', 'game'] },
      { name: 'lua-scripting',          description: 'Lua scripting patterns for game engines', domains: ['lua', 'game', 'scripting'] },
    ],
    defaultSkills: { '.cs': 'unity-csharp', '.lua': 'lua-scripting' },
  },
  {
    id: 'unity-csharp',
    name: 'Unity + C#',
    techStack: 'Unity + C#',
    detect: (root) => fs.existsSync(path.join(root, 'Assets')) && fs.existsSync(path.join(root, 'Packages')),
    extensions: ['.cs'],
    ignoreDirs: ['node_modules', '.git', 'Library', 'Temp', 'obj', 'Packages', '.vs', 'output'],
    testCommand: null,
    platforms: () => 'PC, Mobile (Unity Editor)',
    namingConvention: 'PascalCase for classes/methods, camelCase for fields/variables',
    stateManagement: () => 'Unity MonoBehaviour / GameFramework FSM',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'unity-csharp',           description: 'Unity C# development patterns and pitfalls', domains: ['unity', 'csharp', 'game'] },
    ],
    defaultSkills: { '.cs': 'unity-csharp' },
  },
  {
    id: 'go',
    name: 'Go',
    techStack: 'Go',
    detect: (root) => fs.existsSync(path.join(root, 'go.mod')) || _countFilesWithExt(root, '.go', ['.']) > 0,
    extensions: ['.go'],
    ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'vendor'],
    testCommand: 'go test ./...',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && go mod init ${projectName}`,
    platforms: () => 'Server / CLI',
    namingConvention: 'PascalCase for exported, camelCase for unexported, snake_case for files',
    stateManagement: () => 'Stateless services; use context.Context for request-scoped state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'go-dev',                 description: 'Go language development patterns', domains: ['backend', 'go'] },
    ],
    defaultSkills: { '.go': 'go-dev' },
  },
  {
    id: 'typescript',
    name: 'TypeScript / Node.js',
    techStack: 'TypeScript + Node.js',
    detect: (root) => fs.existsSync(path.join(root, 'tsconfig.json')),
    extensions: ['.ts', '.tsx'],
    ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],
    testCommand: 'npm test',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && npm init -y && npx tsc --init`,
    platforms: (root) => _detectNodePlatform(root),
    namingConvention: 'PascalCase for classes/interfaces, camelCase for functions/variables, kebab-case for files',
    stateManagement: (root) => _detectJsStateManagement(root),
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'typescript-dev',         description: 'TypeScript development patterns', domains: ['frontend', 'backend', 'typescript'] },
    ],
    defaultSkills: { '.ts': 'typescript-dev', '.tsx': 'typescript-dev' },
  },
  {
    id: 'javascript',
    name: 'JavaScript / Node.js',
    techStack: 'JavaScript + Node.js',
    detect: (root) => fs.existsSync(path.join(root, 'package.json')),
    extensions: ['.js', '.mjs'],
    ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],
    testCommand: 'npm test',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && npm init -y`,
    platforms: (root) => _detectNodePlatform(root),
    namingConvention: 'camelCase for functions/variables, PascalCase for classes, kebab-case for files',
    stateManagement: (root) => _detectJsStateManagement(root),
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'javascript-dev',         description: 'JavaScript development patterns', domains: ['frontend', 'backend', 'javascript'] },
    ],
    defaultSkills: { '.js': 'javascript-dev' },
  },
  {
    id: 'python',
    name: 'Python',
    techStack: 'Python',
    detect: (root) => fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'setup.py')) || fs.existsSync(path.join(root, 'pyproject.toml')),
    extensions: ['.py'],
    ignoreDirs: ['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build'],
    testCommand: 'pytest',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && python -m venv .venv && echo "# ${projectName}" > requirements.txt`,
    platforms: () => 'Server / CLI',
    namingConvention: 'snake_case for functions/variables/files, PascalCase for classes, UPPER_SNAKE_CASE for constants',
    stateManagement: () => 'Stateless functions preferred; use dataclasses/Pydantic for structured state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'python-dev',             description: 'Python development patterns', domains: ['backend', 'python'] },
    ],
    defaultSkills: { '.py': 'python-dev' },
  },
  {
    id: 'java',
    name: 'Java',
    techStack: 'Java',
    detect: (root) => fs.existsSync(path.join(root, 'pom.xml')) || fs.existsSync(path.join(root, 'build.gradle')),
    extensions: ['.java'],
    ignoreDirs: ['node_modules', '.git', 'target', 'build', '.gradle'],
    testCommand: fs.existsSync('pom.xml') ? 'mvn test' : 'gradle test',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && mvn archetype:generate -DgroupId=com.${projectName} -DartifactId=${projectName} -DarchetypeArtifactId=maven-archetype-quickstart -DinteractiveMode=false`,
    platforms: () => 'Server / JVM',
    namingConvention: 'PascalCase for classes, camelCase for methods/variables, UPPER_SNAKE_CASE for constants',
    stateManagement: () => 'Spring beans (singleton); use immutable DTOs for data transfer',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'java-dev',               description: 'Java development patterns', domains: ['backend', 'java'] },
    ],
    defaultSkills: { '.java': 'java-dev' },
  },
  {
    id: 'rust',
    name: 'Rust',
    techStack: 'Rust',
    detect: (root) => fs.existsSync(path.join(root, 'Cargo.toml')),
    extensions: ['.rs'],
    ignoreDirs: ['node_modules', '.git', 'target'],
    testCommand: 'cargo test',
    cliInitCommand: (projectRoot, projectName) => `cargo init "${projectRoot}" --name ${projectName}`,
    platforms: () => 'Server / CLI / Systems',
    namingConvention: 'snake_case for functions/variables/files, PascalCase for types/traits, SCREAMING_SNAKE_CASE for constants',
    stateManagement: () => 'Ownership model; use Arc<Mutex<T>> for shared mutable state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'rust-dev',               description: 'Rust development patterns', domains: ['systems', 'rust'] },
    ],
    defaultSkills: { '.rs': 'rust-dev' },
  },
  {
    id: 'dotnet',
    name: '.NET / C#',
    techStack: '.NET + C#',
    detect: (root) => _countFilesWithExt(root, '.csproj', ['.', 'src']) > 0 || _countFilesWithExt(root, '.sln', ['.']) > 0,
    extensions: ['.cs'],
    ignoreDirs: ['node_modules', '.git', 'bin', 'obj', '.vs'],
    testCommand: 'dotnet test',
    cliInitCommand: (projectRoot, projectName) => `dotnet new console -o "${projectRoot}" --name ${projectName}`,
    platforms: () => 'Server / Desktop / Web',
    namingConvention: 'PascalCase for classes/methods/properties, camelCase for local variables, _camelCase for private fields',
    stateManagement: () => 'Dependency injection (IServiceCollection); use immutable records for DTOs',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'dotnet-dev',             description: '.NET/C# development patterns', domains: ['backend', 'dotnet', 'csharp'] },
    ],
    defaultSkills: { '.cs': 'dotnet-dev' },
  },
  {
    id: 'kotlin',
    name: 'Kotlin',
    techStack: 'Kotlin + JVM',
    detect: (root) => {
      const hasKts = fs.existsSync(path.join(root, 'build.gradle.kts'));
      const hasKt  = _countFilesWithExt(root, '.kt', ['.', 'src', 'src/main/kotlin']) > 0;
      return hasKts && hasKt;
    },
    extensions: ['.kt', '.kts'],
    ignoreDirs: ['node_modules', '.git', 'build', '.gradle', '.idea', 'target'],
    testCommand: 'gradle test',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && gradle init --type kotlin-application --project-name ${projectName}`,
    platforms: () => 'Server / Android / JVM',
    namingConvention: 'PascalCase for classes, camelCase for functions/properties, UPPER_SNAKE_CASE for constants',
    stateManagement: () => 'Kotlin coroutines + StateFlow; use data classes for immutable state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'kotlin-dev',             description: 'Kotlin development patterns (Ktor, Compose, Spring)', domains: ['backend', 'kotlin', 'android'] },
    ],
    defaultSkills: { '.kt': 'kotlin-dev', '.kts': 'kotlin-dev' },
  },
  {
    id: 'php',
    name: 'PHP',
    techStack: 'PHP',
    detect: (root) => fs.existsSync(path.join(root, 'composer.json')) || _countFilesWithExt(root, '.php', ['.', 'src', 'app', 'public']) > 0,
    extensions: ['.php'],
    ignoreDirs: ['node_modules', '.git', 'vendor', 'storage', 'bootstrap/cache'],
    testCommand: 'vendor/bin/phpunit',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && composer init --name="${projectName}/${projectName}" --no-interaction`,
    platforms: () => 'Web Server',
    namingConvention: 'PascalCase for classes, camelCase for methods/variables, snake_case for functions (legacy), PSR-12 standard',
    stateManagement: () => 'Request-scoped (stateless); use session/cache for persistence',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'php-dev',                description: 'PHP development patterns (Laravel, Symfony)', domains: ['backend', 'php', 'web'] },
    ],
    defaultSkills: { '.php': 'php-dev' },
  },
  {
    id: 'ruby',
    name: 'Ruby',
    techStack: 'Ruby',
    detect: (root) => fs.existsSync(path.join(root, 'Gemfile')) || fs.existsSync(path.join(root, 'config.ru')),
    extensions: ['.rb', '.erb'],
    ignoreDirs: ['node_modules', '.git', 'vendor', 'tmp', 'log', '.bundle'],
    testCommand: 'bundle exec rspec',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && rails new ${projectName} --skip-bundle`,
    platforms: () => 'Web Server / CLI',
    namingConvention: 'snake_case for methods/variables/files, PascalCase for classes/modules, SCREAMING_SNAKE_CASE for constants',
    stateManagement: () => 'Request-scoped (stateless); use ActiveRecord for persistence',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'ruby-dev',               description: 'Ruby development patterns (Rails, Sinatra)', domains: ['backend', 'ruby', 'web'] },
    ],
    defaultSkills: { '.rb': 'ruby-dev' },
  },
  {
    id: 'swift',
    name: 'Swift',
    techStack: 'Swift',
    detect: (root) => fs.existsSync(path.join(root, 'Package.swift')) || _countFilesWithExt(root, '.swift', ['.', 'Sources', 'src']) > 0,
    extensions: ['.swift'],
    ignoreDirs: ['node_modules', '.git', '.build', '.swiftpm', 'DerivedData'],
    testCommand: 'swift test',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && swift package init --name ${projectName}`,
    platforms: () => 'iOS / macOS / Server',
    namingConvention: 'PascalCase for types/protocols, camelCase for functions/properties, UPPER_SNAKE_CASE for static constants',
    stateManagement: () => 'SwiftUI @State/@ObservedObject; Combine for reactive streams',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'swift-dev',              description: 'Swift development patterns (SwiftUI, Vapor, UIKit)', domains: ['ios', 'macos', 'swift'] },
    ],
    defaultSkills: { '.swift': 'swift-dev' },
  },
  {
    id: 'cpp',
    name: 'C / C++',
    techStack: 'C/C++',
    detect: (root) => fs.existsSync(path.join(root, 'CMakeLists.txt')) || fs.existsSync(path.join(root, 'Makefile')) || _countFilesWithExt(root, '.cpp', ['.', 'src']) > 0,
    extensions: ['.cpp', '.c', '.h', '.hpp'],
    ignoreDirs: ['node_modules', '.git', 'build', 'cmake-build-debug', 'cmake-build-release', '.cache'],
    testCommand: 'cmake --build build --target test',
    cliInitCommand: (projectRoot, projectName) => `mkdir -p "${projectRoot}/src" && echo 'cmake_minimum_required(VERSION 3.15)\\nproject(${projectName} CXX)\\nadd_executable(${projectName} src/main.cpp)' > "${projectRoot}/CMakeLists.txt"`,
    platforms: () => 'Systems / Desktop / Embedded',
    namingConvention: 'PascalCase for classes, camelCase or snake_case for functions/variables (project-dependent), UPPER_SNAKE_CASE for macros',
    stateManagement: () => 'RAII + smart pointers (unique_ptr/shared_ptr); avoid raw pointers',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'cpp-dev',                description: 'C/C++ development patterns (CMake, Qt, systems)', domains: ['systems', 'cpp', 'desktop'] },
    ],
    defaultSkills: { '.cpp': 'cpp-dev', '.c': 'cpp-dev', '.h': 'cpp-dev', '.hpp': 'cpp-dev' },
  },
  {
    id: 'scala',
    name: 'Scala',
    techStack: 'Scala + JVM',
    detect: (root) => fs.existsSync(path.join(root, 'build.sbt')) || _countFilesWithExt(root, '.scala', ['.', 'src', 'src/main/scala']) > 0,
    extensions: ['.scala', '.sc'],
    ignoreDirs: ['node_modules', '.git', 'target', 'project/target', '.bsp', '.metals'],
    testCommand: 'sbt test',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && sbt new scala/scala-seed.g8 --name=${projectName}`,
    platforms: () => 'Server / Data / JVM',
    namingConvention: 'PascalCase for classes/objects/traits, camelCase for methods/values, UPPER_SNAKE_CASE for constants',
    stateManagement: () => 'Immutable vals preferred; Akka actors or ZIO for concurrent state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'scala-dev',              description: 'Scala development patterns (Akka, Play, Spark)', domains: ['backend', 'data', 'scala'] },
    ],
    defaultSkills: { '.scala': 'scala-dev' },
  },
  {
    id: 'elixir',
    name: 'Elixir',
    techStack: 'Elixir + OTP',
    detect: (root) => fs.existsSync(path.join(root, 'mix.exs')),
    extensions: ['.ex', '.exs'],
    ignoreDirs: ['node_modules', '.git', '_build', 'deps', '.elixir_ls'],
    testCommand: 'mix test',
    cliInitCommand: (projectRoot, projectName) => `cd "${projectRoot}" && mix new ${projectName}`,
    platforms: () => 'Server / Real-time',
    namingConvention: 'snake_case for functions/variables/files, PascalCase for modules, SCREAMING_SNAKE_CASE for module attributes',
    stateManagement: () => 'GenServer / Agent for stateful processes; ETS for shared in-memory state',
    skills: [
      { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
      { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
      { name: 'elixir-dev',             description: 'Elixir development patterns (Phoenix, LiveView, Ecto)', domains: ['backend', 'elixir', 'realtime'] },
    ],
    defaultSkills: { '.ex': 'elixir-dev', '.exs': 'elixir-dev' },
  },
];

/**
 * Auto-detects the project tech stack by scanning characteristic files/dirs.
 * @param {string} projectRoot
 * @returns {{ profile: object, projectName: string }}
 */
function detectTechStack(projectRoot) {
  const projectName = path.basename(projectRoot);

  for (const profile of TECH_PROFILES) {
    try {
      if (profile.detect(projectRoot)) {
        return { profile, projectName };
      }
    } catch (err) { console.warn(`[TechProfiles] Detection failed for ${profile.id}: ${err.message}`); }
  }

  // Fallback: count file extensions to pick the most common one
  const extCounts = {};
  const knownExts = ['.cs', '.lua', '.go', '.ts', '.js', '.py', '.java', '.cpp', '.rs', '.kt', '.php', '.rb', '.swift', '.c', '.scala', '.ex'];
  const ignoreFallback = ['node_modules', '.git', 'Library', 'Temp', 'Packages'];

  function walkCount(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (ignoreFallback.includes(e.name) || e.name.startsWith('.')) continue;
      if (e.isDirectory()) { walkCount(path.join(dir, e.name), depth + 1); }
      else {
        const ext = path.extname(e.name).toLowerCase();
        if (knownExts.includes(ext)) extCounts[ext] = (extCounts[ext] || 0) + 1;
      }
    }
  }
  walkCount(projectRoot, 0);

  const topExt = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0];
  if (topExt) {
    return {
      profile: {
        id: 'generic',
        name: `Generic (${topExt[0]})`,
        techStack: topExt[0].replace('.', '').toUpperCase(),
        extensions: [topExt[0]],
        ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output'],
        skills: [
          { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow'] },
          { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality'] },
        ],
        defaultSkills: {},
      },
      projectName,
    };
  }

  return { profile: null, projectName };
}

module.exports = {
  TECH_PROFILES,
  detectTechStack,
  _generateDirectoryTree,
  _countFilesWithExt,
  _detectFlutterPlatforms,
  _detectFlutterStateManagement,
  _detectNodePlatform,
  _detectJsStateManagement,
};
