Read `docs/HANDOFF-2026-08-27-insights-everywhere.md` first — it is the brief. Then §0 of it is the job.

`main` = `b84b531`, clean and pushed. 211 files / 4,051 unit · coverage 99.76% stmts, 100% funcs, `src/lib` 100% on all four · E2E_GATE=1: 523 passed at `maxDiffPixels: 0` · `pnpm ledger-check` exit 0. Net worth $111,531.75 · income $117,924.62 (unchanged three sessions) · 10,111 active rows · 80 categories.

The job, in order:

1. **Finish the insight sweep.** PHASE III-B is built and shipping on `/spending`, `/categories/[id]`, `/merchants/[id]` and `/accounts/[id]`. The machinery is done: a surface is now a **fact builder and nothing else** — the loop, the cap, the drop-if-unprovable rule and the key scheme all live in `services/insights.ts`. Left: `/investments`, `/recurring/[id]`, `/budgets`, `/summary/[year]`, `/flow`, `/transactions`, `/imports`, dashboard hero. ⛔ Read `merchant-insights.ts`'s header before writing one — its first version restated figures the page already printed, and one of those restatements actively misled.

2. **Pass 72d — cost, caching, the kill switch.** No model is called yet; every sentence is composed by the app from measured facts. That was the right order, and it means a model can now be introduced as a SELECTOR over already-true claims rather than as a writer.

3. Then pass 73 (the Robinhood Brokerage arbiter) and 74 as scheduled.

4. **I still owe you an answer on the 25 unpaired transfers** — you have the list in §4.1. Nothing has been linked.

How I want you to work:

- ONE long session, ONE handoff at the very end — not per pass. Keep working; commit and push to `main` between queue items without asking.
- No fabricated numbers, ever. Every figure must trace to a source document or a real query. Re-derive from the handoff rather than quoting it.
- Measure before you assert, and look at the page. Five things were caught wrong last session and **not one was found by a test** — a coverage line that was false, a merchant strip that misled, a bill that was paid less described as a rise, a stack with no visible depth, and a one-pixel flake.
- Ask me when it is genuinely my call — early, as a concrete either/or with real numbers. Don't ask about things the repo can answer.
- I run my own dev server on :3000 with real data — don't kill it, screenshot against it. The real DB is `data/moneyapp.db`.
- Explain a visual diff before regenerating a baseline. ⛔ A fullPage diff is NEVER a pure insertion — splice the band out AND reproduce the residual with an empty div of the same height before you believe it.
- Mutation-test every new guard: break it, watch the test go red, restore. A test that cannot fail is not a test. **A test that early-returns on an absent element is a silent pass** — two were written that way last session.

The one rule that keeps biting: empty is not the same as unproven, and unproven is not the same as missing. It was designed in twice last session instead of fixed after.
