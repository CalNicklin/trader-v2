import { describe, expect, test } from "bun:test";
import { runDailyTournaments } from "../../src/evolution/tournament";

describe("daily tournament runner", () => {
	test("exports runDailyTournaments function", () => {
		expect(typeof runDailyTournaments).toBe("function");
	});
});
