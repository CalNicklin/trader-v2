import { describe, expect, test } from "bun:test";
import { fetchYahooRssUk, parseYahooRssXml } from "../../src/news/yahoo-rss-uk.ts";

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rss version="2.0">
<channel>
<title>Yahoo! Finance: BP.L News</title>
<item>
<title>BP reports strong Q2 earnings</title>
<pubDate>Mon, 20 Apr 2026 14:00:00 +0000</pubDate>
<link>https://finance.yahoo.com/news/bp-q2-earnings-123</link>
<description>BP PLC reported record quarterly earnings today.</description>
</item>
<item>
<title>Oil prices surge on Iran tension</title>
<pubDate>Mon, 20 Apr 2026 10:00:00 +0000</pubDate>
<link>https://finance.yahoo.com/news/oil-surge-456</link>
<description>Brent crude broke $90 overnight.</description>
</item>
</channel>
</rss>`;

describe("parseYahooRssXml", () => {
	test("extracts title, pubDate, link, description per item", () => {
		const items = parseYahooRssXml(SAMPLE_RSS);
		expect(items.length).toBe(2);
		expect(items[0]?.title).toBe("BP reports strong Q2 earnings");
		expect(items[0]?.link).toBe("https://finance.yahoo.com/news/bp-q2-earnings-123");
		expect(items[0]?.pubDate).toBe("Mon, 20 Apr 2026 14:00:00 +0000");
		expect(items[1]?.description).toContain("Brent crude");
	});

	test("returns empty array on malformed XML", () => {
		expect(parseYahooRssXml("not xml")).toEqual([]);
	});

	test("handles CDATA-wrapped fields", () => {
		const xml = `<rss><channel><item>
<title><![CDATA[Foo & Bar]]></title>
<link>https://example.com/1</link>
<pubDate>Mon, 20 Apr 2026 14:00:00 +0000</pubDate>
</item></channel></rss>`;
		const items = parseYahooRssXml(xml);
		expect(items[0]?.title).toBe("Foo & Bar");
	});
});

describe("fetchYahooRssUk", () => {
	test("hits Yahoo RSS URL for .L symbol and returns parsed items", async () => {
		let seenUrl = "";
		const fetchStub = async (url: string) => {
			seenUrl = url;
			return { ok: true, status: 200, statusText: "OK", text: async () => SAMPLE_RSS };
		};
		const items = await fetchYahooRssUk("BP", "LSE", {
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(seenUrl).toContain("s=BP.L");
		expect(items.length).toBe(2);
	});

	test("appends .L for AIM exchange too (Yahoo uses .L for both LSE main + AIM)", async () => {
		let seenUrl = "";
		const fetchStub = async (url: string) => {
			seenUrl = url;
			return { ok: true, status: 200, statusText: "OK", text: async () => SAMPLE_RSS };
		};
		await fetchYahooRssUk("GAW", "AIM", { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(seenUrl).toContain("s=GAW.L");
	});

	test("returns empty array on HTTP failure", async () => {
		const fetchStub = async () => ({
			ok: false,
			status: 500,
			statusText: "Server Error",
			text: async () => "",
		});
		const items = await fetchYahooRssUk("BP", "LSE", {
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(items).toEqual([]);
	});
});
