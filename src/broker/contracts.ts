import { type Contract, SecType } from "@stoqey/ib";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "broker-contracts" });

export type Exchange = "LSE" | "NASDAQ" | "NYSE";

/** Create a Contract for an LSE-listed stock.
 *  Uses SMART routing — IB paper trading doesn't fill direct LSE-routed orders. */
export function lseStock(symbol: string): Contract {
	return {
		symbol,
		secType: SecType.STK,
		exchange: "SMART",
		primaryExch: "LSE",
		currency: "GBP",
	};
}

/** Create a Contract for a US-listed stock (NASDAQ or NYSE). */
export function usStock(symbol: string, exchange: "NASDAQ" | "NYSE"): Contract {
	return {
		symbol,
		secType: SecType.STK,
		exchange: "SMART",
		primaryExch: exchange,
		currency: "USD",
	};
}

/** Dispatch to the correct contract builder based on exchange. */
export function getContract(symbol: string, exchange: Exchange): Contract {
	if (exchange === "LSE") return lseStock(symbol);
	return usStock(symbol, exchange);
}

/** Look up contract details for a symbol on a given exchange.
 *  Requires a live IBKR connection. */
export async function getContractDetails(
	api: { getContractDetails(contract: Contract): Promise<unknown[]> },
	symbol: string,
	exchange: Exchange = "LSE",
) {
	const contract = getContract(symbol, exchange);
	const details = await api.getContractDetails(contract);
	log.debug({ symbol, exchange, count: details.length }, "Contract details fetched");
	return details;
}
