/**
 * One-off backfill: run the research agent against all existing tradeable news events
 * that don't yet have news_analyses rows.
 *
 * Usage: bun scripts/backfill-research.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db/client.ts";
import { newsAnalyses, newsEvents } from "../src/db/schema.ts";
import { runResearchAnalysis } from "../src/news/research-agent.ts";
import { createChildLogger } from "../src/utils/logger.ts";

const log = createChildLogger({ module: "backfill-research" });

async function main() {
	const db = getDb();

	// Find tradeable events that haven't been analysed yet
	const analysedEventIds = db
		.select({ newsEventId: newsAnalyses.newsEventId })
		.from(newsAnalyses);

	const unanalysed = await db
		.select({
			id: newsEvents.id,
			headline: newsEvents.headline,
			source: newsEvents.source,
			symbols: newsEvents.symbols,
			sentiment: newsEvents.sentiment,
			confidence: newsEvents.confidence,
			eventType: newsEvents.eventType,
			urgency: newsEvents.urgency,
		})
		.from(newsEvents)
		.where(
			and(
				eq(newsEvents.tradeable, true),
				sql`${newsEvents.id} NOT IN (SELECT DISTINCT news_event_id FROM news_analyses)`,
			),
		)
		.orderBy(newsEvents.id);

	log.info({ count: unanalysed.length }, "Found tradeable events without research analysis");

	let processed = 0;
	let failed = 0;

	for (const event of unanalysed) {
		const symbols: string[] = JSON.parse(event.symbols ?? "[]");

		try {
			const result = await runResearchAnalysis(event.id, {
				headline: event.headline,
				source: event.source ?? "finnhub",
				symbols,
				classification: {
					sentiment: event.sentiment ?? 0,
					confidence: event.confidence ?? 0,
					tradeable: true,
					eventType: event.eventType ?? "other",
					urgency: event.urgency ?? "medium",
				},
			});

			if (result.skippedBudget) {
				log.warn("Budget exceeded — stopping backfill");
				break;
			}

			processed++;
			log.info(
				{
					id: event.id,
					headline: event.headline.slice(0, 60),
					analyses: result.analyses,
					progress: `${processed}/${unanalysed.length}`,
				},
				"Backfilled",
			);

			// Small delay to avoid rate limiting
			await new Promise((r) => setTimeout(r, 500));
		} catch (err) {
			failed++;
			log.error({ id: event.id, err }, "Backfill failed for event");
		}
	}

	log.info({ processed, failed, total: unanalysed.length }, "Backfill complete");
}

main().catch((err) => {
	console.error("Backfill failed:", err);
	process.exit(1);
});
