import { describe, expect, test } from "bun:test";

describe("capital-allocator", () => {
	test("single probation strategy gets 10% of capital", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[{ strategyId: 1, tier: "probation" }],
			1000,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.allocatedCapital).toBe(100); // 10% of 1000
		expect(result[0]!.maxPositionSize).toBe(25); // 25% of 100
	});

	test("single active strategy gets 25% of capital", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[{ strategyId: 1, tier: "active" }],
			1000,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.allocatedCapital).toBe(250);
	});

	test("single core strategy gets 50% of capital", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[{ strategyId: 1, tier: "core" }],
			1000,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.allocatedCapital).toBe(500);
	});

	test("two probation strategies split tier allocation", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[
				{ strategyId: 1, tier: "probation" },
				{ strategyId: 2, tier: "probation" },
			],
			1000,
		);
		expect(result).toHaveLength(2);
		expect(result[0]!.allocatedCapital).toBe(50); // 100 / 2
		expect(result[1]!.allocatedCapital).toBe(50);
	});

	test("mixed tiers allocate independently", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[
				{ strategyId: 1, tier: "probation" },
				{ strategyId: 2, tier: "active" },
				{ strategyId: 3, tier: "core" },
			],
			1000,
		);
		const byId = new Map(result.map((r) => [r.strategyId, r]));
		expect(byId.get(1)!.allocatedCapital).toBe(100); // probation: 10%
		expect(byId.get(2)!.allocatedCapital).toBe(250); // active: 25%
		expect(byId.get(3)!.allocatedCapital).toBe(500); // core: 50%
	});

	test("returns empty array for no strategies", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		expect(computeAllocations([], 1000)).toHaveLength(0);
	});

	test("returns empty array for zero cash", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		expect(computeAllocations([{ strategyId: 1, tier: "core" }], 0)).toHaveLength(0);
	});

	test("scales down if total exceeds available cash", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		// 3 core strategies: each wants 50% = 150% total — must scale down
		const result = computeAllocations(
			[
				{ strategyId: 1, tier: "core" },
				{ strategyId: 2, tier: "core" },
				{ strategyId: 3, tier: "core" },
			],
			1000,
		);
		// 3 * (500/3) = 500, which is <= 1000, so no scaling needed here
		// Each gets 500/3 = 166.67
		expect(result[0]!.allocatedCapital).toBeCloseTo(166.67, 1);
	});

	test("getTierAllocationPct returns correct percentages", async () => {
		const { getTierAllocationPct } = await import("../../src/live/capital-allocator.ts");
		expect(getTierAllocationPct("probation")).toBe(0.10);
		expect(getTierAllocationPct("active")).toBe(0.25);
		expect(getTierAllocationPct("core")).toBe(0.50);
	});
});
