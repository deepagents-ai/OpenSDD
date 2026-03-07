<p align="center">
  <b>OpenSDD</b>
</p>

<p align="center">
  <b>--Open Spec-Driven Development--</b>
</p>

---

An open protocol for spec-driven development with AI coding agents.

OpenSDD is a protocol and CLI for writing, sharing, and implementing **behavioral specs** — language-agnostic contracts that define what software should do, without dictating how. Specs are the source of truth. Code is derived from the spec, not the other way around.

## How It Works

1. **Write a spec** — Define behavior in markdown: contracts, edge cases, invariants.
2. **Implement it** — Your AI agent reads the spec and produces an implementation that fits your project's language, framework, and conventions.
3. **Evolve it** — When behavior needs to change, draft a changelog against the spec. Iterate until the changes are right, merge into the spec, then update the code.

## Quick Example

```markdown
# rate-limiter

> Token-bucket rate limiter.

## Behavioral Contract

### Core Behavior

Tracks request counts per client within a sliding time window.

- `allow(clientId)` MUST return `true` when the client is within their limit
- `allow(clientId)` MUST return `false` when the client has exhausted their limit
- The window MUST reset after `windowMs` milliseconds of no requests

### Invariants

- Total allowed requests per window MUST NOT exceed `maxRequests`
```

One spec, many implementations. Install it into an Express API and get middleware. Install it into a Python service and get a decorator. The spec is the reusable artifact — not the code.

## Open Spec Registry

Specs can be published to the OpenSDD registry and pulled into any project:

```bash
opensdd install rate-limiter
```

Installation supports two formats:

- **Default mode** — The spec is installed into the `.opensdd.deps/` directory and managed through the full OpenSDD workflow: implementation tracking, conformance checking, deviations, and versioned updates.
- **Skill mode** — The spec is installed as an agent skill across all supported coding agents (Claude Code, Codex CLI, Cursor, GitHub Copilot, Gemini CLI, Amp). Your agent gets the spec as contextual guidance without the formal SDD workflow. Use `--skill` on the install command, or set `"installMode": "skill"` in `opensdd.json` to make it the default.

```bash
opensdd install rate-limiter --skill
```

In either mode, your agent reads the spec and generates an implementation native to your stack.

## Documentation

- [Spec Format](opensdd/spec-format.md) — How to write specs
- [CLI Reference](opensdd/cli.md) — All CLI commands
- [SDD Manager Skill](opensdd/skills/sdd-manager.md) — How agents implement and verify specs
- [SDD Generate Skill](opensdd/skills/sdd-generate.md) — How agents generate specs from existing code

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and workflows.

## License

MIT — see [LICENSE](LICENSE) for details.
