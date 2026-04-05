import { describe, expect, test } from "bun:test";
import {
	classifyProposal,
	generateBranchName,
	isHumanOnlyPath,
	isWhitelistedPath,
	parseProposerResponse,
} from "../../src/self-improve/proposer";

describe("proposer", () => {
	test("isWhitelistedPath matches strategy evaluation files", () => {
		expect(isWhitelistedPath("src/strategy/evaluation/scorer.ts")).toBe(true);
		expect(isWhitelistedPath("src/strategy/signals/rsi.ts")).toBe(true);
		expect(isWhitelistedPath("src/news/classifier.ts")).toBe(true);
		expect(isWhitelistedPath("src/reporting/email.ts")).toBe(true);
	});

	test("isWhitelistedPath rejects non-whitelisted files", () => {
		expect(isWhitelistedPath("src/db/schema.ts")).toBe(false);
		expect(isWhitelistedPath("src/broker/ibkr.ts")).toBe(false);
		expect(isWhitelistedPath("src/risk/limits.ts")).toBe(false);
	});

	test("isHumanOnlyPath matches protected files", () => {
		expect(isHumanOnlyPath("src/risk/limits.ts")).toBe(true);
		expect(isHumanOnlyPath("src/db/schema.ts")).toBe(true);
		expect(isHumanOnlyPath("src/broker/ibkr.ts")).toBe(true);
		expect(isHumanOnlyPath("drizzle/migrations/0001.sql")).toBe(true);
	});

	test("classifyProposal returns pr for whitelisted, issue for human-only, skip for unknown", () => {
		expect(classifyProposal("src/strategy/evaluation/scorer.ts")).toBe("pr");
		expect(classifyProposal("src/risk/limits.ts")).toBe("issue");
		expect(classifyProposal("src/unknown/random.ts")).toBe("skip");
	});

	test("generateBranchName creates a valid git branch name", () => {
		const branch = generateBranchName("Improve RSI signal weighting");
		expect(branch).toMatch(/^self-improve\//);
		expect(branch).not.toContain(" ");
		expect(branch.length).toBeLessThan(80);
	});
});

describe("parseProposerResponse", () => {
	test("parses valid JSON array from code block", () => {
		const response =
			'```json\n[{"title":"Test","description":"desc","targetFile":"src/x.ts","changeDescription":"change","reasoning":"reason","priority":"high"}]\n```';
		const ideas = parseProposerResponse(response);
		expect(ideas.length).toBe(1);
		expect(ideas[0].title).toBe("Test");
	});

	test("returns empty array for invalid JSON", () => {
		const ideas = parseProposerResponse("not json at all");
		expect(ideas).toEqual([]);
	});

	test("returns empty array for empty array response", () => {
		const ideas = parseProposerResponse("[]");
		expect(ideas).toEqual([]);
	});

	test("filters out malformed entries", () => {
		const response =
			'[{"title":"Good","targetFile":"src/x.ts","changeDescription":"change"},{"bad":true}]';
		const ideas = parseProposerResponse(response);
		expect(ideas.length).toBe(1);
	});
});
