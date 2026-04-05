import { describe, expect, test } from "bun:test";

describe("live executor", () => {
	test("runLiveExecutor returns early when LIVE_TRADING_ENABLED=false", async () => {
		// Default test env has LIVE_TRADING_ENABLED=false
		const { runLiveExecutor } = await import("../../src/live/executor.ts");
		const result = await runLiveExecutor();
		expect(result.strategiesEvaluated).toBe(0);
		expect(result.tradesPlaced).toBe(0);
	});
});
