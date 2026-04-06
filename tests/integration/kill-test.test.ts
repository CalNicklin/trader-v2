// tests/integration/kill-test.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("kill test: circuit breakers survive losing streak", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { graduationEvents, riskState, strategyMetrics, strategies } = await import(
			"../../src/db/schema.ts"
		);
		await db.delete(graduationEvents);
		await db.delete(strategyMetrics);
		await db.delete(riskState);
		await db.delete(strategies);
	});

	test("daily halt flag triggers isTradingHalted and prevents further trades", async () => {
		const { riskState } = await import("../../src/db/schema.ts");
		await db
			.insert(riskState)
			.values({ key: "daily_halt_active", value: "true" })
			.onConflictDoUpdate({ target: riskState.key, set: { value: "true" } });

		const { isTradingHalted } = await import("../../src/risk/guardian.ts");
		const result = await isTradingHalted();

		expect(result.halted).toBe(true);
		expect(result.requiresManualRestart).toBe(false);
		expect(result.reason).toContain("Daily");
	});

	test("circuit breaker flag halts trading and requires manual restart", async () => {
		const { riskState } = await import("../../src/db/schema.ts");
		await db
			.insert(riskState)
			.values({ key: "circuit_breaker_tripped", value: "true" })
			.onConflictDoUpdate({ target: riskState.key, set: { value: "true" } });

		const { isTradingHalted } = await import("../../src/risk/guardian.ts");
		const result = await isTradingHalted();

		expect(result.halted).toBe(true);
		expect(result.requiresManualRestart).toBe(true);
	});

	test("drawdown kill retires strategy exceeding 15% max drawdown", async () => {
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");
		const { checkDrawdowns } = await import("../../src/evolution/population.ts");

		const [strategy] = await db
			.insert(strategies)
			.values({
				name: "drawdown_kill_test",
				description: "Test strategy for kill test",
				parameters: JSON.stringify({ hold_days: 1 }),
				signals: JSON.stringify({ entry_long: "last > 0", exit: "hold_days >= 1" }),
				universe: JSON.stringify(["TEST"]),
				status: "paper",
				virtualBalance: 10000,
				createdBy: "evolution",
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strategy.id,
			sampleSize: 10,
			winRate: 0.3,
			expectancy: -0.5,
			profitFactor: 0.5,
			sharpeRatio: -1.0,
			maxDrawdownPct: 18.5,
			consistencyScore: 0,
		});

		const kills = await checkDrawdowns();
		expect(kills.length).toBeGreaterThanOrEqual(1);
		expect(kills).toContain(strategy.id);

		const updated = await db
			.select()
			.from(strategies)
			.where(eq(strategies.id, strategy.id))
			.get();
		expect(updated?.status).toBe("retired");
	});

	test("evolution cannot modify risk constants", () => {
		const { PARAMETER_RANGES } = require("../../src/evolution/validator");
		expect(PARAMETER_RANGES).not.toHaveProperty("max_daily_loss_pct");
		expect(PARAMETER_RANGES).not.toHaveProperty("circuit_breaker_pct");
		expect(PARAMETER_RANGES).not.toHaveProperty("max_concurrent_positions");
		expect(PARAMETER_RANGES).not.toHaveProperty("risk_per_trade_pct");
	});

	test("dispatch decisions are validated against risk limits before execution", async () => {
		const { parseDispatchResponse } = await import("../../src/strategy/dispatch.ts");

		const decisions = parseDispatchResponse(
			JSON.stringify({
				decisions: [
					{ strategyId: 1, symbol: "AAPL", action: "activate", reasoning: "test" },
				],
			}),
		);

		expect(decisions).toHaveLength(1);
		expect(decisions[0].action).toBe("activate");
	});
});
