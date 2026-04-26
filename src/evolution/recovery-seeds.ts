import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { strategies } from "../db/schema";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "evolution:recovery-seeds" });

const SEED_VIRTUAL_BALANCE = 10_000;

interface RecoverySeed {
	name: string;
	description: string;
	parameters: Record<string, number>;
	signals: { entry_long?: string; entry_short?: string; exit: string };
	universe: string[];
}

export const RECOVERY_SEED_POOL: RecoverySeed[] = [
	{
		name: "catalyst_breakout_v1",
		description:
			"Trade strong catalyst-driven momentum — enter when sentiment and price change align with high volume, hold for multi-day drift.",
		parameters: {
			sentiment_threshold: 0.6,
			hold_days: 3,
			position_size_pct: 8,
			stop_loss_pct: 3,
			exit_target_pct: 10,
		},
		signals: {
			entry_long: "news_sentiment > 0.6 AND change_percent > 2 AND volume_ratio > 2.0",
			entry_short: "news_sentiment < -0.6 AND change_percent < -2 AND volume_ratio > 2.0",
			exit: "hold_days >= 3 OR pnl_pct < -3 OR pnl_pct > 10",
		},
		universe: [
			"AAPL",
			"MSFT",
			"GOOGL",
			"AMZN",
			"NVDA",
			"META",
			"AMD",
			"AVGO",
			"MRVL",
			"CRM",
			"NFLX",
			"INTC",
		],
	},
	{
		name: "sentiment_reversal_v1",
		description:
			"Mean reversion on sentiment extremes with price confirmation — requires sentiment divergence from price action plus volume surge.",
		parameters: {
			sentiment_threshold: 0.5,
			hold_days: 4,
			position_size_pct: 7,
			stop_loss_pct: 2.5,
		},
		signals: {
			entry_long: "news_sentiment > 0.5 AND rsi14 < 35 AND change_percent < -1",
			entry_short: "news_sentiment < -0.5 AND rsi14 > 65 AND change_percent > 1",
			exit: "hold_days >= 4 OR pnl_pct < -2.5 OR pnl_pct > 6",
		},
		universe: [
			"AAPL",
			"MSFT",
			"GOOGL",
			"AMZN",
			"NVDA",
			"TSLA",
			"META",
			"JPM",
			"V",
			"JNJ",
			"SHEL:LSE",
			"BP.:LSE",
			"HSBA:LSE",
		],
	},
];

export async function injectRecoverySeed(maxSeeds = 1): Promise<number[]> {
	const db = getDb();

	const existing = await db.select({ name: strategies.name }).from(strategies).all();
	const existingNames = new Set(existing.map((s) => s.name));

	const candidates = RECOVERY_SEED_POOL.filter((s) => !existingNames.has(s.name));
	if (candidates.length === 0) {
		log.info("No unused recovery seeds available");
		return [];
	}

	const toInsert = candidates.slice(0, maxSeeds);
	const inserted: number[] = [];

	for (const seed of toInsert) {
		const [row] = await db
			.insert(strategies)
			.values({
				name: seed.name,
				description: seed.description,
				parameters: JSON.stringify(seed.parameters),
				signals: JSON.stringify(seed.signals),
				universe: JSON.stringify(seed.universe),
				status: "paper" as const,
				virtualBalance: SEED_VIRTUAL_BALANCE,
				generation: 1,
				createdBy: "recovery_seed",
			})
			.returning();

		if (row) {
			inserted.push(row.id);
			log.info({ strategyId: row.id, name: seed.name }, "Injected recovery seed strategy");
		}
	}

	return inserted;
}

export async function isRecoverySeed(strategyId: number): Promise<boolean> {
	const db = getDb();
	const row = await db
		.select({ createdBy: strategies.createdBy })
		.from(strategies)
		.where(eq(strategies.id, strategyId))
		.get();
	return row?.createdBy === "recovery_seed";
}
