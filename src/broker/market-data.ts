import { type Bar, BarSizeSetting, IBApiTickType } from "@stoqey/ib";
import type { FmpHistoricalBar, FmpQuoteData } from "../data/fmp.ts";
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

export async function ibkrHistorical(
	symbol: string,
	exchange: string,
	days = 90,
): Promise<FmpHistoricalBar[] | null> {
	if (!isConnected()) {
		log.warn({ symbol, exchange }, "IBKR not connected, skipping historical");
		return null;
	}

	try {
		const api = getApi();
		const contract = getContract(symbol, exchange as "LSE" | "NASDAQ" | "NYSE");
		const bars: Bar[] = await api.getHistoricalData(
			contract,
			"",
			`${days} D`,
			BarSizeSetting.DAYS_ONE,
			"TRADES",
			1,
			1,
		);

		if (!bars || bars.length === 0) {
			log.warn({ symbol, exchange, days }, "IBKR returned no historical bars");
			return null;
		}

		return bars.map((bar) => ({
			date: formatIbkrDate(bar.time ?? ""),
			open: bar.open ?? 0,
			high: bar.high ?? 0,
			low: bar.low ?? 0,
			close: bar.close ?? 0,
			volume: bar.volume ?? 0,
		}));
	} catch (error) {
		log.warn(
			{ symbol, exchange, error: error instanceof Error ? error.message : String(error) },
			"IBKR historical data failed",
		);
		return null;
	}
}

function formatIbkrDate(raw: string): string {
	const d = raw.replace(/\s.*$/, "");
	if (d.length === 8) {
		return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
	}
	return d;
}
