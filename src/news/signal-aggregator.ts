import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsAnalyses } from "../db/schema.ts";

export const HALF_LIFE_HOURS = 2;
export const WINDOW_HOURS = 24;

export interface AggregatedNewsSignal {
	sentiment: number | null;
	earningsSurprise: number | null;
	guidanceChange: number | null;
	managementTone: number | null;
	regulatoryRisk: number | null;
	acquisitionLikelihood: number | null;
	catalystType: string | null;
	expectedMoveDuration: string | null;
}

function ageHours(createdAt: string, now: Date): number {
	return (now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
}

function decayWeight(confidence: number, ageH: number): number {
	return confidence * 0.5 ** (ageH / HALF_LIFE_HOURS);
}

export async function getAggregatedNewsSignal(
	symbol: string,
	exchange: string,
	now: Date = new Date(),
): Promise<AggregatedNewsSignal> {
	const db = getDb();
	const cutoff = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

	const analyses = await db
		.select({
			sentiment: newsAnalyses.sentiment,
			confidence: newsAnalyses.confidence,
			createdAt: newsAnalyses.createdAt,
		})
		.from(newsAnalyses)
		.where(
			and(
				eq(newsAnalyses.symbol, symbol),
				eq(newsAnalyses.exchange, exchange),
				gte(newsAnalyses.createdAt, cutoff),
			),
		);

	let sentimentNum = 0;
	let sentimentDen = 0;
	for (const row of analyses) {
		const w = decayWeight(row.confidence, ageHours(row.createdAt, now));
		sentimentNum += row.sentiment * w;
		sentimentDen += w;
	}

	return {
		sentiment: sentimentDen > 0 ? sentimentNum / sentimentDen : null,
		earningsSurprise: null,
		guidanceChange: null,
		managementTone: null,
		regulatoryRisk: null,
		acquisitionLikelihood: null,
		catalystType: null,
		expectedMoveDuration: null,
	};
}
