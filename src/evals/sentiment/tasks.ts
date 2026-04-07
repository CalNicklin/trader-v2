import type { EvalTask } from "../types.ts";
import type { SentimentEvalOutput, SentimentEvalReference } from "./graders.ts";

export const sentimentTasks: EvalTask<SentimentEvalOutput, SentimentEvalReference>[] = [
	// --- Correct predictions ---
	{
		id: "sent-001",
		name: "Earnings beat → price up",
		input: {
			sentiment: 0.85,
			confidence: 0.9,
			expectedMoveDuration: "1-3d",
		},
		reference: {
			actualPriceChangePct: 6.2,
			actualDirection: "up",
			actualMoveDurationDays: 2,
		},
		tags: ["correct", "earnings", "positive"],
	},
	{
		id: "sent-002",
		name: "Profit warning → price down",
		input: {
			sentiment: -0.8,
			confidence: 0.85,
			expectedMoveDuration: "intraday",
		},
		reference: {
			actualPriceChangePct: -9.4,
			actualDirection: "down",
			actualMoveDurationDays: 0,
		},
		tags: ["correct", "warning", "negative"],
	},
	{
		id: "sent-003",
		name: "FDA approval → price up multi-day",
		input: {
			sentiment: 0.9,
			confidence: 0.88,
			expectedMoveDuration: "1-2w",
		},
		reference: {
			actualPriceChangePct: 14.5,
			actualDirection: "up",
			actualMoveDurationDays: 9,
		},
		tags: ["correct", "fda", "positive"],
	},
	{
		id: "sent-004",
		name: "Acquisition announcement → price up",
		input: {
			sentiment: 0.75,
			confidence: 0.82,
			expectedMoveDuration: "1-3d",
		},
		reference: {
			actualPriceChangePct: 5.8,
			actualDirection: "up",
			actualMoveDurationDays: 1,
		},
		tags: ["correct", "acquisition", "positive"],
	},
	{
		id: "sent-005",
		name: "Weak guidance → price down sustained",
		input: {
			sentiment: -0.65,
			confidence: 0.78,
			expectedMoveDuration: "1-2w",
		},
		reference: {
			actualPriceChangePct: -4.3,
			actualDirection: "down",
			actualMoveDurationDays: 7,
		},
		tags: ["correct", "guidance", "negative"],
	},
	// --- Challenging cases ---
	{
		id: "sent-006",
		name: "Positive sentiment but price drops (sell the news)",
		input: {
			sentiment: 0.7,
			confidence: 0.72,
			expectedMoveDuration: "1-3d",
		},
		reference: {
			actualPriceChangePct: -2.1,
			actualDirection: "down",
			actualMoveDurationDays: 2,
		},
		tags: ["challenging", "contrarian", "positive"],
	},
	{
		id: "sent-007",
		name: "High confidence but actual move is flat",
		input: {
			sentiment: 0.6,
			confidence: 0.85,
			expectedMoveDuration: "intraday",
		},
		reference: {
			actualPriceChangePct: 0.2,
			actualDirection: "flat",
			actualMoveDurationDays: 0,
		},
		tags: ["challenging", "flat", "miscalibrated"],
	},
	{
		id: "sent-008",
		name: "Correct direction but move delayed beyond prediction",
		input: {
			sentiment: 0.65,
			confidence: 0.7,
			expectedMoveDuration: "1-3d",
		},
		reference: {
			actualPriceChangePct: 3.5,
			actualDirection: "up",
			actualMoveDurationDays: 18,
		},
		tags: ["challenging", "delayed", "positive"],
	},
	{
		id: "sent-009",
		name: "Underconfident on strong move",
		input: {
			sentiment: 0.5,
			confidence: 0.45,
			expectedMoveDuration: "1-2w",
		},
		reference: {
			actualPriceChangePct: 11.0,
			actualDirection: "up",
			actualMoveDurationDays: 8,
		},
		tags: ["challenging", "underconfident", "positive"],
	},
	{
		id: "sent-010",
		name: "Moderate negative signal, correct mild down move",
		input: {
			sentiment: -0.4,
			confidence: 0.62,
			expectedMoveDuration: "1-3d",
		},
		reference: {
			actualPriceChangePct: -1.8,
			actualDirection: "down",
			actualMoveDurationDays: 3,
		},
		tags: ["challenging", "moderate", "negative"],
	},
];
