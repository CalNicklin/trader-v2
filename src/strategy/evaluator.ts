import { eq, inArray } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import {
	closePaperPosition,
	getOpenPositionForSymbol,
	getOpenPositions,
	openPaperPosition,
} from "../paper/manager.ts";
import { checkTradeRiskGate } from "../risk/gate.ts";
import { isTradingHalted, isWeeklyDrawdownActive } from "../risk/guardian.ts";
import { createChildLogger } from "../utils/logger.ts";
import { buildSignalContext, type QuoteFields } from "./context.ts";
import { clearDispatchDecisions, getLatestDispatchDecisions } from "./dispatch.ts";
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
	riskState?: {
		openPositionCount: number;
		openPositionSectors: (string | null)[];
		weeklyDrawdownActive: boolean;
	},
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
				openPositionCount: riskState?.openPositionCount ?? 0,
				openPositionSectors: riskState?.openPositionSectors ?? [],
				weeklyDrawdownActive: riskState?.weeklyDrawdownActive,
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
				openPositionCount: riskState?.openPositionCount ?? 0,
				openPositionSectors: riskState?.openPositionSectors ?? [],
				weeklyDrawdownActive: riskState?.weeklyDrawdownActive,
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
	options?: {
		exchanges?: Exchange[];
		allowNewEntries?: boolean;
	},
): Promise<void> {
	// Check if trading is halted before evaluating any strategies
	const haltStatus = await isTradingHalted();
	if (haltStatus.halted) {
		log.warn({ reason: haltStatus.reason }, "Trading halted — skipping strategy evaluation");
		return;
	}

	const db = getDb();

	const activeStrategies = await db.select().from(strategies).where(eq(strategies.status, "paper"));

	log.info({ count: activeStrategies.length }, "Evaluating paper strategies");

	// Check weekly drawdown state once for all strategies
	const weeklyDrawdownActive = await isWeeklyDrawdownActive();

	for (const strategy of activeStrategies) {
		if (!strategy.universe) continue;
		const rawUniverse: string[] = JSON.parse(strategy.universe);

		// Apply universe management: merge injections, cap at 50, filter liquidity
		const withInjections = await buildEffectiveUniverse(rawUniverse);
		const defaultExchange = "NASDAQ";
		const universe = await filterByLiquidity(withInjections, defaultExchange);

		// Apply exchange filter if provided (session-aware scheduling)
		const exchangeFiltered = options?.exchanges
			? universe.filter((spec) => {
					const ex = spec.includes(":") ? spec.split(":")[1]! : "NASDAQ";
					return options.exchanges!.includes(ex as Exchange);
				})
			: universe;

		// Gather open position state for this strategy
		const openPositions = await getOpenPositions(strategy.id);
		const riskState = {
			openPositionCount: openPositions.length,
			openPositionSectors: openPositions.map(() => null as string | null), // sector lookup not yet available
			weeklyDrawdownActive,
		};

		const openSymbols = new Set(openPositions.map((p) => `${p.symbol}:${p.exchange}`));

		for (const symbolSpec of exchangeFiltered) {
			const [symbol, exchange] = symbolSpec.includes(":")
				? symbolSpec.split(":")
				: [symbolSpec, "NASDAQ"];

			// Skip symbols with no open position when entries are disallowed (us_close)
			if (options?.allowNewEntries === false && !openSymbols.has(`${symbol}:${exchange}`)) {
				continue;
			}

			const data = await getQuoteAndIndicators(symbol!, exchange!);
			if (!data) continue;

			try {
				await evaluateStrategyForSymbol(strategy, symbol!, exchange!, data, riskState);
			} catch (error) {
				log.error({ strategy: strategy.name, symbol, error }, "Error evaluating strategy");
			}
		}
	}

	// ── Graduated strategies (dispatch-filtered) ────────────────────────────
	const dispatchDecisions = getLatestDispatchDecisions();

	const graduatedStatuses = ["probation", "active", "core"] as const;
	const graduatedStrategies = await db
		.select()
		.from(strategies)
		.where(inArray(strategies.status, [...graduatedStatuses]));

	if (graduatedStrategies.length === 0) {
		clearDispatchDecisions();
		return;
	}

	// Build a set of activated strategy-symbol pairs from dispatch
	const activatedPairs = new Set(
		dispatchDecisions
			.filter((d) => d.action === "activate")
			.map((d) => `${d.strategyId}:${d.symbol}`),
	);

	// Build a set of explicitly skipped pairs
	const skippedPairs = new Set(
		dispatchDecisions.filter((d) => d.action === "skip").map((d) => `${d.strategyId}:${d.symbol}`),
	);

	log.info(
		{
			graduated: graduatedStrategies.length,
			activated: activatedPairs.size,
			skipped: skippedPairs.size,
		},
		"Evaluating graduated strategies with dispatch filtering",
	);

	for (const strategy of graduatedStrategies) {
		if (!strategy.universe) continue;
		const rawUniverse: string[] = JSON.parse(strategy.universe);
		const withInjections = await buildEffectiveUniverse(rawUniverse);
		const defaultExchange = "NASDAQ";
		const filteredUniverse = await filterByLiquidity(withInjections, defaultExchange);

		// Apply exchange filter if provided (session-aware scheduling)
		const exchangeFilteredGrad = options?.exchanges
			? filteredUniverse.filter((spec) => {
					const ex = spec.includes(":") ? spec.split(":")[1]! : "NASDAQ";
					return options.exchanges!.includes(ex as Exchange);
				})
			: filteredUniverse;

		const openPositions = await getOpenPositions(strategy.id);
		const riskState = {
			openPositionCount: openPositions.length,
			openPositionSectors: openPositions.map(() => null as string | null),
			weeklyDrawdownActive,
		};

		const openSymbolsGrad = new Set(openPositions.map((p) => `${p.symbol}:${p.exchange}`));

		for (const symbolSpec of exchangeFilteredGrad) {
			const [symbol, exchange] = symbolSpec.includes(":")
				? symbolSpec.split(":")
				: [symbolSpec, "NASDAQ"];

			// Skip symbols with no open position when entries are disallowed (us_close)
			if (options?.allowNewEntries === false && !openSymbolsGrad.has(`${symbol}:${exchange}`)) {
				continue;
			}

			const pairKey = `${strategy.id}:${symbol}`;

			// Skip if dispatch explicitly said skip
			if (skippedPairs.has(pairKey)) {
				log.debug({ strategy: strategy.name, symbol }, "Skipped by dispatch");
				continue;
			}

			// If dispatch had opinions on this strategy but didn't activate this symbol, skip
			const dispatchHasOpinionOnStrategy = dispatchDecisions.some(
				(d) => d.strategyId === strategy.id,
			);
			if (dispatchHasOpinionOnStrategy && !activatedPairs.has(pairKey)) {
				continue;
			}

			const data = await getQuoteAndIndicators(symbol!, exchange!);
			if (!data) continue;

			try {
				await evaluateStrategyForSymbol(strategy, symbol!, exchange!, data, riskState);
			} catch (error) {
				log.error(
					{ strategy: strategy.name, symbol, error },
					"Error evaluating graduated strategy",
				);
			}
		}
	}

	clearDispatchDecisions();
}
