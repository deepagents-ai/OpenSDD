# context-compactor

> Context window management for AI agent harnesses that use SDK-managed run loops, providing configurable compaction strategies to prevent context overflow during agentic tool-calling sessions.

## Overview

This spec targets AI agent applications built on SDK-managed run loops (e.g., Vercel AI SDK, Pydantic AI, LangGraph, Google ADK, OpenAI Agents SDK). In these architectures, the SDK manages the tool-calling loop internally: the model produces tool calls, the host executes them, the results are appended to the message history, and the next request is sent automatically. The host application does not manually control each iteration.

Context compaction prevents the message history from exceeding the model's context window during these loops. Without it, a long-running agent session or a single large tool result can cause API request failures, silent truncation by the provider, or degraded model performance as the context fills.

**Primary audience:** This spec is written for an AI agent that will implement context compaction on a user's project. The spec guides the implementing agent through project analysis, user consultation, configuration, and implementation of all necessary components.

**Key design principle:** The spec prescribes **structured summary-based compaction** as the primary strategy and **raw truncation** as the safety net, matching the pattern used by Anthropic's Claude Code in production. Tool-result clearing is available as an optional advanced feature for deployments with retrievable storage infrastructure; it is not part of the default path.

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

3. **Optional advanced features** — whether to enable any optional advanced features on top of the primary summary-based strategy. The most common is tool-result clearing (see [Optional Advanced Features](#optional-advanced-features)), which is only appropriate for deployments that can provide retrievable external storage. By default, summary-based compaction is the sole compaction strategy and raw truncation is the safety net; this combination is sufficient for most deployments. The implementing agent MUST present its recommendation (based on project analysis) and explain the tradeoffs of enabling any optional feature.

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

When the pre-request check determines that the history exceeds the effective limit, the implementation MUST run **structured summary-based compaction** as the primary strategy ([Summary-Based Compaction](#summary-based-compaction)). Summary is the primary — and, in most deployments, the only — compaction strategy: it absorbs the roles previously split between tool-result clearing and prose summarisation, and produces a single condensed history that replaces the summarised prefix.

If summary compaction fails (the summariser call throws, returns empty, or produces output that is itself still over the effective limit), the implementation MUST fall through to **raw truncation** as a safety net ([Raw Truncation](#raw-truncation)). Raw truncation is not a named tier in this model — it is a last-resort mechanism that guarantees every outgoing request fits within the context window regardless of what happened upstream.

Two auxiliary uses of raw truncation are retained:
1. The post-tool-result size check ([Post-Tool-Result Check](#post-tool-result-check)) uses raw truncation to cap a single oversized tool result before it enters the history.
2. The pre-request safety net (above) uses raw truncation if summary-based compaction fails to bring the history below the effective limit.

**Tool-result clearing is no longer a default strategy.** It remains available as an optional advanced feature for deployments that can implement retrievable external storage for cleared results; see [Optional Advanced Features → Tool Result Clearing](#tool-result-clearing). Lossy clearing without retrievable storage is explicitly NOT RECOMMENDED because it degrades the history irreversibly without giving the model a way to recover the cleared content.

#### Rationale for the single-strategy model

v0.2.0's tiered cascade optimised for cost in a world where summariser LLM calls were expensive and slow. Modern cheap/fast summariser models (small distilled models priced at $0.05-0.20 per million input tokens, serving 100k-token passes in 2-5 seconds) have made cost-driven tiering obsolete. Running summary first also produces a materially better summary than running it after tool-result clearing has already replaced old tool outputs with clearing notices, because the summariser sees concrete content instead of `[cleared]` placeholders.

This model is aligned with the compaction pattern used by Anthropic's Claude Code in production — a single structured-summary compactor with raw truncation as a hard safety net and no tool-result clearing step.

#### Raw Truncation

Truncate content within a single message to reduce token count. Raw truncation serves two roles: it is the final step of the pre-request check (guaranteeing that no API request ever exceeds the context window), and it is the mechanism used by the post-tool-result check to enforce the `toolResultSizeLimit`.

**Behavior:**
- Identifies the largest message (by token count) in the history
- Truncates that message's content to fit within the remaining token budget
- Appends a truncation marker to the truncated content (e.g., `\n\n[Content truncated — original was {N} tokens, kept first {M} tokens]`)
- The truncation marker MUST indicate that content was lost so the model is aware

**When to use:**
- As a last-resort safety net, after summary-based compaction, if the post-summary history is still over the effective limit OR if the summariser call failed. If summary-based compaction succeeded and brought the history under the effective limit, raw truncation is a no-op on that request.
- In the post-tool-result check: when a single tool result exceeds the configured `toolResultSizeLimit`, it is raw-truncated before being appended to the history.

**Constraints:**
- MUST NOT truncate system messages or the system prompt
- MUST NOT truncate the most recent user message (the one being responded to)
- SHOULD prefer truncating tool results over assistant messages, as tool results are typically the largest and most recoverable content
- MUST preserve message structure (role, tool call IDs, metadata) even when content is truncated
- When a message contains multiple content parts (e.g., multiple tool result parts), truncation MUST be applied to the largest individual part, not to a concatenation of all parts. Each part's content is independent and MUST NOT be mixed with other parts during truncation.

**Warning threshold:** If raw truncation removes more than 25% of the selected message's content (by token count), the implementation MUST log a warning. This signals that the primary summary-based strategy did not sufficiently reduce the history — usually because `summaryPreserveCount` is too high, `compactionThreshold` is too tight, or the summariser is failing silently. The warning SHOULD include the percentage of content removed and whether the preceding summariser call succeeded or failed.

#### Summary-Based Compaction

Fire a separate LLM call to replace the summarisable prefix of the message history with a condensed structured summary. This is the spec's primary compaction strategy.

**Behavior:**
1. Select the portion of the message history to summarize (typically everything except the N most recent messages, which are preserved verbatim)
2. Send the selected portion to an LLM with a summarization prompt
3. Replace the summarized portion with a single message containing the summary
4. Preserve the N most recent messages verbatim after the summary

**The summary message:**
- MUST be a `user` role message (or equivalent in the SDK's message format) containing the summary text. The `user` role is chosen because not all providers support a `system` role in the messages array — Anthropic and Google Gemini only expose system instructions as a separate top-level parameter, and Mistral only allows system as the first message. Using `user` role ensures cross-provider compatibility. The clear marker prefix (below) distinguishes the summary from actual user messages. The `assistant` role MUST NOT be used for summaries, as it can cause the model to hallucinate that it said things it did not.
- MUST be prefixed with a clear marker, e.g., `[Conversation summary — the following is a condensed summary of the prior conversation history]\n\n`
- SHOULD instruct the model that it can ask for clarification if the summary omits something it needs

**The summarisation prompt MUST use a structured-output template.** The implementation MUST instruct the summariser to emit output in named sections, not as unstructured prose or a freeform bullet list. Unstructured prompts have been observed in production to drop load-bearing detail — particularly exact tool-call arguments, intermediate artefact paths, and the user's most recent instruction — on tool-heavy agent workloads. Named sections give the summariser explicit slots for each category and are materially better at recall.

The template MUST include, at minimum, named sections for:

1. **Primary request and intent** — all explicit user requests and goals, in detail
2. **Key technical concepts** — technologies, frameworks, domain terms
3. **Files and code sections** — paths examined, modified, or created, with code snippets for the most recent edits
4. **Errors and fixes** — including any user feedback on each error
5. **Problem-solving notes** — what has been figured out; what is still unresolved
6. **All user messages (non-tool-result)** — verbatim or near-verbatim list, in order
7. **Pending tasks** — explicitly requested, not yet done
8. **Current work** — a precise description of what was being worked on immediately before compaction, with snippets where applicable
9. **Optional next step** — only if it is DIRECTLY continuous with the immediately-preceding work, including a verbatim quote from the most recent conversation

This 9-section list is a superset of the preservation categories required by v0.2.0. The v0.2.0 floor (original task, key decisions and rationale, concrete identifiers, error/debugging context, progress state, constraints) is covered by sections 1, 2, 3, 4, 5, 7, and 8 — so implementations that migrate to the structured template do not need a separate preservation-categories check.

**The prompt SHOULD pair the structured output with an analysis scratchpad.** Instructing the summariser to emit `<analysis>...</analysis>` (discarded by the caller) followed by `<summary>...</summary>` (retained by the caller) improves recall by letting the model reason before committing, and gives the caller a deterministic extraction target. Callers SHOULD extract only the `<summary>` content and fall back to the full completion if the tags are absent.

**The number of recent messages to preserve (N):**
- MUST be configurable by the user
- SHOULD default to at least the last complete turn (one user message + one assistant response) plus any in-flight tool call/result pairs
- MUST NOT break tool call / tool result pairs — if a preserved assistant message contains tool calls, the corresponding tool results MUST also be preserved

**Summary model configuration:**
- The model used for summarization MUST be configurable independently of the agent's primary model
- The implementing agent SHOULD default `summaryModel` to a concrete cheaper/faster model available to the deployment (e.g., a smaller model in the same family, or a distilled fast model from a different provider) rather than defaulting to `null`. Defaulting to `null` — which causes summarization to run on the primary model — has been observed in production to cost 5-10x more per compaction pass and to produce summaries close to the size of their input, partially defeating the point of compaction. `null` SHOULD remain available as an explicit operator opt-in but SHOULD NOT be the default. The spec does not name a specific model id, as model catalogues change frequently.
- The summarization call itself MUST have its own max output token limit to prevent the summary from being excessively long

**Summariser call failure handling:**
- If the summarisation LLM call throws (provider outage, rate limit, malformed response, tokenizer mismatch, etc.) the implementation MUST NOT abort the agent run. It MUST catch the error, log it with enough detail for operators to diagnose, and fall through to raw truncation as the safety net.
- If the summariser returns a summary whose token count is still over the effective limit, the implementation MUST NOT recurse. It MUST fall through to raw truncation. Recursive summarisation has no bounded termination guarantee and produces progressively worse output; a single pass plus a safety-net truncation is strictly better.

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

Tool definitions can consume a significant number of tokens (hundreds to thousands depending on the number and complexity of tools). The implementing agent SHOULD measure or estimate tool definition overhead once and include it as a constant in the token budget calculation. This overhead MUST be included in all token count checks — the pre-request check, the post-summary re-check that decides whether raw truncation must run as a safety net, and the post-tool-result check. Failing to include tool definition overhead in any of these can cause a request to exceed the effective limit once tool definitions are added by the provider.

### Configuration

Configuration values MUST live in a dedicated configuration surface — a single choke-point where the library's behavior can be retuned — rather than being hard-coded or scattered across the library's call sites. The implementing agent MUST choose an appropriate configuration mechanism for the project (e.g., environment variables, a config file, constructor parameters, SDK options).

Required configuration parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `contextWindowSize` | `number` | The model's total context window in tokens |
| `compactionThreshold` | `number` | A ratio (0.0-1.0) representing the percentage of the model's context window at which compaction should trigger (e.g., `0.8` means 80%) |
| `maxOutputTokens` | `number` | Tokens reserved for the model's response output |
| `optionalFeatures` | `list` | Optional advanced features to enable. Valid values: `"tool-result-clearing"`. Empty by default. See [Optional Advanced Features](#optional-advanced-features). Summary-based compaction is always active as the primary strategy and is not listed here; raw truncation is always active as the safety net. |
| `summaryModel` | `string \| null` | Model identifier for summary-based compaction. The default SHOULD be a concrete cheaper/faster model id available to the deployment, not `null`. `null` remains a valid explicit value meaning "use the primary model" (see §Summary-Based Compaction for rationale). |
| `summaryPreserveCount` | `number` | Number of recent messages to preserve verbatim during summary compaction |
| `clearedResultStorage` | `enum` | Only consulted when `"tool-result-clearing"` is in `optionalFeatures`. Where to store cleared tool results: `"memory"`, `"disk"`. `"lossy"` is retained as a legacy value for backwards compatibility but is NOT RECOMMENDED — see [Tool Result Clearing](#tool-result-clearing). |
| `toolResultSizeLimit` | `number` | A ratio (0.0-1.0) representing the maximum percentage of the context window that a single tool result may occupy. Default: `0.2` (20%). Works in conjunction with `toolResultMaxTokens` — the effective cap applied to a tool result is the smaller of `contextWindowSize × toolResultSizeLimit` and `toolResultMaxTokens`. |
| `toolResultMaxTokens` | `number` | An absolute token ceiling on the size of a single tool result. Default: `20000`. Works in conjunction with `toolResultSizeLimit` (see above). Protects against a single tool result consuming a large absolute number of tokens even when the model's context window is very large. |

## Optional Advanced Features

These features MAY be enabled by an implementer when their deployment has the additional infrastructure to support them. Enabling any of them requires meeting the preconditions described in that feature's section. They are OFF by default. Summary-based compaction alone (the primary strategy) is sufficient for most deployments — these features are useful only when the deployment has the infrastructure to back them and the workload characteristics that benefit from them.

### Tool Result Clearing

Replace tool-result content in the message history with a retrieval reference, storing the original content externally for on-demand retrieval. When enabled, this runs **after** summary-based compaction has replaced the summarisable prefix, as an additional reduction pass on the tail of recent messages that summary preserved verbatim.

**When to enable.** Tool-result clearing is useful on top of primary summary-based compaction for deployments where:
- The agent run produces many large tool results where only a small fraction are referenced again after the turn they were generated.
- The implementation can provide retrievable storage for cleared results (in-memory map, filesystem, or equivalent).
- The implementation can provide the model with a retrieval mechanism (either a dedicated `retrieve_cleared_result` tool or retrieval instructions in the system prompt).

**Preconditions.**
1. The implementation MUST provide retrievable storage. `clearedResultStorage = "memory"` or `"disk"` are the supported values. `"lossy"` is retained as a legacy value for backwards compatibility but is NOT RECOMMENDED: lossy clearing strictly degrades the history without giving the model a recovery path, and is worse than simply letting summary-based compaction absorb the content into its Files and Code / Problem-Solving sections.
2. The implementation MUST expose a retrieval mechanism. Either:
   - A tool the agent can call to fetch a cleared result by id, OR
   - Instructions in the system prompt telling the model how to reference cleared content (e.g., "cleared tool results can be retrieved by tool call id via…").
3. If the deployment uses provider prompt-cache hashing (e.g., Anthropic's `cache_control`, where system-prompt bytes form part of the cache key), option (2) MUST be applied once, statically, at deployment time — the system prompt MUST NOT be mutated mid-run to add retrieval instructions.

#### Pointer-Based Clearing (recommended)

Replace tool result content with a retrieval reference, storing the original content externally for on-demand retrieval.

**Behavior:**
- When clearing a tool result, store the original content in the configured backing store:
  - **In-memory**: a dictionary/map keyed by tool call ID, stored in the agent's runtime state (e.g., Pydantic AI `deps`, Vercel AI SDK closure state, or application-level state)
  - **On-disk**: written to a file (e.g., `.context-compactor/{tool_call_id}.txt`), suitable when the agent has filesystem access
- Replace the tool result content with a retrieval notice: `[Tool result stored externally — retrieve with tool call ID: {id}]`
- Stop clearing when the token count is below the threshold

#### Lossy Clearing (legacy, NOT RECOMMENDED)

Replace tool result content with a deletion notice. The original content is permanently lost from the agent's perspective. This mode is retained only for backwards compatibility with v0.2.0 deployments that used `clearedResultStorage = "lossy"`; new deployments SHOULD NOT use it.

**Behavior:**
- Iterate through tool result messages in the history, from oldest to newest
- Replace each tool result's content with a notice: `[Tool result cleared — original tool call: {tool_name}({summary_of_args})]`
- Stop clearing when the token count is below the threshold
- The notice MUST include the tool name and a brief summary of the call arguments so the model understands what data was there

**Clearing order (both modes):** Tool results MUST be cleared oldest-first. The most recent tool results are more likely to be relevant to the current task and SHOULD be preserved.

## Edge Cases

- **Single tool result exceeds the size limit**: The post-tool-result check MUST raw-truncate the tool result to fit within the effective cap (the smaller of `contextWindowSize × toolResultSizeLimit` and `toolResultMaxTokens`) before it is appended to the history.

- **Message history is already at the threshold before the agent run starts**: The pre-request check (which fires before the first API call) MUST trigger compaction before the first request is sent.

- **Summary-based compaction produces a summary that still exceeds the threshold, OR the summariser call fails**: The implementation MUST NOT recurse and MUST NOT abort the agent run. It MUST catch the error (if any), log it with enough detail for operators to diagnose, and fall through to raw truncation as the safety net. Raw truncation is guaranteed to bring the history below the effective limit, so summariser failure is always recoverable.

- **Tool call / tool result pairing**: Compaction MUST NOT separate a tool call from its corresponding tool result. If an assistant message containing tool calls is preserved, all corresponding tool result messages MUST also be preserved. If a tool result is cleared or summarized, the tool call in the assistant message MAY remain (since it shows what the agent did) but the result content is what gets compressed.

- **System prompt changes between turns**: If the application modifies the system prompt during a run (e.g., injecting dynamic context), the token count check MUST use the current system prompt, not a cached value.

- **Multiple models with different context windows**: If the application switches models mid-run (e.g., via a hook returning a different model), the compaction threshold MUST be recalculated for the new model's context window.

- **Empty or minimal history**: If the message history contains only a system prompt and a single user message, compaction MUST NOT be triggered regardless of threshold. There is nothing useful to compact.

- **History processor modifies messages that are cached by the provider**: If the application uses prompt caching (e.g., Anthropic's cache control), compaction that modifies cached messages will invalidate the cache. The implementation SHOULD be aware of this tradeoff. This is an implementation consideration, not a behavioral requirement — the spec does not prescribe cache-aware compaction.

- **SDK hook does not preserve modifications between steps**: In non-destructive mode, the implementation MUST maintain external state to track compaction results and re-apply them on each step, since the SDK may pass the original unmodified history to the hook on subsequent calls. This is a known behavior in several SDKs.

- **Tool result clearing removes context the model needs to continue** *(only relevant when the optional Tool Result Clearing feature is enabled — see [Optional Advanced Features](#optional-advanced-features))*: The model may reference data from a cleared tool result. Implementations using pointer-based clearing MUST ensure the retrieval mechanism (tool or system-prompt instructions) is in place before clearing. Implementations using the legacy lossy mode SHOULD include the tool name and argument summary in the clearing notice so the model knows what was there and can re-invoke the tool if needed.

- **Compaction during streaming responses**: If the SDK supports streaming (`streamText`), compaction MUST NOT be applied mid-stream. It MUST only occur between complete request/response cycles.

- **Summary pass elongates the agent trajectory**: A single summary pass typically extends the remaining trajectory by ~10-15% because the summary, while shorter than what it replaces, is still dense enough that the model re-reads it on subsequent turns. This is a known cost of the primary strategy and is not a bug. Implementations SHOULD size `summaryPreserveCount` generously enough that most compaction passes happen on a genuinely-stale prefix rather than on still-load-bearing recent context.

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
- Whether the implementation retries the summarization LLM call before falling through to the next strategy, and the exact log format emitted for summarizer errors (the fall-through itself is required — see the "Summarizer call fails" edge case)
- Thread-safety or concurrency mechanisms for the token counting and compaction process

## Invariants

- An API request MUST NEVER be sent with a token count (input + reserved output) that exceeds the model's context window size. Raw truncation as the final step of the pre-request check guarantees this.
- Compaction MUST NOT alter the most recent user message in the history (the one being responded to).
- Compaction MUST NOT alter or remove the system prompt / system message.
- Tool call / tool result pairs MUST remain paired after compaction — a tool call MUST NOT exist in the history without its corresponding tool result (the result content may be cleared, but the result message with a placeholder MUST remain).
- The pre-request check MUST fire before every LLM API call, including the first call in an agent run.
- The pre-request check MUST run structured summary-based compaction as the primary strategy when the history exceeds the effective limit, then re-check the token count. If the re-check is still over the effective limit, or if the summariser call failed, the implementation MUST run raw truncation as the safety net. When the optional Tool Result Clearing feature is enabled, it runs after summary-based compaction and before the safety-net raw-truncation check. Raw truncation as the safety net MUST always be available to guarantee the outgoing request fits within the context window — if the primary strategy already brought the token count below the threshold, the safety net is a no-op.
- Raw truncation MUST log a warning when it removes more than 25% of a message's content.
- Token count estimates MUST be conservative — when using heuristic estimation, the implementation MUST err on the side of overestimation to prevent overflow.
- Summary-based compaction MUST preserve complete recent messages (the last N messages as configured) without modification.
- In non-destructive mode, the history processor MUST be idempotent when called on the same unmodified input.
- Cleared tool results (in pointer-based mode) MUST remain retrievable for the duration of the agent run.

## Implementation Hints

- **Summary is the default; tool-result clearing is for advanced deployments**: In most agent applications, summary-based compaction with a generous `summaryPreserveCount` is sufficient. Tool-result clearing is useful on top of summary-based compaction when the agent emits very large tool results on most turns and the deployment can provide retrievable external storage; without retrieval, lossy clearing strictly degrades the history.

- **Measure tool definition overhead once**: The token cost of tool definitions (schemas sent with every request) is constant for a given set of tools. Measure it once at startup and subtract it from the available token budget as a fixed cost.

- **Be aware of summary-induced trajectory elongation**: Research (JetBrains, December 2025) found that LLM summarisation can extend agent execution by 13-15% because summaries obscure natural stopping signals. This effect is also documented as an edge case in [§Edge Cases](#edge-cases). If the agent tends to run longer after compaction, increase `summaryPreserveCount` so compaction fires on a genuinely-stale prefix.

- **Consider KV-cache economics**: With providers that support prompt caching (Anthropic, Google), cached input tokens can be 10x cheaper than uncached. Compaction rewrites the message prefix and invalidates the cache. The cost of cache invalidation may exceed the cost of running with a slightly larger context. Factor this into threshold tuning.

- **Non-destructive SDKs: maintain external state**: Some SDKs do not preserve hook output between steps. Maintain compaction state in a closure or external variable and re-apply it on each step. Alternatively, consider running a manual loop with single-step execution for full control over message history.

- **Respect tool call pairing when slicing history**: When slicing message history in a history processor, ensure that messages containing tool calls are always followed by the corresponding tool result messages. Breaking this pairing causes API errors with most providers.

- **Token counting cost**: Provider token counting APIs add latency (an extra API call per check). For high-frequency checks (every turn in a fast tool loop), consider using client-side tokenizers or post-hoc usage tracking and reserving API-based counting for periodic recalibration.

- **Structured summaries are required, not optional**: Structured-output summarisation is a MUST in this spec (see [§Summary-Based Compaction](#summary-based-compaction)). Research (Factory.ai) shows structured summaries score significantly higher on information retention than freeform prose; the reference pattern used by Anthropic's Claude Code in production uses the 9-section template this spec mandates.

- **Non-destructive vs. destructive for dual-mode SDKs**: When the SDK supports both modes, prefer non-destructive mode — it keeps the full history in state while only sending the compacted version to the LLM. If using destructive mode, ensure tool call / tool result pairs are kept together, as some SDKs' message deletion operates by ID and does not enforce pairing automatically.

- **Check whether hook mutations are ephemeral**: In some SDKs, modifications made inside the pre-model hook affect only the current LLM call. If compaction state must persist across invocations (e.g., summary caches), store it in the SDK's state/context mechanism rather than relying on hook-level mutations.

- **Check for built-in compaction**: Some SDKs provide built-in compaction features (server-side summarization, message trimming, etc.). Evaluate whether these are sufficient for the user's needs as described in the Overview's guidance on built-in equivalents.

## Migration from v0.2.0

v0.3.0 replaces the tiered-cascade strategy model with a single-strategy summary-based model. Migration effort depends on which strategies the v0.2.0 deployment had enabled.

### If v0.2.0 deployment ran with `compactionStrategies = ["summary"]` only

No structural changes required. Recommended updates:
1. Switch the summariser prompt to the 9-section structured template. The old 6-category bullet prompt is no longer spec-compliant.
2. Set `summaryModel` to a concrete cheap/fast model id rather than `null`.
3. Wrap the summariser invocation in a try/catch that falls through to raw truncation on failure.

### If v0.2.0 deployment ran with `compactionStrategies` including `"tool-result-clearing"`

Choose one:
- **(Recommended)** Drop tool-result clearing. Summary-based compaction with the 9-section prompt will absorb the content that clearing used to discard, and the resulting history is higher-quality. Remove the `compactionStrategies` field — it is replaced by `optionalFeatures`.
- **(Advanced)** Keep tool-result clearing as an optional feature. Set `optionalFeatures = ["tool-result-clearing"]` and ensure `clearedResultStorage` is `"memory"` or `"disk"` — `"lossy"` is now NOT RECOMMENDED. Implement the retrieval-mechanism precondition from [§Optional Advanced Features](#optional-advanced-features).

### If v0.2.0 deployment ran without any optional strategies (raw truncation only)

Enable summary-based compaction. Running raw-truncation-only in v0.3.0 is still permitted (truncation remains the safety net) but is strongly discouraged — without a primary compaction strategy, every long run will trigger the 25% content-removal warning on raw truncation and the history will degrade rapidly.

### Configuration-field changes

| v0.2.0 field | v0.3.0 disposition |
|---|---|
| `compactionStrategies` | Removed. Replaced by `optionalFeatures` (different semantics). |
| `summaryModel` default | Changed: concrete cheap model id, not `null`. |
| `clearedResultStorage = "lossy"` | Retained but NOT RECOMMENDED. |
| `clearedResultStorage = "memory" \| "disk"` | Retained, now gated by `optionalFeatures = ["tool-result-clearing"]`. |
| `summaryPreserveCount`, `toolResultSizeLimit`, `toolResultMaxTokens`, `contextWindowSize`, `compactionThreshold`, `maxOutputTokens` | Unchanged. |
