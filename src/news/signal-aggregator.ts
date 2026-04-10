import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsAnalyses, newsEvents } from "../db/schema.ts";

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

	const events = await db
		.select({
			sentiment: newsEvents.sentiment,
			confidence: newsEvents.confidence,
			classifiedAt: newsEvents.classifiedAt,
			earningsSurprise: newsEvents.earningsSurprise,
			guidanceChange: newsEvents.guidanceChange,
			managementTone: newsEvents.managementTone,
			regulatoryRisk: newsEvents.regulatoryRisk,
			acquisitionLikelihood: newsEvents.acquisitionLikelihood,
			catalystType: newsEvents.catalystType,
			expectedMoveDuration: newsEvents.expectedMoveDuration,
		})
		.from(newsEvents)
		.where(
			and(sql`${newsEvents.symbols} LIKE ${`%"${symbol}"%`}`, gte(newsEvents.classifiedAt, cutoff)),
		);

	const subFields = [
		"earningsSurprise",
		"guidanceChange",
		"managementTone",
		"regulatoryRisk",
		"acquisitionLikelihood",
	] as const;
	type SubField = (typeof subFields)[number];
	const sub: Record<SubField, { num: number; den: number }> = {
		earningsSurprise: { num: 0, den: 0 },
		guidanceChange: { num: 0, den: 0 },
		managementTone: { num: 0, den: 0 },
		regulatoryRisk: { num: 0, den: 0 },
		acquisitionLikelihood: { num: 0, den: 0 },
	};

	let topWeight = 0;
	let topCatalystType: string | null = null;
	let topExpectedMoveDuration: string | null = null;

	for (const row of events) {
		if (row.sentiment == null || row.classifiedAt == null || row.confidence == null) continue;
		const w = decayWeight(row.confidence, ageHours(row.classifiedAt, now));
		for (const field of subFields) {
			const value = row[field];
			if (value != null) {
				sub[field].num += value * w;
				sub[field].den += w;
			}
		}
		if (w > topWeight) {
			topWeight = w;
			topCatalystType = row.catalystType;
			topExpectedMoveDuration = row.expectedMoveDuration;
		}
	}

	const mean = (field: SubField): number | null =>
		sub[field].den > 0 ? sub[field].num / sub[field].den : null;

	return {
		sentiment: sentimentDen > 0 ? sentimentNum / sentimentDen : null,
		earningsSurprise: mean("earningsSurprise"),
		guidanceChange: mean("guidanceChange"),
		managementTone: mean("managementTone"),
		regulatoryRisk: mean("regulatoryRisk"),
		acquisitionLikelihood: mean("acquisitionLikelihood"),
		catalystType: topCatalystType,
		expectedMoveDuration: topExpectedMoveDuration,
	};
}
