# OpenSDD

> A protocol, CLI, and agent skills for spec-driven development — write behavioral specs, share them via a registry, and let AI agents generate bespoke implementations.

## Version

0.1.0

## Overview

OpenSDD (Open Spec-Driven Development) treats behavioral specifications as the source of truth for software. A spec defines **what** software does and **what constraints** it must satisfy, while leaving **how** it is implemented to the consuming agent. Specs are language-agnostic by default — the same spec can produce implementations in any language or framework.

The system has four components:

- **[Spec Format](spec-format.md)** — The standard format for behavioral specifications. Defines spec structure, the `opensdd.json` manifest, the registry layout, and the protocol rules that all other components depend on.
- **[CLI](cli.md)** — A Node.js command-line tool (`opensdd`) that initializes projects, installs and updates specs from a registry, publishes authored specs, and installs agent skills.
- **[SDD Manager](sdd-manager.md)** — A skill installed into coding agents that teaches them how to implement, update, verify, and deviate from installed dependency specs.
- **[SDD Generate](sdd-generate.md)** — A skill installed into coding agents that teaches them how to generate a behavioral spec from an existing codebase.

## Behavioral Contract

### Spec Authoring

A project authors a spec by placing a `spec.md` in its `opensdd/` directory (configurable via `opensdd.json`). The spec MUST contain an H1 header with a blockquote summary and a `## Behavioral Contract` section. The author MAY include supplementary files in the same directory; all supplementary files MUST be reachable by following links from `spec.md`.

Development is spec-first: behavior changes start in the spec, then code is updated to match.

See [Spec Format](spec-format.md) for the full format definition, required and recommended sections, and inline example conventions.

### Spec Distribution

Specs are distributed via a registry — a versioned store of published specs. The default registry is the `registry/` directory in the OpenSDD GitHub repository.

- `opensdd publish` packages the authored spec and opens a PR against the registry.
- `opensdd install <name>` fetches a spec from the registry and places it in `.opensdd.deps/<name>/`.
- `opensdd update [name]` pulls newer versions and stages changesets for the agent to process.

Installed spec files are spec-owned and MUST NOT be edited by the consumer. The `.opensdd.deps/` directory MUST be committed to the repo.

See [CLI](cli.md) for the full command reference, registry source resolution, and update staging behavior.

### Spec Implementation

When a consumer installs a spec, their AI agent implements it using the sdd-manager skill. The agent reads the spec, checks project conventions (language, framework, test runner), generates an implementation, and runs a verification protocol that includes both a test suite and a spec compliance audit.

The agent MUST NOT implement or modify code based on an OpenSDD spec outside of the workflows defined by the sdd-manager skill.

See [SDD Manager](sdd-manager.md) for the implementation, update, conformance check, and deviation workflows.

### Spec Generation

The sdd-generate skill teaches agents to generate a behavioral spec from an existing codebase via a multi-pass, artifact-driven strategy. The generated spec follows the spec format and is written to `opensdd/spec.md`.

See [SDD Generate](sdd-generate.md) for the multi-pass strategy, prerequisites, and output format.

### Agent Skill Installation

`opensdd init` installs both skills (sdd-manager and sdd-generate) into the native configuration format of each supported coding agent:

- **Claude Code** — `.claude/skills/<name>/SKILL.md` with `references/`
- **OpenAI Codex CLI** — `.agents/skills/<name>/SKILL.md` with `references/`
- **Cursor** — `.cursor/rules/<name>.md` with YAML frontmatter
- **GitHub Copilot** — `.github/instructions/<name>.instructions.md` with YAML frontmatter
- **Gemini CLI** — `GEMINI.md` with `@` imports to canonical skill files
- **Amp** — `AGENTS.md` with `@` references to canonical skill files

All skill files are spec-owned and overwritten on every `opensdd init`. The Claude Code installation serves as the canonical source that Gemini CLI and Amp reference.

See [CLI — Skill Installation Mapping](cli.md#skill-installation-mapping) for the full mapping and installation rules.

## NOT Specified (Implementation Freedom)

- The internal prompting strategy of the sdd-manager and sdd-generate skills
- How agents discover skills (defined by each agent's native mechanism)
- The specific testing framework or test runner (determined by the consumer's project)
- How agents generate implementations (model choice, temperature, etc.)
- The transport mechanism for fetching specs from a registry (defined by the CLI)
- File encoding (assumed UTF-8)

## Invariants

- A spec MUST always contain an H1 header with blockquote summary and a `## Behavioral Contract` section
- Spec-owned files in `.opensdd.deps/` MUST NOT be modified by the consumer
- `deviations.md` MUST NOT be created, modified, or deleted by the CLI or any automated tooling
- Consumer-managed `opensdd.json` fields MUST survive all update operations
- The `.opensdd.deps/` directory MUST be committed to the repo
- Publishing MUST NOT allow overwriting an existing version in the registry
- All supplementary files in a spec directory MUST be reachable by following links from `spec.md`
