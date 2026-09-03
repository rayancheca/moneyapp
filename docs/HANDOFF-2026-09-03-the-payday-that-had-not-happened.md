# Handoff — the payday that had not happened, a fixture in the backup rotation, and a card in credit

> **Supersedes `HANDOFF-2026-09-02-the-forecast-hole.md`.**
>
> Repo: **`/Users/rayankarimcheca/dev/MoneyApp`**, `main`, tree clean, pushed.
> tsc clean · **4,547 unit** · coverage gate exit 0 ·
> **E2E_GATE=1: 598 passed at `maxDiffPixels: 0`** · `pnpm ledger-check` exit 0
> on every commit via `.githooks/pre-commit`.
>
> Ledger: **10,178 active rows** (10,111 + the 67 rows of the Chase Sapphire
> statement you dropped mid-session, §1) · TWO real-DB writes this session, both
> behind restore points: that import, and the insurance attach you approved
> (§8.1).
>
> 16 baselines regenerated across four full gates, every diff cropped and read
> first: the `/imports` family (§6 — six balance-less documents left "the 12
> most recent periods", the footer went 183 → 156, the 27 documents got their
> own sentence) and the `/categories` family (§8.2 — the system row's count went
> "—" → "198 txn", the fixture's category-less bucket). Nothing else moved: no
> fixture series is hand-registered or late, no fixture card is in credit, no
> fixture account is unproven from its first day — every other fix this session
> is unit-tested only. The fourth gate: **598 passed in 8.1 minutes.**

---

# ⛔ 0. THE JOB — what is next

**Both decisions you were asked mid-session are CLOSED** — you said attach it,
and treat the system category as the NULL bucket, and both are done (§8).

1. **❓ ONE question left from the attach:** the statement printed **$357.58**
   for the first insurance payment; the series carries **$361.49**, your figure
   from memory. If Sep 11 posts at $357.58 the matcher's tolerance decides, and
   it should not have to. Which is the premium?
2. **28 merchants are queued for the paid Claude pass** after the import (§1).
   The free pass changed nothing; I did not press the paid one.
3. **⛔⛔ `BTLEServer` at 100% of a core for 52 days.** `uptime` says 52 days,
   20 hours. Still not rebooted. Reboot.
4. **Pass 76 onward** — `docs/program-passes-60-94.md`. **HOSTING LAST.**

---

## 1. Mid-session: the Chase Sapphire September statement

You dropped `20260902-statements-9805-.pdf` into Downloads and said follow the
procedure. The procedure, as run:

    pnpm trial-import <scratch folder with the one PDF>
      parsed 1 · inserted 67 · deduped 0 · quarantined 0
      statement periods reconciled 201 → 202 · Chase Sapphire verified 2026-08-02 → 2026-09-02
      net worth delta +$82.72
    read the PDF's own summary (second arbiter):
      Previous Balance $0.00 · Payments −$1,733.75 · Purchases +$1,651.03 · New Balance −$82.72
      Opening/Closing 08/03/26 – 09/02/26      ← 67 rows sum to exactly that
    stopped your dev server (standing permission)
    pnpm import-statements <same folder> --confirm
      restore point data/backups/pre-2026-09-03T134528-manual-backup.db
      identical numbers to the trial, line for line
    cmp Downloads copy vs data/statements/chase-sapphire-9805/170b5fe3990ce815-…pdf → BYTE-IDENTICAL
    mv Downloads → statements/saphire-preferred/20260902-statements-9805-.pdf
    pnpm backup:statements → archive copied 284, inbox copied 6, 30.5 MB to iCloud
    pnpm ledger-check → exit 0, "ledger matches the recorded baseline"
    dev server back on :3000

**The +$82.72 is a CREDIT balance** — you paid $1,733.75 against $1,651.03 of
purchases, so the card owes you $82.72, and net worth rose by it. That credit
is what exposed §4.

⚠️ The import ran the free categorisation pass (your rules and merchant
memory) itself; pressing "Run categorization" afterwards changed nothing.
**31 rows have no category and 28 merchants are queued for Claude** — the paid
button is yours. Coverage reads 99.7%.

⚠️ `pnpm backup:statements` copied **284 archive files**, not one. The mirror
had fallen that far behind since the repo moved to `~/dev` — additive only, so
nothing was lost, but the iCloud copy was a week stale.

---

## 2. Found by reading the app, ranked by what was on your screen

| # | what the screen said | what is true |
|---|---|---|
| 1 | /budgets: "$0.00 in so far, **$3,141.00 still expected**" one line above "**4 paydays** fall in this month, scheduled at **$4,188.00**" | today's $1,047.00 was in NEITHER leg |
| 2 | dashboard: "14 paydays, Jun 4 – Sep 3 … **13 paydays have passed** since Jun 5 with no deposit" | Sep 3 was TODAY; the upcoming strip beside it listed that pay as still to come |
| 3 | dashboard, after the import: "$842.89 across 3 cards" — Discover "**66%** of it", Venture X "**44%** of it" | two slices of one debt summing to 110% |
| 4 | /imports: Discover "**On schedule** · next closes **Sep 2**", read on Sep 3 | a predicted date already gone, named as the next close |
| 5 | /imports: "The 12 most recent periods" + "**233** older periods" = 245, over tiles reading 201 + 40 + 0 = **241** | four `not_applicable` documents in the list and the footer, two of them under "What the statements proved" |
| 6 | /settings: a daily backup "Ledger runs to Jul 8, 2026 · 1,264 transactions · net worth $143,952.43" between your real dailies, with a Restore button | the e2e FIXTURE, in your real rotation, sorted above every real daily |
| 7 | the car card: "Paid up front, spread over the lease $6,457.58" | includes the $357.58 insurance premium — and would have included the lease itself from Sep 15 |
| 8 | /categories/Car: "Car lease · monthly · inactive · **$559.89**"; /recurring All tab: "Car lease … −$559.89 … ~$8,340.48/yr" | $559.89 is the registration SEED the ledger corrected to $695.04 on 08-31; two amounts on one row |
| 9 | /recurring All tab: "**INACTIVE 7**" over "Cash job · Weekly · Next Sep 3" and five never-billed commitments; /recurring/[id]: an "Inactive" badge beside "Next expected Sep 11" | all seven are forecast one tab over; never billed, running late and lapsed are three facts, not one word |
| 10 | /imports: Robinhood Cash "**nothing has closed** on this account yet" | the same page lists its July period as reconciled; it has 33 statement anchors — the chain is unproven from its FIRST day, which is a different sentence |
| 11 | dashboard WHAT CHANGED: "**Sep 2026** is still running, and it is not fully imported either …" over figures for **July** | August cleared the calendar, failed the import test, and was passed over in silence; the note names the skip now |
| 12 | /accounts/Discover: "Discover is **55.3%** of everything you owe" | a share of $1,008.33 — the Sapphire CREDIT counted as owed; the two cards owe $925.61, so 60.2%, the cards card's own slice |
| 13 | dashboard terrain: "**$114,581.69 held, $925.61 owed**" under a header reading "Assets **$114,498.97** · Liabilities **$842.89**" | the terrain split by sign, the page by side; both were true and they sat on one screen |
| 14 | /investments/stock/MSFT: "**▲ +$4,468.50 (−5.95%)** … down 5.9%" | the dollars are the flow-adjusted gain, the percentage the time-weighted return — true together, unnamed, an up arrow on a fall |
| 15 | /summary/2025: "losses are **not treated as spending**" | under a "What you spent" figure that includes them — Gambling is an expense category in your own taxonomy |
| 16 | runway: "Less what you owe on cards **−$842.89**" | a net of $82.72 in credit; the line says so now |

Every one is the class the last three sessions named. Sixteen, and fourteen
were found by reading; one by reading a backup's own description; one by
reading the code behind another. Rows 12–16 came from the SECOND reading pass,
after both decisions closed — the detail pages, the chart tables and a holding
page, which the first pass had not reached.

---

## 3. ⭐ THE PAYDAY THAT HAD NOT HAPPENED — the same hole as last session's, mirrored onto income

Last session closed a $2,291.21 hole: a bill due earlier this month, unposted,
was in neither the fixed leg (opened on `today`) nor the variable leg. This
session, on a Thursday, the income side showed the mirror image.

`incomeExpectation` (the `/budgets` header) built `postedCents` over
`[start, today]` and opened the expected walk on `today + 1` — "disjoint by
construction", and its docstring said so with pride. The day the two legs meet
belonged to nobody unless the pay had already landed. On a weekly schedule that
is one day in seven, and on Sep 3 it read:

    $0.00 in so far, $3,141.00 still expected from Cash job (weekly pay)
    4 paydays fall in this month, scheduled at $4,188.00

`cashEarnings` (the dashboard's EARNED VS BANKED) had the opposite fault: it
counted a payday dated today as EARNED and as PASSED. "14 paydays, Jun 4 –
Sep 3 … $13,211.00 never reached a bank … 13 paydays have passed since Jun 5
with no deposit" — three centimetres from "Sep 3 · Cash job · +$1,047.00" under
*Upcoming*.

⛔ **One doctrine, stated in both places now: a scheduled occurrence dated
today is FUTURE until money for it has posted today.** That is what the
forecast, the upcoming strip and `committedBook` already did ("a bill due today
is DUE, not late"). The two income surfaces now agree with them:

- `/budgets`: the walk opens on `today`; an occurrence dated today is dropped
  exactly when a linked deposit dated today exists — the one fact that says the
  money is already in `postedCents`. Reads **"$0.00 in so far, $4,188.00 still
  expected"** against **"4 paydays … $4,188.00"**.
- dashboard: **"13 paydays, Jun 4 – Aug 27 · $1,447.00 of $13,611.00 implied ·
  $12,164.00 never reached a bank · 12 paydays have passed since Jun 5"**.
  Tomorrow it rolls to 14.

⚠️ **And the rule needed a second half the moment it landed.** The income card
asks the same function "as of the day the records stop" (its *"9 of them fall
on days the records already cover, through Aug 12"*). THAT day is complete —
every deposit on it is in the records — so a payday dated on it with nothing
banked was checked and missed. Two of its tests went red on a cut-off that fell
on a Thursday, and they were right. `todayIsComplete` says which reading you
are taking, and the checked-silence call sets it. **A function that means
"today" for one caller and "the last read day" for another cannot be fixed with
one boundary.**

⛔ **Why NOT the spending side's rule.** `budgetTail` also opens tomorrow, and
that is correct there: `budgetOverdue` owns today for bills. Income has no
arrears leg by doctrine (a payday that passed with no deposit is evidence about
the IMPORTS, not the job), so the forward leg is the only leg that can hold
today. The docstrings on both say so, so the next session does not "align"
them.

⭐ **Eleven mutants, all killed** across the two: reopening the walk tomorrow,
dropping the posted-today exclusion, counting the schedule through today
unconditionally, ignoring the deposit, ignoring `todayIsComplete`. Two existing
tests moved their asking day off a payday — their point was the unit (periods,
not days), not the boundary — and one budgets assertion that read `0` for a
payday on the period's last day was **an assertion that encoded the gap**. It
asserts the payday now, and says so.

---

## 4. A card in credit shrank the denominator

The Sapphire import closed the card $82.72 in credit, and ON YOUR CARDS read:

    $842.89  Across 3 cards …   Discover $557.62 66% of it   Venture X $367.99 44% of it

`share()` already refused a card in credit a slice of its own — and divided
everyone else by the NET. Slices are of the **$925.61 actually owed** now
(60% / 40%), the sentence says *"$82.72 of credit on Chase Sapphire is netted
off, so each slice is of the $925.61 actually owed"*, and a card that owes is
never "Nothing owed" whatever another card's credit nets the total to. The
headline stays the net, because the runway card subtracts the net and the two
have a test that they agree.

⚠️ Unreachable in the e2e fixture (no fixture card is in credit) — unit tests
only, two mutants killed.

---

## 5. "Next closes Sep 2", on Sep 3

Discover's rhythm says the 2nd; its newest close (Aug 9, the Capital One
reissue) widened the tolerance to eight days, so `statementPull` honestly stays
`waiting` until Sep 10 — last session's §8.3 recorded exactly that decision.
But the sentence printed `expectedOn` bare: **"On schedule · next closes
Sep 2"**, a day already gone, named as the next close. `StatementPull` carries
`readyOn` now (the loop's own sum, not a second derivation) and
`expectedHasPassed`; the row reads *"closes around Sep 2 on this rhythm —
counted as late from Sep 10"*, and the test pins that the status flips on that
exact day. On the predicted day itself the same branch fires ("Aug 31 … counted
as late from Sep 1"), which is also true: the PDF is not out on close day.

---

## 6. The periods list counted what the tiles did not

`/imports` fetched every `statement_periods` row and rendered three verdict
tiles from it — then listed "the 12 most recent" and "233 older" from the whole
table. The four extra are `not_applicable`: a Chase spending report (two), a
balance-less export, a first Robinhood Cash statement. Two of them were in a
list headed **"What the statements proved"**. They get their own sentence now
(*"4 imported documents carried no balance to check … and are neither a period
above nor in the counts"*) and the list and footer draw from the tiles' set:
12 + 230 = 242 = 202 + 40 + 0 after the import.

---

## 7. 🔴 The e2e fixture was in your backup rotation

`data/backups/daily-2026-08-29.db` — 3.9 MB against 14 MB for every real daily,
written Aug 28 at 10:47, describing itself on /settings as *"Ledger runs to
Wed, Jul 8, 2026 · 1,264 transactions · net worth $143,952.43 · categorised by
you 3"*. That is the e2e seed. The e2e server runs under
`TZ=Pacific/Kiritimati`, a day ahead, so it was stamped a day in the FUTURE —
and `prune` keeps the newest fourteen dailies by NAME, so it sat at the top of
the rotation and pushed a real daily out a day early, with a Restore button
beside it.

The e2e harness itself sets `MONEYAPP_BACKUPS_DIR` and `MONEYAPP_SKIP_BACKUP`
(since 2026-07-10); something on Aug 28 opened the fixture beside the real file
without them. The structural fault was `defaultBackupsDir()`: a FIXED folder,
whatever database was open. **The real archive belongs to the real database.**
`dailySnapshotDir(dbPath)` snapshots the real database beside itself and
anything else only where an explicit `MONEYAPP_BACKUPS_DIR` says to; boot says
on stderr when it skips. The stray file is moved (not deleted) to
`data/e2e-backups/stray-fixture-daily-2026-08-29.db`. Two mutants killed.

---

## 7b. Three more from the detail pages — a seed printed as an average, one word for three facts, a sentence that denied 33 statements

**The seed.** `recurring_series.amount_cents_avg` is the detector's measured
mean for a detected series — and, for a hand-registered one, the SEED written
at registration (`recurring-links.ts`), which then goes stale the moment the
owner corrects the amount. The lease was registered at $559.89 on 08-11 and
corrected to $695.04 on 08-31; `/categories/Car` and the All tab still read
the seed, beside an annualized figure built from the correction. Every surface
prints the EFFECTIVE amount now (`nextExpectedAmountCents`, user override
first — what the forecast projects), and the All tab shows *"posted avg"*
beneath it only where charges exist to average and it differs: the rent reads
*−$2,109.00 · posted avg −$2,285.70*, FPL *−$58.87 · posted avg −$14.21*. A
never-billed series shows no average, because it has none.

**One word for three facts.** `isSeriesActive` is "fresh": last charge inside
1.5 cycles plus grace. A series fails that three different ways, and the All
tab called all three "Inactive": the five never-billed commitments (nothing to
be stale FROM — the subscriptions card already says "never billed"), the weekly
pay (late, and money in never lapses), and a bill that has genuinely lapsed
(money out past three cycles — the only one the forecast has let go).
`seriesEvidence` names the four states by the SAME gates the forecast reads —
`lapsedSeriesShouldStopForecasting(kind) && seriesHasLapsed` reused, not
restated — and `lib/series-evidence` holds the vocabulary so the All tab, the
series badge and the category list cannot word it three ways. The All tab has
sections for each, with a note saying which are still forecast. On your ledger:
Active 5 · Running late 2 (Cash job, FPL) · Never billed 5 · Lapsed 0.

**33 statements, "nothing has closed".** `verifiedThrough` is the last trusted
day BEFORE the first untrusted one, so an account whose chain is unproven from
its first day has none — and `coverageDetail` rendered that as *"nothing has
closed on this account yet"*, on a page listing that account's July period as
reconciled. It reads *"nothing closes to the cent from its first day; the first
day it does not is Dec 5, 2023 — 52 days rest on an export with no closing
balance"* now, which is what the trust card's "52 days unchecked" has meant all
along.

Four mutants killed across the three, and a vocabulary test that forbids the
word "inactive" from ever coming back as a label.

A second full gate after these three: **598 passed, zero baseline movement** —
no fixture series is hand-registered, late or lapsed, and no fixture account is
unproven from its first day, so every one of the three is unit-tested only.
Another entry for the unreachable-in-the-fixture list.

---

## 7c. The second pass — five more, and a convention to be aware of

The Sapphire credit balance from §1 is what surfaced four of them. A card the
bank owes you on is a liability-type account with a positive balance, and five
surfaces had five different arithmetic for it:

    header          Liabilities $842.89        net of the credit, by account type
    Assets/Owed lines                          net, by account type
    runway          −$842.89                   net, by type — the line now says "net of $82.72 in credit"
    cards card      $842.89 / slices of $925.61  net headline, gross slices (§4)
    terrain         $925.61 owed / $114,581.69 held   GROSS, by sign — the one that disagreed with its own page
    account insight "55.3% of everything you owe"    a share of |−557.62| + |−367.99| + |+82.72| = $1,008.33

The terrain moved to the page's convention (by side; a row in credit reads
"Owed · in credit"), and the account insight now shares the $925.61 actually
owed and gives a card in credit no share of a debt.

⚖️ **The convention is by TYPE, netted within a side, and that is a choice.**
"Liabilities $842.89" is what your liability accounts net to, not what you owe
the two banks that are owed ($925.61). The cards card says both. A pure by-sign
reading would put "Liabilities $925.61" on the header — but the daily Assets and
Amount-owed lines are built per account type with per-line coverage
(`lib/multi-series`), and splitting them by sign per day changes what "covered"
means for each line. Not done; if you want the header to read $925.61, that is
the change, and it is not small. ⚠️ Latent under the type convention: if card
credits ever exceed card debts, "Liabilities" prints a NEGATIVE figure. Not
reachable on your ledger today.

The other two: the MSFT page's "▲ +$4,468.50 (−5.95%)" — a dollar gain and a
time-weighted return, true together and unnamed — names the percentage now; and
/summary's gambling note said losses were not spending on a page whose spending
figure includes them ($639.66 of 2025's $41,501.86). It says the narrower true
thing now.

---

## 8. ✅ The two decisions — asked with the measurement, answered, done

### 8.1 ✅ APPLIED — PROGRESSIVE INS $357.58 (2026-08-12) attached to "Car insurance"

You said attach it. `scripts/attach-progressive-insurance.ts --apply` ran
behind `data/backups/pre-2026-09-03T150653-manual-backup.db`: 2 rows changed
(the transaction's `recurring_series_id` + `series_link_source = 'user'`, and
the series' `last_matched_on = 2026-08-12`), `next_expected_on` untouched at
Sep 11, ledger-check exit 0 after. Live: the subscriptions card reads *"Car
insurance · last seen 2026-08-12"*, the car card's up-front figure is
**$6,100.00**, /recurring says *"3 have never charged"*. The measurement that
justified it:

You registered the series on 2026-08-31 from payment #2, because #1 "was
already paid 2026-08-11 on Venture X". It was — and it is in the ledger, filed
by hand under Car > Car Insurance, unlinked. Consequences on your screen today:

- dashboard SUBSCRIPTIONS: *"Car insurance — never billed"*, and *"$1,461.69
  of the figure above — 38.9% — has never been billed by a bank"*
- dashboard WORTH A LOOK, one card away: *"Progressive Insurance appears once
  in your ledger, for $357.58"*
- /recurring: *"4 have never charged"*
- THE CAR: *"Paid up front, spread over the lease $6,457.58"* includes it

`scripts/attach-progressive-insurance.ts` links the row and stamps the series'
`last_matched_on` (2026-08-12); `next_expected_on` stays Sep 11, so nothing
forward moves. Guards: the row by id, date, amount, description, category,
account, status and "not yet linked"; the series by id, name, status,
`next_expected_on` and "no linked rows". Rehearsed on a copy:

    REHEARSED on a copy — 2 rows changed
    car card, paid up front   $6,457.58 -> $6,100.00
    car card, a month all in  $1,325.60 -> $1,310.70
    car card, lease+insurance $1,056.53 -> $1,056.53
    subscriptions, insurance  never billed -> last seen 2026-08-12
    subscriptions, never-billed $1,461.69 -> $1,100.20
    subscriptions, monthly     $3,753.08 -> $3,753.08

⚠️ **The statement says $357.58; the series says $361.49** (your figure, from
memory, confirmed once when two numbers conflicted). If Sep 11 posts at $357.58
too, the series' tolerance decides whether it matches — §0 asks you which.

### 8.2 ✅ DONE — the system category "Uncategorized" is the NULL bucket

    2023-11-02  SoFi Savings   −$0.35  Direct Payment CAPITAL ONE ACCTVERIFY
    2023-11-02  SoFi Savings   +$0.11  Deposit CAPITAL ONE ACCTVERIFY
    2023-11-02  SoFi Savings   +$0.24  Deposit CAPITAL ONE ACCTVERIFY
    2024-03-28  SoFi Checking −$73.10  Debit Card MERPAGO*GONZALEZ
    2024-06-18  SoFi Checking −$12.00  Debit Card LORILLARD DEVELOPMENT
    2024-07-02  SoFi Checking  −$7.62  Debit Card CONRAD HOTEL N Y

All six are `categorization_source = user`. The seed's "Uncategorized" is a
`system`-kind category, and analytics classifies spending as *expense-kind rows
plus NULL-category outflows* — so a row filed ON that category is in neither
the headline nor the honesty bucket, and its **$92.72 of debits appear in no
total anywhere**. The dashboard's "31 transactions have no category yet" counts
NULL; `/categories` shows "Uncategorized · 6 txn"; the ledger's Uncategorized
filter shows NULL. Three surfaces, two definitions of one word.

You chose (b), and it is in (`fix(categories)`): `CategoryIndex` carries
`uncategorizedIds` / `isUncategorized`; `activeTxnsInRange` normalises at the
source so every aggregate built on it agrees; `uncategorizedWhere` is the SQL
form for the ledger's filter, the dashboard's count and the coverage figure;
spending's allocation guard and the forecast's variable leg apply the rule to
rows they read themselves; and picking "Uncategorized" in the picker now writes
NULL as a user decision and teaches no merchant, so nothing lands on the system
row again. No write to the six rows — they read as uncategorized where they
are. Twelve mutants killed, and the one test that asserted the old rule now
asserts yours.

    dashboard    "31 transactions have no category yet"  ->  37
    /categories  "Uncategorized · 6 txn"                  ->  37 txn
    /transactions coverage                                99.7% -> 99.6%
    /summary/2024 spending                                $30,266.93 -> $30,359.65   (+$92.72, to the cent)

---

## 9. ⚖️ Looked at and deliberately did NOT change

1. **The Robinhood group row on the dashboard: "3 accounts · as of 2026-09-02"
   over "+$585.31 Aug 28 vs Aug 27".** The total sums each child at its own
   newest day; the change is measured on the combined series, which ends on
   the newest day EVERY child covers (Robinhood Cash, Aug 28). The 09-01 session
   named the change's days for exactly this reason and left `asOf` as the
   newest child, with a docstring saying so. It is still two dates on one row,
   and a judgement about the label rather than a wrong number.
2. ~~The dashboard's WHAT CHANGED note skips August in silence~~ — fixed after
   you answered (§2 row 11): *"Aug 2026 is complete, but not every account you
   spend from has been imported through its last day — so these read Jul 2026
   rather than Aug 2026."*
3. **The category picker still offers "Uncategorized"** — deliberately: it is
   now the way to say "leave this one category-less", and writes NULL.

---

## 10. Notes that cost time, and would again

- ⛔ **A function with two callers can mean "today" for one and "the last day
  read" for the other.** The payday rule was right for the running day and
  wrong for the as-of day, and only the second caller's tests said so. When a
  boundary moves, run every caller's tests before believing the first file.
- ⛔ **The Browser pane went blank mid-session** ("(empty page) Viewport:
  0x0") — the memory's warning holds. A ten-line Playwright script from
  `.trial/` (gitignored) is the reliable way to press a button or read a
  sentence on the running app.
- ⚠️ **`readonly` DB copies via `sqlite.backup` are safe beside the dev
  server**; the confirmed import is not, and the server was stopped for it
  and restarted detached (`nohup pnpm dev &`), so it outlives this session.
- ⚠️ **The stray backup was named by ANOTHER process's clock.** `todayIso(now)`
  ignores `MONEYAPP_FAKE_TODAY` when handed a `Date`, so the name came from the
  wall clock — in Kiritimati. A file in a rotation can be dated by whatever
  process wrote it, which is why the rotation now checks WHOSE database it is
  rather than trusting the name.
- ⚠️ `npx vitest run --maxWorkers=4` — 4,531 in ~25s; tsc clean; coverage
  gate exit 0 (`npx vitest run --coverage --maxWorkers=4`).
- ⛔ The dev server on :3000 is left running, as it was found.

---

## 11. What was measured, and when

Every figure here is **as of 2026-09-03**. Crypto re-priced intraday during the
session: net worth read $110,844.17 on the first dashboard read and
$113,656.08 after the import, of which $82.72 is the import and the rest is
ETH. Any figure standing on the portfolio moved without a write.

Confirmed live after the fixes, read off the page text:

    /budgets     "$0.00 in so far, $4,188.00 still expected" · "4 paydays … $4,188.00"
    dashboard    "13 paydays, Jun 4 – Aug 27" · "$1,447.00 of $13,611.00 implied" · "12 paydays have passed since Jun 5"
    dashboard    "$557.62 60% of it" · "$367.99 40% of it" · "$82.72 of credit on Chase Sapphire is netted off…"
    /imports     "closes around Sep 2 on this rhythm — counted as late from Sep 10"
    /imports     "230 older periods are not listed." · "4 imported documents carried no balance to check…"
    /settings    the fixture snapshot is gone from the rotation
    dashboard    "37 transactions have no category yet" · /categories "Uncategorized · 37 txn" · coverage 99.6%
    /summary/2024 "Spending in 2024 came to $30,359.65"   (was $30,266.93 — +$92.72, the six rows)
    dashboard    "Car insurance · last seen 2026-08-12" · car card "Paid up front … $6,100.00" · /recurring "3 have never charged"
    /recurring?tab=all   ACTIVE 5 · RUNNING LATE 2 · NEVER BILLED 5 — "Car lease … -$695.04", "Cash job … +$1,047.00 · posted avg +$1,046.00"
    /categories/Car      "Car lease · monthly · next Sep 15 · never billed · $695.04"
    /imports     Robinhood Cash: "nothing closes to the cent from its first day; the first day it does not is Dec 5, 2023 …"
    dashboard    "Aug 2026 is complete, but not every account you spend from has been imported through its last day — so these read Jul 2026 rather than Aug 2026."
    /accounts/Discover   "Discover is 60.2% of everything you owe."
    dashboard    terrain "$114,498.97 held, $842.89 owed" · "Chase Sapphire · Owed · in credit" · header "Liabilities $842.89"
    dashboard    "Less what you owe on cards, net of $82.72 in credit"
    /investments/stock/MSFT   "(-5.95% time-weighted)" · "Thu, Sep 3, 2026: +$4,468.50, -5.95% time-weighted"
    /summary/2025 "Counted in none of the money-in totals above: winnings are not treated as income here. Losses are spending …"

---

# 📋 THE PROMPT FOR THE NEXT SESSION

> Read `docs/HANDOFF-2026-09-03-the-payday-that-had-not-happened.md` first —
> it is the brief. §0 of it is the job.
> Repo `/Users/rayankarimcheca/dev/MoneyApp`, `main` clean and pushed. Baseline:
> 4,547 unit in ~25s · tsc clean · coverage gate exit 0 · `E2E_GATE=1`:
> 598 passed at `maxDiffPixels: 0` in 8.1m · `pnpm ledger-check` exit 0 on
> every commit. Ledger: 10,178 active rows · 37 uncategorized.
>
> One question is waiting on me (§0.1: is the insurance premium $357.58 or
> $361.49?). Otherwise the job is the same as the last five sessions: find
> what is wrong. Do not invent features.
>
> 1. ⭐ OPEN THE APP AND READ IT BEFORE YOU GREP IT. Five of this session's
>    seven came from reading sentences; a sixth from reading a backup's own
>    description on /settings.
> 2. A scheduled occurrence dated TODAY is future until its money has posted
>    today — on every surface. Grep for `today` in every function that walks
>    a schedule, and check what "today" means to EACH caller.
> 3. Read a BASELINE as a sentence, not as pixels.
> 4. If you find a decision, put it to me EARLY with the measurement.
> 5. HOSTING goes last. Never propose a hosted-DB migration.
>
> How I want you to work: ONE long session, ONE handoff at the very end;
> commit and push to `main` between items without asking; no fabricated
> numbers, re-derive rather than quote; mutation-test every new guard; explain
> a visual diff before regenerating a baseline; the pre-commit hook runs
> `ledger-check`, NOT coverage; before making any control persistent, grep for
> the tests that PRESS it; real-DB writes rehearse on a copy, show me, then ask;
> I run my own dev server on :3000 — standing permission to stop it; put it
> back, detached.
>
> Rules that keep biting: ⛔⛔ `BTLEServer` at 100% for 52 days, reboot ·
> a fixture that cannot express a condition cannot test it · a test can ENCODE
> the bug · a disclosure underneath does not undo a wrong number on top · grep
> for who else answers a question before fixing one caller · `react`'s `cache`,
> never a module Map · `git checkout -- <file>` destroys uncommitted work ·
> TWO DEFINITIONS OF SPENDING · `user_category_id` is an OVERRIDE · my income
> is cash I spend; $0 recorded is correct · arrears stay scoped to the calendar
> month (decided 2026-09-02) · `pnpm e2e` refuses a stale `.next` — use
> `pnpm e2e:fresh`.
