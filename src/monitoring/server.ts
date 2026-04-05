import type { Server } from "bun";
import { getHealthData } from "./health";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "http-server" });

let _server: Server | null = null;

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

async function handleRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);

	if (req.method === "GET" && url.pathname === "/health") {
		const data = await getHealthData();
		return Response.json(data);
	}

	return new Response("Not Found", { status: 404 });
}
