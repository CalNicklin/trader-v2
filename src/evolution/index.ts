import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { getConfig } from "../config";
import { getDb } from "../db/client";
import { tradeInsights } from "../db/schema";
import { canAffordCall } from "../utils/budget";
import { createChildLogger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { recordUsage } from "../utils/token-tracker";
import { getPerformanceLandscape } from "./analyzer";
import { MAX_POPULATION, MIN_POPULATION, RECOVERY_SPAWN_CAP } from "./population";
import { buildEvolutionPrompt, parseEvolutionResponse } from "./prompt";
import { spawnChild } from "./spawner";
import type { TournamentResult } from "./types";
import { validateMutation } from "./validator";

const log = createChildLogger({ module: "evolution" });

const EVOLUTION_ESTIMATED_COST_USD = 0.05;

export async function markMatchedInsights(
	parentStrategyId: number,
	parameterDiff: Record<string, { from: number; to: number }>,
): Promise<void> {
	const db = getDb();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

	const insights = await db
		.select()
		.from(tradeInsights)
		.where(
			and(
				eq(tradeInsights.strategyId, parentStrategyId),
				isNotNull(tradeInsights.suggestedAction),
				isNull(tradeInsights.ledToImprovement),
				gte(tradeInsights.createdAt, thirtyDaysAgo),
			),
		);

	for (const insight of insights) {
		if (!insight.suggestedAction) continue;

		let action: { parameter: string; direction: string };
		try {
			action = JSON.parse(insight.suggestedAction);
		} catch {
			continue;
		}

		const diff = parameterDiff[action.parameter];
		if (!diff) {
			if (insight.createdAt < sevenDaysAgo) {
				await db
					.update(tradeInsights)
					.set({ ledToImprovement: false })
					.where(eq(tradeInsights.id, insight.id));
			}
			continue;
		}

		const wentUp = diff.to > diff.from;
		const wentDown = diff.to < diff.from;
		const matched =
			(action.direction === "increase" && wentUp) || (action.direction === "decrease" && wentDown);

		if (matched) {
			await db
				.update(tradeInsights)
				.set({ ledToImprovement: true })
				.where(eq(tradeInsights.id, insight.id));
		}
	}
}

export async function runEvolutionCycle(): Promise<{
	drawdownKills: number[];
	tournaments: number;
	populationCulls: number[];
	spawned: number[];
	skippedReason?: string;
}> {
	// Steps 1-3 now handled by daily_tournament job (runs weekdays at 21:45)
	const drawdownKills: number[] = [];
	const tournamentResults: TournamentResult[] = [];
	const populationCulls: number[] = [];

	// Step 4: Get current performance landscape
	const landscape = await getPerformanceLandscape();

	// Step 5: Determine recovery mode
	if (landscape.strategies.length === 0) {
		log.info("Skipping evolution: no active strategies to mutate from");
		return {
			drawdownKills,
			tournaments: tournamentResults.length,
			populationCulls,
			spawned: [],
			skippedReason: "no active strategies",
		};
	}

	const recoveryMode = landscape.activePaperCount < MIN_POPULATION;

	// Step 5b: Skip Sonnet call if no paper strategies with 30+ trades (bypass in recovery mode)
	if (recoveryMode) {
		log.warn(
			{ activePaperCount: landscape.activePaperCount, minPopulation: MIN_POPULATION },
			"Recovery mode: bypassing 30-trade gate due to low population",
		);
	} else {
		const strategiesWithEnoughTrades = landscape.strategies.filter(
			(s) => s.status === "paper" && (s.metrics?.sampleSize ?? 0) >= 30,
		);

		if (strategiesWithEnoughTrades.length === 0) {
			log.info("Skipping evolution: no paper strategies with 30+ trades");
			return {
				drawdownKills,
				tournaments: tournamentResults.length,
				populationCulls,
				spawned: [],
				skippedReason: "no paper strategies with 30+ trades",
			};
		}
	}

	// Step 6: Skip if population is at cap
	if (landscape.activePaperCount >= MAX_POPULATION) {
		log.info(
			{ activePaperCount: landscape.activePaperCount, cap: MAX_POPULATION },
			"Skipping evolution: population at cap",
		);
		return {
			drawdownKills,
			tournaments: tournamentResults.length,
			populationCulls,
			spawned: [],
			skippedReason: "population at cap",
		};
	}

	// Step 7: Budget check
	const canAfford = await canAffordCall(EVOLUTION_ESTIMATED_COST_USD);
	if (!canAfford) {
		log.warn("Skipping evolution: insufficient budget for Sonnet call");
		return {
			drawdownKills,
			tournaments: tournamentResults.length,
			populationCulls,
			spawned: [],
			skippedReason: "insufficient budget",
		};
	}

	// Step 8 & 9: Call Sonnet with retry
	const config = getConfig();
	const client = new Anthropic();
	const { system, user } = buildEvolutionPrompt(landscape, recoveryMode);

	const response = await withRetry(
		() =>
			client.messages.create({
				model: config.CLAUDE_MODEL_HEAVY,
				max_tokens: 4096,
				system,
				messages: [{ role: "user", content: user }],
			}),
		"evolution:sonnet",
		{ maxAttempts: 2, baseDelayMs: 2000 },
	);

	// Step 10: Extract text and record usage
	const textBlock = response.content.find((b) => b.type === "text");
	const rawText = textBlock?.type === "text" ? textBlock.text : "";

	await recordUsage(
		"strategy_evolution",
		response.usage.input_tokens,
		response.usage.output_tokens,
	);

	// Step 11: Parse proposals
	const proposals = parseEvolutionResponse(rawText);

	// Step 12 & 13: Validate and spawn, respecting population slots
	const maxSpawns = recoveryMode
		? Math.min(RECOVERY_SPAWN_CAP, MAX_POPULATION - landscape.activePaperCount)
		: MAX_POPULATION - landscape.activePaperCount;
	const spawned: number[] = [];
	let slotsUsed = 0;

	for (const proposal of proposals) {
		if (slotsUsed >= maxSpawns) {
			log.info({ proposalName: proposal.name }, "Skipping proposal: no population slots remaining");
			break;
		}

		const parent = landscape.strategies.find((s) => s.id === proposal.parentId);
		if (!parent) {
			log.warn(
				{ proposalParentId: proposal.parentId },
				"Skipping proposal: parent strategy not found",
			);
			continue;
		}

		const validation = validateMutation(proposal, parent, landscape.strategies);
		if (!validation.valid) {
			log.info({ proposalName: proposal.name, reason: validation.reason }, "Proposal rejected");
			continue;
		}

		try {
			const childId = await spawnChild(validation.mutation, recoveryMode ? "evolution:recovery" : "evolution");
			spawned.push(childId);
			slotsUsed++;
			await markMatchedInsights(proposal.parentId, validation.mutation.parameterDiff);
			log.info(
				{ childId, parentId: proposal.parentId, name: proposal.name },
				"Spawned child strategy",
			);
		} catch (err) {
			log.warn(
				{ err, proposalName: proposal.name, parentId: proposal.parentId },
				"Failed to spawn child strategy, skipping",
			);
		}
	}

	return {
		drawdownKills,
		tournaments: tournamentResults.length,
		populationCulls,
		spawned,
	};
}
