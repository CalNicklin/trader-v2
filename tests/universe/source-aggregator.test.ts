import { describe, expect, test } from "bun:test";
import { fetchCandidatesFromAllSources } from "../../src/universe/source-aggregator.ts";

describe("fetchCandidatesFromAllSources — fail-partial", () => {
	const passthroughEnrich = async (rows: unknown[]) => rows as never;

	test("returns candidates and empty failedIndexSources when all sources succeed", async () => {
		const result = await fetchCandidatesFromAllSources({
			fetchRussell: async () => [
				{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			],
			fetchFtse: async () => [{ symbol: "SHEL", exchange: "LSE", indexSource: "ftse_350" }],
			fetchAim: async () => [{ symbol: "GAW", exchange: "LSE", indexSource: "aim_allshare" }],
			enrichWithMetrics: passthroughEnrich,
		});
		expect(result.candidates.length).toBe(3);
		expect(result.failedIndexSources).toEqual([]);
	});

	test("skips failing sources, returns succeeded candidates + failedIndexSources records failure", async () => {
		const result = await fetchCandidatesFromAllSources({
			fetchRussell: async () => [
				{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			],
			fetchFtse: async () => {
				throw new Error("FMP FTSE 350 request failed: 403 Forbidden");
			},
			fetchAim: async () => {
				throw new Error("FMP AIM request failed: 403 Forbidden");
			},
			enrichWithMetrics: passthroughEnrich,
		});
		expect(result.candidates.length).toBe(1);
		expect(result.candidates[0]?.symbol).toBe("AAPL");
		expect(result.failedIndexSources.sort()).toEqual(["aim_allshare", "ftse_350"]);
	});

	test("throws when all sources fail (preserves safety rail)", async () => {
		await expect(
			fetchCandidatesFromAllSources({
				fetchRussell: async () => {
					throw new Error("fail1");
				},
				fetchFtse: async () => {
					throw new Error("fail2");
				},
				fetchAim: async () => {
					throw new Error("fail3");
				},
				enrichWithMetrics: passthroughEnrich,
			}),
		).rejects.toThrow(/all.*sources.*failed/i);
	});
});
