# Vision: Self-Directed Research & Engineering Agent

**Status:** Parked — return to this after implementing the hybrid architecture improvements.

## The Idea

Replace the current structured trading bot with a self-directed Claude instance that has full creative agency over the project. Its sole instruction: "maximise profits, you will be rewarded."

Claude would not just optimise within the existing system — it would expand the system's capability surface. Examples:

- Notices a gap in its data pipeline (no social media feed) and builds a Twitter/X scraper to trade off 3am rage tweets from public figures
- Reads about pairs trading and implements a cointegration detector as a new strategy type
- Discovers that SEC Form 4 insider purchase filings have alpha and adds a new data pipeline
- Realizes its news classifier is missing a category (geopolitical risk) and adds it
- Studies market microstructure and builds a liquidity model for AIM stocks with thin order books
- Decides it needs options data and proposes adding an options pricing pipeline
- Upskills itself in quantitative finance by reading docs and papers, then applies what it learns

## Key Constraint

All changes go through PRs. Human reviews and merges. If Claude needs new API keys or infrastructure, it raises a proposal (GitHub issue). This means:

- Claude can propose anything — removing circuit breakers, risky strategies, new infrastructure
- The human is the safety gate, not hidden code
- Claude's job is to propose changes so valuable the human wants to merge them
- Claude learns from which PRs get merged vs rejected

## Open Design Questions

- Activation model: daily deep-work sessions for research/build + shorter trading-hours activations for execution? Or something else?
- How does Claude decide what to work on each session? (research vs build vs trade)
- How does it track its own hypotheses, experiments, and research backlog?
- How does it prioritise PRs to avoid overwhelming the human reviewer?
- Architecture: API agent on cron? Claude Code running on the server? Claude Code with triggers/scheduling?
- How does it learn from merged vs rejected PRs to calibrate its proposals?
- How does it evaluate whether a new capability (e.g., Twitter feed) is actually generating alpha?
- Cost model: longer sessions with Opus/Sonnet for research, cheaper models for routine execution?

## Relationship to Current Work

The debate at `docs/debates/2026-04-06-full-autonomy-vs-structured.md` converged on a hybrid architecture that improves the current system. Those improvements (expanded evolution, daily tournaments, regime detection, dispatch layer) are prerequisites — they make the system capable enough that a research agent has meaningful levers to pull.

Build the hybrid improvements first, then come back to this vision.
