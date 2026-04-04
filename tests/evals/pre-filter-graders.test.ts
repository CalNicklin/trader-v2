import { describe, expect, test } from "bun:test";

describe("pre-filter graders", () => {
	test("correctnessGrader passes when output matches reference", async () => {
		const { correctnessGrader } = await import("../../src/evals/pre-filter/graders.ts");

		const pass = await correctnessGrader.grade(true, { shouldPass: true, reason: "tradeable" });
		expect(pass.pass).toBe(true);

		const fail = await correctnessGrader.grade(true, { shouldPass: false, reason: "noise" });
		expect(fail.pass).toBe(false);
	});
});
