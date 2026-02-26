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
  listRegistrySpecs,
} from '../lib/registry.js';

function isValidSpecName(name) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

export async function installCommand(name, version, options) {
  // Step 1: Verify opensdd.json exists
  const manifestPath = findManifestPath(process.cwd());
  if (!manifestPath) {
    console.error('Error: OpenSDD not initialized. Run `opensdd init` to get started.');
    process.exit(1);
  }

  const manifest = readManifest(manifestPath);
  const projectRoot = path.dirname(manifestPath);
  const depsDir = getDepsDir(manifest);
  const depsDirPath = path.join(projectRoot, depsDir);
  const registrySource = resolveRegistry(options, manifest);

  // Step 2: Check if already installed
  const deps = manifest.dependencies || {};
  const specDirPath = path.join(depsDirPath, name);

  let useVersion = version;

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

  // Step 6: Fetch all spec files and write to deps dir
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

  // Step 7: Add entry to opensdd.json
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

  // Step 8: Check for missing dependencies
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

  // Step 9: Print success
  console.log(`Installed ${name} v${resolvedVersion} to ${depsDir}/${name}/`);
  console.log(
    `\nRun "implement the ${name} spec" in your agent to generate an implementation.`
  );
}
