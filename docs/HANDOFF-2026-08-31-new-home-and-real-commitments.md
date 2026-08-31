# Handoff — the new home, and the first month the app knows what he actually pays

> **Supersedes `HANDOFF-2026-08-28-the-queue-emptied.md`.**
>
> **`main` = `df08e28`**, tree clean, pushed. tsc clean · **4,223 unit** ·
> coverage 99.76% stmts / 100% funcs ·
> **E2E_GATE=1: 582 passed at `maxDiffPixels: 0`** (8.4m) — **first run from the
> new location** · `pnpm ledger-check` exit 0, running on every commit.
>
> ⛔ **THE REPO HAS MOVED: `/Users/rayankarimcheca/dev/MoneyApp`** (lowercase
> `dev` — `mkdir -p ~/Dev` found an existing `~/dev` and kept it). The Desktop
> copy is deleted.
>
> Live ledger: **10,111 active rows** · income **$117,924.62** · spending
> **$167,828.49** · net worth **$113,038.43** — all unchanged by the move.

---

# ⛔ 0. THE JOB — what is next

1. 🔴 **The app cannot see his income any more.** Measured this session:
   recorded income was **$0.00 in August** and **$52.95 in July**, against
   $9,412.53 and $10,353.96 of spending. §4. This is the biggest open thing in
   the ledger and it is not a code bug — it is a data gap.
2. ⛔ **The COKE stock split** — this app multiplies a split-adjusted price by an
   unadjusted quantity, a 10× error in every historical valuation it draws. Three
   of the six `Robinhood Brokerage` disagreements are this. Unchanged from last
   handoff's §3; still the next real correctness pass.
3. **Pass 75** (the state-coverage audit) and onwards —
   `docs/program-passes-60-94.md`.
4. **HOSTING goes last** — `docs/deploy-plan-gcp-firebase-auth.md`.

---

## 1. ✅ The move worked, and one part of my own runbook did not

`git fsck` exit 0, 410 commits, `PRAGMA integrity_check` → `ok`, 10,111 active
rows, spending $167,828.49, 245 statement periods — every figure identical to
before. `core.hooksPath` survived, so the pre-commit ledger check is still live.
**582 e2e passed on the first run from the new folder**, no scattered
non-reproducing failures: the flakiness really was the sync daemon.

🔴 **But `repoint-statement-paths.ts` repointed 195 of 329 and left 134 naming a
folder that had just been deleted** — and said so only in a single summary line.

The cause was a design mistake. It leaned on `migrateStorageLayout`, which
recomputes each file's home from the account it resolves to TODAY, so its target
differed from the stored path in the **folder** as well as the root:

    stored   …/data/statements/capital-one-venturex-4147/fd38…pdf
    wanted   …/data/statements/capital-one-venturex-4208/fd38…pdf

That folder drift is real and pre-existing (a card re-numbered, a Robinhood CSV
filed under the brokerage before the cash account owned it). But it works by
MOVING a file from its old path to its new one, and after a repo move the old
path is gone — so it moved nothing and repointed nothing.

⛔ **A repo move changes the ROOT and nothing else.** The script now rebases the
root, leaves the folder alone, refuses to repoint any row whose file is not
actually at the rebased path, and separately reports rows already under the root
whose file is missing — which the old version could not distinguish from
success. Re-run: **134 repointed, 0 outside the root, all 329 resolve to a file
on disk.**

⚠️ **iCloud had been making conflict copies of the git index too** — `.git/index
6` through `9`, alongside the five `moneyapp N.db-wal` copies. `fsck` says
nothing was damaged. All deleted, along with `coverage 2`, `test-results 2/3/4/5`
and `data/e2e-originals 2–5`.

⚠️ Still un-re-derived: the archive **folder** drift above. Running
`migrateStorageLayout(db, {move:true})` now would fix it, and is a separate,
deliberate job.

---

## 2. ✅ Seven real commitments, from his own bills

Given with screenshots on 2026-08-31. Every figure is one he stated or
photographed, so all of them are written to `user_amount_cents` / `user_ends_on`
— detection keeps its own columns and the forecast reads user-first.

| | ledger before | now | day |
|---|---|---|---|
| Car lease | $559.89 | **$695.04** | **15th**, 24 payments → 2028-08-15 |
| Car insurance | $361.49 | unchanged | 11th, → 2027-01-11 (5 left) |
| Rent (base) | $2,285.70 | **$2,109.00** | 1st |
| Rent utilities & fees | — | **$182.21** | 1st |
| FPL | $14.21 on the 10th | **$58.87** | **8th** |
| Internet | $50.00 on the 10th | $50.00 | **8th** |
| Parking | — | **$368.86** | 20th, **quarterly** |
| Gym | — | **$100.00** | 22nd |

⛔ **The lease was $135.15 a month wrong** — $3,243.60 over 24 payments that the
runway could not see. `register-car-commitments.ts` had $559.89, and its own
header records that two sessions had been told different numbers. The
Mercedes-Benz screenshot is the arbiter now.

⚠️ **The day is the 15th, not the 11th**, on his instruction after being shown
that his message said the 11th and the app said 09/15/2026. The contract End Date
(08/11/2028) IS an 11th, which is why it was worth asking rather than picking.

⚠️ **Rent is split at his choice, and the split has a consequence.** He pays ONE
charge of $2,291.21, so the calendar shows two expected lines against one
posting. That is the cost of separating the fixed part from the variable one.
⚠️ Only **$111.70** of the $182.21 is itemised in his screenshot; the rest is on
line items above the visible cut, so the figure is measured (total − base) and
never assembled from the parts.

⚠️ **`Parking` is quarterly.** $368.86 covers three months; he renews each
quarter. He also wrote "268.86" once when describing the renewal — a probable
typo for 368.86, **not resolved**. If the renewal price really is different, that
series needs correcting.

⚠️ **`Breezeline (internet)` may be the wrong provider name.** The screenshot's
logo is not Breezeline's, but the amount and cadence match exactly, so the
existing series was corrected rather than replaced. Rename if it is wrong.

### Verified in the running app, not assumed

`/recurring` lists all seven. The September calendar puts **−$2,291.21 on the
1st** (rent + fees, the real charge to the cent), **−$108.87 on the 8th**,
**−$361.49 on the 11th**, **−$701.04 on the 15th** (lease + Rocket Money) and
**−$100.00 on the 22nd**; October puts **−$368.86 on the 20th**. The dashboard
reads *"$2,291.21 due before your next paycheck (Sep 3)"*. The car card reads
$1,056.53/month, all-in $1,325.60.

⚠️ I read the 15th's cell as "−781" from a screenshot and it is **−$701.04** —
checked numerically rather than claimed. Do not read money off a screenshot.

---

## 3. 🔴 My budget arithmetic was wrong in both directions before it was right

The first version walked `user_category_id` directly. That column is an
**override** carried only by commitments with no posted rows — so it saw the
three NEW series and was **blind to rent, FPL and the internet**, whose category
is derived from POSTED rows. It reported Housing needing **+$182.21** when the
true change is **+$5.51**: it added the fees line without seeing the rent it had
just been split out of.

Now uses the app's own `recurringSeriesIdsForCategory`, override rule included. A
second opinion about category membership is exactly the drift this repo keeps
paying for.

Budgets move by the change in their category's commitments, so existing
discretionary headroom survives:

| | was | now | why |
|---|---|---|---|
| Housing | $2,285.70 | **$2,291.21** | rent −$176.70 + fees +$182.21 — the real charge, to the cent |
| Car | $921.38 | **$1,056.53** | lease +$135.15 |
| Transport | $105.00 | **$227.95** | parking, monthly-equivalent |
| Health | $35.00 | **$135.00** | gym |
| Utilities | $74.21 | **$118.87** | FPL +$44.66 |

⚠️ **Transport now carries a quarterly charge in a monthly budget.** $368.86
every three months is $122.95 a month, so the month it actually charges runs
over. The script says this out loud rather than smoothing it away; a budget
period that could hold a quarterly commitment is a real design question.

---

## 4. 🔴 THE BIGGEST OPEN THING: the app cannot see his income

Measured after the commitments landed:

| month | recorded income | recorded spending |
|---|---|---|
| 2026-03 | $3,812.48 | $6,909.05 |
| 2026-04 | $2,655.73 | $7,458.74 |
| 2026-05 | $1,061.19 | $8,277.46 |
| 2026-06 | $5,377.30 | $12,349.01 |
| 2026-07 | **$52.95** | $10,353.96 |
| 2026-08 | **$0.00** | $9,412.53 |

Two months of essentially no recorded income against ~$10,000/month of recorded
spending. His `Cash job (weekly pay)` series expects $1,047.00 a week — the app
knows the schedule and cannot see the deposits.

⚠️ **Read this as a data gap, not a life event.** `docs/income-ground-truth.md`
records $117,924.62 of income over the ledger's life, and the app already has a
cash-earnings disclosure for exactly this shape ("N expected paydays have passed
since the last deposit — that money was held as cash, spent as cash, or the
schedule has ended"). What it needs is a measurement: are the deposits missing
from the imports, landing in an unimported account, or arriving as cash that
never reaches a statement?

⚠️ Related and separate: `/budgets` now reads **"Over-allocated by $377.56"** —
budgets total $4,914.56 against $4,537.00 of expected income. That is honest
arithmetic against his own stated income schedule, and it will read differently
once §4 is understood.

---

## 5. Still open (unchanged unless noted)

- 🔴 **Income invisible for two months** — §4.
- ⛔ **The COKE stock split** — a 10× historical-valuation error.
- **The archive folder drift** — `migrateStorageLayout` would re-derive it; §1.
- **`Parking` renewal price** — "268.86" vs "368.86"; §2.
- **`Breezeline (internet)` provider name** — §2.
- **The insight vocabulary, not the selector** — 144 surfaces say exactly two
  things; the model orders and defaults OFF because there was nothing to select.
- **Eight crypto price marks** in `ledger-check`'s baseline, −$24.65…+$18.94.
- **`accountCoverage(db, day)` takes a TODAY, not an as-of** — documented.
- **Discover is missing five statements**, 152 days.
- **45 `WEIXIN*` rows, $340.00**, deliberately in bare `Shopping`.
- **HBO Max is registered as RENEWING** — one click on `/recurring` ends it.
- **4 transfer legs, $1,462.00** (bucket C) still unpaired.

---

## 6. Notes that keep costing time

- ⛔ **A repo move changes the ROOT and nothing else.** Anything that
  re-*derives* a path during a move will silently do nothing, because the source
  it wants to move from no longer exists. §1.
- ⛔ **`user_category_id` is an OVERRIDE, not the membership.** Reading it
  directly sees only the commitments with no posted rows.
  `recurringSeriesIdsForCategory` is the one answer. §3.
- ⛔ **Do not read money off a screenshot.** −$701.04 looked like "−781". §2.
- ⚠️ **TWO DEFINITIONS OF SPENDING.** The quoted headline **$167,828.49** is the
  expense-KIND signed sum; `periodTotals().spentCents` reads **$175,018.27** on
  the same ledger.
- ⚠️ **`pnpm e2e:update <file>` does not work** — the flag takes a mode.
  `npx playwright test e2e/visual.spec.ts --update-snapshots`.
- ⛔ **`crop-visual-diff.mjs`'s second argument is the BASELINE NAME**, not an
  output name.
- ⛔ **A green first run on new tests is when to mutate them, not to trust them.**
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`
