import { describe, expect, test } from "bun:test";
import type { HealthData } from "../../src/monitoring/health";
import { buildStatusPageHtml } from "../../src/monitoring/status-page";

const baseData: HealthData = {
	status: "ok",
	uptime: 3661,
	timestamp: new Date().toISOString(),
	activeStrategies: 5,
	dailyPnl: 120.5,
	apiSpendToday: 0.0234,
	lastQuoteTime: new Date().toISOString(),
	paused: false,
};

describe("buildStatusPageHtml", () => {
	test("renders HTML with system status", () => {
		const html = buildStatusPageHtml(baseData);
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("Trader v2");
		expect(html).toContain("OK");
		expect(html).toContain("5"); // activeStrategies
		expect(html).toContain("0.0234");
	});

	test("shows pause button when not paused", () => {
		const html = buildStatusPageHtml({ ...baseData, paused: false });
		expect(html).toContain('action="/pause"');
		expect(html).toContain("Pause Trading");
		expect(html).not.toContain('action="/resume"');
	});

	test("shows resume button when paused", () => {
		const html = buildStatusPageHtml({ ...baseData, paused: true });
		expect(html).toContain('action="/resume"');
		expect(html).toContain("Resume Trading");
		expect(html).not.toContain('action="/pause"');
	});

	test("formats uptime in hours and minutes", () => {
		// 3661 seconds = 1h 1m
		const html = buildStatusPageHtml({ ...baseData, uptime: 3661 });
		expect(html).toContain("1h 1m");
	});

	test("formats uptime in minutes only when under one hour", () => {
		// 185 seconds = 3m
		const html = buildStatusPageHtml({ ...baseData, uptime: 185 });
		expect(html).toContain("3m");
		expect(html).not.toContain("0h");
	});
});
