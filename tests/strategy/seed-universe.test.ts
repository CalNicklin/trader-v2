import { describe, expect, test } from "bun:test";

describe("seed universes include USO (Proposal #8)", () => {
	test("every seed's universe includes USO", async () => {
		const seedModule = await import("../../src/strategy/seed.ts");
		const seeds = (seedModule as unknown as { SEED_STRATEGIES?: Array<{ universe: string }> })
			.SEED_STRATEGIES;
		expect(Array.isArray(seeds)).toBe(true);
		for (const seed of seeds!) {
			const universe: string[] = JSON.parse(seed.universe);
			expect(universe).toContain("USO");
		}
	});
});
