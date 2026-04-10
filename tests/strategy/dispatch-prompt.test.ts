import { describe, expect, it } from "bun:test";
import { NEWS_PIPELINE_CONTEXT } from "../../src/agents/subsystem-context.ts";
import { buildDispatchPrompt } from "../../src/strategy/dispatch-prompt.ts";

describe("buildDispatchPrompt news context", () => {
	it("includes the news pipeline subsystem context", () => {
		const prompt = buildDispatchPrompt(
			[],
			{ atr_percentile: 50, volume_breadth: 0.5, momentum_regime: 0.5 },
			[],
		);
		expect(prompt).toContain("News pipeline (current architecture)");
		expect(prompt).toContain(NEWS_PIPELINE_CONTEXT);
	});
});
