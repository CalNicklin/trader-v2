import { describe, expect, test } from "bun:test";
import { gradeAlignment, gradeShape } from "../../src/evals/watchlist-enrichment/graders.ts";
import type { EnrichmentPayload } from "../../src/watchlist/enrich.ts";

describe("gradeShape", () => {
	test("passes with valid payload", () => {
		const payload: EnrichmentPayload = {
			catalystSummary: "Apple beat Q2 earnings",
			directionalBias: "long",
			horizon: "days",
			status: "active",
		};
		expect(gradeShape(payload).passed).toBe(true);
	});

	test("fails with null payload", () => {
		expect(gradeShape(null).passed).toBe(false);
	});

	test("fails with short summary", () => {
		const payload: EnrichmentPayload = {
			catalystSummary: "x",
			directionalBias: "long",
			horizon: "days",
			status: "active",
		};
		expect(gradeShape(payload).passed).toBe(false);
	});
});

describe("gradeAlignment", () => {
	test("passes when all three fields match", () => {
		const payload: EnrichmentPayload = {
			catalystSummary: "ok",
			directionalBias: "long",
			horizon: "days",
			status: "active",
		};
		expect(
			gradeAlignment(payload, { directionalBias: "long", horizon: "days", status: "active" })
				.passed,
		).toBe(true);
	});

	test("scores 2/3 when one mismatched", () => {
		const payload: EnrichmentPayload = {
			catalystSummary: "ok",
			directionalBias: "long",
			horizon: "weeks",
			status: "active",
		};
		const r = gradeAlignment(payload, {
			directionalBias: "long",
			horizon: "days",
			status: "active",
		});
		expect(r.passed).toBe(false);
		expect(r.score).toBeCloseTo(2 / 3, 3);
	});
});
