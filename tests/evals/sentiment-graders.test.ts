import { describe, expect, test } from "bun:test";

describe("sentiment graders", () => {
	describe("directionAccuracyGrader", () => {
		test("positive sentiment + price up → score 1, pass true", async () => {
			const { directionAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await directionAccuracyGrader.grade(
				{ sentiment: 0.7, confidence: 0.8, expectedMoveDuration: "1-3d" },
				{ actualPriceChangePct: 4.5, actualDirection: "up", actualMoveDurationDays: 2 },
			);

			expect(result.score).toBe(1);
			expect(result.pass).toBe(true);
		});

		test("positive sentiment + price down → score 0, pass false", async () => {
			const { directionAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await directionAccuracyGrader.grade(
				{ sentiment: 0.6, confidence: 0.75, expectedMoveDuration: "1-3d" },
				{ actualPriceChangePct: -3.2, actualDirection: "down", actualMoveDurationDays: 1 },
			);

			expect(result.score).toBe(0);
			expect(result.pass).toBe(false);
		});

		test("flat actual direction → score 0.5, pass true", async () => {
			const { directionAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await directionAccuracyGrader.grade(
				{ sentiment: 0.4, confidence: 0.6, expectedMoveDuration: "intraday" },
				{ actualPriceChangePct: 0.1, actualDirection: "flat", actualMoveDurationDays: 0 },
			);

			expect(result.score).toBe(0.5);
			expect(result.pass).toBe(true);
		});

		test("negative sentiment + price down → score 1, pass true", async () => {
			const { directionAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await directionAccuracyGrader.grade(
				{ sentiment: -0.8, confidence: 0.9, expectedMoveDuration: "1-2w" },
				{ actualPriceChangePct: -7.5, actualDirection: "down", actualMoveDurationDays: 8 },
			);

			expect(result.score).toBe(1);
			expect(result.pass).toBe(true);
		});
	});

	describe("magnitudeCalibrationGrader", () => {
		test("high confidence + large move → score >0.5, pass true", async () => {
			const { magnitudeCalibrationGrader } = await import("../../src/evals/sentiment/graders.ts");

			// confidence=0.85 (high), move=8% (>=3% threshold)
			const result = await magnitudeCalibrationGrader.grade(
				{ sentiment: 0.8, confidence: 0.85, expectedMoveDuration: "1-3d" },
				{ actualPriceChangePct: 8.0, actualDirection: "up", actualMoveDurationDays: 2 },
			);

			expect(result.score).toBeGreaterThan(0.5);
			expect(result.pass).toBe(true);
		});

		test("high confidence + tiny move → score <0.5, pass false", async () => {
			const { magnitudeCalibrationGrader } = await import("../../src/evals/sentiment/graders.ts");

			// confidence=0.9 (high), move=0.5% (<3% threshold)
			const result = await magnitudeCalibrationGrader.grade(
				{ sentiment: 0.8, confidence: 0.9, expectedMoveDuration: "1-3d" },
				{ actualPriceChangePct: 0.5, actualDirection: "up", actualMoveDurationDays: 1 },
			);

			expect(result.score).toBeLessThan(0.5);
			expect(result.pass).toBe(false);
		});

		test("medium confidence + 1.5% move → pass true", async () => {
			const { magnitudeCalibrationGrader } = await import("../../src/evals/sentiment/graders.ts");

			// confidence=0.65 (medium), move=1.5% (>=1% threshold)
			const result = await magnitudeCalibrationGrader.grade(
				{ sentiment: 0.5, confidence: 0.65, expectedMoveDuration: "1-2w" },
				{ actualPriceChangePct: 1.5, actualDirection: "up", actualMoveDurationDays: 7 },
			);

			expect(result.pass).toBe(true);
		});

		test("low confidence + any move → pass true", async () => {
			const { magnitudeCalibrationGrader } = await import("../../src/evals/sentiment/graders.ts");

			// confidence=0.4 (low), any move size is acceptable
			const result = await magnitudeCalibrationGrader.grade(
				{ sentiment: 0.3, confidence: 0.4, expectedMoveDuration: "intraday" },
				{ actualPriceChangePct: 0.2, actualDirection: "up", actualMoveDurationDays: 0 },
			);

			expect(result.pass).toBe(true);
		});
	});

	describe("durationAccuracyGrader", () => {
		test("intraday prediction, 0-day move → pass", async () => {
			const { durationAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await durationAccuracyGrader.grade(
				{ sentiment: 0.5, confidence: 0.7, expectedMoveDuration: "intraday" },
				{ actualPriceChangePct: 2.0, actualDirection: "up", actualMoveDurationDays: 0 },
			);

			expect(result.pass).toBe(true);
			expect(result.score).toBe(1);
		});

		test("1-3d prediction, 2-day move → pass", async () => {
			const { durationAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await durationAccuracyGrader.grade(
				{ sentiment: 0.6, confidence: 0.8, expectedMoveDuration: "1-3d" },
				{ actualPriceChangePct: 3.5, actualDirection: "up", actualMoveDurationDays: 2 },
			);

			expect(result.pass).toBe(true);
		});

		test("1-2w prediction, 10-day move → pass", async () => {
			const { durationAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await durationAccuracyGrader.grade(
				{ sentiment: 0.7, confidence: 0.75, expectedMoveDuration: "1-2w" },
				{ actualPriceChangePct: 5.0, actualDirection: "up", actualMoveDurationDays: 10 },
			);

			expect(result.pass).toBe(true);
		});

		test("1m+ prediction, 30-day move → pass", async () => {
			const { durationAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await durationAccuracyGrader.grade(
				{ sentiment: 0.5, confidence: 0.6, expectedMoveDuration: "1m+" },
				{ actualPriceChangePct: 12.0, actualDirection: "up", actualMoveDurationDays: 30 },
			);

			expect(result.pass).toBe(true);
		});

		test("intraday prediction, 5-day move → fail", async () => {
			const { durationAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await durationAccuracyGrader.grade(
				{ sentiment: 0.5, confidence: 0.7, expectedMoveDuration: "intraday" },
				{ actualPriceChangePct: 2.0, actualDirection: "up", actualMoveDurationDays: 5 },
			);

			expect(result.pass).toBe(false);
			expect(result.score).toBe(0);
		});

		test("1-3d prediction, 15-day move → fail", async () => {
			const { durationAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await durationAccuracyGrader.grade(
				{ sentiment: 0.6, confidence: 0.8, expectedMoveDuration: "1-3d" },
				{ actualPriceChangePct: 4.0, actualDirection: "up", actualMoveDurationDays: 15 },
			);

			expect(result.pass).toBe(false);
		});

		test("unknown duration → fail with reason", async () => {
			const { durationAccuracyGrader } = await import("../../src/evals/sentiment/graders.ts");

			const result = await durationAccuracyGrader.grade(
				{ sentiment: 0.5, confidence: 0.7, expectedMoveDuration: "unknown-value" },
				{ actualPriceChangePct: 2.0, actualDirection: "up", actualMoveDurationDays: 1 },
			);

			expect(result.pass).toBe(false);
			expect(result.reason).toContain("Unknown");
		});
	});
});
