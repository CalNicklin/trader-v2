import type { FillData, OpenOrderLike, TradeStatus } from "./order-types.ts";

const IB_COMMISSION_SENTINEL = 1e9;

const statusMap: Readonly<Record<string, TradeStatus>> = {
	Submitted: "SUBMITTED",
	PreSubmitted: "SUBMITTED",
	PendingSubmit: "SUBMITTED",
	PendingCancel: "SUBMITTED",
	Filled: "FILLED",
	Cancelled: "CANCELLED",
	ApiCancelled: "CANCELLED",
	Inactive: "ERROR",
};

export function mapIbStatus(ibStatus: string): TradeStatus {
	return statusMap[ibStatus] ?? "SUBMITTED";
}

export function extractFillData(order: OpenOrderLike): FillData {
	const avgFillPrice = order.orderStatus?.avgFillPrice;
	const commission = order.orderState?.commission;

	return {
		fillPrice: avgFillPrice && avgFillPrice > 0 ? avgFillPrice : undefined,
		commission:
			commission !== undefined && commission < IB_COMMISSION_SENTINEL ? commission : undefined,
	};
}
