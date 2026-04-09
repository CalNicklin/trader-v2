/**
 * One-off script to close the orphan HSBA:LSE SHORT position.
 * BUY 3,909 shares at MARKET to flatten the position.
 *
 * Usage: bun src/scripts/close-hsba.ts
 */
import { connect, disconnect } from "../broker/connection.ts";
import { placeTrade } from "../broker/orders.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "close-hsba" });

async function main() {
	log.info("Connecting to IBKR...");
	await connect();

	log.info("Placing BUY 3909 HSBA on LSE (MARKET) to close SHORT position...");
	const result = await placeTrade({
		symbol: "HSBA",
		exchange: "LSE",
		side: "BUY",
		quantity: 3909,
		orderType: "MARKET",
		reasoning: "Close orphan SHORT position — no associated strategy",
	});

	log.info({ tradeId: result.tradeId, ibOrderId: result.ibOrderId, status: result.status }, "Order placed");

	// Give the order monitor a moment to receive fill
	await new Promise((resolve) => setTimeout(resolve, 5000));

	await disconnect();
	log.info("Done");
	process.exit(0);
}

main().catch((err) => {
	log.error({ err }, "Failed to close HSBA position");
	process.exit(1);
});
