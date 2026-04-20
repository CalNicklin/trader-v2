# Data Provider Alternatives — Research Report

**Date:** 2026-04-20
**Trigger:** Issue #32 — FMP paywalled LSE/FTSE endpoints post-Aug-2025, blocking UK coverage in Step 2 Watchlist rollout.
**Status:** Recommendation below; user decision pending.

## TL;DR

**Recommended stack:** **IBKR (existing) + EODHD All-In-One (~$105/mo) + keep Finnhub + drop FMP.**

This directly closes the UK gap, adds capability (news sentiment, better corporate actions), and is cost-neutral-to-slightly-positive vs our current FMP+Finnhub bill. Ship in ~1 week. IBKR alone cannot replace FMP; no US-only provider (Polygon, Tiingo, Alpaca, Intrinio) solves the UK problem.

---

## Data requirements (audited from codebase)

| # | Requirement | Currently sourced from |
|---|---|---|
| A | Index constituents (Russell 1000, FTSE 350, AIM All-Share) | FMP `/russell-1000-constituent` (works); FMP `/symbol/FTSE` & `/symbol/AIM` (**BLOCKED**) |
| B | Profile/fundamentals (market cap, $ADV, free float, IPO date, spread, flags for halt/delisted/ETF/SPAC) | FMP `/profile/` (works for US; UK blocked) |
| C | Earnings calendar (next date within 5 trading days, EPS estimate) | FMP `/earning_calendar` + Finnhub `/calendar/earnings` |
| D | Live/delayed quotes (last/bid/ask/volume/avgVolume/%change) | FMP `/quote` (both markets) + IBKR delayed |
| E | Historical daily EOD bars, 5y | FMP `/historical-price-eod/full` |
| F | Per-symbol news | Finnhub `/company-news` (US), FMP `/news/stock` (UK — only known source) |
| G | Corporate actions (splits/dividends/halts/delistings) | Sparse — FMP fundamentals; no halt feed |
| H | Insider trades (SEC Form 4) — **wishlist**, deferred in spec | Not sourced |
| I | FX rates (GBP/USD) | FMP `/quote` for currency pairs |

---

## Provider coverage matrix

Verdict per requirement: ✅ covered / 🟡 partial / ❌ not covered.

| Provider | A | B | C | D | E | F | G | H | I | Monthly | UK? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Current FMP** | 🟡 US✅ UK❌ (paywall) | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | ❌ | ✅ | ~$30–50 | **blocked** |
| **IBKR (via @stoqey/ib)** | ❌ | 🟡 (no $ADV, spread, SPAC/lev flags) | 🟡 needs Wall St. Horizon $75/mo | ✅ | ✅ (pacing-bound) | 🟡 US only, no RNS | 🟡 no halt push | ❌ | ✅ | ~£3/mo UK feed | ✅ |
| **EODHD All-In-One** | 🟡 (FTSE 350/AIM via screener workaround) | ✅ (thin on AIM small-caps) | ✅ | ✅ | ✅ (25+ yrs incl. LSE) | ✅ (with sentiment) | ✅ | US only | ✅ | ~$105 | ✅ |
| **Polygon/Massive** | ❌ | 🟡 US only | ✅ US (Benzinga) | 🟡 US only | 🟡 US only | 🟡 US only | 🟡 US only, quality concerns | ❌ | ✅ (separate sub) | $250–$450 | **NO** |
| **Tiingo** | ❌ | 🟡 US+CN+ADR only | ❌ | 🟡 US IEX | ✅ US/Canada; LSE thin | ✅ | ✅ US | ❌ | ✅ | ~$10–50 | ~~weak~~ |
| **Alpaca Market Data** | ❌ | ❌ | ❌ | 🟡 US only | ✅ US 2016+ | ✅ US (Benzinga) | ✅ US | ❌ | ❌ | $0–$99 | **NO** |
| **Intrinio Starter** | 🟡 US indices only | ✅ US (Zacks) | ✅ US | ✅ US | ✅ US 1967+ | ✅ US (NewsEdge) | ✅ US | ✅ **best-in-class (2003+)** | ❌ | ~$150–$250 | **NO** |
| **Free sources** | 🟡 Wikipedia + iShares scrape | 🟡 Yahoo unofficial | 🟡 Investing.com scrape | 🟡 IBKR delayed | 🟡 yfinance | 🟡 Yahoo RSS + Investegate | 🟡 SEC EDGAR | ✅ **SEC EDGAR direct** | ✅ Frankfurter.dev | $0 | 🟡 patchy |

---

## Three recommended stacks

### Stack A — "Minimum viable, cheap, scrape-heavy"

IBKR (existing) + FMP (keep US only) + free sources for UK.

**Cost:** $0 incremental.
**What we add:** Wikipedia-scraped FTSE 350/AIM constituents, yahoo-finance2 Node lib for UK fundamentals, Investegate scrape for UK news, SEC EDGAR direct for US Form 4, Frankfurter.dev for FX.
**Pros:** Truly cost-neutral. Can deploy in 2–3 days.
**Cons:** Unofficial sources break without warning (yfinance breaks ~quarterly). BlackRock/iShares ToS is grey. LSE scraping is historically blocked. **UK news via Investegate has no contract** — can evaporate.

### Stack B — "Pro, unblocked" ⭐ **RECOMMENDED**

IBKR + EODHD All-In-One + Finnhub (US news) + drop FMP.

**Cost:** ~$105/mo for EODHD. Cancelling FMP saves $30–50/mo. Net: +$55–75/mo.
**What EODHD covers:** A (via screener), B, C, D, E, F (with sentiment), G, I — all for both US and UK including AIM.
**What IBKR still owns:** paper+live quotes during trading (more accurate than EODHD's 15-min delay), contract metadata, ISINs, halt detection (derivable from quote freeze).
**What Finnhub still owns:** lowest-latency US news.
**Pros:**
- Fixes UK gap completely
- Adds capability (EODHD has sentiment-scored news; FMP doesn't)
- Single vendor for most data = simpler wiring
- EODHD bundle includes insider (US), FX, screener, calendar — replaces 4–5 FMP endpoints in one migration
- 2-week parity audit feasible before cutover
**Cons:**
- $105/mo is real money
- EODHD fundamentals are "thin on AIM small-caps" — same limitation FMP had
- AIM lives under `LSE` exchange code (no segment filter) — need to maintain a side reference list of AIM tickers

### Stack C — "Deep, with insider wishlist ticked"

IBKR + EODHD + Intrinio Starter.

**Cost:** ~$105 + ~$200 = ~$305/mo.
**What this adds over Stack B:** US Form 4 insider data (history to 2003), richer US fundamentals (Zacks-sourced), better US news (NewsEdge live stream).
**When to pick this:** only if insider-flow becomes a load-bearing signal for strategies. Today it's spec-deferred; don't pre-pay for it.

---

## Why NOT other options

| Eliminated | Reason |
|---|---|
| Polygon.io / Massive.com | Zero UK equity coverage. Doesn't solve issue #32. |
| Tiingo | US/CN/ADR only. Thin LSE coverage despite marketing. |
| Alpaca Market Data | US only; "global stocks planned for 2026" but not shipped. |
| Free-only stack | Unofficial sources + ToS risk + no UK news contract = production fragility for a trading system. |
| FMP upgrade | Premium tier expensive; still rebuilds risk around FMP as a single point of failure. |

---

## IBKR specifics (answering your framing)

You asked whether IBKR could cover what we need. From the research:

**IBKR covers outright:** D (quotes, real-time or delayed), E (5y daily bars, pacing-bound), I (FX via `CASH GBP.USD @ IDEALPRO`).
**IBKR covers partially:** B (basic profile fields via `reqContractDetails`, fundamentals via deprecated `reqFundamentalData` with Reuters sub ~$1/mo), G (some corporate actions, no halt push), C (earnings only via Wall Street Horizon add-on ~$75/mo).
**IBKR does NOT cover:** A (no index-constituents feed — staff recommend scraping Wikipedia), H (no Form 4), F for UK (no RNS/LSE news provider on TWS).

So: IBKR displaces ~60–70% of FMP's role, not 100%. It needs a secondary provider for constituents, UK news, and (optionally) insider.

---

## Recommended action plan

1. **Subscribe to EODHD All-In-One** (~$105/mo) — start a trial if available.
2. **Week 1:** write `src/universe/sources/eodhd.ts` adapter — mirror `src/universe/sources.ts` shape, return `ConstituentRow[]` for Russell 1000 / FTSE 350 / AIM All-Share. Use the EODHD Index Constituents API (Russell) + bulk LSE + segment filter (FTSE/AIM).
3. **Week 2:** parity audit — run both FMP (US) and EODHD (US+UK) in parallel for 10 trading days. Compare constituent lists, market caps, earnings dates, news volumes. Grade each field "match / tolerable drift / bad". Criteria for cutover: ≥95% field-level parity on US + zero-crash on UK.
4. **Week 3:** cutover — swap `fmpFetch` callers to EODHD; retire `fmp.ts` paths for B/C/E/I; keep Finnhub for F(US); leave IBKR untouched.
5. **Followups (not this PR):** halt detection via IBKR quote-freeze inference (#21); wishlist H (insider) via Stack C upgrade or SEC EDGAR direct scraping.

## Risks

- **EODHD AIM coverage may still be thin** for long-tail names. Fallback plan: keep FMP UK endpoints cached for now (even though they're paywalled — last-known-good values may still help) OR add yfinance as secondary.
- **EODHD rate limits:** 100k calls/day, 1k/min on All-In-One. News (5+5×tickers) and bulk exchange (100 calls/req) burn fast. Budget carefully in scheduler.
- **Bulk migration risk:** don't delete FMP code until parity audit passes. Keep feature flags.

## Open questions for user

1. Confirm budget tolerance for $105/mo EODHD — OK?
2. Do we want to explore Intrinio now (~+$200/mo) or defer until insider signals prove load-bearing?
3. Any preference between EODHD monthly vs annual (annual saves ~17%)?

---

## Source agent transcripts

All 5 research agents ran in parallel against the same data-needs spec. Cached outputs:
- IBKR audit (capability + gotchas + licensing costs)
- Polygon.io (rebranded to Massive.com 2025-10-30)
- EODHD (best UK fit)
- Tiingo / Alpaca / Intrinio (all US-only; Intrinio strongest for insider)
- Free/unconventional (Wikipedia, iShares, SEC EDGAR, Frankfurter)
