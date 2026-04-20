import { describe, expect, test } from "bun:test";
import { fetchUsProfiles } from "../../../src/universe/enrichers/us-profile.ts";
import type { ConstituentRow } from "../../../src/universe/sources.ts";

describe("fetchUsProfiles", () => {
	test("composes CIK map + frames + Yahoo into a profile Map", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "MSFT", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }, // skipped (not US)
		];

		const cikMap = new Map<string, number>([
			["AAPL:NASDAQ", 320193],
			["MSFT:NASDAQ", 789019],
		]);

		const sharesMap = new Map<number, number>([
			[320193, 14_681_140_000],
			[789019, 7_430_000_000],
		]);

		const yahooMap = new Map<
			string,
			{
				symbol: string;
				exchange: string;
				priceUsd: number;
				avgVolume30d: number;
				avgDollarVolumeUsd: number;
				ipoDate: string | null;
			}
		>([
			[
				"AAPL:NASDAQ",
				{
					symbol: "AAPL",
					exchange: "NASDAQ",
					priceUsd: 270.23,
					avgVolume30d: 50_000_000,
					avgDollarVolumeUsd: 270.23 * 50_000_000,
					ipoDate: "1980-12-12",
				},
			],
			[
				"MSFT:NASDAQ",
				{
					symbol: "MSFT",
					exchange: "NASDAQ",
					priceUsd: 420,
					avgVolume30d: 20_000_000,
					avgDollarVolumeUsd: 420 * 20_000_000,
					ipoDate: "1986-03-13",
				},
			],
		]);

		const out = await fetchUsProfiles(rows, {
			getCiks: async () => cikMap,
			getSharesFrames: async () => sharesMap,
			getYahooQuotes: async () => yahooMap,
		});

		expect(out.size).toBe(2);
		const aapl = out.get("AAPL:NASDAQ");
		expect(aapl?.sharesOutstanding).toBe(14_681_140_000);
		expect(aapl?.priceUsd).toBe(270.23);
		expect(aapl?.marketCapUsd).toBeCloseTo(14_681_140_000 * 270.23);
		expect(aapl?.ipoDate).toBe("1980-12-12");
		// HSBA is non-US, should not be in the output
		expect(out.has("HSBA:LSE")).toBe(false);
	});

	test("returns partial data when frames is missing a CIK (use Yahoo only)", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const out = await fetchUsProfiles(rows, {
			getCiks: async () => new Map([["AAPL:NASDAQ", 320193]]),
			getSharesFrames: async () => new Map(), // no shares data
			getYahooQuotes: async () =>
				new Map([
					[
						"AAPL:NASDAQ",
						{
							symbol: "AAPL",
							exchange: "NASDAQ",
							priceUsd: 270,
							avgVolume30d: 50_000_000,
							avgDollarVolumeUsd: 270 * 50_000_000,
							ipoDate: "1980-12-12",
						},
					],
				]),
		});
		const aapl = out.get("AAPL:NASDAQ");
		expect(aapl?.priceUsd).toBe(270);
		expect(aapl?.marketCapUsd).toBeNull();
		expect(aapl?.sharesOutstanding).toBeNull();
		// Yahoo-only data still populates price/volume/IPO
		expect(aapl?.ipoDate).toBe("1980-12-12");
		expect(aapl?.avgDollarVolumeUsd).toBe(270 * 50_000_000);
	});

	test("returns empty map when no US rows", async () => {
		const out = await fetchUsProfiles(
			[{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }],
			{
				getCiks: async () => new Map(),
				getSharesFrames: async () => new Map(),
				getYahooQuotes: async () => new Map(),
			},
		);
		expect(out.size).toBe(0);
	});

	test("shares-frames failure is swallowed — US rows still get Yahoo data", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const out = await fetchUsProfiles(rows, {
			getCiks: async () => new Map([["AAPL:NASDAQ", 320193]]),
			getSharesFrames: async () => {
				throw new Error("EDGAR 500");
			},
			getYahooQuotes: async () =>
				new Map([
					[
						"AAPL:NASDAQ",
						{
							symbol: "AAPL",
							exchange: "NASDAQ",
							priceUsd: 270,
							avgVolume30d: 50_000_000,
							avgDollarVolumeUsd: 270 * 50_000_000,
							ipoDate: "1980-12-12",
						},
					],
				]),
		});
		const aapl = out.get("AAPL:NASDAQ");
		expect(aapl?.priceUsd).toBe(270);
		expect(aapl?.marketCapUsd).toBeNull(); // no shares
		expect(aapl?.avgDollarVolumeUsd).toBe(270 * 50_000_000);
	});
});
