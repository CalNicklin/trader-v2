import type { EnrichmentPayload } from "../../watchlist/enrich.ts";
import type { EnrichmentEvalTask } from "./tasks.ts";

export interface GraderResult {
	passed: boolean;
	score: number; // 0-1
	details: string;
}

// Code grader: JSON shape + enum validity
export function gradeShape(payload: EnrichmentPayload | null): GraderResult {
	if (!payload) return { passed: false, score: 0, details: "parse failed" };
	const validBias = ["long", "short", "ambiguous"].includes(payload.directionalBias);
	const validHorizon = ["intraday", "days", "weeks"].includes(payload.horizon);
	const validStatus = ["active", "resolved"].includes(payload.status);
	const summaryLen = payload.catalystSummary.length;
	const summaryOk = summaryLen >= 10 && summaryLen <= 400;
	const passed = validBias && validHorizon && validStatus && summaryOk;
	return {
		passed,
		score: passed ? 1 : 0,
		details: `bias=${validBias} horizon=${validHorizon} status=${validStatus} summaryLen=${summaryLen}`,
	};
}

// Code grader: matches expected directional_bias / horizon / status
export function gradeAlignment(
	payload: EnrichmentPayload | null,
	expected: EnrichmentEvalTask["expected"],
): GraderResult {
	if (!payload) return { passed: false, score: 0, details: "parse failed" };
	let hits = 0;
	if (payload.directionalBias === expected.directionalBias) hits++;
	if (payload.horizon === expected.horizon) hits++;
	if (payload.status === expected.status) hits++;
	return {
		passed: hits === 3,
		score: hits / 3,
		details: `bias=${payload.directionalBias}/${expected.directionalBias} horizon=${payload.horizon}/${expected.horizon} status=${payload.status}/${expected.status}`,
	};
}

// LLM-as-judge: summary quality (run via separate Haiku call to minimize cost)
export async function gradeSummaryQuality(
	payload: EnrichmentPayload | null,
	task: EnrichmentEvalTask,
	judge: (prompt: string) => Promise<string>,
): Promise<GraderResult> {
	if (!payload) return { passed: false, score: 0, details: "no payload" };
	const prompt = [
		`You are a strict judge evaluating whether a catalyst summary accurately reflects the source events.`,
		`Symbol: ${task.row.symbol}`,
		`Source events:`,
		...task.events.map((e, i) => `[${i + 1}] ${e.eventType}: ${JSON.stringify(e.payload)}`),
		``,
		`Candidate summary: "${payload.catalystSummary}"`,
		``,
		`Score the summary on a scale of 1-5 where:`,
		`1 = contradicts the events or invents facts`,
		`3 = partially accurate, missing key nuance`,
		`5 = accurate, concise, uses only facts from the events`,
		``,
		`Return only the integer score, nothing else.`,
	].join("\n");
	const raw = await judge(prompt);
	const m = raw.match(/[1-5]/);
	const score = m ? parseInt(m[0], 10) : 0;
	return {
		passed: score >= 4,
		score: score / 5,
		details: `judge_score=${score}`,
	};
}
