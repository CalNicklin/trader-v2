import { describe, expect, test } from "bun:test";
import { fetchFtse250FromWikipedia } from "../../../src/universe/sources/wikipedia-ftse250.ts";

// Fixture: minimal Wikipedia-style HTML with the constituents table.
const SAMPLE_HTML = `
<html>
<body>
<h2>Constituents</h2>
<table class="wikitable sortable">
<tr><th>Company</th><th>EPIC</th><th>Index weighting (%)</th><th>Sector</th></tr>
<tr><td>abrdn plc</td><td><a href="/wiki/Abrdn">ABDN</a></td><td>0.4</td><td>Financials</td></tr>
<tr><td>Aston Martin</td><td>AML</td><td>0.1</td><td>Consumer</td></tr>
<tr><td>BP plc</td><td><a>BP.</a></td><td>3.5</td><td>Energy</td></tr>
</table>
</body>
</html>
`;

describe("fetchFtse250FromWikipedia", () => {
	test("scrapes EPIC codes, strips trailing dot, tags ftse_350 / LSE", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => SAMPLE_HTML,
		});
		const rows = await fetchFtse250FromWikipedia(fetchStub as unknown as typeof fetch);
		expect(rows.map((r) => r.symbol).sort()).toEqual(["ABDN", "AML", "BP"]);
		expect(rows.every((r) => r.exchange === "LSE")).toBe(true);
		expect(rows.every((r) => r.indexSource === "ftse_350")).toBe(true);
	});

	test("filters known parse noise (MCX, EPIC, EPS, FTSE)", async () => {
		const noise = `
		<table class="wikitable">
		<tr><td>MCX</td></tr>
		<tr><td>EPIC</td></tr>
		<tr><td>EPS</td></tr>
		<tr><td>FTSE</td></tr>
		<tr><td>ABDN</td></tr>
		</table>`;
		const fetchStub = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => noise,
		});
		const rows = await fetchFtse250FromWikipedia(fetchStub as unknown as typeof fetch);
		expect(rows.map((r) => r.symbol)).toEqual(["ABDN"]);
	});

	test("throws on non-200 HTTP", async () => {
		const fetchStub = async () => ({
			ok: false,
			status: 500,
			statusText: "Server Error",
			text: async () => "",
		});
		await expect(fetchFtse250FromWikipedia(fetchStub as unknown as typeof fetch)).rejects.toThrow(
			/Wikipedia/i,
		);
	});
});
