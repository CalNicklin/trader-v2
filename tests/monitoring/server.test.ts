import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer, stopServer } from "../../src/monitoring/server";

describe("HTTP server", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	afterEach(() => {
		stopServer();
	});

	test("GET /health returns JSON health data", async () => {
		const port = 39847;
		startServer(port);

		const res = await fetch(`http://localhost:${port}/health`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const data = (await res.json()) as Record<string, unknown>;
		expect(data.status).toBe("ok");
		expect(data.uptime).toBeGreaterThan(0);
		expect(data.activeStrategies).toBeTypeOf("number");
		expect(data.timestamp).toBeDefined();
	});

	test("GET /unknown returns 404", async () => {
		const port = 39848;
		startServer(port);

		const res = await fetch(`http://localhost:${port}/unknown`);
		expect(res.status).toBe(404);
	});

	test("GET / returns HTML status page", async () => {
		const port = 39849;
		startServer(port);

		const res = await fetch(`http://localhost:${port}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");

		const html = await res.text();
		expect(html).toContain("Trader v2");
	});

	test("POST /pause sets paused state and redirects", async () => {
		const port = 39850;
		startServer(port);

		const res = await fetch(`http://localhost:${port}/pause`, {
			method: "POST",
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/");

		// Confirm paused via health endpoint
		const health = await fetch(`http://localhost:${port}/health`);
		const data = (await health.json()) as Record<string, unknown>;
		expect(data.paused).toBe(true);
	});

	test("POST /resume clears paused state and redirects", async () => {
		const port = 39851;
		startServer(port);

		// First pause
		await fetch(`http://localhost:${port}/pause`, { method: "POST", redirect: "manual" });

		// Then resume
		const res = await fetch(`http://localhost:${port}/resume`, {
			method: "POST",
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/");

		const health = await fetch(`http://localhost:${port}/health`);
		const data = (await health.json()) as Record<string, unknown>;
		expect(data.paused).toBe(false);
	});

	test("returns 401 when ADMIN_PASSWORD is set and no credentials given", async () => {
		const port = 39852;
		// Temporarily set password in env
		process.env.ADMIN_PASSWORD = "secret";
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		startServer(port);

		const res = await fetch(`http://localhost:${port}/`);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Basic");

		// Clean up
		delete process.env.ADMIN_PASSWORD;
		resetConfigForTesting();
	});
});
