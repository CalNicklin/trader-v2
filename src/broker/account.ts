import { createChildLogger } from "../utils/logger.ts";
import { getApi } from "./connection.ts";

const log = createChildLogger({ module: "broker-account" });

export interface AccountSummary {
	accountId: string;
	netLiquidation: number;
	totalCashValue: number;
	buyingPower: number;
	grossPositionValue: number;
	availableFunds: number;
}

const SUMMARY_TAGS = "NetLiquidation,TotalCashValue,BuyingPower,GrossPositionValue,AvailableFunds";

/** Fetch current account summary from IBKR */
export async function getAccountSummary(): Promise<AccountSummary> {
	const api = getApi();

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			sub.unsubscribe();
			reject(new Error("Account summary timeout after 10s"));
		}, 10000);

		const sub = api.getAccountSummary("All", SUMMARY_TAGS).subscribe({
			next: (update) => {
				const result: Partial<AccountSummary> = {};

				for (const [accountId, tagValues] of update.all) {
					result.accountId = accountId;
					for (const [tag, currencyValues] of tagValues) {
						for (const [, val] of currencyValues) {
							const numVal = Number(val.value);
							switch (tag) {
								case "NetLiquidation":
									result.netLiquidation = numVal;
									break;
								case "TotalCashValue":
									result.totalCashValue = numVal;
									break;
								case "BuyingPower":
									result.buyingPower = numVal;
									break;
								case "GrossPositionValue":
									result.grossPositionValue = numVal;
									break;
								case "AvailableFunds":
									result.availableFunds = numVal;
									break;
							}
						}
					}
				}

				if (result.accountId && result.netLiquidation !== undefined) {
					clearTimeout(timeout);
					sub.unsubscribe();
					const summary = result as AccountSummary;
					log.info(summary, "Account summary fetched");
					resolve(summary);
				}
			},
			error: (err) => {
				clearTimeout(timeout);
				reject(err);
			},
		});
	});
}

export interface IbkrPosition {
	accountId: string;
	symbol: string;
	exchange: string;
	currency: string;
	quantity: number;
	avgCost: number;
}

/** Fetch current positions from IBKR */
export async function getPositions(): Promise<IbkrPosition[]> {
	const api = getApi();

	return new Promise((resolve, reject) => {
		const positions: IbkrPosition[] = [];
		const timeout = setTimeout(() => {
			sub.unsubscribe();
			resolve(positions); // Return whatever we have
		}, 10000);

		const sub = api.getPositions().subscribe({
			next: (update) => {
				for (const [accountId, positionList] of update.all) {
					for (const pos of positionList) {
						if (pos.pos !== 0) {
							const exchange = pos.contract.primaryExch ?? "LSE";
							const currency = pos.contract.currency ?? "GBP";
							// IBKR reports avgCost in native currency (pounds for GBP)
							// but we store LSE/AIM prices in pence — convert
							const rawAvgCost = pos.avgCost ?? 0;
							const avgCost =
								currency === "GBP" && (exchange === "LSE" || exchange === "AIM")
									? rawAvgCost * 100
									: rawAvgCost;

							positions.push({
								accountId,
								symbol: pos.contract.symbol ?? "UNKNOWN",
								exchange,
								currency,
								quantity: pos.pos ?? 0,
								avgCost,
							});
						}
					}
				}
				clearTimeout(timeout);
				sub.unsubscribe();
				log.info({ count: positions.length }, "Positions fetched");
				resolve(positions);
			},
			error: (err) => {
				clearTimeout(timeout);
				reject(err);
			},
		});
	});
}
