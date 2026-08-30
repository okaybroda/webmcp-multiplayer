# Recovered project history

Recovered on 2026-08-30 from the local Codex session log for this project. The original
task's UI entry may be gone, but its complete local event log remains at:

`/Users/viventhraarao/.codex/sessions/2026/08/27/rollout-2026-08-27T16-36-23-01a044f0-2532-7432-8921-fc062cc679e1.jsonl`

## Product decision

Build a public, single-document collaborative contract demo. Humans and agents share the
same Yjs document. The system coordinates document freshness; it does not decide whether
two changes are semantically contradictory.

## Implemented

- A Cloudflare Worker with a SQLite-backed Durable Object holds one shared Yjs document.
- CodeMirror + Yjs provides live updates to human editors.
- WebMCP exposes `read_document` and `edit_document`.
- The browser holds an opaque, page-lifetime session and server-issued read receipt; agents
  never send either value as tool input.
- An agent must read before it edits. If the document changed since that read:
  - 1–20 committed changes are returned as `changes_since_read`, after which the agent can
    revise and retry without rereading the entire document.
  - More than 20 committed changes return `reread_required`.
- Each agent replacement contains `expectedText`. The server rejects an edit whose intended
  target has changed, preventing a stale line replacement from silently overwriting text.
- The older human-escalation/flag tool was deliberately removed.
- The page includes a button that copies a prompt for opening the public demo in Codex and
  modifying it through WebMCP.
- Human typing is a local draft until published. The document shows removed text in red and
  proposed text in green; an inline checkmark publishes the draft. A remote change makes a
  draft stale and disables publishing until it is discarded.

## Deliberately not implemented

- Semantic contradiction detection or automated human escalation.
- Accounts, document permissions, private data handling, comments, or multiple documents.
- Persisted document version control: browsing/searching historical revisions, viewing a
  prior revision, and restore-as-a-new-revision were discussed but not built.

## Next planned feature: document version control

The next agreed direction was append-only revision history, not destructive rollback:

1. Store an immutable content snapshot for each committed revision in the Durable Object.
2. Add APIs/UI to list and search revisions and preview their contents.
3. Let a person choose a prior revision and load it as a red/green draft.
4. Publishing that draft creates a new current revision, preserving every earlier revision.

The existing `changes` table is only a bounded freshness/change-delivery log. It is not
sufficient for historical search or reliable restoration because change text may be
truncated and it does not store a complete document snapshot per revision.

## Current source of truth

The working app is in this repository. It is not a Git repository, so this recovered file
and the local Codex transcript are the available development record.
