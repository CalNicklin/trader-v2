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
		// Request delayed data (15-min) — paper accounts lack real-time LSE subscriptions
		api.setMarketDataType(3);
		const contract = getContract(symbol, exchange as "LSE" | "NASDAQ" | "NYSE");
		const snapshot = await api.getMarketDataSnapshot(contract, "", false);

		// Check both real-time and delayed tick types (IBKR may return either)
		const last = validTick(
			snapshot.get(IBApiTickType.LAST)?.value ??
				snapshot.get(IBApiTickType.DELAYED_LAST)?.value,
		);
		const bid = validTick(
			snapshot.get(IBApiTickType.BID)?.value ??
				snapshot.get(IBApiTickType.DELAYED_BID)?.value,
		);
		const ask = validTick(
			snapshot.get(IBApiTickType.ASK)?.value ??
				snapshot.get(IBApiTickType.DELAYED_ASK)?.value,
		);
		const volume = validTick(
			snapshot.get(IBApiTickType.VOLUME)?.value ??
				snapshot.get(IBApiTickType.DELAYED_VOLUME)?.value,
		);

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

/** Filter out IBKR sentinel values (-1, -100) that indicate "not available" */
function validTick(value: number | undefined): number | null {
	if (value == null || value <= 0) return null;
	return value;
}

function formatIbkrDate(raw: string): string {
	const d = raw.replace(/\s.*$/, "");
	if (d.length === 8) {
		return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
	}
	return d;
}
