import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import {
  findManifestPath,
  readManifest,
  getSpecsDir,
} from '../lib/manifest.js';
import {
  resolveRegistry,
  isGitHubUrl,
  parseGitHubUrl,
  fetchSpecIndex,
} from '../lib/registry.js';
import { validateSpec } from '../lib/validation.js';
import { generateSkillMd } from '../lib/skills.js';

const PUBLISH_FIELDS = [
  { key: 'name', prompt: 'Spec name (lowercase alphanumeric and hyphens): ' },
  { key: 'version', prompt: 'Version (semver, e.g. 1.0.0): ' },
  { key: 'description', prompt: 'Description: ' },
  { key: 'specFormat', prompt: 'Spec format version (e.g. 0.1.0): ' },
];

async function promptForMissingFields(publish) {
  const result = { ...publish };
  const missingFields = PUBLISH_FIELDS.filter(
    (f) => !result[f.key] || result[f.key].trim() === ''
  );
  if (missingFields.length === 0) return result;

  // Collect all lines from stdin to handle both piped and interactive input
  const lines = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // For piped input, we need to collect answers using the line event
  // because rl.question + close interact poorly with piped streams.
  let lineResolve = null;
  let eofReject = null;

  rl.on('line', (line) => {
    if (lineResolve) {
      const r = lineResolve;
      lineResolve = null;
      r(line);
    } else {
      lines.push(line);
    }
  });

  rl.on('close', () => {
    if (eofReject) {
      eofReject(new Error('EOF'));
    }
  });

  rl.on('SIGINT', () => {
    if (eofReject) {
      eofReject(new Error('interrupted'));
    }
  });

  function getLine(promptText) {
    process.stdout.write(promptText);
    if (lines.length > 0) {
      return Promise.resolve(lines.shift());
    }
    return new Promise((resolve, reject) => {
      lineResolve = resolve;
      eofReject = reject;
    });
  }

  try {
    for (const field of missingFields) {
      while (!result[field.key] || result[field.key].trim() === '') {
        const answer = await getLine(field.prompt);
        if (answer.trim()) {
          result[field.key] = answer.trim();
        }
      }
    }
  } catch {
    rl.close();
    process.exit(1);
  }
  rl.close();
  return result;
}

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function publishCommand(options) {
  // Step 1: Verify opensdd.json
  const manifestPath = findManifestPath(process.cwd());
  if (!manifestPath) {
    console.error('Error: OpenSDD not initialized. Run `opensdd init` to get started.');
    process.exit(1);
  }

  const manifest = readManifest(manifestPath);
  const projectRoot = path.dirname(manifestPath);
  const registrySource = resolveRegistry(options, manifest);

  // Step 2-3: Read publish object and prompt for missing fields
  const publish = manifest.publish || {};
  const completedPublish = await promptForMissingFields(publish);

  // Write completed publish object back to opensdd.json
  manifest.publish = { ...manifest.publish, ...completedPublish };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const { name, version, description, specFormat, dependencies } = manifest.publish;

  // Step 4: Verify spec.md exists
  const specsDir = getSpecsDir(manifest);
  const specsDirPath = path.join(projectRoot, specsDir);

  if (!fs.existsSync(path.join(specsDirPath, 'spec.md'))) {
    console.error(`Error: ${specsDir}/spec.md not found. Create your spec before publishing.`);
    process.exit(1);
  }

  // Step 5: Validate spec
  console.log(`Publishing ${name} v${version} to registry...\n`);

  const validation = validateSpec(specsDirPath);
  if (validation.errors.length > 0) {
    console.error('  Validated spec            FAILED\n');
    for (const err of validation.errors) {
      console.error(`    - ${err}`);
    }
    process.exit(1);
  }
  console.log('  Validated spec            ok');

  // Step 6: Verify registry is GitHub
  if (!isGitHubUrl(registrySource)) {
    console.error('Error: Publishing requires a GitHub registry URL.');
    console.error(`Current registry: ${registrySource}`);
    process.exit(1);
  }

  // Check git and gh CLI
  if (!commandExists('git')) {
    console.error('Error: git is not installed. Install git to publish specs.');
    process.exit(1);
  }
  if (!commandExists('gh')) {
    console.error('Error: GitHub CLI (gh) is not installed.');
    console.error(
      'Install it from https://cli.github.com/ and authenticate with `gh auth login`.'
    );
    process.exit(1);
  }

  // Step 7: Check if version already exists
  try {
    const index = await fetchSpecIndex(registrySource, name);
    if (index && index.versions && index.versions[version]) {
      console.error(
        `\nError: Version ${version} already exists in the registry for ${name}.`
      );
      console.error('Bump the version in opensdd.json before publishing.');
      process.exit(1);
    }
  } catch {
    // Spec doesn't exist in registry yet — that's fine
  }

  // Step 9: Determine branch name
  let branchName = options.branch;
  if (!branchName) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(
        `Enter branch name for the registry PR (default: opensdd/${name}-v${version}): `,
        (a) => resolve(a)
      );
      rl.on('close', () => resolve(''));
    });
    rl.close();
    branchName = answer.trim() || `opensdd/${name}-v${version}`;
  }

  const { owner, repo } = parseGitHubUrl(registrySource);

  // Step 10: Clone, create branch, add files, push, create PR
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensdd-publish-'));

  try {
    // Clone using gh to respect the user's configured git protocol (ssh vs https)
    execSync(`gh repo clone "${owner}/${repo}" "${tmpDir}" -- --depth 1`, { stdio: 'pipe' });

    // Create branch
    execSync(`git checkout -b "${branchName}"`, { cwd: tmpDir, stdio: 'pipe' });
    console.log(`  Created branch            ${branchName}`);

    // Create registry entry directory
    const registryDir = path.join(tmpDir, 'registry', name, version);
    fs.mkdirSync(registryDir, { recursive: true });

    // Copy all spec files first
    copyDirRecursive(specsDirPath, registryDir);

    // Build manifest.json from publish fields (written after copy so it takes precedence
    // over any manifest.json that might exist in the specs directory)
    const publishManifest = {
      name,
      version,
      specFormat,
      description,
      dependencies: dependencies || [],
    };
    fs.writeFileSync(
      path.join(registryDir, 'manifest.json'),
      JSON.stringify(publishManifest, null, 2) + '\n'
    );

    console.log(`  Created registry entry    registry/${name}/${version}/`);

    // Update (or create) index.json
    const indexDir = path.join(tmpDir, 'registry', name);
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, 'index.json');

    let indexData;
    if (fs.existsSync(indexPath)) {
      indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } else {
      indexData = { name, description, latest: version, versions: {} };
    }
    indexData.latest = version;
    indexData.versions[version] = { specFormat };
    fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2) + '\n');
    console.log(`  Updated index.json        latest: ${version}`);

    // Generate SKILL.md from spec.md
    const specContent = fs.readFileSync(path.join(registryDir, 'spec.md'), 'utf-8');
    const skillMd = generateSkillMd(specContent);

    // Write archival copy in registry version dir
    fs.writeFileSync(path.join(registryDir, 'SKILL.md'), skillMd);

    // Create/update skills/<name>/ at registry repo root
    const skillsDir = path.join(tmpDir, 'skills', name);
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), skillMd);

    // Copy supplementary .md files (everything except spec.md, manifest.json, SKILL.md, and directories)
    const skipFiles = new Set(['spec.md', 'manifest.json', 'SKILL.md']);
    const skipDirs = new Set(['skills', '.changes']);
    const entries = fs.readdirSync(specsDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          copyDirRecursive(path.join(specsDirPath, entry.name), path.join(skillsDir, entry.name));
        }
        continue;
      }
      if (!skipFiles.has(entry.name) && entry.name.endsWith('.md')) {
        fs.copyFileSync(path.join(specsDirPath, entry.name), path.join(skillsDir, entry.name));
      }
    }

    // Write README in skills/ root (idempotent — overwritten each publish)
    const skillsRootReadme = path.join(tmpDir, 'skills', 'README.md');
    fs.writeFileSync(skillsRootReadme,
      '# Skills\n\nThis directory is **auto-generated** by `opensdd publish`. Do not edit files here directly — they will be overwritten on the next publish.\n\nTo modify a skill, edit the source spec and re-publish.\n'
    );

    console.log(`  Generated SKILL.md        skills/${name}/`);

    // Commit and push
    execSync('git add -A', { cwd: tmpDir, stdio: 'pipe' });
    execSync(`git commit -m "Add ${name} v${version}"`, { cwd: tmpDir, stdio: 'pipe' });
    execSync(`git push -u origin "${branchName}"`, { cwd: tmpDir, stdio: 'pipe' });

    // Create PR
    const prTitle = `Add ${name} v${version}`;
    const prBody = `Adds ${name} v${version} to the OpenSDD registry.\n\n${description}`;
    const prOutput = execSync(
      `gh pr create --repo "${owner}/${repo}" --title "${prTitle}" --body "${prBody}" --head "${branchName}"`,
      { cwd: tmpDir, encoding: 'utf-8' }
    ).trim();

    console.log(`  Opened pull request       ${prOutput}`);
  } catch (err) {
    if (err.message.includes('Authentication') || err.message.includes('auth')) {
      console.error('\nError: Git authentication failed.');
      console.error('Run `gh auth login` to authenticate with GitHub.');
    } else {
      console.error(`\nError during publish: ${err.message}`);
      if (err.stderr) {
        console.error(err.stderr.toString());
      }
    }
    process.exit(1);
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  console.log('\nPublished. Spec will be available after PR is merged.');
}
