# 💰 Income Ground Truth — derived from the user's own hand-tracking

Source: `Finances 2026.xlsx` (the user's manual spreadsheet, uploaded 2026-07-16). It
tracks Jun 2025 → May 2026 (academic rhythm) plus a full 2025 calendar tab. This is the
**authoritative definition of what counts as income** for this user. Every categorization
decision in the app should be checked against the rule and figures below.

Reconciliation was adversarially verified (3 independent agents, workflow
`income-ground-truth-verify`) against a read-only copy of the real DB. All figures below
are cents-exact from `data/moneyapp.db` at the 2026-07-16 snapshot unless noted.

---

> **⚠️ RE-MEASURED (2026-08-28) — the all-time total below is STALE.**
> The pass-18 note further down says "Current all-time income total ≈ **$119,982.68**". Measured
> against `data/moneyapp.db` today it is **$117,924.62**, so that figure is stale by **$2,058.06**
> and has been carried forward unchanged through six handoffs. The rules in this document are
> unaffected — only the running total moved, as later passes reclassified rows out of income
> (gambling winnings, ATM deposits mislabelled `Salary`, peer Zelles). This figure has now been
> stable across nine passes.
>
> **Two definitions, and they differed by 79 cents** (as of 2026-08-28). Both were correct; say which one you mean:
>
> | | |
> |---|---|
> | **$117,924.62** | every income-kind row, **both signs** — what `/categories/<Income>` publishes (`categorySpending` nets) |
> | $117,925.41 | positive rows only — what `/spending`'s Income card, its heatmap, the cash-flow views and the dashboard bridge publish (`isIncome`) |
>
> **⚠️ RE-MEASURED 2026-09-15 — the two now agree.** The owner refiled that one row to
> `Transfers › Credit Card Payment` on 2026-09-14 (it is the return of a card payment, not a
> clawback of income). Read-only on `data/moneyapp.db` today: **0** negative income-kind rows,
> and both definitions read **$117,979.61 over 286 rows**. The rule difference still stands —
> a future negative income-kind row would be subtracted on `/categories` and left out
> everywhere else — so keep naming which one you mean.
>
> The whole difference is ONE row: `2024-09-18  -$0.79  Refunds & Reimbursements
> "RETURNED INTERNET PMT"` on the Discover card. It is the ledger's **only** outflow sitting in
> an income category — checked ledger-wide, and the mirror case (inflows in expense categories,
> the "silent negative expense" the Rocket Money pass found) is 51 rows worth $7,031.51, all of
> them legitimate refunds that `periodTotals` reports separately and never nets against spending.
>
> **Composition, cents-exact over 2022-08-25 → 2026-08-24, 278 rows** — re-run it with
> `scripts/probe-open-items.ts`:
>
> | category | rows | total |
> |---|---:|---:|
> | Financial Aid | 6 | $51,872.00 |
> | Salary | 59 | $45,514.86 |
> | Tutoring | 60 | $10,023.00 |
> | Refunds & Reimbursements | 6 | $6,650.21 |
> | Interest | 68 | $2,439.68 |
> | Other Income | 35 | $850.81 |
> | Dividends | 44 | $574.06 |
> | **TOTAL** | **278** | **$117,924.62** |
>
> ⚠️ `Financial Aid` is the largest line and is **money in that was not earned** — it is excluded
> from "Earned" everywhere the app prints that word. As of S22 (owner decision 2026-09-14) the only
> surface that prints it is `/summary/[year]`, which puts aid under "Money in that you did not
> earn". `/spending`, its heatmap, the cash-flow chart/table/graph and the dashboard bridge call
> the all-income-kind figure **Income**, because aid is in it; before S22 they called it "Earned",
> and that sentence was false on every one of them. Whether any of the aid is a loan rather than a
> grant is still OPEN, and this document has never answered it.

> **⚠️ PASS-45 UPDATE (2026-08-11) — GAMBLING WINNINGS ARE NO LONGER INCOME.**
> Seven credits totalling **$1,053.82** sat in `Income > Other Income`. They are not earnings —
> they are money coming back from a betting platform (DraftKings / Kalshi), the return leg of
> stakes that were already recorded as spending. Counting them as income inflated earnings *and*
> made a roughly break-even activity read as ~$1,148 of overspend against a $60/mo Entertainment
> budget.
>
> They now live in the top-level **`Gambling`** category alongside the 44 stakes ($1,445.10), so
> analytics nets them automatically: **gross staked $1,445.10, returned $1,053.82, net $391.28.**
>
> **Ledger income total: $118,969.23 → $117,915.41.** Owner-approved with the number in front of
> him, after being told explicitly that this changes income rather than just a category.
> `scripts/split-out-gambling.ts` is the record; restore point
> `data/backups/pre-gambling-winnings-move.db`.
>
> **The rule this sets:** a credit that returns money previously recorded as spend is NOT income.
> It belongs in the same category as the spend, where the two net.

---

> **⚠️ PASS-18 UPDATE (2026-07-18):** the user's situation changed. He **moved Bronx → Miami** in early 2026,
> **Fordham work-study ENDED** (last 2026-05-13) and **Knack tutoring ENDED** (last 2026-05-21), and he now earns
> from a **cash job (~$1,046/week)**. Per his instruction, the cash-job deposits were categorized `Income › Salary`,
> so **"Salary" is no longer pure Fordham** — it is Fordham wages ($42,679.76) + the cash job. A confirmed weekly
> paycheck series ("Cash job (weekly pay)" $1,046/wk) drives the forecast; Fordham + Knack are `ended` series. Also:
> 92 peer Zelles were moved OUT of income (→ `Transfers › Reimbursements`), and dad's-money pass-throughs are now
> `Transfers › Pass-through`. ~~Current all-time income total ≈ **$119,982.68**~~ — ⚠️ **STALE, see the
> 2026-08-28 re-measurement at the top: it is $117,924.62.** The rule below still describes
> what counts as *earned* income; treat this note as the state **as of pass 18**, not as current.

## 1. The rule — what the user counts as "earnings"

> **Earnings = Fordham work-study wages (biweekly ACH _direct deposit_)
>            + Knack tutoring payouts
>            + SoFi savings interest.**

**Explicitly NOT earnings** (the user separates these on every tab):

| Family | Why it is not earned income | Correct app treatment |
|---|---|---|
| Financial-aid refunds | Dad pays tuition from his own (untracked) account; aid is deducted and the balance refunded to the user. Money in from outside, but not earned. | `Income › Financial Aid` (kept separate; "Papa money") |
| Dad's money ("comida" / euros / wires) | Father sends EUR → converted → deposited → often wired back. A pass-through/gift, not income. | `Transfers` (both legs net ~0) |
| ATM **cash** deposits | Mixed-origin cash (the user's own notes list poker, food splits, loans repaid). Fordham pays by ACH, never cash. | **Review queue** — user tags each one |
| Money moved into investing | The user's own cash going into Robinhood. | `Transfers › Investment Contribution` |
| Peer Zelle reimbursements | Friends/roommates paying the user back. | `Transfers` / `Refunds`, or review |

---

## 2. The ledger — where income actually comes from (all-time, per the rule)

**True earned income (2022-08 → 2026-07), by the user's definition:**

| Source | Rows | Amount | App category |
|---|---|---|---|
| Fordham work-study wages (`Direct Deposit FORDHAM UNIVERSI PAYROLL`) | 56 | **$42,679.76** | `Income › Salary` ✓ |
| Knack tutoring (`KNACK PAYOUT`) | 60 | **$10,023.00** | `Income › Tutoring` ✓ |
| SoFi interest | 66 | **$2,425.64** | `Income › Interest` ✓ |
| **TRUE EARNED TOTAL** | **182** | **$55,128.40** | |

The tutoring line is 100% clean (every row is a literal "KNACK PAYOUT"). Fordham wages are
clean once ATM cash is stripped out (see §4). Interest is clean but slightly under-captured
vs the sheet (the user logs one round savings-interest figure/month; the DB has the real,
smaller H2-2025 amounts — the DB is the more accurate record here).

---

## 3. Reconciliation — the app agrees with the user (validated)

**2025 calendar year (both sources cover it in full):**

| | Spreadsheet (user) | App, ATM-cash removed |
|---|---|---|
| Fordham wages | $17,405.04 | $16,912.74 |
| Knack tutoring | $5,292.24 | $5,771.25 |
| Interest | $1,781.76 | $1,413.96 |
| **Earned total** | **$24,479.04** | **$24,097.95** |

**Gap = $381.09 (1.56%).** The component gaps largely cancel, and the *mechanism* is
understood: from ~Sep 2025 the spreadsheet uses **flat forecast placeholders** ($722
Fordham, $124.50 Knack, ~$132 interest) while the DB holds the real posted amounts. So the
app is actually the more accurate record for late 2025 — the two agree to within noise. The
app's pass-8/pass-12 categorization work is fundamentally sound.

---

## 4. The mislabel this exposed — ATM cash booked as wages (CONFIRMED)

The app reports **$175,405.95** total lifetime income (396 rows) — **3.18× the true earned
$55,128.40**. The single biggest distortion:

- **36 `ATM CASH DEPOSIT` rows = $52,625.00 are categorized `Income › Salary`.** They are
  55% of the entire "Salary" bucket. None is Fordham payroll (Fordham is ACH direct deposit,
  never cash at an ATM); all 36 are physical ATM locations (Bronx/Manhattan/Miami/CT/CA).
  `categorization_source = 'rule'`, `needs_review = 0` — set silently, never surfaced.

**Root cause (verified, two independent re-application vectors):**
1. Seed rule `src/db/seed.ts:212` — **"ATM/cash deposit → Salary"** (priority 10, regex
   `ATM|CASH DEPOSIT`, `direction:in`, `amountMinCents:20000`) stamps any cash deposit ≥ $200
   as `Salary` + merchant `Employer (cash)`. It runs first in `categorizeAll()`.
2. `RESERVED_FOR_USER_RE = /ZELLE|\bATM\b/i` (`categorize.ts:336`) only guards **transfer
   pairing** (`detectTransfers()`, line 449). It does **not** protect these rows in the
   categorization pipeline — the docstring misleadingly implies it does.
3. Pass-8's reset (`data/categorize-review-2026-07-13.ts:125`) nulled the category but left
   `merchant_id = Employer(cash)` and `source = 'rule'` (not `'user'`). So every later
   import's `categorizeAll()` (`import/service.ts:349, :988`) re-selected the null-category
   non-user rows and **re-stamped Salary** — via the seed rule *and* the stale merchant map.
   This is why income regressed from the pass-8 **$116k floor** back to **~$175k**.

A durable fix must address BOTH vectors (rule + stamped merchant) or mark the rows
user-owned so `categorizeAll` never re-touches them.

---

## 5. Smaller mislabel families (lower priority, some need the user's eye)

| Family | Rows | Amount | Note |
|---|---|---|---|
| Financial Aid | 6 | $51,872.00 | Correct as income, but not "earned" — keep separate |
| Peer Zelle in `Other Income` | 92 | $6,193.68 | Melanie Ballard 85/$5,055.68; Louis Soumah 7/$1,138. Not earnings — reimbursements. Carson (co-tutor) Zelles *could* be tutoring — needs the user's call |
| Internal transfer as `Other Income` | 5 | $1,028.60 | `Deposit From Savings - 5791` / `Deposit from Self-directed` → should be `Transfers` |
| NYS DTF tax payment as income | 1 | −$302.00 | An **outflow** (tax payment) sitting in income → should be an expense/`Fees` |
| Stock lending (Robinhood) | 22 | $1.92 | Real securities-lending income; trivially small |
| DraftKings RTP credits | 4 | ~$658 | Gambling; landed in `Refunds & Reimbursements`/`Other Income` — did not contaminate Salary |

---

## 6. Account map (from the sheet's routing/account table — confirms identities)

`chase ····3522` ✓ · `sofi checking ····9067` ✓ · `sofi savings ····5791` ✓ ·
`Capital One ····4991` (= app "Venture X ····4208" card) · plus TD, Venmo, Cashapp, Chime,
M&T (not all in the app). Full routing/account numbers are in the source file — **PII, do
not copy into code, docs, or memory.**

---

## 7. Proposed correction (NOT YET APPLIED — needs backup + dry-run + user approval)

Real-DB writes require backup + dry-run-on-copy + Δ-guards + explicit user OK.

1. **Durable code fix** — retire/scope the `ATM/cash deposit → Salary` seed rule so cash
   deposits are never auto-labeled wages for this user; drop the `Employer (cash)` merchant
   default. (Code change; prevents the regression recurring on every import.)
2. **Data fix** — reset the 36 ATM-cash rows out of `Salary` → uncategorized + `needs_review`,
   **and mark them `categorization_source = 'user'`** so `categorizeAll` can't re-grab them.
   Effect: app income $175,406 → ~$122,781; "Salary" → true Fordham wages $42,679.76 only.
3. **Small fixes** — the 5 internal-transfer rows → `Transfers`; the NYS DTF row → expense.
4. **Leave for the user to tag one-by-one** — the 92 peer-Zelle rows (Carson may be tutoring).

---

## Pass-19 update (2026-07-18) — the older ATM cash, resolved

The interactive categorization session revisited the ~$47k of older ATM cash deposits
(2022–2026-02) that pass 15 had pulled out of `Salary`. The user was asked directly whether
this cash (dad's money from Spain + a ~$15k May-2023 summer-school cluster + scattered smaller
deposits) counts as **income**. After I surfaced the magnitude — booking it to income would
raise the total from **$119,462.68 to $166,390.68**, undoing most of the pass-15 correction —
the user chose to **keep it OUT of income**.

**RULE (user decision):** cash the user *receives* but did not *earn* — dad's cash, gift money,
cash-for-a-purpose — is not income. It is booked to a new **`Transfers › Gifts received`**
category (kind `transfer`, so it is excluded from BOTH income and spending totals; net worth
already reflects the deposit via the account balance). This keeps the income number truthful to
what the user actually earns (~$119k: cash job + old Fordham + interest), while the money still
counts toward net worth.

**Income kinds now, for this user:**
- `Income › Salary` = old Fordham work-study **+ the current cash-job pay** (pass 18).
- `Income › Interest / Dividends` = real yield.
- **NOT income:** ATM cash received (→ `Transfers › Gifts received`), dad's in→out remittances
  (→ `Transfers › Pass-through`), self-Zelles and account funding (→ `Transfers ›
  Internal Transfer`), peer reimbursements (→ `Transfers › Reimbursements`).

Session tallies: review queue **1185 → 416**; income **$119,982.68 → $119,462.68** (the −$520
was a $500 Refunds + $20 Other-Income row that were really incoming transfers).
