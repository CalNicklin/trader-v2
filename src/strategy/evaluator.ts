import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import {
	closePaperPosition,
	getOpenPositionForSymbol,
	openPaperPosition,
} from "../paper/manager.ts";
import { checkTradeRiskGate } from "../risk/gate.ts";
import { createChildLogger } from "../utils/logger.ts";
import { buildSignalContext, type QuoteFields } from "./context.ts";
import { evalExpr } from "./expr-eval.ts";
import type { SymbolIndicators } from "./historical.ts";
import { buildEffectiveUniverse, filterByLiquidity } from "./universe.ts";

const log = createChildLogger({ module: "evaluator" });

interface StrategyRow {
	id: number;
	name: string;
	parameters: string;
	signals: string | null;
	universe: string | null;
	status: string;
	virtualBalance: number;
}

interface SignalDef {
	entry_long?: string;
	entry_short?: string;
	exit?: string;
}

export interface EvalInput {
	quote: QuoteFields;
	indicators: SymbolIndicators;
}

export async function evaluateStrategyForSymbol(
	strategy: StrategyRow,
	symbol: string,
	exchange: string,
	input: EvalInput,
): Promise<void> {
	if (!strategy.signals) return;

	const signals: SignalDef = JSON.parse(strategy.signals);

	const openPosition = await getOpenPositionForSymbol(strategy.id, symbol, exchange);

	if (openPosition) {
		if (signals.exit) {
			const ctx = buildSignalContext({
				quote: input.quote,
				indicators: input.indicators,
				position: {
					entryPrice: openPosition.entryPrice,
					openedAt: openPosition.openedAt,
					quantity: openPosition.quantity,
				},
			});

			if (evalExpr(signals.exit, ctx)) {
				log.info({ strategy: strategy.name, symbol, signal: "exit" }, "Exit signal fired");

				if (input.quote.last != null) {
					await closePaperPosition({
						positionId: openPosition.id,
						strategyId: strategy.id,
						exitPrice: input.quote.last,
						signalType: "exit",
						reasoning: `Exit signal: ${signals.exit}`,
					});
				}
			}
		}
	} else {
		const ctx = buildSignalContext({
			quote: input.quote,
			indicators: input.indicators,
			position: null,
		});

		if (input.quote.last == null || input.quote.last <= 0) return;
		const price = input.quote.last;

		if (signals.entry_long && evalExpr(signals.entry_long, ctx)) {
			const gateResult = checkTradeRiskGate({
				accountBalance: strategy.virtualBalance,
				price,
				atr14: input.indicators.atr14 ?? 0,
				side: "BUY",
				exchange,
				sector: null,
				borrowFeeAnnualPct: null,
				openPositionCount: 0,
				openPositionSectors: [],
			});

			if (!gateResult.allowed) {
				log.debug(
					{ strategy: strategy.name, symbol, reason: gateResult.reason },
					"Trade rejected by risk gate",
				);
				return;
			}

			const { quantity, stopLossPrice } = gateResult.sizing!;
			if (quantity > 0) {
				log.info(
					{ strategy: strategy.name, symbol, signal: "entry_long", quantity, price, stopLossPrice },
					"Entry long signal fired (risk-gated)",
				);
				await openPaperPosition({
					strategyId: strategy.id,
					symbol,
					exchange,
					side: "BUY",
					price,
					quantity,
					signalType: "entry_long",
					reasoning: `Entry signal: ${signals.entry_long}`,
				});
			}
		} else if (signals.entry_short && evalExpr(signals.entry_short, ctx)) {
			const gateResult = checkTradeRiskGate({
				accountBalance: strategy.virtualBalance,
				price,
				atr14: input.indicators.atr14 ?? 0,
				side: "SELL",
				exchange,
				sector: null,
				borrowFeeAnnualPct: null,
				openPositionCount: 0,
				openPositionSectors: [],
			});

			if (!gateResult.allowed) {
				log.debug(
					{ strategy: strategy.name, symbol, reason: gateResult.reason },
					"Trade rejected by risk gate",
				);
				return;
			}

			const { quantity, stopLossPrice } = gateResult.sizing!;
			if (quantity > 0) {
				log.info(
					{
						strategy: strategy.name,
						symbol,
						signal: "entry_short",
						quantity,
						price,
						stopLossPrice,
					},
					"Entry short signal fired (risk-gated)",
				);
				await openPaperPosition({
					strategyId: strategy.id,
					symbol,
					exchange,
					side: "SELL",
					price,
					quantity,
					signalType: "entry_short",
					reasoning: `Entry signal: ${signals.entry_short}`,
				});
			}
		}
	}
}

export async function evaluateAllStrategies(
	getQuoteAndIndicators: (
		symbol: string,
		exchange: string,
	) => Promise<{ quote: QuoteFields; indicators: SymbolIndicators } | null>,
): Promise<void> {
	const db = getDb();

	const activeStrategies = await db.select().from(strategies).where(eq(strategies.status, "paper"));

	log.info({ count: activeStrategies.length }, "Evaluating paper strategies");

	for (const strategy of activeStrategies) {
		if (!strategy.universe) continue;
		const rawUniverse: string[] = JSON.parse(strategy.universe);

		// Apply universe management: merge injections, cap at 50, filter liquidity
		const withInjections = await buildEffectiveUniverse(rawUniverse);
		const defaultExchange = "NASDAQ";
		const universe = await filterByLiquidity(withInjections, defaultExchange);

		for (const symbolSpec of universe) {
			const [symbol, exchange] = symbolSpec.includes(":")
				? symbolSpec.split(":")
				: [symbolSpec, "NASDAQ"];

			const data = await getQuoteAndIndicators(symbol!, exchange!);
			if (!data) continue;

			try {
				await evaluateStrategyForSymbol(strategy, symbol!, exchange!, data);
			} catch (error) {
				log.error({ strategy: strategy.name, symbol, error }, "Error evaluating strategy");
			}
		}
	}
}
