import { beforeEach, describe, expect, test } from "bun:test";

describe("catalyst-dispatcher gate logic", () => {
	beforeEach(async () => {
		const mod = await import("../../src/strategy/catalyst-dispatcher.ts");
		mod.resetCatalystStateForTesting();
	});

	test("acceptsTrigger returns true for fresh symbol", async () => {
		const { acceptsTrigger } = await import("../../src/strategy/catalyst-dispatcher.ts");
		expect(acceptsTrigger("AAPL", Date.now())).toBe(true);
	});

	test("acceptsTrigger returns false during cooldown window", async () => {
		const { acceptsTrigger, markDispatched } = await import(
			"../../src/strategy/catalyst-dispatcher.ts"
		);
		const now = Date.now();
		markDispatched("AAPL", now);
		expect(acceptsTrigger("AAPL", now + 5 * 60 * 1000)).toBe(false);
		expect(acceptsTrigger("AAPL", now + 31 * 60 * 1000)).toBe(true);
	});

	test("acceptsTrigger enforces daily cap", async () => {
		const { acceptsTrigger, markDispatched } = await import(
			"../../src/strategy/catalyst-dispatcher.ts"
		);
		const now = Date.now();
		for (let i = 0; i < 20; i++) {
			markDispatched(`S${i}`, now);
		}
		expect(acceptsTrigger("SYM", now)).toBe(false);
	});

	test("daily cap resets on a new calendar day (UTC)", async () => {
		const { acceptsTrigger, markDispatched } = await import(
			"../../src/strategy/catalyst-dispatcher.ts"
		);
		const day1 = Date.parse("2026-04-20T14:00:00Z");
		for (let i = 0; i < 20; i++) {
			markDispatched(`S${i}`, day1);
		}
		expect(acceptsTrigger("SYM", day1)).toBe(false);
		const day2 = Date.parse("2026-04-21T00:30:00Z");
		expect(acceptsTrigger("SYM", day2)).toBe(true);
	});

	test("getCatalystMetrics reports zero before any dispatch", async () => {
		const { getCatalystMetrics } = await import("../../src/strategy/catalyst-dispatcher.ts");
		const metrics = getCatalystMetrics();
		expect(metrics.dispatchesToday).toBe(0);
		expect(metrics.capHit).toBe(false);
		expect(metrics.lastDispatchedAt).toBeNull();
	});

	test("getCatalystMetrics tracks count + capHit + lastDispatchedAt", async () => {
		const { getCatalystMetrics, markDispatched } = await import(
			"../../src/strategy/catalyst-dispatcher.ts"
		);
		const now = Date.now();
		markDispatched("AAPL", now);
		const m1 = getCatalystMetrics();
		expect(m1.dispatchesToday).toBe(1);
		expect(m1.capHit).toBe(false);
		expect(m1.lastDispatchedAt).toBe(new Date(now).toISOString());
	});
});
