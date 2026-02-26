# Contributing to OpenSDD

Thanks for your interest in contributing to OpenSDD. This project uses spec-driven development and governs its own development with opensdd specs — we eat our own dog food. Read this guide before submitting changes.

## Development Setup

**Prerequisites:** Node.js >= 18

```bash
git clone <repo-url> && cd agent-specs
npm install
```

The only runtime dependency is `diff`. There is no build step — the project uses ES modules with `.js` extensions throughout.

Run the CLI locally:

```bash
node bin/opensdd.js [command]
```

Run the test suite (Node.js native test runner):

```bash
npm test
```

## Spec-Driven Workflow

OpenSDD specs govern OpenSDD's own development. The specs live in the `opensdd/` directory:

| File | Purpose |
|------|---------|
| `opensdd/cli.md` | CLI behavioral contract |
| `opensdd/sdd-manager.md` | sdd-manager skill spec |
| `opensdd/sdd-generate.md` | sdd-generate skill spec |
| `opensdd/spec-format.md` | Spec format spec |

Run `opensdd init` to bootstrap the agent skills if you have not already done so.

### Code Changes

When changing implementation without altering behavior:

1. **Read the spec.** Find the relevant spec file in `opensdd/` and read the sections that cover the behavior you are working on.
2. **Implement.** Use the sdd-manager agent skill to implement changes against the spec.
3. **Verify.** Confirm the implementation satisfies the spec before submitting a PR.

### Behavior Changes

When the desired behavior differs from what the spec currently describes:

1. **Update the spec first.** Modify the relevant spec file in `opensdd/` to reflect the new intended behavior.
2. **Implement.** Update the code to match the revised spec.
3. **Verify.** Confirm both the spec and implementation are consistent, then submit both in the same PR.

Always read the relevant spec before writing code. The spec is the source of truth for how opensdd should behave.

## Submitting Changes

1. Branch from `main`.
2. Write descriptive commit messages.
3. Reference the relevant spec sections in your PR description (e.g., "Implements `opensdd/cli.md` section 3.2").
4. Ensure `npm test` passes.
5. If your implementation intentionally diverges from a spec, document the deviation in the corresponding `deviations.md` file under `.opensdd.deps/<name>/`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License. Copyright 2026 DeepAgents.
