# CLI

> A thin Node.js command-line tool that installs, updates, publishes, and manages OpenSDD specs.

## Version

0.1.0

## Overview

The CLI is the distribution mechanism for OpenSDD specs. It handles initializing projects, fetching specs from a registry, managing `opensdd.json`, producing changesets for dependency updates, and publishing authored specs to the registry. It does not perform AI operations — all implementation, testing, and conformance checking is delegated to the consumer's coding agent via the sdd-manager skill.

The CLI is published to npm as `opensdd` and invoked as `opensdd`.

## Behavioral Contract

### `opensdd --version`

Prints the current package version from `package.json` and exits. The version MUST be read from the npm package manifest at runtime — it MUST NOT be hardcoded.

### `opensdd --help`

Prints usage information including the current version, available commands, and options. The version shown MUST be read from `package.json` at runtime.

### `opensdd init`

Initializes the OpenSDD protocol in the current project. Supports two modes:

- **Consumer-only**: Install and implement dependency specs. Minimal footprint — only `sdd-manager` skill installed, no specs directory or skeleton `spec.md`.
- **OpenSDD-driven**: Full SDD methodology adoption. Both skills installed, specs directory and skeleton `spec.md` created.

Mode detection: presence of `specsDir` in `opensdd.json` = OpenSDD-driven. Absence = consumer-only.

If `opensdd.json` already exists in the current working directory, print "Already initialized. Run `opensdd sync` to update skill files." and exit with code 0.

#### Behavior

1. Verify the current directory is a project root (contains `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.git`, `opensdd.json`, or similar project markers). If no project marker is found, warn the user and ask for confirmation to proceed.
2. If `opensdd.json` already exists in the current working directory, print "Already initialized. Run `opensdd sync` to update skill files." and exit with code 0.
3. Determine mode: prompt "How will this project use OpenSDD?" with numbered choices:
     1. Consumer only — install and implement dependency specs
     2. OpenSDD-driven — full SDD methodology (author specs, both skills)
   Create manifest accordingly.
4. Determine the **skill installation root**: if the current directory is inside a git repository, use the git repository root. Otherwise, use the current working directory. Install skills at the skill installation root with the determined mode. In consumer mode, only `sdd-manager` is installed. In full mode, both `sdd-manager` and `sdd-generate` are installed. The full installation mapping is defined in the **Skill Installation Mapping** section below. If already present, overwrite — skills are always spec-owned. If the skill installation root differs from the current working directory, print the skill installation path in the output so the user knows where skills were installed.
   If the skill installation root differs from the current working directory (monorepo sub-project), create a minimal `opensdd.json` at the skill installation root if one does not already exist. The root manifest contains only `{ "opensdd": "0.1.0" }`. If a root `opensdd.json` already exists, leave it untouched. Report the root manifest in the output.
5. Create the `.opensdd.deps/` directory (or the directory specified by `depsDir` in an existing `opensdd.json`) if it does not exist. (Both modes.)
6. If `mode === 'full'`:
   a. If `opensdd.json` does not exist in the current working directory, create it with default contents: `{ "opensdd": "0.1.0", "specsDir": "opensdd", "depsDir": ".opensdd.deps" }`. The `registry`, `publish`, and `dependencies` fields are intentionally omitted from the default — they are optional. When `registry` is absent, the CLI defaults to `https://github.com/deepagents-ai/opensdd` per the registry source resolution logic. If `opensdd.json` already exists, leave it untouched.
   b. Create the `opensdd/` directory (or the directory specified by `specsDir` in the `opensdd.json`) if it does not exist.
   c. If `<specsDir>/spec.md` does not exist, create a skeleton `spec.md` with placeholder sections:
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
7. If `mode === 'consumer'`: create `opensdd.json` in the current working directory with consumer-only contents: `{ "opensdd": "0.1.0", "depsDir": ".opensdd.deps" }` (no `specsDir`). If `opensdd.json` already exists, leave it untouched.
8. Print a success message.

- `opensdd init` selecting OpenSDD-driven in a fresh project MUST produce the full output below
- `opensdd init` selecting consumer-only in a fresh project MUST produce the consumer output below
- `opensdd init` in a project that already has `opensdd.json` MUST print "Already initialized. Run `opensdd sync` to update skill files." and exit with code 0

#### Output

Consumer-only (fresh):
```
Initialized OpenSDD (consumer):
  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp
    sdd-manager              installed (6 agent formats)
  opensdd.json               created
  .opensdd.deps/             created
```

OpenSDD-driven (fresh):
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

OpenSDD-driven (monorepo sub-project, fresh):
```
Initialized OpenSDD:
  Skills installed at repo root (/path/to/monorepo):
    sdd-manager              installed (6 agent formats)
    sdd-generate             installed (6 agent formats)
  opensdd.json (repo root)   created (workspace root)
  opensdd.json               created
  opensdd/                   created
  opensdd/spec.md            created (skeleton)
  .opensdd.deps/             created
```

#### Errors

- If `.claude/` directory cannot be created (permissions error), print error and exit with code 1.
- If `opensdd.json` exists but is malformed JSON, print error and exit with code 1.

### `opensdd sync`

Updates the project's installed skill files and gate rules to match the current CLI version. This is the idempotent "make everything up to date" command — safe to run repeatedly.

#### Behavior

1. Resolve `opensdd.json` via manifest resolution. If not found, print "OpenSDD not initialized. Run `opensdd init` to get started." and exit with code 1.
2. Determine mode from the resolved manifest: if `specsDir` is present, `mode = 'full'`; otherwise `mode = 'consumer'`.
3. Determine the skill installation root (same logic as `opensdd init`): if inside a git repository, use the git root; otherwise use the current working directory.
4. Re-install/update all skill files and gate rules across all supported agent formats for the determined mode. Use the same Skill Installation Mapping as `opensdd init`. Overwrite all existing skill files — they are spec-owned.
5. If the skill installation root differs from the current working directory (monorepo), print the skill installation path.
6. If `mode === 'full'` and CI is not already configured (no `.github/workflows/claude-implement.yml` exists at the git root), prompt: "Would you like to set up CI-driven spec implementation? (opensdd setup-ci) [y/N]". If the user confirms, run the `setup-ci` command.
7. Print a summary of what was updated.

- `opensdd sync` MUST NOT create or modify `opensdd.json`
- `opensdd sync` MUST overwrite all skill files unconditionally (they are spec-owned)

#### Output

```
Synced OpenSDD:
  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp
    sdd-manager              updated (6 agent formats)
    sdd-generate             updated (6 agent formats)
```

#### Errors

- OpenSDD not initialized: print message suggesting `opensdd init` and exit with code 1.
- If a skill installation directory cannot be created (permissions error), warn and continue with other agents.

### Skill Installation Mapping

`opensdd init` installs skills into the native configuration format of each supported coding agent. In **consumer mode**, only `sdd-manager` is installed. In **full (OpenSDD-driven) mode**, both `sdd-manager` and `sdd-generate` are installed. The canonical skill content is authored as markdown source files in `opensdd/skills/` (`skills/sdd-manager.md`, `skills/sdd-generate.md`) and `opensdd/` (`spec-format.md`). Source skill files use Agent Skills frontmatter (`name`, `description`) which the CLI parses and transforms per-agent format during installation.

All installed skill files are **spec-owned** — they are overwritten on every `opensdd init` or `opensdd sync` and MUST NOT be edited by the user.

#### Always-On Gate Rule

In addition to skill files, `opensdd init` installs a lightweight **gate rule** into each agent's always-loaded configuration. The gate rule ensures that any agent operating in the project is aware of the OpenSDD workflow requirement before touching spec-governed code — even if the agent has not yet loaded the full sdd-manager skill.

The gate rule text is:

```
This project uses OpenSDD spec-driven development. Before implementing, modifying, or verifying any code governed by an OpenSDD spec, you MUST load and follow the sdd-manager skill/instructions first. Check `opensdd.json` and `.opensdd.deps/` to identify spec-governed code.
```

The gate rule is installed into each agent's always-loaded file:

| Agent | Gate file | Always-loaded mechanism |
|---|---|---|
| Claude Code | `.claude/rules/opensdd-gate.md` | Rules without `paths:` frontmatter always load |
| Cursor | `.cursor/rules/opensdd-gate.md` | `alwaysApply: true` frontmatter |
| GitHub Copilot | `.github/copilot-instructions.md` | Always included in every Copilot request |
| Gemini CLI | `GEMINI.md` | Always loaded at project root |
| Amp / Codex CLI | `AGENTS.md` | Always loaded at project root |

For Copilot, Gemini CLI, and Amp / Codex CLI, the gate text is prepended to the existing managed OpenSDD section (before the `@` import directives or skill references). For Claude Code and Cursor, the gate is a separate file from the skill files.

The gate rule files are **spec-owned** — they are overwritten on every `opensdd init` or `opensdd sync`.

#### Claude Code (Agent Skills standard)

Each skill is a directory with a `SKILL.md` and a `references/` subdirectory. Claude Code auto-discovers skills in `.claude/skills/` and rules in `.claude/rules/`. The `SKILL.md` files include Agent Skills frontmatter with `name` and `description` fields, copied as-is from the source skill files.

```
.claude/rules/
  opensdd-gate.md               ← gate rule (see Always-On Gate Rule)
.claude/skills/
  sdd-manager/
    SKILL.md                    ← skills/sdd-manager.md
    references/
      spec-format.md            ← spec-format.md
  sdd-generate/
    SKILL.md                    ← skills/sdd-generate.md
    references/
      spec-format.md            ← spec-format.md
```

#### OpenAI Codex CLI (Agent Skills standard)

Codex CLI follows the same Agent Skills standard but discovers skills in `.agents/skills/`. The `SKILL.md` files include Agent Skills frontmatter with `name` and `description` fields, copied as-is from the source skill files.

```
.agents/skills/
  sdd-manager/
    SKILL.md                    ← skills/sdd-manager.md
    references/
      spec-format.md            ← spec-format.md
  sdd-generate/
    SKILL.md                    ← skills/sdd-generate.md
    references/
      spec-format.md            ← spec-format.md
```

#### Cursor

Cursor discovers rules as `.md` or `.mdc` files in `.cursor/rules/`. Each skill becomes a single rule file with YAML frontmatter. The frontmatter uses `description` for intelligent matching (Cursor decides when to apply the rule based on relevance). The body contains the full skill content followed by a reference to `spec-format.md`.

```
.cursor/rules/
  opensdd-gate.md                 ← gate rule with alwaysApply: true (see Always-On Gate Rule)
  sdd-manager.md                  ← skills/sdd-manager.md with Cursor frontmatter
  sdd-generate.md                 ← skills/sdd-generate.md with Cursor frontmatter
  opensdd-spec-format.md          ← spec-format.md with Cursor frontmatter
```

Frontmatter for `opensdd-gate.md`:
```yaml
---
alwaysApply: true
---
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

Copilot discovers instructions as `.instructions.md` files in `.github/instructions/` and project-wide instructions in `.github/copilot-instructions.md`. Each skill becomes an instruction file with YAML frontmatter. The `applyTo` field is set to `"**"` so the instructions are available across the project.

The gate rule is installed in `.github/copilot-instructions.md` (always loaded by Copilot) as a managed section.

```
.github/copilot-instructions.md  ← gate rule in managed section (see Always-On Gate Rule)
.github/instructions/
  sdd-manager.instructions.md   ← skills/sdd-manager.md with Copilot frontmatter
  sdd-generate.instructions.md  ← skills/sdd-generate.md with Copilot frontmatter
  opensdd-spec-format.instructions.md  ← spec-format.md with Copilot frontmatter
```

Frontmatter for `sdd-manager.instructions.md`:
```yaml
---
applyTo: "**"
description: "Implement, update, and verify installed OpenSDD dependency specs. Use when the user asks to implement a spec, process a spec update, check conformance, or create a deviation."
---
```

Frontmatter for `sdd-generate.instructions.md`:
```yaml
---
applyTo: "**"
description: "Generate an OpenSDD behavioral spec from existing code. Use when the user asks to generate, create, or extract a spec from a repository or codebase."
---
```

Frontmatter for `opensdd-spec-format.instructions.md`:
```yaml
---
applyTo: "**"
description: "OpenSDD spec format reference. Defines the structure and rules for behavioral specifications. Referenced by sdd-manager and sdd-generate skills."
---
```

#### Gemini CLI

Gemini CLI discovers `GEMINI.md` files in the project directory and supports `@file.md` import syntax for referencing other files. Rather than duplicating skill content, the CLI appends import directives to `GEMINI.md` (creating it if it does not exist) that reference the canonical skill files from the Claude Code installation.

Appended to `GEMINI.md`:
```markdown
<!-- OpenSDD Skills (managed by opensdd — do not edit this section) -->
This project uses OpenSDD spec-driven development. Before implementing, modifying, or verifying any code governed by an OpenSDD spec, you MUST load and follow the sdd-manager skill/instructions first. Check `opensdd.json` and `.opensdd.deps/` to identify spec-governed code.

@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md
@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md
```

The CLI MUST only modify the clearly delimited OpenSDD section. If a `GEMINI.md` already exists with an OpenSDD section, the CLI MUST replace that section. Content outside the section MUST NOT be modified.

#### Amp / Codex CLI

Amp and Codex CLI discover `AGENTS.md` files in the project directory and support `@` reference syntax for including other files. The CLI appends references to `AGENTS.md` (creating it if it does not exist) that point to the canonical skill files.

Appended to `AGENTS.md`:
```markdown
<!-- OpenSDD Skills (managed by opensdd — do not edit this section) -->
This project uses OpenSDD spec-driven development. Before implementing, modifying, or verifying any code governed by an OpenSDD spec, you MUST load and follow the sdd-manager skill/instructions first. Check `opensdd.json` and `.opensdd.deps/` to identify spec-governed code.

@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md
@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md
```

The CLI MUST only modify the clearly delimited OpenSDD section. If an `AGENTS.md` already exists with an OpenSDD section, the CLI MUST replace that section. Content outside the section MUST NOT be modified.

#### Installation notes

- The Claude Code installation (`.claude/skills/`) serves as the canonical source that Gemini CLI and Amp reference via imports. It MUST always be installed, even if the user only uses Gemini or Amp.
- All installed files are overwritten on every `opensdd init` or `opensdd sync`. The CLI MUST NOT prompt for confirmation before overwriting skill files.
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

Fetches a spec from the registry and installs it as a dependency. The install behavior depends on the resolved install mode.

#### Install Mode Resolution

The install mode is resolved in this order:
1. `--skill` flag on the command (if provided): forces skill mode for this install.
2. `installMode` field in `opensdd.json` (if present).
3. Default: `"default"`.

- **`"default"`** (or omitted): Installs the spec as a dependency in `<depsDir>/<name>/`. The agent uses the sdd-manager skill to implement, test, and maintain conformance with the spec.
- **`"skill"`**: Installs the spec as an agent skill across all supported agent formats. The spec content is available to the agent as contextual guidance — no formal implementation tracking, conformance, or deviations workflow. This is a lighter-weight integration for consumers who want spec guidance without the full SDD workflow.

#### Behavior (default mode)

1. Verify `opensdd.json` exists at the project root. If not, auto-bootstrap as a consumer project: create a minimal `opensdd.json` (no `specsDir`), install consumer-mode skills, create the `.opensdd.deps/` directory, print "Auto-initialized OpenSDD (consumer).", and continue with the normal install flow.
2. Check if the spec `<name>` already exists as a key in `opensdd.json`'s `dependencies` object. If it does AND the spec directory exists in `<depsDir>`, print a message indicating the spec is already installed and suggest `opensdd update` instead. Exit with code 1. If the entry exists BUT the spec directory is missing, treat as a re-install: log a message noting the stale entry, then continue to step 4 using the version from the existing entry (unless `[version]` is explicitly provided, in which case use that).
3. Validate the spec name (lowercase alphanumeric and hyphens only).
4. Fetch `index.json` from `registry/<name>/` in the configured registry source. If `[version]` is provided, use that version; otherwise use `latest` from `index.json`.
5. Read `manifest.json` from `registry/<name>/<version>/` to get specFormat and dependencies.
6. Copy all files from `registry/<name>/<version>/` into `<depsDir>/<name>/` (including `manifest.json`, `spec.md`, and any supplementary files).
7. Add an entry to `opensdd.json` under `dependencies.<name>` with fields from `manifest.json` (`version`, `specFormat`), the resolved registry URL as `source`, and consumer-managed fields initialized to defaults: `implementation: null`, `tests: null`, `hasDeviations: false`.
8. If the spec has `dependencies`, check whether each dependency name exists as a key in `opensdd.json`'s `dependencies` object. If any are missing, print a warning listing the missing dependencies and suggesting `opensdd install` for each.
9. Print a success message.

- `opensdd install slugify` MUST create `.opensdd.deps/slugify/` with all spec files and add a `slugify` entry to `opensdd.json` `dependencies`

#### Behavior (skill mode)

When the resolved install mode is `"skill"`:

1. Verify `opensdd.json` exists at the project root. If not, auto-bootstrap as a consumer project. If the `--skill` flag was passed, set `installMode: "skill"` in the new `opensdd.json`.
2. Check if the spec `<name>` already exists as a key in `opensdd.json`'s `dependencies` object. If it does, print a message indicating the spec is already installed and suggest `opensdd update` instead. Exit with code 1.
3. Validate the spec name (lowercase alphanumeric and hyphens only).
4. Fetch `index.json` from `registry/<name>/` in the configured registry source. If `[version]` is provided, use that version; otherwise use `latest` from `index.json`.
5. Fetch the `SKILL.md` from `registry/<name>/<version>/`. If no `SKILL.md` exists, generate one from `spec.md` using `generateSkillMd`. Also fetch any supplementary `.md` files (excluding `spec.md`, `manifest.json`, `deviations.md`).
6. Install the skill files across all supported agent formats, following the same per-agent mapping used by `opensdd init` (see Skill Installation Mapping). The skill is installed under the spec's name (e.g., `.claude/skills/<name>/SKILL.md`). Supplementary `.md` files are placed in a `references/` subdirectory.
7. Add an entry to `opensdd.json` under `dependencies.<name>` with `version`, `specFormat`, `source`, and `mode: "skill"`. Consumer-managed fields (`implementation`, `tests`, `hasDeviations`) are NOT included.
8. Print a success message.

- `opensdd install slugify` in skill mode MUST install skill files across all agent formats and add a `slugify` entry to `opensdd.json` `dependencies` with `mode: "skill"`

#### Input

- `<name>` (required): The spec name as it appears in the registry.
- `[version]` (optional): Specific semver version to install. Defaults to latest.
- `--skill` (optional): Install as an agent skill instead of a full spec dependency. Overrides `installMode` in `opensdd.json`. When used during auto-bootstrap, sets `installMode: "skill"` in the new `opensdd.json`.
- `--registry <url>` (optional): Alternative registry source.

#### Output (default mode)

```
Installed slugify v2.2.0 to .opensdd.deps/slugify/

Run "implement the slugify spec" in your agent to generate an implementation.
```

#### Output (skill mode)

```
Installed slugify v2.2.0 as skill
  Skills installed for: Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp
```

#### Errors

- Spec not found in registry: print error listing available specs and exit with code 1.
- Requested version not found: print error listing available versions and exit with code 1.
- Spec already installed (entry and directory both exist in default mode, or entry exists in skill mode): print message suggesting `opensdd update` and exit with code 1.

### `opensdd update [name]`

Fetches the latest version of installed dependency specs from the registry, updates spec files in `.opensdd.deps/`, and stages the update for the agent to process. Does NOT modify `opensdd.json` — the dependency entry remains at the old version until `opensdd update apply` is called after the agent has confirmed the migration.

#### Behavior

1. If `<name>` is provided, update that single spec. If no name is provided, update all installed dependencies.
2. For each spec being updated:
   a. Read the spec's entry in `opensdd.json` `dependencies` to get the installed version and `specFormat` version.
   b. Fetch `index.json` from the registry to get the latest version. Read `manifest.json` from the latest version directory.
   c. If the registry version matches the installed version, skip with a message "already up to date".
   d. Before overwriting, compute unified diffs of all spec-owned files that will change.
   e. Overwrite all spec-owned files in `<depsDir>/<name>/` with the new version from the registry (`manifest.json`, `spec.md`, and any supplementary files).
   f. MUST NOT overwrite or delete `deviations.md`. The CLI MUST NOT create, modify, or delete `deviations.md` under any circumstances.
   g. Create the staging directory `.opensdd.deps/.updates/<name>/` and write two files. If a pending update already exists for this spec, overwrite it and note the replacement in the output.
      - `changeset.md` — contains previous and new version, `specFormat` version change (if any), and unified diffs from step (d).
      - `manifest.json` — contains the metadata needed to finalize the update in `opensdd.json`: `name`, `previousVersion`, `version`, `source`, `specFormat`.
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
   b. Update the `opensdd.json` `dependencies.<name>` entry: set `version`, `source`, and `specFormat` from the manifest. Preserve all consumer-managed fields (`implementation`, `tests`, `hasDeviations`).
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
2. Read the `publish` object from `opensdd.json` (may be absent or incomplete).
3. For each required publish field (`name`, `version`, `description`, `specFormat`), if the field is missing or empty, prompt the user interactively:
   - `name`: "Spec name (lowercase alphanumeric and hyphens): "
   - `version`: "Version (semver, e.g. 1.0.0): "
   - `description`: "Description: "
   - `specFormat`: "Spec format version (e.g. 0.1.0): "
   Only prompt for fields that are actually missing — if the `publish` section exists with some fields populated, prompt only for the remaining ones. After collecting all required fields, write the completed `publish` object back to `opensdd.json` (preserving all other manifest fields) before continuing.
4. Verify `<specsDir>/spec.md` exists. If not, print error and exit with code 1.
5. Run validation on the `<specsDir>/` directory (same logic as `opensdd validate`). If validation fails with errors, print them and exit with code 1.
6. Resolve the registry source. The registry MUST be a GitHub repository URL for publishing.
7. Fetch `index.json` from `registry/<name>/` if it exists. If the version being published already exists in `index.json`, print error suggesting a version bump and exit with code 1.
8. Construct the registry entry:
   a. Build `manifest.json` from the `opensdd.json` `publish` fields (`name`, `version`, `description`, `specFormat`, `dependencies`).
   b. Collect all files from `<specsDir>/`.
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
- User provides empty or invalid input for a required publish field: re-prompt for the same field. If the user sends EOF (Ctrl+D) or an interrupt (Ctrl+C), exit with code 1.
- `<specsDir>/spec.md` missing: print error and exit with code 1.
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
3. If `dependencies` exists and has entries, iterate the `dependencies` object. For each entry, read its consumer-managed fields and check for the presence of `deviations.md` in `<depsDir>/<name>/`. Print a dependency status table.
4. Check for untracked directories: spec directories in `<depsDir>` that have no corresponding `opensdd.json` dependency entry. Warn about any found.

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
   b. `specFormat` MUST be present and be a recognized version.
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

### `opensdd setup-ci`

Sets up GitHub Actions CI for the spec-driven Propose workflow. Automates the one-time repository configuration: GitHub labels, Claude Code OAuth token as a repo secret, and two GitHub Actions workflow files.

#### Prerequisites

- `gh` CLI installed and authenticated (`gh auth status` succeeds)
- `claude` CLI installed (for token generation via `claude setup-token`)
- Current directory is inside a git repo with a GitHub remote
- `opensdd.json` exists (run `opensdd init` first)

#### Behavior

1. **Validate environment.**
   a. Verify `opensdd.json` exists (resolve via manifest resolution). If not, print "OpenSDD not initialized. Run `opensdd init` first." and exit with code 1.
   b. Verify `gh` is installed by running `gh --version`. If not found, print "Error: GitHub CLI (gh) is required. Install it from https://cli.github.com" and exit with code 1.
   c. Verify `gh` is authenticated by running `gh auth status`. If not authenticated, print "Error: GitHub CLI is not authenticated. Run `gh auth login` first." and exit with code 1.
   d. Verify `claude` is installed by running `claude --version`. If not found AND `--skip-token` is not set, print "Error: Claude CLI is required for token setup. Install it or use --skip-token to skip." and exit with code 1.
   e. Verify the current directory is inside a git repo with a GitHub remote. Resolve the GitHub owner/repo from the remote URL using `gh repo view --json nameWithOwner`. If no GitHub remote is found, print "Error: No GitHub remote found. Add a GitHub remote first." and exit with code 1.

2. **Create GitHub labels.** Create the following labels using `gh label create`:

   | Label | Color | Description |
   |-------|-------|-------------|
   | `spec` | `#0E8A16` | PR contains only spec changes |
   | `implement-spec` | `#1D76DB` | Issue to be auto-implemented by Claude |

   For each label, attempt creation. If the label already exists (`gh label create` exits with a non-zero code indicating it exists), skip and report as "already exists". The CLI MUST NOT fail if a label already exists.

3. **Set up Claude Code OAuth token.** If `--skip-token` is set, skip this step and report "skipped (--skip-token)".
   a. Run `claude setup-token` to generate a token. Capture the output token.
   b. Check if the secret `CLAUDE_CODE_OAUTH_TOKEN` already exists by running `gh secret list` and checking for the name. If it exists and `--force` is not set, prompt the user: "Secret CLAUDE_CODE_OAUTH_TOKEN already exists. Overwrite? (y/n)". If declined, skip and report "already exists (kept)".
   c. Set the token as a GitHub repo secret via `gh secret set CLAUDE_CODE_OAUTH_TOKEN`.

4. **Install GitHub Actions workflows.** Copy the two bundled workflow files into `.github/workflows/` (creating the directory if it does not exist):
   - `spec-merged.yml` — Triggers on `spec`-labeled PR merge, creates an implementation issue with the `implement-spec` label, and dispatches a `repository_dispatch` event to trigger implementation
   - `claude-implement.yml` — Handles automated implementation (via `repository_dispatch` or manual `implement-spec` label) and interactive `@claude` mentions on issues and PR review comments

   For each file: if the file already exists and `--force` is not set, prompt the user: "Workflow .github/workflows/{name} already exists. Overwrite? (y/n)". If declined, skip and report "already exists (kept)".

   The workflow file contents MUST be bundled with the OpenSDD package (not fetched from a remote). They are embedded as string constants in the implementation module.

5. **Print summary.**

- `opensdd setup-ci` MUST validate all prerequisites before performing any mutations
- `opensdd setup-ci` MUST be idempotent — safe to run multiple times without error
- `opensdd setup-ci --dry-run` MUST NOT create labels, set secrets, or write files

#### Input

- `--force` (optional): Overwrite existing labels, secrets, and workflow files without prompting.
- `--dry-run` (optional): Print what would be done without making any changes.
- `--skip-token` (optional): Skip the Claude OAuth token step (for cases where the secret is managed externally, e.g., org-level secrets).

#### Output

```
OpenSDD CI setup complete:
  ✓ Label: spec                              created
  ✓ Label: implement-spec                    created
  ✓ Secret: CLAUDE_CODE_OAUTH_TOKEN          set
  ✓ Workflow: .github/workflows/spec-merged.yml       installed
  ✓ Workflow: .github/workflows/claude-implement.yml  installed

You can now use the Propose workflow to submit specs for CI implementation.
```

When items are skipped:
```
OpenSDD CI setup complete:
  ✓ Label: spec                              already exists
  ✓ Label: implement-spec                    created
  - Secret: CLAUDE_CODE_OAUTH_TOKEN          skipped (--skip-token)
  ✓ Workflow: .github/workflows/spec-merged.yml       already exists (kept)
  ✓ Workflow: .github/workflows/claude-implement.yml  installed

You can now use the Propose workflow to submit specs for CI implementation.
```

Dry-run output:
```
OpenSDD CI setup (dry run):
  Would create label: spec (#0E8A16)
  Would create label: implement-spec (#1D76DB)
  Would set secret: CLAUDE_CODE_OAUTH_TOKEN
  Would install: .github/workflows/spec-merged.yml
  Would install: .github/workflows/claude-implement.yml

Run without --dry-run to apply.
```

#### Errors

- OpenSDD not initialized: print message suggesting `opensdd init` and exit with code 1.
- `gh` not installed: print error with install URL and exit with code 1.
- `gh` not authenticated: print error suggesting `gh auth login` and exit with code 1.
- `claude` not installed (without `--skip-token`): print error suggesting install or `--skip-token` and exit with code 1.
- No GitHub remote: print error and exit with code 1.
- `claude setup-token` fails: print error with the stderr output and exit with code 1.
- `gh secret set` fails: print error with the stderr output and exit with code 1.
- `.github/workflows/` cannot be created (permissions): print error and exit with code 1.

#### Workflow File Contents

The two workflow files are bundled as string constants within the OpenSDD package. They MUST NOT be fetched from a remote at runtime.

##### spec-merged.yml

Triggers when a PR with the `spec` label is merged. Extracts the OpenSDD metadata block from the PR body, identifies the changed spec files, creates a GitHub issue with the `implement-spec` label for tracking, and dispatches a `repository_dispatch` event to trigger the implementation workflow. The `repository_dispatch` event is used instead of relying on the `labeled` event because GitHub Actions suppresses events generated by the default `GITHUB_TOKEN` from triggering other workflows — but explicitly exempts `repository_dispatch` and `workflow_dispatch` from this restriction.

```yaml
name: "OpenSDD: Spec Merged"

on:
  pull_request:
    types: [closed]

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  create-implementation-issue:
    if: github.event.pull_request.merged == true && contains(github.event.pull_request.labels.*.name, 'spec')
    runs-on: ubuntu-latest
    steps:
      - name: Extract OpenSDD metadata
        id: metadata
        uses: actions/github-script@v7
        with:
          script: |
            const body = context.payload.pull_request.body || '';
            const match = body.match(/<!--\s*opensdd\n([\s\S]*?)-->/);
            if (!match) {
              core.setFailed('No OpenSDD metadata block found in PR body');
              return;
            }
            const lines = match[1].trim().split('\n');
            const metadata = {};
            for (const line of lines) {
              const [key, ...rest] = line.split(':');
              metadata[key.trim()] = rest.join(':').trim();
            }
            core.setOutput('package-name', metadata['package-name'] || '');
            core.setOutput('package-path', metadata['package-path'] || '');
            core.setOutput('specs-dir', metadata['specs-dir'] || 'opensdd');

      - name: Get changed spec files
        id: changed-files
        uses: actions/github-script@v7
        with:
          script: |
            const files = await github.rest.pulls.listFiles({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.pull_request.number,
              per_page: 100
            });
            const specFiles = files.data
              .map(f => f.filename)
              .filter(f => f.endsWith('.md') || f.endsWith('.sdd.md'));
            core.setOutput('files', specFiles.join('\n'));

      - name: Create implementation issue
        id: create-issue
        uses: actions/github-script@v7
        with:
          script: |
            const packageName = '${{ steps.metadata.outputs.package-name }}';
            const packagePath = '${{ steps.metadata.outputs.package-path }}';
            const specsDir = '${{ steps.metadata.outputs.specs-dir }}';
            const specFiles = `${{ steps.changed-files.outputs.files }}`;
            const prNumber = context.payload.pull_request.number;
            const prTitle = context.payload.pull_request.title;

            const title = packagePath
              ? `implement(${packageName}): ${prTitle.replace(/^spec(\([^)]*\))?:\s*/, '')}`
              : `implement: ${prTitle.replace(/^spec:\s*/, '')}`;

            const body = [
              `## Spec Implementation`,
              ``,
              `Spec PR: #${prNumber}`,
              `Package: \`${packageName}\``,
              packagePath ? `Package path: \`${packagePath}\`` : '',
              `Specs dir: \`${specsDir}\``,
              ``,
              `### Changed spec files`,
              ``,
              specFiles.split('\n').map(f => `- \`${f}\``).join('\n'),
              ``,
              `### Instructions`,
              ``,
              `Read the spec files listed above and run \`/sdd-manager implement\` to generate the implementation.`,
              ``,
              `<!-- opensdd`,
              `package-name: ${packageName}`,
              `package-path: ${packagePath}`,
              `specs-dir: ${specsDir}`,
              `spec-pr: ${prNumber}`,
              `-->`,
            ].filter(Boolean).join('\n');

            const issue = await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title,
              body,
              labels: ['implement-spec']
            });
            core.setOutput('issue-number', issue.data.number);

      - name: Trigger implementation
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.repos.createDispatchEvent({
              owner: context.repo.owner,
              repo: context.repo.repo,
              event_type: 'implement-spec',
              client_payload: {
                issue_number: ${{ steps.create-issue.outputs.issue-number }},
                package_name: '${{ steps.metadata.outputs.package-name }}',
                package_path: '${{ steps.metadata.outputs.package-path }}',
                specs_dir: '${{ steps.metadata.outputs.specs-dir }}',
                spec_pr: ${{ github.event.pull_request.number }}
              }
            });
```

##### claude-implement.yml

Handles all Claude Code interactions for the repository. Has two modes:

- **Automated implementation** — Triggered by `repository_dispatch` (from `spec-merged.yml` after a spec PR merges) or by manually adding the `implement-spec` label to an issue. Extracts metadata and runs `claude-code-action` with an implementation prompt.
- **Interactive** — Triggered by `@claude` mentions in issue comments or PR review comments. Runs `claude-code-action` in interactive mode (no prompt) so Claude responds to the user's message directly.

```yaml
name: "OpenSDD: Implement Spec"

on:
  repository_dispatch:
    types: [implement-spec]
  issues:
    types: [labeled]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write

jobs:
  implement:
    if: |
      github.event_name == 'repository_dispatch' ||
      (github.event_name == 'issues' && github.event.label.name == 'implement-spec')
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Extract metadata
        id: metadata
        uses: actions/github-script@v7
        with:
          script: |
            let metadata;
            if (context.eventName === 'repository_dispatch') {
              const p = context.payload.client_payload;
              metadata = {
                'package-name': p.package_name || '',
                'package-path': p.package_path || '',
                'specs-dir': p.specs_dir || 'opensdd',
                'spec-pr': String(p.spec_pr || ''),
              };
            } else {
              const body = context.payload.issue.body || '';
              const match = body.match(/<!--\s*opensdd\n([\s\S]*?)-->/);
              if (!match) {
                core.setFailed('No OpenSDD metadata block found in issue body');
                return;
              }
              const lines = match[1].trim().split('\n');
              metadata = {};
              for (const line of lines) {
                const [key, ...rest] = line.split(':');
                metadata[key.trim()] = rest.join(':').trim();
              }
            }
            core.setOutput('package-name', metadata['package-name'] || '');
            core.setOutput('package-path', metadata['package-path'] || '');
            core.setOutput('specs-dir', metadata['specs-dir'] || 'opensdd');
            core.setOutput('spec-pr', metadata['spec-pr'] || '');

      - name: Implement with Claude
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          prompt: |
            You are implementing a spec that was merged in PR #${{ steps.metadata.outputs.spec-pr }}.

            Package: ${{ steps.metadata.outputs.package-name }}
            Package path: ${{ steps.metadata.outputs.package-path }}
            Specs dir: ${{ steps.metadata.outputs.specs-dir }}

            Instructions:
            1. Navigate to the package path (if set): cd ${{ steps.metadata.outputs.package-path || '.' }}
            2. Read the spec files in the specs directory
            3. Run /sdd-manager implement to generate the implementation
            4. Create a PR with the implementation

  claude:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude'))
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Respond with Claude
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

These templates are canonical references. The CLI embeds them as string constants and writes them verbatim to `.github/workflows/`.

### Manifest Resolution

Commands that require `opensdd.json` (all commands except `opensdd list` and `opensdd validate`) MUST resolve it by searching upward from the current working directory, stopping at the first `opensdd.json` found. This supports monorepos where each sub-project has its own `opensdd.json`. If no `opensdd.json` is found in any ancestor directory, the command fails with the appropriate "not initialized" error.

`opensdd init` always creates `opensdd.json` in the current working directory. `opensdd sync` never creates `opensdd.json` — it only updates skill files. Skills are always installed at the git repository root (or the current working directory if not inside a git repository). This separation allows monorepo sub-projects to each have their own `opensdd.json` while sharing a single skill installation at the repo root.

In a monorepo, `opensdd init` also creates a minimal root-level `opensdd.json` at the git root (if one does not already exist) when the current working directory differs from the git root. This root manifest contains only the protocol version (`{ "opensdd": "0.1.0" }`) and serves as a workspace root marker — it allows repo-level commands (e.g., `opensdd setup-ci`) to find a manifest when run from the repo root. The root manifest does not contain `specsDir`, `depsDir`, `publish`, or `dependencies` — it is not a package manifest.

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
- `hasDeviations`

The CLI reads the existing `opensdd.json` dependency entry, applies updated metadata from the staged manifest, then re-applies the consumer-managed field values. Note that `opensdd update` does NOT touch `opensdd.json` at all — it only stages the update. The `opensdd.json` entry continues to reflect the old version until `opensdd update apply` is called.

## Edge Cases

- Running `opensdd install` for a spec that was previously installed and then manually deleted (directory gone, `opensdd.json` entry gone): treat as a fresh install.
- Running `opensdd install` when the `opensdd.json` dependency entry exists but the directory is missing: treat as a re-install — re-fetch spec files for the version in the existing entry and recreate the directory.
- Spec directory exists in `.opensdd.deps/` but has no `opensdd.json` dependency entry: `opensdd status` MUST warn about untracked spec directories.
- Running `opensdd update` when a spec's registry entry has been removed: print a warning that the spec is no longer available in the registry but leave local files and `opensdd.json` entry untouched.
- Running `opensdd update` when a pending update already exists for the spec: overwrite the existing staged update with the new one.
- Running `opensdd update apply` when no pending updates exist: print "No pending updates." and exit with code 0 (not an error).
- Running `opensdd update apply <name>` when the agent hasn't finished processing the changeset: the CLI has no way to verify this — it's the user's responsibility to confirm the migration is complete before applying.
- Running `opensdd init` in a project that already has `opensdd.json`: print "Already initialized. Run `opensdd sync` to update skill files." and exit with code 0.
- Running `opensdd install` in an uninitialized project: auto-bootstrap as consumer, then continue with install. The auto-bootstrap uses default `installMode` unless the user later changes it.
- Running `opensdd install` in skill mode for a spec that has no `SKILL.md` in the registry: generate one from `spec.md` using `generateSkillMd`.
- Running `opensdd update` in skill mode: re-fetch the skill files and re-install across all agent formats, then stage the update as usual.
- Switching `installMode` after dependencies are already installed: existing dependencies retain their original install mode (tracked via `mode` field in the dependency entry). New installs use the current `installMode`.
- Running any command outside a project directory (no project markers found): warn but allow with confirmation, except `opensdd list` and `opensdd validate` which work anywhere.
- Spec name contains characters invalid for directory names: reject with an error listing allowed characters (lowercase alphanumeric and hyphens).
- Publishing a version that already exists in the registry: reject with an error suggesting a version bump.
- Publishing when the registry is a local path (not GitHub): reject with an error (publishing requires a GitHub registry for PR workflow).
- Running `opensdd publish` when `gh` CLI is not installed: print error with installation guidance.
- Running `opensdd install` with a version that doesn't exist in the registry: print error listing available versions.
- Running `opensdd sync` in a monorepo sub-project: resolves `opensdd.json` from the current directory, installs skills at the git root. Overwrites skill files unconditionally.
- Running `opensdd sync` in an uninitialized project: print "OpenSDD not initialized. Run `opensdd init` to get started." and exit with code 1.
- Running `opensdd sync` when skills are already up to date: overwrite anyway (skills are spec-owned, always overwritten).
- Running `opensdd setup-ci` from the repo root of a monorepo: finds the root `opensdd.json` and proceeds. The CI setup is repo-scoped (labels, secrets, workflows), not package-scoped.
- Running `opensdd setup-ci` in a repo that already has partial CI setup (some labels exist, workflows exist but secret is missing): each step checks independently and skips what already exists.
- Running `opensdd setup-ci` when `gh` is installed but not authenticated: detect via `gh auth status` exit code and print a clear error before any mutations.
- Running `opensdd setup-ci --dry-run`: no mutations are performed. Labels are not created, secrets are not set, files are not written. Only a summary of what would happen is printed.
- Running `opensdd setup-ci --force`: all prompts for existing items are skipped; labels are re-created, secret is overwritten, workflow files are overwritten.
- Running `opensdd setup-ci` with `--skip-token` and `claude` not installed: succeeds (claude is not required when token step is skipped).
- Running `opensdd setup-ci` in a non-GitHub repo (e.g., GitLab remote): fails with "No GitHub remote found" error.

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
- Skill installation files MUST always be installed at the git repository root (or cwd if no git root). They are fully spec-owned and overwritten on every `opensdd init` or `opensdd sync`.
- The Claude Code skill installation (`.claude/skills/`) at the skill installation root MUST always be present since Gemini CLI and Amp reference it
- `opensdd.json` MUST be created by `opensdd init` if it does not exist, and MUST NOT be overwritten if it already exists
- Consumer-managed `opensdd.json` fields MUST survive all update operations
- Every default-mode dependency MUST have both a directory in `depsDir` and an entry in `opensdd.json` `dependencies`
- Every skill-mode dependency MUST have skill files installed across all agent formats and an entry in `opensdd.json` `dependencies` with `mode: "skill"`
- All commands MUST exit with code 0 on success and code 1 on error
- The CLI MUST NOT invoke an AI model or coding agent
- `opensdd publish` MUST NOT allow overwriting an existing version in the registry
- `.opensdd.deps/` MUST be committed to the repo (NOT gitignored)
- `opensdd init` in a monorepo sub-project MUST create a root-level `opensdd.json` at the git root if one does not exist. `opensdd sync` MUST NOT create `opensdd.json` — it only updates skill files.
- `opensdd setup-ci` MUST validate all prerequisites before performing any mutations
- `opensdd setup-ci` MUST be idempotent — running it multiple times MUST NOT cause errors
- `opensdd setup-ci --dry-run` MUST NOT create labels, set secrets, or write workflow files
- The bundled workflow files MUST be embedded in the package, not fetched from a remote
