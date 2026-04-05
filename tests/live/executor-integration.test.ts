import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../src/config.ts";
import { closeDb, getDb } from "../../src/db/client.ts";
import { checkTradeRiskGate } from "../../src/risk/gate.ts";
import { buildSignalContext } from "../../src/strategy/context.ts";
import { evalExpr } from "../../src/strategy/expr-eval.ts";

process.env.DB_PATH = ":memory:";

describe("live executor integration", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("signal evaluation + risk gate pipeline works end-to-end", () => {
		// Simulate what the live executor does:
		// 1. Build context from quote + indicators
		const ctx = buildSignalContext({
			quote: {
				last: 150,
				bid: 149.5,
				ask: 150.5,
				volume: 1000000,
				avgVolume: 800000,
				changePercent: -3.0,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 25, atr14: 3.5, volume_ratio: 1.25 },
			position: null,
		});

		// 2. Evaluate signal expression
		const signal = "rsi14 < 30 AND change_percent < -2";
		const shouldEnter = evalExpr(signal, ctx);
		expect(shouldEnter).toBe(true);

		// 3. Risk gate check (use larger balance for realistic sizing)
		const gateResult = checkTradeRiskGate({
			accountBalance: 5000,
			price: 150,
			atr14: 3.5,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 0,
			openPositionSectors: [],
		});

		expect(gateResult.allowed).toBe(true);
		expect(gateResult.sizing!.quantity).toBeGreaterThan(0);
		expect(gateResult.sizing!.stopLossPrice).toBeLessThan(150);
	});

	test("exit signal with position context", () => {
		const openedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = buildSignalContext({
			quote: {
				last: 170,
				bid: 169.5,
				ask: 170.5,
				volume: null,
				avgVolume: null,
				changePercent: 2.0,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 75, atr14: 4.0, volume_ratio: 0.8 },
			position: { entryPrice: 150, openedAt, quantity: 10 },
		});

		// Exit when RSI overbought and profitable
		const shouldExit = evalExpr("rsi14 > 70 AND pnl_pct > 10", ctx);
		expect(shouldExit).toBe(true);
	});
});
