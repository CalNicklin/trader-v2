import { getDb } from "../db/client.ts";
import { tokenUsage } from "../db/schema.ts";
import { estimateCost } from "./cost.ts";

export async function recordUsage(
	job: string,
	inputTokens: number,
	outputTokens: number,
	cacheCreationTokens?: number,
	cacheReadTokens?: number,
	status?: string,
): Promise<void> {
	const db = getDb();
	await db.insert(tokenUsage).values({
		job,
		inputTokens,
		outputTokens,
		cacheCreationTokens: cacheCreationTokens ?? null,
		cacheReadTokens: cacheReadTokens ?? null,
		estimatedCostUsd: estimateCost(
			job,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
		),
		status: status ?? null,
	});
}
