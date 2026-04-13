import { describe, expect, test } from "bun:test";
import type { Exchange } from "../../src/broker/contracts";

describe("strategy eval exchange filter", () => {
	test("filterUniverseByExchanges keeps only matching exchanges", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const universe = ["AAPL:NASDAQ", "VOD:LSE", "MSFT:NASDAQ"];

		const usOnly = await filterUniverseByExchanges(universe, ["NASDAQ", "NYSE"]);
		expect(usOnly).toEqual(["AAPL:NASDAQ", "MSFT:NASDAQ"]);

		const ukOnly = await filterUniverseByExchanges(universe, ["LSE"]);
		expect(ukOnly).toEqual(["VOD:LSE"]);
	});

	test("filterUniverseByExchanges returns all when no filter", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const universe = ["AAPL:NASDAQ", "VOD:LSE"];

		const all = await filterUniverseByExchanges(universe);
		expect(all).toEqual(["AAPL:NASDAQ", "VOD:LSE"]);
	});

	test("filterUniverseByExchanges resolves bare symbols via resolver", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const resolver = async (symbol: string): Promise<Exchange | null> => {
			if (symbol === "JPM") return "NYSE";
			if (symbol === "AAPL") return "NASDAQ";
			return null;
		};

		const result = await filterUniverseByExchanges(["JPM", "AAPL", "SHEL:LSE"], ["NYSE"], {
			resolver,
		});
		expect(result).toEqual(["JPM"]);
	});

	test("filterUniverseByExchanges skips bare symbols that cannot be resolved", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const resolver = async (): Promise<Exchange | null> => null;

		const result = await filterUniverseByExchanges(["UNKNOWN", "AAPL:NASDAQ"], ["NASDAQ"], {
			resolver,
		});
		expect(result).toEqual(["AAPL:NASDAQ"]);
	});
});
