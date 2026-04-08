import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { paperPositions, paperTrades, strategies } from "../db/schema.ts";
import { getTradeFriction } from "../utils/fx.ts";
import { calcPnl } from "./pnl.ts";

export interface OpenPositionInput {
	strategyId: number;
	symbol: string;
	exchange: string;
	side: "BUY" | "SELL";
	price: number;
	quantity: number;
	signalType: string;
	reasoning: string;
}

export interface ClosePositionInput {
	positionId: number;
	strategyId: number;
	exitPrice: number;
	signalType: string;
	reasoning: string;
}

export async function openPaperPosition(input: OpenPositionInput): Promise<void> {
	const db = getDb();
	const frictionPct = getTradeFriction(input.exchange, input.side);
	const positionValue = input.quantity * input.price;
	const friction = positionValue * frictionPct;

	await db.insert(paperPositions).values({
		strategyId: input.strategyId,
		symbol: input.symbol,
		exchange: input.exchange,
		side: input.side,
		quantity: input.quantity,
		entryPrice: input.price,
		currentPrice: input.price,
	});

	await db.insert(paperTrades).values({
		strategyId: input.strategyId,
		symbol: input.symbol,
		exchange: input.exchange,
		side: input.side as "BUY" | "SELL",
		quantity: input.quantity,
		price: input.price,
		friction,
		signalType: input.signalType,
		reasoning: input.reasoning,
	});

	// Atomic balance deduction — safe even if evaluator is ever parallelized
	await db
		.update(strategies)
		.set({
			virtualBalance: sql`${strategies.virtualBalance} - ${positionValue + friction}`,
		})
		.where(eq(strategies.id, input.strategyId));
}

export async function closePaperPosition(input: ClosePositionInput): Promise<void> {
	const db = getDb();

	const [position] = await db
		.select()
		.from(paperPositions)
		.where(eq(paperPositions.id, input.positionId));

	if (!position) throw new Error(`Position ${input.positionId} not found`);

	const entrySide = position.side as "BUY" | "SELL";
	const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
	const entryFrictionPct = getTradeFriction(position.exchange, entrySide);
	const exitFrictionPct = getTradeFriction(position.exchange, exitSide);

	const pnl = calcPnl(
		entrySide,
		position.quantity,
		position.entryPrice,
		input.exitPrice,
		entryFrictionPct,
		exitFrictionPct,
	);

	const exitFriction = position.quantity * input.exitPrice * exitFrictionPct;

	await db
		.update(paperPositions)
		.set({ closedAt: new Date().toISOString(), currentPrice: input.exitPrice })
		.where(eq(paperPositions.id, input.positionId));

	await db.insert(paperTrades).values({
		strategyId: input.strategyId,
		symbol: position.symbol,
		exchange: position.exchange,
		side: exitSide as "BUY" | "SELL",
		quantity: position.quantity,
		price: input.exitPrice,
		friction: exitFriction,
		pnl,
		signalType: input.signalType,
		reasoning: input.reasoning,
	});

	// Atomic balance credit — safe even if evaluator is ever parallelized
	const proceeds = position.quantity * input.exitPrice - exitFriction;
	await db
		.update(strategies)
		.set({
			virtualBalance: sql`${strategies.virtualBalance} + ${proceeds}`,
		})
		.where(eq(strategies.id, input.strategyId));
}

export async function getOpenPositions(strategyId: number) {
	const db = getDb();
	return db
		.select()
		.from(paperPositions)
		.where(and(eq(paperPositions.strategyId, strategyId), isNull(paperPositions.closedAt)));
}

export async function getOpenPositionForSymbol(
	strategyId: number,
	symbol: string,
	exchange: string,
) {
	const db = getDb();
	const [position] = await db
		.select()
		.from(paperPositions)
		.where(
			and(
				eq(paperPositions.strategyId, strategyId),
				eq(paperPositions.symbol, symbol),
				eq(paperPositions.exchange, exchange),
				isNull(paperPositions.closedAt),
			),
		)
		.limit(1);
	return position ?? null;
}

/** Returns the closedAt timestamp of the most recently closed position for this strategy+symbol, or null. */
export async function getLastClosedTime(
	strategyId: number,
	symbol: string,
	exchange: string,
): Promise<string | null> {
	const db = getDb();
	const [row] = await db
		.select({ closedAt: paperPositions.closedAt })
		.from(paperPositions)
		.where(
			and(
				eq(paperPositions.strategyId, strategyId),
				eq(paperPositions.symbol, symbol),
				eq(paperPositions.exchange, exchange),
				isNotNull(paperPositions.closedAt),
			),
		)
		.orderBy(desc(paperPositions.closedAt))
		.limit(1);
	return row?.closedAt ?? null;
}
