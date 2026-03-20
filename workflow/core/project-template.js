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

module.exports = { _copyProjectTemplates, _inferUserJourneys, _findScreenFiles, _injectUserJourneys };
