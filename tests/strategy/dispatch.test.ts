import { describe, expect, test } from "bun:test";
import { type DispatchDecision, parseDispatchResponse } from "../../src/strategy/dispatch";

describe("dispatch response parsing", () => {
	test("parses valid dispatch JSON", () => {
		const response = JSON.stringify({
			decisions: [
				{
					strategyId: 1,
					symbol: "AAPL",
					action: "activate",
					reasoning: "High momentum regime matches trend strategy",
				},
				{
					strategyId: 2,
					symbol: "SHEL:LSE",
					action: "skip",
					reasoning: "Low volume breadth — mean reversion unlikely to fire",
				},
			],
		});
		const result = parseDispatchResponse(response);
		expect(result).toHaveLength(2);
		expect(result[0].strategyId).toBe(1);
		expect(result[0].action).toBe("activate");
	});

	test("rejects decision referencing unknown strategy ID", () => {
		const response = JSON.stringify({
			decisions: [{ strategyId: 999, symbol: "AAPL", action: "activate", reasoning: "test" }],
		});
		const validStrategyIds = new Set([1, 2, 3]);
		const result = parseDispatchResponse(response, validStrategyIds);
		expect(result).toHaveLength(0);
	});

	test("handles malformed JSON gracefully", () => {
		const result = parseDispatchResponse("not json at all");
		expect(result).toHaveLength(0);
	});
});

describe("dispatch decision types", () => {
	test("DispatchDecision has required fields", () => {
		const decision: DispatchDecision = {
			strategyId: 1,
			symbol: "AAPL",
			action: "activate",
			reasoning: "test",
		};
		expect(decision.action).toBe("activate");
	});
});
