import { ChildProcess, spawn } from "node:child_process";
import { basename, delimiter, join } from "node:path";

const POLL_INTERVAL_MS = 1_500;
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

type ThreadListResult = {
	data: AppServerThread[];
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
 * immediately while a small poll also discovers sessions made in other Codex
 * surfaces connected to this same server.
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
		try {
			await this.request("initialize", {
				clientInfo: {
					name: "codex-status-stream-deck",
					title: "Codex Status Stream Deck",
					version: "0.1.0",
				},
				capabilities: { experimentalApi: true },
			});
			this.notify("initialized", {});
			this.isReady = true;
			this.refresh();
			this.pollTimer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
		} catch {
			if (this.socket) {
				this.socket.close();
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
		this.isRefreshing = true;
		try {
			const threads: AppServerThread[] = [];
			let cursor: string | null = null;
			do {
				const result = await this.request("thread/list", {
					cursor,
					limit: PAGE_SIZE,
					sortKey: "updated_at",
					sortDirection: "desc",
				}) as ThreadListResult;
				threads.push(...result.data);
				cursor = result.nextCursor;
			} while (cursor && threads.length < 1_000);

			this.threads = new Map(threads.map((thread) => [thread.id, thread]));
			this.updateSessions();
		} catch {
			if (this.socket) {
				this.socket.close();
			}
		} finally {
			this.isRefreshing = false;
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

		if (message.method === "thread/status/changed") {
			const params = message.params as { threadId?: string; status?: AppServerThread["status"] };
			const thread = params.threadId ? this.threads.get(params.threadId) : undefined;
			if (thread && params.status) {
				thread.status = params.status;
				this.updateSessions();
			}
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
