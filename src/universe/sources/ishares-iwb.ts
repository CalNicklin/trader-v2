import { createChildLogger } from "../../utils/logger.ts";
import type { ConstituentRow } from "../sources.ts";

const log = createChildLogger({ module: "ishares-iwb" });

// iShares Russell 1000 ETF (IWB) holdings CSV. Updated daily on BlackRock's
// site. We use this as the authoritative Russell 1000 membership list because
// FMP's /v3/russell-1000-constituent endpoint is equivalent but required an
// API key; switching to this removes one dependency on FMP.
const IWB_HOLDINGS_URL =
	"https://www.ishares.com/us/products/239707/ishares-russell-1000-etf/1467271812596.ajax?fileType=csv&fileName=IWB_holdings&dataType=fund";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export async function fetchIwbConstituents(
	fetchImpl: typeof fetch = fetch,
): Promise<ConstituentRow[]> {
	const res = await fetchImpl(IWB_HOLDINGS_URL, {
		headers: { "User-Agent": USER_AGENT },
	});
	if (!res.ok) {
		throw new Error(`IWB holdings request failed: ${res.status} ${res.statusText}`);
	}
	const csv = await res.text();
	const rows = parseIwbCsv(csv);
	log.info({ count: rows.length }, "IWB (Russell 1000) constituents fetched");
	return rows;
}

export function parseIwbCsv(csv: string): ConstituentRow[] {
	const lines = csv.split("\n");
	const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,"));
	if (headerIdx < 0) {
		throw new Error("IWB CSV header row (Ticker,Name,...) not found");
	}
	const rows: ConstituentRow[] = [];
	for (const line of lines.slice(headerIdx + 1)) {
		if (!line.trim().startsWith('"')) continue;
		const cells = parseCsvRow(line);
		const ticker = cells[0];
		const assetClass = cells[3];
		const exchange = cells[10];
		if (assetClass !== "Equity") continue;
		if (!ticker) continue;
		rows.push({
			symbol: ticker,
			exchange: normalizeExchange(exchange ?? "NASDAQ"),
			indexSource: "russell_1000",
		});
	}
	return rows;
}

// iShares US CSV uses the `"field","field",...` convention. Split on `","`
// after trimming the outer quotes.
function parseCsvRow(line: string): string[] {
	const trimmed = line.replace(/^"|"$/g, "");
	return trimmed.split('","');
}

function normalizeExchange(raw: string): string {
	// iShares labels are e.g. "NASDAQ", "NYSE", "NYSE Arca". Collapse to our canonical set.
	if (raw.includes("NASDAQ")) return "NASDAQ";
	if (raw.includes("NYSE")) return "NYSE";
	return raw;
}
