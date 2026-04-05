import { eq } from "drizzle-orm";
import type { Subscription } from "rxjs";
import { z } from "zod";
import { liveTrades } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { processOrderUpdate } from "./order-events.ts";
import type { OpenOrderLike } from "./order-types.ts";

const log = createChildLogger({ module: "order-monitor" });

const OrderStatusSchema = z.object({
	avgFillPrice: z.number().optional(),
	filled: z.number().optional(),
	remaining: z.number().optional(),
	status: z.string().optional(),
});

const trackedOrders = new Map<number, number>();
let orderSub: Subscription | null = null;
let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;

const RESUBSCRIBE_DELAY_MS = 5_000;

interface SubscribableApi {
	getOpenOrders(): {
		subscribe(handlers: {
			next: (update: { all: readonly OpenOrderLike[] }) => void;
			error?: (err: unknown) => void;
			complete?: () => void;
		}): Subscription;
	};
}

interface UpdatableDb {
	update(table: typeof liveTrades): {
		set(data: Record<string, unknown>): {
			where(condition: unknown): Promise<unknown>;
		};
	};
}

function validateOrderStatus(order: OpenOrderLike): OpenOrderLike {
	if (!order.orderStatus) return order;
	const parsed = OrderStatusSchema.safeParse(order.orderStatus);
	if (!parsed.success) {
		log.warn(
			{ orderId: order.orderId, errors: parsed.error.format() },
			"Invalid orderStatus shape from IB — skipping status fields",
		);
		return { ...order, orderStatus: undefined };
	}
	return order;
}

function subscribe(api: SubscribableApi, db: UpdatableDb): void {
	orderSub = api.getOpenOrders().subscribe({
		next: (update) => {
			const validated = update.all.map(validateOrderStatus);
			const events = processOrderUpdate(trackedOrders, validated);

			for (const event of events) {
				const updateData: Record<string, unknown> = {
					status: event.status,
					updatedAt: new Date().toISOString(),
				};

				if (event.status === "FILLED") {
					updateData.filledAt = new Date().toISOString();
					if (event.fillData?.fillPrice) {
						updateData.fillPrice = event.fillData.fillPrice;
					}
					if (event.fillData?.commission !== undefined) {
						updateData.commission = event.fillData.commission;
					}
				}

				db.update(liveTrades)
					.set(updateData)
					.where(eq(liveTrades.id, event.tradeId))
					.then(() => {
						log.info({ tradeId: event.tradeId, status: event.status }, "Trade status updated");
					})
					.catch((err: unknown) => {
						log.error({ tradeId: event.tradeId, error: err }, "Failed to update trade status");
					});
			}
		},
		error: (err) => {
			log.error({ error: err }, "Order subscription error — will resubscribe");
			orderSub = null;
			resubscribeTimer = setTimeout(() => {
				resubscribeTimer = null;
				log.info("Resubscribing to order updates");
				subscribe(api, db);
			}, RESUBSCRIBE_DELAY_MS);
		},
		complete: () => {
			log.warn("Order subscription completed unexpectedly — will resubscribe");
			orderSub = null;
			resubscribeTimer = setTimeout(() => {
				resubscribeTimer = null;
				log.info("Resubscribing to order updates");
				subscribe(api, db);
			}, RESUBSCRIBE_DELAY_MS);
		},
	});
}

export function startOrderMonitoring(api: SubscribableApi, db: UpdatableDb): void {
	if (orderSub) {
		log.warn("Order monitoring already started");
		return;
	}
	log.info("Starting order monitoring (shared subscription)");
	subscribe(api, db);
}

export function trackOrder(ibOrderId: number, tradeId: number): void {
	trackedOrders.set(ibOrderId, tradeId);
	log.info({ ibOrderId, tradeId }, "Tracking order");
}

export function stopOrderMonitoring(): void {
	if (resubscribeTimer) {
		clearTimeout(resubscribeTimer);
		resubscribeTimer = null;
	}
	if (orderSub) {
		orderSub.unsubscribe();
		orderSub = null;
	}
	trackedOrders.clear();
	log.info("Order monitoring stopped");
}
