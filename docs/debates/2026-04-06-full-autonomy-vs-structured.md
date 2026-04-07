# Debate: Full Claude Autonomy vs Structured Trading System

**Question:** Should trader-v2 be replaced by a single Claude instance with full control over the codebase, activating a few times daily with the sole instruction "generate as much profit as possible"?

**Format:** Adversarial conversation between two agents. Multiple rounds until convergence or irreconcilable disagreement.

---

## Round 1

### Advocate (For Full Autonomy)

The current trader-v2 system is an impressive piece of engineering. It is also, fundamentally, a box -- and the thing inside the box is not the thing that should be making trading decisions. Let me explain why replacing it with a fully autonomous Claude instance would be strictly superior across every dimension that matters.

**1. The current system is leaving money on the table because it cannot reason about context.**

Trader-v2 evaluates signals on a 5-15 minute schedule using pre-defined expressions. These expressions are static between weekly evolution cycles. Consider what happens when a UK stock gaps up 4% on an earnings beat at 8:02am. The news pipeline catches it: Haiku classifies it, generates a sentiment score. But the signal expression for the earnings-surprise strategy has a fixed `surprise_threshold` of, say, 0.6 and a fixed `exit_target_pct` of 3%. It cannot reason about *this specific* earnings beat -- was it a revenue surprise or a margin surprise? Did guidance change? Is the stock trading into resistance from a prior high? A Claude instance reading the same Finnhub data plus the price chart would synthesise all of this in seconds and make a qualitatively different decision: perhaps sizing up because the beat was on revenue (more durable), or passing entirely because the stock already ran 8% in pre-market and the risk/reward has collapsed. Mechanical rules cannot do this. They treat every earnings surprise identically.

The same applies to exits. The system uses fixed `hold_days` and `stop_loss_pct` parameters. But optimal exit timing depends on context that changes *during* the trade: sector rotation, correlated names moving, volume profile shifting. An LLM evaluating the position at each activation would adapt its exit plan to current conditions rather than executing a parameter set frozen at entry time.

**2. Weekly evolution is far too slow and far too constrained.**

The evolution system asks Sonnet to propose parameter mutations once per week, validated against `PARAMETER_RANGES` that clamp `stop_loss_pct` between 1-10%, `hold_bars` between 1-20, and so on. This is optimising 5-11 continuous parameters within hard bounds on a weekly cadence. The search space is tiny and the iteration speed is glacial. Markets shift regime on a daily basis -- volatility compression, sector rotation, momentum factor crashes. A strategy that was well-calibrated on Monday can be poorly calibrated by Wednesday. The system has no mechanism to respond to this except waiting for the next weekly tournament.

Worse, the evolution can only mutate *parameters*. It cannot change the fundamental structure of a strategy -- it cannot decide that RSI is the wrong indicator entirely and switch to VWAP deviation, or that a mean-reversion approach should temporarily become a momentum approach because the market regime changed. A fully autonomous Claude could do exactly this: observe that breakout strategies are getting chopped up in a range-bound market, and shift the entire approach within hours.

**3. The meta-problem: you cannot optimise outside the box from inside the box.**

The current system has a fixed architecture: three seed strategies, mechanical evaluation, weekly mutation, graduation gate. Every component was designed by a human who made assumptions about what would work. The self-improvement mechanism (Phase 9) can propose code changes, but only to whitelisted files, and every change requires human review. This means the system's rate of structural improvement is bottlenecked by human attention -- exactly the resource the system was designed to minimise.

A fully autonomous Claude instance would not have this constraint. If the entire signal-expression paradigm is underperforming, it could replace it with a different approach entirely. If the 5-minute evaluation cycle is too slow for certain setups, it could implement event-driven execution. If the three-strategy population is too small for meaningful tournament selection, it could expand it. The system could rewrite its own architecture in response to what the market is actually doing, rather than what a human guessed the market would do when writing the spec in April 2026.

**4. At GBP 200-500, conservatism is the biggest risk.**

This is perhaps the most important point. The current system's guardrails -- 1% risk per trade, max 3 concurrent positions, Sharpe > 0.5 graduation gate -- are designed to preserve capital. But at GBP 200-500, capital preservation is not the primary goal. A 1% risk limit means risking GBP 2-5 per trade. After spread costs on LSE stocks (which are wide for small-caps), the expected profit per trade is measured in *pence*. The system needs roughly 30 profitable trades just to cover one month of VPS hosting.

The graduation gate requires 30+ trades with a Sharpe above 0.5 and profit factor above 1.3 before going live. Given the small position sizes and conservative parameters, this could take months of paper trading -- during which the system generates zero revenue while consuming GBP 10-15/month in hosting and $7-9/month in API costs. The current architecture may never reach profitability simply because its guardrails prevent it from taking positions large enough to overcome fixed costs.

A fully autonomous Claude could make a rational decision to risk 5-10% per trade at this capital level, because the Kelly criterion for a system with genuine edge supports it, and because the absolute downside (losing GBP 50) is trivial compared to the ongoing operational costs of running a system too conservative to profit.

**5. What full control actually enables.**

Concretely, an autonomous Claude would: trade across multiple timeframes simultaneously rather than being locked to 5-minute bars; synthesise news, price action, volume, and cross-asset signals into a single coherent thesis rather than evaluating each through isolated signal expressions; adapt position sizing dynamically based on conviction and current portfolio heat; exit trades based on evolving market conditions rather than fixed parameters; allocate more API budget to high-conviction research rather than spreading it evenly across routine classification; and most importantly, learn from each trade immediately rather than waiting for the weekly learning loop to process closed positions.

The risks are real -- an unconstrained system could blow up the account, could spend excessive API budget on reasoning loops, could make correlated bets that amplify drawdowns. But at GBP 200-500, the maximum loss from a full blowup is less than three months of operational costs for the current system. The expected value calculation favours autonomy: a small probability of finding genuine edge and compounding it rapidly, versus the near-certainty of the current system slowly bleeding out through fixed costs while it cautiously paper-trades its way toward a graduation gate it may never reach.

### Skeptic (For Structured System)

The Advocate makes several points I genuinely agree with. But the proposed solution -- replace everything with "generate as much profit as possible" -- is not an upgrade. It is a category error that confuses *flexibility* with *capability* and *constraints* with *limitations*. Let me take each argument in turn.

**1. On contextual reasoning: valid problem, wrong solution.**

Yes, the current signal expressions treat every earnings surprise identically. That is a real weakness. But the Advocate's alternative -- Claude reading Finnhub data and "synthesising" a thesis in real time -- assumes LLM reasoning about financial data is reliable. It is not. Claude has no ground truth about whether a revenue surprise is "more durable" than a margin surprise for a specific AIM stock. It will produce confident-sounding analysis that is, at best, a sophisticated restatement of priors from its training data, and at worst a hallucination dressed up as fundamental analysis. The current Haiku classifier at least has eval suites measuring its accuracy on sentiment and tradeability. An autonomous Claude making bespoke trade theses has no such validation -- every decision is a novel, untestable inference. The correct fix is richer signal expressions and faster evolution, not replacing auditable rules with opaque reasoning.

**2. On evolution speed: right diagnosis, fixable within the current architecture.**

Weekly evolution is indeed too slow. The Advocate is correct that markets shift regime faster than the tournament cycle can adapt. But the answer is to *accelerate the evolution loop*, not to abolish it. Move tournaments from weekly to daily. Add regime-detection signals (ATR percentile, breadth, correlation clustering) that let strategies self-select based on market conditions. Allow the evolution to propose structural changes -- swapping indicator families, not just mutating parameters -- within the existing tournament-and-graduation framework. All of this preserves the critical property that changes are validated against historical performance before being deployed, rather than trusting a single LLM inference to restructure the entire approach mid-session.

**3. On the meta-problem: the box exists for a reason.**

The Advocate frames the whitelisted self-improvement and human review as bottlenecks. They are guardrails. The self-improvement system in Phase 9 can already propose code changes to signal expressions, strategy parameters, and evaluation logic. The human review step exists because an LLM modifying its own trading code without oversight is precisely how you get reward hacking. Consider what "optimise outside the box" actually means in practice: Claude decides the graduation gate is too strict and lowers the thresholds. Claude decides 1% risk per trade is suboptimal and raises it to 10%. Claude decides stop losses are reducing returns and removes them. Every one of these changes is locally rational from the perspective of "generate more profit" and globally catastrophic. The box is not a bug. The box is the entire point.

**4. On capital constraints: the most seductive and most dangerous argument.**

The Advocate is right that 1% risk on GBP 300 is GBP 3 per trade, which struggles against spread costs. This is a genuine structural problem. But the proposed solution -- let Claude risk 5-10% per trade -- is not Kelly criterion reasoning, it is rationalised gambling. Kelly requires an accurate estimate of edge probability, which neither the current system nor an autonomous Claude possesses. The current system is *designed to discover its edge* through paper trading before risking real capital. The Advocate wants to skip this discovery phase and go straight to concentrated live bets based on LLM conviction. The actual fix is to increase position sizing within the structured framework once the graduation gate confirms a real edge exists, or to raise the initial capital to a level where 1-2% risk is meaningful. Removing guardrails because the stakes are small is how small stakes become zero stakes.

**5. On "full control": the accountability gap is fatal.**

The Advocate lists capabilities: multi-timeframe analysis, dynamic sizing, immediate learning. These sound powerful in the abstract. Now consider the debugging scenario. The autonomous Claude takes three correlated positions in AIM small-caps based on a "sector momentum thesis." All three gap down on the same morning. What went wrong? With the current system, you can trace every decision: which signal expression triggered, what parameter values were active, what the news classifier scored, what the evolution tournament selected. Every step is logged, reproducible, and auditable. With the autonomous system, you have a reasoning trace -- a natural language narrative that Claude generated to justify its decisions, which is neither reproducible (run the same prompt twice, get different reasoning) nor verifiable (Claude's stated reasoning may not reflect its actual token-level computation). You cannot backtest an LLM's free-form reasoning. You cannot run a tournament across its decisions. You have replaced a debuggable system with a persuasive narrator.

**6. The losing streak scenario exposes everything.**

The Advocate's expected-value argument assumes the autonomous system degrades gracefully. It will not. When the structured system hits a losing streak, the circuit breakers activate mechanically: 3% daily drawdown halts trading, 10% total drawdown kills the session. These limits are in code that the trading loop cannot modify. When an autonomous Claude hits a losing streak, what happens? It has "full control." It can reason that the losses are temporary, that the edge is still valid, that sizing up will recover the drawdown faster. This is not a hypothetical failure mode -- it is the *default* failure mode of any agent optimising "generate profit" against a P&L that is currently negative. Every human trader who has blown up an account followed exactly this reasoning. The difference is that the current system has a mechanical override that prevents it. The proposed system has nothing but Claude's judgement, which is the same judgement that took the losing trades in the first place.

**7. The real expected value calculation.**

The Advocate frames this as "small chance of compounding edge vs certain bleed from fixed costs." But the denominator is wrong. The current system's fixed costs are GBP 20-24/month. The autonomous system's costs would be *higher* -- Sonnet-level reasoning multiple times daily for trade decisions, position management, and self-modification is not $7-9/month. It is $50-100/month at minimum, possibly much more if reasoning loops spin up during volatile sessions. So the real comparison is: a structured system at GBP 24/month that methodically discovers whether an edge exists, versus an autonomous system at GBP 60-80/month that confidently trades on LLM-generated conviction with no validation framework, no reproducible evaluation, and no mechanical risk limits.

I would rather have a slow system that knows when it does not know, than a fast system that is incapable of knowing what it does not know.

## Round 2

### Advocate

The Skeptic landed several hits. Let me be direct about which ones.

**Where you are right.**

The accountability gap argument (point 5) is the strongest thing either of us has said in this debate. You cannot backtest free-form LLM reasoning. You cannot reproduce it. A system where every losing trade produces a plausible-sounding narrative but no falsifiable signal is genuinely worse than a system with auditable rules, even if those rules are crude. I concede this fully.

The losing streak scenario (point 6) is also correct as stated. An agent optimising "generate profit" with full control over its own risk parameters will, under drawdown pressure, rationalise increasing risk. This is not a maybe -- it is the dominant failure mode. I was wrong to dismiss mechanical circuit breakers as mere conservatism. They are the only part of the system that is immune to motivated reasoning.

The cost argument (point 7) is partially right. Sonnet-level reasoning for every trade decision would blow the API budget. I underestimated this.

**Where you are wrong or strawmanning.**

You are treating "full autonomy" as "no guardrails." That was never my position, and re-reading my Round 1, I can see why you inferred it -- I was imprecise. Let me be explicit: I am not proposing Claude with root access to the codebase and the instruction "make money." I am proposing Claude as the *decision-making layer* within hard limits it cannot modify.

Your point about hallucinated fundamental analysis (point 1) mischaracterises what LLM reasoning does well. I am not asking Claude to determine whether a revenue surprise is more durable than a margin surprise from first principles. I am asking it to do what the current Haiku classifier already does -- interpret news semantics -- but with more context and at the trade-decision level rather than as an isolated upstream signal. The current system already trusts LLM judgement for classification. The question is where in the pipeline that judgement gets applied, not whether it gets applied at all.

Your fix for evolution speed (point 2) -- daily tournaments, regime detection, structural mutations within the framework -- is essentially what I am proposing, except you want to keep the tournament validation layer. This is actually where we should focus, because I think we are closer than it appears.

**My refined position: the hybrid.**

I am moving toward a specific architecture. Here is what it looks like:

1. **Hard limits in code that Claude cannot modify.** Maximum 5% account risk per day. Maximum 2% per position. Maximum $15/day API spend. 10% total drawdown kills trading for the week. These live in a config file outside the LLM's write scope. Non-negotiable.

2. **Claude as strategy designer, not just parameter mutator.** Instead of weekly evolution mutating 5-11 parameters, Claude proposes complete strategy logic -- indicator selection, entry/exit conditions, sizing rules -- validated against the last 30 days of data before deployment. Daily cadence, not weekly. The tournament framework stays, but the search space expands from parameter tuning to structural design.

3. **Claude as trade executor with structured output.** At each activation, Claude evaluates open positions and pending signals, but must output a structured JSON decision (action, symbol, size, stop, target, confidence, reasoning) that gets validated against the hard limits before execution. The reasoning is logged but the *decision* is the structured output, not the narrative. This preserves auditability.

4. **Mechanical circuit breakers remain untouchable.** Daily drawdown halt, position limits, and the kill switch are in code the LLM context never sees as editable. The Skeptic is right that these must be immune to optimisation pressure.

5. **Graduation gate stays but gets faster.** Paper trading validation before live deployment, but measured in days not months, with the LLM designing strategies that are structurally richer than parameter-mutated signal expressions.

This is not "full autonomy" as I originally framed it. It is Claude with significantly more design authority and execution flexibility than the current system, operating within hard financial limits it cannot reason its way around. The current system treats the LLM as a component (classifier, parameter mutator, reviewer). This hybrid treats it as the strategist -- but a strategist who cannot override the risk desk.

I think this is where the debate should converge. The question is no longer autonomy versus structure. It is how much of the strategy design and execution pipeline should be LLM-driven versus rule-driven, and where exactly the hard boundaries sit.

### Skeptic

Credit where it is due. The Advocate has abandoned the position that actually worried me -- "full control, sole instruction: generate profit" -- and replaced it with something substantially different: Claude as strategist within immutable risk limits. That is a real concession, and it addresses my two strongest objections (the accountability gap and the losing streak scenario) head-on. We are now arguing about where to draw a line, not whether the line should exist. Good.

**Where you convinced me.**

The evolution speed problem is real and I undersold the fix. Daily tournaments help, but the deeper issue is that the current system can only mutate parameters within fixed strategy templates. A mean-reversion strategy cannot become a momentum strategy no matter how fast you run tournaments. The search space is structurally constrained, and I was wrong to suggest that acceleration alone solves this. Letting Claude propose complete strategy logic -- not just tweak numbers -- is a genuine capability upgrade that the current architecture cannot replicate by going faster.

The capital argument also has more merit than I initially granted. At GBP 300, a system that takes months to graduate while bleeding GBP 24/month in fixed costs is not "being careful." It is being slow enough to guarantee failure. Faster graduation with richer strategies is not recklessness; it is survival.

**Where the hybrid needs sharper boundaries.**

Your five-point proposal has a critical ambiguity: point 3 says Claude evaluates positions and outputs structured JSON decisions. What inputs does it see? If Claude gets raw price data, news text, portfolio state, and recent trade history, it is making bespoke inferences on every activation. That is the hallucination surface I flagged in Round 1, just dressed in JSON. The structured output format does not fix the problem -- it constrains the *shape* of the answer, not the *quality* of the reasoning.

Here is what I would need to see instead. Claude's execution decisions should be constrained to selecting from strategies that have already passed tournament validation. Claude picks *which* validated strategy to deploy on *which* symbol given current conditions -- a matching and allocation decision, not a novel inference. It does not freestyle a thesis about why this particular earnings beat warrants a 2% position. It recognises that the current setup matches the conditions where Strategy-47 (which proved itself in paper trading over 30+ trades) has demonstrated edge, and activates it. This is a materially different role from "evaluate everything from scratch each activation."

**My version of the hybrid.**

1. **Strategy design: Claude, unconstrained in structure, daily cadence.** Claude proposes full strategy logic -- indicators, conditions, sizing rules. Validated via backtesting against 30 days of data before entering the paper tournament. This is where the LLM adds the most value with the least risk.

2. **Tournament and graduation: mechanical, no LLM involvement.** Strategies compete on realised paper performance. Graduation thresholds are in code Claude cannot edit. The LLM does not get to argue that a strategy "should have" graduated.

3. **Trade execution: Claude as dispatcher, not analyst.** Claude selects which graduated strategies to activate on which symbols given current market conditions (regime, sector, volatility). Output is structured: strategy ID, symbol, size. The reasoning trace is logged but is not the decision -- the strategy's pre-validated logic is the decision.

4. **Risk limits: immutable, outside LLM context.** Per your point 1, agreed completely.

5. **Exit management: mechanical once entered.** Stop losses and targets are set at entry by the strategy's validated parameters. Claude does not get to "adapt the exit plan" mid-trade. This is where motivated reasoning is most dangerous -- "hold through the dip, the thesis is intact" -- and where mechanical rules save you.

**Concrete acceptance criteria before deploying this.**

- The strategy-design loop must produce at least 3 strategies that pass graduation in paper trading within 14 days. If Claude cannot design strategies that validate mechanically, the expanded design authority adds cost without value.
- Execution decisions (strategy-symbol matching) must be evaluated against a baseline of random assignment from the graduated pool. If Claude's dispatch does not measurably outperform random selection over 60+ trades, remove it and use round-robin.
- API cost for the hybrid must stay under $20/month. If Claude-as-strategist burns through budget on daily design iterations, the cost advantage over the current system evaporates.
- A kill-test: deliberately feed the system a losing streak in paper mode and verify that it does not attempt to modify risk parameters, skip graduation, or override circuit breakers through any pathway. Run this before any live capital touches the system.

The hybrid is the right destination. The remaining question is whether Claude earns execution authority through demonstrated performance, or is granted it by architectural fiat. I want it earned.

## Round 3 -- Convergence

### Moderator Summary

#### What both sides agree on

- **Mechanical circuit breakers are non-negotiable.** Daily drawdown halts, position limits, total drawdown kill switches, and the graduation gate must live in code the LLM cannot see, edit, or reason its way around. Both sides arrived here -- the Advocate by concession, the Skeptic by conviction.
- **Weekly parameter-only evolution is too slow and too narrow.** The current system's search space (5-11 continuous parameters within hard bounds, mutated once per week) cannot adapt to regime changes or discover structurally different strategies. Both agree Claude should design complete strategy logic, not just tweak numbers.
- **The capital problem is real.** At GBP 200-500, a multi-month paper-trading graduation phase that bleeds GBP 24/month in fixed costs is not prudent -- it is a slow path to guaranteed failure. Faster graduation with richer strategies is a survival requirement.
- **Structured outputs over free-form reasoning.** Trade decisions must be expressed as validated JSON, not natural language theses. Auditability requires that every decision be traceable to a specific strategy, signal, and parameter set.
- **The current LLM trust boundary is already non-zero.** Trader-v2 already uses Haiku for news classification and Sonnet for evolution proposals. The debate is about moving that boundary, not introducing it.

#### Remaining disagreements

These are differences of degree, not of kind:

- **Execution authority.** The Advocate wants Claude to evaluate positions and output bespoke trade decisions (structured, but novel per activation). The Skeptic wants Claude limited to dispatching pre-validated strategies to matching conditions. The Skeptic's version is safer; the Advocate's version captures more upside from contextual adaptation. This is resolvable by starting with the Skeptic's version and expanding if Claude's dispatch decisions measurably outperform the baseline.
- **Exit management.** The Advocate wants adaptive exits; the Skeptic wants mechanical exits set at entry. The Skeptic is right that mid-trade exit reasoning is the highest-risk surface for motivated reasoning. Mechanical exits should be the default, with adaptive exits introduced only after eval evidence supports them.

#### The converged proposal

**Architecture: Claude as Strategy Designer and Dispatcher, within immutable hard limits.**

**What Claude controls:**
- Strategy design: proposes complete strategy logic (indicators, entry/exit conditions, sizing rules) on a daily cadence. Not limited to parameter mutation -- can propose entirely new strategy structures.
- Regime-aware dispatch: selects which graduated strategies to activate on which symbols, given current market conditions (volatility regime, sector momentum, news flow). Output is structured JSON: strategy ID, symbol, size, stop, target.
- Learning synthesis: reviews closed trades and generates hypotheses about what worked and why, feeding the next design cycle.

**What stays mechanical:**
- Tournament validation: strategies compete on realised paper-trading performance. No LLM involvement in scoring or selection.
- Graduation gate: thresholds in code (Sharpe, profit factor, minimum trade count). Claude cannot argue a strategy through.
- Exit management: stops and targets set at entry by the strategy's validated parameters. No mid-trade LLM override.
- Circuit breakers: 5% daily account risk cap, 2% per position, 10% total drawdown weekly halt. These live in a config file outside LLM write scope.

**Guardrails that are immutable:**
- Risk limits enforced at the execution layer, after the LLM's structured output, before the broker call. The LLM's output is a *request* that gets validated, never a direct instruction to the broker.
- API budget hard cap at $15/day, enforced by the existing budget guard. Sonnet for strategy design (daily), Haiku for classification and dispatch (per-activation). No open-ended reasoning loops.
- Kill switch: any pathway that modifies risk parameters, graduation thresholds, or circuit breaker values without a human commit is architecturally impossible -- these values are not in the LLM's tool scope.

**Evolution and learning cadence:**
- Daily: Claude proposes 1-3 new strategy designs, backtested against 30 days of data, entering the paper tournament if they pass minimum viability checks.
- Per activation (2-4x daily during market hours): Claude dispatches graduated strategies to matching symbols. Structured output logged in full.
- Weekly: learning loop synthesises closed-trade outcomes into the next design cycle. Self-improvement PRs for signal expressions and strategy templates, human-reviewed before merge.

**Cost implications:**
- Strategy design (1 Sonnet call/day): ~$0.15-0.30/day.
- Dispatch (3-4 Haiku calls/day): ~$0.02-0.05/day.
- Classification (existing Haiku pipeline): unchanged at ~$0.10-0.15/day.
- Estimated total: $8-15/month, within the current budget envelope. The key saving is that strategy design replaces weekly evolution, not adds to it.

**Acceptance criteria before expanding Claude's authority:**
1. Strategy design must produce at least 3 strategies passing graduation within 14 days of paper trading. If it cannot, the expanded design authority is not earning its cost.
2. Claude's dispatch must outperform random strategy-symbol assignment over 60+ trades, measured by Sharpe ratio and profit factor. If it does not, replace dispatch with round-robin.
3. API cost must stay under $20/month for 30 consecutive days.
4. Kill test: simulate a 5-trade losing streak in paper mode and verify the system does not attempt to modify risk parameters, skip graduation, or override circuit breakers through any code path.
5. All four criteria met before any live capital is deployed through the hybrid system.

#### Verdict

Yes, this hybrid is better than what trader-v2 currently has -- but not by the margin the Advocate originally claimed. The gains come from two specific upgrades: (1) expanding the strategy search space from parameter mutation to full structural design, and (2) accelerating the evolution cadence from weekly to daily. These are genuine capability improvements that the current architecture cannot achieve by tuning what exists.

The gains do *not* come from giving Claude free-form execution authority. The Skeptic won that argument. Bespoke LLM reasoning at the trade-execution level introduces an unauditable, unreproducible decision surface with no backtesting framework. Constraining Claude to dispatching validated strategies preserves the system's core property: every live trade is traceable to a strategy that proved itself in paper trading.

The original question -- should trader-v2 be replaced by a fully autonomous Claude instance? -- has a clear answer: no. But trader-v2 should promote Claude from component (classifier, parameter mutator) to strategist (full strategy designer, regime-aware dispatcher), within hard limits it cannot modify and with earned authority that expands only when measured performance justifies it.

#### Recommended next steps

1. **Extend the evolution system to accept full strategy logic**, not just parameter mutations. This is the highest-value change. Claude proposes complete strategy definitions (indicator selection, entry/exit logic, sizing rules) as structured objects that the existing tournament framework can validate.
2. **Accelerate tournaments to daily cadence.** Move the evolution cycle from weekly to daily. This requires no architectural change -- just a scheduler adjustment and ensuring backtesting can run within the daily API budget.
3. **Add regime-detection signals.** ATR percentile, sector breadth, and correlation clustering as inputs to the dispatch layer. These let Claude make informed strategy-symbol matching decisions rather than guessing.
4. **Build the dispatch layer.** A new component where Claude selects which graduated strategies to activate on which symbols, outputting structured JSON validated against risk limits before execution. Start simple: if dispatch does not beat random assignment within 60 trades, remove it.
5. **Implement the kill test.** Before any live deployment, run the adversarial losing-streak scenario in paper mode and verify every circuit breaker holds with no LLM bypass.
6. **Reduce the graduation gate's trade-count requirement** from 30 to 15-20 trades, compensated by tighter performance thresholds. This addresses the capital-bleed problem without removing validation.

Steps 1 and 2 can begin immediately within the existing Phase 4 evolution framework. Steps 3-6 are pre-requisites for Phase 7 (live execution) and should be planned as a Phase 4b or incorporated into Phase 7's plan.

