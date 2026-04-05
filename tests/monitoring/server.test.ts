import { describe, expect, test, afterEach, beforeEach } from "bun:test";
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

		const data = await res.json();
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
});
