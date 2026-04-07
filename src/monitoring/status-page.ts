import type {
	DashboardData,
	GuardianData,
	LearningLoopData,
	NewsPipelineData,
	TradeActivityData,
} from "./dashboard-data.ts";

function formatUptime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function escHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function kpiColor(value: number, limit: number, invert = false): string {
	if (value === 0) return "#666";
	if (invert) {
		const pct = Math.abs(value) / limit;
		if (pct >= 0.8) return "#ef4444";
		if (pct >= 0.5) return "#f59e0b";
		return "#22c55e";
	}
	return value >= 0 ? "#22c55e" : "#ef4444";
}

function riskBarPct(value: number, max: number): number {
	if (max === 0) return 0;
	return Math.min(100, Math.max(0, (Math.abs(value) / max) * 100));
}

function riskBarColor(pct: number): string {
	if (pct >= 80) return "#ef4444";
	if (pct >= 50) return "#f59e0b";
	return "#22c55e";
}

function statusDot(connected: boolean): string {
	const color = connected ? "#22c55e" : "#ef4444";
	return `<span style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${color};box-shadow:0 0 6px ${color}88;"></span>`;
}

function buildTabBar(activeTab: string): string {
	const tabs = [
		{ id: "overview", label: "Overview", href: "/" },
		{ id: "news", label: "News Pipeline", href: "/?tab=news" },
		{ id: "guardian", label: "Guardian", href: "/?tab=guardian" },
		{ id: "learning", label: "Learning Loop", href: "/?tab=learning" },
		{ id: "trades", label: "Trades", href: "/?tab=trades" },
	];
	const links = tabs
		.map((t) => {
			const cls = t.id === activeTab ? "tab-link active" : "tab-link";
			return `<a href="${t.href}" class="${cls}">${t.label}</a>`;
		})
		.join("\n");
	return `<div class="tab-bar">${links}</div>`;
}

export function buildConsolePage(data: DashboardData, tab = "overview", tabHtml = ""): string {
	const utcTime = new Date(data.timestamp).toLocaleString("en-GB", {
		day: "2-digit",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "UTC",
	});

	// Strategy tier counts
	const tierCounts: Record<string, number> = {
		paper: 0,
		probation: 0,
		active: 0,
		core: 0,
		retired: 0,
	};
	for (const s of data.strategies) {
		tierCounts[s.status] = (tierCounts[s.status] ?? 0) + 1;
	}
	const liveCount = (tierCounts.probation ?? 0) + (tierCounts.active ?? 0) + (tierCounts.core ?? 0);

	// KPIs
	const lastQuoteDisplay = data.lastQuoteTime
		? `${new Date(data.lastQuoteTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`
		: "—";
	const lastQuoteSub = (() => {
		if (!data.lastQuoteTime) return "no data";
		const age = Date.now() - new Date(data.lastQuoteTime).getTime();
		if (age > 3_600_000) return "stale";
		return "live";
	})();

	// Pause button
	const pauseAction = tab !== "overview" ? `/pause?tab=${tab}` : "/pause";
	const resumeAction = tab !== "overview" ? `/resume?tab=${tab}` : "/resume";
	const pauseBtn = data.paused
		? `<form method="POST" action="${resumeAction}" style="display:inline"><button type="submit" class="pause-btn" style="border-color:#22c55e;color:#22c55e;">▶ RESUME</button></form>`
		: `<form method="POST" action="${pauseAction}" style="display:inline"><button type="submit" class="pause-btn">⏸ PAUSE</button></form>`;

	// Positions HTML
	const positionsHtml =
		data.positions.length === 0
			? `<div style="color:#333;padding:8px 0;">No positions</div>`
			: data.positions
					.map((p) => {
						const isShort = p.quantity < 0;
						const sideClass = isShort ? "short" : "long";
						const sideLabel = isShort ? "SHORT" : "LONG";
						const pnlStr =
							p.unrealizedPnl != null
								? `${p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}`
								: "—";
						const orphanTag = p.strategyId == null ? `<span class="orphan-tag">orphan</span>` : "";
						return `<div class="position-row">
						<span class="symbol">${escHtml(p.symbol)}:${escHtml(p.exchange)}</span>
						<span class="${sideClass}">${sideLabel}</span>
						<span>${Math.abs(p.quantity).toLocaleString()}</span>
						<span>${p.avgCost.toFixed(2)}p</span>
						<span style="color:${p.unrealizedPnl != null && p.unrealizedPnl >= 0 ? "#22c55e" : "#ef4444"}">${pnlStr}</span>
						<span>${orphanTag}</span>
					</div>`;
					})
					.join("\n");

	// Strategy rows
	const strategyRows = data.strategies
		.map((s) => {
			const statusClass = `status-${s.status}`;
			const winRate = s.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : "—";
			const sharpe = s.sharpeRatio != null ? s.sharpeRatio.toFixed(2) : "—";
			const universe = s.universe.slice(0, 3).join(", ") + (s.universe.length > 3 ? "…" : "");
			return `<div class="strategy-row">
				<span class="name">${escHtml(s.name)}</span>
				<span class="${statusClass}">${s.status}</span>
				<span>${winRate}</span>
				<span>${sharpe}</span>
				<span>${s.tradeCount}</span>
				<span>${escHtml(universe)}</span>
			</div>`;
		})
		.join("\n");

	// Cron rows
	const cronRows = data.cronJobs
		.map((j, i) => {
			const isUpcoming = i < 3;
			const rowClass = isUpcoming ? "cron-row upcoming" : "cron-row";
			const nextTime = new Date(j.nextRun).toLocaleTimeString("en-GB", {
				hour: "2-digit",
				minute: "2-digit",
				timeZone: "Europe/London",
			});
			const lastHtml =
				j.lastStatus === "ok"
					? `<span class="last-ok">✓ ok</span>`
					: j.lastStatus === "error"
						? `<span class="last-err">✗ err</span>`
						: `<span style="color:#333;">—</span>`;
			return `<div class="${rowClass}">
				<span class="time">${nextTime}</span>
				<span class="job">${escHtml(j.name)}</span>
				<span>${lastHtml}</span>
				<span class="countdown">${j.nextRunIn}</span>
			</div>`;
		})
		.join("\n");

	// Log entries
	const logEntries =
		data.recentLogs.length === 0
			? `<div style="color:#333;padding:8px 0;">No activity logged</div>`
			: data.recentLogs
					.map((l) => {
						const levelClass = `level-${l.level.toLowerCase()}`;
						const levelLabel =
							l.level === "ACTION" ? "ACTN" : l.level === "DECISION" ? "DCSN" : l.level;
						return `<div class="log-entry">
						<span class="ts">${l.time}</span>
						<span class="${levelClass}">${levelLabel}</span>
						<span class="phase">${escHtml(l.phase ?? "")}</span>
						<span class="msg">${escHtml(l.message.substring(0, 120))}</span>
					</div>`;
					})
					.join("\n");

	// Risk bars
	const dailyPct = riskBarPct(data.dailyPnl, data.dailyPnlLimit);
	const weeklyPct = riskBarPct(data.weeklyPnl, data.weeklyPnlLimit);
	const posPct = riskBarPct(data.openPositionCount, data.maxPositions);

	// Main content area: overview grid or tab-specific content
	const mainContent =
		tab === "overview"
			? `<div class="console">
<div class="kpi-strip">
<div class="kpi"><div class="kpi-label">Daily P&amp;L</div><div class="kpi-value" style="color:${kpiColor(data.dailyPnl, data.dailyPnlLimit)}">${data.dailyPnl >= 0 ? "+" : ""}${data.dailyPnl.toFixed(2)}p</div><div class="kpi-sub">limit: ${data.dailyPnlLimit.toFixed(0)}%</div></div>
<div class="kpi"><div class="kpi-label">Weekly P&amp;L</div><div class="kpi-value" style="color:${kpiColor(data.weeklyPnl, data.weeklyPnlLimit)}">${data.weeklyPnl >= 0 ? "+" : ""}${data.weeklyPnl.toFixed(2)}p</div><div class="kpi-sub">limit: ${data.weeklyPnlLimit.toFixed(0)}%</div></div>
<div class="kpi"><div class="kpi-label">Open Positions</div><div class="kpi-value" style="color:${data.openPositionCount > 0 ? "#f59e0b" : "#666"}">${data.openPositionCount}</div><div class="kpi-sub">${data.positions[0] ? escHtml(data.positions[0].symbol) : "—"}</div></div>
<div class="kpi"><div class="kpi-label">Trades Today</div><div class="kpi-value" style="color:${data.tradesToday > 0 ? "#e2e8f0" : "#666"}">${data.tradesToday}</div><div class="kpi-sub">—</div></div>
<div class="kpi"><div class="kpi-label">API Spend</div><div class="kpi-value" style="color:${data.apiSpendToday > data.apiBudget * 0.8 ? "#ef4444" : "#666"}">$${data.apiSpendToday.toFixed(2)}</div><div class="kpi-sub">budget: $${data.apiBudget.toFixed(2)}</div></div>
<div class="kpi"><div class="kpi-label">Last Quote</div><div class="kpi-value" style="color:#666;font-size:12px">${lastQuoteDisplay}</div><div class="kpi-sub">${lastQuoteSub}</div></div>
</div>

<div class="pipeline">
<div class="panel-header">Strategy Pipeline<span class="count">${data.strategies.length} total</span></div>
<div class="pipeline-row">
<div class="tier paper"><span class="tc">${tierCounts.paper}</span><span class="tl">Paper</span></div>
<span class="arrow">→</span>
<div class="tier probation"><span class="tc">${tierCounts.probation}</span><span class="tl">Probation</span></div>
<span class="arrow">→</span>
<div class="tier active"><span class="tc">${tierCounts.active}</span><span class="tl">Active</span></div>
<span class="arrow">→</span>
<div class="tier core"><span class="tc">${tierCounts.core}</span><span class="tl">Core</span></div>
<span style="flex:1"></span>
<div class="tier retired"><span class="tc">${tierCounts.retired}</span><span class="tl">Retired</span></div>
</div>
<div class="strategy-list">
<div class="strategy-row header"><span>Name</span><span>Status</span><span>Win Rate</span><span>Sharpe</span><span>Trades</span><span>Universe</span></div>
${strategyRows}
</div>
</div>

<div class="panel">
<div class="panel-header">Live Positions<span class="count">${data.openPositionCount}</span></div>
<div class="scroll-panel">
<div class="position-row header"><span>Symbol</span><span>Side</span><span>Qty</span><span>Avg</span><span>P&amp;L</span><span></span></div>
${positionsHtml}
</div>
<div style="border-top:1px solid #151515;margin-top:12px;padding-top:10px;">
<div class="panel-header" style="margin-bottom:8px;">Risk Limits</div>
<div class="risk-meter"><div class="risk-label"><span>Daily P&amp;L</span><span>${data.dailyPnl.toFixed(1)} / ${data.dailyPnlLimit.toFixed(0)}%</span></div><div class="risk-bar"><div class="risk-fill" style="width:${dailyPct}%;background:${riskBarColor(dailyPct)}"></div></div></div>
<div class="risk-meter"><div class="risk-label"><span>Weekly P&amp;L</span><span>${data.weeklyPnl.toFixed(1)} / ${data.weeklyPnlLimit.toFixed(0)}%</span></div><div class="risk-bar"><div class="risk-fill" style="width:${weeklyPct}%;background:${riskBarColor(weeklyPct)}"></div></div></div>
<div class="risk-meter"><div class="risk-label"><span>Max Positions</span><span>${data.openPositionCount} / ${data.maxPositions}</span></div><div class="risk-bar"><div class="risk-fill" style="width:${posPct}%;background:${riskBarColor(posPct)}"></div></div></div>
</div>
${pauseBtn}
</div>

<div class="panel">
<div class="panel-header">Cron Schedule<span class="count">${data.cronJobs.length} jobs</span></div>
<div class="scroll-panel">
<div class="cron-row header"><span>Time</span><span>Job</span><span>Last</span><span>Next In</span></div>
${cronRows}
</div>
</div>

<div class="panel">
<div class="panel-header">Activity Log<span class="count">recent</span></div>
<div class="scroll-panel">
${logEntries}
</div>
</div>

<div class="footer-bar">
<span>Auto-refreshes every 30s &middot; All times Europe/London</span>
<span>trader-v2 @ ${escHtml(data.gitHash)}</span>
</div>
</div>`
			: `<div class="tab-content">${tabHtml}</div>
<div class="footer-bar" style="background:#0a0a0a;padding:6px 14px;color:#333;font-size:10px;display:flex;justify-content:space-between;border-top:1px solid #1a1a1a">
<span>Auto-refreshes every 30s &middot; All times Europe/London</span>
<span>${pauseBtn} &nbsp; trader-v2 @ ${escHtml(data.gitHash)}</span>
</div>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="refresh" content="30${tab !== "overview" ? `;url=/?tab=${tab}` : ""}" />
<title>Trader v2 — Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'JetBrains Mono','Courier New',monospace;background:#050505;color:#b0b0b0;min-height:100vh;font-size:12px;line-height:1.5}
.status-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;background:#0a0a0a;border-bottom:1px solid #1a1a1a}
.status-bar .left{display:flex;align-items:center;gap:16px}
.status-bar .title{color:#f59e0b;font-weight:700;font-size:13px;letter-spacing:2px}
.status-tag{display:inline-flex;align-items:center;gap:5px;color:#888;font-size:11px}
.meta{color:#555;font-size:11px}
.console{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:#1a1a1a;min-height:calc(100vh - 37px)}
.panel{background:#0a0a0a;padding:12px 14px}
.panel-header{color:#555;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
.panel-header .count{color:#444}
.kpi-strip{grid-column:1/-1;display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:#1a1a1a}
.kpi{background:#0a0a0a;padding:10px 14px}
.kpi-label{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.kpi-value{font-size:16px;font-weight:600}
.kpi-sub{color:#333;font-size:9px;margin-top:2px}
.pipeline{grid-column:1/-1;background:#0a0a0a;padding:12px 14px}
.pipeline-row{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap}
.tier{display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid #1a1a1a;border-radius:3px;min-width:110px}
.tier .tc{font-size:14px;font-weight:700}
.tier .tl{font-size:10px;color:#555;text-transform:uppercase}
.tier.paper{border-color:#334155}.tier.paper .tc{color:#94a3b8}
.tier.probation{border-color:#92400e}.tier.probation .tc{color:#f59e0b}
.tier.active{border-color:#166534}.tier.active .tc{color:#22c55e}
.tier.core{border-color:#14532d}.tier.core .tc{color:#15803d}
.tier.retired{border-color:#1a1a1a}.tier.retired .tc{color:#333}
.arrow{color:#333;font-size:16px}
.strategy-list{margin-top:10px;border-top:1px solid #151515;padding-top:8px}
.strategy-row{display:grid;grid-template-columns:200px 80px 70px 70px 60px 1fr;gap:12px;padding:4px 0;color:#666;font-size:11px}
.strategy-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.strategy-row .name{color:#94a3b8}
.status-paper{color:#64748b}.status-probation{color:#f59e0b}.status-active{color:#22c55e}.status-core{color:#15803d}
.position-row{display:grid;grid-template-columns:100px 55px 65px 65px 65px 1fr;gap:8px;padding:4px 0;font-size:11px;color:#666}
.position-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.position-row .symbol{color:#e2e8f0;font-weight:500}
.short{color:#ef4444}.long{color:#22c55e}
.orphan-tag{color:#f59e0b;font-size:9px;background:#f59e0b11;padding:1px 5px;border-radius:2px}
.risk-meter{margin:6px 0}
.risk-bar{height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden;margin-top:4px}
.risk-fill{height:100%;border-radius:2px}
.risk-label{display:flex;justify-content:space-between;font-size:10px;color:#555}
.cron-row{display:grid;grid-template-columns:50px 170px 55px 1fr;gap:8px;padding:4px 0;font-size:11px;color:#555}
.cron-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.cron-row .time{color:#94a3b8}.cron-row .job{color:#888}
.cron-row .countdown{color:#333;font-size:10px}
.cron-row.upcoming{color:#888}.cron-row.upcoming .time{color:#f59e0b}
.last-ok{color:#22c55e88}.last-err{color:#ef4444}
.log-entry{padding:3px 0;font-size:11px;color:#555;display:flex;gap:8px}
.log-entry .ts{color:#333;min-width:45px}
.log-entry .phase{color:#444;min-width:50px}
.log-entry .msg{color:#777}
.level-info{color:#3b82f6}.level-warn{color:#f59e0b}.level-error{color:#ef4444}.level-action{color:#22c55e}.level-decision{color:#a855f7}
.scroll-panel{max-height:300px;overflow-y:auto}
.scroll-panel::-webkit-scrollbar{width:3px}.scroll-panel::-webkit-scrollbar-track{background:transparent}.scroll-panel::-webkit-scrollbar-thumb{background:#222;border-radius:2px}
.pause-btn{margin-top:12px;padding:6px 14px;background:transparent;border:1px solid #333;color:#888;font-family:inherit;font-size:11px;cursor:pointer;border-radius:3px}
.pause-btn:hover{border-color:#f59e0b;color:#f59e0b}
.footer-bar{grid-column:1/-1;background:#0a0a0a;padding:6px 14px;color:#333;font-size:10px;display:flex;justify-content:space-between;border-top:1px solid #1a1a1a}
.tab-bar{display:flex;gap:0;background:#0a0a0a;border-bottom:1px solid #1a1a1a;padding:0 16px}
.tab-link{padding:10px 20px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#555;border-bottom:2px solid transparent;text-decoration:none;font-family:inherit}
.tab-link:hover{color:#888}
.tab-link.active{color:#f59e0b;border-bottom-color:#f59e0b}
.stat-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#1a1a1a;margin-bottom:16px}
.stat-card{background:#0a0a0a;padding:10px 14px}
.stat-card .sc-label{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.stat-card .sc-value{font-size:16px;font-weight:600}
.stat-card .sc-sub{color:#333;font-size:9px;margin-top:2px}
.insight-card{padding:10px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:3px;margin-bottom:6px}
.insight-card .ic-header{display:flex;justify-content:space-between;margin-bottom:4px}
.insight-card .ic-body{color:#888;font-size:11px}
.insight-card .ic-meta{color:#444;font-size:9px;margin-top:4px}
.type-badge{font-size:9px;text-transform:uppercase;padding:1px 6px;border-radius:2px}
.type-trade_review{color:#3b82f6;background:#3b82f611}
.type-pattern_analysis{color:#a855f7;background:#a855f711}
.type-graduation{color:#22c55e;background:#22c55e11}
.type-badge.type-missed_opportunity{background:#78350f;color:#fbbf24}
.type-badge.type-universe_suggestion{background:#1e3a5f;color:#60a5fa}
.tab-content{padding:16px 14px;background:#0a0a0a;min-height:calc(100vh - 120px)}
.section-divider{display:flex;align-items:center;gap:10px;margin:18px 0 12px}
.section-label{color:#555;font-size:9px;text-transform:uppercase;letter-spacing:2px;white-space:nowrap}
.section-line{flex:1;height:1px;background:#1a1a1a}
.research-columns{display:grid;grid-template-columns:1fr 220px;gap:12px;margin-top:8px}
.research-col-main{min-width:0}
.research-col-side{min-width:0}
.ra-scroll{overflow-x:auto}
.ra-scroll::-webkit-scrollbar{height:3px}.ra-scroll::-webkit-scrollbar-track{background:transparent}.ra-scroll::-webkit-scrollbar-thumb{background:#222;border-radius:2px}
.ra-row{display:grid;grid-template-columns:45px 90px 48px 42px 80px 55px minmax(300px,1fr);gap:6px;padding:4px 0;font-size:11px;color:#666;border-bottom:1px solid #0f0f0f;min-width:700px}
.ra-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.ra-time{color:#333}
.ra-sym{color:#e2e8f0;font-weight:500}
.ra-dir{font-weight:600}
.ra-conf{color:#888}
.ra-tags{display:flex;gap:3px}
.ra-price{color:#666;font-size:10px}
.ra-thesis{color:#555;font-size:10px;white-space:normal;word-break:break-word}
.rec-tag{font-size:8px;padding:1px 4px;border-radius:2px;font-weight:600;letter-spacing:.5px}
.rec-tag.rec{background:#f59e0b22;color:#f59e0b}
.rec-tag.univ{background:#22c55e11;color:#22c55e88}
.rec-tag.new{background:#c084fc11;color:#c084fc}
.ts-row{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:11px}
.ts-sym{color:#94a3b8;font-weight:500;min-width:55px}
.ts-bar-track{flex:1;height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden}
.ts-bar-fill{height:100%;border-radius:2px}
.ts-count{color:#555;min-width:24px;text-align:right;font-size:10px}
.news-row{display:grid;grid-template-columns:45px 65px 1fr 60px 50px;gap:8px;padding:5px 0;font-size:11px;color:#666;border-bottom:1px solid #0f0f0f}
.news-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.guardian-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.guardian-card{background:#0a0a0a;padding:12px;border:1px solid #166534;border-radius:3px}
.guardian-card.tripped{border-color:#ef4444}
.guardian-log-row{display:grid;grid-template-columns:45px 1fr;gap:8px;padding:5px 0;font-size:11px;color:#666;border-bottom:1px solid #0f0f0f}
.trade-row{display:grid;grid-template-columns:45px 65px 42px 60px 60px 80px 70px 1fr;gap:6px;padding:5px 0;font-size:11px;color:#666;border-bottom:1px solid #0f0f0f}
.trade-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
</style>
</head>
<body>
<div class="status-bar">
<div class="left">
<span class="title">TRADER V2</span>
<span class="status-tag">${statusDot(data.ibkrConnected)} ${data.ibkrConnected ? `IBKR ${escHtml(data.ibkrAccount ?? "")}` : "IBKR OFF"}</span>
<span class="status-tag">${statusDot(data.status === "ok")} ${data.status.toUpperCase()}</span>
<span class="status-tag">${statusDot(liveCount > 0)} ${liveCount} LIVE</span>
${data.paused ? `<span class="status-tag" style="color:#f59e0b;">⏸ PAUSED</span>` : ""}
</div>
<div class="meta">UP ${formatUptime(data.uptime)} &middot; ${utcTime} UTC</div>
</div>
${buildTabBar(tab)}
${mainContent}
</body>
</html>`;
}

export function buildNewsPipelineTab(data: NewsPipelineData): string {
	const sentimentColor = data.avgSentiment >= 0 ? "#22c55e" : "#ef4444";
	const sentimentStr = `${data.avgSentiment >= 0 ? "+" : ""}${data.avgSentiment.toFixed(2)}`;
	const r = data.research;

	const accuracyStr =
		r.accuracyTracked > 0 ? `${((r.accuracyCorrect / r.accuracyTracked) * 100).toFixed(0)}%` : "—";
	const accuracyColor =
		r.accuracyTracked > 0
			? r.accuracyCorrect / r.accuracyTracked >= 0.6
				? "#22c55e"
				: "#ef4444"
			: "#555";

	// ── Top symbols bar ───────────────────────────────────────────────────
	const topSymbolsHtml = r.topSymbols
		.map((s) => {
			const sentColor = s.avgSentiment >= 0 ? "#22c55e" : "#ef4444";
			const barWidth = Math.max(8, Math.min(100, (s.count / (r.topSymbols[0]?.count ?? 1)) * 100));
			return `<div class="ts-row">
	<span class="ts-sym">${escHtml(s.symbol)}</span>
	<div class="ts-bar-track"><div class="ts-bar-fill" style="width:${barWidth}%;background:${sentColor}88;"></div></div>
	<span class="ts-count">${s.count}</span>
</div>`;
		})
		.join("\n");

	// ── Recent analyses feed ──────────────────────────────────────────────
	const analysesHtml =
		r.recentAnalyses.length === 0
			? `<div style="color:#333;padding:8px 0;">No research analyses yet</div>`
			: r.recentAnalyses
					.map((a) => {
						const dirColor =
							a.direction === "long" ? "#22c55e" : a.direction === "short" ? "#ef4444" : "#666";
						const dirLabel = a.direction.toUpperCase();
						const confPct = `${(a.confidence * 100).toFixed(0)}%`;
						const recTag = a.recommendTrade ? `<span class="rec-tag rec">REC</span>` : "";
						const univTag = a.inUniverse
							? `<span class="rec-tag univ">UNIV</span>`
							: `<span class="rec-tag new">NEW</span>`;
						const priceInfo =
							a.priceAtAnalysis != null
								? a.priceAfter1d != null
									? (() => {
											const move = ((a.priceAfter1d - a.priceAtAnalysis) / a.priceAtAnalysis) * 100;
											const moveColor = move >= 0 ? "#22c55e" : "#ef4444";
											return `<span style="color:${moveColor};font-size:10px;">${move >= 0 ? "+" : ""}${move.toFixed(1)}%</span>`;
										})()
									: `<span style="color:#333;font-size:10px;">$${a.priceAtAnalysis.toFixed(0)} →?</span>`
								: "";
						return `<div class="ra-row">
	<span class="ra-time">${a.time}</span>
	<span class="ra-sym">${escHtml(a.symbol)}:${escHtml(a.exchange)}</span>
	<span class="ra-dir" style="color:${dirColor};">${dirLabel}</span>
	<span class="ra-conf">${confPct}</span>
	<span class="ra-tags">${recTag}${univTag}</span>
	<span class="ra-price">${priceInfo}</span>
	<span class="ra-thesis">${escHtml(a.tradeThesis)}</span>
</div>`;
					})
					.join("\n");

	// ── Classifications table ─────────────────────────────────────────────
	const articleRows =
		data.recentArticles.length === 0
			? `<div style="color:#333;padding:8px 0;">No articles in last 24h</div>`
			: data.recentArticles
					.map((a) => {
						const sym = a.symbols.slice(0, 2).join(", ");
						const sentColor =
							a.sentiment != null ? (a.sentiment >= 0 ? "#22c55e" : "#ef4444") : "#666";
						const sentStr =
							a.sentiment != null ? `${a.sentiment >= 0 ? "+" : ""}${a.sentiment.toFixed(2)}` : "—";
						const urgencyColor =
							a.urgency === "high" ? "#f59e0b" : a.urgency === "medium" ? "#888" : "#555";
						const urgencyLabel = a.urgency ? a.urgency.toUpperCase() : "—";
						return `<div class="news-row">
	<span style="color:#333;">${a.time}</span>
	<span style="color:#94a3b8;font-weight:500;">${escHtml(sym)}</span>
	<span style="color:#777;">${escHtml(a.headline)}</span>
	<span style="color:${sentColor};">${sentStr}</span>
	<span style="color:${urgencyColor};">${urgencyLabel}</span>
</div>`;
					})
					.join("\n");

	return `
<div class="stat-cards" style="grid-template-columns:repeat(4,1fr);">
	<div class="stat-card"><div class="sc-label">Articles (24h)</div><div class="sc-value" style="color:#e2e8f0;">${data.totalArticles24h}</div><div class="sc-sub">stored from Finnhub</div></div>
	<div class="stat-card"><div class="sc-label">Classified</div><div class="sc-value" style="color:#3b82f6;">${data.classifiedCount}</div><div class="sc-sub">passed pre-filter</div></div>
	<div class="stat-card"><div class="sc-label">Tradeable</div><div class="sc-value" style="color:#22c55e;">${data.tradeableHighUrgency}</div><div class="sc-sub">high-urgency signals</div></div>
	<div class="stat-card"><div class="sc-label">Avg Sentiment</div><div class="sc-value" style="color:${sentimentColor};">${sentimentStr}</div><div class="sc-sub">across classified</div></div>
</div>

<div class="section-divider">
	<span class="section-label">Research Intelligence</span>
	<span class="section-line"></span>
</div>

<div class="stat-cards" style="grid-template-columns:repeat(5,1fr);">
	<div class="stat-card"><div class="sc-label">Analyses</div><div class="sc-value" style="color:#c084fc;">${r.totalAnalyses}</div><div class="sc-sub">total research rows</div></div>
	<div class="stat-card"><div class="sc-label">Symbols</div><div class="sc-value" style="color:#60a5fa;">${r.uniqueSymbols}</div><div class="sc-sub">unique discovered</div></div>
	<div class="stat-card"><div class="sc-label">Recommendations</div><div class="sc-value" style="color:#f59e0b;">${r.recommendations}</div><div class="sc-sub">conf ≥ 0.8</div></div>
	<div class="stat-card"><div class="sc-label">New Symbols</div><div class="sc-value" style="color:#fb923c;">${r.outOfUniverse}</div><div class="sc-sub">out-of-universe recs</div></div>
	<div class="stat-card"><div class="sc-label">Accuracy</div><div class="sc-value" style="color:${accuracyColor};">${accuracyStr}</div><div class="sc-sub">${r.accuracyTracked} tracked</div></div>
</div>

<div class="research-columns">
<div class="research-col-main">
	<div class="panel-header">Recent Analyses<span class="count">${r.recentAnalyses.length}</span></div>
	<div class="scroll-panel ra-scroll" style="max-height:400px;">
		<div class="ra-row header"><span>Time</span><span>Symbol</span><span>Dir</span><span>Conf</span><span>Tags</span><span>Move</span><span>Thesis</span></div>
		${analysesHtml}
	</div>
</div>
<div class="research-col-side">
	<div class="panel-header">Top Symbols<span class="count">${r.topSymbols.length}</span></div>
	<div class="scroll-panel" style="max-height:400px;">
		${topSymbolsHtml}
	</div>
</div>
</div>

<div class="section-divider" style="margin-top:20px;">
	<span class="section-label">Classifications</span>
	<span class="section-line"></span>
</div>

<div class="panel-header">Recent Articles<span class="count">${data.recentArticles.length}</span></div>
<div class="scroll-panel" style="max-height:350px;">
	<div class="news-row header"><span>Time</span><span>Symbol</span><span>Headline</span><span>Sentiment</span><span>Urgency</span></div>
	${articleRows}
</div>`;
}
export function buildGuardianTab(data: GuardianData): string {
	function guardianCard(
		label: string,
		active: boolean,
		valuePct: number,
		limitPct: number,
	): string {
		const statusLabel = active ? "ACTIVE" : "CLEAR";
		const statusColor = active ? "#ef4444" : "#22c55e";
		const cardClass = active ? "guardian-card tripped" : "guardian-card";
		return `<div class="${cardClass}">
	<div style="display:flex;justify-content:space-between;align-items:center;">
		<span style="color:#444;font-size:9px;text-transform:uppercase;">${label}</span>
		${statusDot(!active)}
	</div>
	<div style="font-size:13px;font-weight:600;color:${statusColor};margin-top:6px;">${statusLabel}</div>
	<div style="color:#333;font-size:9px;margin-top:2px;">${valuePct}% / ${limitPct}%</div>
</div>`;
	}

	const logRows =
		data.checkHistory.length === 0
			? `<div style="color:#333;padding:8px 0;">No guardian checks logged</div>`
			: data.checkHistory
					.map((l) => {
						const msgColor =
							l.level === "ERROR" ? "#ef4444" : l.level === "WARN" ? "#f59e0b" : "#22c55e";
						return `<div class="guardian-log-row">
	<span style="color:#333;">${l.time}</span>
	<span style="color:${msgColor};">${escHtml(l.message)}</span>
</div>`;
					})
					.join("\n");

	return `
<div class="guardian-cards">
	${guardianCard("Circuit Breaker", data.circuitBreaker.active, data.circuitBreaker.drawdownPct, data.circuitBreaker.limitPct)}
	${guardianCard("Daily Halt", data.dailyHalt.active, data.dailyHalt.lossPct, data.dailyHalt.limitPct)}
	${guardianCard("Weekly Drawdown", data.weeklyDrawdown.active, data.weeklyDrawdown.lossPct, data.weeklyDrawdown.limitPct)}
</div>
<div style="margin-bottom:8px;display:flex;justify-content:space-between;font-size:10px;color:#444;">
	<span>Peak: £${data.peakBalance.toLocaleString()}</span>
	<span>Current: £${data.accountBalance.toLocaleString()}</span>
</div>
<div class="panel-header">Guardian Check History<span class="count">${data.checkHistory.length}</span></div>
<div class="scroll-panel" style="max-height:500px;">
	${logRows}
</div>`;
}
export function buildLearningLoopTab(data: LearningLoopData): string {
	const insightCards =
		data.recentInsights.length === 0
			? `<div style="color:#333;padding:8px 0;">No insights recorded yet</div>`
			: data.recentInsights
					.map((i) => {
						const typeClass = `type-${i.insightType}`;
						const checkmark = i.ledToImprovement ? ` · Led to improvement: ✓` : "";
						const confStr = i.confidence != null ? i.confidence.toFixed(2) : "—";
						const tagsStr = i.tags.length > 0 ? i.tags.join(", ") : "—";
						return `<div class="insight-card">
	<div class="ic-header">
		<span class="type-badge ${typeClass}">${escHtml(i.insightType)}</span>
		<span style="color:#333;font-size:9px;">${i.time}</span>
	</div>
	<div class="ic-body">${escHtml(i.observation)}</div>
	<div class="ic-meta">Confidence: ${confStr} · Tags: ${escHtml(tagsStr)}${checkmark}</div>
</div>`;
					})
					.join("\n");

	return `
<div class="stat-cards" style="grid-template-columns:repeat(4,1fr);">
	<div class="stat-card"><div class="sc-label">Insights (7d)</div><div class="sc-value" style="color:#e2e8f0;">${data.insightsCount7d}</div><div class="sc-sub">from trade reviews</div></div>
	<div class="stat-card"><div class="sc-label">Led to Change</div><div class="sc-value" style="color:#22c55e;">${data.ledToImprovement}</div><div class="sc-sub">parameter updates</div></div>
	<div class="stat-card"><div class="sc-label">Patterns Found</div><div class="sc-value" style="color:#a855f7;">${data.patternsFound}</div><div class="sc-sub">this week</div></div>
	<div class="stat-card"><div class="sc-label">Missed</div><div class="sc-value" style="color:#f59e0b;">${data.missedOpportunities}</div><div class="sc-sub">opportunities</div></div>
</div>
<div class="panel-header">Recent Insights<span class="count">${data.recentInsights.length}</span></div>
<div class="scroll-panel" style="max-height:500px;">
	${insightCards}
</div>`;
}
export function buildTradeActivityTab(data: TradeActivityData): string {
	const tradeRows =
		data.trades.length === 0
			? `<div style="color:#333;padding:8px 0;">No trades recorded</div>`
			: data.trades
					.map((t) => {
						const sideColor = t.side === "BUY" ? "#22c55e" : "#ef4444";
						const pnlStr = t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}` : "—";
						const pnlColor = t.pnl != null ? (t.pnl >= 0 ? "#22c55e" : "#ef4444") : "#666";
						return `<div class="trade-row">
	<span style="color:#333;">${t.time}</span>
	<span style="color:#94a3b8;font-weight:500;">${escHtml(t.symbol)}</span>
	<span style="color:${sideColor};">${t.side}</span>
	<span style="color:#666;">${t.price.toLocaleString()}p</span>
	<span style="color:${pnlColor};">${pnlStr}</span>
	<span style="color:#555;font-size:10px;">${escHtml(t.strategyName)}</span>
	<span style="color:#444;font-size:10px;">${escHtml(t.signalType)}</span>
	<span style="color:#444;font-size:10px;">${escHtml(t.reasoning ?? "")}</span>
</div>`;
					})
					.join("\n");

	const winRateStr = data.winRateToday != null ? `${(data.winRateToday * 100).toFixed(0)}%` : "—";
	const avgWinStr = data.avgWinner != null ? `+${data.avgWinner.toFixed(0)}` : "—";
	const avgLoseStr = data.avgLoser != null ? `${data.avgLoser.toFixed(0)}` : "—";

	return `
<div class="panel-header">Recent Trades<span class="count">${data.trades.length}</span></div>
<div class="scroll-panel" style="max-height:500px;">
	<div class="trade-row header"><span>Time</span><span>Symbol</span><span>Side</span><span>Price</span><span>P&amp;L</span><span>Strategy</span><span>Signal</span><span>Reason</span></div>
	${tradeRows}
</div>
<div class="stat-cards" style="margin-top:16px;">
	<div class="stat-card"><div class="sc-label">Today</div><div class="sc-value" style="color:#e2e8f0;">${data.tradesToday}</div><div class="sc-sub">trades</div></div>
	<div class="stat-card"><div class="sc-label">Win Rate</div><div class="sc-value" style="color:${data.winRateToday != null && data.winRateToday >= 0.5 ? "#22c55e" : "#ef4444"};">${winRateStr}</div><div class="sc-sub">today</div></div>
	<div class="stat-card"><div class="sc-label">Avg Winner</div><div class="sc-value" style="color:#22c55e;">${avgWinStr}</div><div class="sc-sub">pence</div></div>
	<div class="stat-card"><div class="sc-label">Avg Loser</div><div class="sc-value" style="color:#ef4444;">${avgLoseStr}</div><div class="sc-sub">pence</div></div>
</div>`;
}
