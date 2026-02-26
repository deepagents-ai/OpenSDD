import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  findManifestPath,
  readManifest,
  writeManifest,
  getDepsDir,
} from '../lib/manifest.js';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function updateApplyCommand(name) {
  const manifestPath = findManifestPath(process.cwd());
  if (!manifestPath) {
    console.error('Error: OpenSDD not initialized. Run `opensdd init` to get started.');
    process.exit(1);
  }

  const manifest = readManifest(manifestPath);
  const projectRoot = path.dirname(manifestPath);
  const depsDir = getDepsDir(manifest);
  const updatesDir = path.join(projectRoot, depsDir, '.updates');

  // Determine which updates to apply
  let pendingNames;
  if (name) {
    const updateDir = path.join(updatesDir, name);
    if (!fs.existsSync(updateDir)) {
      console.error(`Error: No pending update for ${name}.`);
      process.exit(1);
    }
    pendingNames = [name];
  } else {
    if (!fs.existsSync(updatesDir)) {
      console.log('No pending updates.');
      process.exit(0);
    }
    const entries = fs.readdirSync(updatesDir, { withFileTypes: true });
    pendingNames = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
    if (pendingNames.length === 0) {
      console.log('No pending updates.');
      process.exit(0);
    }
  }

  // Print warning
  console.log('\u26A0 This will finalize the update in opensdd.json.');
  console.log('  Only proceed if you have confirmed that all spec changes');
  console.log('  have been implemented and tests pass.\n');

  // Prompt for confirmation
  let confirmMsg;
  if (pendingNames.length === 1) {
    const updateManifestPath = path.join(updatesDir, pendingNames[0], 'manifest.json');
    const updateManifest = JSON.parse(fs.readFileSync(updateManifestPath, 'utf-8'));
    confirmMsg = `Apply update for ${pendingNames[0]} v${updateManifest.previousVersion} -> v${updateManifest.version}? (y/n) `;
  } else {
    confirmMsg = `Apply ${pendingNames.length} pending updates? (y/n) `;
  }

  const answer = await prompt(confirmMsg);
  if (answer.toLowerCase() !== 'y') {
    process.exit(0);
  }

  console.log('');

  // Apply each update
  const applied = [];
  for (const specName of pendingNames) {
    const updateDir = path.join(updatesDir, specName);
    const manifestJsonPath = path.join(updateDir, 'manifest.json');

    if (!fs.existsSync(manifestJsonPath)) {
      console.error(`Error: Missing manifest.json for ${specName} update.`);
      process.exit(1);
    }

    let updateManifest;
    try {
      updateManifest = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf-8'));
    } catch (err) {
      console.error(`Error: Malformed manifest.json for ${specName}: ${err.message}`);
      process.exit(1);
    }

    // Update opensdd.json dependency entry, preserving consumer-managed fields
    if (!manifest.dependencies) manifest.dependencies = {};
    const existing = manifest.dependencies[specName] || {};

    manifest.dependencies[specName] = {
      ...existing,
      version: updateManifest.version,
      source: updateManifest.source,
      specFormat: updateManifest.specFormat,
      // Preserve consumer-managed fields
      implementation:
        existing.implementation !== undefined ? existing.implementation : null,
      tests: existing.tests !== undefined ? existing.tests : null,
      hasDeviations:
        existing.hasDeviations !== undefined ? existing.hasDeviations : false,
    };

    // Delete staging directory
    fs.rmSync(updateDir, { recursive: true, force: true });

    applied.push({
      name: specName,
      oldVersion: updateManifest.previousVersion,
      newVersion: updateManifest.version,
    });
  }

  // Write updated manifest
  writeManifest(manifestPath, manifest);

  // Clean up .updates/ directory if empty
  if (fs.existsSync(updatesDir)) {
    const remaining = fs.readdirSync(updatesDir);
    if (remaining.length === 0) {
      fs.rmSync(updatesDir, { recursive: true, force: true });
    }
  }

  // Print output
  if (applied.length === 1) {
    const a = applied[0];
    console.log(`Applied update for ${a.name}: v${a.oldVersion} -> v${a.newVersion}\n`);
    console.log('  opensdd.json    updated');
    console.log('  staged files    cleaned up');
  } else {
    console.log(`Applied ${applied.length} updates:\n`);
    for (const a of applied) {
      console.log(`  ${a.name.padEnd(16)}v${a.oldVersion} -> v${a.newVersion}   applied`);
    }
    console.log('\nopensdd.json updated.');
  }
}
