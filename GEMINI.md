<!-- OpenSDD Skills (managed by opensdd init — do not edit this section) -->
This project uses OpenSDD spec-driven development. Before implementing, modifying, or verifying any code governed by an OpenSDD spec, you MUST load and follow the sdd-manager skill/instructions first. Check `opensdd.json` and `.opensdd.deps/` to identify spec-governed code.

@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md
@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md
<!-- /OpenSDD Skills -->

<!-- OpenSDD Skills (managed by opensdd — do not edit this section) -->
This project consumes OpenSDD dependency specs. Before modifying code under `.opensdd.deps/` or any code that implements a dep's spec, you MUST load and follow the sdd-manager skill. Any change to spec-governed functionality MUST either preserve conformance (verify via the Check Conformance workflow) or be recorded via the Create Deviation workflow. Check `opensdd.json` and `.opensdd.deps/` to identify spec-governed code.

This project also authors its own OpenSDD spec under the directory named by `specsDir` in `opensdd.json`. Behavior changes to the authored spec MUST go through the Revise or Propose workflow defined in the sdd-manager-authoring skill. Implementation of the authored spec is governed by the same rules as dependency implementation — verify conformance or catalog deviations.

@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md
@.claude/skills/sdd-manager-authoring/SKILL.md
@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md
<!-- /OpenSDD Skills -->

<!-- OpenSDD Skills (managed by opensdd — do not edit this section) -->
This project uses OpenSDD spec-driven development. Before implementing, modifying, or verifying any code governed by an OpenSDD spec, you MUST load and follow the sdd-manager skill/instructions first. Check `opensdd.json` and `.opensdd.deps/` to identify spec-governed code.

@.claude/skills/sdd-manager/SKILL.md
@.claude/skills/sdd-manager/references/spec-format.md
@.claude/skills/sdd-generate/SKILL.md
@.claude/skills/sdd-generate/references/spec-format.md
<!-- /OpenSDD Skills -->
