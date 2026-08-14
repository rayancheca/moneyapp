# Handoff — 2026-08-14, pass 55

> **`main` = `e70e8ce`**, tree clean. tsc clean · **159 files / 2,928 unit** ·
> coverage gate exit 0 · `next build` clean · **`E2E_GATE=1` 410 passed** ·
> zero baseline churn.
>
> Third and last block of a single long session (passes 53–55). The owner
> delegated the remaining judgement calls — *"youre choice for everything"* — so
> the budget re-derivation shipped with its rule written down rather than
> waiting another pass for a decision.

## 1. Shipped: the budgets are derived from the ledger again

The queue item that had needed an owner decision since pass 45. Rule, stated so
it can be argued with later:

| part | choice | why |
|---|---|---|
| basis | **median** of the trailing 6 full months | one-off months are everywhere here and the mean chases them — Travel's single $2,448.88 trip pulls its mean to $600.65 against a $270.14 median |
| floor | the subtree's **confirmed monthly commitments** | a budget below what is contractually owed is not a budget, it is a guaranteed overrun |
| result | `max(basis, floor)`, rounded **up** to $5 | rounding down could re-sink the floor |

⚠️ The floor is deliberately **not** `budgetTail`. That applies the staleness
gate added in pass 54, which is right for a forecast and wrong for a floor: the
August rent has not posted yet, and **what is owed does not depend on whether it
has arrived**. `detected` series are excluded as weaker evidence — two of them
are the dead ones pass 54 gated out.

### 1.1 The one that mattered

**Housing was budgeted $2,109.00 against a $2,285.70 rent** — under water by
$176.70 before a single discretionary dollar, in every month, structurally
unmeetable. Now $2,290.00.

| category | was | now |
|---|---|---|
| Car | $921.38 | $925.00 |
| Cash & ATM | $710.00 | $490.00 |
| Entertainment | $60.00 | *unchanged* |
| Fees | $30.00 | $55.00 |
| Food | $1,430.00 | $2,065.00 |
| Health | $170.00 | $150.00 |
| **Housing** | **$2,109.00** | **$2,290.00** |
| Shopping | $1,540.00 | $800.00 |
| Subscriptions | $180.00 | $75.00 |
| Transport | $520.00 | $390.00 |
| Travel | $100.00 | $275.00 |

10 of 11 changed; the total falls **$7,770.38 → $7,575.00** and is far better
distributed. Shopping had been budgeted at nearly twice its own median.

Real-ledger write behind a `VACUUM INTO` backup
(`data/backups/pre-budget-reset-*.db`), read back row by row.

**`pnpm propose-budgets`** re-runs it — DRY RUN unless `--apply` — so the next
time these drift the rule is re-applied instead of re-invented.

### 1.2 Two judgement calls worth flagging

- **Subscriptions $180 → $75** on a $71.22 median, while the last full month was
  $338.43. The median is the stated basis and the series behind that month were
  partly the lapsed ones. If it reads low in practice, that is the number to
  revisit first.
- **Fees $30 → $55.** Pass 51's memory flags a −$499.00 lifetime figure across
  the Fees subtree as untrusted. This used the trailing-6-month median, which is
  measured directly and does not depend on that number.

## 2. What is actually left

The queue is nearly empty. Everything below is small except hosting.

1. **`HoldingRow.quotedOn` is rendered nowhere per-row.** The holdings subtotal
   says "Last close" without a date precisely because rows may disagree; a
   per-row date would show *which* rows are stale. Touches the `investments-*`
   and `holding-*` baselines.
2. **The negative branch of the `left to allocate` tip is unrendered by any
   test** — the fixture's budgets never exceed its income. Needs a fixture that
   over-allocates, not a new assertion.
3. **`pnpm assert-fixture-shape` is not wired into any automatic gate.** It is
   the only guard on pass 53's fixture fix and nothing runs it for you.
4. ⛔ **Hosting + auth, LAST by standing instruction.** Plan is written
   (`docs/deploy-plan-gcp-firebase-auth.md`); the work is `requireSession()`
   across ~103 server actions. **Never propose a hosted-DB migration.**

### Passes remaining

- **1 pass** clears items 1–3 together (all small, one gate run).
- **1 pass** for hosting + auth.

So **2 passes to empty the queue as it stands.**

⚠️ Separately, `docs/future-ideas.md` — the master backlog — still holds **26
open items against 37 done**, and several are programs rather than items
("predictions everywhere + switchable views", Robinhood parity, recurring as
multi-episode, "nothing read-only"). Emptying *that* is realistically **6–10
more passes**, and it is worth choosing which of those you actually want before
starting them.

## 3. Notes

- The session's own lessons live in passes 53 and 54; nothing here supersedes
  them.
- A budget rule is a policy, not a measurement. The numbers above are measured;
  the *median-with-a-floor* choice is a judgement, and §1 exists so the next
  session can disagree with it on the record instead of guessing what was meant.
