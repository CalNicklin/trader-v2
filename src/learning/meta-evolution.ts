import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { learningLoopConfig, tradeInsights } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "meta-evolution" });

type ConfigType = "trade_review" | "pattern_analysis" | "graduation";

export async function computeHitRates(): Promise<Record<ConfigType, number>> {
	const db = getDb();
	const rates: Record<ConfigType, number> = {
		trade_review: 0,
		pattern_analysis: 0,
		graduation: 0,
	};

	for (const configType of ["trade_review", "pattern_analysis", "graduation"] as const) {
		const total = await db
			.select({ count: sql<number>`count(*)` })
			.from(tradeInsights)
			.where(
				and(eq(tradeInsights.insightType, configType), isNotNull(tradeInsights.ledToImprovement)),
			);

		const improved = await db
			.select({ count: sql<number>`count(*)` })
			.from(tradeInsights)
			.where(
				and(eq(tradeInsights.insightType, configType), eq(tradeInsights.ledToImprovement, true)),
			);

		const totalCount = total[0]?.count ?? 0;
		const improvedCount = improved[0]?.count ?? 0;

		rates[configType] = totalCount > 0 ? improvedCount / totalCount : 0;
	}

	return rates;
}

export async function updatePromptHitRate(configType: ConfigType, hitRate: number): Promise<void> {
	const db = getDb();
	await db
		.update(learningLoopConfig)
		.set({ hitRate })
		.where(and(eq(learningLoopConfig.configType, configType), eq(learningLoopConfig.active, true)));
}

export async function runMetaEvolutionUpdate(): Promise<void> {
	const rates = await computeHitRates();

	for (const [configType, rate] of Object.entries(rates) as [ConfigType, number][]) {
		await updatePromptHitRate(configType, rate);
		log.info({ configType, hitRate: rate }, "Updated prompt hit rate");
	}
}
