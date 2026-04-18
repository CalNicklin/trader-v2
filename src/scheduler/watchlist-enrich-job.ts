import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { watchlist } from "../db/schema.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { ENRICH_BATCH_SIZE, ENRICHMENT_RETRY_HOURS } from "../watchlist/constants.ts";
import { enrichOne, type LLMCall } from "../watchlist/enrich.ts";
import { getUnenrichedRows } from "../watchlist/repo.ts";

const log = createChildLogger({ module: "watchlist-enrich-job" });

const OPUS_MODEL = "claude-opus-4-7";
const ESTIMATED_COST_USD = 0.05; // ~1500 input + 500 output tokens on Opus 4.7

export interface WatchlistEnrichJobInput {
	llm?: LLMCall;
	budgetCheck?: () => Promise<boolean>;
}

export interface WatchlistEnrichJobResult {
	enriched: number;
	parseFailed: number;
	llmFailed: number;
	skippedDueToBudget: number;
	markedPermanentlyFailed: number;
}

export async function runWatchlistEnrichJob(
	input: WatchlistEnrichJobInput = {},
): Promise<WatchlistEnrichJobResult> {
	const rows = getUnenrichedRows(ENRICH_BATCH_SIZE);
	const result: WatchlistEnrichJobResult = {
		enriched: 0,
		parseFailed: 0,
		llmFailed: 0,
		skippedDueToBudget: 0,
		markedPermanentlyFailed: 0,
	};
	if (rows.length === 0) {
		log.info("No unenriched rows to process");
		return result;
	}

	const budgetCheck = input.budgetCheck ?? (() => canAffordCall(ESTIMATED_COST_USD * rows.length));
	if (!(await budgetCheck())) {
		log.warn({ batchSize: rows.length }, "Enrichment skipped — daily budget exhausted");
		result.skippedDueToBudget = rows.length;
		return result;
	}

	const llm = input.llm ?? defaultOpusLlm();

	const now = Date.now();
	for (const row of rows) {
		const outcome = await enrichOne(row, llm);
		if (outcome.status === "enriched") {
			result.enriched++;
			continue;
		}

		// parse_failed or llm_failed: check retry window
		const ageHours = (now - Date.parse(row.promotedAt)) / 3600_000;
		if (ageHours > ENRICHMENT_RETRY_HOURS) {
			getDb()
				.update(watchlist)
				.set({ enrichmentFailedAt: new Date(now).toISOString() })
				.where(eq(watchlist.id, row.id))
				.run();
			result.markedPermanentlyFailed++;
			log.error(
				{ symbol: row.symbol, exchange: row.exchange, status: outcome.status },
				"Enrichment permanently failed after retry window",
			);
		}

		if (outcome.status === "parse_failed") result.parseFailed++;
		else result.llmFailed++;
	}

	log.info({ ...result }, "Watchlist enrich job complete");
	return result;
}

function defaultOpusLlm(): LLMCall {
	const config = getConfig();
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
	return async (prompt: string) => {
		const msg = await client.messages.create({
			model: OPUS_MODEL,
			max_tokens: 1024,
			messages: [{ role: "user", content: prompt }],
		});
		await recordUsage("watchlist_enrich", msg.usage.input_tokens, msg.usage.output_tokens);
		const textBlock = msg.content.find((b) => b.type === "text");
		const text = textBlock?.type === "text" ? textBlock.text : "";
		return text;
	};
}
