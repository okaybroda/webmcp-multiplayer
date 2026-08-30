import { getServerByName, routePartykitRequest, type Connection } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

const MAX_DELIVERED_CHANGES = 20;
const MAX_REPLACEMENTS = 12;
const MAX_DOCUMENT_LENGTH = 100_000;
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
	revision: number;
	actor: string;
	startLine: number;
	endLine: number;
	oldText: string;
	newText: string;
	truncated: boolean;
	createdAt: number;
};
type StoredChange = Omit<ChangeRecord, "truncated"> & { truncated: number };
type OperationResult = Record<string, unknown>;

function todayRoomName(now = new Date()): string {
	return `contract-demo-${now.toISOString().slice(0, 10)}`;
}

function safeId(value: unknown): string | null {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{16,160}$/.test(value) ? value : null;
}

function asReplacement(value: unknown): Replacement | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<Replacement>;
	const { startLine, endLine, expectedText, text } = candidate;
	if (
		!Number.isInteger(startLine) ||
		!Number.isInteger(endLine) ||
		startLine! < 1 ||
		endLine! < startLine! ||
		typeof expectedText !== "string" ||
		expectedText.length > 10_000 ||
		typeof text !== "string" ||
		text.length > 10_000
	) return null;
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
	const resolved = replacements
		.map((replacement) => ({ replacement, range: lineRange(text, replacement.startLine, replacement.endLine) }))
		.sort((left, right) => (right.range?.[0] ?? 0) - (left.range?.[0] ?? 0));
	if (resolved.some((item) => item.range === null)) return { status: "invalid_replacements" };
	if (resolved.some((item) => {
		const [start, end] = item.range!;
		return text.slice(start, end) !== item.replacement.expectedText;
	})) return { status: "target_changed" };
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
	while (previousSuffix > prefix && nextSuffix > prefix && previous[previousSuffix - 1] === next[nextSuffix - 1]) {
		previousSuffix -= 1;
		nextSuffix -= 1;
	}
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
	return {
		revision, actor, startLine, endLine,
		oldText: truncated ? oldText.slice(0, 1_600) : oldText,
		newText: truncated ? newText.slice(0, 1_600) : newText,
		truncated, createdAt,
	};
}

function originActor(origin: unknown): string {
	if (origin && typeof origin === "object" && "state" in origin) {
		const state = (origin as { state?: unknown }).state;
		if (state && typeof state === "object" && typeof (state as { actorId?: unknown }).actorId === "string") {
			return (state as { actorId: string }).actorId;
		}
	}
	if (origin && typeof origin === "object" && typeof (origin as { actorId?: unknown }).actorId === "string") {
		return (origin as { actorId: string }).actorId;
	}
	return "human";
}

export class DocumentRoom extends YServer {
	private revision = 0;
	private lastText = "";

	async onLoad(): Promise<void> {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS changes (revision INTEGER PRIMARY KEY, actor TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, old_text TEXT NOT NULL, new_text TEXT NOT NULL, truncated INTEGER NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS read_receipts (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
		`);
		const row = Array.from(this.ctx.storage.sql.exec<{ revision: number; snapshotJson: string }>("SELECT revision, snapshot_json as snapshotJson FROM room_state WHERE id = 1"))[0];
		if (row) {
			this.revision = row.revision;
			Y.applyUpdate(this.document, new Uint8Array(JSON.parse(row.snapshotJson)));
		} else {
			this.document.getText("content").insert(0, INITIAL_DOCUMENT);
			this.persistSnapshot();
		}
		const text = this.document.getText("content");
		this.lastText = text.toString();
		text.observe((event) => this.recordTextChange(event.transaction.origin));
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
			const rows = Array.from(this.ctx.storage.sql.exec<StoredChange>(`SELECT revision, actor, start_line as startLine, end_line as endLine, old_text as oldText, new_text as newText, truncated, created_at as createdAt FROM changes WHERE revision > ? ORDER BY revision ASC LIMIT ?`, receipt.revision, MAX_DELIVERED_CHANGES + 1));
			if (rows.length > MAX_DELIVERED_CHANGES) return this.storeOperation(operationId, { status: "reread_required", currentRevision: this.revision, message: "More than 20 changes arrived since this agent last read the document." });
			this.recordRead(sessionId);
			return this.storeOperation(operationId, { status: "changes_since_read", currentRevision: this.revision, changes: rows.map((row) => ({ ...row, truncated: Boolean(row.truncated) })), message: "Reconcile these delivered changes, then retry the edit." });
		}
		const current = this.document.getText("content").toString();
		const application = applyReplacements(current, replacements);
		if (application.status === "target_changed") return this.storeOperation(operationId, { status: "target_changed", currentRevision: this.revision, message: "The text at one or more edit targets changed. Read the document again before retrying." });
		if (application.status !== "applied") return this.storeOperation(operationId, { status: "invalid_replacements" });
		if (application.content !== current) {
			const text = this.document.getText("content");
			this.document.transact(() => { text.delete(0, current.length); text.insert(0, application.content); }, { actorId: actorLabel });
		}
		this.recordRead(sessionId);
		return this.storeOperation(operationId, { status: "applied", revision: this.revision });
	}

	async status(): Promise<OperationResult> {
		return { room: this.name, revision: this.revision, content: this.document.getText("content").toString(), active: this.name === todayRoomName() };
	}

	private recordTextChange(origin: unknown): void {
		const next = this.document.getText("content").toString();
		if (next === this.lastText) return;
		const record = makeChangeRecord(this.revision + 1, originActor(origin), this.lastText, next, Date.now());
		this.revision = record.revision;
		this.ctx.storage.sql.exec("INSERT INTO changes (revision, actor, start_line, end_line, old_text, new_text, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", record.revision, record.actor, record.startLine, record.endLine, record.oldText, record.newText, record.truncated ? 1 : 0, record.createdAt);
		this.lastText = next;
		this.persistSnapshot();
	}

	private recordRead(sessionId: string): void {
		this.ctx.storage.sql.exec("INSERT INTO read_receipts (session_id, revision, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at", sessionId, this.revision, Date.now());
	}

	private storeOperation(operationId: string, result: OperationResult): OperationResult {
		this.ctx.storage.sql.exec("INSERT INTO operations (operation_id, result_json, created_at) VALUES (?, ?, ?)", operationId, JSON.stringify(result), Date.now());
		return result;
	}

	private persistSnapshot(): void {
		const snapshot = JSON.stringify(Array.from(Y.encodeStateAsUpdate(this.document)));
		this.ctx.storage.sql.exec("INSERT INTO room_state (id, revision, snapshot_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, snapshot_json = excluded.snapshot_json", this.revision, snapshot);
	}
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
	try { const body = await request.json(); return body && typeof body === "object" ? body as Record<string, unknown> : null; } catch { return null; }
}
function json(result: unknown, status = 200): Response { return Response.json(result, { status, headers: { "Cache-Control": "no-store" } }); }

export default {
	async fetch(request, env): Promise<Response> {
		const partyResponse = await routePartykitRequest(request, env);
		if (partyResponse) return partyResponse;
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
		const room = await getServerByName<Env, DocumentRoom>(env.DOCUMENT_ROOM, todayRoomName());
		if (url.pathname === "/api/status" && request.method === "GET") return json(await room.status());
		if (request.method !== "POST") return json({ status: "method_not_allowed" }, 405);
		const body = await jsonBody(request);
		if (!body) return json({ status: "invalid_json" }, 400);
		if (url.pathname === "/api/agent/read") return json(await room.readForSession(String(body.sessionId ?? "")));
		if (url.pathname === "/api/agent/edit") {
			const replacements = Array.isArray(body.replacements) ? body.replacements.map(asReplacement).filter((item): item is Replacement => item !== null) : [];
			return json(await room.editForSession(String(body.sessionId ?? ""), replacements, String(body.operationId ?? ""), typeof body.actorLabel === "string" ? body.actorLabel.slice(0, 80) : "agent"));
		}
		return json({ status: "not_found" }, 404);
	},
} satisfies ExportedHandler<Env>;
