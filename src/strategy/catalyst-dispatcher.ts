import Anthropic from "@anthropic-ai/sdk";
import { inArray } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { getPerformanceLandscape } from "../evolution/analyzer.ts";
import { getOpenPositions } from "../paper/manager.ts";
import { isWeeklyDrawdownActive } from "../risk/guardian.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { buildCatalystPrompt, type CatalystNews } from "./catalyst-prompt.ts";
import { parseDispatchResponse } from "./dispatch.ts";
import { writeCatalystDecisions } from "./dispatch-store.ts";

const log = createChildLogger({ module: "catalyst-dispatcher" });

const CATALYST_TTL_MS = 4 * 60 * 60 * 1000;
const CATALYST_CALL_COST = 0.005;

export const COOLDOWN_MS = 30 * 60 * 1000;
export const DAILY_CAP = 20;
export const DEBOUNCE_MS = 60 * 1000;

interface State {
	symbolCooldownUntil: Map<string, number>;
	lastDispatchedAt: Map<string, number>;
	dailyCount: { day: string; count: number };
	debounceTimers: Map<
		string,
		{ timer: ReturnType<typeof setTimeout>; newsEventId: number; exchange: string }
	>;
}

const state: State = {
	symbolCooldownUntil: new Map(),
	lastDispatchedAt: new Map(),
	dailyCount: { day: "", count: 0 },
	debounceTimers: new Map(),
};

function dayKey(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

export function resetCatalystStateForTesting(): void {
	for (const { timer } of state.debounceTimers.values()) {
		clearTimeout(timer);
	}
	state.symbolCooldownUntil.clear();
	state.lastDispatchedAt.clear();
	state.debounceTimers.clear();
	state.dailyCount = { day: "", count: 0 };
}

/** Returns true if the symbol can trigger a new catalyst dispatch at `now`. */
export function acceptsTrigger(symbol: string, now: number): boolean {
	const cooldownUntil = state.symbolCooldownUntil.get(symbol);
	if (cooldownUntil !== undefined && cooldownUntil > now) {
		log.debug({ symbol, cooldownUntil }, "Catalyst trigger blocked by cooldown");
		return false;
	}

	const today = dayKey(now);
	if (state.dailyCount.day !== today) {
		state.dailyCount = { day: today, count: 0 };
	}
	if (state.dailyCount.count >= DAILY_CAP) {
		log.warn({ symbol, dailyCount: state.dailyCount.count }, "Catalyst daily cap reached");
		return false;
	}

	return true;
}

/** Records that a catalyst dispatch fired for `symbol` at `now`. */
export function markDispatched(symbol: string, now: number): void {
	state.symbolCooldownUntil.set(symbol, now + COOLDOWN_MS);
	state.lastDispatchedAt.set(symbol, now);
	const today = dayKey(now);
	if (state.dailyCount.day !== today) {
		state.dailyCount = { day: today, count: 0 };
	}
	state.dailyCount.count++;
}

export interface EnqueueOptions {
	news?: CatalystNews;
	/** Test hook — replaces the default Haiku runner. */
	_runner?: (symbol: string, exchange: string, newsEventId: number) => Promise<void>;
	/** Test hook — override debounce window. */
	_debounceMs?: number;
}

export function enqueueCatalystDispatch(
	symbol: string,
	exchange: string,
	newsEventId: number,
	options: EnqueueOptions = {},
): void {
	const now = Date.now();
	if (!acceptsTrigger(symbol, now)) return;

	const debounceMs = options._debounceMs ?? DEBOUNCE_MS;
	const runner = options._runner ?? makeDefaultRunner(options.news);

	const existing = state.debounceTimers.get(symbol);
	if (existing) {
		clearTimeout(existing.timer);
	}

	const timer = setTimeout(() => {
		state.debounceTimers.delete(symbol);
		runner(symbol, exchange, newsEventId).catch((err) =>
			log.error({ err, symbol, newsEventId }, "Catalyst dispatch runner failed"),
		);
	}, debounceMs);

	state.debounceTimers.set(symbol, { timer, newsEventId, exchange });
}

function makeDefaultRunner(
	news: CatalystNews | undefined,
): (symbol: string, exchange: string, newsEventId: number) => Promise<void> {
	return async (symbol, exchange, newsEventId) => {
		const start = Date.now();
		if (!acceptsTrigger(symbol, start)) return;

		if (!news) {
			log.warn({ symbol, newsEventId }, "Catalyst runner missing news payload — skipping");
			return;
		}
		if (!(await canAffordCall(CATALYST_CALL_COST))) {
			log.warn({ symbol }, "Catalyst dispatch cannot afford call");
			return;
		}

		const landscape = await getPerformanceLandscape();
		const graduated = landscape.strategies.filter(
			(s) => s.status === "probation" || s.status === "active" || s.status === "core",
		);
		if (graduated.length === 0) {
			log.debug({ symbol }, "No graduated strategies — skipping catalyst dispatch");
			return;
		}

		const prompt = buildCatalystPrompt(symbol, graduated, news);
		const config = getConfig();
		const client = new Anthropic();

		const response = await withRetry(
			() =>
				client.messages.create({
					model: config.CLAUDE_MODEL_FAST,
					max_tokens: 768,
					system: "You are a catalyst-triggered trading dispatcher. Output valid JSON only.",
					messages: [{ role: "user", content: prompt }],
				}),
			"catalyst_dispatch",
			{ maxAttempts: 2, baseDelayMs: 500 },
		);

		const textBlock = response.content.find((b) => b.type === "text");
		const rawText = textBlock?.type === "text" ? textBlock.text : "";
		await recordUsage(
			"catalyst_dispatch",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

		const validIds = new Set(graduated.map((s) => s.id));
		const decisions = parseDispatchResponse(rawText, validIds);

		const expiresAt = new Date(Date.now() + CATALYST_TTL_MS).toISOString();
		await writeCatalystDecisions(decisions, expiresAt, newsEventId);
		markDispatched(symbol, start);

		log.info(
			{
				phase: "catalyst_dispatch",
				symbol,
				newsEventId,
				decisions: decisions.length,
				activated: decisions.filter((d) => d.action === "activate").length,
				latencyMs: Date.now() - start,
			},
			"Catalyst dispatch completed",
		);

		const activatedStrategyIds = decisions
			.filter((d) => d.action === "activate")
			.map((d) => d.strategyId);
		if (activatedStrategyIds.length > 0) {
			kickEvaluatorForSymbol(symbol, exchange, activatedStrategyIds).catch((err) =>
				log.error({ err, symbol }, "Catalyst evaluator kick failed"),
			);
		}
	};
}

async function kickEvaluatorForSymbol(
	symbol: string,
	exchange: string,
	strategyIds: number[],
): Promise<void> {
	const { fetchEvalInput } = await import("../scheduler/strategy-eval-job.ts");
	const { evaluateStrategyForSymbol } = await import("./evaluator.ts");

	const db = getDb();
	const rows = await db.select().from(strategies).where(inArray(strategies.id, strategyIds));
	if (rows.length === 0) return;

	const data = await fetchEvalInput(symbol, exchange);
	if (!data) {
		log.debug({ symbol, exchange }, "No quote data for catalyst kick — skipping");
		return;
	}

	const weeklyDD = await isWeeklyDrawdownActive();

	for (const strategy of rows) {
		const openPositions = await getOpenPositions(strategy.id);
		await evaluateStrategyForSymbol(strategy, symbol, exchange, data, {
			openPositionCount: openPositions.length,
			openPositionSectors: openPositions.map(() => null),
			weeklyDrawdownActive: weeklyDD,
		});
	}
}

export function getCatalystMetrics(): {
	dispatchesToday: number;
	capHit: boolean;
	lastDispatchedAt: string | null;
} {
	const today = dayKey(Date.now());
	const count = state.dailyCount.day === today ? state.dailyCount.count : 0;
	let lastMs = 0;
	for (const stamped of state.lastDispatchedAt.values()) {
		if (stamped > lastMs) lastMs = stamped;
	}
	return {
		dispatchesToday: count,
		capHit: count >= DAILY_CAP,
		lastDispatchedAt: lastMs > 0 ? new Date(lastMs).toISOString() : null,
	};
}
