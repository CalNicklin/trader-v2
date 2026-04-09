/**
 * Live verification script for IBKR LSE market data.
 * Run on VPS with trader-v2 service STOPPED to avoid client ID conflicts.
 *
 * Usage: bun src/scripts/test-ibkr-quotes.ts
 */
import { connect, disconnect } from "../broker/connection.ts";
import { ibkrHistorical, ibkrQuote } from "../broker/market-data.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "test-ibkr-quotes" });

const TEST_SYMBOLS = ["HSBA", "SHEL", "AZN"];

async function main() {
	log.info("Connecting to IBKR...");
	await connect();

	console.log("\n=== IBKR LSE Quote Tests ===\n");

	// Test quotes
	for (const symbol of TEST_SYMBOLS) {
		console.log(`--- ${symbol} quote ---`);
		const quote = await ibkrQuote(symbol, "LSE");
		if (quote) {
			console.log(`  last:   ${quote.last}`);
			console.log(`  bid:    ${quote.bid}`);
			console.log(`  ask:    ${quote.ask}`);
			console.log(`  volume: ${quote.volume}`);
		} else {
			console.log("  FAILED: null");
		}
		console.log();
	}

	// Test historical (one symbol, 30 days)
	console.log("--- HSBA historical (30 days) ---");
	const bars = await ibkrHistorical("HSBA", "LSE", 30);
	if (bars) {
		console.log(`  bars: ${bars.length}`);
		console.log(`  first: ${bars[0]?.date} close=${bars[0]?.close}`);
		console.log(`  last:  ${bars[bars.length - 1]?.date} close=${bars[bars.length - 1]?.close}`);
	} else {
		console.log("  FAILED: null");
	}

	console.log("\n=== Done ===\n");

	await disconnect();
	process.exit(0);
}

main().catch((err) => {
	log.error({ err }, "Test failed");
	process.exit(1);
});
