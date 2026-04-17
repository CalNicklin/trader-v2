import { describe, expect, test } from "bun:test";
import { SEED_STRATEGIES } from "../../src/strategy/seed.ts";

describe("news_sentiment_mr_v1 seed parameters (Proposal #11)", () => {
	const seed = SEED_STRATEGIES.find((s) => s.name === "news_sentiment_mr_v1");

	test("seed entry exists", () => {
		expect(seed).toBeDefined();
	});

	test("parsed parameters include signal_polarity: contrarian", () => {
		const params = JSON.parse(seed!.parameters);
		expect(params.signal_polarity).toBe("contrarian");
	});

	test("parsed parameters include all expected numeric keys", () => {
		const params = JSON.parse(seed!.parameters);
		const expectedNumericKeys = [
			"sentiment_threshold",
			"rsi_oversold",
			"rsi_overbought",
			"hold_days",
			"position_size_pct",
		];
		for (const key of expectedNumericKeys) {
			expect(params).toHaveProperty(key);
			expect(typeof params[key]).toBe("number");
		}
	});
});
