import { eq, gte } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { paperTrades, strategies, strategyMetrics } from "../db/schema.ts";
import { sendEmail } from "../reporting/email.ts";
import { getDailySpend } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "daily-summary" });

export async function runDailySummary(): Promise<void> {
	const db = getDb();
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);

	// Get all strategies with their metrics
	const allStrategies = await db
		.select()
		.from(strategies)
		.leftJoin(strategyMetrics, eq(strategies.id, strategyMetrics.strategyId));

	// Get today's trades
	const todayTrades = await db
		.select()
		.from(paperTrades)
		.where(gte(paperTrades.createdAt, todayStart.toISOString()));

	const apiSpend = await getDailySpend();

	// Build HTML email
	const strategyRows = allStrategies
		.map(({ strategies: s, strategy_metrics: m }) => {
			return `<tr>
				<td>${s.name}</td>
				<td>${s.status}</td>
				<td>${m?.sampleSize ?? 0}</td>
				<td>${m?.winRate != null ? `${(m.winRate * 100).toFixed(0)}%` : "—"}</td>
				<td>${m?.profitFactor?.toFixed(2) ?? "—"}</td>
				<td>${m?.sharpeRatio?.toFixed(2) ?? "—"}</td>
				<td>${m?.maxDrawdownPct != null ? `${m.maxDrawdownPct.toFixed(1)}%` : "—"}</td>
				<td>$${s.virtualBalance.toFixed(0)}</td>
			</tr>`;
		})
		.join("\n");

	const html = `
		<h2>Trader v2 — Daily Summary</h2>
		<p><strong>Date:</strong> ${new Date().toISOString().split("T")[0]}</p>
		<p><strong>Paper trades today:</strong> ${todayTrades.length}</p>
		<p><strong>API spend today:</strong> $${apiSpend.toFixed(4)}</p>

		<h3>Strategy Performance</h3>
		<table border="1" cellpadding="4" cellspacing="0">
			<tr>
				<th>Strategy</th><th>Status</th><th>Trades</th><th>Win Rate</th>
				<th>Profit Factor</th><th>Sharpe</th><th>Max DD</th><th>Balance</th>
			</tr>
			${strategyRows}
		</table>
	`;

	await sendEmail({
		subject: `Trader v2 Daily — ${todayTrades.length} trades, $${apiSpend.toFixed(3)} API`,
		html,
	});

	log.info({ trades: todayTrades.length, apiSpend }, "Daily summary sent");
}
