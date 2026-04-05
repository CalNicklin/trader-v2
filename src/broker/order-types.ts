export type TradeStatus =
	| "PENDING"
	| "SUBMITTED"
	| "FILLED"
	| "PARTIALLY_FILLED"
	| "CANCELLED"
	| "ERROR";

export interface OpenOrderLike {
	readonly orderId: number;
	readonly orderState?: {
		readonly status?: string;
		readonly commission?: number;
	};
	readonly orderStatus?: {
		readonly avgFillPrice?: number;
		readonly filled?: number;
		readonly remaining?: number;
	};
}

export interface ExecutionLike {
	readonly orderId?: number;
	readonly avgPrice?: number;
	readonly shares?: number;
	readonly side?: string;
	readonly time?: string;
}

export interface SubmittedTrade {
	readonly id: number;
	readonly ibOrderId: number;
	readonly symbol: string;
	readonly status: "SUBMITTED";
}

export interface FillData {
	readonly fillPrice?: number;
	readonly commission?: number;
	readonly filledAt?: string;
}

export interface OrderEvent {
	readonly tradeId: number;
	readonly status: TradeStatus;
	readonly fillData?: FillData;
}
