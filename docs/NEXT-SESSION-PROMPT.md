Read `docs/HANDOFF-2026-08-27-provenance-kinds.md` first — it is the brief. Then §0 of it is the job.

`main` = `d74f446`, clean and pushed. 214 files / 4,119 unit · coverage 99.76% stmts, 100% funcs · tsc clean · E2E_GATE=1: **582 passed at `maxDiffPixels: 0`** in 8.4m · income $117,924.62 · spending $167,828.49 · 10,111 active rows. **Zero DB writes last session.**

## ⛔ Before you run anything: this box lies when it is loaded

Read **§5 and §5b** of the brief before you believe a red run. Fifteen different tests failed once each across nine runs last session and **not one reproduced** — every one passed in isolation.

The cause is not the tests. **The repo is inside iCloud Drive** (`~/Desktop` is the synced Desktop), so every `pnpm build` rewrites 1.7 GB under `bird`, which was caught at 59% CPU with nothing else running. It has since **broken a build outright** — `ENOTEMPTY: directory not empty, rmdir '.next/server'`; `rm -rf .next` fixes it, and a build failure here may be the filesystem rather than the code.

**So: stop the dev server, wait for `uptime` load < 4, run ONE thing at a time.** I lost hours to this by running probes and a `vitest run` alongside an e2e run, and once by leaving experiments running against a gate — that gate read a spec file mid-mutation and I had to throw it away.

## Two things that are mine to decide, not yours

1. **The rent merchant rename is rehearsed and NOT applied.** `npx tsx scripts/rename-flamingo-merchant.ts --apply`, dev server stopped. 12/12 guards pass on a `.backup` copy. Ask me; don't run it on your own.
2. **Moving the repo off the Desktop.** It fixes the flakiness AND the fact that `data/moneyapp.db` and `.env` currently sync to Apple while the app's footer says *"Local-first · your data never leaves this Mac."* My machine, my call.

## The job, in order

1. **Pass 72d — cost, caching, the kill switch.** Nothing calls a model yet: all seven insight surfaces compose their sentences from measured facts. That was the right order, and it means a model can be introduced as a **SELECTOR over already-true claims** rather than as a writer. ⛔ Read `insight-facts.ts`'s header first — pass 46 built this the other way round and its validator accepted 16 of 17 attack strings.

2. **Give the e2e fixture a `notices`, a `car` and an `income` card.** All three return null on the seed, so they have no pixel coverage and no spec change can give it to them (§7). A seed job, and it will move dashboard + dashboard-grid baselines — explain each diff before regenerating.

3. **Pass 73** (the Robinhood Brokerage arbiter) and **74** as scheduled.

4. **HOSTING goes last** — `docs/deploy-plan-gcp-firebase-auth.md`, ~1 pass of real work (`requireSession()` on 103 server actions). Never propose a hosted-DB migration.

## How I want you to work

- ONE long session, ONE handoff at the very end — not per pass. Keep working; commit and push to `main` between queue items without asking.
- No fabricated numbers, ever. Every figure traces to a source document or a real query. **Re-derive from the handoff rather than quoting it** — last session the brief's own year-over-year premise was backwards ("spending fell by $22,000"; it rose), and its explanation of a visual gap was wrong too. I would rather you correct me than inherit me.
- Measure before you assert, and look at the page. Two of my own explanations were refuted by measurement last session, and both corrections are in the brief.
- **Mutation-test every new guard.** A green first run is when to break it, not when to trust it. 45 mutants last session: 3 survivors were real test gaps, 2 were genuinely unobservable — and those two say so in a comment rather than carrying an assertion that would pass either way.
- **Explain a visual diff before regenerating a baseline**, with `scripts/crop-visual-diff.mjs`, and regenerate WITHOUT `E2E_GATE=1`.
- Ask me when it is genuinely my call — early, as a concrete either/or with real numbers. Don't ask what the repo can answer.
- I run my own dev server on :3000 with real data. Standing permission to stop it when you need to; put it back.

## The rules that keep biting

- **Empty is not unproven, and unproven is not missing.** Designed in correctly six more times last session; it has bitten five services historically.
- **Coverage has two axes, and the second is the one that bites: VIEW DIMENSIONS.** A route can be fully photographed while a sub-view inside it has never been opened — the dashboard is a deck showing ONE card, so nine of ten cards were unphotographed. `e2e/view-options.spec.ts` now enumerates seven of the nine view specs; the other two have their own.
- **A Playwright call that RETURNS a value usually does not retry.** `boundingBox()` and `isVisible()` both bit this repo. Use `e2e/box-helpers.ts`.
- **A proof must name the rows the figure was summed from** — not a superset, not a neighbour's.
