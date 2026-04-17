import { describe, expect, test } from "bun:test";
import { CRON_SCHEDULE, getNextCronOccurrences } from "../../src/monitoring/cron-schedule.ts";

describe("cron-schedule", () => {
	test("CRON_SCHEDULE contains all 30 jobs", () => {
		expect(Object.keys(CRON_SCHEDULE).length).toBe(30);
	});

	test("CRON_SCHEDULE has required fields", () => {
		for (const [name, entry] of Object.entries(CRON_SCHEDULE)) {
			expect(entry.cron).toBeDefined();
			expect(typeof entry.cron).toBe("string");
			expect(name.length).toBeGreaterThan(0);
		}
	});

	test("getNextCronOccurrences returns sorted results", () => {
		const results = getNextCronOccurrences();
		expect(results.length).toBe(30);

		// Should be sorted by nextRun ascending
		for (let i = 1; i < results.length; i++) {
			expect(new Date(results[i]!.nextRun).getTime()).toBeGreaterThanOrEqual(
				new Date(results[i - 1]!.nextRun).getTime(),
			);
		}
	});

	test("each result has name, nextRun, and nextRunIn", () => {
		const results = getNextCronOccurrences();
		for (const r of results) {
			expect(r.name).toBeDefined();
			expect(r.nextRun).toBeDefined();
			expect(r.nextRunIn).toBeDefined();
			// nextRunIn should be a human-readable string like "2h 15m"
			expect(r.nextRunIn).toMatch(/\d+[hm]/);
		}
	});
});
