import { describe, expect, test } from "bun:test";

describe("finnhub news client", () => {
	test("parseFinnhubArticle extracts required fields", async () => {
		const { parseFinnhubArticle } = await import("../../src/news/finnhub.ts");

		const raw = {
			category: "company",
			datetime: 1711987200,
			headline: "Apple Reports Q1 Earnings Beat",
			id: 12345,
			image: "https://example.com/image.jpg",
			related: "AAPL",
			source: "Reuters",
			summary: "Apple Inc reported better than expected...",
			url: "https://example.com/article",
		};

		const article = parseFinnhubArticle(raw);
		expect(article).not.toBeNull();
		expect(article!.headline).toBe("Apple Reports Q1 Earnings Beat");
		expect(article!.symbols).toEqual(["AAPL"]);
		expect(article!.url).toBe("https://example.com/article");
		expect(article!.source).toBe("finnhub");
		expect(article!.publishedAt).toBeInstanceOf(Date);
	});

	test("parseFinnhubArticle handles multiple related symbols", async () => {
		const { parseFinnhubArticle } = await import("../../src/news/finnhub.ts");

		const raw = {
			category: "company",
			datetime: 1711987200,
			headline: "Merger announced",
			id: 12346,
			image: "",
			related: "AAPL,MSFT,GOOG",
			source: "CNBC",
			summary: "",
			url: "https://example.com",
		};

		const article = parseFinnhubArticle(raw);
		expect(article!.symbols).toEqual(["AAPL", "MSFT", "GOOG"]);
	});

	test("parseFinnhubArticle returns null for missing headline", async () => {
		const { parseFinnhubArticle } = await import("../../src/news/finnhub.ts");

		const raw = { datetime: 1711987200, related: "AAPL" };
		expect(parseFinnhubArticle(raw)).toBeNull();
	});

	test("parseFinnhubArticle returns null for missing datetime", async () => {
		const { parseFinnhubArticle } = await import("../../src/news/finnhub.ts");

		const raw = { headline: "Some headline", related: "AAPL" };
		expect(parseFinnhubArticle(raw)).toBeNull();
	});

	test("buildFinnhubUrl constructs correct URL", async () => {
		const { buildFinnhubUrl } = await import("../../src/news/finnhub.ts");

		const url = buildFinnhubUrl("AAPL", "test-key");
		expect(url).toContain("finnhub.io");
		expect(url).toContain("symbol=AAPL");
		expect(url).toContain("token=test-key");
	});
});
