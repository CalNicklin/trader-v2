import type { Server } from "bun";
import { getConfig } from "../config";
import { createChildLogger } from "../utils/logger";
import { getDashboardData } from "./dashboard-data";
import { getHealthData, setPaused } from "./health";
import { buildConsolePage } from "./status-page";

const log = createChildLogger({ module: "http-server" });

let _server: Server<unknown> | null = null;

export function startServer(port: number): void {
	if (_server) return;

	_server = Bun.serve({
		port,
		fetch: handleRequest,
	});

	log.info({ port }, "HTTP server started");
}

export function stopServer(): void {
	if (_server) {
		_server.stop(true);
		_server = null;
		log.info("HTTP server stopped");
	}
}

export function checkBasicAuth(req: Request): boolean {
	const config = getConfig();
	if (!config.ADMIN_PASSWORD) return true;

	const authHeader = req.headers.get("authorization");
	if (!authHeader?.startsWith("Basic ")) return false;

	const encoded = authHeader.slice("Basic ".length);
	const decoded = Buffer.from(encoded, "base64").toString("utf-8");
	// Accept either "admin:<password>" or just ":<password>" or "<password>"
	const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
	return password === config.ADMIN_PASSWORD;
}

async function handleRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);

	// Health endpoint — unauthenticated
	if (req.method === "GET" && url.pathname === "/health") {
		try {
			const data = await getHealthData();
			return Response.json(data);
		} catch (err) {
			log.error({ err }, "Health check failed");
			return Response.json({ status: "error" }, { status: 500 });
		}
	}

	// All other routes require auth
	if (!checkBasicAuth(req)) {
		return new Response("Unauthorized", {
			status: 401,
			headers: { "WWW-Authenticate": 'Basic realm="Trader v2"' },
		});
	}

	// Dashboard console
	if (req.method === "GET" && url.pathname === "/") {
		try {
			const data = await getDashboardData();
			const html = buildConsolePage(data);
			return new Response(html, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		} catch (err) {
			log.error({ err }, "Dashboard page failed");
			return new Response("Internal Server Error", { status: 500 });
		}
	}

	// Dashboard API (JSON)
	if (req.method === "GET" && url.pathname === "/api/dashboard") {
		try {
			const data = await getDashboardData();
			return Response.json(data);
		} catch (err) {
			log.error({ err }, "Dashboard API failed");
			return Response.json({ error: "internal" }, { status: 500 });
		}
	}

	// Pause trading
	if (req.method === "POST" && url.pathname === "/pause") {
		setPaused(true);
		log.warn("Trading paused via HTTP");
		return new Response(null, {
			status: 303,
			headers: { location: "/" },
		});
	}

	// Resume trading
	if (req.method === "POST" && url.pathname === "/resume") {
		setPaused(false);
		log.info("Trading resumed via HTTP");
		return new Response(null, {
			status: 303,
			headers: { location: "/" },
		});
	}

	return new Response("Not Found", { status: 404 });
}
