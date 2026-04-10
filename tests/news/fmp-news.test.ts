import { describe, expect, test } from "bun:test";
import {
	fetchFmpCompanyNews,
	_test_parseFmpArticle as parseFmpArticle,
} from "../../src/news/fmp-news.ts";

describe("parseFmpArticle", () => {
	const validRaw = {
		symbol: "SHEL",
		publishedDate: "2026-04-08 03:46:00",
		publisher: "Reuters",
		title: "Shell raises dividend",
		url: "https://example.com/shell-dividend",
		site: "reuters.com",
		text: "Shell plc announced...",
	};

	test("parses a valid FMP payload into a NewsArticle", () => {
		const article = parseFmpArticle(validRaw);
		expect(article).not.toBeNull();
		expect(article?.headline).toBe("Shell raises dividend");
		expect(article?.url).toBe("https://example.com/shell-dividend");
		expect(article?.source).toBe("reuters.com");
		expect(article?.symbols).toEqual(["SHEL"]);
		expect(article?.finnhubId).toBeNull();
	});

	test("parses publishedDate as UTC", () => {
		const article = parseFmpArticle(validRaw);
		expect(article?.publishedAt.toISOString()).toBe("2026-04-08T03:46:00.000Z");
	});

	test("returns null when title is missing", () => {
		const article = parseFmpArticle({ ...validRaw, title: "" });
		expect(article).toBeNull();
	});

	test("returns null when url is missing", () => {
		const article = parseFmpArticle({ ...validRaw, url: "" });
		expect(article).toBeNull();
	});

	test("returns null when publishedDate is missing", () => {
		const article = parseFmpArticle({ ...validRaw, publishedDate: "" });
		expect(article).toBeNull();
	});

	test("returns null when publishedDate is malformed", () => {
		const article = parseFmpArticle({ ...validRaw, publishedDate: "not-a-date" });
		expect(article).toBeNull();
	});

	test("prefers site over publisher for source", () => {
		const article = parseFmpArticle({ ...validRaw, site: "reuters.com", publisher: "Reuters Inc" });
		expect(article?.source).toBe("reuters.com");
	});

	test("falls back to publisher when site is missing", () => {
		const { site, ...rawNoSite } = validRaw;
		const article = parseFmpArticle(rawNoSite as typeof validRaw);
		expect(article?.source).toBe("Reuters");
	});

	test("falls back to 'fmp' when neither site nor publisher is present", () => {
		const { site, publisher, ...rawBare } = validRaw;
		const article = parseFmpArticle({ ...rawBare, publisher: "" } as typeof validRaw);
		expect(article?.source).toBe("fmp");
	});
});

describe("fetchFmpCompanyNews", () => {
	test("rewrites LSE symbol to .L form before fetching", async () => {
		const calls: Array<{ path: string; params: Record<string, string> }> = [];
		await fetchFmpCompanyNews("SHEL", "LSE", {
			fmpFetch: async (path: string, params: Record<string, string>) => {
				calls.push({ path, params });
				// Return a non-empty result so the dual-listing fallback does not fire
				return [
					{
						symbol: "SHEL",
						publishedDate: "2026-04-08 03:46:00",
						publisher: "Reuters",
						title: "Shell news",
						url: "https://example.com/shel",
					},
				];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/news/stock");
		expect(calls[0]?.params.symbols).toBe("SHEL.L");
		expect(calls[0]?.params.limit).toBe("20");
	});

	test("returns [] when fmpFetch returns non-array", async () => {
		const result = await fetchFmpCompanyNews("SHEL", "LSE", {
			fmpFetch: async () => null,
			toFmpSymbol: (sym: string) => sym,
		});
		expect(result).toEqual([]);
	});

	test("returns [] when fmpFetch throws", async () => {
		const result = await fetchFmpCompanyNews("SHEL", "LSE", {
			fmpFetch: async () => {
				throw new Error("boom");
			},
			toFmpSymbol: (sym: string) => sym,
		});
		expect(result).toEqual([]);
	});

	test("overrides article.symbols to the queried symbol", async () => {
		const result = await fetchFmpCompanyNews("SHEL", "LSE", {
			fmpFetch: async () => [
				{
					symbol: "WRONG",
					publishedDate: "2026-04-08 03:46:00",
					publisher: "Reuters",
					title: "Shell raises dividend",
					url: "https://example.com/a",
				},
			],
			toFmpSymbol: (sym: string) => sym,
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.symbols).toEqual(["SHEL"]);
	});

	test("skips articles that fail to parse", async () => {
		const result = await fetchFmpCompanyNews("SHEL", "LSE", {
			fmpFetch: async () => [
				{ symbol: "SHEL", publishedDate: "", publisher: "X", title: "Valid", url: "https://a" },
				{
					symbol: "SHEL",
					publishedDate: "2026-04-08 03:46:00",
					publisher: "X",
					title: "OK",
					url: "https://b",
				},
			],
			toFmpSymbol: (sym: string) => sym,
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.headline).toBe("OK");
	});

	test("falls back to plain symbol when .L returns empty (dual-listing)", async () => {
		const calls: string[] = [];
		const result = await fetchFmpCompanyNews("BP", "LSE", {
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				calls.push(params.symbols as string);
				if (params.symbols === "BP.L") return [];
				if (params.symbols === "BP") {
					return [
						{
							symbol: "BP",
							publishedDate: "2026-04-08 03:46:00",
							publisher: "Reuters",
							title: "BP Q1 earnings beat",
							url: "https://example.com/bp",
						},
					];
				}
				return [];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		});
		expect(calls).toEqual(["BP.L", "BP"]);
		expect(result).toHaveLength(1);
		expect(result[0]?.headline).toBe("BP Q1 earnings beat");
		// Attribution preserved to original queried symbol
		expect(result[0]?.symbols).toEqual(["BP"]);
	});

	test("does NOT fall back when .L returns non-empty", async () => {
		const calls: string[] = [];
		const result = await fetchFmpCompanyNews("SHEL", "LSE", {
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				calls.push(params.symbols as string);
				return [
					{
						symbol: "SHEL",
						publishedDate: "2026-04-08 03:46:00",
						publisher: "Reuters",
						title: "Shell news",
						url: "https://example.com/shel",
					},
				];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		});
		expect(calls).toEqual(["SHEL.L"]); // only one call — no fallback
		expect(result).toHaveLength(1);
	});

	test("strips trailing dot from symbol before building .L ticker", async () => {
		const calls: string[] = [];
		await fetchFmpCompanyNews("BP.", "LSE", {
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				calls.push(params.symbols as string);
				return [];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		});
		// Production universe stores "BP." (with trailing dot) — must normalise
		// to "BP" before toFmpSymbol, not produce "BP..L".
		expect(calls).toEqual(["BP.L", "BP"]); // primary + fallback, no "BP..L"
	});

	test("does not fall back for US exchanges", async () => {
		const calls: string[] = [];
		await fetchFmpCompanyNews("AAPL", "NASDAQ", {
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				calls.push(params.symbols as string);
				return [];
			},
			toFmpSymbol: (sym: string) => sym,
		});
		expect(calls).toEqual(["AAPL"]); // no fallback for NASDAQ
	});
});
