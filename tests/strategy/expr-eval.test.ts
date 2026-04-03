import { describe, expect, test } from "bun:test";
import { evalExpr } from "../../src/strategy/expr-eval.ts";

describe("evalExpr", () => {
	const ctx = {
		rsi14: 25,
		volume_ratio: 2.0,
		news_sentiment: 0.8,
		hold_days: 5,
		pnl_pct: -3,
		gap_pct: 0.5,
		change_percent: 1.2,
	};

	test("simple comparisons", () => {
		expect(evalExpr("rsi14 < 30", ctx)).toBe(true);
		expect(evalExpr("rsi14 > 30", ctx)).toBe(false);
		expect(evalExpr("rsi14 >= 25", ctx)).toBe(true);
		expect(evalExpr("rsi14 <= 25", ctx)).toBe(true);
		expect(evalExpr("hold_days == 5", ctx)).toBe(true);
		expect(evalExpr("hold_days != 3", ctx)).toBe(true);
	});

	test("AND expression", () => {
		expect(evalExpr("news_sentiment > 0.7 AND rsi14 < 30 AND volume_ratio > 1.5", ctx)).toBe(true);
		expect(evalExpr("news_sentiment > 0.9 AND rsi14 < 30", ctx)).toBe(false);
	});

	test("OR expression", () => {
		expect(evalExpr("hold_days >= 3 OR pnl_pct < -2 OR pnl_pct > 5", ctx)).toBe(true);
		expect(evalExpr("rsi14 > 100 OR volume_ratio > 1.0", ctx)).toBe(true);
	});

	test("AND binds tighter than OR", () => {
		expect(evalExpr("rsi14 > 100 AND volume_ratio > 1.0 OR hold_days >= 3", ctx)).toBe(true);
	});

	test("parentheses override precedence", () => {
		expect(evalExpr("hold_days >= 3 AND (rsi14 > 100 OR volume_ratio < 0.5)", ctx)).toBe(false);
	});

	test("unknown variable returns false", () => {
		expect(evalExpr("unknown_var > 5", ctx)).toBe(false);
	});

	test("empty expression returns false", () => {
		expect(evalExpr("", ctx)).toBe(false);
	});

	test("negative numbers in context", () => {
		expect(evalExpr("pnl_pct < -2", ctx)).toBe(true);
		expect(evalExpr("pnl_pct > -1", ctx)).toBe(false);
	});

	test("malformed expression returns false", () => {
		expect(evalExpr("rsi14 > > 30", ctx)).toBe(false);
		expect(evalExpr("AND OR", ctx)).toBe(false);
	});
});
