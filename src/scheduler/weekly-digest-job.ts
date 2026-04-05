import { gte, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
	improvementProposals,
	strategies,
	strategyMetrics,
	strategyMutations,
	tokenUsage,
} from "../db/schema";
import { sendEmail } from "../reporting/email";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "weekly-digest" });

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export interface WeeklyDigestData {
	periodStart: string;
	periodEnd: string;
	evolutionEvents: Array<{
		parentName: string;
		childName: string;
		mutationType: string;
		createdAt: string;
	}>;
	activeStrategies: Array<{
		name: string;
		status: string;
		generation: number;
		winRate: number | null;
		sharpeRatio: number | null;
		sampleSize: number;
	}>;
	improvementProposals: Array<{
		title: string;
		status: string;
		prUrl: string | null;
		createdAt: string;
	}>;
	totalApiSpend: number;
}

export async function getWeeklyDigestData(): Promise<WeeklyDigestData> {
	const db = getDb();
	const now = new Date();
	const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const periodStart = weekAgo.toISOString().split("T")[0]!;
	const periodEnd = now.toISOString().split("T")[0]!;

	// Evolution events from the past week — join parent and child strategy names
	const mutations = db
		.select({
			parentName: strategies.name,
			childName: sql<string>`child_s.name`,
			mutationType: strategyMutations.mutationType,
			createdAt: strategyMutations.createdAt,
		})
		.from(strategyMutations)
		.innerJoin(strategies, sql`${strategies.id} = ${strategyMutations.parentId}`)
		.innerJoin(sql`strategies AS child_s`, sql`child_s.id = ${strategyMutations.childId}`)
		.where(gte(strategyMutations.createdAt, weekAgo.toISOString()))
		.all();

	// Active strategies with latest metrics
	const strats = db
		.select({
			name: strategies.name,
			status: strategies.status,
			generation: strategies.generation,
			winRate: strategyMetrics.winRate,
			sharpeRatio: strategyMetrics.sharpeRatio,
			sampleSize: strategyMetrics.sampleSize,
		})
		.from(strategies)
		.leftJoin(strategyMetrics, sql`${strategies.id} = ${strategyMetrics.strategyId}`)
		.where(sql`${strategies.status} != 'retired'`)
		.all();

	// Improvement proposals from the past week
	const proposals = db
		.select()
		.from(improvementProposals)
		.where(gte(improvementProposals.createdAt, weekAgo.toISOString()))
		.all();

	// Total API spend this week
	const spendResult = db
		.select({ total: sql<number>`coalesce(sum(estimated_cost_usd), 0)` })
		.from(tokenUsage)
		.where(gte(tokenUsage.createdAt, weekAgo.toISOString()))
		.get();

	return {
		periodStart,
		periodEnd,
		evolutionEvents: mutations.map((m) => ({
			parentName: m.parentName,
			childName: m.childName,
			mutationType: m.mutationType,
			createdAt: m.createdAt,
		})),
		activeStrategies: strats.map((s) => ({
			name: s.name,
			status: s.status,
			generation: s.generation,
			winRate: s.winRate ?? null,
			sharpeRatio: s.sharpeRatio ?? null,
			sampleSize: s.sampleSize ?? 0,
		})),
		improvementProposals: proposals.map((p) => ({
			title: p.title,
			status: p.status,
			prUrl: p.prUrl,
			createdAt: p.createdAt,
		})),
		totalApiSpend: spendResult?.total ?? 0,
	};
}

export function buildWeeklyDigestHtml(data: WeeklyDigestData): string {
	const evolutionRows =
		data.evolutionEvents.length > 0
			? data.evolutionEvents
					.map(
						(e) => `<tr>
					<td>${esc(e.parentName)}</td>
					<td>${esc(e.childName)}</td>
					<td>${esc(e.mutationType)}</td>
					<td>${esc(e.createdAt)}</td>
				</tr>`,
					)
					.join("\n")
			: '<tr><td colspan="4">No evolution events this week</td></tr>';

	const strategyRows =
		data.activeStrategies.length > 0
			? data.activeStrategies
					.map(
						(s) => `<tr>
					<td>${esc(s.name)}</td>
					<td>${esc(s.status)}</td>
					<td>Gen ${s.generation}</td>
					<td>${s.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : "—"}</td>
					<td>${s.sharpeRatio?.toFixed(2) ?? "—"}</td>
					<td>${s.sampleSize}</td>
				</tr>`,
					)
					.join("\n")
			: '<tr><td colspan="6">No active strategies</td></tr>';

	const proposalRows =
		data.improvementProposals.length > 0
			? data.improvementProposals
					.map(
						(p) => `<tr>
					<td>${esc(p.title)}</td>
					<td>${esc(p.status)}</td>
					<td>${p.prUrl?.startsWith("https://") ? `<a href="${esc(p.prUrl)}">View PR</a>` : "—"}</td>
				</tr>`,
					)
					.join("\n")
			: '<tr><td colspan="3">No proposals this week</td></tr>';

	return `
		<h2>Trader v2 — Weekly Digest</h2>
		<p><strong>Period:</strong> ${data.periodStart} to ${data.periodEnd}</p>
		<p><strong>API spend this week:</strong> $${data.totalApiSpend.toFixed(4)}</p>

		<h3>Evolution Events</h3>
		<table border="1" cellpadding="4" cellspacing="0">
			<tr><th>Parent</th><th>Child</th><th>Type</th><th>Date</th></tr>
			${evolutionRows}
		</table>

		<h3>Active Strategies</h3>
		<table border="1" cellpadding="4" cellspacing="0">
			<tr><th>Strategy</th><th>Status</th><th>Generation</th><th>Win Rate</th><th>Sharpe</th><th>Trades</th></tr>
			${strategyRows}
		</table>

		<h3>Self-Improvement Proposals</h3>
		<table border="1" cellpadding="4" cellspacing="0">
			<tr><th>Title</th><th>Status</th><th>PR</th></tr>
			${proposalRows}
		</table>
	`;
}

export async function runWeeklyDigest(): Promise<void> {
	const data = await getWeeklyDigestData();
	const html = buildWeeklyDigestHtml(data);

	await sendEmail({
		subject: `Trader v2 Weekly — ${data.evolutionEvents.length} evolutions, $${data.totalApiSpend.toFixed(3)} API`,
		html,
	});

	log.info(
		{
			evolutions: data.evolutionEvents.length,
			proposals: data.improvementProposals.length,
			apiSpend: data.totalApiSpend,
		},
		"Weekly digest sent",
	);
}
