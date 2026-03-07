import fs from 'node:fs';
import path from 'node:path';
import {
  findManifestPath,
  readManifest,
  writeManifest,
  getDepsDir,
} from '../lib/manifest.js';
import {
  resolveRegistry,
  fetchSpecIndex,
  fetchSpecManifest,
  fetchSpecFiles,
  fetchSkillFiles,
  listRegistrySpecs,
} from '../lib/registry.js';
import { installSkills, installDependencySkill, generateSkillMd } from '../lib/skills.js';

function isValidSpecName(name) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

export async function installCommand(name, version, options) {
  // Step 1: Verify opensdd.json exists, auto-bootstrap if not
  let manifestPath = findManifestPath(process.cwd());
  if (!manifestPath) {
    const cwd = process.cwd();
    manifestPath = path.join(cwd, 'opensdd.json');
    const consumerManifest = {
      opensdd: '0.1.0',
      depsDir: '.opensdd.deps',
    };
    if (options.skill) {
      consumerManifest.installMode = 'skill';
    }
    fs.writeFileSync(manifestPath, JSON.stringify(consumerManifest, null, 2) + '\n');
    installSkills(cwd, { mode: 'consumer' });
    fs.mkdirSync(path.join(cwd, '.opensdd.deps'), { recursive: true });
    console.log('Auto-initialized OpenSDD (consumer).');
  }

  const manifest = readManifest(manifestPath);
  const projectRoot = path.dirname(manifestPath);
  const depsDir = getDepsDir(manifest);
  const depsDirPath = path.join(projectRoot, depsDir);
  const registrySource = resolveRegistry(options, manifest);

  // Resolve install mode: --skill flag > manifest.installMode > "default"
  const installMode = options.skill ? 'skill' : (manifest.installMode || 'default');

  // Step 2: Check if already installed
  const deps = manifest.dependencies || {};
  const specDirPath = path.join(depsDirPath, name);

  let useVersion = version;

  if (installMode === 'skill') {
    // In skill mode, only check the dependency entry
    if (deps[name]) {
      console.error(`Error: ${name} is already installed (v${deps[name].version}).`);
      console.error(`Use \`opensdd update ${name}\` to update to the latest version.`);
      process.exit(1);
    }
  } else {
    if (deps[name] && fs.existsSync(specDirPath)) {
      console.error(`Error: ${name} is already installed (v${deps[name].version}).`);
      console.error(`Use \`opensdd update ${name}\` to update to the latest version.`);
      process.exit(1);
    }

    // Handle stale entry (entry exists but directory missing)
    if (deps[name] && !fs.existsSync(specDirPath)) {
      console.log(
        `Note: Found stale entry for ${name} in opensdd.json (directory missing). Re-installing.`
      );
      if (!useVersion) {
        useVersion = deps[name].version;
      }
    }
  }

  // Step 3: Validate spec name
  if (!isValidSpecName(name)) {
    console.error(
      `Error: Invalid spec name "${name}". Allowed characters: lowercase alphanumeric and hyphens only.`
    );
    process.exit(1);
  }

  // Step 4: Fetch index.json
  let index;
  try {
    index = await fetchSpecIndex(registrySource, name);
  } catch (err) {
    console.error(`Error: Could not reach registry at ${registrySource}`);
    console.error(err.message);
    process.exit(1);
  }

  if (!index) {
    console.error(`Error: Spec "${name}" not found in registry.`);
    try {
      const available = await listRegistrySpecs(registrySource);
      if (available.length > 0) {
        console.error('\nAvailable specs:');
        for (const s of available) {
          console.error(`  ${s.name}`);
        }
      }
    } catch {
      // ignore listing errors
    }
    process.exit(1);
  }

  // Resolve version
  const resolvedVersion = useVersion || index.latest;

  // Check version exists
  if (!index.versions || !index.versions[resolvedVersion]) {
    console.error(`Error: Version ${resolvedVersion} not found for ${name}.`);
    const availableVersions = Object.keys(index.versions || {});
    if (availableVersions.length > 0) {
      console.error(`Available versions: ${availableVersions.join(', ')}`);
    }
    process.exit(1);
  }

  // Step 5: Fetch manifest for the version
  const specManifest = await fetchSpecManifest(registrySource, name, resolvedVersion);
  if (!specManifest) {
    console.error(`Error: Could not fetch manifest for ${name}@${resolvedVersion}`);
    process.exit(1);
  }

  if (installMode === 'skill') {
    // Skill mode: install as agent skill across all formats
    const skillFiles = await fetchSkillFiles(registrySource, name, resolvedVersion);
    if (!skillFiles) {
      console.error(`Error: Could not fetch skill files for ${name}@${resolvedVersion}`);
      process.exit(1);
    }

    // Get or generate SKILL.md
    let skillMd = skillFiles['SKILL.md'];
    if (!skillMd) {
      // No SKILL.md in registry — generate from spec.md
      const allFiles = await fetchSpecFiles(registrySource, name, resolvedVersion);
      if (!allFiles || !allFiles['spec.md']) {
        console.error(`Error: Could not fetch spec.md for ${name}@${resolvedVersion}`);
        process.exit(1);
      }
      skillMd = generateSkillMd(allFiles['spec.md']);
    }

    // Collect supplementary .md files (everything except SKILL.md)
    const supplementaryFiles = {};
    for (const [fileName, content] of Object.entries(skillFiles)) {
      if (fileName !== 'SKILL.md' && fileName.endsWith('.md')) {
        supplementaryFiles[fileName] = content;
      }
    }

    const warnings = installDependencySkill(projectRoot, name, skillMd, supplementaryFiles);
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }

    // Add entry to opensdd.json
    if (!manifest.dependencies) {
      manifest.dependencies = {};
    }
    manifest.dependencies[name] = {
      version: resolvedVersion,
      source: registrySource,
      specFormat: specManifest.specFormat || '0.1.0',
      mode: 'skill',
    };
    writeManifest(manifestPath, manifest);

    console.log(`Installed ${name} v${resolvedVersion} as skill`);
    console.log('  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp');
  } else {
    // Default mode: install spec files to deps dir
    const files = await fetchSpecFiles(registrySource, name, resolvedVersion);
    if (!files) {
      console.error(`Error: Could not fetch spec files for ${name}@${resolvedVersion}`);
      process.exit(1);
    }

    fs.mkdirSync(specDirPath, { recursive: true });
    for (const [fileName, content] of Object.entries(files)) {
      // Invariant: opensdd install MUST NOT create a deviations.md file
      if (fileName === 'deviations.md') continue;
      fs.writeFileSync(path.join(specDirPath, fileName), content);
    }

    // Add entry to opensdd.json
    if (!manifest.dependencies) {
      manifest.dependencies = {};
    }

    // Preserve consumer-managed fields from stale entry if re-installing
    const existingEntry = deps[name];
    manifest.dependencies[name] = {
      version: resolvedVersion,
      source: registrySource,
      specFormat: specManifest.specFormat || '0.1.0',
      implementation: existingEntry?.implementation ?? null,
      tests: existingEntry?.tests ?? null,
      hasDeviations: existingEntry?.hasDeviations ?? false,
    };

    writeManifest(manifestPath, manifest);

    // Check for missing dependencies
    if (specManifest.dependencies && specManifest.dependencies.length > 0) {
      const missing = specManifest.dependencies.filter(
        (dep) => !manifest.dependencies[dep]
      );
      if (missing.length > 0) {
        console.log('\nWarning: This spec has uninstalled dependencies:');
        for (const dep of missing) {
          console.log(`  Run \`opensdd install ${dep}\` to install ${dep}.`);
        }
      }
    }

    console.log(`Installed ${name} v${resolvedVersion} to ${depsDir}/${name}/`);
    console.log(
      `\nRun "implement the ${name} spec" in your agent to generate an implementation.`
    );
  }
}
