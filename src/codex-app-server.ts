import { ChildProcess, spawn } from "node:child_process";
import { basename, delimiter, join } from "node:path";

const POLL_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 200;

export type CodexSessionStatus = "WORK" | "WAIT" | "DONE";

export type CodexSession = {
	id: string;
	project: string;
	projectSession: number;
	status: CodexSessionStatus;
	createdAt: number;
	updatedAt: number;
};

type AppServerThread = {
	id: string;
	parentThreadId: string | null;
	createdAt: number;
	updatedAt: number;
	recencyAt: number | null;
	cwd: string;
	status: {
		type: "active" | "idle" | "notLoaded" | "systemError";
		activeFlags?: string[];
	};
};

type LoadedThreadListResult = {
	data: string[];
	nextCursor: string | null;
};

type RpcMessage = {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
};

type PendingRequest = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

/**
 * Read-only client for a local `codex app-server` child process.
 *
 * The protocol is bidirectional JSON-RPC over a localhost WebSocket. Keeping
 * the connection open lets us consume `thread/status/changed` notifications
 * immediately. A slower loaded-thread snapshot recovers missed events without
 * scanning historical sessions. Thread metadata is cached between snapshots.
 */
export class CodexAppServer {
	private readonly serverUrl = process.env.CODEX_APP_SERVER_URL || "ws://127.0.0.1:45999";
	private child: ChildProcess | undefined;
	private socket: WebSocket | undefined;
	private nextRequestId = 1;
	private pending = new Map<number, PendingRequest>();
	private isReady = false;
	private isRefreshing = false;
	private pollTimer: NodeJS.Timeout | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private threads = new Map<string, AppServerThread>();
	private snapshotChanges: Map<string, Partial<AppServerThread>> | undefined;
	private refreshAgain = false;
	public sessions: CodexSession[] = [];
	public onSessionsChanged: (() => void) | undefined;

	start(): void {
		if (this.socket || this.child || this.reconnectTimer) {
			return;
		}

		const home = process.env.HOME;
		const pathEntries = [
			home ? join(home, ".local", "bin") : undefined,
			process.env.PATH,
		].filter((entry): entry is string => Boolean(entry));
		const executable = process.platform === "win32" ? "codex.cmd" : "codex";

		if (!process.env.CODEX_APP_SERVER_URL) {
			const child = spawn(process.env.CODEX_BINARY || executable, ["app-server", "--listen", this.serverUrl], {
				env: { ...process.env, PATH: pathEntries.join(delimiter) },
				stdio: "ignore",
			});
			this.child = child;
			child.on("error", () => this.handleServerDisconnect(child));
			child.on("close", () => this.handleServerDisconnect(child));
		}

		setTimeout(() => this.connect(), 100);
	}

	refresh(): void {
		if (!this.isReady || this.isRefreshing) {
			return;
		}
		void this.refreshThreads();
	}

	private async initialize(): Promise<void> {
		const socket = this.socket;
		try {
			await this.request("initialize", {
				clientInfo: {
					name: "codex-status-stream-deck",
					title: "Codex Status Stream Deck",
					version: "0.1.0",
				},
				capabilities: { experimentalApi: true },
			});
			if (this.socket !== socket) return;
			this.notify("initialized", {});
			this.isReady = true;
			this.refresh();
			this.pollTimer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
		} catch {
			if (this.socket === socket) {
				socket?.close();
			}
		}
	}

	private connect(): void {
		if (this.socket) {
			return;
		}
		const socket = new WebSocket(this.serverUrl);
		this.socket = socket;
		socket.addEventListener("open", () => {
			if (this.socket === socket) {
				void this.initialize();
			}
		});
		socket.addEventListener("message", (event) => {
			if (this.socket !== socket) return;
			try {
				this.handleMessage(JSON.parse(String(event.data)) as RpcMessage);
			} catch {
				// Ignore malformed frames so one bad message cannot break updates.
			}
		});
		socket.addEventListener("error", () => this.handleSocketDisconnect(socket));
		socket.addEventListener("close", () => this.handleSocketDisconnect(socket));
	}

	private async refreshThreads(): Promise<void> {
		const socket = this.socket;
		this.isRefreshing = true;
		const changes = new Map<string, Partial<AppServerThread>>();
		this.snapshotChanges = changes;
		try {
			const threads = new Map<string, AppServerThread>();
			let cursor: string | null = null;
			const seenCursors = new Set<string>();
			do {
				const result = await this.request("thread/loaded/list", {
					cursor,
					limit: PAGE_SIZE,
				}) as LoadedThreadListResult;
				if (this.socket !== socket) return;
				for (const id of result.data) {
					const { thread } = await this.request("thread/read", {
						threadId: id,
						includeTurns: false,
					}) as { thread: AppServerThread };
					if (this.socket !== socket) return;
					threads.set(id, thread);
				}
				cursor = result.nextCursor;
				if (cursor && seenCursors.has(cursor)) throw new Error("Repeated pagination cursor");
				if (cursor) seenCursors.add(cursor);
			} while (cursor);

			// Notifications received during a snapshot take precedence over reads.
			for (const [id, change] of changes) {
				const thread = threads.get(id) ?? this.threads.get(id);
				if (thread) threads.set(id, { ...thread, ...change });
			}
			this.threads = threads;
			this.updateSessions();
		} catch {
			if (this.socket === socket) {
				socket?.close();
			}
		} finally {
			if (this.socket === socket) {
				this.snapshotChanges = undefined;
				this.isRefreshing = false;
				if (this.refreshAgain) {
					this.refreshAgain = false;
					this.refresh();
				}
			}
		}
	}

	private updateSessions(): void {
		const topLevelThreads = [...this.threads.values()]
			.filter((thread) => thread.parentThreadId === null)
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

		// A loaded thread is a currently open shared-server session. Do not use
		// historical `notLoaded` threads here: when a project has no open
		// sessions, its next session should begin again at 1.
		const loadedThreads = topLevelThreads.filter((thread) => thread.status.type !== "notLoaded");
		const projectCounts = new Map<string, number>();
		const projectSessionNumbers = new Map<string, number>();
		for (const thread of loadedThreads) {
			const project = projectName(thread.cwd);
			const projectSession = (projectCounts.get(project) ?? 0) + 1;
			projectCounts.set(project, projectSession);
			projectSessionNumbers.set(thread.id, projectSession);
		}

		const sessions = loadedThreads
			.map((thread) => {
				const project = projectName(thread.cwd);
				return {
					id: thread.id,
					project,
					projectSession: projectSessionNumbers.get(thread.id) ?? 1,
					status: statusFor(thread),
					createdAt: thread.createdAt,
					updatedAt: thread.recencyAt ?? thread.updatedAt,
				};
			});

		const nextSessions = sessions.sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
		if (JSON.stringify(nextSessions) !== JSON.stringify(this.sessions)) {
			this.sessions = nextSessions;
			this.onSessionsChanged?.();
		}
	}

	private handleMessage(message: RpcMessage): void {
		if (message.id !== undefined && message.method) return;
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) {
				return;
			}
			this.pending.delete(message.id);
			clearTimeout(pending.timeout);
			if (message.error) {
				pending.reject(new Error(message.error.message));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (message.method === "thread/started") {
			const { thread } = message.params as { thread: AppServerThread };
			this.threads.set(thread.id, thread);
			this.snapshotChanges?.set(thread.id, thread);
			this.updateSessions();
			return;
		}
		const params = message.params as { threadId?: string; status?: AppServerThread["status"] } | undefined;
		if (!params?.threadId) return;
		const status = message.method === "thread/status/changed" ? params.status
			: ["thread/closed", "thread/archived", "thread/deleted"].includes(message.method ?? "")
				? { type: "notLoaded" as const } : undefined;
		if (!status) return;
		const change = { status, recencyAt: Date.now() / 1_000 };
		this.snapshotChanges?.set(params.threadId, { ...this.snapshotChanges.get(params.threadId), ...change });
		const thread = this.threads.get(params.threadId);
		if (thread) {
			Object.assign(thread, change);
			this.updateSessions();
		} else if (status.type !== "notLoaded") {
			// Fetch metadata once when a notification reveals an unknown session.
			if (this.isRefreshing) this.refreshAgain = true;
			else this.refresh();
		}
	}

	private request(method: string, params: unknown): Promise<unknown> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Codex app-server is unavailable"));
		}
		const id = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timeout });
			this.socket?.send(JSON.stringify({ method, id, params }));
		});
	}

	private notify(method: string, params: unknown): void {
		this.socket?.send(JSON.stringify({ method, params }));
	}

	private handleServerDisconnect(child: ChildProcess): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		this.socket?.close();
		this.socket = undefined;
		this.resetConnection();
	}

	private handleSocketDisconnect(socket: WebSocket): void {
		if (this.socket !== socket) {
			return;
		}
		this.socket = undefined;
		this.resetConnection();
	}

	private resetConnection(): void {
		this.isReady = false;
		this.isRefreshing = false;
		this.snapshotChanges = undefined;
		this.refreshAgain = false;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Codex app-server disconnected"));
		}
		this.pending.clear();
		if (!this.reconnectTimer) {
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = undefined;
				if (this.child || process.env.CODEX_APP_SERVER_URL) {
					this.connect();
				} else {
					this.start();
				}
			}, RECONNECT_DELAY_MS);
		}
	}
}

function statusFor(thread: AppServerThread): CodexSessionStatus {
	if (thread.status.type !== "active") {
		return "DONE";
	}
	return thread.status.activeFlags?.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
		? "WAIT"
		: "WORK";
}

function projectName(cwd: string): string {
	const name = basename(cwd);
	return name || cwd || "?";
}
