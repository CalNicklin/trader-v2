import { describe, expect, test } from "bun:test";
import { fetchIsfConstituents } from "../../../src/universe/sources/ishares-isf.ts";

// Fixture: top of a real ISF holdings CSV (UK format — slightly different header layout)
const SAMPLE_CSV = `\uFEFFFund Holdings as of,"16/Apr/2026"

Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Shares,Price,Location,Exchange,Market Currency
"HSBA","HSBC HOLDINGS PLC","Financials","Equity","1,415,309,318.79","8.95","1,415,309,318.79","105,762,167.00","13.38","United Kingdom","London Stock Exchange","GBP"
"AZN","ASTRAZENECA PLC","Health Care","Equity","1,372,082,727.48","8.67","1,372,082,727.48","9,232,154.00","148.62","United Kingdom","London Stock Exchange","GBP"
"BP.","BP PLC","Energy","Equity","564,035,481.12","3.57","564,035,481.12","96,581,418.00","5.84","United Kingdom","London Stock Exchange","GBP"
"GBP CASH","GBP CASH RESERVE","-","Cash","1,000,000.00","0.01","1,000,000.00","1,000,000.00","1.00","-","-","GBP"
`;

describe("fetchIsfConstituents", () => {
	test("parses tickers, strips trailing dots, filters equity-only, tags as ftse_350", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => SAMPLE_CSV,
		});
		const rows = await fetchIsfConstituents(fetchStub as unknown as typeof fetch);
		expect(rows.length).toBe(3);
		// Trailing dot on BP. gets stripped → "BP"
		expect(rows.map((r) => r.symbol).sort()).toEqual(["AZN", "BP", "HSBA"]);
		expect(rows.every((r) => r.exchange === "LSE")).toBe(true);
		expect(rows.every((r) => r.indexSource === "ftse_350")).toBe(true);
	});

	test("throws on non-200 HTTP", async () => {
		const fetchStub = async (_url: string) => ({
			ok: false,
			status: 403,
			statusText: "Forbidden",
			text: async () => "",
		});
		await expect(fetchIsfConstituents(fetchStub as unknown as typeof fetch)).rejects.toThrow(/ISF/);
	});
});
