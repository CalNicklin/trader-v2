# SmallCap Alerts — Design Spec

## Overview

A paid Telegram alert service that surfaces classified UK/AIM and US small-cap news to retail traders in real time. The system already classifies news via Haiku and stores results in the `news_events` table — this product packages that internal signal as an external product.

**Product name:** SmallCap Signals (or similar — AIM Alerts, SmallCap Watch)

**Value proposition:** "We read every RNS filing so you don't have to." AI-classified market news, scored by sentiment, urgency, and confidence, delivered to Telegram before most retail traders have opened their broker app.

## Product Structure

### Free Tier (Telegram Channel)
- Public Telegram channel, anyone can join
- Alerts delayed by 15 minutes from classification time
- Maximum 5 alerts per day (highest-urgency only)
- Each alert shows: stock symbol, headline, sentiment (bullish/bearish/neutral), urgency (medium/high), event type
- Weekly summary post: "This week's top signals and how they moved"
- Purpose: funnel for paid tier, social proof, Reddit seeding content

### Paid Tier (Telegram Group — £7/month)
- Private Telegram group, access gated by active Stripe subscription
- Instant alerts — sent within seconds of classification
- All classified alerts (no daily cap), filtered to tradeable + confidence ≥ 0.6
- Richer alert format: includes confidence score, catalyst type, expected move duration, earnings surprise / guidance change scores where relevant
- Access to pinned daily digest message (morning summary of overnight US news + upcoming UK catalysts)

### Pricing Rationale
£7/month hits the sweet spot: low enough for impulse signup from a Reddit post, high enough that 100 subscribers = £700/month recurring. Lower than the Strategist's £29 (which targets serious traders we don't have yet) but higher than £5 (which signals low value).

## Architecture

### Data Flow

```
Existing pipeline:
  Finnhub/RSS → pre-filter → Haiku classifier → news_events table
                                                       │
New layer:                                             ▼
  Alert dispatcher (new scheduler job, runs every 2 min)
       │
       ├─ Free channel: delayed queue, top 5/day by urgency
       └─ Paid group: immediate send, all tradeable + confidence ≥ 0.6
```

### New Components

1. **`src/alerts/telegram.ts`** — Telegram Bot API client. Sends formatted messages to channels/groups. Handles rate limiting (Telegram allows 30 messages/sec to channels).

2. **`src/alerts/dispatcher.ts`** — Polls `news_events` for undelivered classified events. Decides which tier(s) get each alert. Manages the 15-minute delay queue for free tier. Tracks the 5/day cap. Marks events as dispatched.

3. **`src/alerts/formatter.ts`** — Formats a `news_events` row into a Telegram message. Free tier gets a short format, paid tier gets the full format with all signal scores.

4. **`src/alerts/subscription.ts`** — Manages subscriber state. Maps Telegram user IDs to Stripe subscription status. Handles adding/removing users from the paid group when subscriptions start/cancel.

5. **`src/alerts/stripe-webhook.ts`** — Handles Stripe webhook events (subscription created, cancelled, payment failed). Registered as a route on the existing HTTP server in `src/monitoring/server.ts`.

6. **Landing page** — Simple static HTML page served from the existing HTTP server at a new route (e.g., `/alerts`). Shows the product, links to free channel, and has a Stripe Checkout button for paid tier. No framework — just an HTML string like the existing dashboard in `status-page.ts`.

### Database Changes

New table: `alert_subscribers`
```
id: integer PK
telegramUserId: text (Telegram user ID)
telegramUsername: text (for display)
stripeCustomerId: text (nullable — free users don't have one)
stripeSubscriptionId: text (nullable)
tier: text ("free" | "paid")
status: text ("active" | "cancelled" | "past_due")
createdAt: text (ISO timestamp)
updatedAt: text (ISO timestamp)
```

New column on `news_events`: `alertDispatchedAt` (text, nullable) — tracks whether an event has been sent to Telegram. Prevents duplicate alerts on restart.

### Config Additions

Add to `src/config.ts` Zod schema:
- `TELEGRAM_BOT_TOKEN` — from BotFather
- `TELEGRAM_FREE_CHANNEL_ID` — the public channel chat ID
- `TELEGRAM_PAID_GROUP_ID` — the private group chat ID
- `STRIPE_SECRET_KEY` — for subscription management
- `STRIPE_WEBHOOK_SECRET` — for webhook signature verification
- `STRIPE_PRICE_ID` — the £7/month price object ID
- `ALERTS_MIN_CONFIDENCE` — minimum confidence to alert (default 0.6)
- `ALERTS_FREE_DAILY_CAP` — max free alerts per day (default 5)
- `ALERTS_FREE_DELAY_MINUTES` — delay for free tier (default 15)

### Scheduler Integration

New job: `alert_dispatch` — runs every 2 minutes during market hours (same window as news_poll: 8-20 Mon-Fri UK time). Queries `news_events` where `classifiedAt IS NOT NULL AND tradeable = 1 AND alertDispatchedAt IS NULL`, dispatches to appropriate tiers, marks as dispatched.

Additionally, a daily job `alert_daily_digest` at 07:00 UK time — compiles overnight US news and upcoming UK catalysts into a pinned message for the paid group.

### Stripe Integration

**Signup flow:**
1. User visits landing page at `https://<VPS_HOST>:<PORT>/alerts`
2. Clicks "Subscribe" → redirected to Stripe Checkout (hosted by Stripe, no PCI compliance needed)
3. Stripe Checkout collects payment, redirects to success page
4. Success page shows: "Send /start to @SmallCapSignalsBot on Telegram to activate"
5. User messages the bot → bot checks Stripe customer email against checkout session → adds user to paid group

**Cancellation flow:**
1. Stripe sends `customer.subscription.deleted` webhook
2. Webhook handler updates `alert_subscribers.status = "cancelled"`
3. Bot removes user from paid group

**Linking Stripe to Telegram identity:**
1. Landing page has a field: "Enter your Telegram username" before the Subscribe button
2. Stripe Checkout session is created with `client_reference_id` = Telegram username
3. On successful payment, the webhook stores the username + Stripe customer ID in `alert_subscribers`
4. When the user messages the bot with `/start`, the bot looks up their Telegram username in `alert_subscribers` — if found with `tier: "paid"`, adds them to the group

This avoids requiring the user to copy-paste tokens or IDs. If the username doesn't match (typo, changed username), the bot responds with a support message.

**Why Stripe Checkout (not custom form):** Zero PCI compliance burden, handles SCA/3DS automatically, Cal doesn't touch card details.

### FCA Compliance

This product is a **news classification and alerting service**, not financial advice. To stay on the right side of UK regulation:

- Alerts never say "buy" or "sell" — they report classified news with sentiment scores
- Landing page includes disclaimer: "This is an automated news classification service. It does not constitute financial advice. Always do your own research."
- No performance claims ("our signals beat the market")
- No specific trade recommendations (entry price, stop loss, position size)
- The product is functionally equivalent to a faster, smarter RSS reader — not an advisory service

## Cal's Manual Work

### One-time setup (~2 hours)
- Create Telegram bot via BotFather
- Create public channel + private group on Telegram
- Create Stripe account, set up £7/month product/price
- Set env vars on VPS

### Initial seeding (~30 min/day for 2-4 weeks)
- Post daily in r/UKInvesting, r/stocks, r/pennystocks with examples: "Our AI flagged this AIM stock 4 minutes before the 8% spike — free alerts channel link"
- Share in UK trading Discord servers, Stock Market Chat
- Post the weekly summary thread on Reddit (auto-generated by the system, Cal just shares the link)

### Ongoing (~15 min/week)
- Review weekly subscriber metrics (auto-emailed by the system)
- Approve self-improvement PRs as usual
- Occasionally share a good call on social media

## Success Metrics

- **Classifier quality:** % of high-urgency alerts followed by >2% price move within expected duration
- **Subscriber growth:** free channel members, paid conversion rate
- **Revenue:** MRR, churn rate
- **System health:** alert latency (classification → Telegram delivery), uptime

The eval harness should track classifier quality against actual price moves. This feeds back into the self-improvement cycle — if classification accuracy drops, the system can propose prompt improvements.

## What This Is NOT

- Not a trading bot — it doesn't execute trades
- Not financial advice — it classifies news
- Not a content site — no SEO play (YAGNI, add later if needed)
- Not a newsletter — no email, just Telegram (YAGNI)
- Not an API product — no external API (YAGNI, add later)

## Revenue Trajectory (Conservative)

| Month | Free Members | Paid Subs | MRR |
|-------|-------------|-----------|-----|
| 1 | 50-100 | 5-10 | £35-70 |
| 3 | 200-500 | 20-40 | £140-280 |
| 6 | 500-1000 | 50-100 | £350-700 |
| 12 | 1000-3000 | 100-300 | £700-2100 |

These are conservative — the Strategist's numbers were higher but assumed aggressive growth. This assumes steady Reddit seeding for month 1, then organic growth via referrals and the free channel acting as a funnel.
