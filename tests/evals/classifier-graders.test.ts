import { describe, expect, test } from "bun:test";

describe("classifier graders", () => {
	test("tradeableGrader passes when tradeable matches", async () => {
		const { tradeableGrader } = await import("../../src/evals/classifier/graders.ts");

		const pass = await tradeableGrader.grade(
			{
				tradeable: true,
				sentiment: 0.5,
				confidence: 0.8,
				eventType: "earnings_beat",
				urgency: "high",
				signals: null,
			},
			{
				tradeable: true,
				sentimentDirection: "positive",
				sentimentMin: 0.3,
				sentimentMax: 0.8,
				expectedEventTypes: ["earnings_beat"],
				expectedUrgency: "high",
			},
		);
		expect(pass.pass).toBe(true);
	});

	test("tradeableGrader fails when tradeable mismatches", async () => {
		const { tradeableGrader } = await import("../../src/evals/classifier/graders.ts");

		const fail = await tradeableGrader.grade(
			{
				tradeable: false,
				sentiment: 0.5,
				confidence: 0.8,
				eventType: "earnings_beat",
				urgency: "high",
				signals: null,
			},
			{
				tradeable: true,
				sentimentDirection: "positive",
				sentimentMin: 0.3,
				sentimentMax: 0.8,
				expectedEventTypes: ["earnings_beat"],
				expectedUrgency: "high",
			},
		);
		expect(fail.pass).toBe(false);
	});

	test("sentimentRangeGrader passes when sentiment in range", async () => {
		const { sentimentRangeGrader } = await import("../../src/evals/classifier/graders.ts");

		const result = await sentimentRangeGrader.grade(
			{
				tradeable: true,
				sentiment: 0.6,
				confidence: 0.8,
				eventType: "earnings_beat",
				urgency: "high",
				signals: null,
			},
			{
				tradeable: true,
				sentimentDirection: "positive",
				sentimentMin: 0.3,
				sentimentMax: 0.8,
				expectedEventTypes: ["earnings_beat"],
				expectedUrgency: "high",
			},
		);
		expect(result.pass).toBe(true);
	});

	test("sentimentRangeGrader fails when sentiment out of range", async () => {
		const { sentimentRangeGrader } = await import("../../src/evals/classifier/graders.ts");

		const result = await sentimentRangeGrader.grade(
			{
				tradeable: true,
				sentiment: -0.5,
				confidence: 0.8,
				eventType: "earnings_beat",
				urgency: "high",
				signals: null,
			},
			{
				tradeable: true,
				sentimentDirection: "positive",
				sentimentMin: 0.3,
				sentimentMax: 0.8,
				expectedEventTypes: ["earnings_beat"],
				expectedUrgency: "high",
			},
		);
		expect(result.pass).toBe(false);
	});

	test("eventTypeGrader passes when event type is in expected set", async () => {
		const { eventTypeGrader } = await import("../../src/evals/classifier/graders.ts");

		const result = await eventTypeGrader.grade(
			{
				tradeable: true,
				sentiment: 0.6,
				confidence: 0.8,
				eventType: "earnings_beat",
				urgency: "high",
				signals: null,
			},
			{
				tradeable: true,
				sentimentDirection: "positive",
				sentimentMin: 0.3,
				sentimentMax: 0.8,
				expectedEventTypes: ["earnings_beat", "other"],
				expectedUrgency: "high",
			},
		);
		expect(result.pass).toBe(true);
	});

	test("eventTypeGrader fails when event type not in expected set", async () => {
		const { eventTypeGrader } = await import("../../src/evals/classifier/graders.ts");

		const result = await eventTypeGrader.grade(
			{
				tradeable: true,
				sentiment: 0.6,
				confidence: 0.8,
				eventType: "fda_approval",
				urgency: "high",
				signals: null,
			},
			{
				tradeable: true,
				sentimentDirection: "positive",
				sentimentMin: 0.3,
				sentimentMax: 0.8,
				expectedEventTypes: ["earnings_beat"],
				expectedUrgency: "high",
			},
		);
		expect(result.pass).toBe(false);
	});

	test("urgencyGrader passes on match", async () => {
		const { urgencyGrader } = await import("../../src/evals/classifier/graders.ts");

		const result = await urgencyGrader.grade(
			{
				tradeable: true,
				sentiment: 0.6,
				confidence: 0.8,
				eventType: "earnings_beat",
				urgency: "high",
				signals: null,
			},
			{
				tradeable: true,
				sentimentDirection: "positive",
				sentimentMin: 0.3,
				sentimentMax: 0.8,
				expectedEventTypes: ["earnings_beat"],
				expectedUrgency: "high",
			},
		);
		expect(result.pass).toBe(true);
	});

	test("jsonShapeGrader passes for valid output", async () => {
		const { jsonShapeGrader } = await import("../../src/evals/classifier/graders.ts");

		const result = await jsonShapeGrader.grade(
			{
				tradeable: true,
				sentiment: 0.6,
				confidence: 0.8,
				eventType: "earnings_beat",
				urgency: "high",
				signals: null,
			},
			{
				tradeable: true,
				sentimentDirection: "positive",
				sentimentMin: 0.3,
				sentimentMax: 0.8,
				expectedEventTypes: ["earnings_beat"],
				expectedUrgency: "high",
			},
		);
		expect(result.pass).toBe(true);
	});
});
