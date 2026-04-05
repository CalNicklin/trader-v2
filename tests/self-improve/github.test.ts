import { describe, expect, test } from "bun:test";
import type { IssueRequest, PRRequest } from "../../src/self-improve/github";

describe("self-improve github types", () => {
	test("PRRequest type shape is valid", () => {
		const pr: PRRequest = {
			title: "Improve RSI weighting",
			description: "Adjusted thresholds based on backtest",
			branch: "self-improve/rsi-weight-20260404",
			changes: [{ path: "src/strategy/signals.ts", content: "// updated" }],
		};
		expect(pr.changes.length).toBe(1);
		expect(pr.branch).toStartWith("self-improve/");
	});

	test("IssueRequest type shape is valid", () => {
		const issue: IssueRequest = {
			title: "Update graduation gate threshold",
			body: "Suggest lowering minimum sample from 30 to 25",
			labels: ["agent-suggestion"],
		};
		expect(issue.labels).toContain("agent-suggestion");
	});
});
