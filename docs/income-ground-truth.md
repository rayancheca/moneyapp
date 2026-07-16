# 💰 Income Ground Truth — derived from the user's own hand-tracking

Source: `Finances 2026.xlsx` (the user's manual spreadsheet, uploaded 2026-07-16). It
tracks Jun 2025 → May 2026 (academic rhythm) plus a full 2025 calendar tab. This is the
**authoritative definition of what counts as income** for this user. Every categorization
decision in the app should be checked against the rule and figures below.

Reconciliation was adversarially verified (3 independent agents, workflow
`income-ground-truth-verify`) against a read-only copy of the real DB. All figures below
are cents-exact from `data/moneyapp.db` at the 2026-07-16 snapshot unless noted.

---

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
