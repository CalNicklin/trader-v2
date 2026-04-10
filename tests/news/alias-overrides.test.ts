// tests/news/alias-overrides.test.ts
import { describe, expect, it } from "bun:test";
import { ALIAS_OVERRIDES } from "../../src/news/alias-overrides.ts";

describe("ALIAS_OVERRIDES", () => {
	it("is a non-empty map keyed by LSE symbol", () => {
		expect(Object.keys(ALIAS_OVERRIDES).length).toBeGreaterThan(0);
	});

	it("has known nickname aliases", () => {
		expect(ALIAS_OVERRIDES.HSBA).toContain("HSBC");
		expect(ALIAS_OVERRIDES.SHEL).toContain("Shell");
	});

	it("every override is a non-empty string array", () => {
		for (const [_sym, aliases] of Object.entries(ALIAS_OVERRIDES)) {
			expect(Array.isArray(aliases)).toBe(true);
			expect(aliases.length).toBeGreaterThan(0);
			for (const a of aliases) {
				expect(typeof a).toBe("string");
				expect(a.length).toBeGreaterThan(0);
			}
		}
	});
});
