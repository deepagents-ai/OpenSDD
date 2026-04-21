---
name: context-compactor
description: "Context window management for AI agent harnesses that use SDK-managed run loops, providing configurable compaction strategies to prevent context overflow during agentic tool-calling sessions."
---
# context-compactor

> Context window management for AI agent harnesses that use SDK-managed run loops, providing configurable compaction strategies to prevent context overflow during agentic tool-calling sessions.

## Overview

This spec targets AI agent applications built on SDK-managed run loops (e.g., Vercel AI SDK, Pydantic AI, LangGraph, Google ADK, OpenAI Agents SDK). In these architectures, the SDK manages the tool-calling loop internally: the model produces tool calls, the host executes them, the results are appended to the message history, and the next request is sent automatically. The host application does not manually control each iteration.

Context compaction prevents the message history from exceeding the model's context window during these loops. Without it, a long-running agent session or a single large tool result can cause API request failures, silent truncation by the provider, or degraded model performance as the context fills.

**Primary audience:** This spec is written for an AI agent that will implement context compaction on a user's project. The spec guides the implementing agent through project analysis, user consultation, configuration, and implementation of all necessary components.

**Key design principle:** The spec provides a _toolbox_ of compaction strategies rather than prescribing a single approach. Implementations will typically combine multiple strategies — for example, tool result clearing as a first pass, summary-based compaction for major reductions, and raw truncation as a last-resort safety net.

**SDK-agnostic design:** This spec defines core concepts (history processing hook, processing mode, message, trigger point) in abstract terms. The implementing agent MUST map each core concept to its concrete equivalent in the specific SDK being used. If the implementing agent cannot identify the concrete equivalent of any core concept, it MUST surface this to the user and ask for guidance rather than guessing or skipping the concept.

The core concepts the implementing agent must resolve for any SDK:

| Core Concept | What to look for |
|---|---|
| **History processing hook** | A callback, middleware, or interceptor that runs before each LLM API call and can modify or replace the message history that will be sent. May be registered on the agent constructor, on per-call options, as a parameter on a prebuilt agent factory, or as model middleware. |
| **Processing mode** | Whether the hook's output is persisted (destructive) or ephemeral (non-destructive). See [History Processing Modes](#history-processing-modes). |
| **Message** | The SDK's fundamental unit of conversation history (whatever type represents a single message with role, content, and metadata). |
| **Hook fires before 1st call?** | Whether the hook runs before the first API call in an agent run, not only on subsequent turns. The implementing agent MUST verify this. |
| **Hook registration point** | Where in the application code the hook is registered (agent constructor, per-call options, runner configuration, etc.). |

SDK APIs change frequently — the implementing agent MUST consult the SDK's current documentation and source code to identify the correct hook, rather than relying on hardcoded function names. The essential requirement is a hook that runs before each LLM API call and can modify or replace the message history. If the SDK does not offer a direct hook, alternatives include model middleware (wrapping the model to intercept and modify parameters before each call), wrapping tool execution, or switching to a manual loop.

For each compaction strategy and trigger point defined in this spec, the SDK being used may offer a built-in equivalent. The implementing agent SHOULD evaluate whether any built-in equivalent is sufficient for the user's needs. Built-in solutions are often simpler to integrate but may not cover all the scenarios this spec addresses (e.g., they may lack tool result clearing, truncation markers, or cascading fallback between strategies). It is up to the implementer and user to decide whether to use a built-in equivalent, this spec's approach, or a combination for any given strategy or trigger point.

### Terminology

Throughout this spec, the term **message** refers to the fundamental unit of conversation history in the SDK being used. Different SDKs use different names for this concept (e.g., `ModelMessage` in Pydantic AI, `CoreMessage` in Vercel AI SDK, `BaseMessage` in LangGraph, `Event` in Google ADK, `TResponseInputItem` in OpenAI Agents SDK). Wherever this spec says "message," the implementing agent MUST interpret it as whatever the equivalent unit is in the target SDK. The compaction logic — counting tokens, deciding to compact, applying strategies — is the same regardless of the underlying type.

## Behavioral Contract

### Project Analysis

Before writing any code, the implementing agent MUST analyze the user's project to understand the agentic architecture. The agent MUST determine all of the following:

#### SDK and Run Loop Detection

1. **Which AI agent SDK is used** — identify the SDK (e.g., Vercel AI SDK, Pydantic AI, LangGraph, Google ADK, OpenAI Agents SDK, or a custom loop) and its version.

2. **How the run loop is structured** — identify whether the SDK manages the loop (e.g., `generateText` with `maxSteps`/`stopWhen` in Vercel AI SDK, `agent.run()` in Pydantic AI, graph traversal in LangGraph) or whether the application runs a manual loop (e.g., calling the model in a `while` loop with single-step execution).

3. **What is the concrete history processing hook** — identify the SDK's mechanism for intercepting and modifying message history before each API call. This is a core concept that MUST be resolved. The implementing agent MUST identify the specific function, callback, node, or middleware that:
   - Runs before each LLM API call (including the first call in an agent run)
   - Receives the current message history
   - Can return or apply a modified message history

   Refer to the SDK mapping table in the Overview for known equivalents. The hook may be registered at different levels depending on the SDK — on the agent constructor, on the run/call configuration, or as a parameter on a prebuilt agent factory. The implementing agent MUST understand how the specific SDK exposes this hook and where in the application code it should be registered.

   If the application uses a manual loop (no SDK-managed run loop), the hook is simply the point in the loop before each model call where the message array can be modified directly.

   If the implementing agent cannot identify a suitable hook in the SDK being used, it MUST inform the user and discuss alternatives (e.g., wrapping the model call, using middleware, or switching to a manual loop).

4. **What is the processing mode** — determine whether the hook operates in destructive, non-destructive, or dual mode. This is a core concept that MUST be resolved:
   - **Destructive**: the SDK persists the hook's output — subsequent calls receive the already-modified history (e.g., Pydantic AI)
   - **Non-destructive**: the SDK preserves the original history — the hook's output only affects the current call, and subsequent calls receive the unmodified history again (e.g., Vercel AI SDK, OpenAI Agents SDK)
   - **Dual**: the SDK supports both modes, selected by the hook's return value (e.g., LangGraph, where returning `llm_input_messages` is non-destructive and returning `messages` is destructive)

   See [History Processing Modes](#history-processing-modes) for implementation guidance for each mode.

   If the implementing agent cannot determine the mode, it SHOULD default to treating the hook as non-destructive (the safer assumption, since it requires idempotent processing) and verify by testing.

5. **What token counting mechanism is available** — identify how the implementation will count tokens:
   - Provider-specific token counting APIs (e.g., Anthropic's token counting endpoint, Gemini's `count_tokens`)
   - Client-side tokenizer libraries (e.g., `tiktoken` for OpenAI models, `@anthropic-ai/tokenizer`)
   - Heuristic estimation (e.g., character count / 4)
   - Post-hoc usage data from previous API responses (e.g., `usage.totalTokens` returned by the SDK)

6. **What models are used and their context window sizes** — identify all models the application may use during agent runs, and their maximum context window token limits.

7. **What tools the agent has access to** — catalog all tools registered with the agent, as their outputs are the primary source of context growth.

8. **Whether the SDK has built-in compaction** — check if the SDK provides its own context management features. As noted in the Overview, built-in equivalents may exist for individual strategies and trigger points defined in this spec. The implementing agent SHOULD catalog what the SDK provides, evaluate whether each built-in feature is sufficient for the user's needs, and inform the user of any gaps so they can decide whether to use built-in features, this spec's approach, or a combination for each concern.

#### Information to Collect from the User

The implementing agent MUST use the results of the project analysis to present informed recommendations to the user, not simply ask the user to choose from a list of options. Based on the SDK, tools, models, and architecture identified during analysis, the agent SHOULD recommend specific strategies, trigger points, and configuration values — explaining _why_ each recommendation fits the project. The user then confirms, adjusts, or deviates from the recommendations.

For example, rather than asking "Which compaction strategies do you want?", the agent should say something like: "Based on your Vercel AI SDK project with 12 tools that return large payloads, I recommend enabling tool result clearing (lossy) as the primary optional strategy. Summary-based compaction is likely unnecessary given your tool-heavy, short-conversation pattern. Raw truncation will always run as the final safety net regardless. Does this look right, or would you like to adjust?"

The implementing agent MUST collect the following from the user (values MUST be configurable, not hardcoded):

1. **Context window threshold** — the percentage of the model's context window at which compaction should trigger. Common defaults: 75-80% of the context window.

2. **Max output token reservation** — the number of tokens to reserve for the model's response. This is subtracted from the threshold to determine the effective input token limit. If the user does not specify, the implementing agent SHOULD use the model's default `max_tokens` or a sensible default (e.g., 4096 tokens).

3. **Preferred compaction strategies** — which optional strategy tiers (tool result clearing, summary-based compaction) the user wants enabled. Execution order is determined by the tier hierarchy, not by user selection. Raw truncation is always the final tier and is not part of this selection. The implementing agent MUST present its recommended strategy combination (based on project analysis) and explain the tiered cascade model (see [Compaction Strategies](#compaction-strategies)) and each tier's tradeoffs.

4. **Summary model preference** — if summary-based compaction is enabled, which model should be used for generating summaries. This MAY be a cheaper/smaller model than the agent's primary model.

5. **Tool result storage preference** — if pointer-based tool result clearing is enabled, where cleared results should be stored (in-memory map, on-disk files, or another mechanism available in the project).

6. **Tool result size limit** — the cap on the size of a single tool result before it is raw-truncated and appended to the history. Expressed as two parameters whose smaller effective value applies: a ratio of the context window (`toolResultSizeLimit`, default `0.2`) and an absolute token ceiling (`toolResultMaxTokens`, default `20000`). Default combined cap: `min(contextWindowSize × 0.2, 20000)` tokens.

### Trigger Points

The implementing agent MUST identify and instrument all points in the application where context overflow can occur. There are three categories of trigger points, each requiring a check.

#### Pre-Request Check

A check MUST be performed before every outgoing LLM API request. This is the primary compaction trigger. The check determines whether the current message history, plus the reserved output tokens, exceeds the configured threshold.

**In SDK-managed loops**, this check MUST be placed inside the SDK's history processing hook (as identified during [Project Analysis](#project-analysis)). The implementing agent MUST use whichever concrete hook was identified for the SDK in use — the check logic is the same regardless of the hook's API shape.

**The check MUST run before the first request of an agent run**, not only on subsequent turns. The implementing agent MUST verify that the SDK's hook fires before the first API call. All major SDKs (Pydantic AI, Vercel AI SDK, LangGraph, Google ADK, OpenAI Agents SDK) fire their hooks before the first request, so a single hook placement covers all requests. If using an SDK where the hook does NOT fire before the first request, the implementing agent MUST add a separate check before initiating the agent run.

The pre-request check formula:

```
effective_limit = (context_window_size * compaction_threshold) - max_output_tokens
current_tokens = count_tokens(message_history)
if current_tokens > effective_limit:
    trigger compaction
```

#### Post-Tool-Result Check

A sanity check MUST be performed on each individual tool result before it is appended to the message history. This check prevents a single oversized tool result from entering the history and causing a persistent overflow that is difficult for the pre-request check to recover from.

The check compares the token count of the tool result against an effective limit computed as the smaller of `contextWindowSize × toolResultSizeLimit` and `toolResultMaxTokens`. If the tool result exceeds this effective limit, it MUST be raw-truncated to fit within the limit before being appended to the history. A truncation marker MUST be appended to indicate content was lost (see [Raw Truncation](#raw-truncation) for marker requirements).

```
max_result_tokens = min(context_window_size * tool_result_size_limit, tool_result_max_tokens)
result_tokens = count_tokens(tool_result)
if result_tokens > max_result_tokens:
    truncate tool_result to max_result_tokens
```

This check operates on individual tool results only — it does not consider the cumulative size of the message history (that is the pre-request check's responsibility). When the SDK executes multiple tools in parallel, the check MUST be applied to each result independently.

The implementing agent MUST identify a robust place to perform this check within the SDK's architecture. In some SDKs, this may be a tool result callback, a post-tool-execution hook, or a wrapper around tool execution. If the SDK does not expose an obvious hook point between tool result creation and its appending to the message history, the implementing agent MUST surface this to the user during the pre-implementation clarification phase and discuss alternatives (e.g., wrapping tool execution, intercepting results before they are appended, or using middleware).

#### Pre-Run Check

When the application maintains message history across multiple agent runs (e.g., a multi-turn conversation where each user message triggers a new `agent.run()` or `generateText()` call), the accumulated history from previous runs plus the new user message could already exceed the threshold before the run loop begins.

If the SDK's history processing hook fires before the first request of each run (as all major SDKs do — see the SDK mapping table in the Overview), the pre-request check already covers this scenario and no separate pre-run check is needed. If the implementing agent determines that the SDK's hook does NOT fire before the first request, a separate pre-run check MUST be added before initiating the agent run.

### History Processing Modes

The implementing agent MUST determine which processing mode to use based on the SDK's behavior (as identified during [Project Analysis](#project-analysis)). The processing mode dictates how the compaction processor must be structured. There are two modes, and some SDKs support both.

The implementing agent MUST follow the conventions and API patterns of the specific SDK being used — the mode determines the logical structure of the processor, but the concrete implementation (functional return, in-place mutation, state update dictionary, etc.) MUST match how the SDK expects the hook to work.

#### Non-Destructive Mode (Idempotent Processing)

In non-destructive mode, the SDK preserves the original message history and passes the unmodified history to the processor on every turn. The processor MUST be idempotent: calling it multiple times on the same unprocessed history MUST produce the same result.

This mode applies when the SDK does NOT persist processor output across steps. Some SDKs support non-destructive mode as an explicit option (e.g., by returning a different key from the hook to signal ephemeral vs. persistent modifications).

In this mode, the processor:
1. Receives the full, unmodified message history on every call
2. Determines if compaction is needed based on token count
3. If needed, applies compaction and returns the modified history
4. If not needed, returns the history unchanged (or returns nothing / `undefined` to signal no modification)

The implementing agent SHOULD maintain external state (e.g., a compacted prefix, a summary cache) to avoid re-computing summaries on every step. The processor can then re-apply the cached compaction result efficiently:

```
if cached_compaction exists:
    new_messages = messages_since_last_compaction(full_history)
    return cached_compaction + new_messages
else if compaction_needed(full_history):
    compacted = apply_compaction(full_history)
    cache compacted prefix
    return compacted
else:
    return full_history unchanged
```

#### Destructive Mode (Stateful Processing)

In destructive mode, the SDK replaces the message history with the processor's output. The processor's modifications persist — subsequent calls receive the already-modified history.

This mode applies when the SDK persists processor output — subsequent calls receive the already-modified history. Some SDKs support destructive mode as an explicit option (e.g., by returning a different key from the hook to signal persistent modifications).

In this mode, the processor:
1. Receives the current (possibly already compacted) message history
2. Determines if compaction is needed based on token count
3. If needed, applies compaction in-place and returns the modified history
4. If not needed, returns the history unchanged

Since modifications persist, the processor does not need external caching. However, it MUST account for the possibility that history has already been partially compacted by a previous invocation.

#### Dual-Mode SDKs

Some SDKs support both modes, selected by the hook's return value or configuration. When the SDK supports both modes, the implementing agent SHOULD recommend non-destructive mode by default, as it preserves the full history for debugging and replay. Destructive mode is preferable when state storage size is a concern (e.g., very long-running agents where checkpoint or session storage grows large).

### Compaction Strategies

The implementation MUST provide compaction strategies organized into a tiered cascade. Each tier is more efficient (cheaper, faster) but less robust (may not be sufficient on its own) than the tier below it. The tiers form layers of optionality — raw truncation alone works but poorly; adding summary compaction improves quality; adding tool clearing on top maximizes efficiency.

```
Tier 3 (top, most efficient):  Tool Result Clearing
Tier 2 (middle, always effective): Summary-Based Compaction
Tier 1 (base, required fail-safe):  Raw Truncation
```

When the pre-request check triggers compaction, strategies MUST execute in descending tier order: tier 3 first (if enabled), then tier 2 (if enabled), then tier 1 (always). After each tier executes, the implementation MUST re-check the token count. If the count is already below the threshold, remaining tiers are skipped. This means a well-configured system rarely reaches raw truncation — tool clearing handles most cases, summary handles the rest, and raw truncation is the safety net.

Tool result clearing (tier 3) and summary-based compaction (tier 2) are optional strategies that the user configures — they specify which are active. Raw truncation (tier 1) is not user-configured; it always runs as the final step of the pre-request check to guarantee the request fits (see [Raw Truncation](#raw-truncation)).

#### Raw Truncation

Truncate content within a single message to reduce token count. Raw truncation serves two roles: it is the final step of the pre-request check (guaranteeing that no API request ever exceeds the context window), and it is the mechanism used by the post-tool-result check to enforce the `toolResultSizeLimit`.

**Behavior:**
- Identifies the largest message (by token count) in the history
- Truncates that message's content to fit within the remaining token budget
- Appends a truncation marker to the truncated content (e.g., `\n\n[Content truncated — original was {N} tokens, kept first {M} tokens]`)
- The truncation marker MUST indicate that content was lost so the model is aware

**When to use:**
- As the final step before every API request: after all user-configured compaction strategies have been applied, raw truncation MUST run as the last step to guarantee the request fits within the context window. If prior strategies already brought the token count below the threshold, raw truncation is a no-op.
- In the post-tool-result check: when a single tool result exceeds the configured `toolResultSizeLimit`, it is raw-truncated before being appended to the history.

**Constraints:**
- MUST NOT truncate system messages or the system prompt
- MUST NOT truncate the most recent user message (the one being responded to)
- SHOULD prefer truncating tool results over assistant messages, as tool results are typically the largest and most recoverable content
- MUST preserve message structure (role, tool call IDs, metadata) even when content is truncated
- When a message contains multiple content parts (e.g., multiple tool result parts), truncation MUST be applied to the largest individual part, not to a concatenation of all parts. Each part's content is independent and MUST NOT be mixed with other parts during truncation.

**Warning threshold:** If raw truncation removes more than 25% of the selected message's content (by token count), the implementation MUST log a warning. This signals that the higher-tier strategies (if configured) are not doing enough to manage context growth, or that the user should enable additional strategies. The warning SHOULD include the percentage of content removed and which higher-tier strategies are currently disabled (if any).

#### Tool Result Clearing

Replace tool result content in the message history with a short placeholder, optionally storing the original content for later retrieval. This is the most cost-effective strategy for managing context growth, as tool results are typically the largest messages and are recoverable (the agent can re-invoke the tool).

The implementation MUST support one of two sub-strategies, selected by the user's `clearedResultStorage` configuration:

##### Lossy Clearing

Replace tool result content with a deletion notice. The original content is permanently lost from the agent's perspective.

**Behavior:**
- Iterate through tool result messages in the history, from oldest to newest
- Replace each tool result's content with a notice: `[Tool result cleared — original tool call: {tool_name}({summary_of_args})]`
- Stop clearing when the token count is below the threshold
- The notice MUST include the tool name and a brief summary of the call arguments so the model understands what data was there

##### Pointer-Based Clearing

Replace tool result content with a retrieval reference, storing the original content externally for on-demand retrieval.

**Behavior:**
- When clearing a tool result, store the original content in a configured backing store:
  - **In-memory**: a dictionary/map keyed by tool call ID, stored in the agent's runtime state (e.g., Pydantic AI `deps`, Vercel AI SDK closure state, or application-level state)
  - **On-disk**: written to a file (e.g., `.context-compactor/{tool_call_id}.txt`), suitable when the agent has filesystem access
- Replace the tool result content with a retrieval notice: `[Tool result stored externally — retrieve with tool call ID: {id}]`
- The implementing agent MUST also provide a retrieval mechanism — either a dedicated tool (e.g., `retrieve_cleared_result(tool_call_id)`) or instructions in the system prompt telling the model how to access stored results
- Stop clearing when the token count is below the threshold

**Clearing order:** Tool results MUST be cleared oldest-first. The most recent tool results are more likely to be relevant to the current task and SHOULD be preserved.

#### Summary-Based Compaction

Fire a separate LLM call to summarize the message history into a condensed form. This is the highest-quality compaction strategy but also the most expensive and slowest.

**Behavior:**
1. Select the portion of the message history to summarize (typically everything except the N most recent messages, which are preserved verbatim)
2. Send the selected portion to an LLM with a summarization prompt
3. Replace the summarized portion with a single message containing the summary
4. Preserve the N most recent messages verbatim after the summary

**The summary message:**
- MUST be a `user` role message (or equivalent in the SDK's message format) containing the summary text. The `user` role is chosen because not all providers support a `system` role in the messages array — Anthropic and Google Gemini only expose system instructions as a separate top-level parameter, and Mistral only allows system as the first message. Using `user` role ensures cross-provider compatibility. The clear marker prefix (below) distinguishes the summary from actual user messages. The `assistant` role MUST NOT be used for summaries, as it can cause the model to hallucinate that it said things it did not.
- MUST be prefixed with a clear marker, e.g., `[Conversation summary — the following is a condensed summary of the prior conversation history]\n\n`
- SHOULD instruct the model that it can ask for clarification if the summary omits something it needs

**The summarization prompt MUST instruct the summarizer to preserve:**
- The original task or objective
- Key decisions made and their rationale
- File paths, variable names, API endpoints, and other concrete identifiers
- Error messages and debugging context
- The current state of progress (what's done, what remains)
- Any constraints or requirements established during the conversation

**The number of recent messages to preserve (N):**
- MUST be configurable by the user
- SHOULD default to at least the last complete turn (one user message + one assistant response) plus any in-flight tool call/result pairs
- MUST NOT break tool call / tool result pairs — if a preserved assistant message contains tool calls, the corresponding tool results MUST also be preserved

**Summary model configuration:**
- The model used for summarization MUST be configurable independently of the agent's primary model
- The implementing agent SHOULD suggest using a cheaper/faster model for summarization (e.g., a smaller model in the same family)
- The summarization call itself MUST have its own max output token limit to prevent the summary from being excessively long

### Token Counting

The implementation MUST provide a mechanism for counting or estimating the token count of the current message history. The implementing agent MUST choose the most accurate method available in the project:

**Preferred (in order of accuracy):**

1. **Provider-specific token counting API** — e.g., Anthropic's `/v1/messages/count_tokens`, Google's `count_tokens()`. Most accurate but requires an API call.
2. **Client-side tokenizer** — e.g., `tiktoken` for OpenAI models, `@anthropic-ai/tokenizer` for Claude. Accurate and free, but requires a model-specific tokenizer library.
3. **Post-hoc usage tracking** — use `usage.inputTokens` from the most recent API response to know the token count at that point, then estimate additions since. Reasonably accurate for ongoing sessions.
4. **Heuristic estimation** — approximate token count from character count (e.g., `chars / 4` for English text). Least accurate; the implementation MUST apply a safety margin (e.g., multiply estimate by 1.1) when using heuristics to avoid underestimation.

The implementing agent MUST account for the full request payload when counting tokens, not just message content. This includes:
- System prompt / system message
- All messages in the history (including role markers, tool call metadata, etc.)
- Tool definitions (the schema of all registered tools, which is sent with every request)
- Any provider-specific overhead

Tool definitions can consume a significant number of tokens (hundreds to thousands depending on the number and complexity of tools). The implementing agent SHOULD measure or estimate tool definition overhead once and include it as a constant in the token budget calculation. This overhead MUST be included in all token count checks — both the initial pre-request check and the intermediate re-checks between tiers in the cascade. Failing to include tool definition overhead in intermediate checks can cause the cascade to exit early, resulting in a request that exceeds the effective limit once tool definitions are added by the provider.

### Configuration

Configuration values MUST live in a dedicated configuration surface — a single choke-point where the library's behavior can be retuned — rather than being hard-coded or scattered across the library's call sites. The implementing agent MUST choose an appropriate configuration mechanism for the project (e.g., environment variables, a config file, constructor parameters, SDK options).

Required configuration parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `contextWindowSize` | `number` | The model's total context window in tokens |
| `compactionThreshold` | `number` | A ratio (0.0-1.0) representing the percentage of the model's context window at which compaction should trigger (e.g., `0.8` means 80%) |
| `maxOutputTokens` | `number` | Tokens reserved for the model's response output |
| `compactionStrategies` | `list` | List of optional compaction strategy tiers to enable. Valid values: `"tool-result-clearing"` (tier 3), `"summary"` (tier 2). Execution order is always determined by the tier hierarchy (tier 3 first, then tier 2), not by list order. Raw truncation (tier 1) is always active as the final step and is not included in this list. |
| `summaryModel` | `string \| null` | Model identifier for summary-based compaction (null = use primary model) |
| `summaryPreserveCount` | `number` | Number of recent messages to preserve verbatim during summary compaction |
| `clearedResultStorage` | `enum` | Where to store cleared tool results: `"memory"`, `"disk"`, `"lossy"` |
| `toolResultSizeLimit` | `number` | A ratio (0.0-1.0) representing the maximum percentage of the context window that a single tool result may occupy. Default: `0.2` (20%). Works in conjunction with `toolResultMaxTokens` — the effective cap applied to a tool result is the smaller of `contextWindowSize × toolResultSizeLimit` and `toolResultMaxTokens`. |
| `toolResultMaxTokens` | `number` | An absolute token ceiling on the size of a single tool result. Default: `20000`. Works in conjunction with `toolResultSizeLimit` (see above). Protects against a single tool result consuming a large absolute number of tokens even when the model's context window is very large. |

## Edge Cases

- **Single tool result exceeds the size limit**: The post-tool-result check MUST raw-truncate the tool result to fit within the effective cap (the smaller of `contextWindowSize × toolResultSizeLimit` and `toolResultMaxTokens`) before it is appended to the history.

- **Message history is already at the threshold before the agent run starts**: The pre-request check (which fires before the first API call) MUST trigger compaction before the first request is sent.

- **Summary-based compaction produces a summary that still exceeds the threshold**: The implementation MUST proceed to the next strategy in the configured priority list. If all optional strategies are exhausted, raw truncation (which always runs as the final step) will bring the token count below the threshold. Summary-based compaction MUST NOT recurse — if one summary pass is insufficient, move on to the next strategy.

- **Tool call / tool result pairing**: Compaction MUST NOT separate a tool call from its corresponding tool result. If an assistant message containing tool calls is preserved, all corresponding tool result messages MUST also be preserved. If a tool result is cleared or summarized, the tool call in the assistant message MAY remain (since it shows what the agent did) but the result content is what gets compressed.

- **System prompt changes between turns**: If the application modifies the system prompt during a run (e.g., injecting dynamic context), the token count check MUST use the current system prompt, not a cached value.

- **Multiple models with different context windows**: If the application switches models mid-run (e.g., via a hook returning a different model), the compaction threshold MUST be recalculated for the new model's context window.

- **Empty or minimal history**: If the message history contains only a system prompt and a single user message, compaction MUST NOT be triggered regardless of threshold. There is nothing useful to compact.

- **History processor modifies messages that are cached by the provider**: If the application uses prompt caching (e.g., Anthropic's cache control), compaction that modifies cached messages will invalidate the cache. The implementation SHOULD be aware of this tradeoff. This is an implementation consideration, not a behavioral requirement — the spec does not prescribe cache-aware compaction.

- **SDK hook does not preserve modifications between steps**: In non-destructive mode, the implementation MUST maintain external state to track compaction results and re-apply them on each step, since the SDK may pass the original unmodified history to the hook on subsequent calls. This is a known behavior in several SDKs.

- **Tool result clearing removes context the model needs to continue**: The model may reference data from a cleared tool result. The implementation SHOULD include the tool name and argument summary in the clearing notice so the model knows what was there and can re-invoke the tool if needed.

- **Compaction during streaming responses**: If the SDK supports streaming (`streamText`), compaction MUST NOT be applied mid-stream. It MUST only occur between complete request/response cycles.

## NOT Specified (Implementation Freedom)

- The exact wording of truncation markers, clearing notices, or summary prefixes — any clear indicator that conveys the necessary information is acceptable
- The specific summarization prompt text — the implementer MAY customize the prompt for their domain as long as it preserves the required information categories
- The file format or directory structure for on-disk tool result storage
- Whether token counting happens synchronously or asynchronously
- The data structure used for in-memory tool result storage (map, dictionary, database, etc.)
- How the retrieval tool/mechanism for pointer-based clearing is surfaced to the model (dedicated tool vs. system prompt instruction vs. other)
- The exact heuristic ratio for character-to-token estimation
- Whether configuration is loaded from environment variables, a config file, constructor parameters, or another mechanism
- How the implementation handles prompt caching interactions with compaction
- Whether the implementation logs or emits events when compaction occurs (beyond the required raw truncation warning)
- The specific error handling strategy when a summary LLM call fails (retry, fallback, or skip)
- Thread-safety or concurrency mechanisms for the token counting and compaction process

## Invariants

- An API request MUST NEVER be sent with a token count (input + reserved output) that exceeds the model's context window size. Raw truncation as the final step of the pre-request check guarantees this.
- Compaction MUST NOT alter the most recent user message in the history (the one being responded to).
- Compaction MUST NOT alter or remove the system prompt / system message.
- Tool call / tool result pairs MUST remain paired after compaction — a tool call MUST NOT exist in the history without its corresponding tool result (the result content may be cleared, but the result message with a placeholder MUST remain).
- The pre-request check MUST fire before every LLM API call, including the first call in an agent run.
- The pre-request check MUST apply strategies as a tiered cascade in descending tier order: tier 3 (tool result clearing, if enabled), then tier 2 (summary-based compaction, if enabled), then tier 1 (raw truncation, always). After each tier, the token count MUST be re-checked — remaining tiers are skipped if the count is already below the threshold. Raw truncation (tier 1) MUST always run as the final step regardless of configuration — if prior tiers already brought the token count below the threshold, raw truncation is a no-op.
- Raw truncation MUST log a warning when it removes more than 25% of a message's content.
- Token count estimates MUST be conservative — when using heuristic estimation, the implementation MUST err on the side of overestimation to prevent overflow.
- Summary-based compaction MUST preserve complete recent messages (the last N messages as configured) without modification.
- In non-destructive mode, the history processor MUST be idempotent when called on the same unmodified input.
- Cleared tool results (in pointer-based mode) MUST remain retrievable for the duration of the agent run.

## Implementation Hints

- **Start with tool result clearing**: In most agent applications, tool results (especially file reads, search results, and API responses) account for 60-80% of context growth. Tool result clearing alone often provides sufficient compaction without the cost of summary-based approaches.

- **Measure tool definition overhead once**: The token cost of tool definitions (schemas sent with every request) is constant for a given set of tools. Measure it once at startup and subtract it from the available token budget as a fixed cost.

- **Be aware of summary-induced trajectory elongation**: Research (JetBrains, December 2025) found that LLM summarization can extend agent execution by 13-15% because summaries obscure natural stopping signals. If the agent tends to run longer after compaction, consider preserving more recent messages verbatim.

- **Consider KV-cache economics**: With providers that support prompt caching (Anthropic, Google), cached input tokens can be 10x cheaper than uncached. Compaction rewrites the message prefix and invalidates the cache. The cost of cache invalidation may exceed the cost of running with a slightly larger context. Factor this into threshold tuning.

- **Non-destructive SDKs: maintain external state**: Some SDKs do not preserve hook output between steps. Maintain compaction state in a closure or external variable and re-apply it on each step. Alternatively, consider running a manual loop with single-step execution for full control over message history.

- **Respect tool call pairing when slicing history**: When slicing message history in a history processor, ensure that messages containing tool calls are always followed by the corresponding tool result messages. Breaking this pairing causes API errors with most providers.

- **Token counting cost**: Provider token counting APIs add latency (an extra API call per check). For high-frequency checks (every turn in a fast tool loop), consider using client-side tokenizers or post-hoc usage tracking and reserving API-based counting for periodic recalibration.

- **Structured summaries preserve more**: If implementing summary-based compaction, consider using a structured summarization prompt with explicit sections (objective, files modified, decisions made, remaining tasks) rather than freeform summarization. Research (Factory.ai) shows structured summaries score significantly higher on information retention.

- **Non-destructive vs. destructive for dual-mode SDKs**: When the SDK supports both modes, prefer non-destructive mode — it keeps the full history in state while only sending the compacted version to the LLM. If using destructive mode, ensure tool call / tool result pairs are kept together, as some SDKs' message deletion operates by ID and does not enforce pairing automatically.

- **Check whether hook mutations are ephemeral**: In some SDKs, modifications made inside the pre-model hook affect only the current LLM call. If compaction state must persist across invocations (e.g., summary caches), store it in the SDK's state/context mechanism rather than relying on hook-level mutations.

- **Check for built-in compaction**: Some SDKs provide built-in compaction features (server-side summarization, message trimming, etc.). Evaluate whether these are sufficient for the user's needs as described in the Overview's guidance on built-in equivalents.
