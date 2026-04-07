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
