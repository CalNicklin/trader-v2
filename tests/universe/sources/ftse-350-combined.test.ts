import { describe, expect, test } from "bun:test";
import { fetchFtse350Combined } from "../../../src/universe/sources/ftse-350-combined.ts";
import type { ConstituentRow } from "../../../src/universe/sources.ts";

describe("fetchFtse350Combined", () => {
	test("unions ISF (FTSE 100) and Wikipedia (FTSE 250) results, deduped", async () => {
		const isf: ConstituentRow[] = [
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" },
			{ symbol: "BP", exchange: "LSE", indexSource: "ftse_350" },
		];
		const wiki: ConstituentRow[] = [
			{ symbol: "ABDN", exchange: "LSE", indexSource: "ftse_350" },
			{ symbol: "BP", exchange: "LSE", indexSource: "ftse_350" }, // dup — lives in both buckets
		];
		const rows = await fetchFtse350Combined({
			fetchIsf: async () => isf,
			fetchWiki: async () => wiki,
		});
		expect(rows.length).toBe(3);
		expect(rows.map((r) => r.symbol).sort()).toEqual(["ABDN", "BP", "HSBA"]);
	});

	test("throws if ISF fails (FTSE 100 blue-chips are critical)", async () => {
		await expect(
			fetchFtse350Combined({
				fetchIsf: async () => {
					throw new Error("ISF blocked");
				},
				fetchWiki: async () => [{ symbol: "ABDN", exchange: "LSE", indexSource: "ftse_350" }],
			}),
		).rejects.toThrow(/ISF/);
	});

	test("throws if Wikipedia fails (treat as whole-source failure)", async () => {
		await expect(
			fetchFtse350Combined({
				fetchIsf: async () => [{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }],
				fetchWiki: async () => {
					throw new Error("Wikipedia 500");
				},
			}),
		).rejects.toThrow(/Wikipedia/);
	});
});
