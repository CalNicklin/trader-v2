import { describe, expect, test, beforeEach } from "bun:test";
import {
	strategies,
	strategyMetrics,
	strategyMutations,
	improvementProposals,
	tokenUsage,
} from "../../src/db/schema";
import {
	buildWeeklyDigestHtml,
	getWeeklyDigestData,
} from "../../src/scheduler/weekly-digest-job";

describe("weekly digest", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		db.delete(improvementProposals).run();
		db.delete(tokenUsage).run();
		db.delete(strategyMutations).run();
		db.delete(strategyMetrics).run();
		db.delete(strategies).run();
	});

	test("getWeeklyDigestData returns data for last 7 days", async () => {
		const data = await getWeeklyDigestData();
		expect(data.periodStart).toBeDefined();
		expect(data.periodEnd).toBeDefined();
		expect(data.evolutionEvents).toBeArray();
		expect(data.improvementProposals).toBeArray();
		expect(data.totalApiSpend).toBeGreaterThanOrEqual(0);
	});

	test("buildWeeklyDigestHtml returns valid HTML", async () => {
		const data = await getWeeklyDigestData();
		const html = buildWeeklyDigestHtml(data);
		expect(html).toContain("<h2>");
		expect(html).toContain("Weekly Digest");
		expect(html).toContain(data.periodStart);
	});

	test("includes evolution mutations from the past week", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const db = getDb();
		const [parent] = await db
			.insert(strategies)
			.values({
				name: "parent_v1",
				description: "test",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		const [child] = await db
			.insert(strategies)
			.values({
				name: "parent_v1.1",
				description: "child",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 2,
				createdBy: "evolution",
				parentStrategyId: parent!.id,
			})
			.returning();

		await db.insert(strategyMutations).values({
			parentId: parent!.id,
			childId: child!.id,
			mutationType: "parameter_tweak",
			parameterDiff: JSON.stringify({ hold_days: { from: 3, to: 5 } }),
		});

		const data = await getWeeklyDigestData();
		expect(data.evolutionEvents.length).toBe(1);
		expect(data.evolutionEvents[0].mutationType).toBe("parameter_tweak");
	});

	test("includes improvement proposals from the past week", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const db = getDb();
		await db.insert(improvementProposals).values({
			title: "Improve RSI signal weighting",
			description: "Adjust RSI thresholds based on volatility",
			status: "PR_CREATED" as const,
			prUrl: "https://github.com/example/trader-v2/pull/42",
		});

		const data = await getWeeklyDigestData();
		expect(data.improvementProposals.length).toBe(1);
	});
});
