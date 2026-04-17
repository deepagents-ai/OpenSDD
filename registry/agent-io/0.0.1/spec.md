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

- `sessionId` is opaque to the gateway. The gateway MUST persist it per conversation and pass it back on subsequent launches so the agent resumes prior context.
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
- Preventing filename collisions within a conversation (e.g., by prefixing with a timestamp or hash).
- Sanitizing `filename` defensively (the adapter SHOULD also sanitize, but the store MUST enforce). Path-traversal attempts MUST be rejected or neutralized.

The default store SHOULD write to whatever location is appropriate for chat attachments within the agent's workspace — co-locating attachments with the agent's other working files so the agent can read them with its normal filesystem tools. The specific layout is not prescribed; each consumer chooses a path convention that fits its workspace structure (e.g., `<workspace>/<agentId>/conversations/<externalId>/attachments/<timestamp>-<filename>` is one such layout, but any scheme that namespaces by conversation and prevents collisions is acceptable). Alternative stores (S3, blob storage, shared NFS, etc.) are also acceptable as long as the returned `path` is reachable from the agent's execution environment.

**Sizing and limits.** The spec does not mandate a maximum attachment size. Channel adapters MUST enforce any platform-provided limit (Slack, Telegram, and email providers each have their own). The `AttachmentStore` MAY reject writes that exceed a configured ceiling. Limit violations MUST surface as a handler error, not silent truncation.

**Lifecycle.** Attachment files persist for the lifetime of the conversation. The gateway MAY implement a retention policy (e.g., garbage-collect after N days of inactivity) but the spec does not mandate one.

**Exposure to the agent.** The launcher MUST make the attachments discoverable to the agent. Common strategies: render `AttachmentRef[]` into the persona template as a formatted list (e.g., `{{attachments}}`), prepend a block to the prompt ("User attached: filename (type) at path"), or set an environment variable the agent can read. The choice is deployment-specific, but at least one strategy MUST be active when attachments are present — the agent MUST NOT receive attachments without any indication they exist.

#### HTTP Gateway API

The gateway MUST expose an HTTP endpoint that serves as the unified outbound/scheduling API and as HTTP ingress:

```
POST /gateway
```

**Request body:**

```json
{
  "action": "string (required) — one of: notify, run, schedule",

  "channel": "slack | telegram | email | null",
  "message": "string | null",
  "from": "string | null — label prepended to the rendered message",
  "to": "string | null — recipient override for telegram/email",
  "slackChannel": "string | null",
  "threadTs": "string | null",
  "subject": "string | null — email subject",

  "agentId": "string | null",
  "profile": "string | null",
  "prompt": "string | null",
  "conversationId": "string | null — optional external ID for session resumption",
  "context": "object | null",

  "scheduledFor": "string (ISO 8601) | null — one-shot deferred execution",
  "cron": "string | null — recurring cron expression",
  "jobId": "string | null — for delete",
  "description": "string | null",
  "notificationChannel": "slack | telegram | email | null — delivery channel for scheduled run/notify",
  "notificationRecipient": "string | null",

  "attachments": "InlineAttachment[] | null — attachments for run/notify (base64 bytes or URL to fetch)"
}
```

Where `InlineAttachment` is:

```json
{
  "filename": "string",
  "mimeType": "string",
  "bytesBase64": "string | null — base64-encoded content; mutually exclusive with url",
  "url": "string | null — HTTPS URL the gateway fetches (with optional bearer token); mutually exclusive with bytesBase64"
}
```

- `action: "notify"` MUST send the message immediately to the specified channel (see Outbound). If `scheduledFor` is present, the notification is scheduled via the scheduler.
- `action: "run"` MUST launch the agent immediately via the launcher. If `scheduledFor` is present, the run is enqueued as a one-shot job.
- `action: "schedule"` MUST create a recurring job with `cron`. Passing `jobId` alone (without `cron`/`agentId`) deletes a job.
- When `attachments` is present on a `run` action, the HTTP adapter acts as a channel adapter: decode/fetch the bytes, produce `Attachment` objects, and call `handleInboundMessage` (or the equivalent runtime-only slice that skips classification when `conversationId` is provided).
- The endpoint MUST authenticate inbound requests. Authentication is deployment-configured.
- Responses MUST be structured JSON with `success: boolean` and relevant fields (`jobId`, `nextRun`, `sessionId`, `rawText`, `error`).

```
GET /gateway
```

- MUST return a list of active scheduled jobs.

The HTTP Gateway API is the gateway's programmatic surface for everything except platform-native inbound (Slack/Telegram/email webhooks).

#### Slack Adapter (Inbound)

The Slack adapter MUST receive messages from Slack. It SHOULD prefer **Socket Mode** (a persistent WebSocket connection using an app-level token) over the Events API:

- Socket Mode requires no publicly reachable HTTP endpoint (works behind NAT or on a developer laptop).
- Socket Mode authenticates once at WebSocket connect time, so per-event HMAC signature verification is not needed.
- Socket Mode delivers events in real time without the Events API's 3-second-ACK retry problem.

**Socket Mode requirements:**

- MUST authenticate with an app-level token (`xapp-...`) and a bot token (`xoxb-...`).
- MUST ack each event immediately (per Slack Socket Mode protocol) before starting work.
- MUST listen exclusively for `app_mention` events — the gateway does not handle plain `message` events. Requiring an @mention to trigger is the bot's activation model; it prevents responding to every channel message.
- MUST ignore events with `bot_id` present, to prevent self-triggering loops.
- MUST strip the bot's mention markup (`<@UBOTID>`) from the message text before dispatching.

**Events API requirements (alternative):**

- Respond to Slack's URL verification challenge by returning the `challenge` value.
- Validate the `X-Slack-Signature` header on every request using the signing secret.
- Respond with 200 within 3 seconds; process the message asynchronously.
- Deduplicate retried events using the `X-Slack-Retry-Num` header or event ID.

**Conversation keying (Slack quirk).** The `externalId` MUST be `slack:<channel>:<threadTs || ts>`. If the inbound event is a top-level message (no `thread_ts`), `event.ts` is used as the thread anchor — the bot's first reply creates the Slack thread, and all subsequent messages in that thread map to the same conversation. Replies already inside a thread use the existing `thread_ts`. The `replyFn` MUST post back to the same `channel` and `threadTs` so replies land in the thread.

**Normalization mapping:**

| Slack event field | Shared handler field |
|-------------------|----------------------|
| `event.text` (mention markup stripped) | `text` |
| `"slack:{channel}:{threadTs || ts}"` | `externalId` |
| `{channel, user, ts, threadTs}` | `traceMetadata` |

**Attachments.** Slack events MAY include a `files` array (present on `message` events containing file uploads, and surfacing on `app_mention` events when the user uploads a file with the mention). For each entry in `files`, the adapter MUST:

1. Fetch the bytes from `file.url_private_download` with header `Authorization: Bearer <SLACK_BOT_TOKEN>` — these URLs are private to the bot's workspace and require the token.
2. Build an `Attachment` with `filename = file.name`, `mimeType = file.mimetype`, `bytes = <downloaded>`, `sourceUrl = file.permalink`, and `sourceMetadata = { slackFileId: file.id }`.
3. Pass the array as `attachments` to `handleInboundMessage`.

If the mention carries a file but no accompanying text, the adapter MUST still dispatch (attachments with empty `text` is a valid case).

#### Telegram Adapter (Inbound)

The Telegram adapter MUST receive messages via the Bot API webhook (HTTPS POST from Telegram's servers to a gateway-hosted URL).

**Webhook registration.** Registration is a one-time operator task: POST to `https://api.telegram.org/bot<TOKEN>/setWebhook` with the gateway's URL and, optionally, a secret token. The gateway's setup documentation MUST include these instructions.

**Verification.** If a secret token was registered, Telegram sends it in the `X-Telegram-Bot-Api-Secret-Token` header on every request. The adapter MUST verify the header matches the configured secret. If no secret is configured, verification MAY be skipped (dev mode).

**Activation model (Telegram quirk).**

- In **private chats (DMs)**, every message from the user triggers the agent.
- In **groups** and **supergroups**, only messages that @mention the bot trigger the agent. The adapter MUST detect mentions via the message's `entities` array (`type === "mention"` whose text equals `@<botusername>`), not via substring match.
- In groups, non-mention messages SHOULD still be stored in a recent-messages table. When the bot is mentioned, the adapter MUST look up recent messages (e.g., last 20) and prepend them to the agent's prompt as a "Recent conversation history" block so the agent has context for the discussion it just joined.
- When the bot is mentioned in a group, the adapter MUST strip the `@username` mention from the text before dispatch.

**Conversation keying.** The `externalId` MUST be `telegram:<chatId>` — chat-scoped, not thread-scoped. Telegram does not have persistent threading; a single chat is a single conversation.

**Reply behavior.** The `replyFn` MUST call the Bot API's `sendMessage` with the original `chat_id` and SHOULD include `reply_to_message_id` pointing at the user's message, so the bot's reply appears as an inline reply in Telegram's UI.

**Response timing.** Telegram expects a 200 response quickly. The adapter MUST return 200 immediately and process the message asynchronously.

**Update types.** The adapter MUST handle `message` and MAY handle `edited_message`. It MUST ignore `channel_post` unless the gateway explicitly opts in — channel posts have no sender user and are not suitable for conversational reply.

**Attachments.** Telegram messages MAY carry `photo` (array of sizes), `document`, `audio`, `video`, `voice`, `video_note`, or `sticker`. For each attached media, the adapter MUST:

1. Pick the relevant file identifier (for `photo`, the largest size's `file_id`; for others, the field's `file_id`).
2. Call `https://api.telegram.org/bot<TOKEN>/getFile?file_id=<id>` to obtain `file_path`.
3. Fetch the bytes from `https://api.telegram.org/file/bot<TOKEN>/<file_path>` — note the token appears in the URL, not in a header.
4. Build an `Attachment`. Telegram does not always provide a filename; the adapter MUST synthesize one from the file_id and MIME type if missing (e.g., `<file_id>.jpg`). `mimeType` comes from the message's `mime_type` (for `document`/`audio`/`video`) or is inferred (e.g., `image/jpeg` for `photo`).
5. Pass the array as `attachments` to `handleInboundMessage`.

Telegram's `caption` field (text accompanying a media message) MUST be passed as `text`. A media-only message with no caption MUST still dispatch.

#### Email Adapter (Inbound)

The Email adapter MUST receive inbound emails via a provider webhook (e.g., Resend `email.received`, Mailgun routes, SendGrid Inbound Parse). IMAP polling is also acceptable, but webhook delivery is preferred because the provider handles MX setup and spam filtering.

**Webhook structure (metadata-then-fetch, Resend-style):**

1. The provider POSTs a webhook event containing **only metadata** — `email_id`, `from`, `to`, `subject` — not the full body.
2. The adapter MUST verify the webhook signature (e.g., svix-signed with `svix-id`, `svix-timestamp`, `svix-signature` headers).
3. The adapter MUST then call the provider's API (e.g., `resend.emails.receiving.get(email_id)`) to fetch the full content — headers, plain-text body, HTML body, Message-ID.
4. The adapter MUST return 200 to the webhook quickly and process the fetched body asynchronously.

If a provider delivers the full body in the webhook payload (e.g., SendGrid Inbound Parse `multipart/form-data`), the secondary fetch is omitted but the signature verification requirement still applies.

**Conversation keying by Message-ID root (Email quirk).**

Email threading is driven by the `References` and `In-Reply-To` headers, **not** by sender address. The adapter MUST derive a thread root ID:

- Parse the `References` header — it contains the full ancestry chain `<id1> <id2> <id3>`. The first angle-bracket-delimited ID is the root.
- If `References` is absent, fall back to `In-Reply-To`'s ID.
- If both are absent (new thread), use the email's own `Message-ID` as the root.
- Header lookups MUST be case-insensitive — email header casing is inconsistent across clients.

The `externalId` MUST be `email:<threadRootId>`. This ensures:

- Two unrelated email threads from the same sender are two separate conversations.
- A multi-message reply chain stays grouped into one conversation.

**Loop prevention (Email quirk).** The adapter MUST ignore any inbound email where the sender address matches the configured outbound sender address (the `EMAIL_FROM` the gateway sends as). Without this, the gateway would process its own bounce notifications and auto-replies, creating infinite loops.

**Full text to the agent (Email quirk).** The adapter MUST pass the full plain-text email body — **including quoted reply history** — to the shared handler as `text`. Email clients append the prior thread as quoted text, and this context is valuable when the agent's session cache is cold or session resumption fails. The adapter MUST NOT strip quoted text before dispatch. (The agent's persona is responsible for recognizing quote markers when formulating a reply.)

**Subject handling.** The subject SHOULD be preserved in `traceMetadata`. The subject is NOT part of `text` unless the caller explicitly prepends it.

**Reply behavior.** The `replyFn` MUST send via the outbound email adapter with:

- `to` = the original sender's address
- `subject` = `Re: <original subject>` (prefix only if not already present)
- `In-Reply-To` and `References` headers set to the inbound email's `Message-ID`, so email clients thread the reply

If the fetched email body is empty, the adapter SHOULD drop the message rather than dispatch an empty prompt — unless attachments are present, in which case it MUST still dispatch.

**Attachments.** The fetched email payload contains attachments as parts with filename, content-type, and either inline bytes (base64-encoded in the provider response) or a content-id referencing the provider's blob API. For each non-inline-signature/non-decorative part, the adapter MUST:

1. Extract or fetch the attachment bytes from the provider (e.g., Resend returns attachments in the `attachments` array of the received-email response, each with `filename`, `content_type`, and `content` (base64) — decode the base64).
2. Build an `Attachment` with `filename`, `mimeType = content_type`, `bytes = <decoded>`, and `sourceMetadata = { contentId: <cid if inline>, disposition: inline|attachment }`.
3. Pass the array as `attachments` to `handleInboundMessage`.

Inline images (content-disposition `inline` with a `Content-ID` referenced in the HTML body) SHOULD be treated as attachments just like regular attachments — the agent can still view them. The adapter MAY choose to skip zero-byte parts or parts with disposition hints that mark them as tracking pixels.

#### Event-Based Inbound (Scheduler → Dispatch)

The scheduler fires two kinds of jobs — `run` and `notify` — without any human sender.

- `run` jobs invoke the launcher directly. They do **not** flow through `handleInboundMessage`; they go straight to the launcher. They have no conversation context and no `replyFn`; any delivery is handled via `notificationChannel`/`notificationRecipient` on the job (see Scheduler).
- `notify` jobs invoke `sendNotification` directly.

Cron jobs, one-shot deferred runs, and ad-hoc `run`/`notify` calls through `/gateway` all use this path.

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
  "params": "object | null — for run: { prompt, ...context }; for notify: { message, from }",
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
3. For `run` jobs: invoke the launcher with `agentId`, `profile`, and `params.prompt`. After the launcher returns, inspect the result's `output` for `nextCheckInTime` (minutes); if present and the job has a `cron`, override the next scheduled run with `Date.now() + nextCheckInTime*60*1000`, so the agent can self-pace. On failure, call `sendNotification` on the job's `notificationChannel` with the error text.
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
- **HTTP Gateway API `run` action with `conversationId` that does not exist.** The call MUST launch a fresh agent run (no session resumption) rather than error.

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
- The maximum attachment size — channel adapters enforce their platform's limit; the store MAY enforce an additional ceiling.
- The attachment retention policy (the gateway MAY garbage-collect old files, but the spec does not require it).
- How the launcher surfaces attachments to the agent (persona template variable, prompt block, env var, etc.) — only that the agent MUST be made aware when attachments are present.

## Invariants

- Every inbound message, regardless of platform, MUST flow through the shared `handleInboundMessage` before reaching the launcher. Channel adapters MUST NOT bypass the shared handler.
- The launcher is the only path by which the gateway invokes the agent.
- Conversation identity is the channel-scoped `externalId`. Looking up by `externalId` MUST return the same conversation on every inbound message for that thread/chat/email-thread.
- `sessionId` MUST be persisted per conversation and passed back to the launcher on every subsequent message so the agent resumes context.
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
