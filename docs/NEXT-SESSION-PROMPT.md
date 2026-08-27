Read `docs/HANDOFF-2026-08-27-twelve-cards.md` first — it is the brief. Then §0 of it is the job.

`main` = `a435ba2`, clean and pushed. 200 files / 3,857 unit · coverage 99.74% stmts, 100% funcs · E2E_GATE=1: 507 passed at `maxDiffPixels: 0` · `pnpm ledger-check` exit 0. Net worth $111,531.75 · income $117,924.62 (unchanged six passes) · 10,111 active rows.

**The job, in order:**

1. **PHASE III-B — AI insights everywhere.** This is my standing ask: *"i want ai insights everywhere, and i really mean everywhere."* ⛔ Read pass 72a in `docs/program-passes-60-94.md` before writing a line — this failed a review once and the reason is specific: pass 46's validator accepted **16 of 17 attack strings**, because app-computed slots block fabricated NUMBERS and do nothing about fabricated RELATIONSHIPS ("is your largest category" when it is third, "has been climbing since July" with no trend data). Restart from the TYPE — `Fact.value?: number` plus a `kind` — not from the top.

2. **Ask me about the two data questions in §3 of the handoff before touching them.** Neither is a code bug; both are the ledger having no word for something real. (a) There is no `Taxes` category, which is why a $302 New York State income tax payment is filed under `Fees`. (b) 25 unpaired transfers already sit opposite an exact-amount row — $5,301.64 that one link each would account for.

3. Then pass 68 (data health) and pass 69 (neutral notices) as scheduled.

**How I want you to work:**

- ONE long session, ONE handoff at the very end — not per pass. Keep working; commit and push to `main` between queue items without asking.
- ⛔ **No fabricated numbers, ever.** Every figure must trace to a source document or a real query. The test is: *which file, which line, says this number?* Re-derive figures from the handoff rather than quoting them — three of them have turned out stale or wrong in the last two sessions.
- **Measure before you assert, and look at the page.** Five shipped surfaces were caught lying in the last two sessions and **not one was found by a test** — a percentage stacked over another with no units, a tax bill inside a fee total, an empty account warning on 1,464 days out of 1,464, a badge inside a `<p>` that killed page interactivity, and my rent dropping out of the forecast for being one day late.
- **Ask me when it is genuinely my call** — early, as a concrete either/or with real numbers. Don't ask about things the repo can answer.
- I run my own dev server on **:3000 with real data** — don't kill it, screenshot against it. The real DB is `data/moneyapp.db` (`data/app.db` is a 0-byte stub).
- ⛔ Explain a visual diff before regenerating a baseline (`scripts/crop-visual-diff.mjs`); regenerate WITHOUT `E2E_GATE=1` and verify WITH it.
- Mutation-test every new guard: break it, watch the test go red, restore. A test that cannot fail is not a test.

**The one rule that keeps biting:** *empty is not the same as unproven, and unproven is not the same as missing.* It has cost four separate services now.
