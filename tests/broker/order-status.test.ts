import { describe, expect, test } from "bun:test";

describe("order-status", () => {
	test("mapIbStatus maps known IB statuses", async () => {
		const { mapIbStatus } = await import("../../src/broker/order-status.ts");
		expect(mapIbStatus("Filled")).toBe("FILLED");
		expect(mapIbStatus("Cancelled")).toBe("CANCELLED");
		expect(mapIbStatus("ApiCancelled")).toBe("CANCELLED");
		expect(mapIbStatus("Submitted")).toBe("SUBMITTED");
		expect(mapIbStatus("PreSubmitted")).toBe("SUBMITTED");
		expect(mapIbStatus("Inactive")).toBe("ERROR");
	});

	test("mapIbStatus defaults unknown statuses to SUBMITTED", async () => {
		const { mapIbStatus } = await import("../../src/broker/order-status.ts");
		expect(mapIbStatus("SomeNewStatus")).toBe("SUBMITTED");
	});

	test("extractFillData extracts price and commission", async () => {
		const { extractFillData } = await import("../../src/broker/order-status.ts");
		const order = {
			orderId: 1,
			orderState: { status: "Filled", commission: 1.25 },
			orderStatus: { avgFillPrice: 150.5, filled: 10, remaining: 0 },
		};
		const fill = extractFillData(order);
		expect(fill.fillPrice).toBe(150.5);
		expect(fill.commission).toBe(1.25);
	});

	test("extractFillData ignores sentinel commission value", async () => {
		const { extractFillData } = await import("../../src/broker/order-status.ts");
		const order = {
			orderId: 1,
			orderState: { status: "Filled", commission: 1e9 },
			orderStatus: { avgFillPrice: 100 },
		};
		const fill = extractFillData(order);
		expect(fill.fillPrice).toBe(100);
		expect(fill.commission).toBeUndefined();
	});
});
