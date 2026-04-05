import { extractFillData, mapIbStatus } from "./order-status.ts";
import type { OpenOrderLike, OrderEvent } from "./order-types.ts";

const TERMINAL_STATUSES = new Set(["FILLED", "CANCELLED", "ERROR"]);

export function processOrderUpdate(
	trackedOrders: Map<number, number>,
	openOrders: readonly OpenOrderLike[],
): OrderEvent[] {
	const events: OrderEvent[] = [];

	for (const order of openOrders) {
		const tradeId = trackedOrders.get(order.orderId);
		if (tradeId === undefined) continue;

		const ibStatus = order.orderState?.status;
		if (!ibStatus) continue;

		const status = mapIbStatus(ibStatus);
		const fillData = status === "FILLED" ? extractFillData(order) : undefined;

		events.push({ tradeId, status, fillData });

		if (TERMINAL_STATUSES.has(status)) {
			trackedOrders.delete(order.orderId);
		}
	}

	return events;
}
