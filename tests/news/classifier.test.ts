import { describe, expect, test } from "bun:test";

describe("news classifier", () => {
	test("buildClassificationPrompt returns valid prompt", async () => {
		const { buildClassificationPrompt } = await import("../../src/news/classifier.ts");

		const prompt = buildClassificationPrompt("Apple beats Q4 earnings estimates", "AAPL");
		expect(prompt).toContain("Apple beats Q4 earnings estimates");
		expect(prompt).toContain("AAPL");
		expect(prompt).toContain("JSON");
	});

	test("parseClassificationResponse extracts valid result", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		const response = JSON.stringify({
			tradeable: true,
			sentiment: 0.8,
			confidence: 0.9,
			event_type: "earnings_beat",
			urgency: "high",
		});

		const result = parseClassificationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.tradeable).toBe(true);
		expect(result!.sentiment).toBeCloseTo(0.8);
		expect(result!.confidence).toBeCloseTo(0.9);
		expect(result!.eventType).toBe("earnings_beat");
		expect(result!.urgency).toBe("high");
	});

	test("parseClassificationResponse returns null for invalid JSON", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		expect(parseClassificationResponse("not json")).toBeNull();
		expect(parseClassificationResponse('{"tradeable": "maybe"}')).toBeNull();
	});

	test("parseClassificationResponse clamps sentiment to [-1, 1]", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		const response = JSON.stringify({
			tradeable: true,
			sentiment: 5.0,
			confidence: 0.5,
			event_type: "other",
			urgency: "low",
		});

		const result = parseClassificationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.sentiment).toBe(1.0);
	});
});
