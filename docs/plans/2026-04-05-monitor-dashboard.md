# Monitor Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local monitoring dashboard that streams live VPS logs, shows health status, and displays GitHub Actions deploy history — all via a single `bun run monitor` command.

**Architecture:** A `monitor/` subdirectory with its own package.json containing a Bun WebSocket server that SSHs into the VPS for log streaming, proxies the health endpoint, and calls the GitHub Actions API. The frontend is a React SPA using Vite + shadcn/ui + Tailwind CSS.

**Tech Stack:** Bun, React 19, Vite, Tailwind CSS v4, shadcn/ui, WebSocket

**Spec:** `docs/specs/2026-04-05-monitor-dashboard-design.md`

---

### Task 1: Scaffold the monitor project

**Files:**
- Create: `monitor/package.json`
- Create: `monitor/tsconfig.json`
- Create: `monitor/vite.config.ts`
- Create: `monitor/index.html`
- Create: `monitor/src/main.tsx`
- Create: `monitor/src/App.tsx`
- Create: `monitor/src/index.css`
- Modify: `package.json` (add `monitor` script)

- [ ] **Step 1: Create `monitor/package.json`**

```json
{
  "name": "trader-v2-monitor",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.2",
    "@types/react-dom": "^19.1.2",
    "@vitejs/plugin-react": "^4.4.1",
    "autoprefixer": "^10.4.21",
    "tailwindcss": "^4.1.4",
    "@tailwindcss/vite": "^4.1.4",
    "typescript": "^5.9.3",
    "vite": "^6.3.2"
  }
}
```

- [ ] **Step 2: Create `monitor/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `monitor/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		proxy: {
			"/api": "http://localhost:3848",
			"/ws": {
				target: "ws://localhost:3848",
				ws: true,
			},
		},
	},
	build: {
		outDir: "dist",
	},
});
```

- [ ] **Step 4: Create `monitor/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>trader-v2 monitor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `monitor/src/index.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 6: Create `monitor/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
```

- [ ] **Step 7: Create `monitor/src/App.tsx`**

```tsx
export function App() {
	return (
		<div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
			<h1 className="text-lg font-medium">trader-v2 monitor</h1>
			<p className="text-zinc-500 text-sm">dashboard loading...</p>
		</div>
	);
}
```

- [ ] **Step 8: Install dependencies**

Run: `cd monitor && bun install`
Expected: lockfile created, node_modules populated

- [ ] **Step 9: Verify Vite dev server starts**

Run: `cd monitor && bunx vite --open false &` then `sleep 2 && curl -s http://localhost:5173 | head -5` then kill the vite process.
Expected: HTML response containing `<div id="root">`.

- [ ] **Step 10: Add `monitor` script to root `package.json`**

In the root `package.json`, add to `"scripts"`:

```json
"monitor": "cd monitor && bun run server.ts"
```

- [ ] **Step 11: Commit**

```bash
git add monitor/ package.json
git commit -m "feat(monitor): scaffold React + Vite + Tailwind project"
```

---

### Task 2: Initialize shadcn/ui

**Files:**
- Create: `monitor/components.json`
- Create: `monitor/src/lib/utils.ts`
- Create: `monitor/src/components/ui/card.tsx`
- Create: `monitor/src/components/ui/badge.tsx`
- Create: `monitor/src/components/ui/input.tsx`
- Create: `monitor/src/components/ui/scroll-area.tsx`
- Create: `monitor/src/components/ui/collapsible.tsx`

- [ ] **Step 1: Initialize shadcn**

Run: `cd monitor && bunx --bun shadcn@latest init -d`

This creates `components.json` and sets up the shadcn config. If prompted, accept defaults (New York style, zinc base color, CSS variables).

- [ ] **Step 2: Add required components**

Run: `cd monitor && bunx --bun shadcn@latest add card badge input scroll-area collapsible`

This creates the component files under `monitor/src/components/ui/`.

- [ ] **Step 3: Verify components import correctly**

Update `monitor/src/App.tsx` temporarily:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function App() {
	return (
		<div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
			<Card>
				<CardHeader>
					<CardTitle>
						trader-v2 <Badge>online</Badge>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-zinc-400 text-sm">Components loaded.</p>
				</CardContent>
			</Card>
		</div>
	);
}
```

Run: `cd monitor && bunx vite build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add monitor/
git commit -m "feat(monitor): add shadcn/ui with card, badge, input, scroll-area, collapsible"
```

---

### Task 3: Build the backend server — config + health proxy

**Files:**
- Create: `monitor/server.ts`
- Create: `monitor/server/config.ts`
- Create: `monitor/server/health.ts`

- [ ] **Step 1: Create `monitor/server/config.ts`**

Loads VPS and GitHub config from the project root `.env` file. Uses the same Python-based SSH key extraction as `scripts/vps-ssh.sh`.

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface MonitorConfig {
	vpsHost: string;
	vpsUser: string;
	vpsSshKey: string;
	githubToken: string;
	githubRepo: string;
	adminPassword: string;
	port: number;
}

export function loadConfig(): MonitorConfig {
	const envPath = join(import.meta.dir, "..", ".env");
	const envContent = readFileSync(envPath, "utf-8");

	function getVar(name: string, fallback?: string): string {
		const match = envContent.match(new RegExp(`^${name}=(.+)$`, "m"));
		const value = match?.[1]?.trim() ?? fallback;
		if (!value) throw new Error(`Missing ${name} in .env`);
		return value;
	}

	// Extract multi-line SSH key (same regex as vps-ssh.sh)
	const keyMatch = envContent.match(
		/VPS_SSH_KEY="?(-----BEGIN[\s\S]*?-----END[^\n]+)"?/,
	);
	if (!keyMatch?.[1]) throw new Error("Missing VPS_SSH_KEY in .env");

	return {
		vpsHost: getVar("VPS_HOST"),
		vpsUser: getVar("VPS_USER"),
		vpsSshKey: keyMatch[1],
		githubToken: getVar("GITHUB_TOKEN", ""),
		githubRepo: getVar("GITHUB_REPO_OWNER", "CalNicklin") + "/" + getVar("GITHUB_REPO_NAME", "trader-v2"),
		adminPassword: getVar("ADMIN_PASSWORD", ""),
		port: Number.parseInt(getVar("HTTP_PORT", "3848"), 10),
	};
}
```

- [ ] **Step 2: Create `monitor/server/health.ts`**

Proxies the VPS health endpoint.

```ts
import type { MonitorConfig } from "./config.ts";

export interface HealthData {
	status: "ok" | "degraded" | "error";
	uptime: number;
	timestamp: string;
	activeStrategies: number;
	dailyPnl: number;
	apiSpendToday: number;
	lastQuoteTime: string | null;
	paused: boolean;
}

export async function fetchHealth(config: MonitorConfig): Promise<HealthData | null> {
	const url = `http://${config.vpsHost}:3847/health`;
	try {
		const headers: Record<string, string> = {};
		if (config.adminPassword) {
			headers.Authorization = `Basic ${btoa(`:${config.adminPassword}`)}`;
		}
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
		if (!res.ok) return null;
		return (await res.json()) as HealthData;
	} catch {
		return null;
	}
}
```

- [ ] **Step 3: Create `monitor/server.ts`** (health proxy only, WebSocket in next task)

```ts
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "./server/config.ts";
import { fetchHealth } from "./server/health.ts";

const config = loadConfig();

const distDir = join(import.meta.dir, "dist");
const isDev = !existsSync(join(distDir, "index.html"));

if (isDev) {
	console.log("⚠ No production build found. Run 'bun run build' in monitor/ first, or use Vite dev server with proxy.");
}

const server = Bun.serve({
	port: config.port,
	async fetch(req) {
		const url = new URL(req.url);

		// API: health proxy
		if (url.pathname === "/api/health") {
			const data = await fetchHealth(config);
			if (!data) {
				return Response.json({ error: "VPS unreachable" }, { status: 502 });
			}
			return Response.json(data);
		}

		// Static files (production build)
		if (!isDev) {
			let filePath = join(distDir, url.pathname === "/" ? "index.html" : url.pathname);
			const file = Bun.file(filePath);
			if (await file.exists()) return new Response(file);
			// SPA fallback
			return new Response(Bun.file(join(distDir, "index.html")));
		}

		return new Response("Not found", { status: 404 });
	},
});

console.log(`Monitor server running at http://localhost:${server.port}`);
```

- [ ] **Step 4: Test the server starts**

Run: `cd monitor && bun run server.ts &` then `sleep 1 && curl -s http://localhost:3848/api/health | head -20` then kill the server.
Expected: JSON response (either health data from VPS or `{"error":"VPS unreachable"}`).

- [ ] **Step 5: Commit**

```bash
git add monitor/server.ts monitor/server/
git commit -m "feat(monitor): add backend server with config loader and health proxy"
```

---

### Task 4: Add GitHub Actions deploy endpoint

**Files:**
- Create: `monitor/server/deploys.ts`
- Modify: `monitor/server.ts`

- [ ] **Step 1: Create `monitor/server/deploys.ts`**

```ts
import type { MonitorConfig } from "./config.ts";

export interface DeployRun {
	id: number;
	status: string;
	conclusion: string | null;
	headSha: string;
	headMessage: string;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
	runDurationMs: number | null;
}

export async function fetchDeploys(config: MonitorConfig): Promise<DeployRun[]> {
	if (!config.githubToken) return [];

	const url = `https://api.github.com/repos/${config.githubRepo}/actions/workflows/deploy.yml/runs?per_page=5`;
	try {
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${config.githubToken}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return [];
		const data = (await res.json()) as {
			workflow_runs: Array<{
				id: number;
				status: string;
				conclusion: string | null;
				head_sha: string;
				head_commit?: { message?: string };
				created_at: string;
				updated_at: string;
				html_url: string;
				run_started_at?: string;
			}>;
		};
		return data.workflow_runs.map((run) => ({
			id: run.id,
			status: run.status,
			conclusion: run.conclusion,
			headSha: run.head_sha,
			headMessage: run.head_commit?.message?.split("\n")[0] ?? "",
			createdAt: run.created_at,
			updatedAt: run.updated_at,
			htmlUrl: run.html_url,
			runDurationMs:
				run.run_started_at
					? new Date(run.updated_at).getTime() - new Date(run.run_started_at).getTime()
					: null,
		}));
	} catch {
		return [];
	}
}
```

- [ ] **Step 2: Add deploy route to `monitor/server.ts`**

Add after the `/api/health` handler, before the static files section:

```ts
// API: deploy status
if (url.pathname === "/api/deploys") {
	const data = await fetchDeploys(config);
	return Response.json(data);
}
```

Add the import at the top of `server.ts`:

```ts
import { fetchDeploys } from "./server/deploys.ts";
```

- [ ] **Step 3: Test the endpoint**

Run: `cd monitor && bun run server.ts &` then `sleep 1 && curl -s http://localhost:3848/api/deploys | head -30` then kill the server.
Expected: JSON array of deploy runs (or empty array if no GITHUB_TOKEN).

- [ ] **Step 4: Commit**

```bash
git add monitor/server.ts monitor/server/deploys.ts
git commit -m "feat(monitor): add GitHub Actions deploy status endpoint"
```

---

### Task 5: Add WebSocket log streaming via SSH

**Files:**
- Create: `monitor/server/logs.ts`
- Modify: `monitor/server.ts`

- [ ] **Step 1: Create `monitor/server/logs.ts`**

Manages the SSH child process and broadcasts log lines to WebSocket clients.

```ts
import { spawn, type Subprocess } from "bun";
import { writeFileSync, unlinkSync, chmodSync } from "node:fs";
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
		try { unlinkSync(keyFilePath); } catch {}
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
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "LogLevel=ERROR",
			"-i", keyFilePath,
			`${config.vpsUser}@${config.vpsHost}`,
			"journalctl", "-u", "trader-v2", "-f", "-n", "200", "--no-pager",
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

export function handleWsOpen(ws: ServerWebSocket<unknown>, config: MonitorConfig) {
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
```

- [ ] **Step 2: Update `monitor/server.ts` to support WebSocket upgrade**

Replace the entire `monitor/server.ts` with:

```ts
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "./server/config.ts";
import { fetchHealth } from "./server/health.ts";
import { fetchDeploys } from "./server/deploys.ts";
import { handleWsOpen, handleWsClose, cleanupOnExit } from "./server/logs.ts";

const config = loadConfig();

const distDir = join(import.meta.dir, "dist");
const isDev = !existsSync(join(distDir, "index.html"));

if (isDev) {
	console.log("No production build found. Use Vite dev server (bun run dev) with proxy for development.");
}

const server = Bun.serve({
	port: config.port,
	async fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade for log streaming
		if (url.pathname === "/ws/logs") {
			const upgraded = server.upgrade(req);
			if (!upgraded) {
				return new Response("WebSocket upgrade failed", { status: 400 });
			}
			return undefined;
		}

		// API: health proxy
		if (url.pathname === "/api/health") {
			const data = await fetchHealth(config);
			if (!data) {
				return Response.json({ error: "VPS unreachable" }, { status: 502 });
			}
			return Response.json(data);
		}

		// API: deploy status
		if (url.pathname === "/api/deploys") {
			const data = await fetchDeploys(config);
			return Response.json(data);
		}

		// Static files (production build)
		if (!isDev) {
			const filePath = join(distDir, url.pathname === "/" ? "index.html" : url.pathname);
			const file = Bun.file(filePath);
			if (await file.exists()) return new Response(file);
			// SPA fallback
			return new Response(Bun.file(join(distDir, "index.html")));
		}

		return new Response("Not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			handleWsOpen(ws, config);
		},
		close(ws) {
			handleWsClose(ws);
		},
		message() {
			// Client doesn't send messages; ignore
		},
	},
});

// Cleanup SSH on exit
process.on("SIGINT", () => {
	cleanupOnExit();
	process.exit(0);
});
process.on("SIGTERM", () => {
	cleanupOnExit();
	process.exit(0);
});

console.log(`Monitor server running at http://localhost:${server.port}`);
```

- [ ] **Step 3: Test WebSocket connection**

Run: `cd monitor && bun run server.ts &` then `sleep 2 && curl -s -N -H "Connection: Upgrade" -H "Upgrade: websocket" http://localhost:3848/ws/logs` (this won't fully work as curl doesn't do WS, but should return 400 "WebSocket upgrade failed" confirming the route works). Kill the server.

A fuller test: use `websocat` if installed: `websocat ws://localhost:3848/ws/logs` — should stream log lines.

- [ ] **Step 4: Commit**

```bash
git add monitor/server.ts monitor/server/logs.ts
git commit -m "feat(monitor): add WebSocket log streaming via SSH"
```

---

### Task 6: Build the frontend — log viewer component

**Files:**
- Create: `monitor/src/lib/use-logs.ts`
- Create: `monitor/src/components/log-viewer.tsx`

- [ ] **Step 1: Create `monitor/src/lib/use-logs.ts`**

React hook that connects to the WebSocket, manages the circular buffer, and exposes connection state.

```tsx
import { useEffect, useRef, useState, useCallback } from "react";

export interface LogState {
	lines: string[];
	connected: boolean;
}

const MAX_LINES = 5000;

export function useLogs(): LogState {
	const [lines, setLines] = useState<string[]>([]);
	const [connected, setConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const connect = useCallback(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws/logs`);
		wsRef.current = ws;

		ws.onopen = () => setConnected(true);

		ws.onmessage = (event) => {
			const data = event.data as string;
			// Check for disconnect signal
			try {
				const parsed = JSON.parse(data);
				if (parsed.type === "disconnect") {
					setConnected(false);
					return;
				}
			} catch {
				// Not JSON — it's a log line
			}
			setLines((prev) => {
				const next = [...prev, data];
				return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
			});
		};

		ws.onclose = () => {
			setConnected(false);
			wsRef.current = null;
			reconnectTimer.current = setTimeout(connect, 3000);
		};

		ws.onerror = () => {
			ws.close();
		};
	}, []);

	useEffect(() => {
		connect();
		return () => {
			if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
			wsRef.current?.close();
		};
	}, [connect]);

	return { lines, connected };
}
```

- [ ] **Step 2: Create `monitor/src/components/log-viewer.tsx`**

The main log display with auto-scroll, search filter, and color-coded lines.

```tsx
import { useRef, useEffect, useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

interface LogViewerProps {
	lines: string[];
}

function classifyLine(line: string): "error" | "warn" | "info" {
	const lower = line.toLowerCase();
	if (lower.includes("error") || lower.includes("fatal") || lower.includes("err")) return "error";
	if (lower.includes("warn") || lower.includes("warning")) return "warn";
	return "info";
}

const lineColors = {
	error: "text-red-400",
	warn: "text-amber-400",
	info: "text-zinc-300",
} as const;

export function LogViewer({ lines }: LogViewerProps) {
	const [filter, setFilter] = useState("");
	const [autoScroll, setAutoScroll] = useState(true);
	const bottomRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const filteredLines = useMemo(() => {
		if (!filter) return lines;
		const lower = filter.toLowerCase();
		return lines.filter((l) => l.toLowerCase().includes(lower));
	}, [lines, filter]);

	useEffect(() => {
		if (autoScroll && bottomRef.current) {
			bottomRef.current.scrollIntoView({ behavior: "instant" });
		}
	}, [filteredLines, autoScroll]);

	function handleScroll(e: React.UIEvent<HTMLDivElement>) {
		const el = e.currentTarget;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		setAutoScroll(atBottom);
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
				<Input
					placeholder="Filter logs..."
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-200 placeholder:text-zinc-600 max-w-xs"
				/>
				<span className="text-xs text-zinc-600 ml-auto">
					{filteredLines.length} lines
				</span>
			</div>
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="flex-1 overflow-y-auto font-mono text-xs leading-5 p-3"
			>
				{filteredLines.map((line, i) => {
					const level = classifyLine(line);
					return (
						<div key={i} className={`${lineColors[level]} whitespace-pre-wrap break-all`}>
							{line}
						</div>
					);
				})}
				<div ref={bottomRef} />
			</div>
			{!autoScroll && (
				<button
					type="button"
					onClick={() => {
						setAutoScroll(true);
						bottomRef.current?.scrollIntoView({ behavior: "smooth" });
					}}
					className="absolute bottom-6 right-6 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs px-3 py-1.5 rounded-full border border-zinc-700 shadow-lg"
				>
					Jump to bottom
				</button>
			)}
		</div>
	);
}
```

- [ ] **Step 3: Verify build**

Run: `cd monitor && bunx vite build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add monitor/src/lib/use-logs.ts monitor/src/components/log-viewer.tsx
git commit -m "feat(monitor): add log viewer component with WebSocket hook"
```

---

### Task 7: Build the frontend — health card component

**Files:**
- Create: `monitor/src/lib/use-health.ts`
- Create: `monitor/src/components/health-card.tsx`

- [ ] **Step 1: Create `monitor/src/lib/use-health.ts`**

```tsx
import { useEffect, useState } from "react";

export interface HealthData {
	status: "ok" | "degraded" | "error";
	uptime: number;
	timestamp: string;
	activeStrategies: number;
	dailyPnl: number;
	apiSpendToday: number;
	lastQuoteTime: string | null;
	paused: boolean;
}

export interface HealthState {
	data: HealthData | null;
	error: boolean;
}

export function useHealth(intervalMs = 30_000): HealthState {
	const [data, setData] = useState<HealthData | null>(null);
	const [error, setError] = useState(false);

	useEffect(() => {
		async function poll() {
			try {
				const res = await fetch("/api/health");
				if (!res.ok) {
					setError(true);
					setData(null);
					return;
				}
				const json = (await res.json()) as HealthData;
				setData(json);
				setError(false);
			} catch {
				setError(true);
				setData(null);
			}
		}

		poll();
		const id = setInterval(poll, intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);

	return { data, error };
}
```

- [ ] **Step 2: Create `monitor/src/components/health-card.tsx`**

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { HealthState } from "@/lib/use-health";

function formatUptime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function formatPnl(pnl: number): string {
	const sign = pnl >= 0 ? "+" : "";
	return `${sign}${pnl.toFixed(1)}p`;
}

const statusColors = {
	ok: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
	degraded: "bg-amber-500/20 text-amber-400 border-amber-500/30",
	error: "bg-red-500/20 text-red-400 border-red-500/30",
} as const;

export function HealthCard({ data, error }: HealthState) {
	if (error || !data) {
		return (
			<Card className="bg-zinc-900/50 border-zinc-800">
				<CardHeader className="py-2 px-3">
					<CardTitle className="text-xs font-medium text-zinc-400">Health</CardTitle>
				</CardHeader>
				<CardContent className="px-3 pb-2">
					<Badge variant="destructive" className="text-[10px]">Unreachable</Badge>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="bg-zinc-900/50 border-zinc-800">
			<CardHeader className="py-2 px-3">
				<CardTitle className="text-xs font-medium text-zinc-400 flex items-center gap-2">
					Health
					<Badge className={`text-[10px] ${statusColors[data.status]}`}>
						{data.status}
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-3 pb-2">
				<div className="grid grid-cols-4 gap-3 text-[11px]">
					<div>
						<div className="text-zinc-500">Uptime</div>
						<div className="text-zinc-200 font-medium">{formatUptime(data.uptime)}</div>
					</div>
					<div>
						<div className="text-zinc-500">Strategies</div>
						<div className="text-zinc-200 font-medium">{data.activeStrategies}</div>
					</div>
					<div>
						<div className="text-zinc-500">Daily P&L</div>
						<div className={`font-medium ${data.dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
							{formatPnl(data.dailyPnl)}
						</div>
					</div>
					<div>
						<div className="text-zinc-500">API Spend</div>
						<div className="text-zinc-200 font-medium">${data.apiSpendToday.toFixed(2)}</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
```

- [ ] **Step 3: Verify build**

Run: `cd monitor && bunx vite build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add monitor/src/lib/use-health.ts monitor/src/components/health-card.tsx
git commit -m "feat(monitor): add health card component with polling hook"
```

---

### Task 8: Build the frontend — deploy card component

**Files:**
- Create: `monitor/src/lib/use-deploys.ts`
- Create: `monitor/src/components/deploy-card.tsx`

- [ ] **Step 1: Create `monitor/src/lib/use-deploys.ts`**

```tsx
import { useEffect, useState } from "react";

export interface DeployRun {
	id: number;
	status: string;
	conclusion: string | null;
	headSha: string;
	headMessage: string;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
	runDurationMs: number | null;
}

export function useDeploys(intervalMs = 60_000): DeployRun[] {
	const [deploys, setDeploys] = useState<DeployRun[]>([]);

	useEffect(() => {
		async function poll() {
			try {
				const res = await fetch("/api/deploys");
				if (res.ok) {
					setDeploys((await res.json()) as DeployRun[]);
				}
			} catch {
				// Ignore fetch errors
			}
		}

		poll();
		const id = setInterval(poll, intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);

	return deploys;
}
```

- [ ] **Step 2: Create `monitor/src/components/deploy-card.tsx`**

```tsx
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { DeployRun } from "@/lib/use-deploys";

function relativeTime(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatDuration(ms: number | null): string {
	if (!ms) return "-";
	const secs = Math.floor(ms / 1000);
	const m = Math.floor(secs / 60);
	const s = secs % 60;
	return `${m}m ${s}s`;
}

function conclusionBadge(run: DeployRun) {
	if (run.status === "in_progress") {
		return <Badge className="text-[10px] bg-blue-500/20 text-blue-400 border-blue-500/30">running</Badge>;
	}
	if (run.conclusion === "success") {
		return <Badge className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30">passed</Badge>;
	}
	if (run.conclusion === "failure") {
		return <Badge className="text-[10px] bg-red-500/20 text-red-400 border-red-500/30">failed</Badge>;
	}
	return <Badge className="text-[10px] bg-zinc-500/20 text-zinc-400 border-zinc-500/30">{run.conclusion ?? run.status}</Badge>;
}

function DeployRow({ run }: { run: DeployRun }) {
	return (
		<a
			href={run.htmlUrl}
			target="_blank"
			rel="noopener noreferrer"
			className="flex items-center gap-2 text-[11px] py-1 hover:bg-zinc-800/50 rounded px-1 -mx-1"
		>
			{conclusionBadge(run)}
			<code className="text-zinc-400 font-mono">{run.headSha.slice(0, 7)}</code>
			<span className="text-zinc-500 truncate flex-1">{run.headMessage}</span>
			<span className="text-zinc-600 whitespace-nowrap">{formatDuration(run.runDurationMs)}</span>
			<span className="text-zinc-600 whitespace-nowrap">{relativeTime(run.createdAt)}</span>
		</a>
	);
}

export function DeployCard({ deploys }: { deploys: DeployRun[] }) {
	const [open, setOpen] = useState(false);
	const latest = deploys[0];

	if (!latest) {
		return (
			<Card className="bg-zinc-900/50 border-zinc-800">
				<CardHeader className="py-2 px-3">
					<CardTitle className="text-xs font-medium text-zinc-400">Deploys</CardTitle>
				</CardHeader>
				<CardContent className="px-3 pb-2">
					<span className="text-[11px] text-zinc-600">No deploy data</span>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="bg-zinc-900/50 border-zinc-800">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CardHeader className="py-2 px-3">
					<CardTitle className="text-xs font-medium text-zinc-400">
						<CollapsibleTrigger className="flex items-center gap-1 hover:text-zinc-200 cursor-pointer">
							Deploys
							<svg
								className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
							</svg>
						</CollapsibleTrigger>
					</CardTitle>
				</CardHeader>
				<CardContent className="px-3 pb-2">
					<DeployRow run={latest} />
					<CollapsibleContent>
						{deploys.slice(1).map((run) => (
							<DeployRow key={run.id} run={run} />
						))}
					</CollapsibleContent>
				</CardContent>
			</Collapsible>
		</Card>
	);
}
```

- [ ] **Step 3: Verify build**

Run: `cd monitor && bunx vite build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add monitor/src/lib/use-deploys.ts monitor/src/components/deploy-card.tsx
git commit -m "feat(monitor): add deploy card component with collapsible history"
```

---

### Task 9: Assemble the full App layout

**Files:**
- Modify: `monitor/src/App.tsx`

- [ ] **Step 1: Replace `monitor/src/App.tsx` with the full layout**

```tsx
import { useLogs } from "@/lib/use-logs";
import { useHealth } from "@/lib/use-health";
import { useDeploys } from "@/lib/use-deploys";
import { LogViewer } from "@/components/log-viewer";
import { HealthCard } from "@/components/health-card";
import { DeployCard } from "@/components/deploy-card";

export function App() {
	const { lines, connected } = useLogs();
	const health = useHealth();
	const deploys = useDeploys();

	return (
		<div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
			{/* Header */}
			<header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm">
				<div className="flex items-center gap-3">
					<h1 className="text-sm font-semibold tracking-tight">trader-v2</h1>
					<div className="flex items-center gap-1.5">
						<div
							className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]" : "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.5)]"}`}
						/>
						<span className="text-[10px] text-zinc-500">
							{connected ? "streaming" : "disconnected"}
						</span>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<HealthCard {...health} />
					<DeployCard deploys={deploys} />
				</div>
			</header>

			{/* Log viewer */}
			<main className="flex-1 overflow-hidden relative">
				<LogViewer lines={lines} />
			</main>
		</div>
	);
}
```

- [ ] **Step 2: Build and verify**

Run: `cd monitor && bunx vite build`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add monitor/src/App.tsx
git commit -m "feat(monitor): assemble full dashboard layout"
```

---

### Task 10: Add development workflow and production build

**Files:**
- Modify: `monitor/package.json`
- Modify: `package.json` (root)

- [ ] **Step 1: Update `monitor/package.json` scripts**

Add the `serve` script for production mode:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "serve": "bun run build && bun run ../monitor/server.ts"
  }
}
```

- [ ] **Step 2: Update root `package.json` scripts**

Add both dev and production monitor commands:

```json
"monitor": "cd monitor && bun run build && bun run server.ts",
"monitor:dev": "cd monitor && bun run server.ts & bun run dev"
```

- [ ] **Step 3: Test production flow**

Run: `cd monitor && bun run build && bun run server.ts &` then `sleep 1 && curl -s http://localhost:3848/ | head -5` then kill the server.
Expected: HTML response with the React SPA.

- [ ] **Step 4: Test dev flow**

Run: `cd monitor && bun run server.ts &` then `bun run dev &` then `sleep 3 && curl -s http://localhost:5173/ | head -5` then kill both processes.
Expected: Vite dev server response with HMR support, API calls proxied to backend.

- [ ] **Step 5: Commit**

```bash
git add monitor/package.json package.json
git commit -m "feat(monitor): add dev and production run scripts"
```

---

### Task 11: Polish and final integration test

**Files:**
- Modify: `monitor/src/index.css` (add custom styles)
- Modify: `.gitignore` (add monitor/dist)

- [ ] **Step 1: Add custom styles to `monitor/src/index.css`**

```css
@import "tailwindcss";

/* Custom scrollbar for log viewer */
.overflow-y-auto::-webkit-scrollbar {
	width: 6px;
}
.overflow-y-auto::-webkit-scrollbar-track {
	background: transparent;
}
.overflow-y-auto::-webkit-scrollbar-thumb {
	background: #3f3f46;
	border-radius: 3px;
}
.overflow-y-auto::-webkit-scrollbar-thumb:hover {
	background: #52525b;
}
```

- [ ] **Step 2: Add `monitor/dist` to `.gitignore`**

Add to root `.gitignore`:

```
monitor/dist/
monitor/node_modules/
```

- [ ] **Step 3: Full integration test**

Run the full production flow:

```bash
cd monitor && bun install && bun run build && bun run server.ts
```

Then open `http://localhost:3848` in a browser and verify:
1. Health card shows data (or "Unreachable" if VPS is down)
2. Deploy card shows recent GitHub Actions runs
3. Log viewer streams live logs (or shows disconnect if SSH fails)
4. Filter input works
5. Auto-scroll works, "jump to bottom" button appears when scrolled up

- [ ] **Step 4: Commit**

```bash
git add monitor/src/index.css .gitignore
git commit -m "feat(monitor): polish scrollbar styles and finalize gitignore"
```
