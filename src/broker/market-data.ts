import { IBApiTickType } from "@stoqey/ib";
import type { FmpQuoteData } from "../data/fmp.ts";
import { createChildLogger } from "../utils/logger.ts";
import { getApi, isConnected } from "./connection.ts";
import { getContract } from "./contracts.ts";

const log = createChildLogger({ module: "broker-market-data" });

export async function ibkrQuote(symbol: string, exchange: string): Promise<FmpQuoteData | null> {
	if (!isConnected()) {
		log.warn({ symbol, exchange }, "IBKR not connected, skipping quote");
		return null;
	}

	try {
		const api = getApi();
		const contract = getContract(symbol, exchange as "LSE" | "NASDAQ" | "NYSE");
		const snapshot = await api.getMarketDataSnapshot(contract, "", false);

		const last = snapshot.get(IBApiTickType.LAST)?.value ?? null;
		const bid = snapshot.get(IBApiTickType.BID)?.value ?? null;
		const ask = snapshot.get(IBApiTickType.ASK)?.value ?? null;
		const volume = snapshot.get(IBApiTickType.VOLUME)?.value ?? null;

		if (last === null) {
			log.warn({ symbol, exchange }, "IBKR snapshot returned no last price");
			return null;
		}

		return {
			symbol,
			exchange,
			last,
			bid,
			ask,
			volume,
			avgVolume: null,
			changePercent: null,
		};
	} catch (error) {
		log.warn(
			{ symbol, exchange, error: error instanceof Error ? error.message : String(error) },
			"IBKR snapshot failed",
		);
		return null;
	}
}
