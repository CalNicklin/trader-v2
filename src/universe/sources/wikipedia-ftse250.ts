import { createChildLogger } from "../../utils/logger.ts";
import type { ConstituentRow } from "../sources.ts";

const log = createChildLogger({ module: "wikipedia-ftse250" });

const WIKIPEDIA_URL = "https://en.wikipedia.org/wiki/FTSE_250_Index";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Known false-positives surfaced by the table-cell regex — short strings that
// look like EPIC codes but are column headers, abbreviations, etc.
const KNOWN_NOISE = new Set([
	"MCX", // column header in older revisions
	"EPS",
	"EPIC",
	"FTSE",
]);

export async function fetchFtse250FromWikipedia(
	fetchImpl: typeof fetch = fetch,
): Promise<ConstituentRow[]> {
	const res = await fetchImpl(WIKIPEDIA_URL, {
		headers: { "User-Agent": USER_AGENT },
	});
	if (!res.ok) {
		throw new Error(`Wikipedia FTSE 250 request failed: ${res.status} ${res.statusText}`);
	}
	const html = await res.text();
	const rows = parseFtse250Html(html);
	log.info({ count: rows.length }, "FTSE 250 constituents fetched (Wikipedia)");
	return rows;
}

export function parseFtse250Html(html: string): ConstituentRow[] {
	// Wikipedia cells for EPIC codes look like `<td>ABDN</td>` or
	// `<td><a href=...>ABDN</a></td>`. Real EPICs are 2–4 uppercase letters,
	// optionally suffixed with a trailing dot + class letter (e.g. BP., RR.,
	// BT.A). Strip the trailing dot on normalise.
	const pattern = /<td[^>]*>(?:<a[^>]*>)?([A-Z]{2,4}\.?[A-Z]?)(?:<\/a>)?<\/td>/g;
	const found = new Set<string>();
	for (const m of html.matchAll(pattern)) {
		const t = m[1];
		if (!t || t.length < 2) continue;
		if (KNOWN_NOISE.has(t)) continue;
		found.add(t);
	}
	return [...found].map((t) => ({
		symbol: t.replace(/\.$/, ""),
		exchange: "LSE",
		indexSource: "ftse_350" as const,
	}));
}
