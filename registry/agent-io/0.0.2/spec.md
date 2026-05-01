# agent-io

> The gateway process for an agent harness: ingests messages from external channels, funnels them through a unified pipeline into a launcher that calls the agent, and dispatches the agent's outbound messages back to target channels.

## Overview

Agent IO defines a **gateway process** that sits between external channels (Slack, Telegram, email, HTTP) and an agent. The gateway has three responsibilities:

- **Ingress** — receive messages from external platforms, authenticate them, normalize each platform's quirks, and feed them into a single unified pipeline that terminates at a launcher call to the agent.
- **Egress** — accept outbound delivery requests (from the agent or from a human operator via HTTP) and dispatch them to the correct platform.
- **Scheduler** — persist and fire deferred or recurring jobs that either launch the agent or send a notification.

The gateway runs as a single long-lived process. It owns all inbound surfaces (Slack WebSocket, webhook endpoints, `POST /gateway`), the scheduler polling loop, and the outbound clients. The agent is reached exclusively through a **launcher boundary** — a single function-shaped abstraction that the gateway calls to execute the agent. The launcher may be backed by an in-process call, a subprocess, or a remote RPC; the gateway treats it as an async function.

The gateway does not make outbound routing decisions — the caller specifies channel and recipient. The gateway's inbound pipeline does make one routing decision: when an unknown conversation arrives, it classifies the message and picks the agent + profile to launch.

## Behavioral Contract

### Gateway Process

The gateway process hosts all ingress, egress, and scheduling. It is a separate concern from the agent runtime — the agent may run in the same OS process (as a library) or in a separate process (subprocess or remote service). The spec does not mandate a deployment topology.

The gateway MUST:

- Start all configured inbound surfaces at boot.
- Start the scheduler at boot (see Scheduler).
- Register exactly one handler per platform's inbound event stream, and route all platforms into the shared `handleInboundMessage` (see Unified Inbound Pipeline).
- Import or bind to a launcher and invoke it only via the launcher boundary.
- Expose outbound primitives (`sendNotification`, channel-specific adapters) for use by the scheduler's `notify` action and by the agent via egress requests.

The gateway SHOULD consolidate all public HTTP surfaces (gateway API and webhook endpoints) behind a single HTTP server so one port and one authentication boundary cover the whole gateway.

### Launcher Boundary

The launcher is the only path by which the gateway process invokes the agent. No inbound or scheduled code path MAY call the agent by any other means.

The launcher MUST accept a **launch request**:

```json
{
  "agentId": "string (required) — which agent to run",
  "profile": "string | null — optional capability profile",
  "prompt": "string (required) — the text the agent receives",
  "sessionId": "string | null — resume a prior session when present",
  "context": "object — key-value context injected into the persona template",
  "attachments": "AttachmentRef[] | null — persisted file references the agent can read",
  "additionalEnv": "object | null — extra env vars for the agent process"
}
```

And MUST return a **launch result**:

```json
{
  "success": "boolean",
  "rawText": "string | null — the agent's text output",
  "sessionId": "string | null — session identifier for subsequent resumption",
  "output": "object | null — structured output (when the agent emits JSON)",
  "error": "string | null"
}
```

- `sessionId` is opaque to the gateway. The gateway MUST evaluate session handling per launch: if a launch result contains a non-null `sessionId`, the gateway MUST persist it on the conversation and pass it back on the next launch for that conversation; if a launch result contains `null`, the gateway MUST instead replay prior conversation history into the next launch's prompt to preserve continuity. A given conversation MAY transition between these modes across launches (e.g., a session is established on one launch, expires on the next) — the rule is per-launch, not per-runtime. See the "Conversation Continuity" invariant.
- The default replay window when no `sessionId` is available is the most recent 20 messages from the conversation's history. Implementers MAY override this; the right value is workload-specific (longer for analytic/iterative agents, shorter for chatty/low-context flows).
- The launcher MAY be an in-process function call, a call to a separate service, or a subprocess invocation. The gateway treats it as an async function.
- The launcher is synchronous from the gateway's perspective: it awaits a complete result before proceeding. Streaming is not specified.
- `output` is a free-form object the agent MAY produce. The gateway recognizes one key: `nextCheckInTime` (minutes) — used by the scheduler for self-paced cron jobs (see Scheduler).
- `attachments` is the persisted-file handoff (see Attachments). The launcher MUST ensure the agent is aware of the attachments — the implementation chooses the mechanism (e.g., rendering a list into the persona template, embedding in the prompt, setting an env var) — but the file paths MUST be reachable from the agent's execution environment.

### Inbound

#### Unified Inbound Pipeline

All inbound channels — Slack, Telegram, email, HTTP — MUST converge on a single shared handler. Channel adapters MUST NOT call the launcher directly.

The shared handler — call it `handleInboundMessage` — MUST accept:

```json
{
  "text": "string — the cleaned message text (mention markup stripped, etc.)",
  "externalId": "string — channel-scoped conversation key",
  "traceName": "string — observability label (e.g., slack-message)",
  "traceMetadata": "object | null — channel-specific tracing context",
  "replyFn": "function(string) => Promise<void> — channel-specific reply delivery",
  "context": "object | null — extra key-value context forwarded to the agent's persona",
  "attachments": "Attachment[] | null — resolved file payloads from the channel adapter (see Attachments)"
}
```

The shared handler MUST perform the following steps, in order:

1. **Trace start.** Allocate a trace ID and open a trace with `traceName` and `traceMetadata`.
2. **Conversation lookup.** Look up the conversation by `externalId` in the gateway's conversation store.
3. **Classification (new conversations only).** If no conversation exists, run the classifier on `text` to pick the target `agentId` and optional `profile`. Create a new conversation record keyed by `externalId` storing agent, profile, a derived title, and `null` sessionId.
4. **Attachment persistence.** If `attachments` is non-empty, write each one through the `AttachmentStore` (see Attachments), keyed by the conversation. Collect the resulting `AttachmentRef[]` for the launch step. If writing any attachment fails, the handler MUST fail the whole dispatch with a clear error rather than silently dropping the file.
5. **Launch.** Invoke the launcher with the conversation's `agentId`, `profile`, `prompt=text`, the conversation's stored `sessionId` (if any), a merged `context` (standard fields like `currentTime` plus the adapter-provided context), and the `AttachmentRef[]` from step 4.
6. **Persist.** Append the user's message and the agent's response to the conversation's message list. Store attachment references alongside the user message so the conversation history preserves what the user sent. Update the stored `sessionId` from the launch result.
7. **Reply.** If the launch produced `rawText`, invoke `replyFn` with it. The handler MAY append a trace link to the text.
8. **Trace end.** Complete the trace with success or error status.
9. **Error handling.** If the launcher or any intermediate step throws, the handler MUST mark the trace as failed and SHOULD still invoke `replyFn` with an error message so the user is not left without acknowledgement. A `replyFn` failure inside the error path is swallowed (best-effort).

A message with empty `text` but non-empty `attachments` MUST still be dispatched. The "no text, no attachments" case SHOULD be dropped before entering the handler (the channel adapter decides).

The shared handler is the single point of contact with the launcher for inbound. It MUST NOT be duplicated or forked per channel.

#### Conversation External ID

Conversations are keyed by an `externalId` string that the channel adapter constructs. Different channels define a conversation thread differently:

| Channel | `externalId` format | Thread semantics |
|---------|--------------------|------------------|
| Slack | `slack:<channelId>:<threadTs or ts>` | One conversation per Slack thread |
| Telegram | `telegram:<chatId>` | One conversation per chat (Telegram has no persistent threading) |
| Email | `email:<rootMessageId>` | One conversation per email thread (see Email Adapter) |
| HTTP | caller-supplied | The `POST /gateway` caller provides the identifier |

The conversation store MUST preserve `externalId → { agentId, profile, sessionId, messages }`. The gateway MUST look up by `externalId` on every inbound message so the same conversation resumes.

#### Classification

New conversations MUST be classified to pick the target agent and profile. The classifier is called **only** when no existing conversation matches the `externalId`. The classification MUST return at least `agentId` and MAY return `profile`.

The classifier implementation is not specified — it MAY be a static rule, a regex, an LLM call, or any other mechanism. But the gateway MUST have exactly one classifier for the whole inbound pipeline (not a per-channel classifier), because classification behavior is a global routing concern.

#### Attachments

Attachments (files, images, documents) arriving via any inbound channel MUST be resolved to raw bytes by the channel adapter and handed to `handleInboundMessage` via the `attachments` field. The shared handler persists them via an `AttachmentStore` and passes the resulting references to the launcher. Attachments never travel as URLs through the unified boundary — by the time `handleInboundMessage` sees them, the bytes are already in hand.

**Rationale for fetch-at-the-edge.** Each platform authenticates file downloads differently (Slack bot token + `url_private_download`; Telegram two-step `getFile` + token-in-URL fetch; email provider API for attachment parts; HTTP caller supplies bytes directly). Centralizing the fetch would duplicate every platform's auth concerns into the shared handler. Keeping the fetch inside each channel adapter keeps auth local and lets the unified boundary deal only with persistence and reference-passing.

**Attachment type (adapter → handler):**

```json
{
  "filename": "string — original filename; MUST be sanitized (no path separators, no .., no leading dot) before use",
  "mimeType": "string — e.g., image/png, application/pdf",
  "bytes": "binary — the raw content",
  "sourceUrl": "string | null — original platform URL, for reference/metadata only",
  "sourceMetadata": "object | null — channel-specific extras (e.g., Slack file ID, email content-id for inline images)"
}
```

**AttachmentRef type (handler → launcher):**

```json
{
  "filename": "string — sanitized filename as persisted",
  "mimeType": "string",
  "path": "string — absolute or workspace-relative path the agent can read",
  "sizeBytes": "number",
  "sourceUrl": "string | null",
  "sourceMetadata": "object | null"
}
```

**AttachmentStore interface.**

The gateway MUST provide an `AttachmentStore.write(conversationExternalId, attachment) => Promise<AttachmentRef>`. The store is responsible for:

- Writing the bytes to durable storage under a per-conversation namespace.
- Producing a stable, reachable `path` the agent can read.
- Preventing filename collisions within a conversation.
- Sanitizing `filename` defensively (the adapter SHOULD also sanitize, but the store MUST enforce). Path-traversal attempts MUST be rejected or neutralized.

The store implementation is not prescribed. Backends ranging from local disk to remote object stores are acceptable as long as the returned `path` is reachable from the agent's execution environment.

**Limits.** Attachment size or count limit violations MUST surface as a handler error, not silent truncation.

**Exposure to the agent.** The launcher MUST surface attachments to the agent through at least one mechanism. The agent MUST NOT receive attachments without any indication they exist. The choice of mechanism is deployment-specific (see §NOT Specified).

#### HTTP Gateway API

The gateway MUST expose an HTTP endpoint that serves as the unified outbound/scheduling API and as HTTP ingress:

```
POST /gateway
GET  /gateway
```

The endpoint MUST authenticate inbound requests; the authentication mechanism is deployment-configured. All responses MUST be JSON with a top-level `success: boolean`. Error responses MUST use HTTP 400 for validation errors, 401 for authentication failures, and 500 for server errors, and MUST take the shape `{ "success": false, "error": "<message>" }`.

##### Actions

`POST /gateway` accepts a JSON body with an `action` field. The valid actions and their required/optional fields are:

| Action            | Required                       | Optional                                                                                                                                                       |
|-------------------|--------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `notify`          | `message`                      | `channel`, `from`, `to` / `slackChannel` / `threadTs`, `subject`, `scheduledFor`, `notificationChannel`, `notificationRecipient`, `description`                |
| `run`             | `text`, `externalId`           | `agentId`, `profile`, `context`, `attachments`, `traceMetadata`, `scheduledFor`, `notificationChannel`, `notificationRecipient`                                |
| `schedule`        | `text`, `externalId`, `cron`   | `agentId`, `profile`, `context`, `attachments`, `traceMetadata`, `description`, `notificationChannel`, `notificationRecipient`, `jobId`                        |
| `update_schedule` | `jobId`                        | any of: `cron`, `text`, `description`, `profile`, `notificationChannel`, `notificationRecipient`                                                               |
| `delete_schedule` | `jobId`                        | —                                                                                                                                                              |

The body of `POST /gateway` with `action: "run"` or `action: "schedule"` **is** an inbound-message JSON (per the `handleInboundMessage` shape in §Unified Inbound Pipeline) plus action metadata. `text` and `externalId` are the inbound message's text and channel-scoped conversation key — the caller authors the message; the gateway never synthesizes one. The remaining inbound-message-shape fields (`context`, `attachments`, `traceMetadata`) are passed through verbatim. `agentId`/`profile` are optional classification overrides applied only when the conversation is new; for existing conversations, the conversation's stored agent wins so the agent does not swap mid-conversation.

`update_schedule` and `delete_schedule` replace the previous overload where `schedule` with `jobId` and no `cron` meant "delete". The split removes the overload and gives operators a real edit affordance for live cron jobs without recreating them.

##### Sync vs deferred semantics

- `notify` without `scheduledFor` MUST send immediately and return delivery metadata.
- `notify` with `scheduledFor` MUST enqueue a one-shot notification job.
- `run` without `scheduledFor` MUST execute synchronously through `handleInboundMessage` and return the launch result.
- `run` with `scheduledFor` MUST enqueue a one-shot run job (the inbound message is persisted on the job and replayed when it fires; see §Unified Run Model).
- `schedule`, `update_schedule`, and `delete_schedule` MUST always operate on the scheduler synchronously and return the resulting job state.

##### Response shapes

| Outcome                            | Response                                                          |
|------------------------------------|-------------------------------------------------------------------|
| `notify` (immediate)               | `{ success, channel, channelId \| to }`                           |
| `notify` (deferred)                | `{ success, scheduled: true, jobId, nextRun }`                    |
| `run` (sync)                       | `{ success, rawText, sessionId, output, error }`                  |
| `run` (deferred)                   | `{ success, scheduled: true, jobId, nextRun }`                    |
| `schedule` / `update_schedule`     | `{ success, job: ScheduledJob }`                                  |
| `delete_schedule`                  | `{ success, deleted: jobId }`                                     |
| Any gateway-layer error            | `{ success: false, error }` with HTTP 400/401/500 as applicable   |

`schedule` and `update_schedule` MUST return the full `ScheduledJob` (per §Scheduler Job Model) so callers can confirm exactly which fields landed without a follow-up `GET /gateway`.

`run` (sync) MUST return HTTP 200 even when the underlying launch fails — surface the launcher's failure through `success: false, error: ...` in the body. HTTP 4xx/5xx is reserved for gateway-layer errors (validation, auth, transport). This keeps the failure layers distinct: the HTTP transport reports request-level outcomes, the body reports launch-level outcomes.

##### `externalId` semantics on `run`

`run` is just an inbound message expressed over HTTP — the HTTP adapter passes the body straight to `handleInboundMessage` without inventing any field. See §Unified Run Model.

- `externalId` MUST be present on every `run` request. If absent, the gateway MUST return HTTP 400. The gateway does not generate IDs; if a caller wants ad-hoc execution against a fresh conversation, the caller mints the `externalId` on their side.
- `run` with an `externalId` matching an existing conversation MUST resume that conversation (skip classification, reuse its `sessionId` or replay its history, persist the new exchange).
- `run` with an `externalId` that does not match any existing conversation MUST classify, create a conversation record under that exact `externalId`, and proceed normally.

`replyFn` for the HTTP adapter is a no-op — the caller receives `rawText` directly in the response body.

##### Recipient resolution for `notify`

When `notify` omits the channel-specific recipient (`to` for telegram/email, `slackChannel` for Slack), the gateway MUST consult a configured per-channel default. If no default is configured, the gateway MUST return HTTP 400 with a clear error rather than silently dropping the notification.

##### Attachments on `run`

When `attachments` is present on a `run` action, the HTTP adapter acts as a channel adapter: it decodes/fetches the bytes, produces `Attachment` objects, and passes them through `handleInboundMessage` along with the inbound message.

`InlineAttachment` shape:

```json
{
  "filename": "string",
  "mimeType": "string",
  "bytesBase64": "string | null",
  "url": "string | null"
}
```

`bytesBase64` and `url` are mutually exclusive; passing both MUST be rejected with HTTP 400.

##### `GET /gateway`

`GET /gateway` MUST return `{ "jobs": ScheduledJob[] }` listing all active scheduled jobs.

#### Slack Adapter (Inbound)

The Slack adapter MUST receive messages from Slack. It SHOULD prefer **Socket Mode** (a persistent WebSocket connection authenticated by an app-level token) over the Events API:

- Socket Mode requires no publicly reachable HTTP endpoint.
- Socket Mode authenticates once at connect time, so per-event signature verification is not needed.
- Socket Mode delivers events in real time without the Events API's short-ACK retry problem.

**Socket Mode requirements:**

- MUST authenticate with an app-level token and a bot token.
- MUST acknowledge each event immediately (per Slack Socket Mode protocol) before starting work.
- MUST listen exclusively for `app_mention` events. The gateway does not handle plain `message` events; requiring an @mention to trigger is the bot's activation model.
- MUST ignore events whose payload indicates the message originated from a bot, to prevent self-triggering loops.
- MUST strip the bot's mention markup from the message text before dispatching.

**Events API requirements (alternative):**

- MUST respond to Slack's URL-verification challenge.
- MUST verify the request signature on every event using the configured signing secret.
- MUST respond within Slack's ACK window and process the message asynchronously.
- MUST deduplicate retried events using Slack's retry indicators.

**Conversation keying (Slack quirk).** The `externalId` MUST be `slack:<channel>:<threadTs || ts>`. If the inbound event is a top-level message (no `thread_ts`), the message's own timestamp is used as the thread anchor — the bot's first reply creates the Slack thread, and all subsequent messages in that thread map to the same conversation. Replies already inside a thread use the existing `thread_ts`. The `replyFn` MUST post back to the same channel and thread anchor so replies land in the thread.

**Normalization mapping:**

| Slack event field | Shared handler field |
|-------------------|----------------------|
| message text (mention markup stripped) | `text` |
| `slack:{channel}:{threadTs || ts}` | `externalId` |
| `{channel, user, ts, threadTs}` | `traceMetadata` |

**Attachments.** Slack events MAY carry file uploads. The adapter MUST authenticate the file fetch using its bot token (Slack's private file URLs require it), construct an `Attachment` per file with the original filename and MIME type, and pass the array as `attachments` to `handleInboundMessage`. If a mention carries a file but no accompanying text, the adapter MUST still dispatch (attachments with empty `text` is a valid case). If the file fetch is rejected by Slack (e.g., missing scope), the adapter MUST surface a handler error rather than silently drop the attachment.

#### Telegram Adapter (Inbound)

The Telegram adapter MUST receive messages via the Bot API webhook (HTTPS POST from Telegram to a gateway-hosted URL).

**Webhook registration.** Registration is a one-time operator task documented in the gateway's setup instructions, which MUST cover registering the webhook URL and (recommended) a secret token.

**Verification.** If a secret token was registered, Telegram delivers it on every request. The adapter MUST verify the value matches the configured secret. If no secret is configured, verification MAY be skipped (dev mode).

**Activation model (Telegram quirk).**

- In **private chats (DMs)**, every message from the user triggers the agent.
- In **groups** and **supergroups**, only messages that @mention the bot trigger the agent. The adapter MUST detect mentions structurally (Telegram delivers an entity marking the mention's offset and length), not via substring match.
- In groups, non-mention messages SHOULD still be stored in a recent-messages buffer. When the bot is mentioned, the adapter MUST look up recent messages and prepend them to the agent's prompt as a "Recent conversation history" block so the agent has context for the discussion it just joined.
- When the bot is mentioned in a group, the adapter MUST strip the `@username` mention from the text before dispatch.

**Conversation keying.** The `externalId` MUST be `telegram:<chatId>` — chat-scoped, not thread-scoped. Telegram does not have persistent threading; a single chat is a single conversation.

**Reply behavior.** The `replyFn` MUST send to the original chat and SHOULD link the reply to the user's message so it renders as an inline reply in Telegram's UI.

**Response timing.** Telegram expects a fast 200 response. The adapter MUST return 200 immediately and process the message asynchronously.

**Update types.** The adapter MUST handle user-sent messages and MAY handle edited messages. It MUST ignore Telegram channel posts unless the gateway explicitly opts in — channel posts have no sender user and are not suitable for conversational reply.

**Conversation context (Telegram quirk).** A media message's caption MUST be passed as `text`. A media-only message with no caption MUST still dispatch.

**Attachments.** Telegram messages MAY carry photos, documents, audio, video, voice, video notes, or stickers. The adapter MUST resolve each media reference to bytes (Telegram requires a two-step lookup-then-fetch flow), construct an `Attachment` per item, and pass the array as `attachments` to `handleInboundMessage`. Telegram does not always provide a filename or MIME type for media; the adapter MUST synthesize whichever is missing using the file identifier and the message's media kind. The adapter MUST surface a clear handler error when the platform refuses to download a file (e.g., for files exceeding the Bot API size ceiling) rather than retry silently.

#### Email Adapter (Inbound)

The Email adapter MUST receive inbound emails via a provider webhook (e.g., a transactional email provider's "email received" callback). IMAP polling is also acceptable, but webhook delivery is preferred because the provider handles MX setup and spam filtering.

**Webhook structure.** Some providers POST a webhook event containing only metadata, requiring a follow-up API call to fetch the full body. Others deliver the full body inline. The adapter MUST:

1. Verify the webhook signature using whatever authenticity signal the provider supplies.
2. Resolve the full email content (headers, plain-text body, HTML body, Message-ID) — either from the inline payload or via the provider's follow-up API.
3. Return 200 to the webhook quickly and process the resolved body asynchronously.

**Conversation keying by Message-ID root (Email quirk).**

Email threading is driven by the `References` and `In-Reply-To` headers, **not** by sender address. The adapter MUST derive a thread root ID:

- Parse `References` — it contains the full ancestry chain. The first ID in the chain is the root.
- If `References` is absent, fall back to `In-Reply-To`.
- If both are absent (new thread), use the email's own `Message-ID` as the root.
- Header lookups MUST be case-insensitive.

The `externalId` MUST be `email:<threadRootId>`. This ensures two unrelated email threads from the same sender are two separate conversations, while a multi-message reply chain stays grouped into one conversation.

**Loop prevention (Email quirk).** The adapter MUST ignore any inbound email whose sender address matches the gateway's configured outbound address. Without this, the gateway would process its own bounce notifications and auto-replies, creating infinite loops.

**Full text to the agent (Email quirk).** The adapter MUST pass the full plain-text email body — **including quoted reply history** — to the shared handler as `text`. Email clients append the prior thread as quoted text, and this context is valuable when the agent's session cache is cold or session resumption fails. The adapter MUST NOT strip quoted text before dispatch. (The agent's persona is responsible for recognizing quote markers when formulating a reply.)

**Subject handling.** The subject SHOULD be preserved in `traceMetadata`. The subject is NOT part of `text` unless the caller explicitly prepends it.

**Reply behavior.** The `replyFn` MUST send via the outbound email adapter with:

- recipient = the original sender's address
- subject = `Re: <original subject>` (prefix only if not already present)
- threading headers (`In-Reply-To` and `References`) set so email clients thread the reply

If the fetched email body is empty, the adapter SHOULD drop the message rather than dispatch an empty prompt — unless attachments are present, in which case it MUST still dispatch.

**Attachments.** The fetched payload MAY include attachment parts with filename, MIME type, and inline or referenced bytes. The adapter MUST resolve each part to bytes, construct an `Attachment` per part with the part's metadata (including disposition and any content-id for inline images), and pass the array as `attachments` to `handleInboundMessage`. Inline images SHOULD be treated like regular attachments — the agent can still view them. The adapter MAY skip zero-byte parts or parts whose disposition hints at tracking pixels.

#### Scheduler Dispatch (Unified Run Model)

Scheduled jobs do not bypass the inbound pipeline. They store the inbound message (or notification) the caller authored at schedule time and deliver it when the job fires.

- `run` jobs MUST persist the full inbound-message payload (`text`, `externalId`, `context`, `attachments`, optional `agentId` classification override) at schedule time. When the job fires, the scheduler dispatcher acts as a channel adapter for this firing: it reads `params` verbatim, attaches a `replyFn` constructed from the job's `notificationChannel`/`notificationRecipient` (or a no-op if neither is configured), and calls `handleInboundMessage(<that message>)`. The `replyFn` MUST deliver the agent's `rawText` via `sendNotification` to the configured channel/recipient. Recurring jobs MUST reuse the same stored `externalId` on every firing — this is what allows `sessionId` persistence (or history replay) to carry across firings, and what makes `nextCheckInTime` self-pacing work as ordinary conversation continuity.
- `notify` jobs MUST invoke `sendNotification` directly — `notify` is outbound, not inbound, so it never enters the inbound pipeline.

There is no path by which a scheduled `run` reaches the launcher without going through `handleInboundMessage`.

### Outbound

#### Unified Outbound Primitive

The gateway MUST provide a single `sendNotification(channel, options)` function used by both the HTTP Gateway API's `notify` action and the scheduler's `notify` jobs:

```json
{
  "message": "string (required)",
  "from": "string | null — label prepended to the rendered message as [from]",
  "recipient": "string | null — channel-specific recipient; falls back to channel's configured default",
  "subject": "string | null — email-only"
}
```

- Channel resolution logic (default recipient lookup, auth check) MUST live inside this function, not at each call site.
- If the caller omits `recipient`, the function MUST look up a channel-specific default from configuration (e.g., `default_slack_channel.channelId`, `telegram_config.defaultRecipient`). If no default is configured, the function MUST throw a clear error.
- The function MUST check that the channel is configured (bot token set, etc.) and throw a clear error if not.

#### Slack Adapter (Outbound)

- MUST post via the Slack Web API `chat.postMessage`.
- MUST authenticate with a bot token (`SLACK_BOT_TOKEN`).
- If `threadTs` is provided, MUST post as a thread reply; otherwise post as a top-level message to the channel.

#### Telegram Adapter (Outbound)

- MUST POST to `https://api.telegram.org/bot<TOKEN>/sendMessage`.
- MUST include `chat_id` and `text`.
- MAY include `reply_to_message_id` to inline-reply to a specific user message.
- MAY include `parse_mode` (`Markdown`, `MarkdownV2`, or `HTML`) when the caller opts in.

#### Email Adapter (Outbound)

- MUST send via the configured provider (Resend, SendGrid, SMTP).
- MUST use the configured `EMAIL_FROM` as the `From` header (and the bare address of `EMAIL_FROM` as the loop-prevention match for inbound).
- MUST set `In-Reply-To` and `References` headers when `inReplyTo` is provided, so reply chains thread correctly.
- MUST allow the caller to pass `subject`; if omitted, a deployment-configured default (e.g., `"Notification"`) is used.

#### HTTP Adapter (Outbound)

- MAY POST to a caller-supplied webhook URL with `application/json` body containing `message` and optional metadata. Used for agent-driven webhooks.

### Scheduler

The scheduler is a subsystem inside the gateway process. It persists deferred and recurring jobs and fires them when due.

#### Job Model

```json
{
  "id": "string — unique identifier",
  "action": "run | notify (default: run)",
  "agentId": "string — required for run jobs; may be 'system' for notify",
  "profile": "string | null",
  "cron": "string | null — cron expression; absent means one-shot",
  "nextRun": "number (epoch ms) — precomputed next fire time",
  "enabled": "boolean",
  "params": "object | null — for run: the inbound message authored at schedule time ({ text, externalId, context, attachments, agentId }); for notify: { message, from }",
  "description": "string | null",
  "notificationChannel": "slack | telegram | email | null",
  "notificationRecipient": "string | null"
}
```

#### Backend

- The scheduler MUST persist jobs so they survive process restarts.
- The reference implementation uses Redis: a hash (`jobs:<id>` → JSON) plus a sorted set (`jobs:queue`, score = `nextRun` epoch ms) for efficient due-job lookup. Other backends (SQLite, Postgres, etc.) are acceptable as long as they preserve the same semantics.
- The scheduler MUST poll for due jobs at a regular interval not exceeding 60 seconds. 30 seconds is a reasonable default.

#### Firing

When a job is due, the scheduler MUST:

1. Atomically mark the job as fired (prevents re-firing on a slow launch).
2. Dispatch the job asynchronously — the polling loop MUST NOT block on job execution.
3. For `run` jobs: deliver the stored inbound message (`params`) to `handleInboundMessage`. The job MUST NOT call the launcher directly. After `handleInboundMessage` completes, inspect the launch result's `output` for `nextCheckInTime` (minutes); if present and the job has a `cron`, override the next scheduled run with `Date.now() + nextCheckInTime*60*1000`. On failure (any handler-level error), call `sendNotification` on the job's `notificationChannel` with the error text.
4. For `notify` jobs: invoke `sendNotification` with `params.message`, `params.from`, the job's `notificationChannel`, and `notificationRecipient`.
5. For recurring jobs: after firing, compute the next `nextRun` from the cron expression and reschedule.
6. For one-shot jobs: after firing, remove the job.

#### Active Run Locking

The gateway SHOULD prevent duplicate concurrent runs of the same agent (or agent+profile) via a short-TTL lock in the backend (e.g., Redis `SET key ... EX 900`). A run holds the lock while executing; the scheduler or gateway API MAY skip or queue a new invocation for the same key while a lock is held.

#### Programmatic API

The scheduler MUST expose primitives:

- `scheduleOneShot(agentId, runAt, options)` → create a one-shot `run` job
- `scheduleRecurring(id, agentId, cron, options)` → create a recurring `run` job
- `scheduleNotification(runAt, options)` → create a one-shot `notify` job
- `deleteJob(id)`
- `listJobs()`
- `getDueJobs()`
- `markJobFired(id)` (reschedules recurring; removes one-shot)
- `overrideNextRun(id, date)` (used by the `nextCheckInTime` pattern)
- `setJobEnabled(id, enabled)`

These are called by the HTTP Gateway API's `run`/`schedule`/`notify` actions.

### Authentication

- The HTTP Gateway API (`/gateway`) MUST authenticate requests. Mechanism is deployment-configured.
- Each inbound channel adapter MUST verify platform authenticity:
  - **Slack Socket Mode** — app-level token, validated at WebSocket connect time
  - **Slack Events API** — `X-Slack-Signature` HMAC
  - **Telegram** — `X-Telegram-Bot-Api-Secret-Token` header
  - **Email (Resend)** — svix signature (`svix-id`, `svix-timestamp`, `svix-signature`)
- Outbound adapters MUST authenticate with target APIs using configured credentials (bot tokens, API keys, SMTP credentials).

## Edge Cases

- **Slack `app_mention` with no text and no files.** The adapter SHOULD skip dispatch. If there is at least one file attached, the adapter MUST dispatch with empty `text` and the `attachments` array populated.
- **Slack file download returns 403.** The bot likely lacks `files:read`. The adapter MUST surface this as a handler error, not silently drop the attachment.
- **Telegram media-only message (photo, document, etc.) with no `caption`.** MUST dispatch with empty `text` and `attachments` populated.
- **Telegram `getFile` returns no `file_path`.** Files larger than 20 MB are not downloadable via the Bot API. The adapter MUST surface a clear error (the user's file is too large) rather than retry silently.
- **Email attachment with a path-traversal filename (e.g., `../../etc/passwd`).** The adapter SHOULD sanitize, and the `AttachmentStore` MUST reject or neutralize such names.
- **`AttachmentStore.write` fails midway through a batch of attachments.** The shared handler MUST fail the whole dispatch (rolling back partial writes is recommended but not required) rather than launching the agent with a partial view of what the user sent.
- **HTTP Gateway API `run` with both `bytesBase64` and `url` on the same `InlineAttachment`.** MUST be rejected with a 400 — the two are mutually exclusive.
- **Slack retries on Events API.** Use `X-Slack-Retry-Num` or event ID for deduplication. A retried event MUST NOT produce a second trigger.
- **Telegram edited messages.** The webhook includes `edited_message`. Treating edits as new messages is acceptable, as is explicitly skipping them — the adapter MUST be consistent.
- **Telegram channel posts.** MUST be ignored unless the gateway explicitly opts in.
- **Telegram group with privacy mode enabled.** The bot only receives commands and direct replies. The setup docs MUST call this out so operators know to disable privacy mode via BotFather if they want the bot to see all group messages.
- **Email with no plain-text body (HTML only).** The adapter MUST strip HTML to plain text, or skip dispatch if extraction fails.
- **Email from the gateway's own outbound address.** MUST be dropped (loop prevention).
- **Email `References` header with malformed IDs.** The adapter MUST parse with a regex that tolerates whitespace and handles zero matches gracefully (fall back to `In-Reply-To` or the email's own `Message-ID`).
- **Cron expression that never matches.** MUST be rejected at job creation time.
- **One-shot job with `scheduledFor` in the past.** MUST fire on the next poll cycle.
- **Process restart with cron jobs.** Cron jobs MUST resume without re-registration. Missed cron ticks during downtime SHOULD NOT be backfilled; only future matches fire.
- **Process restart with one-shot jobs whose `scheduledFor` passed during downtime.** The scheduler MUST fire them on startup.
- **`sendNotification` with no `recipient` and no configured default.** MUST throw a clear error rather than silently dropping.
- **`run` job whose agent `output` includes `nextCheckInTime`.** The scheduler MUST override the next cron-computed run with the agent-specified interval.
- **Duplicate concurrent runs of the same agent.** The active-run lock MUST prevent concurrent executions within the lock TTL.
- **Classifier returns an unknown `agentId`.** The shared handler MUST surface this as an error (trace + `replyFn`) rather than silently dropping.
- **`replyFn` throws (e.g., Slack API down).** The shared handler MUST complete the trace with the error and propagate. It MUST NOT retry in the handler — retries are the caller's concern.
- **`POST /gateway` with `update_schedule` referencing an unknown `jobId`.** MUST return HTTP 400 with a clear error.
- **`POST /gateway` with `delete_schedule` referencing an unknown `jobId`.** MUST return HTTP 400 with a clear error rather than silently succeeding.
- **`POST /gateway` with `notify` and no recipient and no configured per-channel default.** MUST return HTTP 400 — this mirrors the equivalent `sendNotification` behavior at the HTTP layer so callers see a clear failure rather than a silent drop.
- **`POST /gateway` with `run` (sync) where the launch itself fails.** MUST return HTTP 200 with `{ success: false, error: ... }`. HTTP 5xx is reserved for gateway-layer errors (transport, validation, auth), not launch outcomes.
- **`POST /gateway` with `run` and an `externalId` that does not match any existing conversation.** The call MUST classify, create a conversation record under that exact `externalId`, and proceed. (See §Unified Run Model — `run` is just an inbound message over HTTP.)
- **`POST /gateway` with `run` and no `externalId`.** MUST return HTTP 400 — the gateway does not synthesize inbound-message fields. The caller MUST supply the `externalId`.
- **Recurring scheduled `run` whose conversation has accumulated long history.** The conversation's `externalId` is stable across firings, so session continuity (or replay) Just Works the same way it does for channel-borne conversations. The conversation store's normal retention/truncation policy applies.
- **Scheduled `run` job whose stored inbound message references attachments that are no longer reachable.** The handler MUST surface a clear error from `handleInboundMessage` step 4 (attachment persistence). The job MUST NOT silently fire without the attachments.

## NOT Specified (Implementation Freedom)

- The programming language or runtime for the gateway process.
- The web framework (Next.js, Express, Fastify, etc.).
- Whether the launcher is an in-process call, a subprocess invocation, or a remote RPC.
- The conversation persistence store (Postgres, SQLite, etc.).
- The scheduler backend (Redis, Postgres, SQLite, etc.) — Redis is the reference.
- The recent-messages store for Telegram group context (any durable key-value store works).
- The classifier implementation (rule, regex, LLM call, etc.).
- The Slack delivery mode (Socket Mode vs. Events API) — Socket Mode recommended.
- The email provider (Resend, Mailgun, SendGrid, SMTP) — Resend is the reference.
- The tracing/observability backend and the structure of trace metadata.
- The exact shape of the agent's `output` object — only `nextCheckInTime` is specified for scheduler self-pacing.
- The authentication mechanism for the HTTP Gateway API.
- Rate limiting, backpressure, and retry policies beyond what is explicitly specified here.
- Whether the gateway and agent are co-located or distributed across hosts.
- The exact prefix format of `from` rendering — the reference uses `*[from]* message` for Slack/Telegram and `[from] message` for email, but this is not required.
- The `AttachmentStore` backend (local disk under the workspace, S3, blob storage, shared NFS). Only the interface contract is specified.
- The default `AttachmentStore` path layout. Any scheme that namespaces by conversation and prevents collisions is acceptable.
- The maximum attachment size — channel adapters enforce their platform's limit; the store MAY enforce an additional ceiling.
- The attachment retention policy (the gateway MAY garbage-collect old files, but the spec does not require it).
- How the launcher surfaces attachments to the agent (persona template variable, prompt block, env var, etc.) — only that the agent MUST be made aware when attachments are present.

## Invariants

- The launcher MUST only be reached via `handleInboundMessage`. There is no second path. HTTP `/gateway run`, channel-borne inbound, and scheduler-fired `run` jobs all converge on the same handler, with the same step ordering.
- The gateway MUST NOT synthesize inbound messages. Every inbound message is authored by a caller — either a human via a channel, the HTTP gateway caller, or (for scheduled jobs) the caller at schedule time, with the message persisted on the job and replayed unchanged at fire time.
- Conversation identity is the channel-scoped `externalId`. Looking up by `externalId` MUST return the same conversation on every inbound message for that thread/chat/email-thread.
- The gateway MUST preserve conversation continuity across messages within the same `externalId`. The choice of mechanism is per-launch: when a launch result returns a `sessionId`, the gateway MUST persist it and pass it back on the next launch for that conversation; when a launch result returns no `sessionId`, the gateway MUST replay prior conversation history into the next launch's prompt instead.
- Inbound platform-specific authentication MUST be performed before the message enters the shared handler.
- The email adapter MUST drop messages sent from the gateway's own outbound address to prevent loops.
- The email adapter MUST thread conversations by `References`/`In-Reply-To`, not by sender address.
- The Slack adapter MUST trigger the agent only on `app_mention`, not on arbitrary `message` events.
- The scheduler's job `params` MUST be preserved unchanged between scheduling and firing.
- Scheduled jobs MUST survive process restarts.
- The gateway MUST NOT make outbound routing decisions — callers (agent, HTTP operator, scheduled job) specify the target channel and recipient.
- Outbound delivery failures MUST be surfaced to the caller (HTTP response, trace, or failure notification), never silently dropped.
- Channel adapters MUST resolve attachments to raw bytes before handing them to `handleInboundMessage`. The shared ingress boundary MUST NOT perform platform-specific file fetches.
- The `AttachmentStore` MUST be the single writer of attachment bytes. Channel adapters MUST NOT write directly to the workspace.
- Attachment `filename` MUST be sanitized before the file is written; path traversal MUST NOT be possible through attachment filenames.
- When attachments are present on an inbound message, the launcher MUST surface them to the agent via at least one mechanism. The agent MUST NOT execute unaware that the user attached files.
