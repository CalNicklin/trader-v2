import { gte, sql } from "drizzle-orm";
import { getConfig } from "../config.ts";
import type { DbClient } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import { tokenUsage } from "../db/schema.ts";

export async function getDailySpend(db?: DbClient): Promise<number> {
	const d = db ?? getDb();
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);

	const [row] = await d
		.select({ total: sql<number>`coalesce(sum(${tokenUsage.estimatedCostUsd}), 0)` })
		.from(tokenUsage)
		.where(gte(tokenUsage.createdAt, todayStart.toISOString()));

	return row?.total ?? 0;
}

export async function canAffordCall(estimatedCost: number, db?: DbClient): Promise<boolean> {
	const config = getConfig();
	if (config.DAILY_API_BUDGET_USD <= 0) return true;
	const d = db ?? getDb();
	const spent = await getDailySpend(d);
	return spent + estimatedCost < config.DAILY_API_BUDGET_USD;
}
