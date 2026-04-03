import { beforeEach, describe, expect, test } from "bun:test";

// Reset module cache between tests so config re-parses
beforeEach(() => {
	// Config caches on first call — we test via env vars set in preload.ts
});

describe("getConfig", () => {
	test("parses required env vars from preload", async () => {
		const { getConfig } = await import("../src/config.ts");
		const config = getConfig();
		expect(config.ANTHROPIC_API_KEY).toBe("test-key");
		expect(config.NODE_ENV).toBe("test");
		expect(config.DB_PATH).toBe(":memory:");
	});

	test("applies defaults for optional vars", async () => {
		const { getConfig } = await import("../src/config.ts");
		const config = getConfig();
		expect(config.DAILY_API_BUDGET_USD).toBe(0);
		expect(config.LOG_LEVEL).toBe("error");
		expect(config.CLAUDE_MODEL_FAST).toContain("haiku");
	});
});
