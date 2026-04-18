import type { WatchlistRow } from "./repo.ts";

export interface CatalystContext {
	symbol: string;
	exchange: string;
	eventType: string;
	source: string;
	payload: unknown;
	firedAt: string;
}

export interface EnrichmentPayload {
	catalystSummary: string;
	directionalBias: "long" | "short" | "ambiguous";
	horizon: "intraday" | "days" | "weeks";
	status: "active" | "resolved";
	correlatedSymbols?: string[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function buildEnrichmentPrompt(row: WatchlistRow, recentEvents: CatalystContext[]): string {
	const eventsBlock =
		recentEvents.length === 0
			? "(no recent catalyst payloads on record)"
			: recentEvents
					.map(
						(e, i) =>
							`[${i + 1}] ${e.eventType} (${e.firedAt}) source=${e.source} payload=${JSON.stringify(
								e.payload,
							)}`,
					)
					.join("\n");

	return [
		`You are enriching a watchlist entry for a systematic trading system.`,
		``,
		`Symbol: ${row.symbol}`,
		`Exchange: ${row.exchange}`,
		`Promotion reasons: ${row.promotionReasons}`,
		`Promoted at: ${row.promotedAt}`,
		`Last catalyst at: ${row.lastCatalystAt}`,
		``,
		`Recent catalyst events:`,
		eventsBlock,
		``,
		`Return STRICTLY JSON matching this shape:`,
		`{`,
		`  "catalyst_summary": "<one to two sentence summary>",`,
		`  "directional_bias": "long" | "short" | "ambiguous",`,
		`  "horizon": "intraday" | "days" | "weeks",`,
		`  "status": "active" | "resolved",`,
		`  "correlated_symbols": ["OPTIONAL_TICKER", ...]`,
		`}`,
		``,
		`status=resolved means the catalyst has fully played out and the watchlist entry should be demoted.`,
		`Do NOT invent facts beyond the payloads above. If the payloads are sparse, return status=active with directional_bias=ambiguous.`,
	].join("\n");
}

export function parseEnrichmentResponse(raw: string): ParseResult<EnrichmentPayload> {
	const json = unwrapJson(raw);
	if (!json) return { ok: false, error: "no JSON found in response" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		return { ok: false, error: `malformed JSON: ${err instanceof Error ? err.message : err}` };
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, error: "response is not an object" };
	}

	const p = parsed as Record<string, unknown>;
	if (typeof p.catalyst_summary !== "string") {
		return { ok: false, error: "missing or non-string catalyst_summary" };
	}
	if (
		p.directional_bias !== "long" &&
		p.directional_bias !== "short" &&
		p.directional_bias !== "ambiguous"
	) {
		return { ok: false, error: `invalid directional_bias: ${p.directional_bias}` };
	}
	if (p.horizon !== "intraday" && p.horizon !== "days" && p.horizon !== "weeks") {
		return { ok: false, error: `invalid horizon: ${p.horizon}` };
	}
	if (p.status !== "active" && p.status !== "resolved") {
		return { ok: false, error: `invalid status: ${p.status}` };
	}

	const correlated = Array.isArray(p.correlated_symbols)
		? p.correlated_symbols.filter((s): s is string => typeof s === "string")
		: undefined;

	return {
		ok: true,
		value: {
			catalystSummary: p.catalyst_summary,
			directionalBias: p.directional_bias,
			horizon: p.horizon,
			status: p.status,
			correlatedSymbols: correlated,
		},
	};
}

function unwrapJson(raw: string): string | null {
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence?.[1]) return fence[1].trim();
	const trimmed = raw.trim();
	if (trimmed.startsWith("{")) return trimmed;
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
	return null;
}
