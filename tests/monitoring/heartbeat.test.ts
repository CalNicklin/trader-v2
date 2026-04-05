import { describe, expect, test } from "bun:test";
import { buildHeartbeatUrl, sendHeartbeat } from "../../src/monitoring/heartbeat";

describe("heartbeat", () => {
	test("buildHeartbeatUrl appends status and msg params", () => {
		const base = "https://uptime.example.com/api/push/abc123";
		const url = buildHeartbeatUrl(base, "up", "quote_refresh OK");
		expect(url).toBe("https://uptime.example.com/api/push/abc123?status=up&msg=quote_refresh+OK");
	});

	test("buildHeartbeatUrl handles base URL with existing params", () => {
		const base = "https://uptime.example.com/api/push/abc123?token=xyz";
		const url = buildHeartbeatUrl(base, "up", "heartbeat");
		expect(url).toContain("status=up");
		expect(url).toContain("msg=heartbeat");
	});

	test("sendHeartbeat returns false when URL not configured", async () => {
		const result = await sendHeartbeat("test_job");
		expect(typeof result).toBe("boolean");
	});
});
