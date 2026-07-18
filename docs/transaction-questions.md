# 🗣️ Transaction clarification — questions for the user

**Refreshed 2026-07-18 (pass 18)** from a read-only copy of the real DB (`/tmp/moneyapp-pass18-readonly.db`,
byte-identical to `data/moneyapp.db`, 9,688 active txns). This is the working list driving the interactive
clarification session. Ask in batches, **income first** (it unblocks the $0.01 projected-income bug), then big
ambiguous inflows, then housing, then the review-queue tail. Apply answers with **backup + dry-run-on-copy +
Δ-guards + confirm**; never auto-guess a reserved row (`source='user'`).

Every name below appears in your own transaction descriptions — I'm listing them so you can identify who's who.

---

## 0. THE LIFE-EVENT CONTEXT this refresh uncovered (please confirm — it frames everything)

The data tells a story of a **move from the Bronx to Miami around Feb–Mar 2026**:
- **Rent to "Hoffman LL" ($1,779.49/mo) STOPS at 2026-01-08** (last payment), and a **"Hoffman LLC SD refund
  $1,375.00" arrives 2026-06-18** (security deposit back).
- A **new rent "ETT\*…FlamingoSouthBe" ($2,285.70, tagged Rent) starts** — Flamingo South Beach is a Miami
  building. Earlier partial charge $1,334.80 on 2026-06-16.
- The **ATM cash deposits move to Miami locations** (474 W 41ST ST MIAMI, 3700 W FLAGLER ST) alongside NY ones.
- **Fordham work-study stops after 2026-05-13** (consistent with leaving campus / summer).
- A **USCIS I-765 / I-907 filing fee ($2,250, 2026-06-24)** appears — a work-permit (EAD) application.

**Q0.1 — Did you move from the Bronx to Miami in early 2026?** (Confirming this lets me treat the Hoffman rent
as *ended*, the Flamingo charge as your *current* rent, and explains the new cash-deposit pattern.)
**Q0.2 — Did you file for a US work permit (I-765) in June 2026?** (If yes, that $2,250 is a government fee, not
a transfer — and it hints your income situation is about to change.)

---

## 1. INCOME — highest priority (fixes projected income = $0.01)

The forecast only sees **recurring income *series*,** and the only ones detected are two **$0.01/mo stock-lending**
payments → projected income = $0.01. Your real, current income isn't modelled at all. Current all-time income
buckets (for reference): Financial Aid $51,872 · Salary/Fordham $42,679.76 · Tutoring/Knack $10,023 · Refunds
$8,293 · Other Income $6,216 · Interest $2,426 · Dividends $545.

**Q1.1 — The recent ATM cash deposits — which are your pay?** These are *irregular*, not a clean weekly $1,047:

| date | day | amount | location |
|---|---|---|---|
| 2026-05-12 | Tue | **$1,400.00** (+ a separate $100) | NY (E 90th) |
| 2026-05-15 | Fri | $300.00 | Bronx (Arthur Ave) |
| 2026-05-18 | Mon | $1,500.00 | NY (W 57th) |
| 2026-06-04 | Thu | **$1,047.00** | **Miami** (W 41st) |
| 2026-06-05 | Fri | $400.00 | **Miami** (Flagler) |
| 2026-06-11 | Thu | $730.00 | NY (E 90th) |
| 2026-06-12 | Fri | $1,000.00 | NY (Broadway) |
| 2026-07-06 | Mon | $150.00 | NY (E 90th) *(already auto-categorized)* |

Recent (Apr 2026+): **9 rows, $6,627** (~$3.3k/mo). Which are **income/pay** vs mixed cash? Where's the cash
from — a cash-paying job, tips, side work, or mixed (the ground-truth doc noted poker / food splits / loans
repaid)? Roughly how much and how often is the pay?

**Q1.2 — The OLDER ATM cash lumps look different.** Pre-Jun 2025: **31 rows, $43,550**, including one-off lumps
of **$6,000, $5,600, $5,100, $5,000, $4,200, $2,700, $2,300** (2022–2024). These don't look like weekly pay.
Were those savings/one-off cash deposits (not earned income)? (I'll tag them separately from any pay stream.)

**Q1.3 — Fordham work-study.** Last payroll **2026-05-13 ($615.13)**, nothing since. Paused for summer, ended,
or should more have arrived?

**Q1.4 — Knack tutoring.** Last payout small/irregular. Still active, or wound down after the move?

**Q1.5 — "Mark this as my recurring paycheck"?** If any of the above is a regular paycheck, I can pin one txn as
your recurring income so the forecast projects it. What's the real cadence + amount (if any)?

---

## 2. BIG AMBIGUOUS INFLOWS — income, loan, gift, or your own money moving?

Currently sitting in **Transfers / Internal Transfer** (so they net ~0 in net worth). Each needs your call —
some are large enough that a wrong label meaningfully distorts income.

**Q2.1 — CHIPS international wires (Standard Chartered Bank) — the biggest ones, NEW to this list:**
| date | amount |
|---|---|
| 2025-05-06 | $14,100.00 |
| 2025-08-11 | $15,500.00 |
| 2025-12-11 | $19,500.00 |
| 2026-05-06 | **$29,800.00** |

~$79k total, roughly **twice a year (May & Dec)** from an international bank. Is this **your father funding your
account** (tuition/living — a gift/transfer, not earned income)? Your own money moved from abroad? Something
else? *(Note: a **$25,000 outgoing international wire on 2026-05-07** — the day after the $29,800 in — suggests
money passing through; is the $29,800 in → $25,000 out a pass-through you'd net to zero?)*

**Q2.2 — "DEPOSIT ID NUMBER" deposits:** $8,950 (3/2), $8,880 ×2 (3/3), $1,611.18 (3/3), $2,092 (6/22). ~$30k
in early March. Prior notes flagged "DEPOSIT ID" as your dad's euros. Same thing — a transfer/gift?

**Q2.3 — MONEYGRAM REMITTANCE $1,120.77 + $1,030.23 (both 2026-06-22).** Who sends these — family support, a
repayment, income?

**Q2.4 — "Zelle payment from ROBERT COHN $2,500.00" (2026-06-23).** Who is Robert Cohn — income, loan,
repayment, or gift?

**Q2.5 — "REAL TIME TRANSFER RECD FROM ABA/CONTR BNK" (many, $500–$3,500; e.g. $3,504.99 on 4/15, $2,999.93 on
5/27, $1,995.04 on 7/1).** You moving your own money between accounts, or receiving from other people? *(One,
$3,504.99, is currently mislabeled as a **Refund** and counts as income today — see §6.)*

**Q2.6 — Self-name transfers "…Rayan Karim Checa…" (e.g. Zelle $1,887 on 7/2).** Money between your own
accounts → Transfers, correct?

---

## 3. HOUSING — a real data gap + the move

**Q3.1 — Hoffman = your old Bronx landlord?** The **$1,779.49/mo "Direct Payment Hoffman LL"** rows (Jul 2025 →
Jan 2026) are currently miscategorized as **"General"**, not Housing — so your Housing budget ($2,109) sees
almost nothing. If Hoffman is rent, I'll move all those rows → **Housing** and mark the series *ended* (you moved
out). Confirm?

**Q3.2 — "ETT\*…FlamingoSouthBe" ($2,285.70) = your current Miami rent?** If yes, I'll make sure it's Housing and
set it up as your current recurring rent (so Housing projects correctly).

**Q3.3 — "Hoffman LLC SD refund $1,375.00" = your security deposit back?** (Currently in Refunds — that's fine,
just confirming it's not income.)

---

## 4. REVIEW-QUEUE TAIL — the reserved rows you wanted to tag yourself

**Q4.1 — Peer Zelles in `Other Income` — income (tutoring) or reimbursements/gifts?**
- **Melanie E Ballard** — 51 inflow rows, ~$4,305 (incl. **$1,890 on 5/26**, $722 on 6/13/25). Who is she — a
  tutoring client, roommate, partner? (Determines income vs reimbursement/gift.)
- **Carson G Lama** — 55 rows, ~$3,592 (flagged before as a possible **co-tutor** → could be tutoring *income*).
- **Louis A Soumah (Fernandez)** — 9 rows, ~$1,288.
- **"other" Zelle-in** — 315 rows, ~$17,482 (many small; we can sample the big ones).

**Q4.2 — ATM cash (from §1).** After you say which recent ones are income, I'll tag those `Income` and the rest
(`Cash & ATM` / mixed) as you intend. The reserved rows (`source='user'`) will only change with your explicit OK.

---

## 5. RECURRING / BILLS — confirm the stale ones (so the "fixed" side of the forecast is honest)

Detected series whose next-expected date is in the **past** (you may have cancelled after the move):
- **Hoffman LL** ($1,786.46/mo, last 2026-01-08) — *ended, per §3.1.*
- **T-Mobile** ($55.64/mo, last 2025-02-09) · **YouTube Premium** ($7.99, last 2025-08-22) · **Uber One**
  ($4.99, last 2025-05-25) · **Extra Space Storage** ($44, last 2025-03-20) · **StephanCodes** ($40, last
  2024-10-03) · **Fordham Sambazon** ($6.60 biweekly, last 2026-04-18).

**Q5.1 — Which of these are still active vs cancelled?** (Cancel = drop them from the forecast's fixed side.)

---

## 6. INCOME-BUCKET CLEANUPS (these change your income *total*, low-risk)

Found sitting in income buckets but arguably not income:
- **`Refunds & Reimbursements` $3,504.99 (2026-04-15) = a "REAL TIME TRANSFER RECD"** — a transfer in, not a
  refund. Likely → Transfers (see Q2.5). Two IRS TREAS 310 refunds ($1,442, $1,333) and the Hoffman SD refund
  ($1,375) are correctly refunds.
- **`Other Income` = almost entirely peer Zelles** (Melanie/Carson/Louis) → reimbursements/gifts, not earned
  (pending Q4.1; Carson may be tutoring income).

---

## How to run this (the interactive workflow)
1. ✅ Re-read the real DB read-only, refreshed these figures, expanded the list (done this pass).
2. Ask in batches (start with §0/§1). One theme at a time; AskUserQuestion for the choices; keep it conversational.
3. Apply each batch as a real-DB categorisation write: **backup → dry-run on a copy with Δ-guards (net-worth
   invariant, income-total sanity) → show the diff → apply only after you confirm.** Never auto-tag a reserved row.
4. After income is clarified, fix the forecast (variable-income component + honest headline) so projected income
   reflects reality — pure-lib-first TDD, adversarial review, one gated commit.
