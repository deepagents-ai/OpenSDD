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

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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

  // Step 2: Verify publish section
  if (!manifest.publish) {
    console.error('Error: No `publish` section in opensdd.json.');
    console.error(
      'Add a `publish` object with name, version, description, and spec_format to publish your spec.'
    );
    process.exit(1);
  }

  const { name, version, description, spec_format, dependencies } = manifest.publish;

  if (!name || !version || !description || !spec_format) {
    console.error(
      'Error: `publish` section must include name, version, description, and spec_format.'
    );
    process.exit(1);
  }

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
    const answer = await prompt(
      `Enter branch name for the registry PR (default: opensdd/${name}-v${version}): `
    );
    branchName = answer.trim() || `opensdd/${name}-v${version}`;
  }

  const { owner, repo } = parseGitHubUrl(registrySource);
  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  // Step 10: Clone, create branch, add files, push, create PR
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensdd-publish-'));

  try {
    // Clone
    execSync(`git clone --depth 1 "${repoUrl}" "${tmpDir}"`, { stdio: 'pipe' });

    // Create branch
    execSync(`git checkout -b "${branchName}"`, { cwd: tmpDir, stdio: 'pipe' });
    console.log(`  Created branch            ${branchName}`);

    // Create registry entry directory
    const registryDir = path.join(tmpDir, 'registry', name, version);
    fs.mkdirSync(registryDir, { recursive: true });

    // Build manifest.json
    const publishManifest = {
      name,
      version,
      spec_format,
      description,
      dependencies: dependencies || [],
    };
    fs.writeFileSync(
      path.join(registryDir, 'manifest.json'),
      JSON.stringify(publishManifest, null, 2) + '\n'
    );

    // Copy all spec files
    copyDirRecursive(specsDirPath, registryDir);

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
    indexData.versions[version] = { spec_format };
    fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2) + '\n');
    console.log(`  Updated index.json        latest: ${version}`);

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
