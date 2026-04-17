import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "seed" });

export const SEED_STRATEGIES = [
	{
		name: "news_sentiment_mr_v1",
		description:
			"Buy on positive sentiment divergence with oversold RSI, short the inverse. Targets LLM's text comprehension edge for detecting nuance beyond keyword sentiment.",
		parameters: JSON.stringify({
			sentiment_threshold: 0.7,
			rsi_oversold: 30,
			rsi_overbought: 70,
			hold_days: 3,
			position_size_pct: 10,
		}),
		signals: JSON.stringify({
			entry_long: "news_sentiment > 0.7 AND rsi14 < 30 AND volume_ratio > 1.5",
			entry_short: "news_sentiment < -0.7 AND rsi14 > 70 AND volume_ratio > 1.5",
			exit: "hold_days >= 3 OR pnl_pct < -2 OR pnl_pct > 5",
		}),
		universe: JSON.stringify([
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
			"USO", // Proposal #8 — commodity/energy proxy
			"SHEL:LSE",
			"BP.:LSE",
			"HSBA:LSE",
			"VOD:LSE",
			"RIO:LSE",
			"GAW:AIM",
			"FDEV:AIM",
			"TET:AIM",
			"JET2:AIM",
			"BOWL:AIM",
		]),
		status: "paper" as const,
		virtualBalance: 10000,
		generation: 1,
		createdBy: "seed",
	},
	{
		name: "gap_fade_v1",
		description:
			"Fade opening gaps > 2%, but only when no fundamental catalyst detected by LLM. Edge: filters out gaps caused by real catalysts that shouldn't be faded.",
		parameters: JSON.stringify({
			gap_threshold_pct: 2,
			exit_target_pct: 1,
			position_size_pct: 10,
		}),
		signals: JSON.stringify({
			entry_long: "change_percent < -2 AND news_sentiment > -0.3",
			entry_short: "change_percent > 2 AND news_sentiment < 0.3",
			exit: "hold_days >= 1 OR pnl_pct < -3 OR pnl_pct > 1",
		}),
		universe: JSON.stringify([
			"AAPL",
			"MSFT",
			"GOOGL",
			"AMZN",
			"NVDA",
			"TSLA",
			"META",
			"AMD",
			"NFLX",
			"CRM",
			"USO", // Proposal #8 — commodity/energy proxy
			"SHEL:LSE",
			"BP.:LSE",
			"HSBA:LSE",
			"AZN:LSE",
			"ULVR:LSE",
			"GAW:AIM",
			"FDEV:AIM",
			"TET:AIM",
			"JET2:AIM",
			"FEVR:AIM",
		]),
		status: "paper" as const,
		virtualBalance: 10000,
		generation: 1,
		createdBy: "seed",
	},
	{
		name: "earnings_drift_v1",
		description:
			"Post-earnings drift: long on positive surprise with confident tone, short on negative. Edge: LLM assesses management tone, not just the EPS numbers.",
		parameters: JSON.stringify({
			earnings_surprise_min: 0.7,
			tone_long_min: 0.5,
			tone_short_max: 0.3,
			hold_days: 5,
			position_size_pct: 8,
		}),
		signals: JSON.stringify({
			entry_long: "earnings_surprise > 0.7 AND management_tone > 0.5 AND volume_ratio > 2.0",
			entry_short: "earnings_surprise > 0.7 AND management_tone < 0.3 AND volume_ratio > 2.0",
			exit: "hold_days >= 5 OR pnl_pct < -3 OR pnl_pct > 8",
		}),
		universe: JSON.stringify([
			"AAPL",
			"MSFT",
			"GOOGL",
			"AMZN",
			"NVDA",
			"TSLA",
			"META",
			"AMD",
			"NFLX",
			"CRM",
			"PYPL",
			"USO", // Proposal #8 — commodity/energy proxy
			"SHEL:LSE",
			"BP.:LSE",
			"HSBA:LSE",
			"AZN:LSE",
			"GAW:AIM",
			"FDEV:AIM",
			"TET:AIM",
			"JET2:AIM",
			"BOWL:AIM",
		]),
		status: "paper" as const,
		virtualBalance: 10000,
		generation: 1,
		createdBy: "seed",
	},
];

export async function ensureSeedStrategies(): Promise<void> {
	const db = getDb();
	const existing = await db.select({ id: strategies.id }).from(strategies);

	if (existing.length > 0) {
		log.info({ count: existing.length }, "Strategies already exist, skipping seed");
		return;
	}

	for (const seed of SEED_STRATEGIES) {
		await db.insert(strategies).values(seed);
	}

	log.info({ count: SEED_STRATEGIES.length }, "Seed strategies inserted");
}
