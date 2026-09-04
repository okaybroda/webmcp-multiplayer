import { getServerByName, routePartykitRequest, type Connection, type WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

const MAX_DELIVERED_CHANGES = 20;
const MAX_REPLACEMENTS = 12;
const MAX_DOCUMENT_LENGTH = 100_000;
const HISTORY_PAGE_SIZE = 10;
const MAX_HISTORY_QUERY_LENGTH = 200;
const MAX_CANVAS_ELEMENTS = 400;
const MAX_CANVAS_ELEMENT_BYTES = 60_000;
const MAX_CANVAS_PATCH_BYTES = 16_000;
const MAX_CANVAS_SCENE_BYTES = 256_000;
const MAX_JSON_BODY_BYTES = 256_000;
const MAX_WEBSOCKET_MESSAGE_BYTES = 64_000;
const RATE_WINDOW_MS = 60_000;
const MAX_HTTP_REQUESTS_PER_CLIENT_WINDOW = 120;
const MAX_WEBSOCKET_CONNECTION_ATTEMPTS_PER_CLIENT_WINDOW = 12;
const MAX_CONCURRENT_WEBSOCKETS = 40;
const MAX_CONCURRENT_WEBSOCKETS_PER_CLIENT = 4;
const MAX_WEBSOCKET_MESSAGES_PER_CONNECTION_WINDOW = 120;
const MAX_WEBSOCKET_BYTES_PER_CONNECTION_WINDOW = 1_000_000;
const MAX_WEBSOCKET_MESSAGES_PER_ROOM_WINDOW = 1_200;
const MAX_WEBSOCKET_BYTES_PER_ROOM_WINDOW = 8_000_000;
const ACTIVITY_RETENTION_MS = 6 * 60 * 60 * 1_000;
const EXPIRED_ROOM_RETENTION_MS = 48 * 60 * 60 * 1_000;
const MAX_RETAINED_REVISIONS = 100;
const MAX_RETAINED_OPERATIONS = 500;
const TURNSTILE_ACTION = "turnstile-spin-v1";
const PRODUCTION_HOSTNAME = "webmcp-demo.rakanlabs.com";
const CANVAS_ELEMENT_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow", "line", "text"]);
const CANVAS_COMMON_FIELDS = new Set([
	"id", "type", "x", "y", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roundness", "roughness", "opacity", "width", "height", "angle", "seed", "version", "versionNonce", "index", "isDeleted", "groupIds", "frameId", "boundElements", "updated", "link", "locked",
]);
const CANVAS_TYPE_FIELDS: Record<string, ReadonlySet<string>> = {
	rectangle: new Set(), ellipse: new Set(), diamond: new Set(),
	text: new Set(["fontSize", "fontFamily", "text", "textAlign", "verticalAlign", "containerId", "originalText", "autoResize", "lineHeight"]),
	line: new Set(["points", "lastCommittedPoint", "startBinding", "endBinding", "startArrowhead", "endArrowhead"]),
	arrow: new Set(["points", "lastCommittedPoint", "startBinding", "endBinding", "startArrowhead", "endArrowhead", "elbowed", "fixedSegments", "startIsSpecial", "endIsSpecial"]),
};
const CANVAS_PATCH_FIELDS = new Set([...CANVAS_COMMON_FIELDS, ...Object.values(CANVAS_TYPE_FIELDS).flatMap((fields) => [...fields])]);
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
type RateLimitRow = { windowStart: number; count: number };
type SocketState = { actorId: string; clientKey: string; windowStart: number; messageCount: number; byteCount: number };

function todayRoomName(now = new Date()): string { return `contract-demo-${now.toISOString().slice(0, 10)}`; }
function todayCanvasRoomName(now = new Date()): string { return `canvas-demo-${now.toISOString().slice(0, 10)}`; }
function safeId(value: unknown): string | null { return typeof value === "string" && /^[a-zA-Z0-9_-]{16,160}$/.test(value) ? value : null; }
function asRevision(value: unknown): number | null {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function asOptionalQuery(value: string | null): string { return (value ?? "").trim().slice(0, MAX_HISTORY_QUERY_LENGTH); }
function snapshotJson(document: Y.Doc): string { return JSON.stringify(Array.from(Y.encodeStateAsUpdate(document))); }
function sameOrigin(request: Request, environment: string): boolean {
	const origin = request.headers.get("Origin");
	if (origin === `https://${PRODUCTION_HOSTNAME}`) return true;
	if (environment !== "development") return false;
	// Wrangler rewrites localhost traffic to the configured custom-domain host.
	if (origin === "http://webmcp-demo.rakanlabs.com") return true;
	if (origin === null) return false;
	try {
		const localOrigin = new URL(origin);
		return (localOrigin.protocol === "http:" || localOrigin.protocol === "https:")
			&& (localOrigin.hostname === "localhost" || localOrigin.hostname === "127.0.0.1");
	} catch { return false; }
}
function allowedTurnstileHostname(hostname: string, environment: string): boolean {
	return hostname === PRODUCTION_HOSTNAME
		|| (environment === "development" && (hostname === "localhost" || hostname === "127.0.0.1"));
}
function messageSize(message: WSMessage): number { return typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength; }
function allowWebSocketMessage(connection: Connection, message: WSMessage): boolean {
	const now = Date.now();
	const bytes = messageSize(message);
	const state = connection.state as SocketState | null;
	if (!state || state.windowStart <= now - RATE_WINDOW_MS) {
		connection.setState({ actorId: state?.actorId ?? "viewer", clientKey: state?.clientKey ?? "unknown", windowStart: now, messageCount: 1, byteCount: bytes });
		return bytes <= MAX_WEBSOCKET_BYTES_PER_CONNECTION_WINDOW;
	}
	if (state.messageCount >= MAX_WEBSOCKET_MESSAGES_PER_CONNECTION_WINDOW || state.byteCount + bytes > MAX_WEBSOCKET_BYTES_PER_CONNECTION_WINDOW) return false;
	connection.setState({ ...state, messageCount: state.messageCount + 1, byteCount: state.byteCount + bytes });
	return true;
}

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
function finiteNumber(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }
function boundedInteger(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum; }
function canvasPoint(value: unknown): boolean { return Array.isArray(value) && value.length === 2 && value.every((coordinate) => finiteNumber(coordinate, -1_000_000, 1_000_000)); }
function canvasBinding(value: unknown): boolean {
	if (value === null) return true;
	if (!isRecord(value) || Object.keys(value).some((key) => !["elementId", "focus", "gap", "fixedPoint"].includes(key))) return false;
	return safeId(value.elementId) !== null && finiteNumber(value.focus, -1, 1) && finiteNumber(value.gap, 0, 1_000_000) && (value.fixedPoint === undefined || canvasPoint(value.fixedPoint));
}
function canvasRoundness(value: unknown): boolean {
	if (value === null) return true;
	return isRecord(value) && Object.keys(value).every((key) => key === "type" || key === "value")
		&& boundedInteger(value.type, 1, 3) && (value.value === undefined || finiteNumber(value.value, 0, 1_000_000));
}
function canvasBoundElements(value: unknown): boolean {
	return value === null || (Array.isArray(value) && value.length <= 20 && value.every((item) => isRecord(item)
		&& Object.keys(item).length === 2 && safeId(item.id) !== null && (item.type === "arrow" || item.type === "text")));
}
function canvasFixedSegments(value: unknown): boolean {
	return value === null || (Array.isArray(value) && value.length <= 200 && value.every((segment) => isRecord(segment)
		&& Object.keys(segment).every((key) => key === "start" || key === "end" || key === "index")
		&& canvasPoint(segment.start) && canvasPoint(segment.end) && boundedInteger(segment.index, 0, 200)));
}
function safeCanvasLink(value: unknown): boolean {
	if (value === null) return true;
	if (typeof value !== "string" || value.length > 2_048) return false;
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
	} catch { return false; }
}
function validCanvasField(key: string, value: unknown): boolean {
	switch (key) {
		case "id": return safeId(value) !== null;
		case "type": return typeof value === "string" && CANVAS_ELEMENT_TYPES.has(value);
		case "x": case "y": return finiteNumber(value, -1_000_000, 1_000_000);
		case "width": case "height": return finiteNumber(value, 0, 1_000_000);
		case "angle": return finiteNumber(value, -100, 100);
		case "strokeColor": case "backgroundColor": return typeof value === "string" && (/^#[0-9a-fA-F]{3,8}$/.test(value) || value === "transparent");
		case "fillStyle": return value === "hachure" || value === "cross-hatch" || value === "solid" || value === "zigzag";
		case "strokeWidth": return finiteNumber(value, 0, 20);
		case "strokeStyle": return value === "solid" || value === "dashed" || value === "dotted";
		case "roundness": return canvasRoundness(value);
		case "roughness": return boundedInteger(value, 0, 2);
		case "opacity": return boundedInteger(value, 0, 100);
		case "seed": case "version": case "versionNonce": return boundedInteger(value, 0, 2_147_483_647);
		case "index": return value === null || (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value));
		case "isDeleted": return value === false;
		case "groupIds": return Array.isArray(value) && value.length <= 10 && value.every((id) => safeId(id) !== null);
		case "frameId": return value === null;
		case "boundElements": return canvasBoundElements(value);
		case "updated": return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
		case "link": return safeCanvasLink(value);
		case "locked": case "autoResize": case "elbowed": return typeof value === "boolean";
		case "text": case "originalText": return typeof value === "string" && value.length <= 10_000;
		case "fontSize": return finiteNumber(value, 1, 512);
		case "fontFamily": return typeof value === "number" && [1, 2, 3, 5, 6, 7, 8, 9].includes(value);
		case "textAlign": return value === "left" || value === "center" || value === "right";
		case "verticalAlign": return value === "top" || value === "middle" || value === "bottom";
		case "containerId": return value === null || safeId(value) !== null;
		case "lineHeight": return finiteNumber(value, 0.5, 5);
		case "points": return Array.isArray(value) && value.length >= 2 && value.length <= 200 && value.every(canvasPoint);
		case "lastCommittedPoint": return value === null || canvasPoint(value);
		case "startBinding": case "endBinding": return canvasBinding(value);
		case "startArrowhead": case "endArrowhead": return value === null || (typeof value === "string" && ["arrow", "bar", "dot", "circle", "circle_outline", "triangle", "triangle_outline", "diamond", "diamond_outline", "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many"].includes(value));
		case "fixedSegments": return canvasFixedSegments(value);
		case "startIsSpecial": case "endIsSpecial": return value === null || typeof value === "boolean";
		default: return false;
	}
}
function canvasElement(value: unknown): CanvasElement | null {
	if (!isRecord(value) || !safeId(value.id) || typeof value.type !== "string" || !CANVAS_ELEMENT_TYPES.has(value.type)) return null;
	const allowedFields = new Set([...CANVAS_COMMON_FIELDS, ...CANVAS_TYPE_FIELDS[value.type]]);
	if (Object.keys(value).some((key) => !allowedFields.has(key) || !validCanvasField(key, value[key]))) return null;
	if (!["x", "y", "width", "height"].every((key) => Object.hasOwn(value, key))) return null;
	if (value.type === "text" && !["text", "originalText", "fontSize", "fontFamily", "lineHeight"].every((key) => Object.hasOwn(value, key))) return null;
	if ((value.type === "line" || value.type === "arrow") && !Object.hasOwn(value, "points")) return null;
	try {
		const copy = JSON.parse(JSON.stringify(value)) as CanvasElement;
		return new TextEncoder().encode(JSON.stringify(copy)).byteLength <= MAX_CANVAS_ELEMENT_BYTES ? copy : null;
	} catch { return null; }
}
function canvasPatch(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => key === "id" || key === "type" || !CANVAS_PATCH_FIELDS.has(key) || !validCanvasField(key, value[key]))) return null;
	try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_CANVAS_PATCH_BYTES ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : null; } catch { return null; }
}
function canvasScene(value: unknown): CanvasElement[] | null {
	if (!Array.isArray(value) || value.length > MAX_CANVAS_ELEMENTS) return null;
	const elements = value.map(canvasElement);
	if (!elements.every((element): element is CanvasElement => element !== null) || new Set(elements.map((element) => element.id)).size !== elements.length) return null;
	try { return new TextEncoder().encode(JSON.stringify(elements)).byteLength <= MAX_CANVAS_SCENE_BYTES ? elements : null; } catch { return null; }
}
function canvasMutation(value: unknown): CanvasMutation | null {
	if (!isRecord(value) || typeof value.action !== "string") return null;
	if (value.action === "create" && Array.isArray(value.elements)) {
		const elements = value.elements.map(canvasElement);
		return elements.every((element): element is CanvasElement => element !== null) && elements.length > 0 && elements.length <= 40 ? { action: "create", elements } : null;
	}
	if (value.action === "update" && Array.isArray(value.patches)) {
		const patches = value.patches.map((item) => {
			if (!isRecord(item) || !safeId(item.id)) return null;
			const patch = canvasPatch(item.patch);
			return patch ? { id: item.id, patch } : null;
		});
		return patches.every((patch): patch is { id: string; patch: Record<string, unknown> } => patch !== null) && patches.length > 0 && patches.length <= 40 ? { action: "update", patches } : null;
	}
	if (value.action === "delete" && Array.isArray(value.ids)) {
		const ids = value.ids.filter((id): id is string => safeId(id) !== null);
		return ids.length === value.ids.length && ids.length > 0 && ids.length <= 40 ? { action: "delete", ids } : null;
	}
	return null;
}
function websocketMessageType(message: WSMessage): number | null {
	if (typeof message === "string") return null;
	const bytes = message instanceof Uint8Array
		? message
		: message instanceof ArrayBuffer
			? new Uint8Array(message)
			: new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
	return bytes.byteLength > 0 ? bytes[0] : null;
}
function connectionClientKey(connection: Connection): string { return (connection.state as SocketState | null)?.clientKey ?? "unknown"; }
function requestClientKey(request: Request): string { const value = request.headers.get("X-WebMCP-Client-Key"); return value && /^[0-9a-f]{32}$/.test(value) ? value : "unknown"; }
async function anonymousClientKey(request: Request): Promise<string> {
	const url = new URL(request.url);
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	const source = local ? `local:${url.origin}` : `cf:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
	return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function roomExpiryAt(name: string, prefix: string): number {
	const match = name.match(new RegExp(`^${prefix}(\\d{4}-\\d{2}-\\d{2})$`));
	if (!match) return Date.now() + EXPIRED_ROOM_RETENTION_MS;
	const start = Date.parse(`${match[1]}T00:00:00.000Z`);
	return Number.isFinite(start) ? start + EXPIRED_ROOM_RETENTION_MS : Date.now() + EXPIRED_ROOM_RETENTION_MS;
}

export class DocumentRoom extends YServer {
	// PartyServer defaults to regular WebSockets, which pin a Durable Object in
	// memory for the lifetime of each connection. Hibernation keeps the sockets
	// connected while avoiding duration charges whenever the room is idle.
	static options = { hibernate: true };

	private revision = 0;
	private lastText = "";
	private started = false;

	async onStart(): Promise<void> {
		if (this.started) return;
		await super.onStart();
		this.started = true;
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
			CREATE TABLE IF NOT EXISTS request_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
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
		await this.ctx.storage.setAlarm(Math.max(Date.now() + 60_000, roomExpiryAt(this.name, "contract-demo-")));
	}
	async onSave(): Promise<void> { this.persistSnapshot(); }
	onConnect(connection: Connection, context: { request: Request }): void {
		const clientKey = requestClientKey(context.request);
		const connections = [...this.getConnections()];
		if (connections.length > MAX_CONCURRENT_WEBSOCKETS || connections.filter((candidate) => connectionClientKey(candidate) === clientKey).length >= MAX_CONCURRENT_WEBSOCKETS_PER_CLIENT) {
			connection.close(1008, "WebSocket connection limit exceeded");
			return;
		}
		connection.setState({ actorId: "viewer", clientKey, windowStart: Date.now(), messageCount: 0, byteCount: 0 });
		super.onConnect(connection, context);
	}
	isReadOnly(): boolean { return true; }
	onMessage(connection: Connection, message: WSMessage): void {
		if (messageSize(message) > MAX_WEBSOCKET_MESSAGE_BYTES) { connection.close(1009, "WebSocket message too large"); return; }
		if (!allowWebSocketMessage(connection, message)) { connection.close(1008, "WebSocket message rate exceeded"); return; }
		// This demo does not expose presence/cursor state. Only Yjs sync messages
		// are accepted, and isReadOnly() prevents clients from writing updates.
		if (websocketMessageType(message) !== 0) return;
		if (!this.consumeSocketBudget(messageSize(message))) { connection.close(1008, "Room WebSocket budget exceeded"); return; }
		super.onMessage(connection, message);
	}
	async allowHttpAction(clientKey: string): Promise<boolean> {
		if (!this.started) await this.onStart();
		return this.consumeRateLimit(`http:${clientKey}`, MAX_HTTP_REQUESTS_PER_CLIENT_WINDOW);
	}
	async allowWebSocketConnection(clientKey: string): Promise<boolean> {
		if (!this.started) await this.onStart();
		const connections = [...this.getConnections()];
		if (connections.length >= MAX_CONCURRENT_WEBSOCKETS || connections.filter((connection) => connectionClientKey(connection) === clientKey).length >= MAX_CONCURRENT_WEBSOCKETS_PER_CLIENT) return false;
		return this.consumeRateLimit(`ws-connect:${clientKey}`, MAX_WEBSOCKET_CONNECTION_ATTEMPTS_PER_CLIENT_WINDOW);
	}
	async onAlarm(): Promise<void> {
		if (Date.now() >= roomExpiryAt(this.name, "contract-demo-")) {
			for (const connection of this.getConnections()) connection.close(1008, "This demo room has expired.");
			await this.ctx.storage.deleteAll();
			return;
		}
		this.pruneActivity(Date.now());
		await this.ctx.storage.setAlarm(roomExpiryAt(this.name, "contract-demo-"));
	}

	async readForSession(sessionId: string): Promise<OperationResult> {
		if (!safeId(sessionId)) return { status: "invalid_session" };
		this.recordRead(sessionId);
		return { status: "ok", revision: this.revision, content: this.document.getText("content").toString() };
	}
	async changesSinceLastRead(sessionId: string): Promise<OperationResult> {
		if (!safeId(sessionId)) return { status: "invalid_session" };
		const receipt = Array.from(this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM read_receipts WHERE session_id = ?", sessionId))[0];
		if (!receipt) return { status: "read_required", message: "Call read_document before requesting changes." };
		if (receipt.revision === this.revision) { this.recordRead(sessionId); return { status: "up_to_date", revision: this.revision }; }
		const rows = Array.from(this.ctx.storage.sql.exec<StoredChange>("SELECT revision, actor, start_line as startLine, end_line as endLine, old_text as oldText, new_text as newText, truncated, created_at as createdAt FROM changes WHERE revision > ? ORDER BY revision ASC LIMIT ?", receipt.revision, MAX_DELIVERED_CHANGES + 1));
		if (rows.length > MAX_DELIVERED_CHANGES) return { status: "reread_required", currentRevision: this.revision, message: "More than 20 changes arrived. Call read_document for the current document." };
		if (rows.some((change) => Boolean(change.truncated))) return { status: "reread_required", currentRevision: this.revision, message: "A change was too large to summarize safely. Call read_document for the current document." };
		this.recordRead(sessionId);
		return { status: "changes_since_read", fromRevision: receipt.revision, currentRevision: this.revision, changes: rows.map((change) => ({ ...change, truncated: Boolean(change.truncated) })) };
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
			if (rows.length > MAX_DELIVERED_CHANGES) return this.storeOperation(operationId, { status: "reread_required", currentRevision: this.revision, message: "More than 20 changes arrived since this agent last read the document. Call read_document again." });
			if (rows.some((change) => Boolean(change.truncated))) return this.storeOperation(operationId, { status: "reread_required", currentRevision: this.revision, message: "A change was too large to summarize safely. Call read_document again." });
			return this.storeOperation(operationId, { status: "changes_available", currentRevision: this.revision, message: "The document changed since your last read. Call read_changes_since_last_read before retrying this edit." });
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
	async commitHumanDraft(baseText: string, nextText: string): Promise<OperationResult> {
		if (this.name !== todayRoomName()) return { status: "room_expired", rereadRequired: true };
		if (baseText.length > MAX_DOCUMENT_LENGTH || nextText.length > MAX_DOCUMENT_LENGTH) return { status: "invalid_document" };
		const current = this.document.getText("content").toString();
		if (current !== baseText) return { status: "stale", revision: this.revision, content: current };
		if (current === nextText) return { status: "no_change", revision: this.revision };
		const text = this.document.getText("content");
		this.document.transact(() => { text.delete(0, current.length); text.insert(0, nextText); }, { actorId: "human", kind: "edit" });
		return { status: "applied", revision: this.revision };
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
		this.pruneActivity(record.createdAt);
	}
	private recordRead(sessionId: string): void { const now = Date.now(); this.ctx.storage.sql.exec("INSERT INTO read_receipts (session_id, revision, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at", sessionId, this.revision, now); this.pruneActivity(now); }
	private storeOperation(operationId: string, result: OperationResult): OperationResult { const now = Date.now(); this.ctx.storage.sql.exec("INSERT INTO operations (operation_id, result_json, created_at) VALUES (?, ?, ?)", operationId, JSON.stringify(result), now); this.pruneActivity(now); return result; }
	private persistSnapshot(): void { this.ctx.storage.sql.exec("INSERT INTO room_state (id, revision, snapshot_json) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, snapshot_json = excluded.snapshot_json", this.revision, snapshotJson(this.document)); }
	private consumeRateLimit(kind: string, limit: number): boolean {
		const key = kind;
		const now = Date.now();
		const row = Array.from(this.ctx.storage.sql.exec<RateLimitRow>("SELECT window_start as windowStart, count FROM request_limits WHERE key = ?", key))[0];
		if (!row || row.windowStart <= now - RATE_WINDOW_MS) { this.ctx.storage.sql.exec("INSERT INTO request_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count", key, now); return true; }
		if (row.count >= limit) return false;
		this.ctx.storage.sql.exec("UPDATE request_limits SET count = count + 1 WHERE key = ?", key);
		return true;
	}
	private consumeSocketBudget(bytes: number): boolean {
		const now = Date.now();
		const messageRow = Array.from(this.ctx.storage.sql.exec<RateLimitRow>("SELECT window_start as windowStart, count FROM request_limits WHERE key = 'ws-room-messages'"))[0];
		const byteRow = Array.from(this.ctx.storage.sql.exec<RateLimitRow>("SELECT window_start as windowStart, count FROM request_limits WHERE key = 'ws-room-bytes'"))[0];
		const messages = !messageRow || messageRow.windowStart <= now - RATE_WINDOW_MS ? 0 : messageRow.count;
		const byteCount = !byteRow || byteRow.windowStart <= now - RATE_WINDOW_MS ? 0 : byteRow.count;
		if (messages >= MAX_WEBSOCKET_MESSAGES_PER_ROOM_WINDOW || byteCount + bytes > MAX_WEBSOCKET_BYTES_PER_ROOM_WINDOW) return false;
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("INSERT INTO request_limits (key, window_start, count) VALUES ('ws-room-messages', ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = ?, count = ?", messages === 0 ? now : messageRow!.windowStart, messages === 0 ? now : messageRow!.windowStart, messages + 1);
			this.ctx.storage.sql.exec("INSERT INTO request_limits (key, window_start, count) VALUES ('ws-room-bytes', ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = ?, count = ?", byteCount === 0 ? now : byteRow!.windowStart, bytes, byteCount === 0 ? now : byteRow!.windowStart, byteCount + bytes);
		});
		return true;
	}
	private pruneActivity(now: number): void {
		const oldest = Math.max(0, this.revision - MAX_RETAINED_REVISIONS);
		this.ctx.storage.sql.exec("DELETE FROM read_receipts WHERE updated_at < ?", now - ACTIVITY_RETENTION_MS);
		this.ctx.storage.sql.exec("DELETE FROM operations WHERE created_at < ?", now - ACTIVITY_RETENTION_MS);
		this.ctx.storage.sql.exec("DELETE FROM operations WHERE operation_id NOT IN (SELECT operation_id FROM operations ORDER BY created_at DESC LIMIT ?)", MAX_RETAINED_OPERATIONS);
		this.ctx.storage.sql.exec("DELETE FROM restore_intents WHERE created_at < ?", now - ACTIVITY_RETENTION_MS);
		this.ctx.storage.sql.exec("DELETE FROM changes WHERE revision < ?", oldest);
		this.ctx.storage.sql.exec("DELETE FROM revision_snapshots WHERE revision < ?", oldest);
		this.ctx.storage.sql.exec("DELETE FROM request_limits WHERE window_start < ?", now - RATE_WINDOW_MS * 2);
	}
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
			CREATE TABLE IF NOT EXISTS request_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
		`);
		this.revision = Array.from(this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM canvas_state WHERE id = 1"))[0]?.revision ?? 0;
		const snapshot = Array.from(this.ctx.storage.sql.exec<{ snapshotJson: string }>("SELECT snapshot_json as snapshotJson FROM canvas_snapshots WHERE id = 1"))[0];
		if (snapshot) Y.applyUpdate(this.document, new Uint8Array(JSON.parse(snapshot.snapshotJson)));
		this.elements = this.document.getMap<CanvasElement>("elements");
		let sanitizedLegacyContent = false;
		this.document.transact(() => {
			for (const [id, element] of this.elements) {
				const safeElement = canvasElement(element);
				if (!safeElement) { this.elements.delete(id); sanitizedLegacyContent = true; continue; }
				if (JSON.stringify(safeElement) !== JSON.stringify(element)) { this.elements.set(id, safeElement); sanitizedLegacyContent = true; }
			}
		}, { actorId: "system", action: "security_sanitize" });
		if (this.elements.size === 0) { this.seedCanvas(); sanitizedLegacyContent = true; }
		if (sanitizedLegacyContent) this.persistSnapshot();
		this.elements.observe((event) => this.recordCanvasChange(event));
		this.loaded = true;
		await this.ctx.storage.setAlarm(Math.max(Date.now() + 60_000, roomExpiryAt(this.name, "canvas-demo-")));
	}
	onConnect(connection: Connection, context: { request: Request }): void {
		const clientKey = requestClientKey(context.request);
		const connections = [...this.getConnections()];
		if (connections.length > MAX_CONCURRENT_WEBSOCKETS || connections.filter((candidate) => connectionClientKey(candidate) === clientKey).length >= MAX_CONCURRENT_WEBSOCKETS_PER_CLIENT) {
			connection.close(1008, "WebSocket connection limit exceeded");
			return;
		}
		connection.setState({ actorId: "viewer", clientKey, windowStart: Date.now(), messageCount: 0, byteCount: 0 });
		super.onConnect(connection, context);
	}
	isReadOnly(): boolean { return true; }
	onMessage(connection: Connection, message: WSMessage): void {
		if (messageSize(message) > MAX_WEBSOCKET_MESSAGE_BYTES) { connection.close(1009, "WebSocket message too large"); return; }
		if (!allowWebSocketMessage(connection, message)) { connection.close(1008, "WebSocket message rate exceeded"); return; }
		if (websocketMessageType(message) !== 0) return;
		if (!this.consumeSocketBudget(messageSize(message))) { connection.close(1008, "Room WebSocket budget exceeded"); return; }
		super.onMessage(connection, message);
	}
	async allowHttpAction(clientKey: string): Promise<boolean> {
		await this.ensureLoaded();
		return this.consumeRateLimit(`http:${clientKey}`, MAX_HTTP_REQUESTS_PER_CLIENT_WINDOW);
	}
	async allowWebSocketConnection(clientKey: string): Promise<boolean> {
		await this.ensureLoaded();
		const connections = [...this.getConnections()];
		if (connections.length >= MAX_CONCURRENT_WEBSOCKETS || connections.filter((connection) => connectionClientKey(connection) === clientKey).length >= MAX_CONCURRENT_WEBSOCKETS_PER_CLIENT) return false;
		return this.consumeRateLimit(`ws-connect:${clientKey}`, MAX_WEBSOCKET_CONNECTION_ATTEMPTS_PER_CLIENT_WINDOW);
	}
	async onAlarm(): Promise<void> {
		if (Date.now() >= roomExpiryAt(this.name, "canvas-demo-")) {
			for (const connection of this.getConnections()) connection.close(1008, "This demo canvas has expired.");
			await this.ctx.storage.deleteAll();
			return;
		}
		this.pruneActivity(Date.now());
		await this.ctx.storage.setAlarm(roomExpiryAt(this.name, "canvas-demo-"));
	}

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
		if (!receipt) return { status: "read_required", message: "Call read_canvas before making a change." };
		if (receipt.revision < this.revision) {
			const changes = this.changesSince(receipt.revision);
			return changes.length <= MAX_DELIVERED_CHANGES
				? { status: "changes_since_read", currentRevision: this.revision, changes, elements: this.sceneElements(), message: "The canvas changed since this agent last read it. Call read_canvas to record the refreshed scene before retrying." }
				: { status: "reread_required", currentRevision: this.revision, message: "More than 20 canvas changes arrived. Call read_canvas again before retrying." };
		}
		const applied = this.applyMutation(operation, actorLabel);
		if (applied.status !== "ok") return { status: "invalid_mutation" };
		this.recordRead(sessionId);
		return this.storeOperation(operationId, { status: applied.changedIds.length ? "applied" : "no_change", revision: this.revision, changedElementIds: applied.changedIds });
	}
	async commitHumanScene(expectedRevision: number, scene: CanvasElement[]): Promise<OperationResult> {
		await this.ensureLoaded();
		if (this.name !== todayCanvasRoomName()) return { status: "room_expired", rereadRequired: true };
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revision) return { status: "stale", currentRevision: this.revision, elements: this.sceneElements() };
		const elements = canvasScene(scene);
		if (!elements) return { status: "invalid_scene" };
		const next = new Map(elements.map((element) => [element.id, element]));
		const changed = new Set<string>();
		this.document.transact(() => {
			for (const id of [...this.elements.keys()]) if (!next.has(id)) { this.elements.delete(id); changed.add(id); }
			for (const [id, element] of next) {
				const current = this.elements.get(id);
				if (JSON.stringify(current) === JSON.stringify(element)) continue;
				this.elements.set(id, current ? { ...element, id, type: current.type, version: (Number(current.version) || 0) + 1, updated: Date.now() } : { ...element, version: Number(element.version) || 1, updated: Date.now(), isDeleted: false });
				changed.add(id);
			}
		}, { actorId: "human", action: "human_commit" });
		return { status: changed.size ? "applied" : "no_change", revision: this.revision, changedElementIds: [...changed] };
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
			{ id: "canvas-title-00001", type: "text", x: 120, y: 100, width: 430, height: 35, text: "Design a great first-run experience", fontSize: 28, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: null, originalText: "Design a great first-run experience", autoResize: true, lineHeight: 1.25, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, angle: 0, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false },
			{ id: "canvas-card-000001", type: "rectangle", x: 120, y: 180, width: 280, height: 150, strokeColor: "#4f46e5", backgroundColor: "#eef2ff", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, angle: 0, seed: 2, version: 1, versionNonce: 2, isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false },
			{ id: "canvas-note-000001", type: "text", x: 160, y: 225, width: 220, height: 100, text: "Human sketch\n\nInvite agents to add\noptions, flows, and copy.", fontSize: 20, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: null, originalText: "Human sketch\n\nInvite agents to add\noptions, flows, and copy.", autoResize: true, lineHeight: 1.25, strokeColor: "#312e81", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, angle: 0, seed: 3, version: 1, versionNonce: 3, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false },
		] as CanvasElement[];
		this.document.transact(() => seed.forEach((element) => this.elements.set(element.id, element)), { actorId: "system", action: "seed" });
	}
	private applyMutation(operation: CanvasMutation, actorLabel: string): { status: "ok"; changedIds: string[] } | { status: "invalid_mutation" } {
		const changed = new Set<string>();
		const preparedUpdates = new Map<string, CanvasElement>();
		if (operation.action === "update") {
			for (const { id, patch } of operation.patches) {
				const current = this.elements.get(id);
				if (!current) continue;
				const next = canvasElement({ ...current, ...patch, id, type: current.type, version: (Number(current.version) || 0) + 1, updated: Date.now() });
				if (!next) return { status: "invalid_mutation" };
				preparedUpdates.set(id, next);
			}
		}
		this.document.transact(() => {
			if (operation.action === "create") {
				for (const element of operation.elements) {
					if (this.elements.size >= MAX_CANVAS_ELEMENTS || this.elements.has(element.id)) continue;
					this.elements.set(element.id, { ...element, version: Number(element.version) || 1, updated: Date.now(), isDeleted: false });
					changed.add(element.id);
				}
			}
			if (operation.action === "update") {
				for (const [id, next] of preparedUpdates) {
					this.elements.set(id, next);
					changed.add(id);
				}
			}
			if (operation.action === "delete") for (const id of operation.ids) {
				if (!this.elements.has(id)) continue;
				this.elements.delete(id);
				changed.add(id);
			}
		}, { actorId: actorLabel, action: operation.action });
		return { status: "ok", changedIds: [...changed] };
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
		this.pruneActivity(Date.now());
	}
	private sceneElements(): CanvasElement[] { return [...this.elements.values()].map((element) => JSON.parse(JSON.stringify(element)) as CanvasElement); }
	private receipt(sessionId: string): { revision: number } | undefined { return Array.from(this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM canvas_read_receipts WHERE session_id = ?", sessionId))[0]; }
	private changesSince(revision: number): Array<Record<string, unknown>> {
		return Array.from(this.ctx.storage.sql.exec<{ revision: number; actor: string; action: string; elementIdsJson: string; createdAt: number }>("SELECT revision, actor, action, element_ids_json as elementIdsJson, created_at as createdAt FROM canvas_changes WHERE revision > ? ORDER BY revision ASC LIMIT ?", revision, MAX_DELIVERED_CHANGES + 1)).map((change) => ({ ...change, elementIds: JSON.parse(change.elementIdsJson), elementIdsJson: undefined }));
	}
	private recordRead(sessionId: string): void { const now = Date.now(); this.ctx.storage.sql.exec("INSERT INTO canvas_read_receipts (session_id, revision, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at", sessionId, this.revision, now); this.pruneActivity(now); }
	private storeOperation(operationId: string, result: OperationResult): OperationResult { const now = Date.now(); this.ctx.storage.sql.exec("INSERT INTO canvas_operations (operation_id, result_json, created_at) VALUES (?, ?, ?)", operationId, JSON.stringify(result), now); this.pruneActivity(now); return result; }
	private persistSnapshot(): void { this.ctx.storage.sql.exec("INSERT INTO canvas_snapshots (id, snapshot_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json", snapshotJson(this.document)); }
	private consumeRateLimit(kind: string, limit: number): boolean {
		const key = kind;
		const now = Date.now();
		const row = Array.from(this.ctx.storage.sql.exec<RateLimitRow>("SELECT window_start as windowStart, count FROM request_limits WHERE key = ?", key))[0];
		if (!row || row.windowStart <= now - RATE_WINDOW_MS) { this.ctx.storage.sql.exec("INSERT INTO request_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count", key, now); return true; }
		if (row.count >= limit) return false;
		this.ctx.storage.sql.exec("UPDATE request_limits SET count = count + 1 WHERE key = ?", key);
		return true;
	}
	private consumeSocketBudget(bytes: number): boolean {
		const now = Date.now();
		const messageRow = Array.from(this.ctx.storage.sql.exec<RateLimitRow>("SELECT window_start as windowStart, count FROM request_limits WHERE key = 'ws-room-messages'"))[0];
		const byteRow = Array.from(this.ctx.storage.sql.exec<RateLimitRow>("SELECT window_start as windowStart, count FROM request_limits WHERE key = 'ws-room-bytes'"))[0];
		const messages = !messageRow || messageRow.windowStart <= now - RATE_WINDOW_MS ? 0 : messageRow.count;
		const byteCount = !byteRow || byteRow.windowStart <= now - RATE_WINDOW_MS ? 0 : byteRow.count;
		if (messages >= MAX_WEBSOCKET_MESSAGES_PER_ROOM_WINDOW || byteCount + bytes > MAX_WEBSOCKET_BYTES_PER_ROOM_WINDOW) return false;
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("INSERT INTO request_limits (key, window_start, count) VALUES ('ws-room-messages', ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = ?, count = ?", messages === 0 ? now : messageRow!.windowStart, messages === 0 ? now : messageRow!.windowStart, messages + 1);
			this.ctx.storage.sql.exec("INSERT INTO request_limits (key, window_start, count) VALUES ('ws-room-bytes', ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = ?, count = ?", byteCount === 0 ? now : byteRow!.windowStart, bytes, byteCount === 0 ? now : byteRow!.windowStart, byteCount + bytes);
		});
		return true;
	}
	private pruneActivity(now: number): void {
		const oldest = Math.max(0, this.revision - MAX_RETAINED_REVISIONS);
		this.ctx.storage.sql.exec("DELETE FROM canvas_read_receipts WHERE updated_at < ?", now - ACTIVITY_RETENTION_MS);
		this.ctx.storage.sql.exec("DELETE FROM canvas_operations WHERE created_at < ?", now - ACTIVITY_RETENTION_MS);
		this.ctx.storage.sql.exec("DELETE FROM canvas_operations WHERE operation_id NOT IN (SELECT operation_id FROM canvas_operations ORDER BY created_at DESC LIMIT ?)", MAX_RETAINED_OPERATIONS);
		this.ctx.storage.sql.exec("DELETE FROM canvas_changes WHERE revision < ?", oldest);
		this.ctx.storage.sql.exec("DELETE FROM request_limits WHERE window_start < ?", now - RATE_WINDOW_MS * 2);
	}
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
	const contentLength = request.headers.get("content-length");
	if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_JSON_BODY_BYTES)) return null;
	if (!request.body) return null;
	try {
		const reader = request.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_JSON_BODY_BYTES) { await reader.cancel(); return null; }
			chunks.push(value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		const body = JSON.parse(new TextDecoder().decode(bytes));
		return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
	} catch { return null; }
}
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com wss://webmcp-demo.rakanlabs.com ws://localhost:* ws://127.0.0.1:*; frame-src https://challenges.cloudflare.com",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	"Referrer-Policy": "same-origin",
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
};
function secureResponse(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers, webSocket: response.webSocket });
}
function json(result: unknown, status = 200): Response { return secureResponse(Response.json(result, { status, headers: { "Cache-Control": "no-store" } })); }
function plain(message: string, status: number, headers?: HeadersInit): Response { return secureResponse(new Response(message, { status, headers })); }
function methodNotAllowed(allowed: string): Response { return plain("Method not allowed", 405, { Allow: allowed }); }
function isJsonRequest(request: Request): boolean { return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json"; }
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
		if (result.success === true && typeof result.hostname === "string" && allowedTurnstileHostname(result.hostname, env.APP_ENVIRONMENT) && result.action === TURNSTILE_ACTION) return { status: "ok" };
	} catch { /* Treat verification outages as a failed confirmation without exposing service internals. */ }
	return { status: "turnstile_failed", message: "Confirmation could not be verified. Please try the challenge again." };
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/parties/")) {
			// Fully validate the route and handshake before either PartyServer or
			// this handler resolves a Durable Object.
			const isCanvas = isCurrentCanvasRoomRequest(url);
			if (!isCurrentDocumentRoomRequest(url) && !isCanvas) return plain("Room not found", 404);
			if (request.method !== "GET") return methodNotAllowed("GET");
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return plain("WebSocket upgrade required", 426, { Upgrade: "websocket" });
			if (!sameOrigin(request, env.APP_ENVIRONMENT)) return plain("Forbidden", 403);
			const clientKey = await anonymousClientKey(request);
			const room = isCurrentCanvasRoomRequest(url)
				? await getServerByName<Env, CanvasRoom>(env.CANVAS_ROOM, todayCanvasRoomName())
				: await getServerByName<Env, DocumentRoom>(env.DOCUMENT_ROOM, todayRoomName());
			if (!await room.allowWebSocketConnection(clientKey)) return plain("Too many connections", 429, { "Retry-After": "60" });
			const headers = new Headers(request.headers);
			headers.set("X-WebMCP-Client-Key", clientKey);
			const routedRequest = new Request(request, { headers });
			const partyResponse = await routePartykitRequest(routedRequest, env, { onBeforeConnect: (connectionRequest) => sameOrigin(connectionRequest, env.APP_ENVIRONMENT) ? undefined : plain("Forbidden", 403) });
			return partyResponse ? secureResponse(partyResponse) : plain("Room not found", 404);
		}
		if (!url.pathname.startsWith("/api/")) return secureResponse(await env.ASSETS.fetch(request));
		if (url.pathname.startsWith("/api/canvas/")) {
			const getRoute = url.pathname === "/api/canvas/status" || url.pathname === "/api/canvas/revisions";
			const postRoute = url.pathname === "/api/canvas/read" || url.pathname === "/api/canvas/mutate" || url.pathname === "/api/canvas/human-commit";
			if (!getRoute && !postRoute) return json({ status: "not_found" }, 404);
			if (getRoute && request.method !== "GET") return methodNotAllowed("GET");
			if (postRoute && request.method !== "POST") return methodNotAllowed("POST");
			let body: Record<string, unknown> | null = null;
			let mutation: CanvasMutation | null = null;
			let scene: CanvasElement[] | null = null;
			let expectedRevision: number | null = null;
			if (postRoute) {
				if (!sameOrigin(request, env.APP_ENVIRONMENT)) return json({ status: "forbidden" }, 403);
				if (!isJsonRequest(request)) return json({ status: "unsupported_media_type" }, 415);
				body = await jsonBody(request);
				if (!body) return json({ status: "invalid_json" }, 400);
				if (url.pathname === "/api/canvas/read" && !safeId(body.sessionId)) return json({ status: "invalid_session" }, 400);
				if (url.pathname === "/api/canvas/mutate") {
					mutation = canvasMutation(body.mutation);
					if (!safeId(body.sessionId) || !safeId(body.operationId) || !mutation) return json({ status: "invalid_mutation" }, 400);
				}
				if (url.pathname === "/api/canvas/human-commit") {
					scene = canvasScene(body.elements);
					expectedRevision = asRevision(body.expectedRevision);
					if (!scene || expectedRevision === null) return json({ status: "invalid_scene" }, 400);
				}
			}
			const clientKey = await anonymousClientKey(request);
			const canvas = await getServerByName<Env, CanvasRoom>(env.CANVAS_ROOM, todayCanvasRoomName());
			if (!await canvas.allowHttpAction(clientKey)) return secureResponse(new Response(JSON.stringify({ status: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "60" } }));
			if (url.pathname === "/api/canvas/status") return json(await canvas.status());
			if (url.pathname === "/api/canvas/revisions") return json(await canvas.listRevisions());
			if (url.pathname === "/api/canvas/read") return json(await canvas.readForSession(body!.sessionId as string));
			if (url.pathname === "/api/canvas/mutate") return json(await canvas.mutateForSession(body!.sessionId as string, mutation!, body!.operationId as string, "WebMCP agent"));
			return json(await canvas.commitHumanScene(expectedRevision!, scene!));
		}
		const revisionMatch = url.pathname.match(/^\/api\/revisions\/(\d+)$/);
		const getRoute = url.pathname === "/api/status" || url.pathname === "/api/config" || url.pathname === "/api/revisions" || revisionMatch !== null;
		const postRoute = url.pathname === "/api/agent/read" || url.pathname === "/api/agent/changes" || url.pathname === "/api/agent/edit" || url.pathname === "/api/human/commit" || url.pathname === "/api/revisions/restore-intents" || url.pathname === "/api/revisions/restore-cancel" || url.pathname === "/api/revisions/restore-confirm";
		if (!getRoute && !postRoute) return json({ status: "not_found" }, 404);
		if (getRoute && request.method !== "GET") return methodNotAllowed("GET");
		if (postRoute && request.method !== "POST") return methodNotAllowed("POST");
		let body: Record<string, unknown> | null = null;
		let replacements: Replacement[] | null = null;
		if (postRoute) {
			if (!sameOrigin(request, env.APP_ENVIRONMENT)) return json({ status: "forbidden" }, 403);
			if (!isJsonRequest(request)) return json({ status: "unsupported_media_type" }, 415);
			body = await jsonBody(request);
			if (!body) return json({ status: "invalid_json" }, 400);
			if ((url.pathname === "/api/agent/read" || url.pathname === "/api/agent/changes") && !safeId(body.sessionId)) return json({ status: "invalid_session" }, 400);
			if (url.pathname === "/api/agent/edit") {
				if (!safeId(body.sessionId) || !safeId(body.operationId) || !Array.isArray(body.replacements) || body.replacements.length === 0 || body.replacements.length > MAX_REPLACEMENTS) return json({ status: "invalid_replacements" }, 400);
				const parsedReplacements = body.replacements.map(asReplacement);
				if (!parsedReplacements.every((replacement): replacement is Replacement => replacement !== null)) return json({ status: "invalid_replacements" }, 400);
				replacements = parsedReplacements;
			}
			if (url.pathname === "/api/human/commit" && (typeof body.baseText !== "string" || typeof body.nextText !== "string" || body.baseText.length > MAX_DOCUMENT_LENGTH || body.nextText.length > MAX_DOCUMENT_LENGTH)) return json({ status: "invalid_document" }, 400);
			if (url.pathname === "/api/revisions/restore-intents" && asRevision(body.revision) === null) return json({ status: "invalid_revision" }, 400);
			if ((url.pathname === "/api/revisions/restore-cancel" || url.pathname === "/api/revisions/restore-confirm") && !safeId(body.intentId)) return json({ status: "invalid_intent" }, 400);
			if (url.pathname === "/api/revisions/restore-confirm" && (typeof body.turnstileToken !== "string" || body.turnstileToken.length === 0 || body.turnstileToken.length > 2_048)) return json({ status: "turnstile_failed" }, 400);
		}
		if (revisionMatch && asRevision(revisionMatch[1]) === null) return json({ status: "invalid_revision" }, 400);
		const clientKey = await anonymousClientKey(request);
		const room = await getServerByName<Env, DocumentRoom>(env.DOCUMENT_ROOM, todayRoomName());
		if (!await room.allowHttpAction(clientKey)) return secureResponse(new Response(JSON.stringify({ status: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "60" } }));
		if (url.pathname === "/api/status") return json(await room.status());
		if (url.pathname === "/api/config") return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, turnstileAction: TURNSTILE_ACTION });
		if (url.pathname === "/api/revisions") return json(await room.listRevisions(asOptionalQuery(url.searchParams.get("query")), asRevision(url.searchParams.get("beforeRevision"))));
		if (revisionMatch) return json(await room.readRevision(Number(revisionMatch[1])));
		if (url.pathname === "/api/agent/read") return json(await room.readForSession(body!.sessionId as string));
		if (url.pathname === "/api/agent/changes") return json(await room.changesSinceLastRead(body!.sessionId as string));
		if (url.pathname === "/api/agent/edit") {
			return json(await room.editForSession(body!.sessionId as string, replacements as Replacement[], body!.operationId as string, "WebMCP agent"));
		}
		if (url.pathname === "/api/human/commit") {
			return json(await room.commitHumanDraft(body!.baseText as string, body!.nextText as string));
		}
		if (url.pathname === "/api/revisions/restore-intents") {
			return json(await room.createRestoreIntent(asRevision(body!.revision)!, "workspace participant"));
		}
		if (url.pathname === "/api/revisions/restore-cancel") {
			return json(await room.cancelRestoreIntent(body!.intentId as string));
		}
		if (url.pathname === "/api/revisions/restore-confirm") {
			const intentId = body!.intentId as string;
			const lookup = await room.getRestoreIntent(intentId) as unknown as RestoreIntentLookup;
			if (lookup.status !== "ok") return json(lookup);
			const intentStatus = lookup.intent.status;
			if (intentStatus === "completed") return json(await room.confirmRestore(intentId));
			if (intentStatus !== "pending") return json({ status: intentStatus });
			const verified = await verifyRestoreToken(env, body!.turnstileToken, request, intentId);
			if (verified.status !== "ok") return json(verified);
			return json(await room.confirmRestore(intentId));
		}
		return json({ status: "not_found" }, 404);
	},
} satisfies ExportedHandler<Env>;
