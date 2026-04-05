import { describe, expect, test } from "bun:test";

describe("order-events", () => {
	test("processOrderUpdate emits events for tracked orders", async () => {
		const { processOrderUpdate } = await import("../../src/broker/order-events.ts");
		const tracked = new Map([[100, 1]]);
		const orders = [
			{ orderId: 100, orderState: { status: "Filled", commission: 2.0 }, orderStatus: { avgFillPrice: 150 } },
		];
		const events = processOrderUpdate(tracked, orders);
		expect(events).toHaveLength(1);
		expect(events[0]!.tradeId).toBe(1);
		expect(events[0]!.status).toBe("FILLED");
		expect(events[0]!.fillData?.fillPrice).toBe(150);
	});

	test("processOrderUpdate ignores untracked orders", async () => {
		const { processOrderUpdate } = await import("../../src/broker/order-events.ts");
		const tracked = new Map<number, number>();
		const orders = [
			{ orderId: 999, orderState: { status: "Filled" }, orderStatus: { avgFillPrice: 100 } },
		];
		const events = processOrderUpdate(tracked, orders);
		expect(events).toHaveLength(0);
	});

	test("processOrderUpdate removes terminal orders from tracking", async () => {
		const { processOrderUpdate } = await import("../../src/broker/order-events.ts");
		const tracked = new Map([[100, 1]]);
		const orders = [
			{ orderId: 100, orderState: { status: "Cancelled" } },
		];
		processOrderUpdate(tracked, orders);
		expect(tracked.has(100)).toBe(false);
	});

	test("processOrderUpdate skips orders with no orderState", async () => {
		const { processOrderUpdate } = await import("../../src/broker/order-events.ts");
		const tracked = new Map([[100, 1]]);
		const orders = [{ orderId: 100 }];
		const events = processOrderUpdate(tracked, orders);
		expect(events).toHaveLength(0);
	});
});
