import { describe, expect, test } from "bun:test";
import { fetchAimCurated } from "../../../src/universe/sources/aim-curated.ts";

describe("fetchAimCurated", () => {
	test("returns the hand-maintained AIM watchlist", async () => {
		const rows = await fetchAimCurated();
		// Sanity: must have more than zero and all tagged aim_allshare
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.indexSource === "aim_allshare")).toBe(true);
		expect(rows.every((r) => r.exchange === "AIM")).toBe(true);
	});

	test("includes the known names we care about", async () => {
		const rows = await fetchAimCurated();
		const symbols = new Set(rows.map((r) => r.symbol));
		// These five were the hand-curated set from the spec / PoC
		for (const s of ["GAW", "FDEV", "TET", "JET2", "BOWL"]) {
			expect(symbols.has(s)).toBe(true);
		}
	});
});
