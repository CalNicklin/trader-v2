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

	test("parseClassificationResponse extracts signal fields", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		const response = JSON.stringify({
			tradeable: true,
			sentiment: 0.8,
			confidence: 0.9,
			event_type: "earnings_beat",
			urgency: "high",
			signals: {
				earnings_surprise: 0.9,
				guidance_change: 0.3,
				management_tone: 0.7,
				regulatory_risk: 0.0,
				acquisition_likelihood: 0.0,
				catalyst_type: "fundamental",
				expected_move_duration: "1-3d",
			},
		});

		const result = parseClassificationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.signals).toBeDefined();
		expect(result!.signals!.earningsSurprise).toBeCloseTo(0.9);
		expect(result!.signals!.guidanceChange).toBeCloseTo(0.3);
		expect(result!.signals!.managementTone).toBeCloseTo(0.7);
		expect(result!.signals!.regulatoryRisk).toBeCloseTo(0.0);
		expect(result!.signals!.acquisitionLikelihood).toBeCloseTo(0.0);
		expect(result!.signals!.catalystType).toBe("fundamental");
		expect(result!.signals!.expectedMoveDuration).toBe("1-3d");
	});

	test("parseClassificationResponse handles missing signals gracefully", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		const response = JSON.stringify({
			tradeable: true,
			sentiment: 0.5,
			confidence: 0.7,
			event_type: "upgrade",
			urgency: "medium",
		});

		const result = parseClassificationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.signals).toBeNull();
	});

	test("parseClassificationResponse clamps signal scores to [0, 1]", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		const response = JSON.stringify({
			tradeable: true,
			sentiment: 0.8,
			confidence: 0.9,
			event_type: "earnings_beat",
			urgency: "high",
			signals: {
				earnings_surprise: 1.5,
				guidance_change: -0.2,
				management_tone: 0.7,
				regulatory_risk: 0.0,
				acquisition_likelihood: 0.0,
				catalyst_type: "fundamental",
				expected_move_duration: "1-3d",
			},
		});

		const result = parseClassificationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.signals!.earningsSurprise).toBe(1.0);
		expect(result!.signals!.guidanceChange).toBe(0.0);
	});

	test("parseClassificationResponse validates catalyst_type enum", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		const response = JSON.stringify({
			tradeable: true,
			sentiment: 0.8,
			confidence: 0.9,
			event_type: "earnings_beat",
			urgency: "high",
			signals: {
				earnings_surprise: 0.9,
				guidance_change: 0.3,
				management_tone: 0.7,
				regulatory_risk: 0.0,
				acquisition_likelihood: 0.0,
				catalyst_type: "invalid_type",
				expected_move_duration: "1-3d",
			},
		});

		const result = parseClassificationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.signals!.catalystType).toBe("other");
	});
});
