import type { HealthData } from "./health";

function formatUptime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 0) {
		return `${h}h ${m}m`;
	}
	return `${m}m`;
}

export function buildStatusPageHtml(data: HealthData): string {
	const statusColour =
		data.status === "ok" ? "#22c55e" : data.status === "degraded" ? "#f59e0b" : "#ef4444";

	const pauseButton = data.paused
		? `<form method="POST" action="/resume" style="display:inline">
        <button type="submit" class="btn btn-resume">Resume Trading</button>
      </form>`
		: `<form method="POST" action="/pause" style="display:inline">
        <button type="submit" class="btn btn-pause">Pause Trading</button>
      </form>`;

	const lastQuote = data.lastQuoteTime
		? new Date(data.lastQuoteTime).toLocaleTimeString("en-GB", { timeZone: "UTC" }) + " UTC"
		: "—";

	const pnlSign = data.dailyPnl >= 0 ? "+" : "";
	const pnlColour = data.dailyPnl >= 0 ? "#22c55e" : "#ef4444";

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="60" />
  <title>Trader v2 — Status</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 1.5rem; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-weight: 600; font-size: 0.875rem; background: ${statusColour}22; color: ${statusColour}; border: 1px solid ${statusColour}44; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
    .card { background: #1e293b; border-radius: 0.75rem; padding: 1.25rem; }
    .card-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 0.5rem; }
    .card-value { font-size: 1.5rem; font-weight: 700; }
    .pnl { color: ${pnlColour}; }
    .controls { margin-top: 1.5rem; }
    .btn { padding: 0.625rem 1.25rem; border-radius: 0.5rem; font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none; }
    .btn-pause { background: #f59e0b; color: #0f172a; }
    .btn-resume { background: #22c55e; color: #0f172a; }
    .footer { margin-top: 2rem; font-size: 0.75rem; color: #475569; }
  </style>
</head>
<body>
  <h1>Trader v2 <span class="badge">${data.status.toUpperCase()}</span></h1>

  <div class="grid">
    <div class="card">
      <div class="card-label">Uptime</div>
      <div class="card-value">${formatUptime(data.uptime)}</div>
    </div>
    <div class="card">
      <div class="card-label">Active Strategies</div>
      <div class="card-value">${data.activeStrategies}</div>
    </div>
    <div class="card">
      <div class="card-label">Daily P&amp;L</div>
      <div class="card-value pnl">${pnlSign}${data.dailyPnl.toFixed(2)}p</div>
    </div>
    <div class="card">
      <div class="card-label">API Spend Today</div>
      <div class="card-value">$${data.apiSpendToday.toFixed(4)}</div>
    </div>
    <div class="card">
      <div class="card-label">Last Quote</div>
      <div class="card-value" style="font-size:1rem">${lastQuote}</div>
    </div>
  </div>

  <div class="controls">
    ${pauseButton}
  </div>

  <div class="footer">Auto-refreshes every 60 seconds &middot; ${new Date(data.timestamp).toUTCString()}</div>
</body>
</html>`;
}
