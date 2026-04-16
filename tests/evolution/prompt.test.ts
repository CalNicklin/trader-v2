import { describe, expect, test } from "bun:test";
import { buildEvolutionPrompt, parseEvolutionResponse } from "../../src/evolution/prompt";
import type {
	MutationProposal,
	PerformanceLandscape,
	StrategyPerformance,
} from "../../src/evolution/types";

function makeStrategy(overrides: Partial<StrategyPerformance> = {}): StrategyPerformance {
	return {
		id: 1,
		name: "momentum-v1",
		status: "paper",
		generation: 1,
		parentStrategyId: null,
		createdBy: "seed",
		parameters: { position_size_pct: 5, stop_loss_pct: 3 },
		signals: { entry_long: "rsi < 30", exit: "rsi > 70" },
		universe: ["AAPL", "MSFT"],
		metrics: {
			sampleSize: 45,
			winRate: 0.6,
			expectancy: 15.5,
			profitFactor: 1.8,
			sharpeRatio: 1.2,
			sortinoRatio: 1.5,
			maxDrawdownPct: 8.0,
			calmarRatio: 0.9,
			consistencyScore: 3,
		},
		recentTrades: [],
		virtualBalance: 10000,
		insightSummary: [],
		suggestedActions: [],
		...overrides,
	};
}

function makeLandscape(overrides: Partial<PerformanceLandscape> = {}): PerformanceLandscape {
	return {
		strategies: [makeStrategy()],
		activePaperCount: 3,
		missedOpportunities: [],
		timestamp: "2026-04-04T09:00:00.000Z",
		...overrides,
	};
}

// ── buildEvolutionPrompt ──────────────────────────────────────────────────────

describe("buildEvolutionPrompt", () => {
	test("returns system and user message strings", () => {
		const result = buildEvolutionPrompt(makeLandscape());
		expect(typeof result.system).toBe("string");
		expect(typeof result.user).toBe("string");
		expect(result.system.length).toBeGreaterThan(0);
		expect(result.user.length).toBeGreaterThan(0);
	});

	test("system prompt describes the role and mutation types", () => {
		const { system } = buildEvolutionPrompt(makeLandscape());
		expect(system).toContain("strategy evolution engine");
		expect(system).toContain("parameter_tweak");
		expect(system).toContain("new_variant");
	});

	test("system prompt lists parameter ranges", () => {
		const { system } = buildEvolutionPrompt(makeLandscape());
		expect(system).toContain("position_size_pct");
		expect(system).toContain("stop_loss_pct");
		expect(system).toContain("rsi_oversold");
		expect(system).toContain("sentiment_threshold");
	});

	test("user prompt includes population cap info with N / 8 format", () => {
		const landscape = makeLandscape({ activePaperCount: 3 });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).toContain("3 / 8");
	});

	test("user prompt includes strategy name and id", () => {
		const strategy = makeStrategy({ id: 42, name: "gap-hunter-v2" });
		const landscape = makeLandscape({ strategies: [strategy] });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).toContain("gap-hunter-v2");
		expect(user).toContain("id=42");
	});

	test("user prompt includes strategy status, generation, and parent", () => {
		const strategy = makeStrategy({ status: "probation", generation: 3, parentStrategyId: 7 });
		const landscape = makeLandscape({ strategies: [strategy] });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).toContain("probation");
		expect(user).toContain("generation: 3");
		expect(user).toContain("parent: 7");
	});

	test("user prompt includes parameters, signals, and universe as JSON", () => {
		const strategy = makeStrategy({
			parameters: { position_size_pct: 10, hold_days: 5 },
			signals: { entry_long: "gap > 2%" },
			universe: ["TSLA", "NVDA"],
		});
		const landscape = makeLandscape({ strategies: [strategy] });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).toContain('"position_size_pct"');
		expect(user).toContain('"hold_days"');
		expect(user).toContain("gap > 2%");
		expect(user).toContain("TSLA");
	});

	test("user prompt includes formatted metrics (win rate as %, sharpe to 2 decimals)", () => {
		const strategy = makeStrategy({
			metrics: {
				sampleSize: 50,
				winRate: 0.625,
				sharpeRatio: 1.347,
				sortinoRatio: null,
				expectancy: null,
				profitFactor: null,
				maxDrawdownPct: 12.0,
				calmarRatio: null,
				consistencyScore: null,
			},
		});
		const { user } = buildEvolutionPrompt(makeLandscape({ strategies: [strategy] }));
		expect(user).toContain("62.5%");
		expect(user).toContain("1.35"); // sharpe to 2 decimals
		expect(user).toContain("12.0%"); // drawdown as %
	});

	test("user prompt shows 'none yet' for a strategy without metrics", () => {
		const strategy = makeStrategy({ metrics: null });
		const { user } = buildEvolutionPrompt(makeLandscape({ strategies: [strategy] }));
		expect(user).toContain("none yet");
	});

	test("user prompt includes virtual balance", () => {
		const strategy = makeStrategy({ virtualBalance: 12500 });
		const { user } = buildEvolutionPrompt(makeLandscape({ strategies: [strategy] }));
		expect(user).toContain("12500");
	});

	test("user prompt includes guidance about Sharpe < 1.5 and new_variant", () => {
		const { user } = buildEvolutionPrompt(makeLandscape());
		expect(user).toContain("Sharpe");
		expect(user).toContain("new_variant");
	});

	test("handles multiple strategies in the landscape", () => {
		const s1 = makeStrategy({ id: 1, name: "alpha" });
		const s2 = makeStrategy({ id: 2, name: "beta" });
		const landscape = makeLandscape({ strategies: [s1, s2], activePaperCount: 2 });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).toContain("alpha");
		expect(user).toContain("beta");
		expect(user).toContain("2 / 8");
	});

	test("user prompt includes suggested parameter changes when present", () => {
		const strategy = makeStrategy({
			suggestedActions: [
				{
					parameter: "stop_loss_pct",
					direction: "increase" as const,
					reasoning: "Stops triggered on normal volatility",
				},
				{
					parameter: "hold_days",
					direction: "decrease" as const,
					reasoning: "Holding too long in choppy markets",
				},
			],
		});
		const landscape = makeLandscape({ strategies: [strategy] });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).toContain("Suggested parameter changes:");
		expect(user).toContain("increase stop_loss_pct");
		expect(user).toContain("decrease hold_days");
	});

	test("user prompt omits suggested parameter changes section when empty", () => {
		const strategy = makeStrategy({ suggestedActions: [] });
		const landscape = makeLandscape({ strategies: [strategy] });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).not.toContain("Suggested parameter changes:");
	});

	test("includes POPULATION CRITICAL text when recoveryMode is true", () => {
		const landscape = makeLandscape({ activePaperCount: 2 });
		const { user } = buildEvolutionPrompt(landscape, true);
		expect(user).toContain("POPULATION CRITICAL");
		expect(user).toContain("structural");
	});

	test("does not include POPULATION CRITICAL text when recoveryMode is false", () => {
		const landscape = makeLandscape({ activePaperCount: 2 });
		const { user } = buildEvolutionPrompt(landscape, false);
		expect(user).not.toContain("POPULATION CRITICAL");
	});

	test("does not include POPULATION CRITICAL text by default", () => {
		const landscape = makeLandscape({ activePaperCount: 2 });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).not.toContain("POPULATION CRITICAL");
	});

	test("includes missed opportunities section when present", () => {
		const landscape = makeLandscape({
			missedOpportunities: [
				{
					symbol: "AVGO",
					observation: "AVGO moved +11.5% (predicted long). Thesis: AI chip supply deal.",
					confidence: 0.95,
				},
				{
					symbol: "INTC",
					observation: "INTC moved +17.4% (predicted long). Thesis: Terafab partnership.",
					confidence: 0.9,
				},
			],
		});
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).toContain("Missed Opportunities");
		expect(user).toContain("AVGO moved +11.5%");
		expect(user).toContain("INTC moved +17.4%");
		expect(user).toContain("catalyst-driven momentum");
	});

	test("omits missed opportunities section when empty", () => {
		const landscape = makeLandscape({ missedOpportunities: [] });
		const { user } = buildEvolutionPrompt(landscape);
		expect(user).not.toContain("Missed Opportunities");
	});

	test("includes news pipeline subsystem context", () => {
		const landscape = makeLandscape();
		const { system } = buildEvolutionPrompt(landscape);
		expect(system).toContain("News pipeline (current architecture)");
	});
});

// ── parseEvolutionResponse ────────────────────────────────────────────────────

describe("parseEvolutionResponse", () => {
	const validProposal = {
		parentId: 1,
		type: "parameter_tweak",
		name: "momentum-v1-tweak",
		description: "Lower stop loss",
		parameters: { stop_loss_pct: 2 },
		reasoning: "Reduce early exits",
	};

	test("parses a valid JSON array", () => {
		const raw = JSON.stringify([validProposal]);
		const result = parseEvolutionResponse(raw);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("momentum-v1-tweak");
		expect(result[0]!.type).toBe("parameter_tweak");
		expect(result[0]!.parentId).toBe(1);
	});

	test("extracts JSON from markdown code blocks (```json ... ```)", () => {
		const raw = `Here are my proposals:\n\`\`\`json\n${JSON.stringify([validProposal])}\n\`\`\`\n`;
		const result = parseEvolutionResponse(raw);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("momentum-v1-tweak");
	});

	test("extracts JSON from plain code blocks (``` ... ```)", () => {
		const raw = `\`\`\`\n${JSON.stringify([validProposal])}\n\`\`\``;
		const result = parseEvolutionResponse(raw);
		expect(result).toHaveLength(1);
	});

	test("returns [] for invalid JSON", () => {
		expect(parseEvolutionResponse("not json at all")).toEqual([]);
		expect(parseEvolutionResponse("{broken: json}")).toEqual([]);
		expect(parseEvolutionResponse("")).toEqual([]);
	});

	test("returns [] for non-array JSON", () => {
		expect(parseEvolutionResponse(JSON.stringify({ parentId: 1 }))).toEqual([]);
		expect(parseEvolutionResponse(JSON.stringify("string value"))).toEqual([]);
	});

	test("filters out proposals missing required field: parentId", () => {
		const bad = { ...validProposal, parentId: undefined };
		const result = parseEvolutionResponse(JSON.stringify([bad]));
		expect(result).toHaveLength(0);
	});

	test("filters out proposals missing required field: type", () => {
		const bad = { ...validProposal, type: undefined };
		const result = parseEvolutionResponse(JSON.stringify([bad]));
		expect(result).toHaveLength(0);
	});

	test("filters out proposals missing required field: name", () => {
		const bad = { ...validProposal, name: undefined };
		const result = parseEvolutionResponse(JSON.stringify([bad]));
		expect(result).toHaveLength(0);
	});

	test("filters out proposals missing required field: description", () => {
		const bad = { ...validProposal, description: undefined };
		const result = parseEvolutionResponse(JSON.stringify([bad]));
		expect(result).toHaveLength(0);
	});

	test("filters out proposals missing required field: reasoning", () => {
		const bad = { ...validProposal, reasoning: undefined };
		const result = parseEvolutionResponse(JSON.stringify([bad]));
		expect(result).toHaveLength(0);
	});

	test("filters out proposals with invalid type value", () => {
		const bad = { ...validProposal, type: "turbo_boost" };
		const result = parseEvolutionResponse(JSON.stringify([bad]));
		expect(result).toHaveLength(0);
	});

	test("filters out proposals where parameters is null", () => {
		const bad = { ...validProposal, parameters: null };
		const result = parseEvolutionResponse(JSON.stringify([bad]));
		expect(result).toHaveLength(0);
	});

	test("filters out proposals where parameters is an array", () => {
		const bad = { ...validProposal, parameters: [1, 2, 3] };
		const result = parseEvolutionResponse(JSON.stringify([bad]));
		expect(result).toHaveLength(0);
	});

	test("keeps valid and drops invalid in a mixed array", () => {
		const good = validProposal;
		const bad = { ...validProposal, reasoning: undefined };
		const result = parseEvolutionResponse(JSON.stringify([good, bad]));
		expect(result).toHaveLength(1);
	});

	test("preserves optional signals and universe fields", () => {
		const withOptionals = {
			...validProposal,
			type: "new_variant",
			signals: { entry_long: "rsi < 25", exit: "rsi > 75" },
			universe: ["GOOGL", "AMZN"],
		};
		const result = parseEvolutionResponse(JSON.stringify([withOptionals]));
		expect(result).toHaveLength(1);
		expect(result[0]!.signals).toEqual({ entry_long: "rsi < 25", exit: "rsi > 75" });
		expect(result[0]!.universe).toEqual(["GOOGL", "AMZN"]);
	});

	test("returns [] for an empty array", () => {
		expect(parseEvolutionResponse("[]")).toEqual([]);
	});

	test("accepts both valid mutation types", () => {
		const tweak: MutationProposal = { ...validProposal, type: "parameter_tweak" };
		const variant: MutationProposal = { ...validProposal, type: "new_variant" };
		const result = parseEvolutionResponse(JSON.stringify([tweak, variant]));
		expect(result).toHaveLength(2);
	});

	test("salvages complete objects from truncated JSON array", () => {
		const full = JSON.stringify([validProposal, validProposal]);
		// Truncate mid-way through second object
		const truncated = full.slice(0, full.length - 20);
		const result = parseEvolutionResponse(truncated);
		expect(result).toHaveLength(1);
		expect(result[0]!.parentId).toBe(validProposal.parentId);
	});

	test("returns [] when truncation is too severe to salvage", () => {
		const result = parseEvolutionResponse('[{"parentId": 1, "type":');
		expect(result).toEqual([]);
	});
});
