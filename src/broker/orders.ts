import { type Order, OrderAction, OrderType } from "@stoqey/ib";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { liveTrades } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { getApi } from "./connection.ts";
import { type Exchange, getContract } from "./contracts.ts";
import { trackOrder } from "./order-monitor.ts";

const log = createChildLogger({ module: "broker-orders" });

export interface TradeRequest {
	strategyId?: number;
	symbol: string;
	exchange?: Exchange;
	side: "BUY" | "SELL";
	quantity: number;
	orderType: "LIMIT" | "MARKET";
	limitPrice?: number;
	reasoning?: string;
	confidence?: number;
}

export interface TradeResult {
	tradeId: number;
	ibOrderId: number;
	status: string;
}

/** Place a trade order and log it to the live_trades table */
export async function placeTrade(req: TradeRequest): Promise<TradeResult> {
	const db = getDb();
	const api = getApi();
	const exchange = req.exchange ?? "LSE";
	const contract = getContract(req.symbol, exchange);

	const [tradeRecord] = await db
		.insert(liveTrades)
		.values({
			strategyId: req.strategyId ?? null,
			symbol: req.symbol,
			exchange,
			side: req.side as "BUY" | "SELL",
			quantity: req.quantity,
			orderType: req.orderType as "LIMIT" | "MARKET",
			limitPrice: req.limitPrice,
			reasoning: req.reasoning,
			confidence: req.confidence,
			status: "PENDING" as const,
		})
		.returning();

	if (!tradeRecord) {
		throw new Error("Failed to create trade record");
	}

	const order: Order = {
		action: req.side === "BUY" ? OrderAction.BUY : OrderAction.SELL,
		totalQuantity: req.quantity,
		orderType: req.orderType === "LIMIT" ? OrderType.LMT : OrderType.MKT,
		tif: "DAY",
		transmit: true,
	};

	if (req.orderType === "LIMIT" && req.limitPrice) {
		order.lmtPrice = req.limitPrice;
	}

	try {
		const ibOrderId = await api.placeNewOrder(contract, order);

		await db
			.update(liveTrades)
			.set({
				ibOrderId,
				status: "SUBMITTED" as const,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(liveTrades.id, tradeRecord.id));

		log.info(
			{
				tradeId: tradeRecord.id,
				ibOrderId,
				symbol: req.symbol,
				side: req.side,
				qty: req.quantity,
				strategyId: req.strategyId,
			},
			"Order placed",
		);

		trackOrder(ibOrderId, tradeRecord.id);

		return { tradeId: tradeRecord.id, ibOrderId, status: "SUBMITTED" };
	} catch (error) {
		await db
			.update(liveTrades)
			.set({ status: "ERROR" as const, updatedAt: new Date().toISOString() })
			.where(eq(liveTrades.id, tradeRecord.id));

		log.error({ tradeId: tradeRecord.id, error }, "Failed to place order");
		throw error;
	}
}

/** Cancel an order */
export async function cancelOrder(ibOrderId: number): Promise<void> {
	const api = getApi();
	api.cancelOrder(ibOrderId);
	log.info({ ibOrderId }, "Order cancellation requested");
}

/** Get all open orders */
export async function getOpenOrders() {
	const api = getApi();
	return api.getAllOpenOrders();
}
