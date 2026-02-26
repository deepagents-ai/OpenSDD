<p align="center">
  <b>OpenSDD</b>
</p>

<p align="center">
  <b>--Open Spec-Driven Development--</b>
</p>

---

AI agents are great at writing code, but they need to know *what* to build. OpenSDD is a protocol and CLI for writing, sharing, and consuming **behavioral specs** — language-agnostic contracts that tell agents what software should do, without dictating how.

Think of it like a package manager, but for specifications instead of code.

```bash
npm install -g opensdd

# Initialize OpenSDD in your project
opensdd init

# Install a spec from the registry
opensdd install slugify
```

Then tell your coding agent: "implement the slugify spec" — it reads the spec, writes the code, and generates tests.

## How It Works

1. **Write a spec** — Define what your software does in `opensdd/spec.md` using a simple markdown format with behavioral contracts, edge cases, and invariants.
2. **Share it** — Publish your spec to a registry with `opensdd publish`. Others can install it with `opensdd install`.
3. **Implement it** — Your AI agent reads the spec and generates a bespoke implementation in whatever language and framework your project uses.

Specs are the source of truth. Code flows from the spec, not the other way around.

## Features

- **Language-agnostic specs** — One spec, any implementation. The same spec produces TypeScript, Python, Rust, or whatever your project needs.
- **Registry & versioning** — Publish, install, and update specs with semver. Updates produce changesets so your agent knows exactly what changed.
- **Multi-agent support** — Skills auto-install for Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, and Amp.
- **Deviations** — Need to diverge from a spec? Document it formally instead of silently drifting.
- **Spec dependencies** — Specs can reference other specs for shared types and contracts.

## Quick Example

A spec (`spec.md`) looks like this:

```markdown
# slugify

> Converts a string into a URL-friendly slug.

## Behavioral Contract

### Core Behavior

Accepts a string and returns a lowercase, hyphen-separated slug.

- `slugify("Hello World")` MUST return `"hello-world"`
- `slugify("Déjà Vu")` MUST return `"deja-vu"`

## Invariants

- For any string `x`: `slugify(slugify(x)) === slugify(x)` (idempotent)
```

## Documentation

- [Spec Format](opensdd/spec-format.md) — How to write specs
- [CLI Reference](opensdd/cli.md) — All CLI commands
- [SDD Manager Skill](opensdd/sdd-manager.md) — How agents implement and verify specs
- [SDD Generate Skill](opensdd/sdd-generate.md) — How agents generate specs from existing code

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and workflows.

## License

MIT — see [LICENSE](LICENSE) for details.
