import type { ClassificationResult } from "../../news/classifier.ts";
import type { Grader } from "../types.ts";
import type { ClassifierReference } from "./tasks.ts";

const VALID_CATALYST_TYPES = new Set([
	"fundamental",
	"technical",
	"macro",
	"sector",
	"sentiment",
	"other",
]);

const VALID_MOVE_DURATIONS = new Set(["intraday", "1-3d", "1-2w", "1m+"]);


type CG = Grader<ClassificationResult, ClassifierReference>;

export const jsonShapeGrader: CG = {
	name: "json-shape",
	type: "code",
	grade: async (output) => {
		const hasAll =
			typeof output.tradeable === "boolean" &&
			typeof output.sentiment === "number" &&
			typeof output.confidence === "number" &&
			typeof output.eventType === "string" &&
			typeof output.urgency === "string" &&
			output.sentiment >= -1 &&
			output.sentiment <= 1 &&
			output.confidence >= 0 &&
			output.confidence <= 1;

		return {
			score: hasAll ? 1 : 0,
			pass: hasAll,
			reason: hasAll ? "Valid shape" : "Missing or invalid fields",
		};
	},
};

export const tradeableGrader: CG = {
	name: "tradeable",
	type: "code",
	grade: async (output, reference) => {
		const match = output.tradeable === reference.tradeable;
		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Correctly identified as ${output.tradeable ? "" : "non-"}tradeable`
				: `Expected tradeable=${reference.tradeable}, got ${output.tradeable}`,
		};
	},
};

export const sentimentRangeGrader: CG = {
	name: "sentiment-range",
	type: "code",
	grade: async (output, reference) => {
		const inRange =
			output.sentiment >= reference.sentimentMin && output.sentiment <= reference.sentimentMax;

		// Partial credit: how close to the range
		let score = 0;
		if (inRange) {
			score = 1;
		} else {
			const rangeCenter = (reference.sentimentMin + reference.sentimentMax) / 2;
			const distance = Math.abs(output.sentiment - rangeCenter);
			score = Math.max(0, 1 - distance);
		}

		return {
			score,
			pass: inRange,
			reason: inRange
				? `Sentiment ${output.sentiment.toFixed(2)} in range [${reference.sentimentMin}, ${reference.sentimentMax}]`
				: `Sentiment ${output.sentiment.toFixed(2)} outside range [${reference.sentimentMin}, ${reference.sentimentMax}]`,
		};
	},
};

export const eventTypeGrader: CG = {
	name: "event-type",
	type: "code",
	grade: async (output, reference) => {
		const match = reference.expectedEventTypes.includes(output.eventType);
		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Event type "${output.eventType}" matches expected`
				: `Event type "${output.eventType}" not in [${reference.expectedEventTypes.join(", ")}]`,
		};
	},
};

export const urgencyGrader: CG = {
	name: "urgency",
	type: "code",
	grade: async (output, reference) => {
		const match = output.urgency === reference.expectedUrgency;
		// Partial credit for adjacent urgency levels
		const levels = ["low", "medium", "high"];
		const outIdx = levels.indexOf(output.urgency);
		const refIdx = levels.indexOf(reference.expectedUrgency);
		const distance = Math.abs(outIdx - refIdx);
		const score = match ? 1 : distance === 1 ? 0.5 : 0;

		return {
			score,
			pass: match,
			reason: match
				? `Urgency "${output.urgency}" matches`
				: `Urgency "${output.urgency}", expected "${reference.expectedUrgency}"`,
		};
	},
};

export const signalShapeGrader: CG = {
	name: "signal-shape",
	type: "code",
	grade: async (output) => {
		// Only check shape for tradeable events — non-tradeable may have null signals
		if (!output.tradeable) {
			return { score: 1, pass: true, reason: "Non-tradeable: signal shape not required" };
		}

		if (!output.signals) {
			return { score: 0, pass: false, reason: "Tradeable event missing signals object" };
		}

		const s = output.signals;
		const checks = [
			typeof s.earningsSurprise === "number" && s.earningsSurprise >= 0 && s.earningsSurprise <= 1,
			typeof s.guidanceChange === "number" && s.guidanceChange >= 0 && s.guidanceChange <= 1,
			typeof s.managementTone === "number" && s.managementTone >= 0 && s.managementTone <= 1,
			typeof s.regulatoryRisk === "number" && s.regulatoryRisk >= 0 && s.regulatoryRisk <= 1,
			typeof s.acquisitionLikelihood === "number" &&
				s.acquisitionLikelihood >= 0 &&
				s.acquisitionLikelihood <= 1,
			typeof s.catalystType === "string" && VALID_CATALYST_TYPES.has(s.catalystType),
			typeof s.expectedMoveDuration === "string" && VALID_MOVE_DURATIONS.has(s.expectedMoveDuration),
		];

		const validCount = checks.filter(Boolean).length;
		const score = validCount / checks.length;
		const pass = validCount === checks.length;

		return {
			score,
			pass,
			reason: pass
				? "All 7 signal fields valid"
				: `${validCount}/7 signal fields valid`,
		};
	},
};

export const signalValueGrader: CG = {
	name: "signal-value",
	type: "code",
	grade: async (output, reference) => {
		// Skip if no expected signals defined in reference
		if (!reference.expectedSignals) {
			return { score: 1, pass: true, reason: "No expected signals to check" };
		}

		if (!output.signals) {
			return { score: 0, pass: false, reason: "Missing signals object, cannot check values" };
		}

		const exp = reference.expectedSignals;
		const s = output.signals;
		const checks: Array<{ name: string; pass: boolean }> = [];

		if (exp.earningsSurpriseMin !== undefined) {
			checks.push({
				name: "earningsSurprise",
				pass: s.earningsSurprise >= exp.earningsSurpriseMin,
			});
		}

		if (exp.managementToneMin !== undefined) {
			checks.push({
				name: "managementTone",
				pass: s.managementTone >= exp.managementToneMin,
			});
		}

		if (exp.catalystType !== undefined) {
			checks.push({
				name: "catalystType",
				pass: s.catalystType === exp.catalystType,
			});
		}

		if (checks.length === 0) {
			return { score: 1, pass: true, reason: "No threshold checks configured" };
		}

		const passedCount = checks.filter((c) => c.pass).length;
		const score = passedCount / checks.length;
		const pass = passedCount === checks.length;
		const failedNames = checks.filter((c) => !c.pass).map((c) => c.name);

		return {
			score,
			pass,
			reason: pass
				? "All signal value thresholds met"
				: `Failed thresholds: ${failedNames.join(", ")}`,
		};
	},
};

export const allClassifierGraders: CG[] = [
	jsonShapeGrader,
	tradeableGrader,
	sentimentRangeGrader,
	eventTypeGrader,
	urgencyGrader,
	signalShapeGrader,
	signalValueGrader,
];
