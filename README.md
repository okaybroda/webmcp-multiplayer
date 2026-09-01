# Canvas Relay

Canvas Relay is an open-source WebMCP demonstration of **multiple people and their agents collaborating in the same live workspace**. It includes two public daily demos: a shared contract editor and a visual Excalidraw canvas.

## What it demonstrates

- People make local drafts and explicitly commit them to the shared state.
- Agents use browser-registered WebMCP tools instead of brittle UI automation.
- The browser keeps an opaque freshness receipt for each agent, preventing accidental stale agent edits.
- Realtime Yjs state is coordinated and durably snapshotted by per-demo Cloudflare Durable Objects.

### Canvas Relay

`/canvas/` is a MIT-licensed Excalidraw integration for real-time visual collaboration. It uses a dedicated daily Yjs room and hibernating Durable Object, isolated from the contract editor.

Its WebMCP tools are `read_canvas`, `create_canvas_elements`, `update_canvas_elements`, and `delete_canvas_elements`. They mirror the document demo's freshness model: the browser retains an opaque session per agent, and the server records the canvas revision that session last read. Mutating tools never accept a caller-supplied revision. If someone else changed the canvas after an agent's read, the mutation returns `changes_since_read` (or `reread_required`) and does not apply. The agent must review the update and retry deliberately.

Excalidraw scenes are stored as structured elements in a Yjs map keyed by element ID. This demo supports shapes and text only; binary image files are deliberately out of scope and would need a separate R2-backed asset path in a production implementation.

## Run locally

```sh
npm install
npm run dev
```

For client hot rebuilding while working, also run `npm run dev:client` in another terminal. Wrangler serves the compiled `dist/` assets and live-reloads the Worker.

Open `http://localhost:8787/canvas/` for the visual demo. The app is intentionally public and uses a date-derived room name; do not enter confidential information.

## Agent freshness protocol

The browser creates one opaque `sessionId` per agent bridge. It is never exposed as a tool parameter. The Durable Object records that session's last read revision.

- The first `read_document()` call records the receipt and returns the full document. Later calls in the same session return only the changes since the previous read when there are at most 20. If more than 20 changes arrived, the call returns the full document again; if nothing changed, it returns `up_to_date` without repeating the content.
- `edit_document({ replacements })` has no `sessionId` or `lastReadRevision` argument. Every replacement supplies its exact `expectedText`; the server rejects the write if that target changed.
- If at most 20 revisions arrived since the session read, the edit returns `changes_since_read` with line-level old/new text and refreshes its receipt. If the intended edit contradicts those changes, the response tells the agent to escalate to a human instead of overwriting them or making the document inconsistent.
- If more than 20 revisions arrived, the edit returns `reread_required`; the agent calls `read_document()` again.
- If a retry no longer finds its `expectedText` at the requested lines, it returns `target_changed` and the agent must read again. This is the server-side conditional-write guard.

Human clients receive Yjs updates live, but their own typing remains a local draft. The editor renders removed text in red and proposed text in green, with an inline checkmark that publishes the draft. If a remote edit arrives first, the checkmark is disabled until the draft is discarded and the live document is reviewed. Approved human edits create the same revision history used by agent freshness checks.

The **Copy prompt to use Codex to modify the doc** button copies a compact brief pointing an agent at the same daily document URL. Paste it into Codex; the agent then receives the document's WebMCP tools from the page itself.

## Version history and restore

Every edit is stored with a complete immutable snapshot. The **Version history** dialog searches document text and editor labels, returning 10 revisions at a time. Agents receive equivalent `list_revisions`, `read_revision`, and `request_restore_revision` WebMCP tools.

A restore never replaces history. It creates a new `restore` revision referencing the selected source revision. An agent can only open the browser review; the person in the browser sees a text-safe red/green diff and must explicitly confirm it. Confirmation is protected by Cloudflare Turnstile and is checked by the main Worker through a private service binding to the stock Siteverify Worker. The secret stays only in that verification Worker.

Restore requests are invalidated if the live document changes, and pending local drafts block a restore review. The history is scoped to the active UTC daily document; an existing document receives one labelled baseline when version history is first enabled.

## Deploy

```sh
npm run deploy
```

The document room is named `contract-demo-YYYY-MM-DD` in UTC. It is intentionally a public demo; do not use it for confidential documents. Production use needs authentication, authorization, rate limiting, and a durable audit-retention policy.

## License

This project is licensed under the [MIT License](LICENSE). Excalidraw is used as a published MIT-licensed dependency; its source checkout is deliberately not included in this repository.
