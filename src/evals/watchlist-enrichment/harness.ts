import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";
import { buildEnrichmentPrompt, parseEnrichmentResponse } from "../../watchlist/enrich.ts";
import type { WatchlistRow } from "../../watchlist/repo.ts";
import { type GraderResult, gradeAlignment, gradeShape, gradeSummaryQuality } from "./graders.ts";
import { ENRICHMENT_TASKS } from "./tasks.ts";

const OPUS_MODEL = "claude-opus-4-7";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

async function callModel(model: string, prompt: string, maxTokens: number): Promise<string> {
	const client = new Anthropic({ apiKey: getConfig().ANTHROPIC_API_KEY });
	const msg = await client.messages.create({
		model,
		max_tokens: maxTokens,
		messages: [{ role: "user", content: prompt }],
	});
	const textBlock = msg.content.find((b) => b.type === "text");
	return textBlock?.type === "text" ? textBlock.text : "";
}

export async function runEvalHarness(): Promise<void> {
	const results: Array<{
		taskId: string;
		shape: GraderResult;
		alignment: GraderResult;
		summary: GraderResult;
	}> = [];

	for (const task of ENRICHMENT_TASKS) {
		const prompt = buildEnrichmentPrompt(task.row as WatchlistRow, task.events);
		const raw = await callModel(OPUS_MODEL, prompt, 1024);
		const parsed = parseEnrichmentResponse(raw);
		const payload = parsed.ok ? parsed.value : null;

		const shape = gradeShape(payload);
		const alignment = gradeAlignment(payload, task.expected);
		const summary = await gradeSummaryQuality(payload, task, (p) => callModel(HAIKU_MODEL, p, 10));

		results.push({ taskId: task.id, shape, alignment, summary });
	}

	const outDir = join(import.meta.dir, "results");
	mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	writeFileSync(
		join(outDir, `eval-${stamp}.json`),
		JSON.stringify(
			{
				totalTasks: results.length,
				shapePassRate: results.filter((r) => r.shape.passed).length / results.length,
				alignmentPassRate: results.filter((r) => r.alignment.passed).length / results.length,
				summaryPassRate: results.filter((r) => r.summary.passed).length / results.length,
				results,
			},
			null,
			2,
		),
	);

	console.log(`Eval complete: ${results.length} tasks. Results written to ${outDir}`);
}

if (import.meta.main) {
	await runEvalHarness();
}
