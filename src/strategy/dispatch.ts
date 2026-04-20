import Anthropic from "@anthropic-ai/sdk";
import { gte } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { newsEvents } from "../db/schema.ts";
import { getPerformanceLandscape } from "../evolution/analyzer.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { buildDispatchPrompt } from "./dispatch-prompt.ts";
import {
	type DispatchDecisionInput,
	expireScheduledDecisions,
	writeScheduledDecisions,
} from "./dispatch-store.ts";
import type { RegimeSignals } from "./regime.ts";

const log = createChildLogger({ module: "dispatch" });

export interface DispatchDecision extends DispatchDecisionInput {}

interface DispatchResponse {
	decisions: DispatchDecision[];
}

/** Safety-net TTL for scheduled rows. The next scheduled runDispatch explicitly
 * invalidates these rows, so this only matters when dispatch itself fails. */
const SCHEDULED_TTL_MS = 6 * 60 * 60 * 1000;

export function parseDispatchResponse(
	raw: string,
	validStrategyIds?: Set<number>,
): DispatchDecision[] {
	try {
		let cleaned = raw.trim();
		if (cleaned.startsWith("```")) {
			cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
		}
		const parsed: DispatchResponse = JSON.parse(cleaned);
		if (!parsed.decisions || !Array.isArray(parsed.decisions)) return [];

		return parsed.decisions
			.filter((d) => {
				if (typeof d.strategyId !== "number" || !d.symbol || !d.action) return false;
				if (d.action !== "activate" && d.action !== "skip") return false;
				if (validStrategyIds && !validStrategyIds.has(d.strategyId)) {
					log.warn({ strategyId: d.strategyId }, "Dispatch references unknown strategy, skipping");
					return false;
				}
				return true;
			})
			.map((d) => ({
				strategyId: d.strategyId,
				symbol: d.symbol,
				action: d.action,
				reasoning: d.reasoning ?? "",
			}));
	} catch {
		log.error("Failed to parse dispatch response");
		return [];
	}
}

export async function runDispatch(): Promise<DispatchDecision[]> {
	const db = getDb();
	const landscape = await getPerformanceLandscape();
	const graduatedStrategies = landscape.strategies.filter(
		(s) => s.status === "probation" || s.status === "active" || s.status === "core",
	);

	if (graduatedStrategies.length === 0) {
		log.info({ phase: "dispatch" }, "No graduated strategies — skipping dispatch");
		return [];
	}

	if (!(await canAffordCall(0.02))) {
		log.warn({ phase: "dispatch" }, "Cannot afford dispatch call");
		return [];
	}

	// TODO: Wire real regime detection once quote data is available at dispatch time
	const regime: RegimeSignals = {
		atr_percentile: 50,
		volume_breadth: 0.5,
		momentum_regime: 0.5,
	};

	const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
	const recentNews = await db
		.select({
			symbols: newsEvents.symbols,
			headline: newsEvents.headline,
			sentiment: newsEvents.sentiment,
			eventType: newsEvents.eventType,
		})
		.from(newsEvents)
		.where(gte(newsEvents.classifiedAt, fourHoursAgo))
		.all();

	const newsForPrompt = recentNews.map((n) => ({
		symbol: n.symbols ? JSON.parse(n.symbols)[0] : "UNKNOWN",
		headline: n.headline,
		sentiment: n.sentiment ?? 0,
		eventType: n.eventType ?? "other",
	}));

	const prompt = buildDispatchPrompt(graduatedStrategies, regime, newsForPrompt);

	const config = getConfig();
	const client = new Anthropic();

	const response = await withRetry(
		() =>
			client.messages.create({
				model: config.CLAUDE_MODEL_FAST,
				max_tokens: 1024,
				system: "You are a trading strategy dispatcher. Output valid JSON only.",
				messages: [{ role: "user", content: prompt }],
			}),
		"dispatch",
		{ maxAttempts: 2, baseDelayMs: 1000 },
	);

	const textBlock = response.content.find((b) => b.type === "text");
	const rawText = textBlock?.type === "text" ? textBlock.text : "";

	await recordUsage("dispatch", response.usage.input_tokens, response.usage.output_tokens);

	const validIds = new Set(graduatedStrategies.map((s) => s.id));
	const decisions = parseDispatchResponse(rawText, validIds);

	// Expire prior scheduled decisions, then write the fresh set to dispatch_decisions.
	await expireScheduledDecisions();
	const expiresAt = new Date(Date.now() + SCHEDULED_TTL_MS).toISOString();
	await writeScheduledDecisions(decisions, expiresAt);

	log.info(
		{
			phase: "dispatch",
			total: decisions.length,
			activated: decisions.filter((d) => d.action === "activate").length,
		},
		"Dispatch decisions made",
	);

	return decisions;
}
