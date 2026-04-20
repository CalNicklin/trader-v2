import { describe, expect, test } from "bun:test";
import {
	fetchSharesOutstandingFrames,
	mostRecentCompletedQuarter,
} from "../../../src/universe/enrichers/edgar-shares-frames.ts";

const SAMPLE_FRAMES_RESPONSE = {
	taxonomy: "us-gaap",
	tag: "CommonStockSharesOutstanding",
	ccp: "CY2025Q4I",
	uom: "shares",
	pts: 3,
	data: [
		{
			accn: "0001193125-26-102079",
			cik: 320193,
			entityName: "Apple Inc.",
			val: 14681140000,
			end: "2025-12-31",
		},
		{
			accn: "0001193125-26-100001",
			cik: 789019,
			entityName: "Microsoft Corp",
			val: 7430000000,
			end: "2025-12-31",
		},
		{
			accn: "0001193125-26-100002",
			cik: 1018724,
			entityName: "Amazon.com Inc.",
			val: 10500000000,
			end: "2025-12-31",
		},
	],
};

describe("fetchSharesOutstandingFrames", () => {
	test("returns a Map<cik, sharesOutstanding> for the given quarter", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_FRAMES_RESPONSE,
		});
		const out = await fetchSharesOutstandingFrames({
			quarter: "CY2025Q4I",
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(out.size).toBe(3);
		expect(out.get(320193)).toBe(14681140000);
		expect(out.get(789019)).toBe(7430000000);
	});

	test("throws on non-200", async () => {
		const fetchStub = async () => ({ ok: false, status: 404, json: async () => ({}) });
		await expect(
			fetchSharesOutstandingFrames({
				quarter: "CY2025Q4I",
				fetchImpl: fetchStub as unknown as typeof fetch,
			}),
		).rejects.toThrow(/EDGAR frames/);
	});

	test("uses the configured quarter in the URL", async () => {
		let seenUrl = "";
		const fetchStub = async (url: string) => {
			seenUrl = url;
			return { ok: true, status: 200, json: async () => SAMPLE_FRAMES_RESPONSE };
		};
		await fetchSharesOutstandingFrames({
			quarter: "CY2025Q3I",
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(seenUrl).toContain("CY2025Q3I");
	});
});

describe("mostRecentCompletedQuarter", () => {
	test("returns Q4 of previous year when called mid-Feb", () => {
		expect(mostRecentCompletedQuarter(new Date("2026-02-15T00:00:00Z"))).toBe("CY2025Q4I");
	});

	test("returns Q1 when called mid-June", () => {
		expect(mostRecentCompletedQuarter(new Date("2026-06-15T00:00:00Z"))).toBe("CY2026Q1I");
	});

	test("returns Q3 when called mid-November", () => {
		expect(mostRecentCompletedQuarter(new Date("2026-11-15T00:00:00Z"))).toBe("CY2026Q3I");
	});
});
