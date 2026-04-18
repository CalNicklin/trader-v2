import type { CatalystContext } from "../../watchlist/enrich.ts";
import type { WatchlistRow } from "../../watchlist/repo.ts";

export interface EnrichmentEvalTask {
	id: string;
	row: Partial<WatchlistRow> & Pick<WatchlistRow, "symbol" | "exchange" | "promotionReasons">;
	events: CatalystContext[];
	expected: {
		directionalBias: "long" | "short" | "ambiguous";
		horizon: "intraday" | "days" | "weeks";
		status: "active" | "resolved";
	};
}

export const ENRICHMENT_TASKS: EnrichmentEvalTask[] = [
	{
		id: "aapl-q2-beat",
		row: { symbol: "AAPL", exchange: "NASDAQ", promotionReasons: "news,earnings" },
		events: [
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				eventType: "earnings",
				source: "fmp_earning_calendar",
				payload: { date: "2026-05-02", epsEstimate: 1.5 },
				firedAt: "2026-04-17T22:45:00Z",
			},
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Apple reports record Q2 revenue, raises guidance",
					urgency: "high",
					sentiment: 0.85,
				},
				firedAt: "2026-04-17T21:00:00Z",
			},
		],
		expected: { directionalBias: "long", horizon: "days", status: "active" },
	},
	{
		id: "tsla-recall",
		row: { symbol: "TSLA", exchange: "NASDAQ", promotionReasons: "news" },
		events: [
			{
				symbol: "TSLA",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Tesla recalls 2M vehicles over autopilot defect",
					urgency: "high",
					sentiment: -0.8,
				},
				firedAt: "2026-04-17T18:00:00Z",
			},
		],
		expected: { directionalBias: "short", horizon: "days", status: "active" },
	},
	{
		id: "resolved-merger",
		row: { symbol: "ACQR", exchange: "NASDAQ", promotionReasons: "news" },
		events: [
			{
				symbol: "ACQR",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "ACQR merger completed; delisting effective today",
					urgency: "medium",
					sentiment: 0,
				},
				firedAt: "2026-04-17T14:00:00Z",
			},
		],
		expected: { directionalBias: "ambiguous", horizon: "days", status: "resolved" },
	},
	{
		id: "msft-analyst-upgrade",
		row: { symbol: "MSFT", exchange: "NASDAQ", promotionReasons: "research" },
		events: [
			{
				symbol: "MSFT",
				exchange: "NASDAQ",
				eventType: "research",
				source: "research_agent",
				payload: {
					confidence: 0.82,
					eventType: "analyst_upgrade",
					summary: "Morgan Stanley raises MSFT price target to $550 on Azure strength",
				},
				firedAt: "2026-04-17T13:00:00Z",
			},
		],
		expected: { directionalBias: "long", horizon: "weeks", status: "active" },
	},
	{
		id: "amzn-earnings-miss",
		row: { symbol: "AMZN", exchange: "NASDAQ", promotionReasons: "news,earnings" },
		events: [
			{
				symbol: "AMZN",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Amazon Q1 earnings miss estimates; AWS growth slows",
					urgency: "high",
					sentiment: -0.6,
				},
				firedAt: "2026-04-17T22:00:00Z",
			},
		],
		expected: { directionalBias: "short", horizon: "days", status: "active" },
	},
	{
		id: "nvda-partnership",
		row: { symbol: "NVDA", exchange: "NASDAQ", promotionReasons: "news" },
		events: [
			{
				symbol: "NVDA",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Nvidia announces exclusive partnership with major automaker",
					urgency: "medium",
					sentiment: 0.7,
				},
				firedAt: "2026-04-17T15:00:00Z",
			},
		],
		expected: { directionalBias: "long", horizon: "days", status: "active" },
	},
	{
		id: "gs-guidance-cut",
		row: { symbol: "GS", exchange: "NYSE", promotionReasons: "news" },
		events: [
			{
				symbol: "GS",
				exchange: "NYSE",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Goldman Sachs cuts full-year guidance on trading revenue weakness",
					urgency: "high",
					sentiment: -0.65,
				},
				firedAt: "2026-04-17T12:30:00Z",
			},
		],
		expected: { directionalBias: "short", horizon: "weeks", status: "active" },
	},
	{
		id: "meta-product-launch",
		row: { symbol: "META", exchange: "NASDAQ", promotionReasons: "news" },
		events: [
			{
				symbol: "META",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Meta launches new AR glasses at developer conference",
					urgency: "medium",
					sentiment: 0.3,
				},
				firedAt: "2026-04-17T17:00:00Z",
			},
		],
		expected: { directionalBias: "ambiguous", horizon: "days", status: "active" },
	},
	{
		id: "xom-sanctions",
		row: { symbol: "XOM", exchange: "NYSE", promotionReasons: "news" },
		events: [
			{
				symbol: "XOM",
				exchange: "NYSE",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "New US sanctions on Russian oil — Exxon could see windfall from higher prices",
					urgency: "medium",
					sentiment: 0.5,
				},
				firedAt: "2026-04-17T09:00:00Z",
			},
		],
		expected: { directionalBias: "long", horizon: "weeks", status: "active" },
	},
	{
		id: "dis-ambiguous-news",
		row: { symbol: "DIS", exchange: "NYSE", promotionReasons: "news" },
		events: [
			{
				symbol: "DIS",
				exchange: "NYSE",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Disney announces new streaming tier; pricing details pending",
					urgency: "medium",
					sentiment: 0.05,
				},
				firedAt: "2026-04-17T11:00:00Z",
			},
		],
		expected: { directionalBias: "ambiguous", horizon: "days", status: "active" },
	},
	{
		id: "pfe-drug-approval",
		row: { symbol: "PFE", exchange: "NYSE", promotionReasons: "news" },
		events: [
			{
				symbol: "PFE",
				exchange: "NYSE",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Pfizer wins FDA approval for next-gen oncology drug",
					urgency: "high",
					sentiment: 0.75,
				},
				firedAt: "2026-04-17T14:30:00Z",
			},
		],
		expected: { directionalBias: "long", horizon: "weeks", status: "active" },
	},
	{
		id: "f-strike-resolved",
		row: { symbol: "F", exchange: "NYSE", promotionReasons: "news" },
		events: [
			{
				symbol: "F",
				exchange: "NYSE",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Ford union strike ends after labor deal ratified",
					urgency: "medium",
					sentiment: 0.2,
				},
				firedAt: "2026-04-17T10:00:00Z",
			},
		],
		expected: { directionalBias: "ambiguous", horizon: "days", status: "resolved" },
	},
	{
		id: "boeing-safety-incident",
		row: { symbol: "BA", exchange: "NYSE", promotionReasons: "news" },
		events: [
			{
				symbol: "BA",
				exchange: "NYSE",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Another Boeing 737 MAX grounded after mid-flight incident",
					urgency: "high",
					sentiment: -0.85,
				},
				firedAt: "2026-04-17T08:00:00Z",
			},
		],
		expected: { directionalBias: "short", horizon: "weeks", status: "active" },
	},
	{
		id: "wmt-acquisition-rumor",
		row: { symbol: "WMT", exchange: "NYSE", promotionReasons: "news" },
		events: [
			{
				symbol: "WMT",
				exchange: "NYSE",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Walmart in talks to acquire regional grocery chain — unconfirmed",
					urgency: "medium",
					sentiment: 0.15,
				},
				firedAt: "2026-04-17T16:00:00Z",
			},
		],
		expected: { directionalBias: "ambiguous", horizon: "days", status: "active" },
	},
	{
		id: "coinbase-volume-spike",
		row: { symbol: "COIN", exchange: "NASDAQ", promotionReasons: "volume" },
		events: [
			{
				symbol: "COIN",
				exchange: "NASDAQ",
				eventType: "volume",
				source: "volume_catalyst_job",
				payload: { volume: 30_000_000, avgVolume: 5_000_000, ratio: 6.0 },
				firedAt: "2026-04-17T15:30:00Z",
			},
		],
		expected: { directionalBias: "ambiguous", horizon: "intraday", status: "active" },
	},
];
