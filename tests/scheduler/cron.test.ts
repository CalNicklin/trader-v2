import { describe, expect, test } from "bun:test";

describe("scheduler", () => {
	test("jobs module exports runJob function", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		expect(typeof runJob).toBe("function");
	});

	test("runJob handles quote_refresh job", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		// Should not throw — quote_refresh with no symbols just logs and returns
		await runJob("quote_refresh");
	});
});
