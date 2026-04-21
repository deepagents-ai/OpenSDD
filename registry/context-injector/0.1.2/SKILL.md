---
name: context-injector
description: "Context injection for AI agent run loops that attaches stable, dynamic, and turn-counter addenda to outgoing messages without mutating tool result payloads."
---
# context-injector

> Context injection for AI agent run loops that attaches stable, dynamic, and turn-counter addenda to outgoing messages without mutating tool result payloads.

## Overview

This spec targets AI agent applications built on SDK-managed run loops (e.g., Vercel AI SDK, Pydantic AI, LangGraph, Google ADK, OpenAI Agents SDK, Claude Agent SDK) or manual loops. It defines a context injection layer that augments outgoing messages with three complementary categories of ambient context:

- **Stable context** — situational facts that change occasionally (e.g., the current app page a user is viewing while chatting with the agent). Injected into human-initiated user messages only when the exact string is not already present in the conversation history. Persists in history.
- **Dynamic context** — facts that change on every run (e.g., current time, session id). Unconditionally injected into human-initiated user messages at submission time. Persists in history.
- **Turn counter** — the current position within an agent run, rendered as `turn N/M`. Attached to every outbound LLM API call (including tool-result calls) without mutating tool result payloads. Only active when a run-level turn limit is configured.

**Primary audience:** This spec is written for an AI agent that will implement context injection on a user's project. The spec guides the implementing agent through project analysis, user consultation, and the injection machinery.

**Key design principles:**

- **Tool result payloads are immutable.** The textual content of a tool result is never modified. Turn-counter attachment on tool-result outbound calls uses sibling content blocks (for schemas that support multi-block user messages) or synthetic follow-up user messages (for schemas that do not) — never mutation of the tool result payload itself.
- **Persistence is SDK-natural.** All three injection categories persist in conversation history as a normal byproduct of the SDK's run loop. The library does not attempt to strip the turn counter from history after each call — the implementation complexity of ephemeral injection (non-destructive hook modes, post-call cleanup, SDK-specific restoration) is not worth it, and the residual turn-counter text in history is harmless.
- **SDK-agnostic design.** The spec defines core concepts (submission point, pre-request hook, message schema, run boundary) in abstract terms. The implementing agent MUST map each core concept to its concrete equivalent in the specific SDK being used. If the implementing agent cannot identify the concrete equivalent of any core concept, it MUST surface this to the user and ask for guidance rather than guessing or skipping the concept.

### Terminology

Throughout this spec:

- **Message** — the fundamental unit of conversation history in the SDK being used (e.g., `ModelMessage` in Pydantic AI, `CoreMessage` in Vercel AI SDK, `BaseMessage` in LangGraph, `Event` in Google ADK, `TResponseInputItem` in OpenAI Agents SDK). The implementing agent MUST interpret "message" as whatever the equivalent unit is in the target SDK.

- **User message** — a message submitted by the human end user that drives the agent forward. In most SDKs this maps to `role: "user"` containing one or more text content parts. A user message is semantically distinct from a tool result even when both are encoded with `role: "user"` in the Anthropic Messages API.

- **Tool result** — an in-loop observation returned from executing a tool call. Representations vary by SDK:
  - Anthropic Messages API — a `tool_result` content block nested inside a `role: "user"` message
  - OpenAI Chat Completions — a standalone `role: "tool"` message
  - LangChain / LangGraph — a `ToolMessage`
  - ReAct literature — "observation"

  The library MUST distinguish tool results from human-initiated user messages regardless of how the SDK encodes both as `role: "user"` or a similar role.

- **Run** — a single invocation of the agent loop, from an initial triggering user message through the assistant's final response, including all intermediate tool-call / tool-result iterations. In SDK terms this is one call to `agent.run()`, `generateText()`, `graph.invoke()`, or equivalent.

- **Turn** — one outbound LLM API request within a run. The first outbound call of a run is turn 1. Each subsequent outbound call (typically carrying a tool result) increments the turn number by 1.

- **Turn limit** — the maximum number of outbound LLM calls allowed in a single run (e.g., `maxSteps` in Vercel AI SDK, `recursion_limit` in LangGraph, `max_turns` in several OpenAI-family SDKs). MAY be absent; when absent, the turn counter is inactive.

## Behavioral Contract

### Project Analysis

Before writing any code, the implementing agent MUST analyze the user's project and determine all of the following:

#### SDK and Run Loop Detection

1. **Which AI agent SDK is used** — identify the SDK (e.g., Vercel AI SDK, Pydantic AI, LangGraph, Google ADK, OpenAI Agents SDK, Claude Agent SDK) and its version, or determine that the application runs a manual loop.

2. **Submission point** — identify where in the application a new human-initiated user message is handed to the run loop. Stable and dynamic addenda are attached at this point, before the message is persisted to history. In SDKs without an explicit submission hook, the application code itself is the injection point (immediately before passing the message to the run-loop entry function).

3. **Pre-request hook** — identify the SDK's mechanism for adding content to the outbound payload before every LLM API call. This is where the turn counter is attached. This is the same core concept as context-compactor's history processing hook; implementing agents using both libraries MAY reuse a single hook registration (see [Implementation Hints](#implementation-hints)). Either destructive-mode (persists) or non-destructive-mode (ephemeral) hooks are acceptable — the library does not require one or the other.

4. **Message schema** — determine how the SDK represents user messages and tool results:
   - Whether user messages accept an array of content parts (Anthropic-style, e.g., Anthropic Messages API, LangChain, Bedrock Converse) or a single content field (OpenAI-style, e.g., OpenAI Chat Completions with `role: "tool"` for tool output)
   - Whether tool results are encoded as `tool_result` content blocks inside a `role: "user"` message, as a dedicated `role: "tool"` message, or as a typed SDK object
   - How to construct a synthetic user message in the SDK's format (needed for turn-counter attachment when multi-block user messages are not supported)

5. **Turn limit source** — determine whether a run-level turn limit exists and how to read it:
   - Explicit SDK parameter (`maxSteps`, `recursion_limit`, `max_turns`)
   - Application-level configuration passed to the agent at startup
   - Manual loop terminator condition

   If no turn limit is present or configurable, the turn counter MUST be disabled (see [Turn Counter](#turn-counter)).

6. **Run-boundary detection** — determine how the library will know when a new run starts so it can reset the turn counter to 1. Acceptable mechanisms include hooking a run-start lifecycle event, wrapping the SDK's run entrypoint, or exposing an explicit reset call that the application invokes at run start. The implementing agent MUST choose the mechanism that aligns with how the application already invokes the run loop.

#### Information to Collect from the User

The implementing agent MUST use project analysis to present informed recommendations, not ask the user to choose from a blank list. Based on the SDK, application domain, and what the agent observes in the codebase, the implementing agent SHOULD propose which injection categories make sense and what content each should carry.

The implementing agent MUST collect or infer:

1. **Stable context entries** — for each stable context item, a provider (function or value) that supplies the current string, and any activation scope. Example: "the current app page the user is viewing, read from the application's router state."

2. **Dynamic context entries** — for each dynamic context item, a provider that is evaluated at each run to produce fresh text. Example: "the current wall-clock time formatted as ISO 8601."

3. **Turn limit** — confirm the turn limit value (from the SDK or application config) or confirm that there is no turn limit and the turn counter should be disabled.

4. **Placement** — confirm that stable and dynamic addenda are appended to the user message content (the RECOMMENDED placement — see [Injection Mechanics](#injection-mechanics)). The user MAY override this if their application has a different caching strategy or formatting requirement.

### Injection Categories

#### Stable Context

Stable context entries are attached to a human-initiated user message at submission time, conditional on absence from the conversation history.

**Behavior:**

1. At the moment a new human-initiated user message is being submitted to the run loop, evaluate each configured stable context provider in configuration order to obtain its current string.
2. For each produced string, scan the existing conversation history. If the string appears as an exact substring inside the content of any prior message carrying a user role (defined below), skip this entry. Otherwise, append the string to the outgoing user message's content, separated from preceding content by a clear delimiter.
3. The modified user message is then handed to the run loop and persists in history as part of normal SDK operation.

**History scan scope:** The implementing agent MAY scan either all messages whose primary role is user (including those containing `tool_result` content blocks in the Anthropic-style schema) or only human-initiated user messages. Both satisfy the behavior — the simpler implementation is preferred. In most SDKs this is "scan all messages whose primary role is user," since the stable string's presence or absence is the same regardless of what else is in the message.

**Use cases:**
- Current page or screen the user is on
- Feature flags or user settings active at the time of the question
- Session-level facts that change occasionally but not on every turn

Example:

```
Stable provider: "Current page: /settings/profile"

Turn 1 (not in history yet):
  outgoing user message content = <original text>\n\nCurrent page: /settings/profile

Turn 2 (same string now in history):
  skipped — no injection
```

#### Dynamic Context

Dynamic context entries are attached to every human-initiated user message at submission time, unconditionally.

**Behavior:**

1. At the moment a new human-initiated user message is being submitted to the run loop, evaluate each configured dynamic context provider in configuration order to obtain its current string.
2. Append each produced string to the outgoing user message's content, separated from preceding content by a clear delimiter.
3. The modified user message is handed to the run loop and persists in history as part of normal SDK operation.

Dynamic context is NOT re-evaluated on each outbound LLM call within a run. It is evaluated once per submitted user message. Per-call re-evaluation would invalidate prompt caching on every call.

**Use cases:**
- Current wall-clock time at the start of the run
- Freshly computed per-run metadata
- Session identifier, user identifier, or other per-run state

#### Turn Counter

The turn counter is active only when a turn limit M is configured. When active, it is attached ephemerally to every outbound LLM API request within a run.

**Format:** The injected string MUST be of the form `turn N/M` (or include that substring) where:
- N is the 1-indexed number of the current outbound LLM call within the current run — the first call is turn 1.
- M is the configured turn limit.

A surrounding wrapper such as `[turn N/M]` on its own line is RECOMMENDED for clarity. The exact surrounding text is not mandated.

**Run boundary:** N MUST reset to 1 at the start of each new run. N MUST NOT accumulate across runs in a multi-run conversation.

**Attachment:** For each outbound LLM API call, the library attaches the turn-counter string to the outbound payload as follows:

- **Multi-block user messages supported (Anthropic-style schemas):** Attach a text content block containing the turn counter to the latest user message in the outbound payload, as a sibling of any existing content blocks. The existing blocks in that message MUST remain byte-for-byte unchanged. When the latest user message contains a `tool_result` content block, the text block SHOULD be placed after the `tool_result` block in the content array (placing text before the `tool_result` can be rejected by some validators that require the `tool_result` to immediately follow its matching `tool_use`).

- **Single-string user messages, tool result is a distinct message type (OpenAI-style schemas):**
  - When the latest message in the outbound payload is a human-initiated user message (typically turn 1), append the turn-counter string to its content.
  - When the latest message is a tool result (`role: "tool"` or equivalent), insert a new `role: "user"` message containing only the turn-counter string, immediately after the tool-result message in the outbound payload.

These attachments MAY persist in conversation history as the SDK processes each outbound call — the library does not strip them. The only hard constraint is that the tool result payload's own content remains byte-for-byte unchanged; sibling blocks and follow-up messages around it are fine to persist. The library MUST NOT attach a duplicate turn counter to a message that already carries one (e.g., on retries or when the hook fires more than once per logical outbound call).

**Disabled state:** When no turn limit is configured, the turn counter MUST be completely disabled. The library MUST NOT attach a free-running counter (e.g., `turn N` without a denominator) — a counter without a ceiling is not what this feature is for.

### Injection Mechanics

**Appending vs. prepending:** Stable and dynamic addenda SHOULD be appended to the end of the user message content rather than prepended. Appending preserves the user's original prefix verbatim, which keeps more of the message cacheable by providers that support prompt caching.

**Ordering:** When multiple addenda attach to the same user message at submission time, the recommended order from earliest to latest in the resulting content is:

1. Original user message content
2. Stable context addenda (in configuration order, skipping absent-from-history entries)
3. Dynamic context addenda (in configuration order)

The turn counter, when attached to a user message, comes after stable and dynamic in the content.

Ordering within the stable and dynamic categories follows configuration order.

**Separation:** Individual addenda SHOULD be separated from preceding content and from each other by a clear delimiter (e.g., a blank line, or a labeled prefix such as `[context] ...`). The exact delimiter is not prescribed but MUST be consistent across injections so the model can distinguish addenda from the user's own text.

**Tool result immutability:** The library MUST NOT modify the content of a `tool_result` content block or a `role: "tool"` message under any circumstance. All tool-result–adjacent injection MUST use the sideband mechanisms described in [Turn Counter](#turn-counter).

### Configuration

Configuration values MUST live in a dedicated configuration surface — a single choke-point where the library's behavior can be retuned — rather than being hard-coded or scattered across the library's call sites. The implementing agent MUST choose an appropriate configuration mechanism for the project (e.g., constructor parameters, config file, SDK options, environment variables).

Required configuration parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `stableContext` | list of providers | Ordered list of stable context providers. Each provider is a function (sync or async, per SDK conventions) or a value that produces the current string. Providers returning empty strings are skipped. |
| `dynamicContext` | list of providers | Ordered list of dynamic context providers. Each provider is a function (sync or async) that produces the current string at submission time. Providers returning empty strings are skipped. |
| `turnLimit` | number or null | The run-level turn limit M. `null` (or absent) disables the turn counter entirely. When non-null, the library SHOULD verify the SDK's own run-loop limit agrees and warn the user of any mismatch. |
| `turnCounterFormat` | string, optional | Override for the rendered turn-counter string. Default: `[turn N/M]`. MUST contain `N` and `M` placeholders (or equivalents) where the current values are substituted. |
| `delimiter` | string, optional | The separator between original content and addenda, and between successive addenda. Default: a blank line. |

## Edge Cases

- **Stable string partially present in history:** Substring matching is all-or-nothing against the full stable string. If the stable string is `"Current page: /settings/profile"` and the history contains `"Current page: /settings"` (a prefix) but not the full string, the stable string is considered absent and MUST be injected.

- **Stable provider returns empty string:** The entry MUST be skipped — no existence check, no injection.

- **Dynamic provider returns empty string:** The entry MUST be skipped for this submission.

- **Provider raises an error:** The implementing agent SHOULD catch the error, log a warning, and skip that provider. One failing provider MUST NOT block other providers or fail the run.

- **Outbound call carries no newly-submitted user message (turns >= 2 within a run):** Stable and dynamic injections are only relevant when a new human-initiated user message is being submitted. Subsequent outbound calls within the same run (which carry tool results back to the model) MUST NOT re-inject stable or dynamic addenda. Only the turn counter applies to these outbound calls.

- **Multi-run conversation, stable value changes between runs:** If a stable provider returned string A in run 1 and returns a different string B in run 2, the run 2 submission MUST inject B (since B is a distinct string from A, and B is absent from history). String A remains in run 1's user message in history — this is intentional and reflects what was true at the time of the earlier turn.

- **Multi-run conversation, turn counter:** N resets to 1 at the start of each new run. The turn counter is never persisted, so there is no leakage from run 1 into run 2.

- **Turn counter on turn 1:** The first outbound call of a run typically carries the triggering human user message as the latest message. The turn counter is attached to that outbound payload as specified in [Turn Counter](#turn-counter). It is acceptable for the attached turn counter to persist in history alongside the user message.

- **Turn counter when N equals or exceeds M:** The library MUST render the counter truthfully (e.g., `turn 25/25` or `turn 26/25` if the SDK oversteps). The library does not enforce the limit — termination is the SDK's responsibility.

- **No turn limit configured:** The turn counter is disabled entirely. No sideband or appended turn-counter text MUST appear in any outbound payload.

- **Hook fires multiple times for the same logical outbound call:** If the pre-request hook fires more than once for the same logical outbound call (e.g., due to a retry, a provider fallback, or an SDK quirk), the library MUST detect that the latest message already carries a turn counter attachment from this library and skip re-attachment. Duplicate `turn N/M` entries on the same message MUST NOT occur.

- **Application deserializes tool result content:** Since tool result content is never mutated, application-side deserialization of tool result payloads (e.g., `json.loads` on the tool result body) continues to work regardless of whether the turn counter was attached.

- **Streaming responses:** Injection happens at outbound-request construction time, before streaming begins. The library does not interact with streamed response chunks.

- **Concurrent runs sharing a history store:** If the application runs multiple concurrent agent runs over a shared history, the turn-counter state MUST be scoped per run, not global. Stable and dynamic injections apply per submission and are naturally per-run.

- **A stable addendum is later removed from history by a compactor:** If context-compactor (or another compactor) removes or summarizes a message that carried a stable addendum, the stable string is no longer present in history. The next submission MUST treat the string as absent and re-inject it. This is correct behavior and requires no special handling.

- **User message with empty original content (metadata-only submission):** Stable and dynamic addenda are still appended; the resulting content is valid. The library MUST NOT inject a delimiter before empty original content (no leading blank line).

## NOT Specified (Implementation Freedom)

- The exact delimiter between original user content and addenda, and between successive addenda (blank line, labeled prefix, XML-like tag, etc.) — as long as it is consistent
- The exact rendered format of the turn counter beyond including `N/M` (a wrapper such as `[turn N/M]` is recommended but not mandated)
- Whether providers are synchronous functions, async functions, or constants
- How the library stores per-run turn-counter state (closure, SDK context object, external map keyed by run id, etc.)
- The data structure used for the configured provider list
- How configuration is loaded (environment variables, config file, constructor parameters, etc.)
- The specific substring-matching algorithm for stable-context presence checks — only the semantic behavior is specified
- Whether the library emits logs or events when injection occurs
- Whether the library exposes a mechanism for the application to read back the current turn counter value (not required, but permitted)
- How the library composes with other pre-request hooks (ordering with compactors, rate limiters, etc.) — see [Implementation Hints](#implementation-hints) for a recommendation

## Invariants

- Tool result payload content (the text/body of a `tool_result` content block or a `role: "tool"` message) MUST NEVER be modified by the library.
- When the turn counter is inactive (no turn limit configured), no turn-counter string MUST appear in any outbound payload or in persisted history.
- Stable context strings MUST NOT be injected into a submitted user message when the exact string is already present as a substring in the content of any prior user-role message in the conversation history.
- Dynamic context strings MUST be evaluated and injected on every newly submitted human-initiated user message.
- The turn counter N MUST equal 1 on the first outbound LLM call of each run.
- The turn counter MUST increment by exactly 1 with each subsequent outbound LLM call within the same run.
- The turn counter state MUST reset between runs — no accumulation across runs in a multi-run conversation.
- Stable and dynamic addenda MUST be attached only to human-initiated user messages at submission time, never to tool results or to user messages that exist solely to carry tool results.
- A given message MUST carry at most one turn-counter attachment at any time — no duplication, even across hook retries.
- No injection MUST alter the original user text — addenda are strictly appended after the original content, and the original content MUST remain a prefix of the modified content.
- When stable and dynamic are both configured, stable addenda MUST appear before dynamic addenda in the modified user message content.

## Implementation Hints

- **Compose cleanly with context-compactor.** Both libraries hook the same pre-LLM-call point. When both are in use, they MAY share a single hook registration. The recommended composition order is: compactor runs first (may remove or summarize messages), then context-injector's pre-request phase runs (attaches turn counter to the final outbound payload). This ordering ensures the turn counter is attached to whatever the compactor decided to send, and the compactor's size thresholds do not need to account for the small, fixed-size turn-counter text.

- **Submission-time vs. pre-request timing.** Stable and dynamic injections happen at submission time — they modify the user message content as it enters the run loop. The turn counter uses a pre-request hook at each outbound call. Keep these two flows separate in the implementation. All three injection categories persist in history as a side effect of normal SDK operation; no ephemeral-mode or restore-after-call mechanism is required.

- **Prefer sibling blocks over content mutation.** In SDKs whose user messages accept multi-block content (Anthropic-style), attaching a sibling text block for the turn counter is cleaner than appending to existing text content. It keeps the structural placement of the `tool_result` block stable and makes retry-detection simpler (the library can check for a block it previously added).

- **Duplicate-attachment detection.** Tag the turn-counter block (e.g., with a stable prefix such as `[turn ` inside a dedicated block) so the library can recognize its own prior attachment when the hook fires more than once per logical outbound call. This prevents runaway duplication under retries.

- **Run boundary detection.** The cleanest implementation is to wrap the SDK's run entrypoint (`agent.run`, `generateText`, `graph.invoke`, etc.) in a thin helper that increments an internal run id and resets the turn counter. Inferring boundaries from message timing or history diffs is fragile.

- **Error isolation.** A provider that raises MUST NOT fail the run. Catch, log, and skip. This is especially important for providers that touch external systems (database reads, HTTP calls).

- **Provider purity and cost.** Providers are called on every submission (for stable and dynamic) or every call (for the turn counter, which is internal). They SHOULD be fast and side-effect-free. If a provider needs expensive work, the implementing agent SHOULD recommend memoizing per run.

- **Substring match cost.** For very long histories with many stable providers, the naive "scan every user message content for each stable string" check is O(history × providers × string length). In practice this is negligible — histories are bounded, providers are few. If profiling shows it matters, memoize which stable strings are already known to be present in the current session and short-circuit.

- **Cache-friendly placement.** For providers that support prompt caching, the cache key is typically the message prefix up to some marker. Appending addenda to the user message content preserves the prefix cacheability for prior turns. The current turn's appended addenda are by nature uncacheable on their first appearance, but they become part of the cacheable prefix for subsequent turns.

- **Interaction with summary-based compaction.** If summary-based compaction rewrites older messages into a summary, the stable strings that were in those older messages disappear from history. This is fine — the next submission will observe them as absent and re-inject. No coordination between the libraries is needed beyond the ordering noted above.

- **Verify the SDK's turn-limit signaling matches yours.** When a turn limit comes from both configuration and the SDK (e.g., the library is configured with `turnLimit: 25` and the SDK is started with `maxSteps: 20`), the effective limit is the SDK's, not the library's. The library SHOULD warn the user when the configured value does not match what the SDK will actually enforce.
