import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { findManifestPath } from '../lib/manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKFLOWS_DIR = path.resolve(__dirname, '../../opensdd/workflows');

function promptYN(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

function commandExists(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function ghAuthStatus() {
  try {
    execSync('gh auth status', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function getGitHubRepo() {
  try {
    const result = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

export function readWorkflowFile(name) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf-8');
}

const LABELS = [
  { name: 'spec', color: '0E8A16', description: 'PR contains only spec changes' },
  { name: 'implement-spec', color: '1D76DB', description: 'Issue to be auto-implemented by Claude' },
];

export const WORKFLOW_NAMES = ['spec-merged.yml', 'claude-implement.yml'];

export async function setupCiCommand({ force = false, dryRun = false, skipToken = false } = {}) {
  const results = [];

  // Step 1: Validate environment
  console.log('Setting up OpenSDD CI...\n');
  console.log('Checking prerequisites...');

  const manifestPath = findManifestPath(process.cwd());
  if (!manifestPath) {
    console.error('Error: OpenSDD not initialized. Run `opensdd init` first.');
    process.exit(1);
  }
  console.log('  opensdd.json             found');

  if (!commandExists('gh')) {
    console.error('Error: GitHub CLI (gh) is required. Install it from https://cli.github.com');
    process.exit(1);
  }
  console.log('  gh CLI                   found');

  if (!ghAuthStatus()) {
    console.error('Error: GitHub CLI is not authenticated. Run `gh auth login` first.');
    process.exit(1);
  }
  console.log('  gh auth                  authenticated');

  if (!skipToken && !commandExists('claude')) {
    console.error('Error: Claude CLI is required for token setup. Install it or use --skip-token to skip.');
    process.exit(1);
  }
  if (!skipToken) {
    console.log('  claude CLI               found');
  }

  const repo = getGitHubRepo();
  if (!repo) {
    console.error('Error: No GitHub remote found. Add a GitHub remote first.');
    process.exit(1);
  }
  console.log(`  GitHub remote            ${repo}`);

  console.log('');

  // Dry-run mode
  if (dryRun) {
    console.log('OpenSDD CI setup (dry run):');
    for (const label of LABELS) {
      console.log(`  Would create label: ${label.name} (#${label.color})`);
    }
    if (skipToken) {
      console.log('  Would skip secret: CLAUDE_CODE_OAUTH_TOKEN (--skip-token)');
    } else {
      console.log('  Would set secret: CLAUDE_CODE_OAUTH_TOKEN');
    }
    for (const name of WORKFLOW_NAMES) {
      console.log(`  Would install: .github/workflows/${name}`);
    }
    console.log('\nRun without --dry-run to apply.');
    return;
  }

  // Step 2: Create GitHub labels
  console.log('Creating labels...');
  for (const label of LABELS) {
    try {
      execSync(
        `gh label create "${label.name}" --color "${label.color}" --description "${label.description}"`,
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      results.push({ item: `Label: ${label.name}`, status: 'created', ok: true });
      console.log(`  ${label.name}            created`);
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString() : '';
      if (stderr.includes('already exists')) {
        results.push({ item: `Label: ${label.name}`, status: 'already exists', ok: true });
        console.log(`  ${label.name}            already exists`);
      } else {
        console.error(`Error: Failed to create label "${label.name}": ${stderr || err.message}`);
        process.exit(1);
      }
    }
  }

  // Step 3: Set up Claude Code OAuth token
  if (skipToken) {
    results.push({ item: 'Secret: CLAUDE_CODE_OAUTH_TOKEN', status: 'skipped (--skip-token)', ok: false });
    console.log('Skipping token setup (--skip-token)');
  } else {
    console.log('Setting up Claude Code OAuth token...');
    // Check if secret already exists
    let secretExists = false;
    try {
      const secretList = execSync('gh secret list', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      secretExists = secretList.split('\n').some((line) => line.startsWith('CLAUDE_CODE_OAUTH_TOKEN'));
    } catch {
      // If we can't list secrets, assume it doesn't exist
    }

    let shouldSet = true;
    if (secretExists && !force) {
      shouldSet = await promptYN('Secret CLAUDE_CODE_OAUTH_TOKEN already exists. Overwrite? (y/n) ');
      if (!shouldSet) {
        results.push({ item: 'Secret: CLAUDE_CODE_OAUTH_TOKEN', status: 'already exists (kept)', ok: true });
      }
    }

    if (shouldSet) {
      // Run claude setup-token interactively — it needs a TTY for the OAuth flow.
      // stdout is captured to extract the token; stdin/stderr are inherited for user interaction.
      let token;
      console.log('  Running claude setup-token (follow the prompts)...');
      try {
        token = execSync('claude setup-token', { encoding: 'utf-8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
      } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : err.message;
        console.error(`Error: claude setup-token failed: ${stderr}`);
        process.exit(1);
      }

      if (!token) {
        console.error('Error: claude setup-token did not produce a token. Run it manually and use --skip-token.');
        process.exit(1);
      }

      // Set the secret
      console.log('  Setting repo secret...');
      try {
        execSync('gh secret set CLAUDE_CODE_OAUTH_TOKEN', {
          input: token,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        results.push({ item: 'Secret: CLAUDE_CODE_OAUTH_TOKEN', status: 'set', ok: true });
      } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : err.message;
        console.error(`Error: Failed to set secret: ${stderr}`);
        process.exit(1);
      }
    }
  }

  // Step 4: Install GitHub Actions workflows
  console.log('Installing workflow files...');
  const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const workflowDir = path.join(gitRoot, '.github', 'workflows');

  try {
    fs.mkdirSync(workflowDir, { recursive: true });
  } catch (err) {
    console.error(`Error: Could not create .github/workflows/: ${err.message}`);
    process.exit(1);
  }

  for (const name of WORKFLOW_NAMES) {
    const filePath = path.join(workflowDir, name);
    const exists = fs.existsSync(filePath);

    if (exists && !force) {
      const overwrite = await promptYN(`Workflow .github/workflows/${name} already exists. Overwrite? (y/n) `);
      if (!overwrite) {
        results.push({ item: `Workflow: .github/workflows/${name}`, status: 'already exists (kept)', ok: true });
        console.log(`  ${name}    already exists (kept)`);
        continue;
      }
    }

    fs.writeFileSync(filePath, readWorkflowFile(name));
    results.push({ item: `Workflow: .github/workflows/${name}`, status: 'installed', ok: true });
    console.log(`  ${name}    installed`);
  }

  // Step 5: Print summary
  console.log('\nOpenSDD CI setup complete:');
  for (const r of results) {
    const icon = r.ok ? '\u2713' : '-';
    console.log(`  ${icon} ${r.item.padEnd(45)} ${r.status}`);
  }
  console.log('\nYou can now use the Propose workflow to submit specs for CI implementation.');
}
