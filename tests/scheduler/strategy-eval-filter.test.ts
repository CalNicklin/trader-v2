import { describe, expect, test } from "bun:test";

describe("strategy eval exchange filter", () => {
	test("filterUniverseByExchanges keeps only matching exchanges", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const universe = ["AAPL:NASDAQ", "VOD:LSE", "MSFT:NASDAQ"];

		const usOnly = filterUniverseByExchanges(universe, ["NASDAQ", "NYSE"]);
		expect(usOnly).toEqual(["AAPL:NASDAQ", "MSFT:NASDAQ"]);

		const ukOnly = filterUniverseByExchanges(universe, ["LSE"]);
		expect(ukOnly).toEqual(["VOD:LSE"]);
	});

	test("filterUniverseByExchanges returns all when no filter", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const universe = ["AAPL:NASDAQ", "VOD:LSE"];

		const all = filterUniverseByExchanges(universe);
		expect(all).toEqual(["AAPL:NASDAQ", "VOD:LSE"]);
	});

	test("filterUniverseByExchanges handles bare symbols (default NASDAQ)", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const universe = ["AAPL", "VOD:LSE"];

		const usOnly = filterUniverseByExchanges(universe, ["NASDAQ"]);
		expect(usOnly).toEqual(["AAPL"]);
	});
});
