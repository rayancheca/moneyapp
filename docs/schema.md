# MoneyApp — Data Schema (v2 — approved 2026-07-08; implemented in src/db/schema)

This is the single shared schema every module reads and writes.
SQLite via Drizzle ORM + better-sqlite3.
Post-approval addenda (documented below, shipped as migrations): `holding_events` (Phase 7
crypto quantity timeline) and `balance_anchors.import_file_id` (un-import lifecycle provenance).
v2 incorporates the adversarial-review fixes (investment reconciliation, dedupe stability,
import lifecycle, anchor precedence, ownership takeover semantics).

## Global conventions

- **IDs**: `TEXT` UUIDv7, generated in app code. Chosen over autoincrement so a future
  sync/hosted mode can merge databases without key collisions (no rewrite later).
- **Ledger money**: `INTEGER` cents. Never floats for money.
- **Market data** (prices): `REAL`. Prices are observations, not ledger entries; computed
  values are rounded to cents at the edge.
- **Quantities** (shares/crypto): `INTEGER` in 1e-8 units — exact, covers fractional shares and ETH.
- **Dates**: `TEXT 'YYYY-MM-DD'` for financial dates. Timestamps: ISO-8601 UTC. All tables
  carry `created_at`/`updated_at` (not repeated below) — exemptions: `daily_balances`
  (rebuildable cache, no timestamps), `ai_calls` (append-only, `created_at` only),
  `app_settings` (`updated_at` only).
- **Enums** are enforced at the application level (Drizzle column enums + Zod at every
  boundary), not as SQL CHECK constraints — non-app writes to the DB file are out of contract.
- **Weeks**: ISO (Monday start). A transaction belongs to the period containing `posted_on`, full stop.
- **Sign convention**: every amount and balance is signed from the **net-worth perspective**.
  Positive = increases net worth; negative = decreases. Credit-card balances stored
  **negative**; a card purchase is negative; a card payment is `+X` on the card, `−X` on
  checking. Parsers normalize each institution's convention at the boundary.

## Reconciliation identities (scoped by account type)

- **Cash & credit accounts**: `beginning_balance + Σ(transactions in period) = ending_balance`,
  to the cent. Failure ⇒ `gap` ⇒ quarantine.
- **Investment accounts**: market movement is not a transaction, so the cash formula can
  never close. Instead: `beginning_value + Σ(cash-flow txns: contributions, withdrawals,
  dividends, interest, fees) + market_change = ending_value`, where `market_change` is
  **computed and stored** (`statement_periods.market_change_cents`) and displayed — never
  treated as a gap. Investment statement periods are primarily **value anchors**; their
  transactions (dividends, interest, transfers) flow to income/transfer analytics normally.
  Buys/sells are internal (net-worth-neutral) and never enter balance replay.

## Entity relationship overview

```
institutions 1─* accounts 1─* transactions ── * merchants ── categories (tree)
                     │            │                │
                     │            │            merchant_aliases
                     │            ├── transfer_group_id (pairs legs)
                     │            └── recurring_series
                     ├─* balance_anchors ──── statement_periods ──── import_files
                     ├─* daily_balances (derived cache)
                     └─* holdings ──── price_cache (by symbol + asset_type)
budgets ── categories        rules (ordered)        ai_calls        app_settings
```

## Tables

### institutions
`id PK` · `name UNIQUE` (Chase, Discover, Capital One, SoFi, Robinhood)

### accounts
| field | type | notes |
|---|---|---|
| id | TEXT PK | |
| institution_id | FK | |
| name | TEXT | "Chase Checking" |
| type | enum | `checking` \| `savings` \| `credit` \| `investment` |
| subtype | enum nullable | `brokerage` \| `crypto`. Robinhood = **two** accounts |
| last4 | TEXT nullable | matches files to accounts |
| currency | TEXT | `USD` |
| is_active / display_order | | |
| cash_account_id | FK→accounts nullable, UNIQUE | set on a **brokerage book** only: the cash account whose statement section proves the book's positions (Robinhood Agentic's book). The import creates the book and finds it by this link, never by name |

Liability status **derived** from `type='credit'`. Debit cards are intentionally not accounts.

### account_numbers
A number, other than `accounts.last4`, that the account's statements print — a card reissued under
a new number (Venture X: 9082, then 4147, now 4208). An import matches a statement's printed number
to `accounts.last4` first, then to exactly one account here; a number two accounts once printed
names neither. `id` · `account_id` FK · `last4` · UNIQUE(account_id, last4).

### import_files — with an explicit lifecycle
| field | type | notes |
|---|---|---|
| id | TEXT PK | |
| file_name / file_sha256 / storage_path | | files copied to `data/originals/` |
| format | enum | `csv` \| `ofx` \| `qfx` \| `pdf` (archives, e.g. Robinhood "Download my data" ZIPs, are unpacked **before** sniffing; members become individual import_files) |
| institution_id | FK | |
| parser_profile | TEXT nullable | e.g. `chase-card-csv`; null until format sniffing assigns one |
| parser_version | INTEGER default 1 | bumped when a profile's logic changes; drives the re-parse lifecycle |
| status | enum | `parsed` \| `failed` \| `needs_claude` \| `parsed_with_claude` \| `superseded` |
| superseded_by | FK nullable | re-parse lineage |
| error / imported_at | | |

**Lifecycle rules** (the quarantine repair loop must never dead-end):
- The idempotency no-op applies per **(file_sha256, parser_version)** — a byte-identical file at
  the same parser version is a `skipped_duplicate`, and a fixed parser can always re-parse it.
- **Re-parse** (a higher `parser_version` for the same `file_sha256`): the old file's periods and
  anchors are removed, its transactions become `superseded` (retained as history, never deleted),
  the old import_file row becomes `superseded`, and the file's fresh rows are written — all in ONE
  transaction, and only once the new version has read the file. A version that cannot read the
  file, or fails part-way through it, changes nothing: the old read stays in place beside the
  `failed` row, which says so.
- **Carry-forward is what makes a re-parse safe.** The old rows' user-set attributes are
  snapshotted *before* they are superseded, then re-attached to the new rows by content match:
  same **(account, posted_on, amount_cents)** — the money's identity, which survives a parser
  fix that reads the description differently — with the normalized description only *ranking*
  candidates when a day holds several equal amounts, and multiset consumption so one old row
  feeds at most one new row. What travels:
  - `category_id` where `categorization_source='user'` (with its `merchant_id` and
    confidence, because categorizeAll never revisits a user-categorized row); where it is
    `claude` or has NO recorded source (with its merchant, confidence and `needs_review`) onto a
    row the new parser gives no category — an import never calls Claude, and no engine sets a
    sourceless one; and where it is `transfer_detect` together with the transfer group —
    detection pairs only ungrouped rows, so it never reads the row again
  - `notes`, `transfer_group_id`, `recurring_series_id` + `series_link_source`
  - `status='excluded'` — a user's exclusion is a decision, not a parse artifact
  - `file_link_source='attached'`, onto the row the re-parse inserts for that money only — the
    owner's reconstruction stays his, so a later un-import still keeps it (never filled onto
    another file's row, never taken from a takeover victim). An attached row no line of the
    re-parse claims (a section it withholds, an account or a line it no longer reads) is not
    superseded at all: it is detached as an un-import detaches it, and filed again under the
    statement that holds its day.
  - `transaction_splits`, moved wholesale onto the new parent (same amount ⇒ the parts still sum;
    the parent stays immutable)

  What does **not** travel: a detected category (rule/merchant/bank/credit — re-derived once
  the batch settles, so carrying one would freeze a stale guess), `needs_review`, and
  `quarantined` status (a reconciliation verdict on the *old* file's period). A user category is
  never downgraded: when the new row's money is already represented by another file's row, the
  carry only **fills** attributes that row lacks. The per-file `carriedForward` count in the
  import outcome makes every carry visible.
- **Un-import** is a first-class operation: removes the rows the file **parsed**, its periods,
  and its anchors atomically. An anchor is written once per (account, day, source) and owned by
  the file that wrote it last, so a statement anchor another file's printed period still prints
  (the neighbouring statement's opening or closing day, or a second download of the same
  statement) is handed to that period instead — on a re-parse as on an un-import — and the
  confirmation counts only the balances that go. A statement **downloaded twice** is kept once:
  the second download adopts the first one's period and its lines dedupe against the first
  one's rows, and it records what it prints (`statement_copies`). Un-importing the download that
  holds the statement hands its period, the rows the other download prints (every attribute on
  them kept) and the rows filed by hand on the period's days to the most recently imported
  other download that is still parsed, which is no longer a copy on that account (on another
  account it may still be a copy of a different file's period); only un-importing the last
  download removes them. A
  re-parse hands over the period alone, and only lends it: the new read writes the rows again,
  takes the period back where it writes it again (the other download stays recorded as a copy),
  and a period it no longer writes (a section it now withholds, an account it no longer reads)
  stays with the other download — with the retired rows the other download prints that no live
  row records, each back with the status it had, as an un-import hands them over; the rows filed
  by hand on its days are filed under it too, and the other download is no longer a copy of it.
  One rule for every file, the agent's brokerage book included.
  More generally, every import records **every line it prints** (`printed_lines`), whichever
  row ends up recording it — its own, one another record already held (absorbed), or one a more
  trusted file owns. Un-importing a file hands each of its parsed rows that a still-imported
  file needs to another file that prints it (re-filed, every attribute kept): each such file's
  lines are matched to the account's rows, and a line only the un-imported file's rows can record
  takes one of them — a statement whose period holds the row's day first, then the most recently
  imported. A line another record already holds takes nothing. So un-importing an export keeps
  the rows the statements imported after it print, and those statements' periods stay
  reconciled; importing the export again takes its rows back (a takeover retires the row the
  same line wrote before — same `dedupe_hash` — first). A **takeover** is the same case: the
  file that took over a still-imported file's rows is un-imported, and the rows that took over
  (carrying everything the owner had set on the rows they replaced) stay, filed under the file
  that prints their lines (owner, 2026-09-16). A live file with no `printed_lines` record on the
  account (imported before the table, and not readable again at its version) is known to print
  at least the lines of its own parsed rows a takeover retired (not the copies a duplicate verdict
  retired: the duplicate lifecycle puts those back).
  A **transfer** the un-import takes apart (a deleted leg whose partner stays alone, or a pair
  whose legs were all the file's) is kept in `unimported_transfer_legs` — the deleted legs by
  content and the category the pair gave them (with its merchant), the staying leg by id — and
  linked again, with that category, when an import writes the same lines; a staying leg the owner has linked
  elsewhere meanwhile ends it. A staying leg whose own file is un-imported (or re-read at a new
  parser version) is kept by content from then on, and a leg that comes back before the others
  takes back its category and waits by id — so both files of a pair can be round-tripped, in one
  upload or one at a time. A staying leg **filed by hand** is not its file's to retire: a re-read
  that prints its line again carries it onto the row it writes, and the transfer waits by that
  row; one that no longer reads its account keeps it, and the transfer waits by it still (owner,
  2026-09-16).
  Those rows leave the database (a pre-mutation snapshot is taken so the operation is
  recoverable), but what was set on them does not: each deleted live row carrying anything the
  carry-forward moves — a category no engine of an import sets again, a note, a recurring link or
  a "not this one", an exclusion, splits — is kept in `unimported_row_attributes`, and an import
  that writes the same line again (same account, amount and posted — else transacted — day, and
  the same `dedupe_hash` or words that describe the same charge) takes it back, as a re-parse
  takes its predecessor's; the record is then spent. A line that takes over another file's row,
  or that another row absorbs, spends the record too, but only fills what that row leaves empty
  (the row is the live record of the money and holds the owner's work since; a re-parse carry
  fills an absorbing row the same way). A row filed under the file because the file prints its
  money (another file wrote it) is kept in the words of the line the file prints for it. A
  transfer leg's hand category is the pair's and is not kept here; a category, merchant or series
  deleted meanwhile is not given back (owner, 2026-09-16).
  A row **filed by hand** (`attached`) is never a takeover victim: like any row entered by hand,
  it absorbs the more trusted file's line.
  A row **attached** to the file (`file_link_source = 'attached'`: recorded without the document,
  then filed under the statement that prints it — the importer never writes the marker) is not
  the file's to delete. It is **detached**: `import_file_id` NULL, the marker kept, every other
  column untouched, a quarantined row made `active`. Importing a statement whose printed-balance
  period (beginning and ending balance) holds its posted day files it there again; a day two
  such periods hold leaves it detached (owner, 2026-09-15).
- Imported transactions are **immutable** in amount/date/description. Corrections happen via
  re-parse or an explicit manual-adjustment transaction — never in-place edits (in-place
  edits would silently break dedupe and reconciliation).

### statement_copies
A statement another file already holds, printed again by `import_file_id` (a second download in
different bytes). Written by the import when it adopts another file's period; read by un-import
(`services/import/statement-copies`).
| field | type | notes |
|---|---|---|
| id / import_file_id / account_id | | UNIQUE(import_file_id, account_id) |
| period_start / period_end | date | the period's content key — never `statement_periods.id`, which a re-parse of the holder rewrites |
| lines | JSON | what the copy prints on the account: `posted_on`, `transacted_on`, `amount_cents`, normalized description per line |

### unimported_row_attributes
What the owner had set on a row an un-import deleted, until an import writes the same line again
(`services/import/unimported-attributes`). No foreign keys: a category, merchant, series or
account may be deleted while a record waits; an import gives back what still exists, and a
brokerage book removed with its last statement takes its records with it.
| field | type | notes |
|---|---|---|
| id / account_id | | |
| posted_on / transacted_on / amount_cents / normalized_description / dedupe_hash | | the line's identity, as the carry-forward matches it — the words are the ones the un-imported file prints for the row's line (`printedWordsOfRows`), which differ from the row's only for a row another file wrote |
| category_id / categorization_source / categorization_confidence / merchant_id / needs_review | | only a category no engine of an import sets again: `user` (with no category: "Uncategorized" picked by hand), `claude`, or no source — never a transfer leg's hand category, which is the pair's (`unimported_transfer_legs`). A line that takes over another file's row, or that another row absorbs, spends the record: it only fills what that row, the live record with his work since, leaves empty |
| notes / recurring_series_id / series_link_source | | a link, or a detach (no series, `user`) |
| excluded | boolean | |
| splits | JSON nullable | `[{ categoryId, amountCents, note, sortOrder }]` |

### printed_lines
Every line `import_file_id` prints on an account, recorded by the import (and, for the files
imported before the table existed, by `scripts/record-printed-lines.ts`); read by un-import
(`services/import/printed-lines`). Forgotten when the file is un-imported or retired by a re-read.
A line printed with no transaction day also matches a row TRANSACTED on its day (a statement line
printed before its period opens is stored on the period's first day). Of rows of the line's money,
one posted on the day the import stored the line on outranks one posted on the day it prints: a
statement's lines all posted inside its period.
The three records (`account_numbers`, `statement_copies`, `printed_lines`) are not filled by a
migration: a Settings restore of a snapshot older than them records them again from the
originals (`services/import/import-records`), and `pnpm ledger-check` fails while a parsed file
read at its profile's current version has no `printed_lines` record, naming the three backfills.
Each backfill opens — and so migrates — the ledger itself; run them in that order (account
numbers, copies, lines), then `pnpm ledger-check`.
| field | type | notes |
|---|---|---|
| id / import_file_id / account_id | | UNIQUE(import_file_id, account_id) |
| lines | JSON | per line: `printedOn` (the day printed), `postedOn` (the day stored), `transactedOn`, `amountCents`, normalized description |

### statement_periods
| field | type | notes |
|---|---|---|
| id / import_file_id / account_id | | UNIQUE(import_file_id, account_id) |
| period_start / period_end | date | |
| beginning_balance_cents / ending_balance_cents | INTEGER nullable | net-worth-signed |
| market_change_cents | INTEGER nullable | investment accounts: the computed plug (see identity above) |
| reconciliation | enum | `reconciled` \| `gap` \| `accepted` (user override) \| `value_anchor` (investment) \| `not_applicable` (no balances in file) |
| gap_cents | INTEGER nullable | shown to user when ≠ 0 |

**Period membership is by date-range** — reconciliation sums active transactions with
`posted_on` in [period_start, period_end] for the account, regardless of which file
contributed them. `transactions.statement_period_id` is **provenance-only**.
**Boundary-drift rule**: when a gap exactly equals the sum of transactions within ±1 day of
a period boundary contributed by a different source, the importer proposes re-dating them —
**statements are the date authority** for period membership.

### transactions
| field | type | notes |
|---|---|---|
| id / account_id / import_file_id (nullable) / statement_period_id (nullable, provenance) | | |
| posted_on / transacted_on (nullable) | date | |
| amount_cents | INTEGER | net-worth-signed |
| raw_description | TEXT | byte-exact from the file, never modified |
| normalized_description | TEXT | normalizer output (versioned; used for matching, **not** dedupe) |
| bank_category | TEXT nullable | Chase/Discover/CapOne CSVs ship a category column — kept as a cheap prior for the categorization pipeline; a line absorbed by another record gives it its bucket where that record has none |
| merchant_id / category_id | FK nullable | |
| categorization_source | enum nullable | `user` \| `rule` \| `merchant_map` \| `claude` \| `transfer_detect` \| `credit_match` |
| categorization_confidence | REAL nullable | |
| needs_review | bool | |
| status | enum | `active` \| `quarantined` \| `excluded` \| `superseded` (replaced during source takeover/re-parse; kept for audit) |
| transfer_group_id | TEXT nullable | |
| recurring_series_id | FK nullable | |
| fitid | TEXT nullable | corroborator only — unstable across channels, absent for Discover/SoFi |
| occurrence_index | INTEGER | see algorithm below |
| dedupe_hash | TEXT | sha256 over (account_id, posted_on, amount_cents, **raw_description**, occurrence_index) in a length-prefixed canonical encoding — field boundaries cannot be forged by descriptions containing the separator |
| notes | TEXT nullable | |

UNIQUE(account_id, dedupe_hash) among non-superseded. Indexes: (account_id, posted_on),
(category_id, posted_on), (merchant_id), (transfer_group_id).

**Why raw_description in the hash**: raw text is byte-stable across exports of the same
format, which is the only case content-hash dedupe is trusted for. The normalizer will
evolve constantly; hashing its output would duplicate history on the next overlapping
import (review finding). Cross-format matching is the ownership policy's job, not the hash's.

**occurrence_index algorithm** (deterministic, documented, tested): within the incoming
file, identical `(account_id, posted_on, amount_cents, raw_description)` rows are numbered
0..n−1 in file-row order. On insert, collide-and-skip per index. When two sources disagree
on the count of identical rows, the higher count wins and the discrepancy is flagged;
reconciliation is the backstop.

**Cross-format ownership policy** (same purchase worded differently in QFX vs CSV vs PDF):
- Fidelity priority: `OFX/QFX > CSV > PDF`. Transactions import only from the primary
  source covering a range; lower-priority files contribute balances/anchors, validation,
  and gap-fill only.
- **Covered range** per format: OFX = declared DTSTART/DTEND; CSV/PDF = [min, max] observed
  row dates — never the range the user requested (silent truncation defense; row counts are
  also cross-checked against statement periods).
- **Demotion rule**: if a period owned by a higher-priority source fails reconciliation and
  a lower-priority source covers it, ownership for that period falls through so (e.g.) PDF
  rows can fill the hole — subject to the fuzzy review queue.
- **Takeover rule** (files arrive in any order): when a higher-priority file later covers an
  owned range, its rows are content-matched (date ±1, amount, description similarity)
  against existing ones; user-set attributes migrate to the new rows; unmatched old rows go
  to the fuzzy review queue; replaced rows become `superseded`. **Invariant: importing the
  same file set in any order permutation yields an equivalent database.**
- Residual cross-source pass flags probable duplicates for review — never silently deletes, and
  never picks a winner. Matching is same account, same amount, **same day** (post-to-post, or
  transaction-to-transaction when both rows carry one), from two DIFFERENT sources, with a
  non-zero description score. **Not date ±1**, which this doc prescribed until pass 35: measured
  against the real 9,827-row ledger, a ±1 window pairs two distinct month-end ETH buys (0.003247
  vs 0.003508 ETH, both $9.90, both normalizing to the same text) — 22 rows, mostly false. A pair
  inside a `reconciled` statement period is exempt: that period's arithmetic already proves its
  money to the cent (see `src/services/duplicate-flags.ts`).

### balance_anchors
| field | type | notes |
|---|---|---|
| id / account_id | | |
| anchored_on | date | |
| balance_cents | INTEGER | net-worth-signed |
| source | enum | `statement` \| `ofx_ledger` \| `manual` \| `live` \| `unimported_statement` |
| statement_period_id | FK nullable | |
| import_file_id | FK nullable | the file the anchor dies with on un-import |

UNIQUE(account_id, anchored_on, source).
**Precedence on the same date: `statement > ofx_ledger > manual > live`.** Only the winning
anchor is a chain endpoint; lower-precedence same-date anchors become validation-only, and a
conflict above a small cent-threshold surfaces in the review queue (e.g. your Phase-1
hand-entered balance vs the statement that later covers that date). `ofx_ledger` and `live`
anchors are **moments, not end-of-day values** — they are excluded from exact chain-closure
checks (tolerance = that day's activity) and `live` is only ever written for *today*.

**`unimported_statement` — a kept opening (owner decision 20, 2026-09-17).** Un-importing a
statement whose rows stay under another still-imported file (`printed_lines`), and which leaves
the account with no other anchor, keeps the OPENING balance that statement printed (its own
period's beginning balance, on `period_start − 1`) as one anchor of this source, owned
(`import_file_id`) by the file that keeps the most of its rows, with no `statement_period_id`.
Never a closing, never a balance no statement printed, never on an investment account, and
never for a file with no printed period. It ranks below `live`, and it is neither an endpoint
nor a moment: the replay starts from it only when the account has no other anchor, and every
day it carries — its own included — is `derived_unverified`, so no surface reads it as checked
and `ledger-check` counts it as no witness. It goes when an import records its day again
(re-importing the statement), when the file that owns it is un-imported, and when a re-read of
that file no longer writes a row on the account (a re-read that still does moves it to the
successor). Wells Fargo Everyday Checking: un-importing `2026-08-25-everyday-checking.pdf`
keeps its $0.00 opening for 2026-07-26 under `rocket-money-export-2026-08-25.csv`, and net
worth stays 11,312,501 cents (a backfilled copy of the real ledger); `ledger-check` then fails
on exactly the two statement anchors, one window and one period that left (the kept opening is
not counted) — a removal he asked for, so the case `--lower-marks=chain-endpoints,chain-windows,statement-periods`
exists for, and only once he has actually un-imported it.

### daily_balances (derived cache — rebuildable at any time)
| field | type | notes |
|---|---|---|
| account_id / day | PK | |
| balance_cents | INTEGER | |
| basis | enum | `anchored` \| `derived` (replay between two anchors, chain verified) \| `derived_unverified` (backward replay before the earliest anchor — no closure guarantee; upgraded when an earlier anchor arrives) \| `carried` (step-hold between sparse anchors, styled as approximate) \| `gap` (no coverage — rendered as a gap, never invented) |

Derivation: between consecutive winning anchors, replay transactions and verify closure;
before the earliest anchor, replay backward (`derived_unverified`). Transaction segments
unreachable from any anchor render as `gap` for **balances** while their transactions remain
fully visible in analytics. Cash/credit accounts use replay; **brokerage** accounts step-hold
between statement anchors (v2: holdings × historical prices); the **crypto** account derives
directly from the ETH quantity timeline × cached daily closes (v1 — see master plan Phase 7).

**Net worth series**: a day's total is **complete** only when every active account has
non-gap coverage; incomplete days render as a dashed/partial segment annotated
"partial (N of M accounts)" — the total never silently drops an account (review finding).

### categories (tree, subcategories on)
`id · name · parent_id (one level, enforced in code) · kind (expense|income|transfer|rewards|investment|system) · icon · color · is_system · is_archived · sort_order` — UNIQUE(parent_id, name) **plus** a partial unique index on (name) WHERE parent_id IS NULL (SQLite treats NULLs as distinct, so root categories need their own guard).

**Archive semantics** (enforced at archive time): archiving deactivates budgets on the
category, flags merchant defaults and rules targeting it for re-pointing, removes it from
categorization suggestions and Claude's taxonomy — while history keeps rendering and rolling up.

### merchants
`id · canonical_name UNIQUE · default_category_id · mapping_source (user|claude|seed)` — user wins, permanently.

**Direction guard** (refund-poisoning defense): a user correction on a transaction whose
sign opposes the merchant's dominant sign updates **that transaction only** — the merchant's
default mapping changes only on explicit confirmation. Merchant refunds stay in the
merchant's expense category as negative spend; `Income > Refunds & Reimbursements` is
reserved for genuinely category-less reimbursements.

### merchant_aliases
`id · merchant_id · pattern · match_type (exact|prefix|contains) · priority` — UNIQUE(pattern, match_type). Grows with every import; why Claude calls decay to zero.

### rules
`id · name UNIQUE · priority · is_enabled · conditions JSON {descriptionContains?, descriptionRegex?, accountIds?, amountMinCents?, amountMaxCents?, direction?} · actions JSON {categoryId?, merchantId?, markTransfer?, exclude?} · times_applied` — Zod-validated.
Precedence: **explicit user set > rules > merchant map > Claude**.
The seeded ATM-salary rule assigns a synthetic merchant **"Employer (cash)"** so the weekly
salary is visible to merchant-grouped recurring detection (review finding).

### budgets
`id · category_id · period (daily|weekly|monthly|annual) · amount_cents · starts_on · ends_on? · is_active · rollover_enabled · rollover_starts_on? · rollover_cap_cents?` — UNIQUE(category_id, period) among active.

**Rollover is opt-in per budget, off by default** (migration 0012). Off, leftover/overrun is
displayed informationally, unchanged. On, unspent plan from CLOSED periods accumulates
(`carryInto`) and pct/alert/pace/remaining grade against `amount_cents + carry`. The carry is
floored at zero (a deficit is never carried), skips a partial first period, never looks back past
`starts_on` (`rollover_starts_on` may only move it LATER), subtracts each period's overdue bills,
and is derived at read time — never stored, because imports back-fill closed periods.
Totals and the expected-income comparison stay on the plan amount: a carry is money an earlier
period brought in. **Overlap semantics**: child spend
rolls into a parent's budget by design; alerts fire independently per budget row; any
"total budgeted" aggregate excludes budgets whose category is a descendant of another
budgeted category (no double-count).

### recurring_series
`id · name · merchant_id? · account_id? · kind (income|bill|subscription|transfer|other) · cadence (weekly|biweekly|semimonthly|monthly|quarterly|annual) · interval_days_avg · amount_cents_avg · amount_cents_stddev · tolerance_days · next_expected_on · next_expected_amount_cents · status (detected|confirmed|dismissed|ended) · confidence · last_matched_on`
Detection groups by merchant, plus by `(account_id, normalized_description)` for
merchant-less transactions. Statistics are stored so the forecast math stays inspectable.

### holdings
`id · account_id (investment only) · symbol · asset_type (stock|etf|crypto) · quantity_e8 · avg_cost_cents? · is_active` — UNIQUE(account_id, symbol). Avg cost feeds P/L display only, never net worth.

### price_cache
`id · symbol · asset_type · quoted_on · close REAL · source (yahoo|coinbase|coingecko|stooq|manual) · fetched_at`
**UNIQUE(symbol, asset_type, quoted_on)** and every provider lookup is keyed by
(symbol, asset_type) — crypto routes only to Coinbase/CoinGecko, equities only to
Yahoo/Stooq. (Review finding: bare `ETH` is both Ethereum and a NYSE ticker; a bare-symbol
lookup could silently price your crypto with an equity quote.)

### holding_events (Phase 7 addendum)
`id · account_id FK→accounts (investment only) · symbol · asset_type (stock|etf|crypto) ·
occurred_on date · quantity_delta_e8 INTEGER signed (buys positive, sells negative) ·
cost_cents INTEGER nullable (event cost, P/L display only) · note nullable ·
import_file_id FK→import_files nullable` — indexed on (account_id, symbol, occurred_on) and on
import_file_id. `import_file_id` is set on a brokerage book's trades, filed under the statement
that printed them: they leave with its un-import and are deleted (not kept beside) on its re-read.

The quantity timeline behind **crypto history v1** (master plan Phase 7): the cumulative
sum of deltas per (account, symbol) × cached daily closes derives the crypto account's
`daily_balances` (basis `derived` where a close exists that day, `carried` when the last
known close is stepped forward) — closing the Phase 2b crypto exemption. `upsertHolding`
appends a delta event for every quantity change on any holding, so the timeline is
maintained as a side effect of normal holdings CRUD. Like all market-derived values,
computed balances are rounded to cents at the edge; quantities stay exact 1e-8 integers.

### duplicate_candidates (pass-35 addendum)
`id · account_id · transaction_id_a · transaction_id_b · pair_key · reason · reason_detail ·
resolution (unresolved|confirmed_duplicate|dismissed) · resolved_at · retired_transaction_id ·
retired_from_status` — **UNIQUE(transaction_id_a, transaction_id_b)**, indexed on
`transaction_id_b`, on `pair_key`, and on `(resolution, account_id)`.

One row per cross-source duplicate PAIR, so the app can say *which two rows* and *why* — and so
the owner's verdict outlives the boolean. `transactions.needs_review` alone could not carry this:
it has no reason field, and fifteen code paths clear it (categorizing a row, confirming a review
cluster, linking a transfer, the "mark all reviewed" amnesty), any of which would erase a
double-count warning with nothing left to re-derive it.

**Invariants enforced in app code, not SQL:**
- `transaction_id_a < transaction_id_b` lexicographically. uuidv7 ids are lowercase hex, so JS `<`
  and SQLite's BINARY collation agree. Normalization lives in the single writer
  (`flagDuplicateCandidates`), which is what makes the unique index actually dedupe — the
  self-join is symmetric and emits every pair twice.
- `retired_transaction_id` is non-null only when `resolution = 'confirmed_duplicate'`, and always
  equals one of the two ids.

**Both transaction FKs are `ON DELETE SET NULL`, deliberately not CASCADE.** Rows are genuinely
hard-deleted (`unimportFile`, `deleteManualTransaction`) under `foreign_keys = ON`, so a plain
reference would throw — but cascading would destroy the owner's own verdict along with the row,
and `unimportFile` re-runs the detector fifteen lines after its delete, so a dismissed pair would
return immediately as unresolved.

`pair_key` is a content hash of the account plus both sides' (posted_on, transacted_on, amount,
normalized description), sides sorted. It exists because every unimport→re-import gives the same
two charges brand-new ids: an id-keyed memory would re-ask a question the owner already answered,
which is the import-order dependence this table was added to end. A re-parse that changes a
normalized description changes the key, and that is correct — different words are a different
question.

**Money rule:** confirming a duplicate retires ONE side by setting `transactions.status =
'superseded'` (out of `REPLAY_STATUSES`, out of every analytics total, still in the table), records
what its status was, and is reversible. Nothing is ever deleted and no winner is ever picked
automatically — an earlier revision picked winners on (day, amount) alone and destroyed real
charges (reverted in `3e5a7fc`). Retiring is refused when the row sits inside a `reconciled`
period: that statement's arithmetic already proves the money, and removing a row from it would
make the next reconcile find a gap and quarantine the whole file's rows in that period.

### ai_calls
`id · purpose (categorize|pdf_extract|annotate) · model · input_tokens · output_tokens · est_cost_usd · batch_size` — surfaces monthly AI spend; settings cap warns before exceeding.

### app_settings
`key PK · value JSON` — AI budget cap, review thresholds, price staleness, backup config, week-start override.

### ledger_witness_marks (migration 0017)
`kind PK · mark INTEGER · witnesses JSON · account_names JSON · updated_at` — the high-water
mark under each kind of witness `pnpm ledger-check` counts (`src/lib/witness-floor.ts`). A run
counting fewer fails; one counting more raises the row itself. Each witness is keyed by its
account's **id**, never its name; `account_names` only names an account a drop removed. It
lives in the ledger, not beside it, so a restored snapshot brings back its own marks. Lowered
only by `pnpm ledger-check --lower-marks=<kind> --confirm`.

## Invariants the test suite enforces

1. Every `reconciled` **cash/credit** statement period: `beginning + Σ(active txns in
   date-range) = ending`, exactly. Every **investment** period:
   `beginning + Σ(cash flows) + market_change = ending` with `market_change` stored, never a gap.
2. Every replayed chain between consecutive winning anchors closes exactly, or the span is
   `gap`/`derived_unverified` — levels are never invented.
3. Re-importing any file under the same parser_version adds 0 rows; re-parse under a newer
   version supersedes atomically and preserves user-set attributes.
4. **Import-order independence**: any permutation of the same file set yields an equivalent database.
5. Net-worth total on a complete day = assets − liabilities; incomplete days are marked
   partial, never silently understated.
6. Every `transfer_group_id` has ≥1 counterpart leg.
7. Spending/income analytics never include `transfer`/`investment`/`rewards` kinds or
   `quarantined`/`excluded`/`superseded` statuses — but investment-account dividends and
   interest **do** appear in income (they are income-kind transactions, not market movement).
