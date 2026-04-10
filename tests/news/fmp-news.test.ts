import { describe, expect, test } from "bun:test";
import { _test_parseFmpArticle as parseFmpArticle } from "../../src/news/fmp-news.ts";

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
