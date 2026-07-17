# 🗣️ Transaction clarification — questions for the user (compiled 2026-07-17, pass 17)

The user asked to be **asked a lot of questions** so we can clarify every ambiguous transaction and get
income/projections right. This is the working list to drive an interactive session (next pass). Ask in
batches, apply answers with **backup + dry-run-on-copy + Δ-guards + confirm**, never auto-guess a reserved
row. Ordered by leverage: **income first** (it unblocks the $0.01 projected-income bug), then big ambiguous
inflows, then the review-queue tail. Amounts/dates are from the real DB (read-only) at 2026-07-17.

Every name below appears in your own transaction descriptions — I'm listing them so you can identify who's who.

---

## 1. INCOME — the highest priority (fixes projected income = $0.01)

The forecast only sees **recurring income series**, and the only ones detected are two **$0.01/mo stock-lending**
payments — so projected income is $0.01. Your real income isn't modelled. Let's fix that:

**Q1.1 — The "$1,047 every Thursday" you mentioned.** The ATM cash deposits are actually *irregular*, not a
clean weekly $1,047:
| date | day | amount |
|---|---|---|
| 2026-05-12 | Tue | $1,400.00 |
| 2026-05-15 | Fri | $300.00 |
| 2026-05-18 | Mon | $1,500.00 |
| 2026-06-04 | Thu | **$1,047.00** |
| 2026-06-05 | Fri | $400.00 |
| 2026-06-11 | Thu | $730.00 |
| 2026-06-12 | Fri | $1,000.00 |
Which of these are your **income/pay** vs mixed cash (the ground-truth doc noted poker / food splits / loans
repaid)? Is the pay actually weekly, and roughly how much? Where does the cash come from (job, tips, side work)?
→ Once you say which are income, we categorise them `Income` and can model a recurring paycheck.

**Q1.2 — Fordham work-study.** Your last Fordham payroll deposit was **2026-05-13 ($615.13)** — nothing since.
Is work-study **paused for the summer / ended**, or should more have arrived? (It's not modelled as recurring,
which is part of why nothing projects.)

**Q1.3 — Do you want a "recurring paycheck" set up?** If you have a regular pay (Fordham when it resumes, or the
cash pay), we can mark one transaction as your recurring income so the forecast projects it. What's the real
cadence + amount?

**Q1.4 — Knack tutoring.** Still active? (Last seen $51 on 2026-05-21.) Regular, or ad-hoc per session?

---

## 2. BIG AMBIGUOUS INFLOWS — income, loan, gift, or your own money moving?

These are large and currently in **Transfers** or uncategorised. Each needs a call:

**Q2.1 — "ACH Deposit $9,000.00" (2026-06-23).** What is this? (Income? A loan? Moving your own money in?)

**Q2.2 — "Zelle payment from ROBERT COHN $2,500.00" (2026-06-23).** Who is Robert Cohn — is this income, a
loan, a repayment, or a gift?

**Q2.3 — MONEYGRAM REMITTANCE $1,030.23 + $1,120.77 (both 2026-06-22).** Who sends these? Income, family
support, or a repayment?

**Q2.4 — "DEPOSIT ID NUMBER 191705 $2,092.00" (2026-06-22).** What is a "DEPOSIT ID" deposit for you? (Prior
notes flagged a big "DEPOSIT ID" as your dad's euros washing through — same thing?)

**Q2.5 — Self-Zelles "Zelle payment from Rayan Karim Checa $1,887.00 / $5.00" (2026-07-02).** These are from
*your own name* — moving money between your own accounts (→ Transfers), correct?

**Q2.6 — "REAL TIME TRANSFER RECD" / "Instant bank transfer" (many, $100–$3,900).** Are these you moving your
own money between accounts, or receiving from other people? (They're all in Transfers now.)

---

## 3. HOUSING / RENT — connects to the Housing budget + a data gap

**Q3.1 — "Hoffman LL" is a detected **$1,786.46/mo bill** and there's a "Hoffman LLC SD refund $1,375.00"
(2026-06-18).** Is Hoffman your **landlord** (so that $1,786 is **rent → Housing**)? The **SD refund** suggests a
**security-deposit return — did you move out / change apartments?** (This matters: your Housing budget is
$2,109 but the forecast only sees $109 there because rent isn't linked to Housing as recurring.)

---

## 4. REVIEW-QUEUE TAIL — the reserved rows you wanted to tag yourself

**Q4.1 — Peer Zelles (92 rows, ~$6,194) in `Other Income`.** Are these **tutoring income**, reimbursements, or
gifts? The big senders:
- **Melanie E Ballard** — 85 rows, ~$5,056 (incl. a $1,890 on 5/26). Who is she — a tutoring client, roommate,
  partner? (Determines income vs reimbursement.)
- **Louis A Soumah** — 7 rows, ~$1,138.
- **Carson G Lama** — flagged before as a possible co-tutor (so possibly *tutoring income*). Confirm?

**Q4.2 — ATM cash deposits (the review queue, from §1).** After Q1.1, tag the income ones `Income` and the rest
(`Cash & ATM` / mixed) as you intend.

---

## 5. RECURRING / BILLS — confirm the stale-looking ones

Several detected series have a **next-expected date in the past** (2024–2025) — do you still pay these, or are
they cancelled? Confirm/cancel so the forecast's fixed side is accurate:
- **T-Mobile** ($55.64/mo, next 2025-03-11) · **YouTube Premium** ($7.99, two series — a duplicate?) ·
  **Netflix** ($18.12) · **OpenAI ChatGPT** ($21.78, next 2025-04-26) · **Rocket Money / Rocket Money Premium**
  ($6.00 — looks like the *same* subscription detected twice) · **Extra Space Storage** ($44) ·
  **StephanCodes** ($40) · **Uber One** ($4.99).

**Q5.1 — Which of these are still active?** Any duplicates to merge (Rocket Money ×2, YouTube ×2)?

---

## How to run this (for the next chat)
1. Read the real DB read-only (copy to /tmp) to refresh these figures; expand the list with anything new.
2. Ask in batches (start with §1 income). Keep it conversational — one theme at a time.
3. Apply each batch of answers as a real-DB categorisation write: **backup → dry-run on a copy with Δ-guards
   (net worth invariant, income totals sanity) → confirm the diff → apply.** Never auto-tag a reserved row.
4. After income is clarified, revisit the forecast (add the variable-income component + honest headline) so
   projected income reflects reality.
