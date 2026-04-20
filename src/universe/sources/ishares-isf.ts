import { createChildLogger } from "../../utils/logger.ts";
import type { ConstituentRow } from "../sources.ts";

const log = createChildLogger({ module: "ishares-isf" });

// iShares Core FTSE 100 UCITS ETF (ISF) holdings CSV. UK site uses a
// different AJAX suffix than the US site, hence the separate URL.
const ISF_HOLDINGS_URL =
	"https://www.ishares.com/uk/individual/en/products/251795/ishares-core-ftse-100-ucits-etf/1506575576011.ajax?fileType=csv&fileName=ISF_holdings&dataType=fund";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export async function fetchIsfConstituents(
	fetchImpl: typeof fetch = fetch,
): Promise<ConstituentRow[]> {
	const res = await fetchImpl(ISF_HOLDINGS_URL, {
		headers: { "User-Agent": USER_AGENT },
	});
	if (!res.ok) {
		throw new Error(`ISF holdings request failed: ${res.status} ${res.statusText}`);
	}
	const csv = await res.text();
	const rows = parseIsfCsv(csv);
	log.info({ count: rows.length }, "ISF (FTSE 100) constituents fetched");
	return rows;
}

export function parseIsfCsv(csv: string): ConstituentRow[] {
	const lines = csv.split("\n");
	const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,"));
	if (headerIdx < 0) {
		throw new Error("ISF CSV header row (Ticker,Name,...) not found");
	}
	const rows: ConstituentRow[] = [];
	for (const line of lines.slice(headerIdx + 1)) {
		if (!line.trim().startsWith('"')) continue;
		const cells = parseCsvRow(line);
		const ticker = cells[0];
		const assetClass = cells[3];
		if (assetClass !== "Equity") continue;
		if (!ticker) continue;
		rows.push({
			symbol: normaliseLondonSymbol(ticker),
			exchange: "LSE",
			indexSource: "ftse_350",
		});
	}
	return rows;
}

function parseCsvRow(line: string): string[] {
	const trimmed = line.replace(/^"|"$/g, "");
	return trimmed.split('","');
}

// Strip trailing dot from London EPICs (BP. → BP, RR. → RR). Yahoo + our DB
// store them without the trailing dot.
function normaliseLondonSymbol(raw: string): string {
	return raw.replace(/\.$/, "");
}
