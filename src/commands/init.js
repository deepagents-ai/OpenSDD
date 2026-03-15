import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import { installSkills } from '../lib/skills.js';

const PROJECT_MARKERS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  '.git',
  'opensdd.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Makefile',
  'CMakeLists.txt',
  'composer.json',
  'Gemfile',
  'setup.py',
  'setup.cfg',
  'mix.exs',
  'deno.json',
  'bun.lockb',
];

function hasProjectMarker(dir) {
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

function findGitRoot(dir) {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return root;
  } catch {
    return null;
  }
}

function getProjectName(dir) {
  // Try package.json
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name) return pkg.name;
    } catch {
      // ignore
    }
  }
  // Try pyproject.toml
  const pyprojectPath = path.join(dir, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf-8');
      const match = content.match(/name\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {
      // ignore
    }
  }
  // Try Cargo.toml
  const cargoPath = path.join(dir, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const content = fs.readFileSync(cargoPath, 'utf-8');
      const match = content.match(/name\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {
      // ignore
    }
  }
  // Default to directory name
  return path.basename(dir);
}

function promptYN(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

function promptChoice(question, choices) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const lines = choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    rl.question(`${question}\n${lines}\nChoice: `, (answer) => {
      rl.close();
      const idx = parseInt(answer, 10);
      resolve(idx >= 1 && idx <= choices.length ? idx : null);
    });
  });
}

export async function initCommand() {
  const cwd = process.cwd();

  // Step 1: Check for project markers
  if (!hasProjectMarker(cwd)) {
    const proceed = await promptYN(
      'Warning: No project markers found in the current directory. Continue? (y/n) '
    );
    if (!proceed) {
      process.exit(0);
    }
  }

  // Step 2: Read existing opensdd.json if present
  const manifestPath = path.join(cwd, 'opensdd.json');
  let manifest = null;

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      console.error(`Error: opensdd.json is malformed JSON: ${err.message}`);
      process.exit(1);
    }
  }

  // Step 3: Determine mode
  let mode;
  let manifestCreated = false;

  if (manifest && manifest.specsDir) {
    // OpenSDD-driven re-init — no prompt needed
    mode = 'full';
  } else if (manifest && !manifest.specsDir) {
    // Consumer re-init — offer upgrade
    const upgrade = await promptYN('Upgrade to OpenSDD-driven? (y/n) ');
    if (upgrade) {
      mode = 'full';
      manifest.specsDir = manifest.specsDir || 'opensdd';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    } else {
      mode = 'consumer';
    }
  } else {
    // Fresh init — prompt for mode
    const choice = await promptChoice('How will this project use OpenSDD?', [
      'Consumer only \u2014 install and implement dependency specs',
      'OpenSDD-driven \u2014 full SDD methodology (author specs, both skills)',
    ]);
    mode = choice === 2 ? 'full' : 'consumer';
  }

  // Step 4: Determine skill installation root and install skills
  const gitRoot = findGitRoot(cwd);
  const skillRoot = gitRoot || cwd;
  const skillRootDiffers = path.resolve(skillRoot) !== path.resolve(cwd);

  let warnings;
  let skillsChanged;
  try {
    const result = installSkills(skillRoot, { mode });
    warnings = result.warnings;
    skillsChanged = result.anyChanged;
  } catch (err) {
    console.error(`Error: Could not install skills: ${err.message}`);
    process.exit(1);
  }

  for (const w of warnings) {
    console.warn(`Warning: ${w}`);
  }

  // Step 5: Create or preserve opensdd.json
  if (!manifest) {
    if (mode === 'full') {
      manifest = {
        opensdd: '0.1.0',
        specsDir: 'opensdd',
        depsDir: '.opensdd.deps',
      };
    } else {
      manifest = {
        opensdd: '0.1.0',
        depsDir: '.opensdd.deps',
      };
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    manifestCreated = true;
  }

  const depsDir = manifest.depsDir || '.opensdd.deps';
  const depsDirPath = path.join(cwd, depsDir);

  // Step 6: Create deps directory (both modes)
  const depsDirCreated = !fs.existsSync(depsDirPath);
  fs.mkdirSync(depsDirPath, { recursive: true });

  // Step 7: Full mode — create specs directory and skeleton spec.md
  let specsDirCreated = false;
  let specMdCreated = false;
  if (mode === 'full') {
    const specsDir = manifest.specsDir || 'opensdd';
    const specsDirPath = path.join(cwd, specsDir);

    specsDirCreated = !fs.existsSync(specsDirPath);
    fs.mkdirSync(specsDirPath, { recursive: true });

    const specMdPath = path.join(specsDirPath, 'spec.md');
    if (!fs.existsSync(specMdPath)) {
      const projectName = getProjectName(cwd);
      const skeleton = `# ${projectName}

> TODO: One-line description of what this software does.

## Behavioral Contract

<!-- Define behaviors here. -->

## NOT Specified (Implementation Freedom)

<!-- List aspects left to the implementer's discretion. -->

## Invariants

<!-- List properties that must hold true across all inputs and states. -->
`;
      fs.writeFileSync(specMdPath, skeleton);
      specMdCreated = true;
    }
  }

  // Step 8: Print output
  // Determine skill verb: 'installed' (fresh), 'updated' (content changed), 'up to date' (no change)
  let skillVerb;
  if (!skillRootDiffers && manifestCreated) {
    // Fresh init at repo root — always 'installed'
    skillVerb = 'installed';
  } else if (skillsChanged) {
    skillVerb = 'updated';
  } else {
    skillVerb = 'up to date';
  }

  const skillsUpToDate = skillVerb === 'up to date';

  if (mode === 'consumer') {
    console.log('Initialized OpenSDD (consumer):');
    if (skillRootDiffers) {
      console.log(`  Skills ${skillsUpToDate ? 'already installed' : 'installed'} at repo root (${skillRoot}):`);
    } else {
      console.log(
        '  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp'
      );
    }
    console.log(`    sdd-manager              ${skillVerb} (6 agent formats)`);
    console.log(
      `  opensdd.json               ${manifestCreated ? 'created' : 'already exists (preserved)'}`
    );
    console.log(`  ${depsDir}/             ${depsDirCreated ? 'created' : 'already exists'}`);
  } else {
    const specsDir = manifest.specsDir || 'opensdd';
    console.log('Initialized OpenSDD:');
    if (skillRootDiffers) {
      console.log(`  Skills ${skillsUpToDate ? 'already installed' : 'installed'} at repo root (${skillRoot}):`);
    } else {
      console.log(
        '  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp'
      );
    }
    console.log(`    sdd-manager              ${skillVerb} (6 agent formats)`);
    console.log(`    sdd-generate             ${skillVerb} (6 agent formats)`);
    console.log(
      `  opensdd.json               ${manifestCreated ? 'created' : 'already exists (preserved)'}`
    );
    console.log(`  ${specsDir}/                   ${specsDirCreated ? 'created' : 'already exists'}`);
    console.log(
      `  ${specsDir}/spec.md            ${specMdCreated ? 'created (skeleton)' : 'already exists (preserved)'}`
    );
    console.log(`  ${depsDir}/             ${depsDirCreated ? 'created' : 'already exists'}`);
  }
}
