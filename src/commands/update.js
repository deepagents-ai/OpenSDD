import fs from 'node:fs';
import path from 'node:path';
import { createPatch } from 'diff';
import {
  findManifestPath,
  readManifest,
  getDepsDir,
} from '../lib/manifest.js';
import {
  resolveRegistry,
  fetchSpecIndex,
  fetchSpecManifest,
  fetchSpecFiles,
} from '../lib/registry.js';

export async function updateCommand(name, options) {
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
  const deps = manifest.dependencies || {};

  // Determine which specs to update
  let specsToUpdate;
  if (name) {
    if (!deps[name]) {
      console.error(`Error: ${name} is not installed. Run \`opensdd install ${name}\` first.`);
      process.exit(1);
    }
    specsToUpdate = [name];
  } else {
    specsToUpdate = Object.keys(deps);
    if (specsToUpdate.length === 0) {
      console.log('No dependencies installed.');
      return;
    }
  }

  const results = [];

  for (const specName of specsToUpdate) {
    const entry = deps[specName];
    const specDir = path.join(depsDirPath, specName);

    // Fetch latest from registry
    let index;
    try {
      index = await fetchSpecIndex(registrySource, specName);
    } catch (err) {
      console.error(`Error: Could not reach registry for ${specName}: ${err.message}`);
      process.exit(1);
    }

    if (!index) {
      console.warn(
        `Warning: ${specName} is no longer available in the registry. Local files preserved.`
      );
      results.push({ name: specName, status: 'not_found' });
      continue;
    }

    const latestVersion = index.latest;

    if (latestVersion === entry.version) {
      results.push({ name: specName, status: 'up_to_date', version: entry.version });
      continue;
    }

    // Fetch new version files
    const newManifest = await fetchSpecManifest(registrySource, specName, latestVersion);
    const newFiles = await fetchSpecFiles(registrySource, specName, latestVersion);

    if (!newManifest || !newFiles) {
      console.error(`Error: Could not fetch ${specName}@${latestVersion} from registry.`);
      process.exit(1);
    }

    // Step d: Compute unified diffs of all spec-owned files before overwriting
    const diffs = {};
    const changedFiles = [];

    for (const [fileName, newContent] of Object.entries(newFiles)) {
      // deviations.md is consumer-owned — skip it in diffs and overwrites
      if (fileName === 'deviations.md') continue;

      const existingPath = path.join(specDir, fileName);
      const oldContent = fs.existsSync(existingPath)
        ? fs.readFileSync(existingPath, 'utf-8')
        : '';

      if (oldContent !== newContent) {
        diffs[fileName] = createPatch(fileName, oldContent, newContent);
        changedFiles.push(fileName);
      }
    }

    // Step e: Overwrite all spec-owned files
    fs.mkdirSync(specDir, { recursive: true });
    for (const [fileName, content] of Object.entries(newFiles)) {
      // Step f: MUST NOT overwrite deviations.md
      if (fileName === 'deviations.md') continue;
      fs.writeFileSync(path.join(specDir, fileName), content);
    }

    // Step g: Create staging directory
    const updatesDir = path.join(depsDirPath, '.updates', specName);
    const wasReplaced = fs.existsSync(updatesDir);
    fs.mkdirSync(updatesDir, { recursive: true });

    // Write changeset.md
    const specFormatOld = entry.specFormat || '0.1.0';
    const specFormatNew = newManifest.specFormat || '0.1.0';
    const specFormatChange =
      specFormatOld === specFormatNew
        ? 'unchanged'
        : `${specFormatOld} \u2192 ${specFormatNew}`;

    let changeset = `# Changeset: ${specName}\n\n`;
    changeset += `**Previous version:** ${entry.version}\n`;
    changeset += `**New version:** ${latestVersion}\n`;
    changeset += `**Spec-format:** ${specFormatChange}\n`;
    changeset += `**Date:** ${new Date().toISOString().split('T')[0]}\n\n`;
    changeset += '## Changed Files\n';

    for (const [fileName, diff] of Object.entries(diffs)) {
      changeset += `\n### ${fileName}\n\n\`\`\`diff\n${diff}\`\`\`\n`;
    }

    if (changedFiles.length === 0) {
      changeset += '\nNo file content changes (metadata only).\n';
    }

    fs.writeFileSync(path.join(updatesDir, 'changeset.md'), changeset);

    // Write manifest.json for staging
    const stageManifest = {
      name: specName,
      previousVersion: entry.version,
      version: latestVersion,
      source: registrySource,
      specFormat: newManifest.specFormat || '0.1.0',
    };

    fs.writeFileSync(
      path.join(updatesDir, 'manifest.json'),
      JSON.stringify(stageManifest, null, 2) + '\n'
    );

    results.push({
      name: specName,
      status: 'updated',
      oldVersion: entry.version,
      newVersion: latestVersion,
      changedFiles,
      replaced: wasReplaced,
    });
  }

  // Print output
  if (name) {
    // Single spec output
    const result = results[0];
    if (result.status === 'up_to_date') {
      console.log(`${result.name} v${result.version} is already up to date.`);
      return;
    }
    if (result.status === 'not_found') {
      return; // Warning already printed
    }

    console.log(`Updated ${result.name}: v${result.oldVersion} -> v${result.newVersion}`);
    if (result.replaced) {
      console.log('  (replaced existing pending update)');
    }

    if (result.changedFiles.length > 0) {
      console.log('\nChanged files:');
      for (const f of result.changedFiles) {
        console.log(`  ${f.padEnd(16)}updated`);
      }
    }

    // Check for deviations.md
    const deviationsPath = path.join(depsDirPath, result.name, 'deviations.md');
    if (fs.existsSync(deviationsPath)) {
      console.log('\nPreserved:');
      console.log('  deviations.md (consumer-owned, not modified)');
    }

    console.log('\nStaged update:');
    console.log(`  ${depsDir}/.updates/${result.name}/changeset.md`);
    console.log(`  ${depsDir}/.updates/${result.name}/manifest.json`);
    console.log(`\nRun "process the ${result.name} spec update" in your agent.`);
    console.log(`After confirming, run: opensdd update apply ${result.name}`);
  } else {
    // All specs output
    const updated = results.filter((r) => r.status === 'updated');

    console.log(`Updated ${updated.length} of ${results.length} installed specs:\n`);

    for (const r of results) {
      const namePad = r.name.padEnd(16);
      if (r.status === 'updated') {
        console.log(`  ${namePad}v${r.oldVersion} -> v${r.newVersion}   staged`);
      } else if (r.status === 'up_to_date') {
        console.log(`  ${namePad}v${r.version}             already up to date`);
      } else if (r.status === 'not_found') {
        console.log(`  ${namePad}not found in registry`);
      }
    }

    if (updated.length > 0) {
      console.log('\nRun "process spec updates" in your agent.');
      console.log('After confirming each update, run:');
      for (const r of updated) {
        console.log(`  opensdd update apply ${r.name}`);
      }
    }
  }
}
