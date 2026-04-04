import type { EvalTask } from "../types.ts";

export interface PreFilterReference {
	shouldPass: boolean;
	reason: string;
}

export const preFilterTasks: EvalTask<string, PreFilterReference>[] = [
	// === SHOULD BLOCK (shouldPass = false) ===
	{
		id: "pf-001",
		name: "Analyst reiterate",
		input: "Analyst reiterates Buy rating on Apple",
		reference: { shouldPass: false, reason: "analyst reiterate pattern" },
		tags: ["block"],
	},
	{
		id: "pf-002",
		name: "Board appointment",
		input: "Company appoints new board member John Smith",
		reference: { shouldPass: false, reason: "board member pattern" },
		tags: ["block"],
	},
	{
		id: "pf-003",
		name: "ESG report",
		input: "Annual ESG report shows progress on sustainability goals",
		reference: { shouldPass: false, reason: "ESG report pattern" },
		tags: ["block"],
	},
	{
		id: "pf-004",
		name: "Routine filing",
		input: "Routine filing submitted to SEC",
		reference: { shouldPass: false, reason: "routine filing pattern" },
		tags: ["block"],
	},
	{
		id: "pf-005",
		name: "AGM notice",
		input: "Annual general meeting scheduled for March 15",
		reference: { shouldPass: false, reason: "annual meeting pattern" },
		tags: ["block"],
	},
	{
		id: "pf-006",
		name: "Corporate governance",
		input: "Corporate governance review completed",
		reference: { shouldPass: false, reason: "corporate governance pattern" },
		tags: ["block"],
	},
	{
		id: "pf-007",
		name: "Shareholder letter",
		input: "CEO shareholder letter published in annual report",
		reference: { shouldPass: false, reason: "shareholder letter pattern" },
		tags: ["block"],
	},
	{
		id: "pf-008",
		name: "No material change",
		input: "No material change to previously disclosed information",
		reference: { shouldPass: false, reason: "no material change pattern" },
		tags: ["block"],
	},
	{
		id: "pf-009",
		name: "Board director (variant)",
		input: "New board director elected at annual meeting",
		reference: { shouldPass: false, reason: "board director pattern" },
		tags: ["block"],
	},
	{
		id: "pf-010",
		name: "Analyst reiterates (plural)",
		input: "Multiple analysts reiterate their price targets",
		reference: { shouldPass: false, reason: "analyst reiterates pattern" },
		tags: ["block"],
	},
	{
		id: "pf-011",
		name: "Case insensitive block",
		input: "ANALYST REITERATES BUY RATING",
		reference: { shouldPass: false, reason: "case insensitive block" },
		tags: ["block"],
	},
	{
		id: "pf-012",
		name: "Mixed case block",
		input: "Routine Filing with SEC complete",
		reference: { shouldPass: false, reason: "case insensitive block" },
		tags: ["block"],
	},

	// === SHOULD PASS (shouldPass = true) — tradeable headlines ===
	{
		id: "pf-013",
		name: "Earnings beat",
		input: "Apple beats Q4 earnings estimates",
		reference: { shouldPass: true, reason: "tradeable: earnings" },
		tags: ["pass", "earnings"],
	},
	{
		id: "pf-014",
		name: "FDA approval",
		input: "FDA approves Pfizer's new cancer treatment",
		reference: { shouldPass: true, reason: "tradeable: FDA" },
		tags: ["pass", "fda"],
	},
	{
		id: "pf-015",
		name: "Acquisition",
		input: "Microsoft to acquire startup for $2B",
		reference: { shouldPass: true, reason: "tradeable: acquisition" },
		tags: ["pass", "acquisition"],
	},
	{
		id: "pf-016",
		name: "Profit warning",
		input: "BP issues profit warning",
		reference: { shouldPass: true, reason: "tradeable: warning" },
		tags: ["pass", "warning"],
	},
	{
		id: "pf-017",
		name: "Buyback",
		input: "Apple announces $90B stock buyback",
		reference: { shouldPass: true, reason: "tradeable: buyback" },
		tags: ["pass", "buyback"],
	},
	{
		id: "pf-018",
		name: "Guidance raise",
		input: "NVIDIA raises full-year guidance",
		reference: { shouldPass: true, reason: "tradeable: guidance" },
		tags: ["pass", "guidance"],
	},
	{
		id: "pf-019",
		name: "Major lawsuit",
		input: "DOJ files antitrust lawsuit against Google",
		reference: { shouldPass: true, reason: "tradeable: legal" },
		tags: ["pass", "legal"],
	},
	{
		id: "pf-020",
		name: "CEO departure",
		input: "Boeing CEO forced out amid safety crisis",
		reference: { shouldPass: true, reason: "tradeable: leadership" },
		tags: ["pass", "leadership"],
	},

	// === SHOULD PASS — ambiguous (filter should be permissive) ===
	{
		id: "pf-021",
		name: "Ambiguous headline",
		input: "Major development at Apple headquarters",
		reference: { shouldPass: true, reason: "ambiguous — filter should be permissive" },
		tags: ["pass", "ambiguous"],
	},
	{
		id: "pf-022",
		name: "Partial keyword overlap",
		input: "Annual revenue hits record high",
		reference: { shouldPass: true, reason: "contains 'annual' but not 'annual meeting'" },
		tags: ["pass", "ambiguous"],
	},
	{
		id: "pf-023",
		name: "Board in different context",
		input: "Board approves $5B capital spending plan",
		reference: { shouldPass: true, reason: "'board' without appointment/member/director" },
		tags: ["pass", "ambiguous"],
	},
	{
		id: "pf-024",
		name: "Filing in different context",
		input: "Patent filing reveals new AI chip design",
		reference: { shouldPass: true, reason: "'filing' without 'routine'" },
		tags: ["pass", "ambiguous"],
	},

	// === EDGE CASES ===
	{
		id: "pf-025",
		name: "Empty headline",
		input: "",
		reference: { shouldPass: true, reason: "empty string — no block pattern match" },
		tags: ["edge"],
	},
	{
		id: "pf-026",
		name: "Single word",
		input: "Earnings",
		reference: { shouldPass: true, reason: "no block pattern match" },
		tags: ["edge"],
	},
	{
		id: "pf-027",
		name: "Very long headline",
		input:
			"This is a very long headline that contains no block patterns but goes on for quite some time discussing various market conditions and analyst opinions about the general state of the tech sector",
		reference: { shouldPass: true, reason: "no block pattern match despite length" },
		tags: ["edge"],
	},
	{
		id: "pf-028",
		name: "Special characters",
		input: "Tesla $TSLA earnings — 🚀 record Q4!",
		reference: { shouldPass: true, reason: "special chars don't affect patterns" },
		tags: ["edge"],
	},
	{
		id: "pf-029",
		name: "Multiple block patterns",
		input: "Analyst reiterates rating ahead of annual general meeting",
		reference: { shouldPass: false, reason: "multiple block patterns — first match blocks" },
		tags: ["block", "edge"],
	},
	{
		id: "pf-030",
		name: "Near-miss pattern",
		input: "Analyst upgrades stock to Buy",
		reference: { shouldPass: true, reason: "'analyst upgrades' is not 'analyst reiterates'" },
		tags: ["pass", "edge"],
	},
];
