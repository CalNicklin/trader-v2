import { MAX_POPULATION } from "./population";
import type { MutationProposal, PerformanceLandscape } from "./types";

const PARAMETER_RANGES = `
- position_size_pct: 2–25
- stop_loss_pct: 1–10
- hold_days: 1–20
- sentiment_threshold: 0.1–0.95
- rsi_oversold: 15–45
- rsi_overbought: 55–85
- gap_threshold_pct: 0.5–5
- exit_target_pct: 0.5–10`.trim();

const SYSTEM_PROMPT = `You are a strategy evolution engine for an autonomous trading system.

Your job is to analyse a portfolio of paper-trading strategies and propose mutations that may improve performance.

## Mutation types

- **parameter_tweak**: Adjust numeric parameters of an existing strategy. Keep the same signals and universe; only change parameter values. Required fields: parentId, type, name, description, parameters, reasoning.
- **new_variant**: Introduce a new variant with different signals or a different universe, derived from a parent strategy. All fields including signals and universe are required.
- **structural**: Entirely new strategy design. You choose the indicators, signal logic, entry/exit conditions, parameters, and universe. Parameters can use custom names (not limited to the standard set). Max 5 parameters. You MUST provide signals with at least one entry condition. Signal expressions can use any variable from the context: last, bid, ask, volume, avg_volume, change_percent, news_sentiment, earnings_surprise, guidance_change, management_tone, regulatory_risk, acquisition_likelihood, rsi14, atr14, volume_ratio, hold_days, pnl_pct.

Use "structural" when the current strategy templates are fundamentally wrong for the market regime. Use "parameter_tweak" for fine-tuning. Use "new_variant" for exploring variations of an existing approach.

## Parameter ranges (stay within these bounds)

${PARAMETER_RANGES}

Max 5 parameters per strategy.

## Output format

Respond with a JSON array ONLY — no prose, no markdown outside the code block. Each element must conform to:

\`\`\`json
[
  {
    "parentId": <number>,
    "type": "parameter_tweak" | "new_variant" | "structural",
    "name": "<string>",
    "description": "<string>",
    "parameters": { "<key>": <number> },
    "signals": { "entry_long"?: "<string>", "entry_short"?: "<string>", "exit"?: "<string>" },
    "universe": ["<symbol>", ...],
    "reasoning": "<string>"
  }
]
\`\`\`

For parameter_tweak, signals and universe may be omitted. For new_variant, both are required.`;

function formatMetrics(strategy: PerformanceLandscape["strategies"][number]): string {
	const m = strategy.metrics;
	if (!m) return "  metrics: none yet";

	const lines: string[] = [`  sample_size: ${m.sampleSize}`];

	if (m.winRate !== null) lines.push(`  win_rate: ${(m.winRate * 100).toFixed(1)}%`);
	if (m.sharpeRatio !== null) lines.push(`  sharpe: ${m.sharpeRatio.toFixed(2)}`);
	if (m.sortinoRatio !== null) lines.push(`  sortino: ${m.sortinoRatio.toFixed(2)}`);
	if (m.expectancy !== null) lines.push(`  expectancy: ${m.expectancy.toFixed(2)}`);
	if (m.profitFactor !== null) lines.push(`  profit_factor: ${m.profitFactor.toFixed(2)}`);
	if (m.maxDrawdownPct !== null) lines.push(`  max_drawdown: ${m.maxDrawdownPct.toFixed(1)}%`);
	if (m.calmarRatio !== null) lines.push(`  calmar: ${m.calmarRatio.toFixed(2)}`);
	if (m.consistencyScore !== null) lines.push(`  consistency: ${m.consistencyScore}`);

	return lines.join("\n");
}

export function buildEvolutionPrompt(
	landscape: PerformanceLandscape,
	recoveryMode = false,
): {
	system: string;
	user: string;
} {
	const { strategies, activePaperCount } = landscape;
	const slotsUsed = `${activePaperCount} / ${MAX_POPULATION} paper slots used`;
	const slotsAvailable = MAX_POPULATION - activePaperCount;

	const strategyBlocks = strategies
		.map((s) => {
			const lines: string[] = [
				`### Strategy: ${s.name} (id=${s.id})`,
				`status: ${s.status}`,
				`generation: ${s.generation}`,
				`parent: ${s.parentStrategyId ?? "none"}`,
				`virtual_balance: ${s.virtualBalance}`,
				`parameters: ${JSON.stringify(s.parameters)}`,
				`signals: ${JSON.stringify(s.signals)}`,
				`universe: ${JSON.stringify(s.universe)}`,
				"metrics:",
				formatMetrics(s),
			];
			if (s.insightSummary.length > 0) {
				lines.push("Learning loop insights:");
				for (const insight of s.insightSummary.slice(0, 5)) {
					lines.push(`  - ${insight}`);
				}
			}
			if (s.suggestedActions.length > 0) {
				lines.push("Suggested parameter changes:");
				for (const action of s.suggestedActions.slice(0, 5)) {
					lines.push(`  → ${action.direction} ${action.parameter}: ${action.reasoning}`);
				}
			}
			return lines.join("\n");
		})
		.join("\n\n");

	const recoveryBlock = recoveryMode
		? `\n\n**POPULATION CRITICAL:** Only ${activePaperCount}/${MAX_POPULATION} strategies active. Propose structural mutations — new signal logic, different entry/exit approaches, fresh universes. Prioritise diversity over data-driven tuning. Do NOT propose parameter_tweak — there is insufficient trade data.`
		: "";

	const user = `## Performance Landscape

Population: ${slotsUsed}

${strategyBlocks}

---

## Task

Propose mutations to improve this portfolio. Guidelines:
- Prioritise strategies with 30+ trades and Sharpe < 1.5 for parameter_tweak
- Propose a new_variant if ${slotsAvailable} slot(s) are available and there is a promising parent
- For \`parameter_tweak\` and \`new_variant\`, stay within parameter ranges. For \`structural\`, any parameter names are allowed, but max 5.
- Return only a JSON array — no additional text${recoveryBlock}`;

	return { system: SYSTEM_PROMPT, user };
}

/** Try to recover complete objects from a truncated JSON array */
function salvageTruncatedArray(text: string): unknown[] | null {
	// Walk backwards to find the last complete top-level object boundary
	// by tracking brace depth from the start
	let depth = 0;
	let lastObjectEnd = -1;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			// Skip strings (including escaped quotes)
			i++;
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\") i++;
				i++;
			}
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				// Closed a top-level object within the array
				lastObjectEnd = i;
			}
		}
	}

	if (lastObjectEnd === -1) return null;

	const candidate = `${text.slice(0, lastObjectEnd + 1)}]`;
	try {
		const parsed = JSON.parse(candidate);
		if (Array.isArray(parsed) && parsed.length > 0) return parsed;
	} catch {
		// Still broken — give up
	}
	return null;
}

export function parseEvolutionResponse(raw: string): MutationProposal[] {
	let jsonText = raw.trim();

	// Try to extract from markdown code block first
	const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch?.[1]) {
		jsonText = codeBlockMatch[1].trim();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		// Attempt to salvage truncated JSON — find last complete object in array
		parsed = salvageTruncatedArray(jsonText);
		if (!parsed) return [];
	}

	if (!Array.isArray(parsed)) return [];

	const valid: MutationProposal[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;

		// Required fields check
		if (
			typeof obj.parentId !== "number" ||
			typeof obj.type !== "string" ||
			typeof obj.name !== "string" ||
			typeof obj.description !== "string" ||
			typeof obj.reasoning !== "string"
		) {
			continue;
		}

		// Valid type check
		if (obj.type !== "parameter_tweak" && obj.type !== "new_variant" && obj.type !== "structural")
			continue;

		// parameters must be a non-null object
		if (
			typeof obj.parameters !== "object" ||
			obj.parameters === null ||
			Array.isArray(obj.parameters)
		) {
			continue;
		}

		// All parameter values must be finite numbers
		const paramEntries = Object.entries(obj.parameters as Record<string, unknown>);
		if (paramEntries.some(([_k, v]) => typeof v !== "number" || !Number.isFinite(v))) {
			continue;
		}

		const proposal: MutationProposal = {
			parentId: obj.parentId,
			type: obj.type,
			name: obj.name.slice(0, 100),
			description: obj.description.slice(0, 500),
			parameters: obj.parameters as Record<string, number>,
			reasoning: obj.reasoning,
		};

		// new_variant proposals without signals/universe are accepted here —
		// Task 3's validator enforces that both fields are required for new_variant.
		if (obj.signals != null) {
			if (typeof obj.signals === "object" && !Array.isArray(obj.signals)) {
				const validKeys = ["entry_long", "entry_short", "exit"];
				const signals: Record<string, string> = {};
				for (const [k, v] of Object.entries(obj.signals as Record<string, unknown>)) {
					if (validKeys.includes(k) && typeof v === "string") {
						signals[k] = v;
					}
				}
				proposal.signals = signals as MutationProposal["signals"];
			}
			// Invalid signals shape — omit; validator will use parent's signals
		}
		if (Array.isArray(obj.universe)) {
			proposal.universe = obj.universe.filter((u: unknown) => typeof u === "string");
		}

		valid.push(proposal);
	}

	return valid;
}
