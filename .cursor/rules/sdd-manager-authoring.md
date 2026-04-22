---
description: "Authoring extension to sdd-manager — revise authored specs and propose spec changes for CI-driven implementation. Installed only in OpenSDD-authored projects (full mode). Use when the user asks to revise a spec, propose a spec change, or prefixes a message with 'Propose:'."
alwaysApply: false
---

# SDD Manager — Authoring Extension

> Extension to the sdd-manager skill for projects that author their own OpenSDD specs. Adds the Revise and Propose workflows alongside the consumer-core workflows (Implement, Update, Check Conformance, Create Deviation).

## Relationship to sdd-manager

This extension assumes the sdd-manager consumer core is loaded. The universal implementation defaults, project conventions check, verification protocol, spec-as-source-of-truth rules, and workflow identification format defined there apply to the workflows below unchanged.

This file is installed alongside sdd-manager in OpenSDD-authored projects (those with a `specsDir` in `opensdd.json`). It MUST NOT be installed in consumer-only projects — consumer-only projects have no authored spec to revise or propose.

## Workflow Identification (authoring workflows)

The workflow identification format defined in sdd-manager applies. The announcement tag remains `[sdd-manager: ...]` (not `[sdd-manager-authoring: ...]`) because these tags are referenced by CI configs. Examples:

> **[sdd-manager: Revise]** opensdd/cli.md
> I'll draft a changeset for your review before modifying the spec.

> **[sdd-manager: Propose]** opensdd/cli.md
> I'll create a spec-only PR for CI-driven implementation.

Routing rules:

- **Revise**: User says "revise the spec", "update the spec", "change the behavior", or describes a behavioral change to an authored spec without asking for PR/CI routing.
- **Propose**: User says "propose", "Propose:", "submit spec", "create spec PR", "send spec for implementation", or has staged/modified `.sdd.md` files and asks to "push" or "submit" them. A message prefixed with "Propose:" MUST be routed to the Propose workflow.

## Workflows

### Revise

For incremental changes to the project's authored spec. The agent drafts a changeset for the user to review before modifying the spec or implementation.

1. **Understand the request.** Read the user's description of the desired behavior change. Read the current spec from `<specsDir>/` (`spec.md` and any supplementary files).

2. **Draft changeset.** Write a changeset to `<specsDir>/.changes/changeset.md` containing:
   - **Rationale:** Why this change is being made — the user's request, the problem it solves, and any design decisions.
   - **Changed Files:** For each spec file being modified, a unified diff showing the proposed changes. For new sections being added, show the full proposed content as an addition.

   The changeset MUST be persisted to disk (not kept in conversation context) so it survives context window clears. The agent MUST NOT modify spec files or implementation code during this step.

3. **Review.** Present the changeset to the user. Summarize what's changing and why. The user may:
   - **Approve** — proceed to step 4.
   - **Request modifications** — the agent updates the changeset and re-presents. The agent MUST re-read the changeset from disk before modifying it.
   - **Reject** — delete `<specsDir>/.changes/` and stop.

   The agent MUST NOT proceed past this step without explicit user approval.

4. **Apply to spec.** Apply the approved diffs to the spec files. Delete `<specsDir>/.changes/` after successful application.

5. **Implement.** Update the implementation to match the revised spec. Use the changeset to identify which behavioral sections changed — only modify code affected by the changes. The agent MUST re-read the updated spec sections directly (not work from the changeset diffs) when implementing.

6. **Verify.** Execute the verification protocol (defined in sdd-manager) scoped to the changed sections: regenerate affected tests, run until all pass, dispatch subagent for spec compliance audit scoped to the changed sections, fix any findings, re-run tests.

7. **Report.** Summarize what changed in the spec and implementation. If the project has `publish` configured in `opensdd.json`, remind the user to bump the version before publishing.

### Propose

The async, PR-driven counterpart to Revise. The agent drafts spec changes the same way as Revise, but instead of asking the user for approval in the CLI and implementing locally, it opens a PR — the PR review is the approval gate, and implementation happens in CI after merge.

The agent MUST execute all steps end-to-end without pausing for user confirmation. The Propose workflow is a single uninterrupted flow from understanding the request through PR creation — the agent MUST NOT stop to ask the user whether to proceed at any intermediate step. The PR itself is the review mechanism.

1. **Understand the request.** Read the user's description of the desired behavior change. Read the current spec from `<specsDir>/` (`spec.md` and any supplementary files). This is the same as Revise step 1.

2. **Draft changeset.** Write a changeset to `<specsDir>/.changes/changeset.md` containing:
   - **Rationale:** Why this change is being made — the user's request, the problem it solves, and any design decisions.
   - **Changed Files:** For each spec file being modified, a unified diff showing the proposed changes. For new sections being added, show the full proposed content as an addition.

   The changeset MUST be persisted to disk (not kept in conversation context) so it survives context window clears. The agent MUST NOT modify spec files or implementation code during this step. This is the same as Revise step 2.

3. **Apply to spec.** Apply the diffs from the changeset to the spec files. Delete `<specsDir>/.changes/` after successful application. Unlike Revise, there is no CLI approval gate — the PR serves as the review mechanism.

4. **Resolve scope.** Resolve the nearest `opensdd.json` from the current working directory. All subsequent steps operate relative to the directory containing this manifest (the **package root**). Determine the **package name** from: `opensdd.json` `name` field, falling back to `publish.name`, falling back to the package root directory name. Determine the **package path** as the relative path from the git repository root to the package root (empty string for repo-root projects).

5. **Create a feature branch.** Create a new branch from the current branch. The naming convention depends on whether the project is a monorepo (non-empty package path): monorepo projects use `opensdd/<package-name>/<spec-name>`, repo-root projects use `opensdd/<spec-name>`. The `<spec-name>` is derived from the primary spec filename or the changeset rationale. If a branch with that name already exists, prompt the user for a suffix or alternative name.

6. **Stage spec files only.** Stage only the spec files within `<specsDir>/` and any `.sdd.md` files within the package root, plus any related spec assets (e.g., supplementary files referenced by the spec). The agent MUST NOT stage implementation files, test files, or other non-spec changes. If the working tree has non-spec changes, leave them unstaged.

7. **Commit.** Commit the staged spec files with a conventional commit message:
   ```
   spec(<package-name>): <brief description of the spec change>
   ```
   For repo-root projects (empty package path), omit the scope: `spec: <brief description>`. The agent SHOULD derive the description from the spec content or filenames.

8. **Push.** Push the feature branch to the remote.

9. **Create PR.** Create a pull request targeting the base branch:
   - **Title:** `spec(<package-name>): <brief description>` (or `spec: <brief description>` for repo-root projects)
   - **Labels:** `spec`
   - **Body:** Include the changeset rationale, a summary of the spec changes, a note explaining that merging this PR will trigger auto-implementation via GitHub Actions, and an **OpenSDD metadata block** (see spec-format.md "PR Metadata Block" section) that encodes the package name and path for CI consumption.

10. **Clean up local state.** Switch the local working tree back to the branch that was active before the Propose workflow started (typically `main`). This ensures the developer's local state is clean and not left on the spec branch.

11. **Confirm.** Output the PR URL and explain to the user that:
    - Merging the PR will automatically create an implementation issue
    - `claude-code-action` will pick up the issue and open an implementation PR
    - No local implementation work is needed — the CI pipeline handles it
