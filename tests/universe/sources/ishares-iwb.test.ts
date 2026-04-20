import { describe, expect, test } from "bun:test";
import { fetchIwbConstituents } from "../../../src/universe/sources/ishares-iwb.ts";

// Fixture: top of a real IWB holdings CSV (truncated)
const SAMPLE_CSV = `\uFEFFiShares Russell 1000 ETF
Fund Holdings as of,"Apr 17, 2026"
Inception Date,"May 15, 2000"
Shares Outstanding,"119,350,000.00"
Stock,"-"
Bond,"-"
Cash,"-"
Other,"-"

Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency,Accrual Date
"NVDA","NVIDIA CORP","Information Technology","Equity","3,354,167,508.48","7.24","3,354,167,508.48","16,631,136.00","201.68","United States","NASDAQ","USD","1.00","USD","-"
"AAPL","APPLE INC","Information Technology","Equity","2,766,430,713.37","5.97","2,766,430,713.37","10,237,319.00","270.23","United States","NASDAQ","USD","1.00","USD","-"
"MSFT","MICROSOFT CORP","Information Technology","Equity","2,100,000,000.00","4.50","2,100,000,000.00","5,000,000.00","420.00","United States","NASDAQ","USD","1.00","USD","-"
"XYZ CASH","XYZ CASH RESERVE","-","Cash","1,000,000.00","0.10","1,000,000.00","1,000,000.00","1.00","-","-","USD","1.00","USD","-"
`;

describe("fetchIwbConstituents", () => {
	test("parses Ticker/Exchange from the iShares IWB CSV, skips non-equity rows", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => SAMPLE_CSV,
		});
		const rows = await fetchIwbConstituents(fetchStub as unknown as typeof fetch);
		expect(rows.length).toBe(3);
		expect(rows[0]?.symbol).toBe("NVDA");
		expect(rows[0]?.exchange).toBe("NASDAQ");
		expect(rows[0]?.indexSource).toBe("russell_1000");
		expect(rows.map((r) => r.symbol).sort()).toEqual(["AAPL", "MSFT", "NVDA"]);
	});

	test("throws on non-200 HTTP", async () => {
		const fetchStub = async (_url: string) => ({
			ok: false,
			status: 404,
			statusText: "Not Found",
			text: async () => "",
		});
		await expect(fetchIwbConstituents(fetchStub as unknown as typeof fetch)).rejects.toThrow(/IWB/);
	});

	test("throws when Ticker header row is missing", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => 'Fund Holdings as of,"Apr 17, 2026"\n',
		});
		await expect(fetchIwbConstituents(fetchStub as unknown as typeof fetch)).rejects.toThrow(
			/header/i,
		);
	});
});
