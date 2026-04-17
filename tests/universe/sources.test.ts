import { beforeEach, describe, expect, test } from "bun:test";

describe("fetchRussell1000Constituents", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
	});

	test("returns array of US-listed constituents with symbol and exchange", async () => {
		const { fetchRussell1000Constituents } = await import("../../src/universe/sources.ts");
		const mockFetch = async (url: string) => {
			expect(url).toContain("russell-1000");
			return {
				ok: true,
				json: async () => [
					{ symbol: "AAPL", name: "Apple Inc.", sector: "Technology", exchange: "NASDAQ" },
					{ symbol: "MSFT", name: "Microsoft", sector: "Technology", exchange: "NASDAQ" },
				],
			} as Response;
		};
		const result = await fetchRussell1000Constituents(mockFetch);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" });
	});

	test("throws on non-ok response", async () => {
		const { fetchRussell1000Constituents } = await import("../../src/universe/sources.ts");
		const mockFetch = async () =>
			({ ok: false, status: 500, statusText: "Server Error" }) as Response;
		await expect(fetchRussell1000Constituents(mockFetch)).rejects.toThrow();
	});

	test("returns empty array on empty constituent list", async () => {
		const { fetchRussell1000Constituents } = await import("../../src/universe/sources.ts");
		const mockFetch = async () => ({ ok: true, json: async () => [] }) as unknown as Response;
		const result = await fetchRussell1000Constituents(mockFetch);
		expect(result).toEqual([]);
	});
});
