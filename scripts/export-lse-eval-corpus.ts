// scripts/export-lse-eval-corpus.ts
//
// One-off exporter that pulls production LSE news events and their analyses
// into a JSON fixture used by the research-agent eval suite.
//
// Usage (run locally against a copy of the production DB):
//   bun scripts/export-lse-eval-corpus.ts > src/evals/research-agent/fixtures/lse-corpus.json

import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../src/db/client.ts";
import { newsAnalyses, newsEvents } from "../src/db/schema.ts";

async function main() {
	const db = getDb();
	const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

	const analyses = await db
		.select()
		.from(newsAnalyses)
		.where(and(eq(newsAnalyses.exchange, "LSE"), gte(newsAnalyses.createdAt, since)))
		.limit(200);

	const eventIds = Array.from(new Set(analyses.map((a) => a.newsEventId)));
	const events = eventIds.length
		? await db.select().from(newsEvents).where(inArray(newsEvents.id, eventIds))
		: [];

	const eventById = new Map(events.map((e) => [e.id, e]));

	const corpus = analyses
		.map((a) => {
			const evt = eventById.get(a.newsEventId);
			if (!evt) return null;
			return {
				headline: evt.headline,
				source: evt.source,
				primarySymbol: a.symbol,
				primaryExchange: a.exchange,
				initialSentiment: a.sentiment,
				// HAND-LABEL REQUIRED: set to the correct primary symbol after review
				correctPrimarySymbol: "",
				notes: "",
			};
		})
		.filter((r) => r !== null);

	console.log(JSON.stringify({ corpus }, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
