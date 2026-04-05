import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "./server/config.ts";
import { fetchHealth } from "./server/health.ts";

const config = loadConfig();

const distDir = join(import.meta.dir, "dist");
const isDev = !existsSync(join(distDir, "index.html"));

if (isDev) {
	console.log(
		"No production build found. Use Vite dev server (bun run dev) with proxy for development.",
	);
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
			const filePath = join(
				distDir,
				url.pathname === "/" ? "index.html" : url.pathname,
			);
			const file = Bun.file(filePath);
			if (await file.exists()) return new Response(file);
			// SPA fallback
			return new Response(Bun.file(join(distDir, "index.html")));
		}

		return new Response("Not found", { status: 404 });
	},
});

console.log(`Monitor server running at http://localhost:${server.port}`);
