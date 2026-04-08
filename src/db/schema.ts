import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ── Strategies ──────────────────────────────────────────────────────────────

export const strategies = sqliteTable("strategies", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	description: text("description").notNull(),
	parameters: text("parameters").notNull(), // JSON
	signals: text("signals"), // JSON: { entry_long, entry_short, exit }
	universe: text("universe"), // JSON: string[]
	status: text("status", {
		enum: ["paper", "probation", "active", "core", "retired"],
	})
		.notNull()
		.default("paper"),
	virtualBalance: real("virtual_balance").notNull().default(10000),
	parentStrategyId: integer("parent_strategy_id"),
	generation: integer("generation").notNull().default(1),
	createdBy: text("created_by").default("seed"), // "seed" | "evolution" | "human"
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	retiredAt: text("retired_at"),
	promotedAt: text("promoted_at"),
});

// ── Paper Trading ───────────────────────────────────────────────────────────

export const paperPositions = sqliteTable("paper_positions", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id").notNull(),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	side: text("side", { enum: ["BUY", "SELL"] })
		.notNull()
		.default("BUY"),
	quantity: real("quantity").notNull(),
	entryPrice: real("entry_price").notNull(),
	currentPrice: real("current_price"),
	stopLoss: real("stop_loss"),
	trailingStop: real("trailing_stop"),
	highWaterMark: real("high_water_mark"),
	unrealizedPnl: real("unrealized_pnl"),
	openedAt: text("opened_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	closedAt: text("closed_at"),
});

export const paperTrades = sqliteTable("paper_trades", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id").notNull(),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull().default("NASDAQ"),
	side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
	quantity: real("quantity").notNull(),
	price: real("price").notNull(),
	friction: real("friction").notNull().default(0), // stamp duty + FX cost deducted
	pnl: real("pnl"),
	signalType: text("signal_type").notNull(), // entry_long, entry_short, exit
	reasoning: text("reasoning"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Live Trading ────────────────────────────────────────────────────────────

export const livePositions = sqliteTable(
	"live_positions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		strategyId: integer("strategy_id"),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		currency: text("currency").notNull().default("USD"),
		quantity: real("quantity").notNull(),
		avgCost: real("avg_cost").notNull(),
		currentPrice: real("current_price"),
		unrealizedPnl: real("unrealized_pnl"),
		marketValue: real("market_value"),
		stopLossPrice: real("stop_loss_price"),
		trailingStopPrice: real("trailing_stop_price"),
		highWaterMark: real("high_water_mark"),
		updatedAt: text("updated_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		symbolExchangeUnique: unique("live_positions_symbol_exchange_unique").on(
			table.symbol,
			table.exchange,
		),
	}),
);

export const liveTrades = sqliteTable("live_trades", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id"),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	side: text("side", { enum: ["BUY", "SELL"] }).notNull(),
	quantity: real("quantity").notNull(),
	orderType: text("order_type", { enum: ["LIMIT", "MARKET"] }).notNull(),
	limitPrice: real("limit_price"),
	fillPrice: real("fill_price"),
	commission: real("commission"),
	friction: real("friction").notNull().default(0),
	status: text("status", {
		enum: ["PENDING", "SUBMITTED", "FILLED", "PARTIALLY_FILLED", "CANCELLED", "ERROR"],
	})
		.notNull()
		.default("PENDING"),
	ibOrderId: integer("ib_order_id"),
	reasoning: text("reasoning"),
	confidence: real("confidence"),
	pnl: real("pnl"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updated_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	filledAt: text("filled_at"),
});

// ── Market Data ─────────────────────────────────────────────────────────────

export const quotesCache = sqliteTable(
	"quotes_cache",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		last: real("last"),
		bid: real("bid"),
		ask: real("ask"),
		volume: integer("volume"),
		avgVolume: integer("avg_volume"),
		changePercent: real("change_percent"),
		newsSentiment: real("news_sentiment"), // written by news event bus
		newsEarningsSurprise: real("news_earnings_surprise"),
		newsGuidanceChange: real("news_guidance_change"),
		newsManagementTone: real("news_management_tone"),
		newsRegulatoryRisk: real("news_regulatory_risk"),
		newsAcquisitionLikelihood: real("news_acquisition_likelihood"),
		newsCatalystType: text("news_catalyst_type"),
		newsExpectedMoveDuration: text("news_expected_move_duration"),
		updatedAt: text("updated_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		symbolExchangeUnique: unique("quotes_cache_symbol_exchange_unique").on(
			table.symbol,
			table.exchange,
		),
	}),
);

export const earningsCalendar = sqliteTable("earnings_calendar", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	date: text("date").notNull(),
	estimatedEps: real("estimated_eps"),
	source: text("source"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Strategy Metrics & Graduation ───────────────────────────────────────────

export const strategyMetrics = sqliteTable(
	"strategy_metrics",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		strategyId: integer("strategy_id").notNull(),
		sampleSize: integer("sample_size").notNull().default(0),
		winRate: real("win_rate"),
		expectancy: real("expectancy"),
		profitFactor: real("profit_factor"),
		sharpeRatio: real("sharpe_ratio"),
		sortinoRatio: real("sortino_ratio"),
		maxDrawdownPct: real("max_drawdown_pct"),
		calmarRatio: real("calmar_ratio"),
		consistencyScore: integer("consistency_score"), // profitable weeks out of last 4
		updatedAt: text("updated_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		strategyIdUnique: unique("strategy_metrics_strategy_id_unique").on(table.strategyId),
	}),
);

export const graduationEvents = sqliteTable("graduation_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id").notNull(),
	event: text("event", {
		enum: ["graduated", "promoted", "demoted", "killed"],
	}).notNull(),
	fromTier: text("from_tier"),
	toTier: text("to_tier"),
	evidence: text("evidence"), // JSON: statistical summary
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Evolution ───────────────────────────────────────────────────────────────

export const strategyMutations = sqliteTable("strategy_mutations", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	parentId: integer("parent_id").notNull(),
	childId: integer("child_id").notNull(),
	mutationType: text("mutation_type", {
		enum: ["parameter_tweak", "new_variant", "code_change", "structural"],
	}).notNull(),
	parameterDiff: text("parameter_diff"), // JSON
	parentSharpe: real("parent_sharpe"),
	childSharpe: real("child_sharpe"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Learning Loop ──────────────────────────────────────────────────────────

export const tradeInsights = sqliteTable("trade_insights", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id"),
	tradeId: integer("trade_id"),
	insightType: text("insight_type", {
		enum: [
			"trade_review",
			"pattern_analysis",
			"graduation",
			"missed_opportunity",
			"universe_suggestion",
		],
	}).notNull(),
	tags: text("tags"), // JSON: string[]
	observation: text("observation").notNull(),
	suggestedAction: text("suggested_action"), // JSON: { parameter, direction, reasoning }
	confidence: real("confidence"),
	promptVersion: integer("prompt_version"),
	ledToImprovement: integer("led_to_improvement", { mode: "boolean" }),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const learningLoopConfig = sqliteTable("learning_loop_config", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	configType: text("config_type", {
		enum: ["trade_review", "pattern_analysis", "graduation"],
	}).notNull(),
	promptVersion: integer("prompt_version").notNull().default(1),
	promptText: text("prompt_text").notNull(),
	active: integer("active", { mode: "boolean" }).notNull().default(true),
	hitRate: real("hit_rate"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	retiredAt: text("retired_at"),
});

// ── News ────────────────────────────────────────────────────────────────────

export const newsEvents = sqliteTable(
	"news_events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		source: text("source").notNull(),
		headline: text("headline").notNull(),
		url: text("url"),
		symbols: text("symbols"), // JSON: string[]
		sentiment: real("sentiment"),
		confidence: real("confidence"),
		tradeable: integer("tradeable", { mode: "boolean" }),
		eventType: text("event_type"),
		urgency: text("urgency", { enum: ["low", "medium", "high"] }),
		earningsSurprise: real("earnings_surprise"),
		guidanceChange: real("guidance_change"),
		managementTone: real("management_tone"),
		regulatoryRisk: real("regulatory_risk"),
		acquisitionLikelihood: real("acquisition_likelihood"),
		catalystType: text("catalyst_type"),
		expectedMoveDuration: text("expected_move_duration"),
		classifiedAt: text("classified_at"),
		priceAtClassification: real("price_at_classification"),
		priceAfter1d: real("price_after_1d"),
		createdAt: text("created_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		headlineIdx: index("news_events_headline_idx").on(table.headline),
	}),
);

export const newsAnalyses = sqliteTable(
	"news_analyses",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		newsEventId: integer("news_event_id").notNull(),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		sentiment: real("sentiment").notNull(),
		urgency: text("urgency", { enum: ["low", "medium", "high"] }).notNull(),
		eventType: text("event_type").notNull(),
		direction: text("direction", { enum: ["long", "short", "avoid"] }).notNull(),
		tradeThesis: text("trade_thesis").notNull(),
		confidence: real("confidence").notNull(),
		recommendTrade: integer("recommend_trade", { mode: "boolean" }).notNull(),
		inUniverse: integer("in_universe", { mode: "boolean" }).notNull(),
		priceAtAnalysis: real("price_at_analysis"),
		priceAfter1d: real("price_after_1d"),
		priceAfter1w: real("price_after_1w"),
		validatedTicker: integer("validated_ticker", { mode: "boolean" })
			.notNull()
			.$defaultFn(() => true),
		createdAt: text("created_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		newsEventIdx: index("news_analyses_news_event_idx").on(table.newsEventId),
		symbolIdx: index("news_analyses_symbol_idx").on(table.symbol),
		inUniverseIdx: index("news_analyses_in_universe_idx").on(table.inUniverse),
		uniqueEventSymbol: uniqueIndex("news_analyses_event_symbol_uniq").on(
			table.newsEventId,
			table.symbol,
		),
	}),
);

// ── Operational ─────────────────────────────────────────────────────────────

export const tokenUsage = sqliteTable("token_usage", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	job: text("job").notNull(),
	inputTokens: integer("input_tokens").notNull(),
	outputTokens: integer("output_tokens").notNull(),
	cacheCreationTokens: integer("cache_creation_tokens"),
	cacheReadTokens: integer("cache_read_tokens"),
	estimatedCostUsd: real("estimated_cost_usd").notNull(),
	status: text("status"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const agentLogs = sqliteTable("agent_logs", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	level: text("level", { enum: ["INFO", "WARN", "ERROR", "DECISION", "ACTION"] }).notNull(),
	phase: text("phase"),
	message: text("message").notNull(),
	data: text("data"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const dailySnapshots = sqliteTable("daily_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	date: text("date").notNull().unique(),
	portfolioValue: real("portfolio_value").notNull(),
	cashBalance: real("cash_balance").notNull(),
	positionsValue: real("positions_value").notNull(),
	dailyPnl: real("daily_pnl").notNull(),
	dailyPnlPercent: real("daily_pnl_percent").notNull(),
	totalPnl: real("total_pnl").notNull(),
	paperStrategiesActive: integer("paper_strategies_active").notNull().default(0),
	liveStrategiesActive: integer("live_strategies_active").notNull().default(0),
	tradesCount: integer("trades_count").notNull().default(0),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

// ── Risk State ─────────────────────────────────────────────────────────────

export const riskState = sqliteTable("risk_state", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	key: text("key").notNull().unique(),
	value: text("value").notNull(),
	updatedAt: text("updated_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const improvementProposals = sqliteTable("improvement_proposals", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	title: text("title").notNull(),
	description: text("description").notNull(),
	filesChanged: text("files_changed"),
	prUrl: text("pr_url"),
	status: text("status", {
		enum: ["PROPOSED", "PR_CREATED", "ISSUE_CREATED", "MERGED", "REJECTED"],
	})
		.notNull()
		.default("PROPOSED"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});
