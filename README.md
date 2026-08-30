# Shared contract WebMCP demo

A single public collaborative document built with Cloudflare Durable Objects, Yjs, PartyServer, CodeMirror, and WebMCP tool registration.

## Run locally

```sh
npm install
npm run dev
```

For client hot rebuilding while working, also run `npm run dev:client` in another terminal. Wrangler serves the compiled `dist/` assets and live-reloads the Worker.

## Agent freshness protocol

The browser creates one opaque `sessionId` per agent bridge. It is never exposed as a tool parameter. The Durable Object records that session's last read revision.

- `read_document()` records the receipt and returns the full document.
- `edit_document({ replacements })` has no `sessionId` or `lastReadRevision` argument. Every replacement supplies its exact `expectedText`; the server rejects the write if that target changed.
- If at most 20 revisions arrived since the session read, the edit returns `changes_since_read` with line-level old/new text and refreshes its receipt. The agent reconciles those changes and retries.
- If more than 20 revisions arrived, the edit returns `reread_required`; the agent calls `read_document()` again.
- If a retry no longer finds its `expectedText` at the requested lines, it returns `target_changed` and the agent must read again. This is the server-side conditional-write guard.

Human clients receive Yjs updates live, but their own typing remains a local draft. The editor renders removed text in red and proposed text in green, with an inline checkmark that publishes the draft. If a remote edit arrives first, the checkmark is disabled until the draft is discarded and the live document is reviewed. Approved human edits create the same revision history used by agent freshness checks.

The **Copy prompt to use Codex to modify the doc** button copies a compact brief pointing an agent at the same daily document URL. Paste it into Codex; the agent then receives the document's WebMCP tools from the page itself.

## Deploy

```sh
npm run deploy
```

The document room is named `contract-demo-YYYY-MM-DD` in UTC. It is intentionally a public demo; do not use it for confidential documents. Production use needs authentication, authorization, rate limiting, and a durable audit-retention policy.
