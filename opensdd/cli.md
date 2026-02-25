# CLI

> A thin Node.js command-line tool that installs, updates, publishes, and manages OpenSDD specs.

## Version

0.1.0

## Overview

The CLI is the distribution mechanism for OpenSDD specs. It handles initializing projects, fetching specs from a registry, managing `opensdd.json`, producing changesets for dependency updates, and publishing authored specs to the registry. It does not perform AI operations — all implementation, testing, and conformance checking is delegated to the consumer's coding agent via the sdd-manager skill.

The CLI is published to npm as `opensdd` and invoked as `opensdd`.

## Behavioral Contract

### `opensdd init`

Initializes the OpenSDD protocol in the current project.

#### Behavior

1. Verify the current directory is a project root (contains `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.git`, `opensdd.json`, or similar project markers). If no project marker is found, warn the user and ask for confirmation to proceed.
2. Install both skills (sdd-manager and sdd-generate) into all supported agent configuration directories. If already present, overwrite — skills are always spec-owned. The full installation mapping is defined in the **Skill Installation Mapping** section below.
3. If `opensdd.json` does not exist at the project root, create it with default contents: `{ "opensdd": "0.1.0", "specs_dir": "opensdd", "deps_dir": ".opensdd.deps" }`. The `registry`, `publish`, and `dependencies` fields are intentionally omitted from the default — they are optional. When `registry` is absent, the CLI defaults to `https://github.com/deepagents-ai/opensdd` per the registry source resolution logic. If `opensdd.json` already exists, leave it untouched.
4. Create the `opensdd/` directory (or the directory specified by `specs_dir` in an existing `opensdd.json`) if it does not exist.
5. If `<specs_dir>/spec.md` does not exist, create a skeleton `spec.md` with placeholder sections:
   ```markdown
   # {project-name}

   > TODO: One-line description of what this software does.

   ## Behavioral Contract

   <!-- Define behaviors here. -->

   ## NOT Specified (Implementation Freedom)

   <!-- List aspects left to the implementer's discretion. -->

   ## Invariants

   <!-- List properties that must hold true across all inputs and states. -->
   ```
   The `{project-name}` placeholder SHOULD be inferred from the nearest project manifest (e.g., `name` in `package.json`) or default to the directory name. If `spec.md` already exists, leave it untouched.
6. Create the `.opensdd.deps/` directory (or the directory specified by `deps_dir` in an existing `opensdd.json`) if it does not exist.
7. Print a success message.

- `opensdd init` in a fresh project MUST produce the output below
- `opensdd init` in a project that already has OpenSDD initialized MUST overwrite all skill installation files across all agent formats but MUST NOT overwrite `opensdd.json`

#### Output

```
Initialized OpenSDD:
  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp
    sdd-manager              installed (6 agent formats)
    sdd-generate             installed (6 agent formats)
  opensdd.json               created
  opensdd/                   created
  opensdd/spec.md            created (skeleton)
  .opensdd.deps/             created
```

If already initialized:
```
Initialized OpenSDD:
  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp
    sdd-manager              updated (6 agent formats)
    sdd-generate             updated (6 agent formats)
  opensdd.json               already exists (preserved)
  opensdd/                   already exists
  opensdd/spec.md            already exists (preserved)
  .opensdd.deps/             already exists
```

#### Errors

- If `.claude/` directory cannot be created (permissions error), print error and exit with code 1.
- If `opensdd.json` exists but is malformed JSON, print error and exit with code 1.

### Skill Installation Mapping

`opensdd init` installs both skills (sdd-manager and sdd-generate) into the native configuration format of each supported coding agent. The canonical skill content is authored as markdown source files (`sdd-manager.md`, `sdd-generate.md`, `spec-format.md`). The CLI transforms these into each agent's expected format during installation.

All installed skill files are **spec-owned** — they are overwritten on every `opensdd init` and MUST NOT be edited by the user.

#### Claude Code (Agent Skills standard)

Each skill is a directory with a `SKILL.md` and a `references/` subdirectory. Claude Code auto-discovers skills in `.claude/skills/`.

```
.claude/skills/
  sdd-manager/
    SKILL.md                    ← sdd-manager.md
    references/
      spec-format.md            ← spec-format.md
  sdd-generate/
    SKILL.md                    ← sdd-generate.md
    references/
      spec-format.md            ← spec-format.md
```

#### OpenAI Codex CLI (Agent Skills standard)

Codex CLI follows the same Agent Skills standard but discovers skills in `.agents/skills/`.

```
.agents/skills/
  sdd-manager/
    SKILL.md                    ← sdd-manager.md
    references/
      spec-format.md            ← spec-format.md
  sdd-generate/
    SKILL.md                    ← sdd-generate.md
    references/
      spec-format.md            ← spec-format.md
```

#### Cursor

Cursor discovers rules as `.md` or `.mdc` files in `.cursor/rules/`. Each skill becomes a single rule file with YAML frontmatter. The frontmatter uses `description` for intelligent matching (Cursor decides when to apply the rule based on relevance). The body contains the full skill content followed by a reference to `spec-format.md`.

```
.cursor/rules/
  sdd-manager.md                ← sdd-manager.md with frontmatter
  sdd-generate.md               ← sdd-generate.md with frontmatter
  opensdd-spec-format.md        ← spec-format.md with frontmatter
```

Frontmatter for `sdd-manager.md`:
```yaml
---
description: "Implement, update, and verify installed OpenSDD dependency specs. Use when the user asks to implement a spec, process a spec update, check conformance, or create a deviation."
alwaysApply: false
---
```

Frontmatter for `sdd-generate.md`:
```yaml
---
description: "Generate an OpenSDD behavioral spec from existing code. Use when the user asks to generate, create, or extract a spec from a repository or codebase."
alwaysApply: false
---
```

Frontmatter for `opensdd-spec-format.md`:
```yaml
---
description: "OpenSDD spec format reference. Defines the structure and rules for behavioral specifications. Referenced by sdd-manager and sdd-generate skills."
alwaysApply: false
---
```

#### GitHub Copilot

Copilot discovers instructions as `.instructions.md` files in `.github/instructions/`. Each skill becomes an instruction file with YAML frontmatter. The `applyTo` field is set to `"**"` so the instructions are available across the project.

```
.github/instructions/
  sdd-manager.instructions.md   ← sdd-manager.md with frontmatter
  sdd-generate.instructions.md  ← sdd-generate.md with frontmatter
  opensdd-spec-format.instructions.md  ← spec-format.md with frontmatter
```

Frontmatter for each file:
```yaml
---
applyTo: "**"
---
```

#### Gemini CLI

Gemini CLI discovers `GEMINI.md` files in the project directory and supports `@file.md` import syntax for referencing other files. Rather than duplicating skill content, the CLI appends import directives to `GEMINI.md` (creating it if it does not exist) that reference the canonical skill files from the Claude Code installation.

Appended to `GEMINI.md`:
```markdown
<!-- OpenSDD Skills (managed by opensdd init — do not edit this section) -->
@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md
@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md
```

The CLI MUST only modify the clearly delimited OpenSDD section. If a `GEMINI.md` already exists with an OpenSDD section, the CLI MUST replace that section. Content outside the section MUST NOT be modified.

#### Amp

Amp discovers `AGENTS.md` files in the project directory and supports `@` reference syntax for including other files. The CLI appends references to `AGENTS.md` (creating it if it does not exist) that point to the canonical skill files.

Appended to `AGENTS.md`:
```markdown
<!-- OpenSDD Skills (managed by opensdd init — do not edit this section) -->
@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md
@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md
```

The CLI MUST only modify the clearly delimited OpenSDD section. If an `AGENTS.md` already exists with an OpenSDD section, the CLI MUST replace that section. Content outside the section MUST NOT be modified.

#### Installation notes

- The Claude Code installation (`.claude/skills/`) serves as the canonical source that Gemini CLI and Amp reference via imports. It MUST always be installed, even if the user only uses Gemini or Amp.
- All installed files are overwritten on every `opensdd init`. The CLI MUST NOT prompt for confirmation before overwriting skill files.
- If a target directory cannot be created (e.g., permissions), the CLI SHOULD warn and continue installing to other agent directories rather than failing entirely.
- For Gemini CLI and Amp, the CLI MUST NOT overwrite user content in `GEMINI.md` or `AGENTS.md` — it MUST only manage the clearly delimited OpenSDD section.

### `opensdd list`

Lists specs available in the registry.

#### Behavior

1. Fetch the directory listing of the `registry/` folder from the configured registry source (default: the OpenSDD GitHub repository).
2. For each subdirectory in `registry/`, read `index.json` to extract `name`, `latest` version, `description`.
3. Print a formatted list showing each spec's name, latest version, and description.

- `opensdd list` MUST work from any directory (no project markers required)

#### Input

Optional flag: `--registry <url>` to specify an alternative registry source.

#### Output

```
Available specs:

  slugify          v2.2.0  String to URL-friendly slug
  http-retry       v1.0.0  HTTP request retry with backoff
  payments         v1.3.0  Payment provider integrations
```

#### Errors

- If the registry is unreachable, print error with the URL that failed and exit with code 1.
- If a spec's `index.json` is malformed or missing, skip it and print a warning.

### `opensdd install <name> [version]`

Fetches a spec from the registry and installs it as a dependency.

#### Behavior

1. Verify `opensdd.json` exists at the project root. If not, print a message suggesting `opensdd init` first and exit with code 1.
2. Check if the spec `<name>` already exists as a key in `opensdd.json`'s `dependencies` object. If it does AND the spec directory exists in `<deps_dir>`, print a message indicating the spec is already installed and suggest `opensdd update` instead. Exit with code 1. If the entry exists BUT the spec directory is missing, treat as a re-install: log a message noting the stale entry, then continue to step 4 using the version from the existing entry (unless `[version]` is explicitly provided, in which case use that).
3. Validate the spec name (lowercase alphanumeric and hyphens only).
4. Fetch `index.json` from `registry/<name>/` in the configured registry source. If `[version]` is provided, use that version; otherwise use `latest` from `index.json`.
5. Read `manifest.json` from `registry/<name>/<version>/` to get spec_format and dependencies.
6. Copy all files from `registry/<name>/<version>/` into `<deps_dir>/<name>/` (including `manifest.json`, `spec.md`, and any supplementary files).
7. Add an entry to `opensdd.json` under `dependencies.<name>` with fields from `manifest.json` (`version`, `spec_format`), the resolved registry URL as `source`, and consumer-managed fields initialized to defaults: `implementation: null`, `tests: null`, `has_deviations: false`.
8. If the spec has `dependencies`, check whether each dependency name exists as a key in `opensdd.json`'s `dependencies` object. If any are missing, print a warning listing the missing dependencies and suggesting `opensdd install` for each.
9. Print a success message.

- `opensdd install slugify` MUST create `.opensdd.deps/slugify/` with all spec files and add a `slugify` entry to `opensdd.json` `dependencies`

#### Input

- `<name>` (required): The spec name as it appears in the registry.
- `[version]` (optional): Specific semver version to install. Defaults to latest.
- `--registry <url>` (optional): Alternative registry source.

#### Output

```
Installed slugify v2.2.0 to .opensdd.deps/slugify/

Run "implement the slugify spec" in your agent to generate an implementation.
```

#### Errors

- Spec not found in registry: print error listing available specs and exit with code 1.
- Requested version not found: print error listing available versions and exit with code 1.
- Spec already installed (entry and directory both exist): print message suggesting `opensdd update` and exit with code 1.
- OpenSDD not initialized: print message suggesting `opensdd init` and exit with code 1.

### `opensdd update [name]`

Fetches the latest version of installed dependency specs from the registry, updates spec files in `.opensdd.deps/`, and stages the update for the agent to process. Does NOT modify `opensdd.json` — the dependency entry remains at the old version until `opensdd update apply` is called after the agent has confirmed the migration.

#### Behavior

1. If `<name>` is provided, update that single spec. If no name is provided, update all installed dependencies.
2. For each spec being updated:
   a. Read the spec's entry in `opensdd.json` `dependencies` to get the installed version and `spec_format` version.
   b. Fetch `index.json` from the registry to get the latest version. Read `manifest.json` from the latest version directory.
   c. If the registry version matches the installed version, skip with a message "already up to date".
   d. Before overwriting, compute unified diffs of all spec-owned files that will change.
   e. Overwrite all spec-owned files in `<deps_dir>/<name>/` with the new version from the registry (`manifest.json`, `spec.md`, and any supplementary files).
   f. MUST NOT overwrite or delete `deviations.md`. The CLI MUST NOT create, modify, or delete `deviations.md` under any circumstances.
   g. Create the staging directory `.opensdd.deps/.updates/<name>/` and write two files. If a pending update already exists for this spec, overwrite it and note the replacement in the output.
      - `changeset.md` — contains previous and new version, `spec_format` version change (if any), and unified diffs from step (d).
      - `manifest.json` — contains the metadata needed to finalize the update in `opensdd.json`: `name`, `previous_version`, `version`, `source`, `spec_format`.
3. Print a summary of what was updated.

#### Input

- `[name]` (optional): Dependency spec to update. If omitted, update all installed dependencies.
- `--registry <url>` (optional): Alternative registry source.

#### Output

For a single spec:
```
Updated slugify: v2.1.0 -> v2.2.0

Changed files:
  spec.md    updated

Preserved:
  deviations.md (consumer-owned, not modified)

Staged update:
  .opensdd.deps/.updates/slugify/changeset.md
  .opensdd.deps/.updates/slugify/manifest.json

Run "process the slugify spec update" in your agent.
After confirming, run: opensdd update apply slugify
```

For all specs:
```
Updated 2 of 3 installed specs:

  slugify     v2.1.0 -> v2.2.0   staged
  payments    v1.3.0 -> v1.4.0   staged
  http-retry  v1.0.0             already up to date

Run "process spec updates" in your agent.
After confirming each update, run:
  opensdd update apply slugify
  opensdd update apply payments
```

#### Errors

- Spec not installed: print error and exit with code 1.
- Registry unreachable: print error and exit with code 1.

### `opensdd update apply [name]`

Applies a staged update to `opensdd.json`, confirming that the migration is complete.

#### Behavior

1. If `<name>` is provided, apply that single update. If no name is provided, apply all pending updates.
2. Print a warning: "This will finalize the update in opensdd.json. Only proceed if you have confirmed that all spec changes have been implemented and tests pass."
3. Prompt the user for confirmation (y/n). If declined, exit with code 0.
4. For each pending update:
   a. Read `.opensdd.deps/.updates/<name>/manifest.json` to get the update metadata.
   b. Update the `opensdd.json` `dependencies.<name>` entry: set `version`, `source`, and `spec_format` from the manifest. Preserve all consumer-managed fields (`implementation`, `tests`, `has_deviations`).
   c. Delete the `.opensdd.deps/.updates/<name>/` directory.
5. If `.opensdd.deps/.updates/` is now empty, delete it.
6. Print a summary.

#### Input

- `[name]` (optional): Dependency spec to apply. If omitted, apply all pending updates.

#### Output

For a single spec:
```
⚠ This will finalize the update in opensdd.json.
  Only proceed if you have confirmed that all spec changes
  have been implemented and tests pass.

Apply update for slugify v2.1.0 -> v2.2.0? (y/n) y

Applied update for slugify: v2.1.0 -> v2.2.0

  opensdd.json    updated
  staged files    cleaned up
```

For all pending:
```
⚠ This will finalize the update in opensdd.json.
  Only proceed if you have confirmed that all spec changes
  have been implemented and tests pass.

Apply 2 pending updates? (y/n) y

Applied 2 updates:

  slugify     v2.1.0 -> v2.2.0   applied
  payments    v1.3.0 -> v1.4.0   applied

opensdd.json updated.
```

#### Errors

- No pending update for the specified spec: print error and exit with code 1.
- No pending updates at all (when no name provided): print "No pending updates." and exit with code 0.
- `.opensdd.deps/.updates/<name>/manifest.json` is missing or malformed: print error and exit with code 1.

### `opensdd publish`

Publishes an authored spec to the registry.

#### Behavior

1. Verify `opensdd.json` exists at the project root. If not, print a message suggesting `opensdd init` first and exit with code 1.
2. Verify `opensdd.json` has a `publish` object. If not, print an error suggesting the user add a `publish` section and exit with code 1.
3. Read the `publish` object to get `name`, `version`, `description`, `spec_format`, `dependencies`.
4. Verify `<specs_dir>/spec.md` exists. If not, print error and exit with code 1.
5. Run validation on the `<specs_dir>/` directory (same logic as `opensdd validate`). If validation fails with errors, print them and exit with code 1.
6. Resolve the registry source. The registry MUST be a GitHub repository URL for publishing.
7. Fetch `index.json` from `registry/<name>/` if it exists. If the version being published already exists in `index.json`, print error suggesting a version bump and exit with code 1.
8. Construct the registry entry:
   a. Build `manifest.json` from the `opensdd.json` `publish` fields (`name`, `version`, `description`, `spec_format`, `dependencies`).
   b. Collect all files from `<specs_dir>/`.
9. If `--branch <name>` was provided, use that as the branch name. Otherwise, prompt the user for a branch name.
10. Clone the registry repo (shallow), create a new branch with the chosen name, and:
    a. Create `registry/<name>/<version>/` with `manifest.json` and all spec files.
    b. Update (or create) `registry/<name>/index.json` — set `latest` to the new version, add the version to `versions`.
11. Commit the changes, push the branch, and open a pull request using `gh pr create`.
12. Print a success message with the PR URL.

- `opensdd publish` MUST create a PR adding `registry/<name>/<version>/` with the spec files
- `opensdd publish` MUST NOT allow publishing a version that already exists in the registry

#### Input

- `--branch <name>` (optional): Branch name for the registry PR. If omitted, the CLI prompts the user.
- `--registry <url>` (optional): Alternative registry source (must be a GitHub URL).

#### Output

```
Publishing auth v1.0.0 to registry...

  Validated spec            ok
  Created branch            opensdd/auth-v1.0.0
  Created registry entry    registry/auth/1.0.0/
  Updated index.json        latest: 1.0.0
  Opened pull request       https://github.com/deepagents-ai/opensdd/pull/42

Published. Spec will be available after PR is merged.
```

#### Errors

- OpenSDD not initialized: print message suggesting `opensdd init` and exit with code 1.
- No `publish` section in `opensdd.json`: print error and exit with code 1.
- `<specs_dir>/spec.md` missing: print error and exit with code 1.
- Spec validation fails: print validation errors and exit with code 1.
- Version already exists in registry: print error suggesting version bump and exit with code 1.
- Registry is not a GitHub URL: print error (publishing requires a GitHub registry) and exit with code 1.
- Git or `gh` CLI not available: print error with installation guidance and exit with code 1.
- Git authentication fails: print error guiding the user to authenticate and exit with code 1.

### `opensdd status`

Shows the status of the authored spec and all installed dependency specs in the current project.

#### Behavior

1. Read `opensdd.json`.
2. If `publish` exists, print authored spec section showing the spec's name, version, and directory.
3. If `dependencies` exists and has entries, iterate the `dependencies` object. For each entry, read its consumer-managed fields and check for the presence of `deviations.md` in `<deps_dir>/<name>/`. Print a dependency status table.
4. Check for untracked directories: spec directories in `<deps_dir>` that have no corresponding `opensdd.json` dependency entry. Warn about any found.

#### Output

```
Authored spec:

  auth  v1.0.0  opensdd/

Installed dependencies:

  slugify     v2.1.0  implemented       src/utils/slugify.ts
  payments    v1.3.0  implemented       src/payments/index.ts    2 deviations
  http-retry  v1.0.0  not implemented
```

#### Errors

- If `opensdd.json` does not exist, print "OpenSDD not initialized. Run `opensdd init` to get started."
- If no specs are published or installed, print "No specs found. Run `opensdd install <name>` to install a dependency or add a `publish` entry to opensdd.json."

### `opensdd validate [path]`

Validates that a spec directory conforms to the OpenSDD spec-format.

#### Behavior

1. If `[path]` is provided, use it as the directory to validate. If omitted, look for the `opensdd/` directory in the current working directory and use that.
2. Read the directory.
3. Check for required files: `spec.md` MUST exist.
4. If `manifest.json` exists, validate it:
   a. `name` MUST be present.
   b. `spec_format` MUST be present and be a recognized version.
   c. `version` MUST be present and be valid semver.
5. Validate `spec.md`:
   a. MUST start with an H1 header followed by a blockquote summary.
   b. MUST contain `## Behavioral Contract` section.
   c. `## NOT Specified` section SHOULD be present (warn if missing).
   d. `## Invariants` section SHOULD be present (warn if missing).
   e. `## Edge Cases` SHOULD be present (warn if missing).
6. Verify no `deviations.md` exists (specs intended for the registry MUST NOT contain deviations).
7. Print a summary of validation results.

- `opensdd validate` MUST work on any local directory (no project markers required)
- `opensdd validate` MUST NOT require OpenSDD to be initialized

#### Input

- `[path]` (optional): Path to a spec directory to validate. If omitted, defaults to `opensdd/` in the current directory.

#### Output

For a valid spec:
```
Validated slugify v2.1.0

  spec.md structure     ok
  manifest.json         ok
  no deviations.md      ok

Valid. Ready for publishing to registry.
```

For a spec with issues:
```
Validated slugify v2.1.0

  spec.md structure     2 warnings
    - Missing ## NOT Specified section (recommended)
    - Missing ## Edge Cases section (recommended)
  manifest.json         ok
  no deviations.md      ok

Valid with warnings. Review warnings before publishing.
```

For an invalid spec:
```
Validation failed for slugify

  spec.md structure     error
    - Missing required: H1 header with blockquote summary
  manifest.json         error
    - Missing required field: version

2 errors. Fix errors before publishing.
```

#### Errors

- Path does not exist or is not a directory: print error and exit with code 1.
- No `[path]` provided and the default `opensdd/` directory does not exist: print error ("No spec directory found. Provide a path or run from a directory containing `opensdd/`.") and exit with code 1.
- Missing required file (`spec.md`): report as validation error (do not exit early — continue checking what can be checked).
- `opensdd validate` MUST exit with code 0 if validation passes (including with warnings) and code 1 if any errors are found.

### Manifest Resolution

Commands that require `opensdd.json` (all commands except `opensdd list` and `opensdd validate`) MUST resolve it by searching upward from the current working directory, stopping at the first `opensdd.json` found. This supports monorepos where each sub-project has its own `opensdd.json`. If no `opensdd.json` is found in any ancestor directory, the command fails with the appropriate "not initialized" error.

`opensdd init` always creates `opensdd.json` in the current working directory.

### Registry Source Resolution

The CLI fetches specs from a registry source. The default source is the `registry/` directory in the OpenSDD GitHub repository.

The CLI MUST resolve the registry source in this order:
1. `--registry` flag on the command (if provided)
2. `registry` field in `opensdd.json` (if present)
3. Default: `https://github.com/deepagents-ai/opensdd` (the canonical registry)

For GitHub sources, the CLI MUST use the GitHub API to list directory contents and fetch raw file content. This avoids requiring a full git clone (except for `opensdd publish`, which requires a clone to create a branch and PR).

For local paths, the CLI MUST read directly from the filesystem. This supports development and testing of specs before publishing to a registry.

### Consumer-Managed Field Preservation

During `opensdd update apply`, the CLI MUST preserve these `opensdd.json` fields for each affected dependency entry:
- `implementation`
- `tests`
- `has_deviations`

The CLI reads the existing `opensdd.json` dependency entry, applies updated metadata from the staged manifest, then re-applies the consumer-managed field values. Note that `opensdd update` does NOT touch `opensdd.json` at all — it only stages the update. The `opensdd.json` entry continues to reflect the old version until `opensdd update apply` is called.

## Edge Cases

- Running `opensdd install` for a spec that was previously installed and then manually deleted (directory gone, `opensdd.json` entry gone): treat as a fresh install.
- Running `opensdd install` when the `opensdd.json` dependency entry exists but the directory is missing: treat as a re-install — re-fetch spec files for the version in the existing entry and recreate the directory.
- Spec directory exists in `.opensdd.deps/` but has no `opensdd.json` dependency entry: `opensdd status` MUST warn about untracked spec directories.
- Running `opensdd update` when a spec's registry entry has been removed: print a warning that the spec is no longer available in the registry but leave local files and `opensdd.json` entry untouched.
- Running `opensdd update` when a pending update already exists for the spec: overwrite the existing staged update with the new one.
- Running `opensdd update apply` when no pending updates exist: print "No pending updates." and exit with code 0 (not an error).
- Running `opensdd update apply <name>` when the agent hasn't finished processing the changeset: the CLI has no way to verify this — it's the user's responsibility to confirm the migration is complete before applying.
- Running `opensdd init` in a project that already has OpenSDD initialized: overwrite all skill installation files across all agent formats, leave `opensdd.json` untouched.
- Running any command outside a project directory (no project markers found): warn but allow with confirmation, except `opensdd list` and `opensdd validate` which work anywhere.
- Spec name contains characters invalid for directory names: reject with an error listing allowed characters (lowercase alphanumeric and hyphens).
- Publishing a version that already exists in the registry: reject with an error suggesting a version bump.
- Publishing when the registry is a local path (not GitHub): reject with an error (publishing requires a GitHub registry for PR workflow).
- Running `opensdd publish` when `gh` CLI is not installed: print error with installation guidance.
- Running `opensdd install` with a version that doesn't exist in the registry: print error listing available versions.

## NOT Specified (Implementation Freedom)

- HTTP client library choice for GitHub API requests
- Caching strategy for registry requests
- CLI framework (commander, yargs, or plain process.argv parsing)
- Output coloring/formatting approach
- Whether to use TypeScript or plain JavaScript internally
- Progress indicator style for network requests
- The exact format of the registry's internal files beyond the required fields
- The git branching strategy used during `opensdd publish` (branch name is user-provided)
- Whether `opensdd publish` does a shallow or full clone of the registry repo

## Invariants

- The CLI MUST NOT create, modify, or delete `deviations.md` under any circumstances
- `opensdd install` MUST NOT create a `deviations.md` file
- `opensdd update` MUST NOT modify `opensdd.json` — it only stages the update
- `opensdd update` MUST create a staging directory in `.opensdd.deps/.updates/<name>/` for every spec that was updated (not for specs already up to date)
- `opensdd update apply` MUST update `opensdd.json` and delete the staging directory
- All skill installation files across all agent formats MUST always be overwritten on `opensdd init` (they are fully spec-owned)
- The Claude Code skill installation (`.claude/skills/`) MUST always be present since Gemini CLI and Amp reference it
- `opensdd.json` MUST be created by `opensdd init` if it does not exist, and MUST NOT be overwritten if it already exists
- Consumer-managed `opensdd.json` fields MUST survive all update operations
- Every installed dependency MUST have both a directory in `deps_dir` and an entry in `opensdd.json` `dependencies`
- All commands MUST exit with code 0 on success and code 1 on error
- The CLI MUST NOT invoke an AI model or coding agent
- `opensdd publish` MUST NOT allow overwriting an existing version in the registry
- `.opensdd.deps/` MUST be committed to the repo (NOT gitignored)
