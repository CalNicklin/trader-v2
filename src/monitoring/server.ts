import type { Server } from "bun";
import { getConfig } from "../config";
import { createChildLogger } from "../utils/logger";
import {
	getDashboardData,
	getGuardianData,
	getLearningLoopData,
	getNewsPipelineData,
	getTradeActivityData,
} from "./dashboard-data";
import { getHealthData, setPaused } from "./health";
import {
	buildConsolePage,
	buildGuardianTab,
	buildLearningLoopTab,
	buildNewsPipelineTab,
	buildTradeActivityTab,
} from "./status-page";

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
			const validTabs = ["overview", "news", "guardian", "learning", "trades"];
			const tab = validTabs.includes(url.searchParams.get("tab") ?? "")
				? (url.searchParams.get("tab") as string)
				: "overview";

			let tabHtml = "";
			if (tab === "news") {
				const tabData = await getNewsPipelineData();
				tabHtml = buildNewsPipelineTab(tabData);
			} else if (tab === "guardian") {
				const tabData = await getGuardianData();
				tabHtml = buildGuardianTab(tabData);
			} else if (tab === "learning") {
				const tabData = await getLearningLoopData();
				tabHtml = buildLearningLoopTab(tabData);
			} else if (tab === "trades") {
				const tabData = await getTradeActivityData();
				tabHtml = buildTradeActivityTab(tabData);
			}

			const data = await getDashboardData();
			const html = buildConsolePage(data, tab, tabHtml);
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
		const pauseTab = url.searchParams.get("tab");
		const pauseRedirect = pauseTab ? `/?tab=${pauseTab}` : "/";
		return new Response(null, {
			status: 303,
			headers: { location: pauseRedirect },
		});
	}

	// Resume trading
	if (req.method === "POST" && url.pathname === "/resume") {
		setPaused(false);
		log.info("Trading resumed via HTTP");
		const resumeTab = url.searchParams.get("tab");
		const resumeRedirect = resumeTab ? `/?tab=${resumeTab}` : "/";
		return new Response(null, {
			status: 303,
			headers: { location: resumeRedirect },
		});
	}

	return new Response("Not Found", { status: 404 });
}
