import { action, DidReceiveSettingsEvent, KeyDownEvent, KeyAction, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";

import {
	CodexAppServer,
	CodexSession,
	CodexSessionStatus,
} from "../codex-app-server";

const STATUS_COLORS: Record<CodexSessionStatus, string> = {
	WORK: "#FFD740",
	WAIT: "#FF5C5C",
	DONE: "#69F0AE",
};

const PROJECT_COLORS = [
	"#7DD3FC", // sky
	"#A7F3D0", // mint
	"#C4B5FD", // lavender
	"#FDE68A", // amber
	"#F9A8D4", // pink
	"#FDBA74", // orange
	"#86EFAC", // green
];

/**
 * Displays a selected, recent Codex session on a Stream Deck key.
 */
@action({ UUID: "com.falcon.falcon.codex-status" })
export class CodexStatus extends SingletonAction<CodexStatusSettings> {
	private readonly appServer = new CodexAppServer();

	constructor() {
		super();
		this.appServer.onSessionsChanged = () => this.renderVisibleActions();
		this.appServer.start();
	}

	override async onWillAppear(ev: WillAppearEvent<CodexStatusSettings>): Promise<void> {
		if (ev.action.isKey()) {
			await this.render(ev.action, ev.payload.settings);
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CodexStatusSettings>): Promise<void> {
		if (ev.action.isKey()) {
			await this.render(ev.action, ev.payload.settings);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<CodexStatusSettings>): Promise<void> {
		// A press intentionally does not alter the session. Refreshing provides a
		// quick recovery path if app-server was restarting or Codex just started.
		this.appServer.refresh();
		if (ev.action.isKey()) {
			await this.render(ev.action, ev.payload.settings);
		}
	}

	private renderVisibleActions(): void {
		for (const action of this.actions) {
			if (action.isKey()) {
				void this.render(action, action.getSettings<CodexStatusSettings>());
			}
		}
	}

	private async render(
		action: KeyAction<CodexStatusSettings>,
		settings: CodexStatusSettings | Promise<CodexStatusSettings>,
	): Promise<void> {
		const session = this.appServer.sessions[taskNumber(await settings) - 1];
		await action.setImage(createKeyImage(session));
	}
}

type CodexStatusSettings = {
	taskNumber?: number | string;
};

function taskNumber(settings: CodexStatusSettings): number {
	const value = Number(settings.taskNumber ?? 1);
	return Number.isInteger(value) && value > 0 ? value : 1;
}

function createKeyImage(session: CodexSession | undefined): string {
	const status = session?.status ?? "DONE";
	const header = session ? `${session.project}: ${session.projectSession}` : "No Codex task";
	const projectColor = session ? projectColorFor(session.project) : "#F8FAFC";
	const escapedHeader = escapeXml(header);

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
		<rect width="144" height="144" rx="12" fill="#080808"/>
		<rect x="10" y="10" width="124" height="34" rx="7" fill="#242424"/>
		<text x="72" y="32" text-anchor="middle" fill="${projectColor}" font-family="Arial,sans-serif" font-size="15" font-weight="700">${escapedHeader}</text>
		<text x="72" y="96" text-anchor="middle" fill="${STATUS_COLORS[status]}" font-family="Arial,sans-serif" font-size="34" font-weight="800">${status}</text>
	</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** A stable, high-contrast colour for every project name. */
function projectColorFor(project: string): string {
	let hash = 0;
	for (const character of project) {
		hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	}
	return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&apos;",
	}[character] ?? character));
}
