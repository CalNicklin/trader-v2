// src/news/uk-feed-config.ts

export interface UkRssFeed {
	name: string;
	url: string;
}

export const UK_FEEDS: readonly UkRssFeed[] = [
	// Existing feeds
	{ name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
	{ name: "Yahoo Finance UK", url: "https://uk.finance.yahoo.com/rss/topstories" },
	{
		name: "Yahoo Finance FTSE",
		url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^FTSE&region=UK&lang=en-GB",
	},
	{ name: "Proactive Investors UK", url: "https://www.proactiveinvestors.co.uk/rss/all_news" },
	{ name: "Investing.com UK", url: "https://www.investing.com/rss/news_301.rss" },

	// New additions — any URL that 404s on first fetch is logged and skipped
	{ name: "Sharecast", url: "https://www.sharecast.com/rss/news" },
	{ name: "London South East", url: "https://www.lse.co.uk/rss/MarketNews" },
	{
		name: "Proactive Investors AIM",
		url: "https://www.proactiveinvestors.co.uk/rss/all_news/aim",
	},
	{ name: "Reuters UK Business", url: "https://feeds.reuters.com/reuters/UKBusinessNews" },
	{ name: "Citywire", url: "https://citywire.com/funds-insider/rss" },
];
