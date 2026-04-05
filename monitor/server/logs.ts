import { spawn, type Subprocess } from "bun";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MonitorConfig } from "./config.ts";
import type { ServerWebSocket } from "bun";

let sshProcess: Subprocess | null = null;
let keyFilePath: string | null = null;
const clients = new Set<ServerWebSocket<unknown>>();
const buffer: string[] = [];
const MAX_BUFFER = 200;

function writeKeyFile(key: string): string {
	const path = join(tmpdir(), `monitor-ssh-${process.pid}.key`);
	writeFileSync(path, key, { mode: 0o600 });
	return path;
}

function cleanupKeyFile() {
	if (keyFilePath) {
		try {
			unlinkSync(keyFilePath);
		} catch {}
		keyFilePath = null;
	}
}

function broadcast(line: string) {
	buffer.push(line);
	if (buffer.length > MAX_BUFFER) buffer.shift();
	for (const ws of clients) {
		ws.send(line);
	}
}

function startSsh(config: MonitorConfig) {
	if (sshProcess) return;

	keyFilePath = writeKeyFile(config.vpsSshKey);

	sshProcess = spawn({
		cmd: [
			"ssh",
			"-o",
			"StrictHostKeyChecking=no",
			"-o",
			"UserKnownHostsFile=/dev/null",
			"-o",
			"LogLevel=ERROR",
			"-i",
			keyFilePath,
			`${config.vpsUser}@${config.vpsHost}`,
			"journalctl",
			"-u",
			"trader-v2",
			"-f",
			"-n",
			"200",
			"--no-pager",
		],
		stdout: "pipe",
		stderr: "pipe",
	});

	const reader = sshProcess.stdout.getReader();

	(async () => {
		const decoder = new TextDecoder();
		let partial = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				partial += decoder.decode(value, { stream: true });
				const lines = partial.split("\n");
				partial = lines.pop() ?? "";
				for (const line of lines) {
					if (line.trim()) broadcast(line);
				}
			}
		} catch {
			// SSH disconnected
		}
		sshProcess = null;
		cleanupKeyFile();
		// Notify clients of disconnect
		for (const ws of clients) {
			ws.send(JSON.stringify({ type: "disconnect" }));
		}
		// Auto-reconnect after 3s if clients still connected
		if (clients.size > 0) {
			setTimeout(() => startSsh(config), 3000);
		}
	})();
}

function stopSsh() {
	if (sshProcess) {
		sshProcess.kill();
		sshProcess = null;
	}
	cleanupKeyFile();
}

export function handleWsOpen(
	ws: ServerWebSocket<unknown>,
	config: MonitorConfig,
) {
	clients.add(ws);
	// Send buffered lines as backfill
	for (const line of buffer) {
		ws.send(line);
	}
	startSsh(config);
}

export function handleWsClose(ws: ServerWebSocket<unknown>) {
	clients.delete(ws);
	if (clients.size === 0) {
		stopSsh();
	}
}

export function cleanupOnExit() {
	stopSsh();
}
