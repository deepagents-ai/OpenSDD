import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { generateSkillMd } from '../src/lib/skills.js';
import { readWorkflowFile, WORKFLOW_NAMES } from '../src/commands/setupCi.js';

const CLI = path.resolve('bin/opensdd.js');
const PKG = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
const FIXTURES = path.join('/tmp', 'opensdd-test-fixtures');
const TEST_PROJECT = path.join('/tmp', 'opensdd-test-project');
const TEST_REGISTRY = path.join('/tmp', 'opensdd-test-registry');

function run(args, cwd = TEST_PROJECT, opts = {}) {
  try {
    return execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...opts.env },
      input: opts.input,
      timeout: 15000,
    });
  } catch (err) {
    if (opts.expectError) {
      return { stderr: err.stderr, stdout: err.stdout, exitCode: err.status };
    }
    throw err;
  }
}

function setupTestProject() {
  fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
  fs.mkdirSync(TEST_PROJECT, { recursive: true });
  execSync('git init', { cwd: TEST_PROJECT, stdio: 'ignore' });
  fs.writeFileSync(
    path.join(TEST_PROJECT, 'package.json'),
    JSON.stringify({ name: 'my-test-app' })
  );
}

function setupTestRegistry() {
  fs.rmSync(TEST_REGISTRY, { recursive: true, force: true });

  // slugify v1.0.0
  const slugify100 = path.join(TEST_REGISTRY, 'registry', 'slugify', '1.0.0');
  fs.mkdirSync(slugify100, { recursive: true });
  fs.writeFileSync(
    path.join(slugify100, 'manifest.json'),
    JSON.stringify({
      name: 'slugify',
      version: '1.0.0',
      specFormat: '0.1.0',
      description: 'String to URL-friendly slug',
      dependencies: [],
    })
  );
  fs.writeFileSync(
    path.join(slugify100, 'spec.md'),
    `# Slugify\n\n> String to URL-friendly slug.\n\n## Behavioral Contract\n\n### Core\n\nConvert string to slug.\n\n## Edge Cases\n\n- Empty returns empty\n\n## NOT Specified (Implementation Freedom)\n\n- Algorithm\n\n## Invariants\n\n- Idempotent\n`
  );

  // slugify v1.1.0
  const slugify110 = path.join(TEST_REGISTRY, 'registry', 'slugify', '1.1.0');
  fs.mkdirSync(slugify110, { recursive: true });
  fs.writeFileSync(
    path.join(slugify110, 'manifest.json'),
    JSON.stringify({
      name: 'slugify',
      version: '1.1.0',
      specFormat: '0.1.0',
      description: 'String to URL-friendly slug',
      dependencies: [],
    })
  );
  fs.writeFileSync(
    path.join(slugify110, 'spec.md'),
    `# Slugify\n\n> String to URL-friendly slug.\n\n## Behavioral Contract\n\n### Core\n\nConvert string to slug.\n\n### Unicode Support\n\nTransliterate accented characters.\n\n## Edge Cases\n\n- Empty returns empty\n\n## NOT Specified (Implementation Freedom)\n\n- Algorithm\n\n## Invariants\n\n- Idempotent\n`
  );

  // slugify index.json
  fs.writeFileSync(
    path.join(TEST_REGISTRY, 'registry', 'slugify', 'index.json'),
    JSON.stringify({
      name: 'slugify',
      description: 'String to URL-friendly slug',
      latest: '1.1.0',
      versions: {
        '1.0.0': { specFormat: '0.1.0' },
        '1.1.0': { specFormat: '0.1.0' },
      },
    })
  );

  // with-deps v1.0.0 (has dependencies)
  const withDeps = path.join(TEST_REGISTRY, 'registry', 'with-deps', '1.0.0');
  fs.mkdirSync(withDeps, { recursive: true });
  fs.writeFileSync(
    path.join(withDeps, 'manifest.json'),
    JSON.stringify({
      name: 'with-deps',
      version: '1.0.0',
      specFormat: '0.1.0',
      description: 'Spec with dependencies',
      dependencies: ['slugify', 'missing-dep'],
    })
  );
  fs.writeFileSync(
    path.join(withDeps, 'spec.md'),
    `# With Deps\n\n> Spec with deps.\n\n## Behavioral Contract\n\nUses slugify.\n`
  );
  fs.writeFileSync(
    path.join(TEST_REGISTRY, 'registry', 'with-deps', 'index.json'),
    JSON.stringify({
      name: 'with-deps',
      description: 'Spec with dependencies',
      latest: '1.0.0',
      versions: { '1.0.0': { specFormat: '0.1.0' } },
    })
  );
}

describe('opensdd CLI', () => {
  before(() => {
    setupTestRegistry();
  });

  after(() => {
    fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
    fs.rmSync(TEST_REGISTRY, { recursive: true, force: true });
  });

  describe('--help and --version', () => {
    it('should print help', () => {
      const output = run('--help', '/tmp');
      assert.match(output, new RegExp(`opensdd v${PKG.version.replace(/\./g, '\\.')}`));
      assert.match(output, /Commands:/);
    });

    it('should print version', () => {
      const output = run('--version', '/tmp');
      assert.equal(output.trim(), PKG.version);
    });
  });

  describe('init', () => {
    beforeEach(() => {
      setupTestProject();
    });

    it('should initialize a fresh project (OpenSDD-driven)', () => {
      const output = run('init', TEST_PROJECT, { input: '2\n' });
      assert.match(output, /Initialized OpenSDD/);
      assert.match(output, /installed \(6 agent formats\)/);
      assert.match(output, /opensdd\.json\s+created/);
      assert.match(output, /opensdd\/spec\.md\s+created \(skeleton\)/);

      // Verify files
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, 'opensdd.json')));
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, 'opensdd', 'spec.md')));
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, '.opensdd.deps')));
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager', 'SKILL.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.agents', 'skills', 'sdd-generate', 'SKILL.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager-authoring', 'SKILL.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.agents', 'skills', 'sdd-manager-authoring', 'SKILL.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.cursor', 'rules', 'sdd-manager-authoring.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(
            TEST_PROJECT,
            '.github',
            'instructions',
            'sdd-manager-authoring.instructions.md'
          )
        )
      );
      assert.ok(
        fs.existsSync(path.join(TEST_PROJECT, '.cursor', 'rules', 'sdd-manager.md'))
      );
      assert.ok(
        fs.existsSync(
          path.join(
            TEST_PROJECT,
            '.github',
            'instructions',
            'sdd-manager.instructions.md'
          )
        )
      );
      // CLAUDE.md, GEMINI.md, AGENTS.md are NOT created — only patched if they exist
      assert.ok(!fs.existsSync(path.join(TEST_PROJECT, 'GEMINI.md')));
      assert.ok(!fs.existsSync(path.join(TEST_PROJECT, 'AGENTS.md')));
      assert.ok(!fs.existsSync(path.join(TEST_PROJECT, 'CLAUDE.md')));

      // Tip message shown for missing config files
      assert.match(output, /Tip:.*gate rules/);
      assert.match(output, /GEMINI\.md/);
      assert.match(output, /AGENTS\.md/);
      assert.match(output, /CLAUDE\.md/);

      // Verify opensdd.json content
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.opensdd, '0.1.0');
      assert.equal(manifest.specsDir, 'opensdd');
      assert.equal(manifest.depsDir, '.opensdd.deps');

      // Verify SKILL.md files contain Agent Skills frontmatter
      const claudeManagerSkill = fs.readFileSync(
        path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager', 'SKILL.md'),
        'utf-8'
      );
      assert.match(claudeManagerSkill, /^---\n/);
      assert.match(claudeManagerSkill, /name: sdd-manager/);
      assert.match(claudeManagerSkill, /description: "/);

      const claudeGenerateSkill = fs.readFileSync(
        path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-generate', 'SKILL.md'),
        'utf-8'
      );
      assert.match(claudeGenerateSkill, /^---\n/);
      assert.match(claudeGenerateSkill, /name: sdd-generate/);
      assert.match(claudeGenerateSkill, /description: "/);

      const codexManagerSkill = fs.readFileSync(
        path.join(TEST_PROJECT, '.agents', 'skills', 'sdd-manager', 'SKILL.md'),
        'utf-8'
      );
      assert.match(codexManagerSkill, /^---\n/);
      assert.match(codexManagerSkill, /name: sdd-manager/);
      assert.match(codexManagerSkill, /description: "/);
    });

    it('should infer project name from package.json', () => {
      run('init', TEST_PROJECT, { input: '2\n' });
      const spec = fs.readFileSync(
        path.join(TEST_PROJECT, 'opensdd', 'spec.md'),
        'utf-8'
      );
      assert.match(spec, /^# my-test-app/);
    });

    it('should print already initialized when opensdd.json exists', () => {
      run('init', TEST_PROJECT, { input: '2\n' });

      // Running init again should exit early with message
      const output = run('init');
      assert.match(output, /Already initialized/);
      assert.match(output, /opensdd sync/);
    });

    it('should error on malformed opensdd.json', () => {
      fs.writeFileSync(
        path.join(TEST_PROJECT, 'opensdd.json'),
        'not valid json {'
      );
      const result = run('init', TEST_PROJECT, { expectError: true });
      assert.match(result.stderr, /malformed JSON/i);
      assert.equal(result.exitCode, 1);
    });

    it('should initialize as consumer-only', () => {
      const output = run('init', TEST_PROJECT, { input: '1\n' });
      assert.match(output, /Initialized OpenSDD \(consumer\)/);
      assert.match(output, /sdd-manager/);

      // Verify no specsDir in manifest
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.opensdd, '0.1.0');
      assert.equal(manifest.specsDir, undefined);
      assert.equal(manifest.depsDir, '.opensdd.deps');

      // Verify no opensdd/ dir or spec.md
      assert.ok(!fs.existsSync(path.join(TEST_PROJECT, 'opensdd', 'spec.md')));

      // Verify no sdd-generate skill files
      assert.ok(
        !fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-generate', 'SKILL.md')
        )
      );
      assert.ok(
        !fs.existsSync(
          path.join(TEST_PROJECT, '.agents', 'skills', 'sdd-generate', 'SKILL.md')
        )
      );
      assert.ok(
        !fs.existsSync(path.join(TEST_PROJECT, '.cursor', 'rules', 'sdd-generate.md'))
      );

      // Verify no sdd-manager-authoring skill files (consumer mode excludes authoring)
      assert.ok(
        !fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager-authoring', 'SKILL.md')
        )
      );
      assert.ok(
        !fs.existsSync(
          path.join(TEST_PROJECT, '.agents', 'skills', 'sdd-manager-authoring', 'SKILL.md')
        )
      );
      assert.ok(
        !fs.existsSync(
          path.join(TEST_PROJECT, '.cursor', 'rules', 'sdd-manager-authoring.md')
        )
      );
      assert.ok(
        !fs.existsSync(
          path.join(
            TEST_PROJECT,
            '.github',
            'instructions',
            'sdd-manager-authoring.instructions.md'
          )
        )
      );

      // Consumer gate text should mention consuming deps, not "spec-driven development"
      const gate = fs.readFileSync(
        path.join(TEST_PROJECT, '.claude', 'rules', 'opensdd-gate.md'),
        'utf-8'
      );
      assert.match(gate, /consumes OpenSDD dependency specs/);
      assert.doesNotMatch(gate, /spec-driven development/);
      assert.doesNotMatch(gate, /sdd-manager-authoring skill/);

      // Verify sdd-manager IS installed
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager', 'SKILL.md')
        )
      );
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, '.opensdd.deps')));
    });

    it('should print already initialized for consumer project', () => {
      // First init as consumer
      run('init', TEST_PROJECT, { input: '1\n' });

      // Running init again should exit early with message
      const output = run('init');
      assert.match(output, /Already initialized/);
      assert.match(output, /opensdd sync/);
    });

    it('should auto-bootstrap on install without init', () => {
      // No init — just install directly
      const output = run(`install slugify --registry ${TEST_REGISTRY}`);
      assert.match(output, /Auto-initialized OpenSDD \(consumer\)/);
      assert.match(output, /Installed slugify/);

      // Verify consumer manifest
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.specsDir, undefined);
      assert.ok(manifest.dependencies.slugify);

      // Verify sdd-manager installed
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager', 'SKILL.md')
        )
      );
    });

    it('should create root manifest in monorepo sub-project', () => {
      // Set up a monorepo: git repo at tmpDir, sub-project at packages/auth
      const monorepoRoot = fs.mkdtempSync(path.join('/tmp', 'opensdd-monorepo-'));
      execSync('git init', { cwd: monorepoRoot, stdio: 'ignore' });
      const subProject = path.join(monorepoRoot, 'packages', 'auth');
      fs.mkdirSync(subProject, { recursive: true });
      fs.writeFileSync(
        path.join(subProject, 'package.json'),
        JSON.stringify({ name: '@myorg/auth' })
      );

      // Run opensdd init (full mode) from the sub-project
      const output = run('init', subProject, { input: '2\nn\n' });

      // Verify sub-project manifest created with specsDir
      const subManifest = JSON.parse(
        fs.readFileSync(path.join(subProject, 'opensdd.json'), 'utf-8')
      );
      assert.equal(subManifest.opensdd, '0.1.0');
      assert.equal(subManifest.specsDir, 'opensdd');

      // Verify root manifest created with minimal content
      const rootManifest = JSON.parse(
        fs.readFileSync(path.join(monorepoRoot, 'opensdd.json'), 'utf-8')
      );
      assert.deepEqual(rootManifest, { opensdd: '0.1.0' });

      // Verify output mentions root manifest creation
      assert.match(output, /opensdd\.json \(repo root\)\s+created \(workspace root\)/);

      // Cleanup
      fs.rmSync(monorepoRoot, { recursive: true, force: true });
    });

    it('should preserve existing root manifest in monorepo sub-project', () => {
      // Set up a monorepo with an existing root manifest
      const monorepoRoot = fs.mkdtempSync(path.join('/tmp', 'opensdd-monorepo-'));
      execSync('git init', { cwd: monorepoRoot, stdio: 'ignore' });
      const subProject = path.join(monorepoRoot, 'packages', 'auth');
      fs.mkdirSync(subProject, { recursive: true });
      fs.writeFileSync(
        path.join(subProject, 'package.json'),
        JSON.stringify({ name: '@myorg/auth' })
      );

      // Create root manifest with extra content before running init
      const rootManifestPath = path.join(monorepoRoot, 'opensdd.json');
      fs.writeFileSync(
        rootManifestPath,
        JSON.stringify({ opensdd: '0.1.0', custom: true }, null, 2) + '\n'
      );

      // Run opensdd init (full mode) from the sub-project
      const output = run('init', subProject, { input: '2\nn\n' });

      // Verify root manifest is untouched (still has custom: true)
      const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf-8'));
      assert.equal(rootManifest.opensdd, '0.1.0');
      assert.equal(rootManifest.custom, true);

      // Verify output says preserved, not created
      assert.match(output, /opensdd\.json \(repo root\)\s+already exists \(preserved\)/);

      // Cleanup
      fs.rmSync(monorepoRoot, { recursive: true, force: true });
    });
  });

  describe('sync', () => {
    beforeEach(() => {
      setupTestProject();
    });

    it('should update skill files in a full-mode project', () => {
      // First init as OpenSDD-driven
      run('init', TEST_PROJECT, { input: '2\n' });

      // Run sync
      const output = run('sync', TEST_PROJECT, { input: 'n\n' });
      assert.match(output, /Synced OpenSDD/);
      assert.match(output, /sdd-manager\s+updated \(6 agent formats\)/);
      assert.match(output, /sdd-manager-authoring\s+updated \(6 agent formats\)/);
      assert.match(output, /sdd-generate\s+updated \(6 agent formats\)/);

      // Verify skill files still exist
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager', 'SKILL.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager-authoring', 'SKILL.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-generate', 'SKILL.md')
        )
      );

      // Full-mode gate text should include both consumer text and authoring addendum
      const gate = fs.readFileSync(
        path.join(TEST_PROJECT, '.claude', 'rules', 'opensdd-gate.md'),
        'utf-8'
      );
      assert.match(gate, /consumes OpenSDD dependency specs/);
      assert.match(gate, /sdd-manager-authoring skill/);
    });

    it('should update skill files in a consumer-mode project', () => {
      // First init as consumer
      run('init', TEST_PROJECT, { input: '1\n' });

      // Run sync
      const output = run('sync');
      assert.match(output, /Synced OpenSDD/);
      assert.match(output, /sdd-manager\s+updated \(6 agent formats\)/);

      // Consumer mode should NOT have sdd-generate or sdd-manager-authoring in output
      assert.doesNotMatch(output, /sdd-generate/);
      assert.doesNotMatch(output, /sdd-manager-authoring/);

      // Verify sdd-manager installed
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager', 'SKILL.md')
        )
      );
    });

    it('should fail in uninitialized project', () => {
      const result = run('sync', TEST_PROJECT, { expectError: true });
      assert.match(result.stderr, /not initialized/i);
      assert.equal(result.exitCode, 1);
    });

    it('should prune orphan skills when mode downgrades from full to consumer', () => {
      // Init as full mode
      run('init', TEST_PROJECT, { input: '2\n' });

      // Verify full-mode skills are present
      const orphanPaths = [
        path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager-authoring'),
        path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-generate'),
        path.join(TEST_PROJECT, '.agents', 'skills', 'sdd-manager-authoring'),
        path.join(TEST_PROJECT, '.agents', 'skills', 'sdd-generate'),
        path.join(TEST_PROJECT, '.cursor', 'rules', 'sdd-manager-authoring.md'),
        path.join(TEST_PROJECT, '.cursor', 'rules', 'sdd-generate.md'),
        path.join(TEST_PROJECT, '.github', 'instructions', 'sdd-manager-authoring.instructions.md'),
        path.join(TEST_PROJECT, '.github', 'instructions', 'sdd-generate.instructions.md'),
      ];
      for (const p of orphanPaths) {
        assert.ok(fs.existsSync(p), `expected ${p} to exist after full init`);
      }

      // Downgrade to consumer by removing specsDir from opensdd.json
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      delete manifest.specsDir;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      // Run sync — should prune orphans
      run('sync');

      // Verify orphan files are gone
      for (const p of orphanPaths) {
        assert.ok(!fs.existsSync(p), `expected ${p} to be pruned after consumer sync`);
      }

      // Verify sdd-manager still installed across formats
      assert.ok(
        fs.existsSync(path.join(TEST_PROJECT, '.claude', 'skills', 'sdd-manager', 'SKILL.md'))
      );
      assert.ok(
        fs.existsSync(path.join(TEST_PROJECT, '.cursor', 'rules', 'sdd-manager.md'))
      );
    });

    it('should not modify opensdd.json', () => {
      run('init', TEST_PROJECT, { input: '2\n' });

      // Modify opensdd.json with custom field
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.registry = 'https://github.com/custom/registry';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      // Run sync
      run('sync', TEST_PROJECT, { input: 'n\n' });

      // Verify opensdd.json preserved
      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.equal(updated.registry, 'https://github.com/custom/registry');
      assert.equal(updated.specsDir, 'opensdd');
    });

    it('should preserve GEMINI.md user content', () => {
      fs.writeFileSync(
        path.join(TEST_PROJECT, 'GEMINI.md'),
        '# My Custom Instructions\n\nDo things.\n'
      );
      run('init', TEST_PROJECT, { input: '2\n' });

      // Run sync to update skill files
      run('sync', TEST_PROJECT, { input: 'n\n' });

      const gemini = fs.readFileSync(
        path.join(TEST_PROJECT, 'GEMINI.md'),
        'utf-8'
      );
      assert.match(gemini, /# My Custom Instructions/);
      assert.match(gemini, /OpenSDD Skills/);
      assert.match(gemini, /@\.claude\/skills\/sdd-manager\/SKILL\.md/);
    });

    it('should work in monorepo sub-project', () => {
      const monorepoRoot = fs.mkdtempSync(path.join('/tmp', 'opensdd-monorepo-'));
      execSync('git init', { cwd: monorepoRoot, stdio: 'ignore' });
      const subProject = path.join(monorepoRoot, 'packages', 'auth');
      fs.mkdirSync(subProject, { recursive: true });
      fs.writeFileSync(
        path.join(subProject, 'package.json'),
        JSON.stringify({ name: '@myorg/auth' })
      );

      // Init from sub-project
      run('init', subProject, { input: '2\nn\n' });

      // Run sync from sub-project
      const output = run('sync', subProject, { input: 'n\n' });
      assert.match(output, /Synced OpenSDD/);
      assert.match(output, /sdd-manager\s+updated/);

      // Verify skills at repo root
      assert.ok(
        fs.existsSync(
          path.join(monorepoRoot, '.claude', 'skills', 'sdd-manager', 'SKILL.md')
        )
      );

      // Cleanup
      fs.rmSync(monorepoRoot, { recursive: true, force: true });
    });

    it('should overwrite existing workflow files', () => {
      run('init', TEST_PROJECT, { input: '2\n' });

      // Create workflow files with stale content
      const workflowDir = path.join(TEST_PROJECT, '.github', 'workflows');
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, 'spec-merged.yml'), 'old-content');
      fs.writeFileSync(path.join(workflowDir, 'claude-implement.yml'), 'old-content');

      // Run sync — should overwrite both
      const output = run('sync', TEST_PROJECT);
      assert.match(output, /Workflows:/);
      assert.match(output, /spec-merged\.yml\s+updated/);
      assert.match(output, /claude-implement\.yml\s+updated/);

      // Verify content was overwritten with bundled versions
      const specMerged = fs.readFileSync(path.join(workflowDir, 'spec-merged.yml'), 'utf-8');
      assert.notEqual(specMerged, 'old-content');
      assert.match(specMerged, /OpenSDD/);

      const claudeImpl = fs.readFileSync(path.join(workflowDir, 'claude-implement.yml'), 'utf-8');
      assert.notEqual(claudeImpl, 'old-content');
      assert.match(claudeImpl, /OpenSDD/);
    });

    it('should only overwrite workflow files that exist', () => {
      run('init', TEST_PROJECT, { input: '2\n' });

      // Create only one workflow file
      const workflowDir = path.join(TEST_PROJECT, '.github', 'workflows');
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, 'claude-implement.yml'), 'old-content');

      // Run sync — should only overwrite the one that exists
      const output = run('sync', TEST_PROJECT);
      assert.match(output, /Workflows:/);
      assert.match(output, /claude-implement\.yml\s+updated/);
      assert.doesNotMatch(output, /spec-merged\.yml/);

      // Verify spec-merged.yml was NOT created
      assert.ok(!fs.existsSync(path.join(workflowDir, 'spec-merged.yml')));
    });

    it('should not create workflow files when none exist', () => {
      run('init', TEST_PROJECT, { input: '2\n' });

      // Ensure no workflow files exist (but .github/workflows/ dir exists)
      const workflowDir = path.join(TEST_PROJECT, '.github', 'workflows');
      fs.mkdirSync(workflowDir, { recursive: true });

      // Run sync — should not create workflow files and should not show Workflows section
      const output = run('sync', TEST_PROJECT, { input: 'n\n' });
      assert.doesNotMatch(output, /Workflows:/);

      // Verify no workflow files were created
      assert.ok(!fs.existsSync(path.join(workflowDir, 'spec-merged.yml')));
      assert.ok(!fs.existsSync(path.join(workflowDir, 'claude-implement.yml')));
    });
  });

  describe('list', () => {
    it('should list specs from local registry', () => {
      const output = run(`list --registry ${TEST_REGISTRY}`, '/tmp');
      assert.match(output, /Available specs/);
      assert.match(output, /slugify/);
      assert.match(output, /with-deps/);
    });
  });

  describe('install', () => {
    beforeEach(() => {
      setupTestProject();
      run('init', TEST_PROJECT, { input: '2\n' });
    });

    it('should install a spec at latest version', () => {
      const output = run(`install slugify --registry ${TEST_REGISTRY}`);
      assert.match(output, /Installed slugify v1\.1\.0/);

      // Verify files
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.opensdd.deps', 'slugify', 'spec.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(TEST_PROJECT, '.opensdd.deps', 'slugify', 'manifest.json')
        )
      );

      // Verify manifest entry
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.dependencies.slugify.version, '1.1.0');
      assert.equal(manifest.dependencies.slugify.implementedVersion, null);
      assert.equal(manifest.dependencies.slugify.tests, null);
      assert.equal(manifest.dependencies.slugify.hasDeviations, false);
    });

    it('should install a spec at a specific version', () => {
      const output = run(`install slugify 1.0.0 --registry ${TEST_REGISTRY}`);
      assert.match(output, /Installed slugify v1\.0\.0/);
    });

    it('should reject already installed spec', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      const result = run(`install slugify --registry ${TEST_REGISTRY}`, TEST_PROJECT, {
        expectError: true,
      });
      assert.match(result.stderr, /already installed/);
      assert.equal(result.exitCode, 1);
    });

    it('should reject invalid spec names', () => {
      const result = run(`install UPPER --registry ${TEST_REGISTRY}`, TEST_PROJECT, {
        expectError: true,
      });
      assert.match(result.stderr, /Invalid spec name/);
    });

    it('should reject non-existent spec', () => {
      const result = run(
        `install nope --registry ${TEST_REGISTRY}`,
        TEST_PROJECT,
        { expectError: true }
      );
      assert.match(result.stderr, /not found in registry/);
    });

    it('should reject non-existent version', () => {
      const result = run(
        `install slugify 9.9.9 --registry ${TEST_REGISTRY}`,
        TEST_PROJECT,
        { expectError: true }
      );
      assert.match(result.stderr, /Version 9\.9\.9 not found/);
    });

    it('should warn about missing dependencies', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      const output = run(`install with-deps --registry ${TEST_REGISTRY}`);
      assert.match(output, /missing-dep/);
    });

    it('should re-install when entry exists but directory is missing', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      fs.rmSync(path.join(TEST_PROJECT, '.opensdd.deps', 'slugify'), {
        recursive: true,
      });
      const output = run(`install slugify --registry ${TEST_REGISTRY}`);
      assert.match(output, /stale entry/);
      assert.match(output, /Installed slugify/);
    });

    it('should auto-bootstrap when opensdd not initialized', () => {
      fs.rmSync(path.join(TEST_PROJECT, 'opensdd.json'));
      const output = run(`install slugify --registry ${TEST_REGISTRY}`);
      assert.match(output, /Auto-initialized OpenSDD \(consumer\)/);
      assert.match(output, /Installed slugify/);

      // Verify consumer opensdd.json created
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.opensdd, '0.1.0');
      assert.equal(manifest.specsDir, undefined);
      assert.equal(manifest.depsDir, '.opensdd.deps');
      assert.ok(manifest.dependencies.slugify);
    });

    it('should drop legacy implementation field on re-install of stale entry', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      // Inject legacy implementation field
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.dependencies.slugify.implementation = 'src/slugify.js';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      // Remove directory to trigger stale re-install
      fs.rmSync(path.join(TEST_PROJECT, '.opensdd.deps', 'slugify'), { recursive: true });
      run(`install slugify --registry ${TEST_REGISTRY}`);

      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.equal(updated.dependencies.slugify.implementation, undefined);
      assert.equal(updated.dependencies.slugify.implementedVersion, null);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      setupTestProject();
      run('init', TEST_PROJECT, { input: '2\n' });
      run(`install slugify 1.0.0 --registry ${TEST_REGISTRY}`);
    });

    it('should update a single spec', () => {
      const output = run(`update slugify --registry ${TEST_REGISTRY}`);
      assert.match(output, /Updated slugify: v1\.0\.0 -> v1\.1\.0/);
      assert.match(output, /changeset\.md/);
      assert.match(output, /manifest\.json/);

      // Verify staging files
      const updatesDir = path.join(
        TEST_PROJECT,
        '.opensdd.deps',
        '.updates',
        'slugify'
      );
      assert.ok(fs.existsSync(path.join(updatesDir, 'changeset.md')));
      assert.ok(fs.existsSync(path.join(updatesDir, 'manifest.json')));

      // Verify opensdd.json NOT modified
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.dependencies.slugify.version, '1.0.0');
    });

    it('should report already up to date', () => {
      run(`update slugify --registry ${TEST_REGISTRY}`);
      // Apply the update
      execSync(
        `echo "y" | node ${CLI} update apply slugify`,
        { cwd: TEST_PROJECT, encoding: 'utf-8' }
      );
      // Try updating again
      const output = run(`update slugify --registry ${TEST_REGISTRY}`);
      assert.match(output, /already up to date/);
    });

    it('should not overwrite deviations.md', () => {
      const deviationsPath = path.join(
        TEST_PROJECT,
        '.opensdd.deps',
        'slugify',
        'deviations.md'
      );
      fs.writeFileSync(deviationsPath, '## My Deviation (behavior-modified)\n');
      run(`update slugify --registry ${TEST_REGISTRY}`);
      assert.ok(fs.existsSync(deviationsPath));
      const content = fs.readFileSync(deviationsPath, 'utf-8');
      assert.match(content, /My Deviation/);
    });

    it('should error for uninstalled spec', () => {
      const result = run(`update nope --registry ${TEST_REGISTRY}`, TEST_PROJECT, {
        expectError: true,
      });
      assert.match(result.stderr, /not installed/);
    });

    it('should generate changeset with diffs', () => {
      run(`update slugify --registry ${TEST_REGISTRY}`);
      const changeset = fs.readFileSync(
        path.join(
          TEST_PROJECT,
          '.opensdd.deps',
          '.updates',
          'slugify',
          'changeset.md'
        ),
        'utf-8'
      );
      assert.match(changeset, /Previous version.*1\.0\.0/);
      assert.match(changeset, /New version.*1\.1\.0/);
      assert.match(changeset, /```diff/);
    });
  });

  describe('update apply', () => {
    beforeEach(() => {
      setupTestProject();
      run('init', TEST_PROJECT, { input: '2\n' });
      run(`install slugify 1.0.0 --registry ${TEST_REGISTRY}`);
      run(`update slugify --registry ${TEST_REGISTRY}`);
    });

    it('should apply a pending update', () => {
      const output = execSync(
        `echo "y" | node ${CLI} update apply slugify`,
        { cwd: TEST_PROJECT, encoding: 'utf-8' }
      );
      assert.match(output, /Applied update for slugify/);

      // Verify opensdd.json updated
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.dependencies.slugify.version, '1.1.0');

      // Verify staging cleaned up
      assert.ok(
        !fs.existsSync(
          path.join(TEST_PROJECT, '.opensdd.deps', '.updates', 'slugify')
        )
      );
    });

    it('should preserve consumer-managed fields', () => {
      // Set consumer fields
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.dependencies.slugify.implementedVersion = '1.0.0';
      manifest.dependencies.slugify.tests = 'test/slugify.test.js';
      manifest.dependencies.slugify.hasDeviations = true;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      execSync(`echo "y" | node ${CLI} update apply slugify`, {
        cwd: TEST_PROJECT,
        encoding: 'utf-8',
      });

      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.equal(updated.dependencies.slugify.version, '1.1.0');
      assert.equal(updated.dependencies.slugify.implementedVersion, '1.0.0');
      assert.equal(updated.dependencies.slugify.tests, 'test/slugify.test.js');
      assert.equal(updated.dependencies.slugify.hasDeviations, true);
    });

    it('should drop legacy implementation field on update apply', () => {
      // Inject legacy implementation field
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.dependencies.slugify.implementation = 'src/slugify.js';
      delete manifest.dependencies.slugify.implementedVersion;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      execSync(`echo "y" | node ${CLI} update apply slugify`, {
        cwd: TEST_PROJECT,
        encoding: 'utf-8',
      });

      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.equal(updated.dependencies.slugify.implementation, undefined);
      assert.equal(updated.dependencies.slugify.implementedVersion, null);
    });

    it('should handle no pending updates', () => {
      execSync(`echo "y" | node ${CLI} update apply slugify`, {
        cwd: TEST_PROJECT,
        encoding: 'utf-8',
      });
      const output = run('update apply', TEST_PROJECT);
      assert.match(output, /No pending updates/);
    });

    it('should error for specific non-pending spec', () => {
      execSync(`echo "y" | node ${CLI} update apply slugify`, {
        cwd: TEST_PROJECT,
        encoding: 'utf-8',
      });
      const result = run('update apply slugify', TEST_PROJECT, {
        expectError: true,
      });
      assert.match(result.stderr, /No pending update/);
    });
  });

  describe('status', () => {
    beforeEach(() => {
      setupTestProject();
      run('init', TEST_PROJECT, { input: '2\n' });
    });

    it('should show no specs when none installed', () => {
      const output = run('status');
      assert.match(output, /No specs found/);
    });

    it('should show installed dependencies', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      const output = run('status');
      assert.match(output, /Installed dependencies/);
      assert.match(output, /slugify/);
      assert.match(output, /not implemented/);
    });

    it('should show implemented status with version when implementedVersion matches version', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.dependencies.slugify.implementedVersion = '1.1.0';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      const output = run('status');
      assert.match(output, /implemented v1\.1\.0/);
    });

    it('should show stale status when implementedVersion differs from version', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.dependencies.slugify.implementedVersion = '1.0.0';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      const output = run('status');
      assert.match(output, /stale \(impl v1\.0\.0\)/);
    });

    it('should show authored spec when publish is configured', () => {
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.publish = {
        name: 'my-spec',
        version: '1.0.0',
        description: 'My test spec',
        specFormat: '0.1.0',
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      const output = run('status');
      assert.match(output, /Authored spec/);
      assert.match(output, /my-spec/);
      assert.match(output, /v1\.0\.0/);
    });

    it('should warn about untracked directories', () => {
      fs.mkdirSync(path.join(TEST_PROJECT, '.opensdd.deps', 'phantom'), {
        recursive: true,
      });
      run(`install slugify --registry ${TEST_REGISTRY}`);
      const output = run('status');
      assert.match(output, /Untracked spec directories/);
      assert.match(output, /phantom/);
    });

    it('should error when not initialized', () => {
      fs.rmSync(path.join(TEST_PROJECT, 'opensdd.json'));
      const output = run('status');
      assert.match(output, /not initialized/i);
    });
  });

  describe('validate', () => {
    beforeEach(() => {
      setupTestProject();
      run('init', TEST_PROJECT, { input: '2\n' });
    });

    it('should validate a valid spec', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      const output = run('validate .opensdd.deps/slugify');
      assert.match(output, /Validated slugify/);
      assert.match(output, /spec\.md structure\s+ok/);
      assert.match(output, /Valid/);
    });

    it('should warn about missing recommended sections', () => {
      // Create a minimal spec
      const minimalDir = path.join(TEST_PROJECT, 'minimal-spec');
      fs.mkdirSync(minimalDir);
      fs.writeFileSync(
        path.join(minimalDir, 'spec.md'),
        '# Minimal\n\n> A minimal spec.\n\n## Behavioral Contract\n\nDoes stuff.\n'
      );
      const output = run('validate minimal-spec');
      assert.match(output, /warning/);
      assert.match(output, /NOT Specified/);
    });

    it('should error for missing spec.md', () => {
      const emptyDir = path.join(TEST_PROJECT, 'empty-spec');
      fs.mkdirSync(emptyDir);
      const result = run('validate empty-spec', TEST_PROJECT, {
        expectError: true,
      });
      assert.match(result.stderr || result.stdout, /Missing required file: spec\.md/);
    });

    it('should error for missing Behavioral Contract', () => {
      const badDir = path.join(TEST_PROJECT, 'bad-spec');
      fs.mkdirSync(badDir);
      fs.writeFileSync(
        path.join(badDir, 'spec.md'),
        '# Bad\n\n> No contract.\n\nJust text.\n'
      );
      const result = run('validate bad-spec', TEST_PROJECT, {
        expectError: true,
      });
      assert.match(
        result.stderr || result.stdout,
        /Behavioral Contract/
      );
    });

    it('should error when deviations.md is present', () => {
      const withDev = path.join(TEST_PROJECT, 'dev-spec');
      fs.mkdirSync(withDev);
      fs.writeFileSync(
        path.join(withDev, 'spec.md'),
        '# Dev\n\n> Has deviations.\n\n## Behavioral Contract\n\nStuff.\n'
      );
      fs.writeFileSync(path.join(withDev, 'deviations.md'), '## Deviation\n');
      const result = run('validate dev-spec', TEST_PROJECT, {
        expectError: true,
      });
      assert.match(result.stderr || result.stdout, /deviations\.md/);
    });

    it('should validate manifest.json when present', () => {
      const specDir = path.join(TEST_PROJECT, 'with-manifest');
      fs.mkdirSync(specDir);
      fs.writeFileSync(
        path.join(specDir, 'spec.md'),
        '# Test\n\n> Test spec.\n\n## Behavioral Contract\n\nBehavior.\n\n## Edge Cases\n\n## NOT Specified (Implementation Freedom)\n\n## Invariants\n'
      );
      fs.writeFileSync(
        path.join(specDir, 'manifest.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          specFormat: '0.1.0',
        })
      );
      const output = run('validate with-manifest');
      assert.match(output, /manifest\.json\s+ok/);
    });

    it('should work from any directory without initialization', () => {
      const anyDir = path.join('/tmp', 'opensdd-validate-any');
      fs.rmSync(anyDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(anyDir, 'opensdd'), { recursive: true });
      fs.writeFileSync(
        path.join(anyDir, 'opensdd', 'spec.md'),
        '# Any\n\n> Works anywhere.\n\n## Behavioral Contract\n\nDoes things.\n'
      );
      const output = run('validate', anyDir);
      assert.match(output, /Validated/);
      fs.rmSync(anyDir, { recursive: true, force: true });
    });
  });

  describe('generateSkillMd', () => {
    it('should generate SKILL.md with frontmatter from spec content', () => {
      const spec = '# Slugify\n\n> String to URL-friendly slug.\n\n## Behavioral Contract\n\nConvert string to slug.\n';
      const result = generateSkillMd(spec);
      assert.match(result, /^---\n/);
      assert.match(result, /name: Slugify/);
      assert.match(result, /description: "String to URL-friendly slug\."/);
      assert.match(result, /---\n# Slugify/);
      assert.match(result, /## Behavioral Contract/);
    });

    it('should escape quotes in description', () => {
      const spec = '# Test\n\n> A "quoted" description.\n\n## Behavioral Contract\n\nStuff.\n';
      const result = generateSkillMd(spec);
      assert.match(result, /description: "A \\"quoted\\" description\."/);
    });

    it('should throw when H1 is missing', () => {
      const spec = '> No header.\n\n## Behavioral Contract\n\nStuff.\n';
      assert.throws(() => generateSkillMd(spec), /H1 header/);
    });

    it('should throw when blockquote is missing', () => {
      const spec = '# Header Only\n\n## Behavioral Contract\n\nStuff.\n';
      assert.throws(() => generateSkillMd(spec), /blockquote description/);
    });
  });

  describe('install (skill mode)', () => {
    beforeEach(() => {
      setupTestProject();
      // Create opensdd.json with installMode: "skill"
      fs.writeFileSync(
        path.join(TEST_PROJECT, 'opensdd.json'),
        JSON.stringify({
          opensdd: '0.1.0',
          depsDir: '.opensdd.deps',
          installMode: 'skill',
        }, null, 2)
      );
      fs.mkdirSync(path.join(TEST_PROJECT, '.opensdd.deps'), { recursive: true });
      // Install opensdd skills so the CLI works
      run('init', TEST_PROJECT, { input: '1\n' });
      // Re-write with skill mode (init overwrites opensdd.json for fresh projects)
      const manifest = JSON.parse(fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8'));
      manifest.installMode = 'skill';
      fs.writeFileSync(
        path.join(TEST_PROJECT, 'opensdd.json'),
        JSON.stringify(manifest, null, 2)
      );
    });

    it('should install a spec as a skill across agent formats', () => {
      const output = run(`install slugify --registry ${TEST_REGISTRY}`);
      assert.match(output, /Installed slugify v1\.1\.0 as skill/);
      assert.match(output, /Skills installed for/);

      // Verify Claude Code skill
      const claudeSkill = path.join(TEST_PROJECT, '.claude', 'skills', 'slugify', 'SKILL.md');
      assert.ok(fs.existsSync(claudeSkill));
      const skillContent = fs.readFileSync(claudeSkill, 'utf-8');
      assert.match(skillContent, /name: Slugify/);
      assert.match(skillContent, /description:/);

      // Verify Codex CLI skill
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, '.agents', 'skills', 'slugify', 'SKILL.md')));

      // Verify Cursor rule
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, '.cursor', 'rules', 'slugify.md')));

      // Verify Copilot instruction
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, '.github', 'instructions', 'slugify.instructions.md')));

      // Verify no spec files in .opensdd.deps
      assert.ok(!fs.existsSync(path.join(TEST_PROJECT, '.opensdd.deps', 'slugify')));

      // Verify manifest entry has mode: "skill" and no consumer-managed fields
      const manifest = JSON.parse(fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8'));
      assert.equal(manifest.dependencies.slugify.version, '1.1.0');
      assert.equal(manifest.dependencies.slugify.mode, 'skill');
      assert.equal(manifest.dependencies.slugify.implementedVersion, undefined);
    });

    it('should reject already installed spec in skill mode', () => {
      run(`install slugify --registry ${TEST_REGISTRY}`);
      const result = run(`install slugify --registry ${TEST_REGISTRY}`, TEST_PROJECT, {
        expectError: true,
      });
      assert.match(result.stderr, /already installed/);
      assert.equal(result.exitCode, 1);
    });

    it('should generate SKILL.md when not present in registry', () => {
      // with-deps has no SKILL.md — should be generated from spec.md
      const output = run(`install with-deps --registry ${TEST_REGISTRY}`);
      assert.match(output, /Installed with-deps v1\.0\.0 as skill/);

      const claudeSkill = path.join(TEST_PROJECT, '.claude', 'skills', 'with-deps', 'SKILL.md');
      assert.ok(fs.existsSync(claudeSkill));
      const content = fs.readFileSync(claudeSkill, 'utf-8');
      assert.match(content, /name: With Deps/);
    });
  });

  describe('install --skill flag', () => {
    beforeEach(() => {
      setupTestProject();
      run('init', TEST_PROJECT, { input: '1\n' });
    });

    it('should install as skill when --skill flag is passed', () => {
      const output = run(`install slugify --skill --registry ${TEST_REGISTRY}`);
      assert.match(output, /Installed slugify v1\.1\.0 as skill/);

      // Verify skill files exist
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, '.claude', 'skills', 'slugify', 'SKILL.md')));

      // Verify no spec files in .opensdd.deps
      assert.ok(!fs.existsSync(path.join(TEST_PROJECT, '.opensdd.deps', 'slugify')));

      // Verify manifest entry
      const manifest = JSON.parse(fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8'));
      assert.equal(manifest.dependencies.slugify.mode, 'skill');
    });

    it('should override manifest installMode with --skill flag', () => {
      // Manifest has no installMode (defaults to "default"), but --skill overrides
      const manifest = JSON.parse(fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8'));
      assert.equal(manifest.installMode, undefined);

      const output = run(`install slugify --skill --registry ${TEST_REGISTRY}`);
      assert.match(output, /as skill/);
    });

    it('should auto-bootstrap with installMode skill when --skill passed', () => {
      fs.rmSync(path.join(TEST_PROJECT, 'opensdd.json'));
      const output = run(`install slugify --skill --registry ${TEST_REGISTRY}`);
      assert.match(output, /Auto-initialized OpenSDD/);
      assert.match(output, /as skill/);

      const manifest = JSON.parse(fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8'));
      assert.equal(manifest.installMode, 'skill');
    });
  });

  describe('publish SKILL.md generation', () => {
    const PUBLISH_PROJECT = path.join('/tmp', 'opensdd-publish-skill-test');

    beforeEach(() => {
      fs.rmSync(PUBLISH_PROJECT, { recursive: true, force: true });
      fs.mkdirSync(PUBLISH_PROJECT, { recursive: true });
    });

    after(() => {
      fs.rmSync(PUBLISH_PROJECT, { recursive: true, force: true });
    });

    it('should generate SKILL.md in registry version dir and skills dir', () => {
      // Simulate what publish does after copyDirRecursive + manifest write:
      // Set up a mock registry dir and specs dir
      const specsSrc = path.join(PUBLISH_PROJECT, 'opensdd');
      fs.mkdirSync(specsSrc, { recursive: true });
      fs.writeFileSync(
        path.join(specsSrc, 'spec.md'),
        '# My Spec\n\n> A test spec for publish.\n\n## Behavioral Contract\n\nDoes things.\n'
      );
      fs.writeFileSync(path.join(specsSrc, 'clients.md'), '# Clients\n\nClient docs.\n');
      fs.writeFileSync(path.join(specsSrc, 'safety.md'), '# Safety\n\nSafety docs.\n');

      // Simulate registry dir (what copyDirRecursive would produce)
      const registryDir = path.join(PUBLISH_PROJECT, 'registry', 'my-spec', '1.0.0');
      fs.mkdirSync(registryDir, { recursive: true });
      fs.copyFileSync(path.join(specsSrc, 'spec.md'), path.join(registryDir, 'spec.md'));

      // Run the skill generation logic inline (same as publish.js)
      const specContent = fs.readFileSync(path.join(registryDir, 'spec.md'), 'utf-8');
      const skillMd = generateSkillMd(specContent);

      // Write archival copy
      fs.writeFileSync(path.join(registryDir, 'SKILL.md'), skillMd);

      // Write to skills/<name>/
      const skillsDir = path.join(PUBLISH_PROJECT, 'skills', 'my-spec');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), skillMd);

      // Copy supplementary files
      const skipFiles = new Set(['spec.md', 'manifest.json', 'SKILL.md']);
      const skipDirs = new Set(['skills', '.changes']);
      const entries = fs.readdirSync(specsSrc, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !skipDirs.has(entry.name)) continue;
        if (!entry.isDirectory() && !skipFiles.has(entry.name) && entry.name.endsWith('.md')) {
          fs.copyFileSync(path.join(specsSrc, entry.name), path.join(skillsDir, entry.name));
        }
      }

      // Write README
      fs.writeFileSync(
        path.join(PUBLISH_PROJECT, 'skills', 'README.md'),
        '# Skills\n\nThis directory is **auto-generated** by `opensdd publish`. Do not edit files here directly — they will be overwritten on the next publish.\n\nTo modify a skill, edit the source spec and re-publish.\n'
      );

      // Assertions
      // 1. Archival SKILL.md in registry version dir
      assert.ok(fs.existsSync(path.join(registryDir, 'SKILL.md')));
      const archival = fs.readFileSync(path.join(registryDir, 'SKILL.md'), 'utf-8');
      assert.match(archival, /name: My Spec/);
      assert.match(archival, /description: "A test spec for publish\."/);

      // 2. SKILL.md in skills/<name>/
      assert.ok(fs.existsSync(path.join(skillsDir, 'SKILL.md')));
      const skill = fs.readFileSync(path.join(skillsDir, 'SKILL.md'), 'utf-8');
      assert.equal(skill, archival);

      // 3. Supplementary files copied
      assert.ok(fs.existsSync(path.join(skillsDir, 'clients.md')));
      assert.ok(fs.existsSync(path.join(skillsDir, 'safety.md')));

      // 4. spec.md NOT copied to skills dir
      assert.ok(!fs.existsSync(path.join(skillsDir, 'spec.md')));

      // 5. README exists in skills/
      assert.ok(fs.existsSync(path.join(PUBLISH_PROJECT, 'skills', 'README.md')));
      const readme = fs.readFileSync(path.join(PUBLISH_PROJECT, 'skills', 'README.md'), 'utf-8');
      assert.match(readme, /auto-generated/);
    });
  });

  describe('publish interactive prompting', () => {
    beforeEach(() => {
      setupTestProject();
      run('init', TEST_PROJECT, { input: '2\n' });
    });

    it('should prompt for all missing publish fields and write them to opensdd.json', () => {
      // No publish section, no spec.md — will fail at spec.md check, but manifest should be updated
      const input = 'my-pkg\n1.0.0\nA cool spec\n0.1.0\n';
      const result = run('publish --registry https://github.com/fake/reg', TEST_PROJECT, {
        expectError: true,
        input,
      });
      // It will fail because spec.md doesn't exist, but publish fields should be written
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.publish.name, 'my-pkg');
      assert.equal(manifest.publish.version, '1.0.0');
      assert.equal(manifest.publish.description, 'A cool spec');
      assert.equal(manifest.publish.specFormat, '0.1.0');
    });

    it('should only prompt for missing fields when some are already present', () => {
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.publish = { name: 'existing-name', version: '2.0.0' };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      // Only description and specFormat are missing, so provide just those
      const input = 'My description\n0.1.0\n';
      const result = run('publish --registry https://github.com/fake/reg', TEST_PROJECT, {
        expectError: true,
        input,
      });
      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.equal(updated.publish.name, 'existing-name');
      assert.equal(updated.publish.version, '2.0.0');
      assert.equal(updated.publish.description, 'My description');
      assert.equal(updated.publish.specFormat, '0.1.0');
    });

    it('should preserve existing manifest fields when writing publish section', () => {
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.customField = 'preserved';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      const input = 'my-pkg\n1.0.0\nA spec\n0.1.0\n';
      run('publish --registry https://github.com/fake/reg', TEST_PROJECT, {
        expectError: true,
        input,
      });
      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.equal(updated.customField, 'preserved');
      assert.equal(updated.publish.name, 'my-pkg');
    });

    it('should exit with code 1 on EOF during prompting', () => {
      // Send empty stdin (EOF immediately)
      const result = run('publish --registry https://github.com/fake/reg', TEST_PROJECT, {
        expectError: true,
        input: '',
      });
      assert.equal(result.exitCode, 1);
    });

    it('should skip prompting when all publish fields are present', () => {
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.publish = {
        name: 'full-spec',
        version: '1.0.0',
        description: 'Fully specified',
        specFormat: '0.1.0',
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      // No stdin needed — all fields present. Will fail at spec.md check or later.
      const result = run('publish --registry https://github.com/fake/reg', TEST_PROJECT, {
        expectError: true,
        input: '',
      });
      // Should get past prompting — verify it didn't prompt by checking output doesn't contain prompt text
      const output = (result.stderr || '') + (result.stdout || '');
      assert.ok(!output.includes('Spec name'), 'should not prompt for name');
      assert.ok(!output.includes('Version (semver'), 'should not prompt for version');
      assert.ok(!output.includes('Description:'), 'should not prompt for description');
    });

    it('should re-prompt when user provides empty input for a required field', () => {
      // First line is empty (re-prompt for name), second is valid name, then rest of fields
      const input = '\nmy-pkg\n1.0.0\nA spec\n0.1.0\n';
      const result = run('publish --registry https://github.com/fake/reg', TEST_PROJECT, {
        expectError: true,
        input,
      });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.publish.name, 'my-pkg');
    });
  });
});

describe('readWorkflowFile', () => {
  it('should return bundled workflow content matching the source files', () => {
    for (const name of WORKFLOW_NAMES) {
      const content = readWorkflowFile(name);
      assert.ok(content.length > 0, `${name} should not be empty`);
      assert.match(content, /^name:/, `${name} should start with name:`);
    }
  });

  it('should return claude-implement.yml with both implement and claude jobs', () => {
    const content = readWorkflowFile('claude-implement.yml');

    assert.match(content, /^\s+implement:/m);
    assert.match(content, /^\s+claude:/m);
  });

  it('should return claude-implement.yml with context detection for three modes', () => {
    const content = readWorkflowFile('claude-implement.yml');

    // Verify context detection step
    assert.match(content, /Detect context/);

    // Three modes: pr, issue-with-pr, issue-no-pr
    assert.match(content, /'pr'/);
    assert.match(content, /'issue-with-pr'/);
    assert.match(content, /'issue-no-pr'/);
  });
});

describe('sdd-manager-authoring Propose: routing', () => {
  it('should include Propose: prefix in authoring skill description', () => {
    const skillPath = path.resolve('opensdd/skills/sdd-manager-authoring.md');
    const content = fs.readFileSync(skillPath, 'utf-8');

    // Verify the description includes Propose: prefix routing
    assert.match(content, /prefixes a message with 'Propose:'/);
  });

  it('should route Propose: prefixed messages to the Propose workflow', () => {
    const skillPath = path.resolve('opensdd/skills/sdd-manager-authoring.md');
    const content = fs.readFileSync(skillPath, 'utf-8');

    // Verify Propose: MUST be routed
    assert.match(content, /A message prefixed with "Propose:" MUST be routed to the Propose workflow/);
  });

  it('should install sdd-manager-authoring with Propose: routing via full-mode init', () => {
    const testDir = path.join('/tmp', 'opensdd-test-propose');
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });
    execSync('git init', { cwd: testDir, stdio: 'ignore' });
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'propose-test' })
    );

    execSync(`node ${CLI} init`, {
      cwd: testDir,
      encoding: 'utf-8',
      input: '2\n',
      timeout: 15000,
    });

    // Verify installed authoring skill includes Propose: routing
    const authoringSkill = fs.readFileSync(
      path.join(testDir, '.claude', 'skills', 'sdd-manager-authoring', 'SKILL.md'),
      'utf-8'
    );
    assert.match(authoringSkill, /Propose:/);

    fs.rmSync(testDir, { recursive: true, force: true });
  });
});

// ---- setup-ci tests (appended outside main describe) ----

const SETUP_CI_PROJECT = path.join('/tmp', 'opensdd-test-setup-ci');
const MOCK_BIN_DIR = path.join('/tmp', 'opensdd-test-mock-bin');

function setupMockGh() {
  fs.mkdirSync(MOCK_BIN_DIR, { recursive: true });
  // Mock gh script that handles all subcommands without network calls
  const mockGh = `#!/bin/sh
case "$*" in
  --version) echo "gh version 2.50.0 (mock)" ;;
  "auth status") exit 0 ;;
  "repo view --json nameWithOwner -q .nameWithOwner") echo "test-owner/test-repo" ;;
  "secret list") echo "" ;;
  label\\ create*) echo "label created" ;;
  *) echo "mock gh: unhandled: $*" >&2; exit 1 ;;
esac
`;
  const mockGhPath = path.join(MOCK_BIN_DIR, 'gh');
  fs.writeFileSync(mockGhPath, mockGh);
  fs.chmodSync(mockGhPath, 0o755);

  // Mock claude script for --dry-run without --skip-token
  const mockClaude = `#!/bin/sh
case "$*" in
  --version) echo "claude 1.0.0 (mock)" ;;
  setup-token) echo "mock-token-value" ;;
  *) echo "mock claude: unhandled: $*" >&2; exit 1 ;;
esac
`;
  const mockClaudePath = path.join(MOCK_BIN_DIR, 'claude');
  fs.writeFileSync(mockClaudePath, mockClaude);
  fs.chmodSync(mockClaudePath, 0o755);
}

function setupCiProject() {
  fs.rmSync(SETUP_CI_PROJECT, { recursive: true, force: true });
  fs.mkdirSync(SETUP_CI_PROJECT, { recursive: true });
  setupMockGh();
  execSync('git init', { cwd: SETUP_CI_PROJECT, stdio: 'ignore' });
  execSync('git remote add origin git@github.com:deepagents-ai/OpenSDD.git', {
    cwd: SETUP_CI_PROJECT,
    stdio: 'ignore',
  });
  fs.writeFileSync(
    path.join(SETUP_CI_PROJECT, 'package.json'),
    JSON.stringify({ name: 'ci-test-app' })
  );
  // Initialize opensdd (full mode)
  execSync(`node ${CLI} init`, {
    cwd: SETUP_CI_PROJECT,
    encoding: 'utf-8',
    input: '2\nn\n',
    timeout: 15000,
  });
}

function runCi(args, opts = {}) {
  try {
    return execSync(`node ${CLI} ${args}`, {
      cwd: SETUP_CI_PROJECT,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${MOCK_BIN_DIR}:${process.env.PATH}`, ...opts.env },
      input: opts.input,
      timeout: 15000,
    });
  } catch (err) {
    if (opts.expectError) {
      return { stderr: err.stderr, stdout: err.stdout, exitCode: err.status };
    }
    throw err;
  }
}

describe('opensdd setup-ci', () => {
  after(() => {
    fs.rmSync(SETUP_CI_PROJECT, { recursive: true, force: true });
    fs.rmSync(MOCK_BIN_DIR, { recursive: true, force: true });
  });

  describe('command registration', () => {
    it('should include setup-ci in --help output', () => {
      const output = execSync(`node ${CLI} --help`, {
        encoding: 'utf-8',
        cwd: '/tmp',
      });
      assert.match(output, /setup-ci/);
      assert.match(output, /Set up GitHub Actions CI/);
    });
  });

  describe('prerequisite validation', () => {
    it('should fail when opensdd.json is missing', () => {
      const bareDir = path.join('/tmp', 'opensdd-test-bare-ci');
      fs.rmSync(bareDir, { recursive: true, force: true });
      fs.mkdirSync(bareDir, { recursive: true });
      execSync('git init', { cwd: bareDir, stdio: 'ignore' });

      const result = (() => {
        try {
          return execSync(`node ${CLI} setup-ci --dry-run --skip-token`, {
            cwd: bareDir,
            encoding: 'utf-8',
            timeout: 15000,
          });
        } catch (err) {
          return { stderr: err.stderr, stdout: err.stdout, exitCode: err.status };
        }
      })();

      assert.ok(result.stderr || result.exitCode);
      assert.match(result.stderr, /not initialized/i);
      assert.equal(result.exitCode, 1);

      fs.rmSync(bareDir, { recursive: true, force: true });
    });
  });

  describe('--dry-run --skip-token', () => {
    before(() => {
      setupCiProject();
    });

    it('should print dry-run output and create no files', () => {
      const output = runCi('setup-ci --dry-run --skip-token');

      // Verify dry-run summary lines
      assert.match(output, /dry run/i);
      assert.match(output, /Would create label: spec/);
      assert.match(output, /Would create label: implement-spec/);
      assert.match(output, /Would skip secret.*--skip-token/);
      assert.match(output, /Would install:.*spec-merged\.yml/);
      assert.match(output, /Would install:.*claude-implement\.yml/);
      assert.match(output, /Run without --dry-run to apply/);

      // Verify no workflow files were created
      assert.ok(
        !fs.existsSync(
          path.join(SETUP_CI_PROJECT, '.github', 'workflows', 'spec-merged.yml')
        )
      );
      assert.ok(
        !fs.existsSync(
          path.join(SETUP_CI_PROJECT, '.github', 'workflows', 'claude-implement.yml')
        )
      );
    });
  });

  describe('--dry-run (without --skip-token)', () => {
    before(() => {
      setupCiProject();
    });

    it('should show would-set-secret line', () => {
      const output = runCi('setup-ci --dry-run');

      assert.match(output, /dry run/i);
      assert.match(output, /Would set secret: CLAUDE_CODE_OAUTH_TOKEN/);

      // Still no files created
      assert.ok(
        !fs.existsSync(
          path.join(SETUP_CI_PROJECT, '.github', 'workflows', 'spec-merged.yml')
        )
      );
    });
  });

  describe('--force --skip-token (workflow installation)', () => {
    beforeEach(() => {
      setupCiProject();
    });

    it('should create workflow files in .github/workflows/', () => {
      const output = runCi('setup-ci --force --skip-token');

      assert.match(output, /CI setup complete/i);

      // Verify both workflow files exist
      const specMerged = path.join(
        SETUP_CI_PROJECT, '.github', 'workflows', 'spec-merged.yml'
      );
      const claudeImplement = path.join(
        SETUP_CI_PROJECT, '.github', 'workflows', 'claude-implement.yml'
      );
      assert.ok(fs.existsSync(specMerged));
      assert.ok(fs.existsSync(claudeImplement));

      // Verify content is valid YAML-like (starts with name:)
      const specMergedContent = fs.readFileSync(specMerged, 'utf-8');
      assert.match(specMergedContent, /^name:/);
      assert.match(specMergedContent, /OpenSDD.*Spec Merged/);

      const claudeContent = fs.readFileSync(claudeImplement, 'utf-8');
      assert.match(claudeContent, /^name:/);
      assert.match(claudeContent, /OpenSDD.*Implement Spec/);
    });

    it('should install claude-implement.yml with both implement and claude jobs', () => {
      runCi('setup-ci --force --skip-token');

      const claudeImplement = path.join(
        SETUP_CI_PROJECT, '.github', 'workflows', 'claude-implement.yml'
      );
      const content = fs.readFileSync(claudeImplement, 'utf-8');

      // Verify the implement job exists
      assert.match(content, /^\s+implement:/m);

      // Verify the claude job exists
      assert.match(content, /^\s+claude:/m);
    });

    it('should install claude-implement.yml with context detection in claude job', () => {
      runCi('setup-ci --force --skip-token');

      const claudeImplement = path.join(
        SETUP_CI_PROJECT, '.github', 'workflows', 'claude-implement.yml'
      );
      const content = fs.readFileSync(claudeImplement, 'utf-8');

      // Verify context detection step exists
      assert.match(content, /Detect context/);

      // Verify all three modes are present
      assert.match(content, /mode.*pr/);
      assert.match(content, /mode.*issue-with-pr/);
      assert.match(content, /mode.*issue-no-pr/);

      // Verify PR branch checkout is conditional on mode
      assert.match(content, /Checkout PR branch/);
      assert.match(content, /steps\.context\.outputs\.mode == 'pr'/);
      assert.match(content, /steps\.context\.outputs\.mode == 'issue-with-pr'/);
    });

    it('should install claude-implement.yml that handles @claude mentions', () => {
      runCi('setup-ci --force --skip-token');

      const claudeImplement = path.join(
        SETUP_CI_PROJECT, '.github', 'workflows', 'claude-implement.yml'
      );
      const content = fs.readFileSync(claudeImplement, 'utf-8');

      // Verify claude job triggers on @claude mentions in issue and PR comments
      assert.match(content, /issue_comment/);
      assert.match(content, /pull_request_review_comment/);
      assert.match(content, /@claude/);
    });

    it('should be idempotent — running twice does not error', () => {
      runCi('setup-ci --force --skip-token');
      const output = runCi('setup-ci --force --skip-token');

      // Second run should also succeed
      assert.match(output, /CI setup complete/i);

      // Files still exist
      assert.ok(
        fs.existsSync(
          path.join(SETUP_CI_PROJECT, '.github', 'workflows', 'spec-merged.yml')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(SETUP_CI_PROJECT, '.github', 'workflows', 'claude-implement.yml')
        )
      );
    });
  });
});
