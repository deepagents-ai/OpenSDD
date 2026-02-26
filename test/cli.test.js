import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

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
      spec_format: '0.1.0',
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
      spec_format: '0.1.0',
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
        '1.0.0': { spec_format: '0.1.0' },
        '1.1.0': { spec_format: '0.1.0' },
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
      spec_format: '0.1.0',
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
      versions: { '1.0.0': { spec_format: '0.1.0' } },
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

    it('should initialize a fresh project', () => {
      const output = run('init');
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
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, 'GEMINI.md')));
      assert.ok(fs.existsSync(path.join(TEST_PROJECT, 'AGENTS.md')));

      // Verify opensdd.json content
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_PROJECT, 'opensdd.json'), 'utf-8')
      );
      assert.equal(manifest.opensdd, '0.1.0');
      assert.equal(manifest.specs_dir, 'opensdd');
      assert.equal(manifest.deps_dir, '.opensdd.deps');

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
      run('init');
      const spec = fs.readFileSync(
        path.join(TEST_PROJECT, 'opensdd', 'spec.md'),
        'utf-8'
      );
      assert.match(spec, /^# my-test-app/);
    });

    it('should preserve opensdd.json on re-init', () => {
      run('init');

      // Modify opensdd.json
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.registry = 'https://github.com/custom/registry';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      // Re-init
      const output = run('init');
      assert.match(output, /opensdd\.json\s+already exists \(preserved\)/);
      assert.match(output, /updated \(6 agent formats\)/);

      // Verify opensdd.json preserved
      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.equal(updated.registry, 'https://github.com/custom/registry');
    });

    it('should preserve GEMINI.md user content on re-init', () => {
      fs.writeFileSync(
        path.join(TEST_PROJECT, 'GEMINI.md'),
        '# My Custom Instructions\n\nDo things.\n'
      );
      run('init');

      const gemini = fs.readFileSync(
        path.join(TEST_PROJECT, 'GEMINI.md'),
        'utf-8'
      );
      assert.match(gemini, /# My Custom Instructions/);
      assert.match(gemini, /OpenSDD Skills/);
      assert.match(gemini, /@\.claude\/skills\/sdd-manager\/SKILL\.md/);
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
      run('init');
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
      assert.equal(manifest.dependencies.slugify.implementation, null);
      assert.equal(manifest.dependencies.slugify.tests, null);
      assert.equal(manifest.dependencies.slugify.has_deviations, false);
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

    it('should error when opensdd not initialized', () => {
      fs.rmSync(path.join(TEST_PROJECT, 'opensdd.json'));
      const result = run(
        `install slugify --registry ${TEST_REGISTRY}`,
        TEST_PROJECT,
        { expectError: true }
      );
      assert.match(result.stderr, /not initialized/);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      setupTestProject();
      run('init');
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
      run('init');
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
      manifest.dependencies.slugify.implementation = 'src/slugify.js';
      manifest.dependencies.slugify.tests = 'test/slugify.test.js';
      manifest.dependencies.slugify.has_deviations = true;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      execSync(`echo "y" | node ${CLI} update apply slugify`, {
        cwd: TEST_PROJECT,
        encoding: 'utf-8',
      });

      const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      assert.equal(updated.dependencies.slugify.version, '1.1.0');
      assert.equal(updated.dependencies.slugify.implementation, 'src/slugify.js');
      assert.equal(updated.dependencies.slugify.tests, 'test/slugify.test.js');
      assert.equal(updated.dependencies.slugify.has_deviations, true);
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
      run('init');
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

    it('should show authored spec when publish is configured', () => {
      const manifestPath = path.join(TEST_PROJECT, 'opensdd.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.publish = {
        name: 'my-spec',
        version: '1.0.0',
        description: 'My test spec',
        spec_format: '0.1.0',
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
      run('init');
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
          spec_format: '0.1.0',
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
});
