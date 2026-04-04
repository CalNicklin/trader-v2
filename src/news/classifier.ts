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
- signals: object — event-specific signal scores (include ONLY when tradeable is true):
  - earnings_surprise: number 0-1 — strength of earnings surprise (0 if not earnings-related)
  - guidance_change: number 0-1 — magnitude of forward guidance change (0 if none)
  - management_tone: number 0-1 — confidence/optimism in management commentary (0.5 = neutral)
  - regulatory_risk: number 0-1 — regulatory threat level (0 = none)
  - acquisition_likelihood: number 0-1 — probability this leads to M&A activity (0 = none)
  - catalyst_type: string — one of: fundamental, technical, macro, sector, sentiment, other
  - expected_move_duration: string — one of: intraday, 1-3d, 1-2w, 1m+

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

export interface ClassificationSignals {
	earningsSurprise: number;
	guidanceChange: number;
	managementTone: number;
	regulatoryRisk: number;
	acquisitionLikelihood: number;
	catalystType: string;
	expectedMoveDuration: string;
}

export interface ClassificationResult {
	tradeable: boolean;
	sentiment: number;
	confidence: number;
	eventType: string;
	urgency: "low" | "medium" | "high";
	signals: ClassificationSignals | null;
}

const VALID_CATALYST_TYPES = new Set([
	"fundamental",
	"technical",
	"macro",
	"sector",
	"sentiment",
	"other",
]);

const VALID_MOVE_DURATIONS = new Set(["intraday", "1-3d", "1-2w", "1m+"]);

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function parseSignals(raw: unknown): ClassificationSignals | null {
	if (raw == null || typeof raw !== "object") return null;
	const s = raw as Record<string, unknown>;

	if (typeof s.earnings_surprise !== "number") return null;
	if (typeof s.guidance_change !== "number") return null;
	if (typeof s.management_tone !== "number") return null;
	if (typeof s.regulatory_risk !== "number") return null;
	if (typeof s.acquisition_likelihood !== "number") return null;
	if (typeof s.catalyst_type !== "string") return null;
	if (typeof s.expected_move_duration !== "string") return null;

	return {
		earningsSurprise: clamp01(s.earnings_surprise),
		guidanceChange: clamp01(s.guidance_change),
		managementTone: clamp01(s.management_tone),
		regulatoryRisk: clamp01(s.regulatory_risk),
		acquisitionLikelihood: clamp01(s.acquisition_likelihood),
		catalystType: VALID_CATALYST_TYPES.has(s.catalyst_type) ? s.catalyst_type : "other",
		expectedMoveDuration: VALID_MOVE_DURATIONS.has(s.expected_move_duration)
			? s.expected_move_duration
			: "1-3d",
	};
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
			signals: parseSignals(parsed.signals),
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

	const estimatedCost = 0.0003; // ~200 input + 50 output tokens at Haiku rates
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
					max_tokens: 300,
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
