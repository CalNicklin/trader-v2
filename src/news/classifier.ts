import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";

const log = createChildLogger({ module: "news-classifier" });

const SYSTEM_PROMPT = `You are a financial news classifier for an automated trading system.
Analyze the headline and return a JSON object with these fields:
- tradeable: boolean — true if this news could move the stock price. Routine events like conferences, minor partnerships, and incremental product launches are NOT tradeable. Buybacks, dividends, analyst actions, and sarcastic/negative-tone earnings commentary ARE tradeable.
- sentiment: number — from -1.0 (very bearish) to 1.0 (very bullish), 0 = neutral
- confidence: number — from 0.0 to 1.0, how confident you are in the classification
- event_type: string — one of: earnings_beat, earnings_miss, guidance_raise, guidance_lower, fda_approval, fda_rejection, acquisition, merger, buyback, dividend, profit_warning, upgrade, downgrade, legal, restructuring, other. Use "other" for inline/neutral earnings and events that don't fit a specific category.
- urgency: string — one of: low, medium, high

## Urgency calibration (be precise — default to medium when uncertain)
- high: ONLY these — earnings beat/miss, guidance changes, FDA decisions, acquisitions/mergers, profit warnings, major legal actions, trading halts, crypto crashes
- medium: Everything else that is tradeable — analyst upgrades/downgrades, restructuring/layoffs, mixed earnings, geopolitical risks, buybacks, sarcastic/ambiguous tone, delivery misses, short/vague headlines
- low: Non-tradeable events — dividend changes, conferences, minor partnerships, routine product launches, inline earnings

## Sentiment calibration
- Analyst upgrade/downgrade: moderate sentiment (±0.3 to ±0.6), not extreme
- Dividend increases, buybacks: mildly positive (0.2 to 0.5)
- Restructuring/layoffs: mildly to moderately negative (-0.2 to -0.5)
- CEO departures: context-dependent, typically -0.3 to -0.5 unless clearly positive
- Inline/neutral earnings: near zero (-0.1 to 0.1)

Return ONLY the JSON object, no other text.`;

export interface ClassificationResult {
	tradeable: boolean;
	sentiment: number;
	confidence: number;
	eventType: string;
	urgency: "low" | "medium" | "high";
}

export function buildClassificationPrompt(headline: string, symbol: string): string {
	return `Classify this financial headline for ticker ${symbol}:\n\n"${headline}"\n\nReturn JSON only.`;
}

export function parseClassificationResponse(text: string): ClassificationResult | null {
	try {
		// Extract JSON from response (handle markdown code blocks)
		const jsonStr = text
			.replace(/```json?\n?/g, "")
			.replace(/```/g, "")
			.trim();
		const parsed = JSON.parse(jsonStr);

		if (typeof parsed.tradeable !== "boolean") return null;
		if (typeof parsed.sentiment !== "number") return null;
		if (typeof parsed.confidence !== "number") return null;
		if (typeof parsed.event_type !== "string") return null;
		if (typeof parsed.urgency !== "string") return null;

		const validUrgency = ["low", "medium", "high"];
		if (!validUrgency.includes(parsed.urgency)) return null;

		const validEventTypes = new Set([
			"earnings_beat",
			"earnings_miss",
			"guidance_raise",
			"guidance_lower",
			"fda_approval",
			"fda_rejection",
			"acquisition",
			"merger",
			"buyback",
			"dividend",
			"profit_warning",
			"upgrade",
			"downgrade",
			"legal",
			"restructuring",
			"other",
		]);
		const eventType = validEventTypes.has(parsed.event_type) ? parsed.event_type : "other";

		return {
			tradeable: parsed.tradeable,
			sentiment: Math.max(-1, Math.min(1, parsed.sentiment)),
			confidence: Math.max(0, Math.min(1, parsed.confidence)),
			eventType,
			urgency: parsed.urgency as "low" | "medium" | "high",
		};
	} catch {
		return null;
	}
}

export async function classifyHeadline(
	headline: string,
	symbol: string,
): Promise<ClassificationResult | null> {
	const config = getConfig();

	const estimatedCost = 0.0002; // ~200 input + 50 output tokens at Haiku rates
	if (!(await canAffordCall(estimatedCost))) {
		log.warn("Skipping classification — daily budget exceeded");
		return null;
	}

	try {
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const userMessage = buildClassificationPrompt(headline, symbol);

		const response = await withRetry(
			async () =>
				client.messages.create({
					model: config.CLAUDE_MODEL_FAST,
					max_tokens: 150,
					system: SYSTEM_PROMPT,
					messages: [{ role: "user", content: userMessage }],
				}),
			`classify-${symbol}`,
			{ maxAttempts: 2, baseDelayMs: 1000 },
		);

		const text = response.content[0]?.type === "text" ? response.content[0].text : "";

		await recordUsage(
			"news_classification",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

		const result = parseClassificationResponse(text);
		if (!result) {
			log.warn({ headline, response: text }, "Failed to parse classification response");
		}
		return result;
	} catch (error) {
		log.error({ headline, error }, "Classification API call failed");
		return null;
	}
}
