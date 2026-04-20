import { createChildLogger } from "../../utils/logger.ts";

const log = createChildLogger({ module: "edgar-shares-frames" });

const EDGAR_UA = "trader-v2 (cal@nicklin.io)";

// Example: CY2025Q4I → Calendar Year 2025 Q4 Instant (2025-12-31).
// "I" (instant) gives point-in-time values like sharesOutstanding.
export type FramesQuarter = `CY${number}Q${1 | 2 | 3 | 4}I`;

export interface FramesFetchInput {
	quarter: FramesQuarter;
	fetchImpl?: typeof fetch;
}

interface FramesResponse {
	taxonomy: string;
	tag: string;
	ccp: string;
	data: Array<{ cik: number; entityName?: string; val: number; end: string }>;
}

export async function fetchSharesOutstandingFrames(
	input: FramesFetchInput,
): Promise<Map<number, number>> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/CommonStockSharesOutstanding/shares/${input.quarter}.json`;
	const res = await fetchImpl(url, { headers: { "User-Agent": EDGAR_UA } });
	if (!res.ok) {
		throw new Error(`EDGAR frames request failed: ${res.status} for ${input.quarter}`);
	}
	const data = (await res.json()) as FramesResponse;
	const out = new Map<number, number>();
	for (const row of data.data) {
		out.set(row.cik, row.val);
	}
	log.info({ quarter: input.quarter, count: out.size }, "EDGAR shares-outstanding frames fetched");
	return out;
}

// Pick the most-recent completed quarter as of `now`. Companies file 10-K
// within 60–90 days of quarter-end, so we lag by 45 days to maximise
// coverage (frames for a quarter fill in over time as companies file).
export function mostRecentCompletedQuarter(now: Date): FramesQuarter {
	const lagged = new Date(now.getTime() - 45 * 86400_000);
	const year = lagged.getUTCFullYear();
	const month = lagged.getUTCMonth() + 1; // 1..12
	let q: 1 | 2 | 3 | 4;
	let yy = year;
	if (month <= 3) {
		q = 4;
		yy = year - 1;
	} else if (month <= 6) {
		q = 1;
	} else if (month <= 9) {
		q = 2;
	} else {
		q = 3;
	}
	return `CY${yy}Q${q}I` as FramesQuarter;
}
