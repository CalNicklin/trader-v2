/** All hard risk limits. Human-controlled, not AI-tunable. */

// ── Per-Trade Limits ──────────────────────────────────────────────────────
export const RISK_PER_TRADE_PCT = 0.01; // 1% of account balance
export const MIN_POSITION_VALUE = 50; // USD — below this, spreads eat edge
export const MAX_CONCURRENT_POSITIONS = 3;
export const MAX_SHORT_SIZE_RATIO = 0.75; // 75% of max long size
export const BORROW_FEE_CAP_ANNUAL_PCT = 0.05; // 5% annualized

// ── Stop Loss Multipliers ─────────────────────────────────────────────────
export const STOP_LOSS_ATR_MULT_LONG = 2; // 2x ATR(14) for longs
export const STOP_LOSS_ATR_MULT_SHORT = 1; // 1x ATR(14) for shorts

// ── Portfolio-Level Limits ────────────────────────────────────────────────
export const DAILY_LOSS_HALT_PCT = 0.03; // 3% — stop all trading for the day
export const WEEKLY_DRAWDOWN_LIMIT_PCT = 0.05; // 5% — reduce position sizes by 50%
export const WEEKLY_DRAWDOWN_SIZE_REDUCTION = 0.5; // multiply sizes by this
export const MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT = 0.1; // 10% — full stop
export const MAX_CORRELATED_SECTOR_POSITIONS = 2;

// ── Demotion / Kill ───────────────────────────────────────────────────────
export const TWO_STRIKE_WINDOW_DAYS = 30; // second breach within N days = demotion
export const CAPITAL_REDUCTION_FIRST_STRIKE = 0.5; // 50% capital on first breach
export const KILL_LOSS_STREAK_SD = 3; // loss streak > 3 SD of expected
export const KILL_MAX_LIVE_TRADES = 60; // not profitable after N live trades
export const KILL_DEMOTIONS_IN_WINDOW = 2; // demoted twice in window
export const KILL_DEMOTION_WINDOW_DAYS = 60;

// ── Behavioral Divergence ─────────────────────────────────────────────────
export const BEHAVIORAL_DIVERGENCE_THRESHOLD = 0.2; // 20% deviation flags review
