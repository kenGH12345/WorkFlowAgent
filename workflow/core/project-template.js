'use strict';

const fs   = require('fs');
const path = require('path');
const { TECH_PROFILES, _generateDirectoryTree } = require('./tech-profiles');

// ─── User Journey Inference ───────────────────────────────────────────────────

function _findScreenFiles(root, exts, subdirs) {
  const results = [];
  const screenPatterns = [/screen/i, /page/i, /view/i, /scene/i];

  for (const sub of subdirs) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    try {
      function walk(d) {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
          const ext = path.extname(e.name);
          if (!exts.includes(ext)) continue;
          if (screenPatterns.some(p => p.test(e.name))) {
            const label = e.name.replace(ext, '')
              .split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
            results.push(label);
          }
        }
      }
      walk(dir);
    } catch (err) { console.warn(`[ProjectTemplate] Failed to scan directory ${dir}: ${err.message}`); }
  }
  return results.slice(0, 5);
}

function _inferUserJourneys(projectRoot, profile, projectName) {
  const journeys = [];

  if (!profile) {
    return [
      { name: 'Core User Journey', steps: ['User opens the application', 'User performs the main action', 'User sees the expected result'] },
    ];
  }

  if (profile.id === 'flutter') {
    const screens = _findScreenFiles(projectRoot, ['.dart'], ['lib']);
    if (screens.length > 0) {
      journeys.push({
        name: 'App Launch',
        steps: ['Run the app on target device/emulator', 'Verify splash/loading screen appears', 'Verify main screen loads without errors', 'Check no exceptions in console'],
      });
      if (screens.length > 1) {
        journeys.push({
          name: `Navigate to ${screens[1]}`,
          steps: [`From main screen, navigate to ${screens[1]}`, 'Verify screen renders correctly', 'Verify all interactive elements respond', 'Navigate back and confirm no state leak'],
        });
      }
    } else {
      journeys.push({ name: 'App Launch', steps: ['Run flutter run', 'Verify app starts without errors', 'Verify main screen renders'] });
    }
  } else if (profile.id.startsWith('unity')) {
    journeys.push(
      { name: 'Game Launch', steps: ['Open project in Unity Editor', 'Press Play in the Editor', 'Verify no compile errors', 'Verify main scene loads'] },
      { name: 'Core Gameplay Loop', steps: ['Start a game session', 'Perform the primary game action', 'Verify game state updates correctly', 'End session and verify cleanup'] },
    );
  } else if (profile.id === 'go' || profile.id === 'python' || profile.id === 'java' || profile.id === 'dotnet') {
    journeys.push(
      { name: 'Service Startup', steps: ['Run the service', 'Verify it starts without errors', 'Check health endpoint responds 200', 'Verify logs show no errors'] },
      { name: 'Core API Flow', steps: ['Send a valid request to the primary endpoint', 'Verify response status 200', 'Verify response body matches expected schema', 'Verify no errors in service logs'] },
    );
  } else if (profile.id === 'typescript' || profile.id === 'javascript') {
    journeys.push(
      { name: 'Application Start', steps: ['Run npm start / npm run dev', 'Verify no startup errors', 'Verify main entry point is accessible'] },
      { name: 'Core Feature Flow', steps: ['Trigger the primary feature', 'Verify expected output/response', 'Verify no errors in console'] },
    );
  } else {
    journeys.push(
      { name: 'Application Start', steps: ['Start the application', 'Verify it runs without errors', 'Verify main functionality is accessible'] },
      { name: 'Core Feature', steps: ['Trigger the primary feature', 'Verify expected output', 'Verify no errors'] },
    );
  }

  return journeys;
}

function _injectUserJourneys(content, journeys) {
  if (!journeys || journeys.length === 0) return content;

  let result = content;
  const journeyBlocks = journeys.map((j, idx) => {
    const steps = j.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return `### Journey ${idx + 1}: ${j.name}\n${steps}`;
  }).join('\n\n');

  const journeyPattern = new RegExp('### Journey 1: \\{JOURNEY_NAME\\}[\\s\\S]*?(?=\\n---|\\n## ADR|$)');
  result = result.replace(journeyPattern, journeyBlocks + '\n');
  result = result
    .replace(/\{JOURNEY_NAME\}/g, journeys[0]?.name || 'Core User Journey')
    .replace(/\{STEP_1\}/g, journeys[0]?.steps[0] || 'User opens the application')
    .replace(/\{STEP_2\}/g, journeys[0]?.steps[1] || 'User performs the main action')
    .replace(/\{STEP_3\}/g, journeys[0]?.steps[2] || 'User sees the expected result');

  return result;
}

// ─── Project Template Copy ────────────────────────────────────────────────────

/**
 * Copies project-init-template/ files into the target project root.
 * @param {string} projectRoot
 * @param {object} config
 */
function _copyProjectTemplates(projectRoot, config) {
  const templateDir = path.join(__dirname, '..', 'project-init-template');
  if (!fs.existsSync(templateDir)) {
    console.log(`      ⏭️  project-init-template/ not found, skipping\n`);
    return;
  }

  const projectName = config.projectName || path.basename(projectRoot);
  const techStack   = config.techStack   || 'Unknown';
  const today       = new Date().toISOString().slice(0, 10);

  const profile = TECH_PROFILES.find(p => p.techStack === techStack);

  let platforms = 'TBD';
  if (profile && profile.platforms) {
    platforms = typeof profile.platforms === 'function' ? profile.platforms(projectRoot) : profile.platforms;
  }

  const namingConvention = profile ? profile.namingConvention || 'Follow language conventions' : 'Follow language conventions';

  let stateManagement = 'TBD';
  if (profile && profile.stateManagement) {
    stateManagement = typeof profile.stateManagement === 'function' ? profile.stateManagement(projectRoot) : profile.stateManagement;
  }

  const effectiveTree = _generateDirectoryTree(projectRoot, config.ignoreDirs);

  const maxLinesMap = {
    'flutter': '800', 'dart': '800',
    'unity': '600', 'c#': '600', 'csharp': '600',
    'lua': '400', 'go': '500',
    'typescript': '600', 'javascript': '600',
    'python': '500', 'java': '700',
  };
  const stackLower = techStack.toLowerCase();
  const maxLines = Object.entries(maxLinesMap).find(([k]) => stackLower.includes(k))?.[1] || '600';

  const journeys = _inferUserJourneys(projectRoot, profile, projectName);

  function fillTemplate(content) {
    let result = content
      .replace(/\{PROJECT_NAME\}/g, projectName)
      .replace(/\{ONE_LINE_DESCRIPTION\}/g, `${projectName} – ${techStack} project`)
      .replace(/\{TECH_STACK\}/g, techStack)
      .replace(/\{PLATFORMS\}/g, platforms)
      .replace(/\{DATE\}/g, today)
      .replace(/\{MAX_LINES\}/g, maxLines)
      .replace(/\{LANGUAGE_SPECIFIC_LIMIT\}/g, `No single file > ${maxLines} lines`)
      .replace(/\{NAMING_CONVENTION\}/g, namingConvention)
      .replace(/\{NAMING_RULE\}/g, namingConvention)
      .replace(/\{STATE_MANAGEMENT_APPROACH\}/g, stateManagement)
      .replace(/\{STATE_MANAGEMENT_RULE\}/g, stateManagement)
      .replace(/\{PASTE_YOUR_DIRECTORY_TREE_HERE\}/g, effectiveTree)
      .replace(/\{BRIEF_DESCRIPTION\}/g, `${techStack} project`)
      .replace(/\{FIRST_DECISION_TITLE\}/g, `Adopt ${techStack} as primary tech stack`)
      .replace(/\{WHY_THIS_DECISION_WAS_NEEDED\}/g, `Project was initialized with the /wf workflow. Tech stack auto-detected as ${techStack}.`)
      .replace(/\{WHAT_WAS_DECIDED\}/g, `Use ${techStack} as the primary tech stack. State management: ${stateManagement}.`)
      .replace(/\{POSITIVE_CONSEQUENCE\}/g, 'Workflow is ready to use. All project-specific config auto-generated.')
      .replace(/\{TRADEOFF_IF_ANY\}/g, 'Review auto-generated values and update if needed.');

    result = _injectUserJourneys(result, journeys);
    return result;
  }

  const filesToCopy = [
    ['AGENTS.md',            'AGENTS.md'],
    ['docs/architecture.md', 'docs/architecture.md'],
    ['init-checklist.md',    'docs/init-checklist.md'],
  ];

  // P2: Generate code scaffolds document based on Tech Profile
  _generateCodeScaffolds(projectRoot, profile, techStack, config);

  let copied = 0;
  let skipped = 0;

  for (const [srcRel, destRel] of filesToCopy) {
    const srcPath  = path.join(templateDir, srcRel);
    const destPath = path.join(projectRoot, destRel);

    if (!fs.existsSync(srcPath)) {
      console.log(`      ⚠️  Template not found: ${srcRel}`);
      continue;
    }

    if (fs.existsSync(destPath)) {
      console.log(`      ⏭️  Already exists, skipping: ${destRel}`);
      skipped++;
      continue;
    }

    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const templateContent = fs.readFileSync(srcPath, 'utf-8');
    const filledContent   = fillTemplate(templateContent);
    fs.writeFileSync(destPath, filledContent, 'utf-8');
    console.log(`      ✅ Created: ${destRel}`);
    copied++;
  }

  if (copied > 0)  console.log(`      📝 ${copied} file(s) created. Edit them to fill in project-specific details.`);
  if (skipped > 0) console.log(`      ℹ️  ${skipped} file(s) already existed, not overwritten.`);
  console.log('');
}

// ─── P2: Code Scaffolds Generator ─────────────────────────────────────────────

/**
 * Scaffold patterns per tech stack family.
 * Each entry provides common code patterns that developers frequently need.
 * NOTE: These are generic, language-idiomatic patterns — NOT project-specific.
 */
const SCAFFOLD_PATTERNS = {
  flutter: {
    label: 'Flutter / Dart',
    patterns: [
      { name: 'StatelessWidget',   desc: 'A minimal stateless widget template',  code: 'class {Name}Widget extends StatelessWidget {\n  const {Name}Widget({super.key});\n\n  @override\n  Widget build(BuildContext context) {\n    return Container();\n  }\n}' },
      { name: 'StatefulWidget',    desc: 'A stateful widget with lifecycle',     code: 'class {Name}Widget extends StatefulWidget {\n  const {Name}Widget({super.key});\n\n  @override\n  State<{Name}Widget> createState() => _{Name}WidgetState();\n}\n\nclass _{Name}WidgetState extends State<{Name}Widget> {\n  @override\n  Widget build(BuildContext context) {\n    return Container();\n  }\n}' },
      { name: 'Repository Pattern', desc: 'Data repository abstraction',          code: 'abstract class {Name}Repository {\n  Future<List<{Name}>> getAll();\n  Future<{Name}?> getById(String id);\n  Future<void> create({Name} item);\n  Future<void> update({Name} item);\n  Future<void> delete(String id);\n}' },
    ],
  },
  go: {
    label: 'Go',
    patterns: [
      { name: 'HTTP Handler',      desc: 'Standard net/http handler function',   code: 'func {name}Handler(w http.ResponseWriter, r *http.Request) {\n\tctx := r.Context()\n\t// TODO: implement\n\tw.WriteHeader(http.StatusOK)\n}' },
      { name: 'Interface + Impl',  desc: 'Interface with constructor',            code: 'type {Name} interface {\n\tDo(ctx context.Context) error\n}\n\ntype {name}Impl struct{}\n\nfunc New{Name}() {Name} {\n\treturn &{name}Impl{}\n}\n\nfunc (s *{name}Impl) Do(ctx context.Context) error {\n\treturn nil\n}' },
      { name: 'Error Handling',    desc: 'Custom error type with wrapping',      code: 'type {Name}Error struct {\n\tOp  string\n\tErr error\n}\n\nfunc (e *{Name}Error) Error() string {\n\treturn fmt.Sprintf("%s: %v", e.Op, e.Err)\n}\n\nfunc (e *{Name}Error) Unwrap() error { return e.Err }' },
    ],
  },
  node: {
    label: 'JavaScript / TypeScript',
    patterns: [
      { name: 'Express Router',    desc: 'Express.js router module',             code: 'const express = require(\'express\');\nconst router = express.Router();\n\nrouter.get(\'/{name}\', async (req, res) => {\n  try {\n    // TODO: implement\n    res.json({ ok: true });\n  } catch (err) {\n    res.status(500).json({ error: err.message });\n  }\n});\n\nmodule.exports = router;' },
      { name: 'Service Class',     desc: 'Service layer abstraction',            code: 'class {Name}Service {\n  constructor(deps) {\n    this.repo = deps.repo;\n  }\n\n  async getAll() {\n    return this.repo.findAll();\n  }\n\n  async getById(id) {\n    const item = await this.repo.findById(id);\n    if (!item) throw new Error(`{Name} not found: ${id}`);\n    return item;\n  }\n}\n\nmodule.exports = { {Name}Service };' },
    ],
  },
  python: {
    label: 'Python',
    patterns: [
      { name: 'FastAPI Router',    desc: 'FastAPI router with CRUD endpoints',   code: 'from fastapi import APIRouter, HTTPException\n\nrouter = APIRouter(prefix="/{name}", tags=["{name}"])\n\n@router.get("/")\nasync def list_{name}s():\n    """List all {name}s."""\n    return []\n\n@router.get("/{id}")\nasync def get_{name}(id: str):\n    """Get a {name} by ID."""\n    raise HTTPException(status_code=404, detail="Not found")' },
      { name: 'Dataclass Model',   desc: 'Pydantic / dataclass model',           code: 'from dataclasses import dataclass, field\nfrom datetime import datetime\n\n@dataclass\nclass {Name}:\n    id: str\n    name: str\n    created_at: datetime = field(default_factory=datetime.utcnow)\n    metadata: dict = field(default_factory=dict)' },
    ],
  },
  java: {
    label: 'Java',
    patterns: [
      { name: 'Spring Controller',  desc: 'REST controller with basic CRUD',     code: '@RestController\n@RequestMapping("/api/{name}")\npublic class {Name}Controller {\n    private final {Name}Service service;\n\n    public {Name}Controller({Name}Service service) {\n        this.service = service;\n    }\n\n    @GetMapping\n    public List<{Name}> list() {\n        return service.findAll();\n    }\n}' },
      { name: 'Service Layer',      desc: 'Spring service with constructor DI',  code: '@Service\npublic class {Name}Service {\n    private final {Name}Repository repository;\n\n    public {Name}Service({Name}Repository repository) {\n        this.repository = repository;\n    }\n\n    public List<{Name}> findAll() {\n        return repository.findAll();\n    }\n}' },
    ],
  },
  unity: {
    label: 'Unity / C#',
    patterns: [
      { name: 'MonoBehaviour',     desc: 'Standard MonoBehaviour component',     code: 'public class {Name} : MonoBehaviour\n{\n    void Start()\n    {\n        // Initialization\n    }\n\n    void Update()\n    {\n        // Per-frame logic\n    }\n}' },
      { name: 'Singleton Manager',  desc: 'Thread-safe singleton pattern',       code: 'public class {Name}Manager : MonoBehaviour\n{\n    public static {Name}Manager Instance { get; private set; }\n\n    void Awake()\n    {\n        if (Instance != null && Instance != this) { Destroy(gameObject); return; }\n        Instance = this;\n        DontDestroyOnLoad(gameObject);\n    }\n}' },
    ],
  },
};

/**
 * Generates a docs/code-scaffolds.md file with common code patterns
 * based on the detected tech stack.
 *
 * @param {string} projectRoot
 * @param {object|null} profile - Tech profile
 * @param {string} techStack
 * @param {object} config
 */
function _generateCodeScaffolds(projectRoot, profile, techStack, config) {
  const destPath = path.join(projectRoot, 'docs', 'code-scaffolds.md');
  if (fs.existsSync(destPath)) {
    console.log(`      \u23ED\uFE0F  code-scaffolds.md already exists, skipping`);
    return;
  }

  // Find matching scaffold family
  const stackLower = techStack.toLowerCase();
  let scaffold = null;
  for (const [key, val] of Object.entries(SCAFFOLD_PATTERNS)) {
    if (stackLower.includes(key)) {
      scaffold = val;
      break;
    }
  }

  if (!scaffold) {
    console.log(`      \u23ED\uFE0F  No scaffold patterns for ${techStack}, skipping code-scaffolds.md`);
    return;
  }

  const lines = [
    `# Code Scaffolds – ${scaffold.label}`,
    ``,
    `> Auto-generated by \`/wf init\`. Common code patterns for ${scaffold.label} projects.`,
    `> Use these as starting points when creating new files. Replace \`{Name}\` / \`{name}\` with your actual names.`,
    ``,
    `---`,
    ``,
  ];

  for (const pattern of scaffold.patterns) {
    lines.push(`## ${pattern.name}`);
    lines.push(``);
    lines.push(`${pattern.desc}`);
    lines.push(``);
    lines.push('```');
    lines.push(pattern.code);
    lines.push('```');
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.writeFileSync(destPath, lines.join('\n'), 'utf-8');
  console.log(`      \u2705 Created: docs/code-scaffolds.md (${scaffold.patterns.length} patterns for ${scaffold.label})`);
}

module.exports = { _copyProjectTemplates, _inferUserJourneys, _findScreenFiles, _injectUserJourneys, _generateCodeScaffolds };
