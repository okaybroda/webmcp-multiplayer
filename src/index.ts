import { getServerByName, routePartykitRequest, type Connection } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

const MAX_DELIVERED_CHANGES = 20;
const MAX_REPLACEMENTS = 12;
const MAX_DOCUMENT_LENGTH = 100_000;
const HISTORY_PAGE_SIZE = 10;
const MAX_HISTORY_QUERY_LENGTH = 200;
const MAX_CANVAS_ELEMENTS = 400;
const MAX_CANVAS_ELEMENT_BYTES = 60_000;
const TURNSTILE_ACTION = "turnstile-spin-v1";
const ALLOWED_TURNSTILE_HOSTNAMES = new Set([
	"webmcp-game.viventhraarao.workers.dev",
	"localhost",
	"127.0.0.1",
]);
const INITIAL_DOCUMENT = `# Services Agreement

This Services Agreement (the "Agreement") is entered into by the parties below.

## Commercial terms

Total consideration for the services is **$1,000**.

Payment due at signing is **$1,000**.

## Scope

The provider will deliver the agreed implementation and reasonable handoff materials.

## Signatures

The parties may sign this Agreement electronically.`;

type Replacement = { startLine: number; endLine: number; expectedText: string; text: string };
type ChangeRecord = {
	revision: number; actor: string; startLine: number; endLine: number; oldText: string; newText: string; truncated: boolean; createdAt: number;
};
type StoredChange = Omit<ChangeRecord, "truncated"> & { truncated: number };
type OperationResult = Record<string, unknown>;
type RevisionKind = "baseline" | "edit" | "restore";
type RevisionRow = { revision: number; actor: string; content: string; createdAt: number; kind: RevisionKind; sourceRevision: number | null };
type RestoreIntentRow = {
	intentId: string; targetRevision: number; expectedRevision: number; requestedBy: string; status: string; resultJson: string | null; createdAt: number;
};
type RestoreIntentLookup = { status: "ok"; intent: Record<string, unknown> } | { status: "not_found" };
type CanvasElement = Record<string, unknown> & { id: string; type: string };
type CanvasMutation =
	| { action: "create"; elements: CanvasElement[] }
	| { action: "update"; patches: Array<{ id: string; patch: Record<string, unknown> }> }
	| { action: "delete"; ids: string[] };

function todayRoomName(now = new Date()): string { return `contract-demo-${now.toISOString().slice(0, 10)}`; }
function todayCanvasRoomName(now = new Date()): string { return `canvas-demo-${now.toISOString().slice(0, 10)}`; }
function safeId(value: unknown): string | null { return typeof value === "string" && /^[a-zA-Z0-9_-]{16,160}$/.test(value) ? value : null; }
function asRevision(value: unknown): number | null {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function asOptionalQuery(value: string | null): string { return (value ?? "").trim().slice(0, MAX_HISTORY_QUERY_LENGTH); }
function snapshotJson(document: Y.Doc): string { return JSON.stringify(Array.from(Y.encodeStateAsUpdate(document))); }

function asReplacement(value: unknown): Replacement | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<Replacement>;
	const { startLine, endLine, expectedText, text } = candidate;
	if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine! < 1 || endLine! < startLine! || typeof expectedText !== "string" || expectedText.length > 10_000 || typeof text !== "string" || text.length > 10_000) return null;
	return { startLine: startLine!, endLine: endLine!, expectedText, text };
}
function lineRange(text: string, startLine: number, endLine: number): [number, number] | null {
	const starts = [0];
	for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") starts.push(index + 1);
	if (startLine > starts.length || endLine > starts.length) return null;
	const start = starts[startLine - 1];
	const nextLineStart = endLine < starts.length ? starts[endLine] : text.length;
	const end = nextLineStart > start && text[nextLineStart - 1] === "\n" ? nextLineStart - 1 : nextLineStart;
	return [start, end];
}
type ReplacementApplication = { status: "applied"; content: string } | { status: "invalid_replacements" | "target_changed" };
function applyReplacements(text: string, replacements: Replacement[]): ReplacementApplication {
	const resolved = replacements.map((replacement) => ({ replacement, range: lineRange(text, replacement.startLine, replacement.endLine) })).sort((left, right) => (right.range?.[0] ?? 0) - (left.range?.[0] ?? 0));
	if (resolved.some((item) => item.range === null)) return { status: "invalid_replacements" };
	if (resolved.some((item) => { const [start, end] = item.range!; return text.slice(start, end) !== item.replacement.expectedText; })) return { status: "target_changed" };
	let output = text;
	let protectedStart = Number.POSITIVE_INFINITY;
	for (const item of resolved) {
		const [start, end] = item.range!;
		if (end > protectedStart) return { status: "invalid_replacements" };
		output = `${output.slice(0, start)}${item.replacement.text}${output.slice(end)}`;
		protectedStart = start;
	}
	return output.length <= MAX_DOCUMENT_LENGTH ? { status: "applied", content: output } : { status: "invalid_replacements" };
}
function makeChangeRecord(revision: number, actor: string, previous: string, next: string, createdAt: number): ChangeRecord {
	let prefix = 0;
	while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
	let previousSuffix = previous.length;
	let nextSuffix = next.length;
	while (previousSuffix > prefix && nextSuffix > prefix && previous[previousSuffix - 1] === next[nextSuffix - 1]) { previousSuffix -= 1; nextSuffix -= 1; }
	const previousLineStart = previous.lastIndexOf("\n", Math.max(0, prefix - 1)) + 1;
	const nextLineStart = next.lastIndexOf("\n", Math.max(0, prefix - 1)) + 1;
	const previousLineEndAt = previous.indexOf("\n", previousSuffix);
	const nextLineEndAt = next.indexOf("\n", nextSuffix);
	const previousLineEnd = previousLineEndAt === -1 ? previous.length : previousLineEndAt;
	const nextLineEnd = nextLineEndAt === -1 ? next.length : nextLineEndAt;
	const startLine = previous.slice(0, previousLineStart).split("\n").length;
	const endLine = startLine + previous.slice(previousLineStart, previousLineEnd).split("\n").length - 1;
	const oldText = previous.slice(previousLineStart, previousLineEnd);
	const newText = next.slice(nextLineStart, nextLineEnd);
	const truncated = oldText.length > 1_600 || newText.length > 1_600;
	return { revision, actor, startLine, endLine, oldText: truncated ? oldText.slice(0, 1_600) : oldText, newText: truncated ? newText.slice(0, 1_600) : newText, truncated, createdAt };
}
function originDetails(origin: unknown): { actor: string; kind: RevisionKind; sourceRevision: number | null } {
	const candidate = origin && typeof origin === "object" && "state" in origin ? (origin as { state?: unknown }).state : origin;
	if (candidate && typeof candidate === "object") {
		const { actorId, kind, sourceRevision } = candidate as { actorId?: unknown; kind?: unknown; sourceRevision?: unknown };
		return { actor: typeof actorId === "string" ? actorId.slice(0, 80) : "human", kind: kind === "restore" ? "restore" : "edit", sourceRevision: asRevision(sourceRevision) };
	}
	return { actor: "human", kind: "edit", sourceRevision: null };
}
function historyMetadata(row: RevisionRow): Record<string, unknown> {
	return { revision: row.revision, actor: row.actor, createdAt: row.createdAt, kind: row.kind, sourceRevision: row.sourceRevision, preview: row.content.slice(0, 260) };
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function canvasElement(value: unknown): CanvasElement | null {
	if (!isRecord(value) || !safeId(value.id) || typeof value.type !== "string" || value.type.length === 0 || value.type.length > 40) return null;
	try {
		const copy = JSON.parse(JSON.stringify(value)) as CanvasElement;
		return JSON.stringify(copy).length <= MAX_CANVAS_ELEMENT_BYTES ? copy : null;
	} catch { return null; }
}
function canvasMutation(value: unknown): CanvasMutation | null {
	if (!isRecord(value) || typeof value.action !== "string") return null;
	if (value.action === "create" && Array.isArray(value.elements)) {
		const elements = value.elements.map(canvasElement);
		return elements.every((element): element is CanvasElement => element !== null) && elements.length > 0 && elements.length <= 40 ? { action: "create", elements } : null;
	}
	if (value.action === "update" && Array.isArray(value.patches)) {
		const patches = value.patches.map((item) => isRecord(item) && safeId(item.id) && isRecord(item.patch) ? { id: item.id, patch: item.patch } : null);
		return patches.every((patch): patch is { id: string; patch: Record<string, unknown> } => patch !== null) && patches.length > 0 && patches.length <= 40 ? { action: "update", patches } : null;
	}
	if (value.action === "delete" && Array.isArray(value.ids)) {
		const ids = value.ids.filter((id): id is string => safeId(id) !== null);
		return ids.length === value.ids.length && ids.length > 0 && ids.length <= 40 ? { action: "delete", ids } : null;
	}
	return null;
}

export class DocumentRoom extends YServer {
	// PartyServer defaults to regular WebSockets, which pin a Durable Object in
	// memory for the lifetime of each connection. Hibernation keeps the sockets
	// connected while avoiding duration charges whenever the room is idle.
	static options = { hibernate: true };

	private revision = 0;
	private lastText = "";

	async onStart(): Promise<void> {
		await super.onStart();
		// A tab left open across UTC midnight must not revive an archived room.
		// This also clears connections from pre-hibernation deployments once they
		// next wake the object.
		if (this.name !== todayRoomName()) {
			for (const connection of this.getConnections()) connection.close(1008, "This demo room has expired. Reload to join today's document.");
		}
	}

	async onLoad(): Promise<void> {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS changes (revision INTEGER PRIMARY KEY, actor TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, old_text TEXT NOT NULL, new_text TEXT NOT NULL, truncated INTEGER NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS read_receipts (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS revision_snapshots (revision INTEGER PRIMARY KEY, actor TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL, source_revision INTEGER);
			CREATE TABLE IF NOT EXISTS restore_intents (intent_id TEXT PRIMARY KEY, target_revision INTEGER NOT NULL, expected_revision INTEGER NOT NULL, requested_by TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS restore_intents_status_idx ON restore_intents(status);
		`);
		const row = Array.from(this.ctx.storage.sql.exec<{ revision: number; snapshotJson: string }>("SELECT revision, snapshot_json as snapshotJson FROM room_state WHERE id = 1"))[0];
		if (row) {
			this.revision = row.revision;
			Y.applyUpdate(this.document, new Uint8Array(JSON.parse(row.snapshotJson)));
		} else {
			this.document.getText("content").insert(0, INITIAL_DOCUMENT);
			this.persistSnapshot();
		}
		this.lastText = this.document.getText("content").toString();
		this.ensureHistoryBaseline();
		this.document.getText("content").observe((event) => this.recordTextChange(event.transaction.origin));
	}
	async onSave(): Promise<void> { this.persistSnapshot(); }
	onConnect(connection: Connection, context: { request: Request }): void {
		const actorId = new URL(context.request.url).searchParams.get("actor")?.slice(0, 80) || "human";
		connection.setState({ actorId });
		super.onConnect(connection, context);
	}
	isReadOnly(): boolean { return this.name !== todayRoomName(); }

	async readForSession(sessionId: string): Promise<OperationResult> {
		if (!safeId(sessionId)) return { status: "invalid_session" };
		const receipt = Array.from(this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM read_receipts WHERE session_id = ?", sessionId))[0];
		if (receipt && receipt.revision === this.revision) {
			this.recordRead(sessionId);
			return { status: "up_to_date", revision: this.revision };
		}
		if (receipt) {
			const rows = Array.from(this.ctx.storage.sql.exec<StoredChange>("SELECT revision, actor, start_line as startLine, end_line as endLine, old_text as oldText, new_text as newText, truncated, created_at as createdAt FROM changes WHERE revision > ? ORDER BY revision ASC LIMIT ?", receipt.revision, MAX_DELIVERED_CHANGES + 1));
			if (rows.length <= MAX_DELIVERED_CHANGES) {
				this.recordRead(sessionId);
				return { status: "changes_since_read", fromRevision: receipt.revision, currentRevision: this.revision, changes: rows.map((change) => ({ ...change, truncated: Boolean(change.truncated) })) };
			}
		}
		this.recordRead(sessionId);
		return { status: "ok", revision: this.revision, content: this.document.getText("content").toString() };
	}
	async editForSession(sessionId: string, replacements: Replacement[], operationId: string, actorLabel = "agent"): Promise<OperationResult> {
		if (!safeId(sessionId) || !safeId(operationId)) return { status: "invalid_request" };
		if (this.name !== todayRoomName()) return { status: "room_expired", rereadRequired: true };
		if (replacements.length === 0 || replacements.length > MAX_REPLACEMENTS) return { status: "invalid_replacements" };
		const prior = Array.from(this.ctx.storage.sql.exec<{ resultJson: string }>("SELECT result_json as resultJson FROM operations WHERE operation_id = ?", operationId))[0];
		if (prior) return JSON.parse(prior.resultJson) as OperationResult;
		const receipt = Array.from(this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM read_receipts WHERE session_id = ?", sessionId))[0];
		if (!receipt) return this.storeOperation(operationId, { status: "read_required" });
		if (receipt.revision < this.revision) {
			const rows = Array.from(this.ctx.storage.sql.exec<StoredChange>("SELECT revision, actor, start_line as startLine, end_line as endLine, old_text as oldText, new_text as newText, truncated, created_at as createdAt FROM changes WHERE revision > ? ORDER BY revision ASC LIMIT ?", receipt.revision, MAX_DELIVERED_CHANGES + 1));
			if (rows.length > MAX_DELIVERED_CHANGES) return this.storeOperation(operationId, { status: "reread_required", currentRevision: this.revision, message: "More than 20 changes arrived since this agent last read the document." });
			this.recordRead(sessionId);
			return this.storeOperation(operationId, { status: "changes_since_read", currentRevision: this.revision, changes: rows.map((change) => ({ ...change, truncated: Boolean(change.truncated) })), message: "These are changes made since your last read. If your edits contradict these changes, escalate to a human instead of overwriting them or making the document inconsistent." });
		}
		const current = this.document.getText("content").toString();
		const application = applyReplacements(current, replacements);
		if (application.status === "target_changed") return this.storeOperation(operationId, { status: "target_changed", currentRevision: this.revision, message: "The text at one or more edit targets changed. Read the document again before retrying." });
		if (application.status !== "applied") return this.storeOperation(operationId, { status: "invalid_replacements" });
		if (application.content !== current) {
			const text = this.document.getText("content");
			this.document.transact(() => { text.delete(0, current.length); text.insert(0, application.content); }, { actorId: actorLabel, kind: "edit" });
		}
		this.recordRead(sessionId);
		return this.storeOperation(operationId, { status: "applied", revision: this.revision });
	}
	async status(): Promise<OperationResult> { return { room: this.name, revision: this.revision, content: this.document.getText("content").toString(), active: this.name === todayRoomName() }; }

	async listRevisions(query: string, beforeRevision: number | null): Promise<OperationResult> {
		const before = beforeRevision ?? Number.MAX_SAFE_INTEGER;
		const normalized = query.toLocaleLowerCase();
		const rows = Array.from(this.ctx.storage.sql.exec<RevisionRow>(
			"SELECT revision, actor, content, created_at as createdAt, kind, source_revision as sourceRevision FROM revision_snapshots WHERE revision < ? AND (? = '' OR lower(content) LIKE ? OR lower(actor) LIKE ?) ORDER BY revision DESC LIMIT ?",
			before, normalized, `%${normalized}%`, `%${normalized}%`, HISTORY_PAGE_SIZE + 1,
		));
		const page = rows.slice(0, HISTORY_PAGE_SIZE);
		return { status: "ok", revisions: page.map(historyMetadata), nextBeforeRevision: rows.length > HISTORY_PAGE_SIZE ? page.at(-1)?.revision ?? null : null, historyStartRevision: this.historyStartRevision() };
	}
	async readRevision(revision: number): Promise<OperationResult> {
		const row = this.snapshotForRevision(revision);
		return row ? { status: "ok", ...historyMetadata(row), content: row.content } : { status: "not_found" };
	}
	async createRestoreIntent(targetRevision: number, requester: string): Promise<OperationResult> {
		if (this.name !== todayRoomName()) return { status: "room_expired" };
		const target = this.snapshotForRevision(targetRevision);
		if (!target) return { status: "not_found" };
		if (targetRevision === this.revision) return { status: "already_current", currentRevision: this.revision };
		const intentId = crypto.randomUUID().replaceAll("-", "");
		const createdAt = Date.now();
		this.ctx.storage.sql.exec("INSERT INTO restore_intents (intent_id, target_revision, expected_revision, requested_by, status, result_json, created_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?)", intentId, targetRevision, this.revision, requester.slice(0, 80), createdAt);
		return { status: "confirmation_required", intentId, targetRevision, expectedRevision: this.revision, target: { ...historyMetadata(target), content: target.content } };
	}
	async getRestoreIntent(intentId: string): Promise<RestoreIntentLookup> {
		const intent = this.intentById(intentId);
		return intent ? { status: "ok", intent: this.intentMetadata(intent) } : { status: "not_found" };
	}
	async cancelRestoreIntent(intentId: string): Promise<OperationResult> {
		const intent = this.intentById(intentId);
		if (!intent) return { status: "not_found" };
		if (intent.status === "pending") this.ctx.storage.sql.exec("UPDATE restore_intents SET status = 'cancelled', result_json = ? WHERE intent_id = ?", JSON.stringify({ status: "cancelled" }), intentId);
		return { status: "cancelled" };
	}
	async confirmRestore(intentId: string): Promise<OperationResult> {
		const intent = this.intentById(intentId);
		if (!intent) return { status: "not_found" };
		if (intent.status === "completed") return intent.resultJson ? JSON.parse(intent.resultJson) as OperationResult : { status: "completed" };
		if (intent.status !== "pending") return { status: intent.status };
		if (intent.expectedRevision !== this.revision) return this.finishIntent(intentId, "stale", { status: "stale", currentRevision: this.revision, message: "The document changed while this restore was being reviewed." });
		const target = this.snapshotForRevision(intent.targetRevision);
		if (!target) return this.finishIntent(intentId, "stale", { status: "not_found" });
		const current = this.document.getText("content").toString();
		if (current === target.content) return this.finishIntent(intentId, "completed", { status: "already_current", revision: this.revision, sourceRevision: target.revision });
		const text = this.document.getText("content");
		this.document.transact(() => { text.delete(0, current.length); text.insert(0, target.content); }, { actorId: intent.requestedBy, kind: "restore", sourceRevision: target.revision });
		return this.finishIntent(intentId, "completed", { status: "restored", revision: this.revision, sourceRevision: target.revision });
	}

	private ensureHistoryBaseline(): void {
		const existing = Array.from(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM revision_snapshots"))[0];
		if (!existing || existing.count === 0) this.ctx.storage.sql.exec("INSERT INTO revision_snapshots (revision, actor, content, created_at, kind, source_revision) VALUES (?, 'system', ?, ?, 'baseline', NULL)", this.revision, this.lastText, Date.now());
	}
	private historyStartRevision(): number {
		return Array.from(this.ctx.storage.sql.exec<{ revision: number }>("SELECT MIN(revision) as revision FROM revision_snapshots"))[0]?.revision ?? this.revision;
	}
	private snapshotForRevision(revision: number): RevisionRow | undefined {
		return Array.from(this.ctx.storage.sql.exec<RevisionRow>("SELECT revision, actor, content, created_at as createdAt, kind, source_revision as sourceRevision FROM revision_snapshots WHERE revision = ?", revision))[0];
	}
	private intentById(intentId: string): RestoreIntentRow | undefined {
		return Array.from(this.ctx.storage.sql.exec<RestoreIntentRow>("SELECT intent_id as intentId, target_revision as targetRevision, expected_revision as expectedRevision, requested_by as requestedBy, status, result_json as resultJson, created_at as createdAt FROM restore_intents WHERE intent_id = ?", intentId))[0];
	}
	private intentMetadata(intent: RestoreIntentRow): Record<string, unknown> { return { targetRevision: intent.targetRevision, expectedRevision: intent.expectedRevision, requestedBy: intent.requestedBy, status: intent.status, createdAt: intent.createdAt }; }
	private finishIntent(intentId: string, status: string, result: OperationResult): OperationResult {
		this.ctx.storage.sql.exec("UPDATE restore_intents SET status = ?, result_json = ? WHERE intent_id = ?", status, JSON.stringify(result), intentId);
		return result;
	}
	private recordTextChange(origin: unknown): void {
		const next = this.document.getText("content").toString();
		if (next === this.lastText) return;
		const details = originDetails(origin);
		const record = makeChangeRecord(this.revision + 1, details.actor, this.lastText, next, Date.now());
		const snapshot = snapshotJson(this.document);
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("INSERT INTO changes (revision, actor, start_line, end_line, old_text, new_text, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", record.revision, record.actor, record.startLine, record.endLine, record.oldText, record.newText, record.truncated ? 1 : 0, record.createdAt);
			this.ctx.storage.sql.exec("INSERT INTO revision_snapshots (revision, actor, content, created_at, kind, source_revision) VALUES (?, ?, ?, ?, ?, ?)", record.revision, record.actor, next, record.createdAt, details.kind, details.sourceRevision);
			this.ctx.storage.sql.exec("INSERT INTO room_state (id, revision, snapshot_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, snapshot_json = excluded.snapshot_json", record.revision, snapshot);
			this.ctx.storage.sql.exec("UPDATE restore_intents SET status = 'stale', result_json = ? WHERE status = 'pending' AND expected_revision <> ?", JSON.stringify({ status: "stale", currentRevision: record.revision, message: "The document changed while this restore was being reviewed." }), record.revision);
		});
		this.revision = record.revision;
		this.lastText = next;
	}
	private recordRead(sessionId: string): void { this.ctx.storage.sql.exec("INSERT INTO read_receipts (session_id, revision, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at", sessionId, this.revision, Date.now()); }
	private storeOperation(operationId: string, result: OperationResult): OperationResult { this.ctx.storage.sql.exec("INSERT INTO operations (operation_id, result_json, created_at) VALUES (?, ?, ?)", operationId, JSON.stringify(result), Date.now()); return result; }
	private persistSnapshot(): void { this.ctx.storage.sql.exec("INSERT INTO room_state (id, revision, snapshot_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, snapshot_json = excluded.snapshot_json", this.revision, snapshotJson(this.document)); }
}

/** A separate, public daily visual collaboration room for the Excalidraw demo. */
export class CanvasRoom extends YServer {
	static options = { hibernate: true };
	private revision = 0;
	private elements!: Y.Map<CanvasElement>;
	private loaded = false;
	private started = false;

	async onStart(): Promise<void> {
		if (this.started) return;
		await super.onStart();
		this.started = true;
		if (this.name !== todayCanvasRoomName()) {
			for (const connection of this.getConnections()) connection.close(1008, "This demo canvas has expired. Reload to join today's canvas.");
		}
	}
	async onLoad(): Promise<void> {
		if (this.loaded) return;
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS canvas_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS canvas_snapshots (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot_json TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS canvas_changes (revision INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, element_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS canvas_read_receipts (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS canvas_operations (operation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
		`);
		this.revision = Array.from(this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM canvas_state WHERE id = 1"))[0]?.revision ?? 0;
		const snapshot = Array.from(this.ctx.storage.sql.exec<{ snapshotJson: string }>("SELECT snapshot_json as snapshotJson FROM canvas_snapshots WHERE id = 1"))[0];
		if (snapshot) Y.applyUpdate(this.document, new Uint8Array(JSON.parse(snapshot.snapshotJson)));
		this.elements = this.document.getMap<CanvasElement>("elements");
		if (this.elements.size === 0) { this.seedCanvas(); this.persistSnapshot(); }
		this.elements.observe((event) => this.recordCanvasChange(event));
		this.loaded = true;
	}
	onConnect(connection: Connection, context: { request: Request }): void {
		const actorId = new URL(context.request.url).searchParams.get("actor")?.slice(0, 80) || "human";
		connection.setState({ actorId });
		super.onConnect(connection, context);
	}
	isReadOnly(): boolean { return this.name !== todayCanvasRoomName(); }

	async readForSession(sessionId: string): Promise<OperationResult> {
		await this.ensureLoaded();
		if (!safeId(sessionId)) return { status: "invalid_session" };
		const receipt = this.receipt(sessionId);
		if (receipt?.revision === this.revision) {
			this.recordRead(sessionId);
			return { status: "up_to_date", revision: this.revision };
		}
		if (receipt) {
			const changes = this.changesSince(receipt.revision);
			if (changes.length <= MAX_DELIVERED_CHANGES) {
			this.recordRead(sessionId);
			return { status: "changes_since_read", fromRevision: receipt.revision, currentRevision: this.revision, changes, elements: this.sceneElements() };
			}
		}
		this.recordRead(sessionId);
		return { status: "ok", revision: this.revision, elements: this.sceneElements() };
	}
	async mutateForSession(sessionId: string, operation: CanvasMutation, operationId: string, actorLabel = "agent"): Promise<OperationResult> {
		await this.ensureLoaded();
		if (!safeId(sessionId) || !safeId(operationId)) return { status: "invalid_request" };
		if (this.name !== todayCanvasRoomName()) return { status: "room_expired", rereadRequired: true };
		const prior = Array.from(this.ctx.storage.sql.exec<{ resultJson: string }>("SELECT result_json as resultJson FROM canvas_operations WHERE operation_id = ?", operationId))[0];
		if (prior) return JSON.parse(prior.resultJson) as OperationResult;
		const receipt = this.receipt(sessionId);
		if (!receipt) return this.storeOperation(operationId, { status: "read_required", message: "Call read_canvas before making a change." });
		if (receipt.revision < this.revision) {
			const changes = this.changesSince(receipt.revision);
			return this.storeOperation(operationId, changes.length <= MAX_DELIVERED_CHANGES
				? { status: "changes_since_read", currentRevision: this.revision, changes, elements: this.sceneElements(), message: "The canvas changed since this agent last read it. Call read_canvas to record the refreshed scene before retrying." }
				: { status: "reread_required", currentRevision: this.revision, message: "More than 20 canvas changes arrived. Call read_canvas again before retrying." });
		}
		const changedIds = this.applyMutation(operation, actorLabel);
		this.recordRead(sessionId);
		return this.storeOperation(operationId, { status: changedIds.length ? "applied" : "no_change", revision: this.revision, changedElementIds: changedIds });
	}
	async status(): Promise<OperationResult> { await this.ensureLoaded(); return { room: this.name, revision: this.revision, elementCount: this.elements.size, active: this.name === todayCanvasRoomName() }; }
	async listRevisions(): Promise<OperationResult> {
		await this.ensureLoaded();
		const revisions = Array.from(this.ctx.storage.sql.exec<{ revision: number; actor: string; action: string; elementIdsJson: string; createdAt: number }>("SELECT revision, actor, action, element_ids_json as elementIdsJson, created_at as createdAt FROM canvas_changes ORDER BY revision DESC LIMIT 30")).map((change) => ({ revision: change.revision, actor: change.actor, action: change.action, elementIds: JSON.parse(change.elementIdsJson) as string[], createdAt: change.createdAt }));
		return { revisions, currentRevision: this.revision };
	}
	private async ensureLoaded(): Promise<void> { if (!this.started) await this.onStart(); }

	private seedCanvas(): void {
		const seed = [
			{ id: "canvas-title-00001", type: "text", x: 120, y: 100, text: "Design a great first-run experience", fontSize: 28, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: null, originalText: "Design a great first-run experience", autoResize: true, lineHeight: 1.25, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, angle: 0, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false },
			{ id: "canvas-card-000001", type: "rectangle", x: 120, y: 180, width: 280, height: 150, strokeColor: "#4f46e5", backgroundColor: "#eef2ff", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, angle: 0, seed: 2, version: 1, versionNonce: 2, isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false },
			{ id: "canvas-note-000001", type: "text", x: 160, y: 225, text: "Human sketch\n\nInvite agents to add\noptions, flows, and copy.", fontSize: 20, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: null, originalText: "Human sketch\n\nInvite agents to add\noptions, flows, and copy.", autoResize: true, lineHeight: 1.25, strokeColor: "#312e81", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, angle: 0, seed: 3, version: 1, versionNonce: 3, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false },
		] as CanvasElement[];
		this.document.transact(() => seed.forEach((element) => this.elements.set(element.id, element)), { actorId: "system", action: "seed" });
	}
	private applyMutation(operation: CanvasMutation, actorLabel: string): string[] {
		const changed = new Set<string>();
		this.document.transact(() => {
			if (operation.action === "create") {
				for (const element of operation.elements) {
					if (this.elements.size >= MAX_CANVAS_ELEMENTS || this.elements.has(element.id)) continue;
					this.elements.set(element.id, { ...element, version: Number(element.version) || 1, updated: Date.now(), isDeleted: false });
					changed.add(element.id);
				}
			}
			if (operation.action === "update") {
				for (const { id, patch } of operation.patches) {
					const current = this.elements.get(id);
					if (!current) continue;
					const { id: _id, type: _type, ...safePatch } = patch;
					const next = canvasElement({ ...current, ...safePatch, id, type: current.type, version: (Number(current.version) || 0) + 1, updated: Date.now() });
					if (next) { this.elements.set(id, next); changed.add(id); }
				}
			}
			if (operation.action === "delete") for (const id of operation.ids) {
				if (!this.elements.has(id)) continue;
				this.elements.delete(id);
				changed.add(id);
			}
		}, { actorId: actorLabel, action: operation.action });
		return [...changed];
	}
	private recordCanvasChange(event: Y.YMapEvent<CanvasElement>): void {
		if (event.keys.size === 0) return;
		const origin = event.transaction.origin as { actorId?: unknown; action?: unknown } | undefined;
		const actor = typeof origin?.actorId === "string" ? origin.actorId.slice(0, 80) : "human";
		const action = typeof origin?.action === "string" ? origin.action.slice(0, 30) : "human_edit";
		const elementIds = [...event.keys.keys()];
		const nextRevision = this.revision + 1;
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("INSERT INTO canvas_changes (revision, actor, action, element_ids_json, created_at) VALUES (?, ?, ?, ?, ?)", nextRevision, actor, action, JSON.stringify(elementIds), Date.now());
			this.ctx.storage.sql.exec("INSERT INTO canvas_state (id, revision) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision", nextRevision);
			this.ctx.storage.sql.exec("INSERT INTO canvas_snapshots (id, snapshot_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json", snapshotJson(this.document));
		});
		this.revision = nextRevision;
	}
	private sceneElements(): CanvasElement[] { return [...this.elements.values()].map((element) => JSON.parse(JSON.stringify(element)) as CanvasElement); }
	private receipt(sessionId: string): { revision: number } | undefined { return Array.from(this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM canvas_read_receipts WHERE session_id = ?", sessionId))[0]; }
	private changesSince(revision: number): Array<Record<string, unknown>> {
		return Array.from(this.ctx.storage.sql.exec<{ revision: number; actor: string; action: string; elementIdsJson: string; createdAt: number }>("SELECT revision, actor, action, element_ids_json as elementIdsJson, created_at as createdAt FROM canvas_changes WHERE revision > ? ORDER BY revision ASC LIMIT ?", revision, MAX_DELIVERED_CHANGES + 1)).map((change) => ({ ...change, elementIds: JSON.parse(change.elementIdsJson), elementIdsJson: undefined }));
	}
	private recordRead(sessionId: string): void { this.ctx.storage.sql.exec("INSERT INTO canvas_read_receipts (session_id, revision, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at", sessionId, this.revision, Date.now()); }
	private storeOperation(operationId: string, result: OperationResult): OperationResult { this.ctx.storage.sql.exec("INSERT INTO canvas_operations (operation_id, result_json, created_at) VALUES (?, ?, ?)", operationId, JSON.stringify(result), Date.now()); return result; }
	private persistSnapshot(): void { this.ctx.storage.sql.exec("INSERT INTO canvas_snapshots (id, snapshot_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json", snapshotJson(this.document)); }
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
	try { const body = await request.json(); return body && typeof body === "object" ? body as Record<string, unknown> : null; } catch { return null; }
}
function json(result: unknown, status = 200): Response { return Response.json(result, { status, headers: { "Cache-Control": "no-store" } }); }
function isCurrentDocumentRoomRequest(url: URL): boolean {
	const parts = url.pathname.split("/");
	return parts.length === 4 && parts[1] === "parties" && parts[2].toLowerCase() === "document-room" && parts[3] === todayRoomName();
}
function isCurrentCanvasRoomRequest(url: URL): boolean {
	const parts = url.pathname.split("/");
	return parts.length === 4 && parts[1] === "parties" && parts[2].toLowerCase() === "canvas-room" && parts[3] === todayCanvasRoomName();
}
async function verifyRestoreToken(env: Env, token: unknown, request: Request, intentId: string): Promise<OperationResult> {
	if (typeof token !== "string" || token.length === 0 || token.length > 2_048) return { status: "turnstile_failed", message: "A valid confirmation token is required." };
	try {
		const response = await env.TURNSTILE_VERIFY.fetch("https://turnstile-siteverify/siteverify", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, remoteip: request.headers.get("CF-Connecting-IP") ?? undefined, idempotency_key: intentId }),
		});
		const result = await response.json() as { success?: unknown; hostname?: unknown; action?: unknown };
		if (result.success === true && typeof result.hostname === "string" && ALLOWED_TURNSTILE_HOSTNAMES.has(result.hostname) && result.action === TURNSTILE_ACTION) return { status: "ok" };
	} catch { /* Treat verification outages as a failed confirmation without exposing service internals. */ }
	return { status: "turnstile_failed", message: "Confirmation could not be verified. Please try the challenge again." };
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/parties/")) {
			// Do this before PartyServer resolves a Durable Object: otherwise a
			// public visitor can create arbitrary named rooms just by opening a URL.
			if (!isCurrentDocumentRoomRequest(url) && !isCurrentCanvasRoomRequest(url)) return new Response("Room not found", { status: 404 });
			const partyResponse = await routePartykitRequest(request, env);
			if (partyResponse) return partyResponse;
		}
		if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
		if (url.pathname.startsWith("/api/canvas/")) {
			const canvas = await getServerByName<Env, CanvasRoom>(env.CANVAS_ROOM, todayCanvasRoomName());
			if (url.pathname === "/api/canvas/status" && request.method === "GET") return json(await canvas.status());
			if (url.pathname === "/api/canvas/revisions" && request.method === "GET") return json(await canvas.listRevisions());
			if (request.method !== "POST") return json({ status: "method_not_allowed" }, 405);
			const body = await jsonBody(request);
			if (!body) return json({ status: "invalid_json" }, 400);
			if (url.pathname === "/api/canvas/read") return json(await canvas.readForSession(String(body.sessionId ?? "")));
			if (url.pathname === "/api/canvas/mutate") {
				const mutation = canvasMutation(body.mutation);
				return mutation ? json(await canvas.mutateForSession(String(body.sessionId ?? ""), mutation, String(body.operationId ?? ""), typeof body.actorLabel === "string" ? body.actorLabel.slice(0, 80) : "agent")) : json({ status: "invalid_mutation" }, 400);
			}
			return json({ status: "not_found" }, 404);
		}
		const room = await getServerByName<Env, DocumentRoom>(env.DOCUMENT_ROOM, todayRoomName());
		if (url.pathname === "/api/status" && request.method === "GET") return json(await room.status());
		if (url.pathname === "/api/config" && request.method === "GET") return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, turnstileAction: TURNSTILE_ACTION });
		if (url.pathname === "/api/revisions" && request.method === "GET") return json(await room.listRevisions(asOptionalQuery(url.searchParams.get("query")), asRevision(url.searchParams.get("beforeRevision"))));
		const revisionMatch = url.pathname.match(/^\/api\/revisions\/(\d+)$/);
		if (revisionMatch && request.method === "GET") return json(await room.readRevision(Number(revisionMatch[1])));
		if (request.method !== "POST") return json({ status: "method_not_allowed" }, 405);
		const body = await jsonBody(request);
		if (!body) return json({ status: "invalid_json" }, 400);
		if (url.pathname === "/api/agent/read") return json(await room.readForSession(String(body.sessionId ?? "")));
		if (url.pathname === "/api/agent/edit") {
			const replacements = Array.isArray(body.replacements) ? body.replacements.map(asReplacement).filter((item): item is Replacement => item !== null) : [];
			return json(await room.editForSession(String(body.sessionId ?? ""), replacements, String(body.operationId ?? ""), typeof body.actorLabel === "string" ? body.actorLabel.slice(0, 80) : "agent"));
		}
		if (url.pathname === "/api/revisions/restore-intents") {
			const revision = asRevision(body.revision);
			return revision === null ? json({ status: "invalid_revision" }, 400) : json(await room.createRestoreIntent(revision, typeof body.requester === "string" ? body.requester : "human"));
		}
		if (url.pathname === "/api/revisions/restore-cancel") {
			const intentId = safeId(body.intentId);
			return intentId ? json(await room.cancelRestoreIntent(intentId)) : json({ status: "invalid_intent" }, 400);
		}
		if (url.pathname === "/api/revisions/restore-confirm") {
			const intentId = safeId(body.intentId);
			if (!intentId) return json({ status: "invalid_intent" }, 400);
			const lookup = await room.getRestoreIntent(intentId) as unknown as RestoreIntentLookup;
			if (lookup.status !== "ok") return json(lookup);
			const intentStatus = lookup.intent.status;
			if (intentStatus === "completed") return json(await room.confirmRestore(intentId));
			if (intentStatus !== "pending") return json({ status: intentStatus });
			const verified = await verifyRestoreToken(env, body.turnstileToken, request, intentId);
			if (verified.status !== "ok") return json(verified);
			return json(await room.confirmRestore(intentId));
		}
		return json({ status: "not_found" }, 404);
	},
} satisfies ExportedHandler<Env>;
