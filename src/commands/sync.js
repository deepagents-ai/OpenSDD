import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findManifestPath, readManifest } from '../lib/manifest.js';
import { installSkills } from '../lib/skills.js';
import { findGitRoot } from './init.js';
import { setupCiCommand } from './setupCi.js';

function promptYN(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

export async function syncCommand() {
  const cwd = process.cwd();

  // Step 1: Resolve opensdd.json via manifest resolution
  const manifestPath = findManifestPath(cwd);
  if (!manifestPath) {
    console.error('OpenSDD not initialized. Run `opensdd init` to get started.');
    process.exit(1);
  }

  // Step 2: Determine mode from the resolved manifest
  const manifest = readManifest(manifestPath);
  const mode = manifest.specsDir ? 'full' : 'consumer';

  // Step 3: Determine skill installation root
  const gitRoot = findGitRoot(cwd);
  const skillRoot = gitRoot || cwd;
  const skillRootDiffers = path.resolve(skillRoot) !== path.resolve(cwd);

  // Step 4: Re-install/update all skill files
  let warnings;
  try {
    const result = installSkills(skillRoot, { mode });
    warnings = result.warnings;
  } catch (err) {
    console.error(`Error: Could not install skills: ${err.message}`);
    process.exit(1);
  }

  for (const w of warnings) {
    console.warn(`Warning: ${w}`);
  }

  // Step 5: Print summary
  console.log('Synced OpenSDD:');
  if (skillRootDiffers) {
    console.log(`  Skills installed at repo root (${skillRoot}):`);
  } else {
    console.log(
      '  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp'
    );
  }
  console.log('    sdd-manager              updated (6 agent formats)');
  if (mode === 'full') {
    console.log('    sdd-generate             updated (6 agent formats)');
  }

  // Step 6: If full mode and CI not already configured, prompt for CI setup
  if (mode === 'full') {
    const ciWorkflowPath = path.join(skillRoot, '.github', 'workflows', 'claude-implement.yml');
    if (!fs.existsSync(ciWorkflowPath)) {
      const setupCi = await promptYN(
        '\nWould you like to set up CI-driven spec implementation? (opensdd setup-ci) [y/N] '
      );
      if (setupCi) {
        console.log('');
        await setupCiCommand();
      }
    }
  }
}
