# Handoff — the Rocket Money queue is empty, and the visual gate can see again

> **Supersedes `HANDOFF-2026-08-25-calendar-and-rocket-money.md`.** Its §0 queue
> is worked out; §2.4 is decided; §1 of this brief records which of its premises
> did not survive measurement.
>
> **`main` = pushed**, tree clean. tsc clean · **186 files / 3,508 unit** ·
> coverage gate exit 0 · `pnpm ledger-check` exit 0 ·
> **E2E_GATE=1: 458 passed** at `maxDiffPixels: 0`, twice, zero failed,
> zero flaky, zero skipped.
>
> Live ledger: 10,072 active rows · net worth $33,134.22 · income $117,924.62 ·
> 0 flagged for review. 100 rows recategorised, one category renamed, no amount
> moved.

---

# ⛔ 0. THE JOB — what is next

Nothing is half-built and there is no owner-approved queue outstanding. The
ranked candidates, best first:

1. **The Wells Fargo importer.** Still the owner's own ask, and still blocked:
   *"well i guess skip this cause i dont have one for at least a week."*
   **Ask him whether the export has arrived before doing anything else.** The
   build notes in the prior brief's §3 are still correct, including the warning
   that the headerless five-column format is general knowledge and must be
   checked against a real file. `pnpm trial-import` first, always.
2. **The 113 WeChat Pay rows** — see §4 below. A task chip is already filed.
3. **Pass 66 as originally scheduled** — `src/services/provenance.ts` plus a
   `<ProvenancePopover>`, never started. `docs/program-passes-60-94.md`.
4. **The 69 unlinked exact-opposite transfer pairs** and the 24 transfer groups
   with one active member.

---

## 1. The queue, worked — and three premises that were wrong

### 1.1 `Dining & Drinks → Shopping` (item 2) — 81 rows moved, and the brief named 73 of them

The brief said 101 rows, "RAM'S VILLAGE, CASTAWAYS — a bodega and a bar".
Measured: 88 unique (date, amount) matches across **twelve** descriptor groups.

The mechanism turned out to be better evidence than the export ever was.
**RAM'S VILLAGE was already filed both ways in this ledger**: 61 rows on Venture
X, Discover and Chase Checking sat in `Food > Dining` — put there by hand — and
all 78 on Chase Sapphire sat in `Shopping`, every one of them from
`bank_category`. This was never "Rocket Money is right". It was *"he already told
this ledger the answer on three cards and one card's bank feed overrode him."*

That is why the move was **merchant-level (78)** and not limited to the 72 rows
the export matched uniquely: the six extra rows are the same merchant, same
account, same descriptor, wrong for the same reason, and matching row-by-row
would have left the merchant split for no reason. 139 rows now read as one
merchant.

🔴 **13 `WEIXIN*` rows in the same pair were deliberately NOT moved.** WeChat Pay
is a payment RAIL: 202 rows, one 2025-06-29 → 2025-07-17 trip to China, already
split ten ways here. Rocket Money labels the whole rail "Dining & Drinks" —
including `WEIXIN*subway operatio` at **$0.42**, a metro fare their matcher read
as a sandwich shop. Copying that in is what he warned against: *"just use this as
a guide dont just change everythign to what it say here."*

### 1.2 🔴 Item 3's premise was false, and two defects were behind it

Item 3 asked for ATM withdrawals categorised by what the cash bought. **His
export cannot deliver that.** Of 81 ATM rows it leaves **50** as plain "Cash &
Checks"; the ~12 it labels otherwise are mostly this ledger's own misfilings
showing through, and the 13 genuinely purposeful ones (Weed) were applied last
session. What was actually there:

| what | rows | why |
|---|---|---|
| casino ATMs → `Gambling` | 2 · $355.20 | the one purpose a descriptor can prove is LOCATION. Owner confirmed. |
| ATM cash deposits → `Internal Transfer` | 5 · +$393 | sat in `Cash & ATM`, kind **expense** — money IN filed as an expense |
| `VENMO CASHOUT` → `Internal Transfer` | 7 · +$94.50 | the same rail filed two different ways **by direction** |

The Venmo one is the shape worth remembering: every Venmo row going **out** was
`Transfers > Internal Transfer` (15 rows, $1,219); every Venmo row coming **in**
was `Cash & ATM > ATM Withdrawals` — called an ATM withdrawal when it is neither
an ATM nor a withdrawal.

🔴 **This is why spending moved.** `spendingBucket` admits any row under an
expense-kind root **regardless of sign**, and `monthlySpending` accumulates
`-amountCents`, so those 12 inflows were netting against real ATM withdrawals as
though they were refunds of them. Measured cash spending $8,430.02 → **$8,562.32**
and total spending **+$487.50 exactly**, asserted by a guard. The `Cash & ATM`
tree now holds 72 rows and not one inflow.

### 1.3 Item 4 confirmed — but the last handoff's Carson claim was half wrong

719 rows, 360 in / 359 out, netting +$1,957.22 over three years, every one a
Zelle to or from a named individual. Nothing to do, exactly as the brief
predicted.

🔴 But the brief recorded **"Carson Lama is his own Wells Fargo Zelle handle"**,
and that had already moved two rows the wrong way.

Cross-checking Zelle REF numbers across the two legs of the export settles it
exactly. Five Chase payments "TO CARSON LAMA" arrive at his own Wells Fargo
account — `JPM99CQXLSRM`, `JPM99CQXLN8W`, `JPM99CSO5OZR`, `JPM99CU779B3`,
`JPM99CU77AM7` — each matching a WF row reading `ZELLE FROM RAYAN KARIM CHECA`
under the same reference, with the memo still attached: TEST, RENT, RENT. Those
five are genuinely internal.

Carson Lama transactions, however, start **2024-10-04** — twenty-one months
before that account existed — and run to about 110 small peer-to-peer splits.
The two rows corrected (2026-08-05 $50, 2026-08-06 $15) carry Chase
person-contact ids, not a `JPM99…` reference; no Wells Fargo arrival exists on
either date; and on 2026-08-13 Carson sent back **exactly $65**, a row already
sitting in `Reimbursements`.

> **The lesson, because it will recur:** a Zelle contact NAME is the label in
> *his* address book, not an identity. The reference number is the identity, and
> it appears on both legs.

The Wells Fargo account **is** his — the export shows his rent
(`Flamingo RENT … Rayan Karim Ch`), his Capital One payment, and his own Miami
merchants.

### 1.4 `Family pass-through` → `Pass-through` (§2.4, decided)

He chose the rename. The $3,000 across 2026-05-12 and 2026-05-18 moved out of
`Transfers > Loans`, which now nets exactly **-$999.00** — $5,000 lent to
Philipe, $3,500 repaid, $501 in from Adam Godina — a real outstanding position
rather than a grab bag.

⚠️ **The rename is not a display change, and `renameCategory()` REFUSES it.**
Transfer-kind categories keep their names because the transfer detector resolves
them *by name*, and `src/services/year-summary.ts` did exactly that. Proven, not
assumed: with only the code renamed, `/summary/2026` drops its pass-through line
and `excludedCents` reads **$0.00**, silently hiding $71,364.18. Both halves
shipped together.

> **If you ever rename another transfer/system category**, grep for its literal
> name first. The service resolving it by string is the only thing standing
> between a rename and a silently empty figure.

---

## 2. 🔴 The visual gate had been blind, and now is not

`maxDiffPixelRatio: 0.001` scales the allowance with page **area**. `/transactions`
at 1440×3487 is 5.0M pixels, which bought **5,021 pixels of silence**. Three real
changes had been living in it:

| what was invisible | size | ratio |
|---|---|---|
| a whole **`Categories`** item added to the sidebar | 1,302 px | 0.00077 |
| a **`Duplicates`** filter tab added to /transactions | (within 1,974 px) | 0.00039 |
| the dashboard's committed bills $2,000.41 → **$2,004.16**, overdue $125 → $170 | 99 px | 0.000026 |

The `Categories` one is the worst: it is on **every page with a sidebar**, and
the gate could not see it on any of them.

**The fix is `maxDiffPixels: 0`, and zero is measured, not aspirational.**
Re-running the whole suite at `maxDiffPixelRatio: 0` put **435 of 458** green —
those baselines are byte-identical run to run. Deleting 42 baselines and
regenerating them brought **19 back byte-for-byte identical**. The 23 that
changed were all real content; the smallest real diff was **41 pixels**. There is
no CI — one Mac, one font stack, so there is no second renderer to be tolerant
of.

⚠️ If it ever becomes genuinely noisy, raise it to a flat number **below 41** —
never back to a ratio.

### 2.1 Two things that cost time here, worth knowing

- ⛔ **`updateSnapshots: E2E_GATE ? "none" : "missing"`.** A gate run deliberately
  refuses to write a missing baseline — correct design, and it means
  **regeneration must run WITHOUT `E2E_GATE=1`**, then be verified with it. A
  gate run against deleted baselines just fails 41 times and writes nothing.
- **`scripts/crop-visual-diff.mjs` is new** and is the reason all 23 regenerated
  baselines are *explained*. A full-page diff PNG is mostly unchanged pixels; the
  changed region can be 96×201 inside 1440×1173. Crop it and read it before you
  regenerate anything.

---

## 3. Notes that keep costing time

- ⚠️ **zsh does not word-split.** `for d in "dir name"; do cmd $d; done` passes
  ONE argument, not two. It cost a confusing round of `ERR_MODULE_NOT_FOUND`
  this pass, and it is in the memory already because it has bitten before.
- ⚠️ **The Bash cwd persists across calls.** A `cd` in one call silently changes
  the next one's working directory; an `rm` glob then matches nothing and reports
  success. `cd` to the repo root explicitly, or use absolute paths.
- ⚠️ **`sharp` is a transitive dependency**, not a direct one — `import "sharp"`
  fails. `scripts/crop-visual-diff.mjs` resolves it out of `node_modules/.pnpm`.
- ⚠️ The owner runs his **own dev server on :3000** — curl it, don't kill it.
  Playwright wants :3111; stale CLOSED sockets there are harmless, only a
  `LISTEN` matters (`lsof -nP -iTCP:3111 -sTCP:LISTEN`).
- ⚠️ **Never pipe a gate run through `tail`** — capture the whole log.
- ⚠️ **The Bash tool caps `timeout` at 600000ms**, shorter than a build + full
  e2e run. Run gates in the background and poll.
- `data/app.db` is a 0-byte stub; the real database is **`data/moneyapp.db`**.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`

---

## 4. Still open

- **The Wells Fargo importer** — owner has no export for about a week from
  2026-08-25. Ask first.
- **113 `WEIXIN*` rows, $803.78**, sitting in a bare `Shopping` from
  `bank_category` — the China trip. A task chip is filed with the full brief.
  ⛔ Do not copy Rocket Money's categories for these; it labels metro fares as
  dining.
- ⚠️ **`docs/income-ground-truth.md:40` still says income ≈ $119,982.68.** The
  measured, guarded figure is **$117,924.62** and has been stable across three
  passes. That line is a dated pass-18 annotation; it was NOT corrected here
  because tracing the difference is its own job, and editing a number without
  tracing it is the thing this project does not do.
- **17 of 39 `Weed` rows** unmatched on (date, amount) ambiguity.
- **FPL's 2026-07-28 charge is still untagged**, correctly — its descriptor is
  `FPL DIRECT DEBIT ELEC PYMT PPD ID:…` against a tagged `ORIG CO NAME:FPL
  DIRECT DEBIT…`. A human can see they are the same bill; the ledger cannot.
- **The wallet design for future ATM withdrawals** — the withdrawal as a transfer
  INTO `Cash on Hand`, the spend recorded when it leaves. He liked it. It cannot
  be applied retroactively (Cash on Hand is tracked only from 2026-08-03 and its
  earlier history must never be backfilled), so it is a forward-looking design
  question to raise with him.
- **Chime** is deliberately not an account — opened for a $300 bonus, closed.
- **The $560.54 on 2026-07-29**, self-to-self, routing 021000021.
- **Dad's remaining ~$5k** via Arno Search Capital LLC; the pass-through legs do
  not cancel.
- **69 exact opposite transfer pairs** unlinked; **24 transfer groups with one
  active member**.
- **`notFound()` returns HTTP 200** app-wide from force-dynamic pages.
- **`/summary/[year]` has no visual baseline.** It has one now-verified figure
  (the Pass-through line) and no pixel coverage at all; with the gate finally
  strict, this is a cheap and worthwhile addition.
