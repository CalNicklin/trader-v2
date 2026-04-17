import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache, researchOutcome } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "research-calibration" });

export interface RecordOutcomeInput {
	newsAnalysisId: number;
	symbol: string;
	exchange: string;
	predictedDirection: "long" | "short" | "avoid";
	confidence: number;
	eventType: string;
	priceAtCall: number | null;
}

export async function recordOutcome(input: RecordOutcomeInput): Promise<void> {
	const db = getDb();
	await db.insert(researchOutcome).values({
		newsAnalysisId: input.newsAnalysisId,
		symbol: input.symbol,
		exchange: input.exchange,
		predictedDirection: input.predictedDirection,
		confidence: input.confidence,
		eventType: input.eventType,
		priceAtCall: input.priceAtCall,
	});
}

const MS_PER_HOUR = 3_600_000;

/**
 * Fill realised-move columns by comparing priceAtCall against the latest quote
 * in quotes_cache. Run as a batch job T+24h and T+48h post-call. Returns the
 * number of rows newly filled.
 */
export async function backfillOutcomes(opts: { window: "24h" | "48h" }): Promise<number> {
	const db = getDb();
	const thresholdMs = opts.window === "24h" ? 24 * MS_PER_HOUR : 48 * MS_PER_HOUR;
	const cutoff = new Date(Date.now() - thresholdMs).toISOString();

	const pending = await db
		.select()
		.from(researchOutcome)
		.where(
			and(
				lt(researchOutcome.createdAt, cutoff),
				opts.window === "24h"
					? isNull(researchOutcome.filled24hAt)
					: isNull(researchOutcome.filled48hAt),
			),
		)
		.all();

	let filled = 0;
	for (const row of pending) {
		if (row.priceAtCall == null) continue;
		const [quote] = await db
			.select({ last: quotesCache.last })
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, row.symbol), eq(quotesCache.exchange, row.exchange)))
			.limit(1);
		if (!quote?.last) continue;

		const move = (quote.last - row.priceAtCall) / row.priceAtCall;
		const update =
			opts.window === "24h"
				? { realisedMove24h: move, filled24hAt: new Date().toISOString() }
				: { realisedMove48h: move, filled48hAt: new Date().toISOString() };
		await db.update(researchOutcome).set(update).where(eq(researchOutcome.id, row.id));
		filled++;
	}

	log.info({ window: opts.window, filled, considered: pending.length }, "calibration_backfill");
	return filled;
}
