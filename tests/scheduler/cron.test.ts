// tests/scheduler/cron.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { isLocked, resetAllLocks } from "../../src/scheduler/locks";

describe("scheduler", () => {
	beforeEach(() => {
		resetAllLocks();
	});

	test("jobs module exports runJob function", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		expect(typeof runJob).toBe("function");
	});

	test("runJob acquires and releases category lock", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		await runJob("quote_refresh_uk");
		expect(isLocked("quotes_uk")).toBe(false);
	});

	test("runJob skips if category lock is held", async () => {
		const { acquireLock } = await import("../../src/scheduler/locks");
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		acquireLock("quotes_uk");
		await runJob("quote_refresh_uk");
		expect(isLocked("quotes_uk")).toBe(true);
	});

	test("jobs in different categories can run concurrently", async () => {
		const { acquireLock } = await import("../../src/scheduler/locks");
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		acquireLock("quotes_uk");
		await runJob("quote_refresh_us");
		expect(isLocked("quotes_us")).toBe(false);
		expect(isLocked("quotes_uk")).toBe(true);
	});
});

describe("watchlist cron registration", () => {
	test("runJob accepts each new watchlist job name without throwing", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		// Each should run (or safely skip) without crashing the runner
		// These calls may run actual job bodies in-memory DB; errors inside the
		// job are caught by runJob. We only assert no uncaught throws.
		await runJob("volume_catalyst_us");
		await runJob("volume_catalyst_uk");
		await runJob("watchlist_demote");
		await runJob("watchlist_enrich");
	});

	test("cron-schedule mirror contains watchlist entries", async () => {
		const { CRON_SCHEDULE } = await import("../../src/monitoring/cron-schedule.ts");
		expect(CRON_SCHEDULE.earnings_catalyst).toBeDefined();
		expect(CRON_SCHEDULE.watchlist_demote).toBeDefined();
		expect(CRON_SCHEDULE.watchlist_enrich_post_close).toBeDefined();
	});
});
