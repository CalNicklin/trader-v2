import { describe, expect, test } from "bun:test";
import { generateBranchName, parseProposerResponse } from "../../src/self-improve/proposer";

describe("proposer", () => {
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
		expect(ideas[0]!.title).toBe("Test");
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
