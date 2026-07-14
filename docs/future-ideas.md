# MoneyApp — Ideas & Future Implementation

> Living backlog. **Every working pass must expand + polish this list and tick off
> what shipped.** Newest thinking near the top of each section. Dates are absolute.

Last updated: 2026-07-14 (pass 10 — Track 4 CLOSED: cross-format dedupe shipped, "orphan CSVs"
exposed as synthetic fixtures + deleted, Knack → Income › Tutoring, RH-crypto last4 + folder migrated).

---

## 🗺️ Session roadmap — how the remaining work splits into sessions

> User decision (2026-07-13): tackle the four tracks in priority order **4 → 3 → 2 → 1**
> (loose ends → nothing-read-only → motion/focus → multi-episode recurring), one focused
> session at a time, each ending with a handoff prompt for the next. Sizes are estimates —
> sessions can merge or split. Polish items (see "Known small issues") fold into the nearest
> relevant session. Deployment (Turso/libSQL + auth, then iOS) stays gated until the end.

**Track 4 — Loose ends (option 4)** — ✅ CLOSED 2026-07-14 (pass 10)
- [x] **S1 — covered-accounts chart phrasing** shipped (commit `2e26bc3`): adaptive "only …"/"missing …"
  labels via `src/lib/coverage-label.ts`. See "Active priorities".
- [x] **S1b — data hygiene (RESOLVED 2026-07-14, pass 10).** Three closures:
  1. **Cross-format reconciliation dedupe shipped** (`feat(import)` commit): when an incoming row's
     exact hash misses (different raw text across export formats), it now dedupes against existing
     balance-affecting rows from other sources by (account, posted_on, amount) with **multiset
     consumption** (two genuinely identical same-day charges still both count). New visible
     `FileOutcome.dedupedCrossFormat` counter. This is the user's stated model: files are parsed once,
     the DB is master, overlapping uploads are harmless by design. TDD'd (4 new tests, 17/17 import
     suite, 1034 unit total).
  2. **The 4 "orphan alt-export CSVs" were NOT user data** — byte-identical to
     `tests/fixtures/synthetic/` files (fake SoFi balances $20,078.53 + $8,150.00 explain the old
     +$28k double-count finding exactly; the "SoFi savings" rows had arithmetic-perfect fake interest).
     Deleted from `data/originals/` (now removed, archive lives in `data/statements/`) per the standing
     "no fake data" directive; scratch backup kept one session. Real db untouched.
  3. **Robinhood Crypto last4 + archive folder** (user chose rename+migrate): `last4=8474` set, folder
     → `data/statements/robinhood-crypto-8474/`, 8 `storage_path` rows repointed + verified on disk
     (`data/db-ops-2026-07-14.ts`, backup `data/backups/pre-dbops-2026-07-14.db`, Δ net worth = 0).
  Also: **Knack Payout → NEW Income › Tutoring** (60 rows, $10,023.00; 45 from Other Income + 15 from
  the review queue — all literal "Knack Payout" direct deposits; review queue 2255 → 2232).

**Track 3 — "Nothing read-only" (option 3, ~6 sessions)** — the north star; each a shippable slice.
- [x] **S2 — inline-edit primitive shipped (pass 9).** Built the pure edit-state core
  `src/lib/inline-edit.ts` (reducer + `keyToIntent` + `resolveTextCommit`/`resolveAmountCommit` →
  save/noop/invalid; TDD'd, src/lib 100%), the `useInlineEdit` hook (optimistic display + rollback,
  generation guard against overlapping saves, try/catch on a thrown/rejected save, Toast+Undo, keyboard
  focus return, Enter/Escape/blur grammar), and `<InlineEditableText>` (a role=button span that flows/wraps
  like the surrounding text, click→input in place, no layout jump). **First use: the account detail `<h1>`**
  is now editable in place via `renameAccountAction` (value-returning; reuses `updateAccount`). `StatCard`
  gained an optional `className`. e2e `zz-account-rename` (Escape cancels · Enter saves · Undo restores ·
  reload persists); adversarial 4-lens review → 5 findings fixed (2 high: save-rejection swallow, keyboard
  focus loss; 1 med: overlapping-save race; 2 low). Verified on real data (hover affordance, edit-in-place
  input, no jump) at desktop + mobile; net worth untouched.
  - NOTE: `<InlineEditableAmount>` component **deferred to S4** (its first real wiring = manual-txn
    amounts). The hard part is already done + tested here: `resolveAmountCommit` (cents via the ledger's
    string-math parser) and the shared hook are generic, so S4 is a thin renderer.
- [x] **S3 — inline-rename everywhere (pass 10).** Every name edits where it's shown via the shared
  `<InlineEditableText>`: **category detail `<h1>`** (net-new `renameCategory` service in
  `src/services/category-edit.ts` — guards sibling-name uniqueness with a readable error and BLOCKS
  transfer/system kinds because transfer detection matches on their names; 6 unit tests) +
  `renameCategoryAction`; **merchant detail header** (`MerchantNameHeading`, old name becomes a
  contains-alias so imports keep resolving); **series detail `<h1>`** and the **sheet's merchant row**
  (both bespoke toggle-inputs replaced by the primitive). **Account type/subtype now editable** in the
  edit sheet behind an explicit "re-derives history" checkbox: `editAccount` re-runs `rebuildAccount`
  on a semantics change, and the action rejects unconfirmed changes. e2e `zz-inline-renames` (series /
  category / merchant, each Undo-restored + reload-proven).
- [x] **S4 — inline txn fields in the ledger-row expander (pass 10).** Each ledger row gains a chevron
  expander (no sheet needed): **notes** edit on every row; **date / amount / description** edit ONLY on
  manual rows (`importFileId IS NULL` threaded through `LEDGER_SELECT`/`toLedgerRow` as
  `LedgerRow.isManual`) — imported rows render their facts read-only with an explicit "audit trail"
  note; **merchant** renames inline (lazy-loaded via the sheet's panel action). Built
  **`<InlineEditableAmount>`** (formats cents, edits through the string-math parser — no floats) and
  `resolveDateCommit` (pure, 100%); `InlineEditableText` gained a `resolve` override for dates. New
  `editManualTransaction` service recomputes the row's dedupe identity (occurrence index + hash) and
  rebuilds derived balances; 3 service tests + e2e `zz-zz-txn-expander` (manual edit round-trip +
  imported-row immutability).
- [x] **S5 — linkable (pass 10).** Transaction sheet gains two lazy-disclosure panels:
  **"Link as transfer…"** pairs a row with its counterpart (opposite sign, other account, ±14d,
  nearest amount first — the human override for fee-shaved/date-drifted pairs the detector can't
  match; outflow id keys the group, detector category conventions) + **Unlink** (keeps categories);
  **"Attach to recurring series…"/Detach** wires recurring-links into the ledger. Review-hardened
  (12 verified agents): stale-counterpart detach on group-key re-mint, zero-amount guard, link-only
  unlink undo, and **lossless series-link undo** — `undoFieldsSchema` grew `seriesLinkSource`,
  `applyUndoPatch` restores link ownership + re-settles series stats, so undo can't strand rows
  detector-invisible. `src/services/transfer-links.ts` (11 tests) + e2e `zz-zz-linking`.
  NOTE: link-by-DRAG deliberately deferred to S7's pointer-drag hook — the affordance version is the
  keyboard-accessible baseline a11y requires anyway.
- [x] **S6 — linkable cont. (pass 10).** **Merchant→category default rule** editable on the merchant
  page (picker + Undo; explicit "Apply to N uncategorized" backfill that never overwrites, lossless
  undo). **Card↔payment-source account link**: `accounts.payment_source_account_id` (migration 0005 —
  trimmed by hand: 0004 lacked a snapshot so drizzle-kit tried to re-add its columns, which would have
  crashed boot; LESSON: hand-written migrations must also hand-write their snapshot), Edit-sheet
  "Payment source" select (credit-only, cash-account target, never self), and `detectTransfers`
  treats the linked pair as hinted → card payments auto-pair without a descriptor match.
- [ ] **S7** — movable: drag-reorder dashboard sections (persist `dashboard_layout` in `app_settings`);
  drag-reorder accounts on the dashboard cards; drag a txn between categories (kanban); move/merge
  categories (re-parent) with re-derivation.

**Track 2 — Motion + focus (option 2, ~3 sessions)** — all compositor-only + reduced-motion-gated.
- [ ] **S8** — §3 Focus mode: click the chart → expand to a focus modal via the View Transitions API
  (shared-element morph, CSS fallback); reuse the `Sheet.tsx` native-`<dialog>` focus-trap; lazy-load.
- [ ] **S9** — §5 Activity-hub redesign: kill the "To review / Upcoming" dead gap; bento/segmented
  composition; everything clickable/expandable (overlaps the editability vision).
- [ ] **S10** — §7 app-wide bold-&-playful motion: page/route transitions, card-entrance stagger, hover
  depth, NumberRoll everywhere, spring micro-interactions, categorize checkmark-draw + confetti. May
  split S10a (transitions + stagger) / S10b (micro-interactions).

**Track 1 — Multi-episode recurring (option 1, ~4 sessions)** — schema + detection + projection + UI.
- [ ] **S11** — `recurring_episodes` table + migration (each existing series → one open episode,
  behavior-preserving); episode-aware `isSeriesActive` + projection (`toProjectable`/`forecast`). TDD
  the projection math (pure, 100%).
- [ ] **S12** — auto-detect episodes: gap-analysis split in `recurring.ts` (gap > ~2× local cadence →
  new episode; infer per-episode cadence + day). TDD (StephanCodes→1 closed, Netflix→several).
- [ ] **S13** — calendar + list: episode-aware day-state grammar (active solid/accent vs past-episode
  muted/outlined); series list groups/labels active vs historical; fixes the wrong "Next expected" on
  ended series.
- [ ] **S14** — per-episode editor UI on the series detail page (add/remove, set start/end, cadence +
  day, amount, one-click "mark ended"); per-episode cadence sentence. Ties into "nothing read-only".

**Then (gated):** deployment — Turso/libSQL migration + auth before any public deploy of real
financial data; then iOS.

---

## 🎯 Active priorities (this thread)

- [x] **Data-correctness review (2026-07-13, pass 8)** — user-directed triage of the opaque income
  + the SoFi backfill. Applied via `data/categorize-review-2026-07-13.ts` (backup
  `data/backups/pre-catreview-2026-07-13.db`; in-txn net-worth/integrity/count guards → rollback on
  anomaly). 428 rows touched; **net worth $94,144.53 unchanged**, integrity ok, 9360 active txns, 83
  import_files. Total income 2022–2026 **$205,266 → $116,380** (−$88,886 — an honest correction, see below).
  - **DEPOSIT ID NUMBER (5 rows, $30,413)** → Transfers › Internal Transfer. User: their dad gave them
    euros in Spain → converted to USD → deposited (these inflows) → wired back to dad (the already-Transfers
    "CONSUMER ONLINE INTERNATIONAL WIRE" outflows −$25k/−$3.3k on Mar 4–5). A currency pass-through/wash,
    NOT the user's income. Both legs now Transfers → nets ~0, out of income.
  - **SoFi backfill (282 uncategorized, Oct 2023→Jul 2024)** auto-categorized per user's choice: 168
    internal sweeps + Chase moves → Transfers › Internal Transfer; 19 Discover e-payments → Transfers ›
    Credit Card Payment; 12 Interest Earned → Income › Interest; 13 rewards/promo → Rewards › Cash Back;
    the remaining **70** (debit-card purchases + misc, e.g. Fordham WEBCHECK) → **review queue** (flagged,
    left uncategorized) for normal categorization.
  - **ATM cash deposits (49 rows, $53,948, mislabeled "Salary")** + **Zelle-from-individuals (92 rows,
    $6,194, "Other Income")** → **reset to uncategorized + review queue** (+190 items total). User's call:
    these are heterogeneous (cash income / gambling / dad currency-exchange / a friend's tuition money;
    Zelle = reimbursement-vs-income unknown) and they want to tag each ONE BY ONE in the app's review UI
    (this is a concrete pull for the "nothing read-only" review-cards workflow). Income is now a known
    FLOOR ($116k) that grows back as the queue is tagged. Nothing fabricated; raw descriptions intact.
  - FOLLOW-UP: the +190 review-queue items are the user's to categorize. Knack Payout ($10k, tutoring
    platform) was LEFT as Income › Other Income (clearly income; user can move to a dedicated bucket).

- [x] **SoFi statement ingestion (2026-07-13, pass 6)** — built `sofiCombinedStatementPdf` parser
  (combined Checking-9067 + Savings-5791 sections per PDF; commit `611e6c7`, 66/66 sections reconcile
  to the cent). User uploaded 33 monthly combined statements (Oct 2023→Jun 2026). The statements
  OVERLAP the CSV-sourced SoFi data and use different raw descriptions (would double-count), so user
  chose **Replace**: superseded the 970 CSV txns + 2 CSV import_files, imported 1290 statement txns,
  **preserved 960 categories** by (account,date,amount) match (so only the pre-2024-07 backfill is
  uncategorized → review queue), re-applied Fordham→Salary. Real db: net worth $94,144.53 unchanged,
  0 negative months, 102 periods reconciled, integrity ok. Harness `data/replace-sofi.ts`, backup
  `data/backups/pre-sofi-replace-2026-07-13.db`. Note: `categorizeAll` recovered 0 (SoFi's 100% cat
  was not rule-based) — the ~282 backfill txns categorize via the review queue over time.

- [x] **Dynamic dashboard §1** — shared window-history reducer + lifted ScrubChart brush state (commit `7a97003`).
- [x] **Dynamic dashboard §2/§4** — brush the net-worth chart → linked activity panel + ← Back/→ timeframe history (commit `913a090`).
- [x] **Per-account coverage report** — done as analysis (see "Data coverage" below).
- [x] **Chart names WHICH accounts are missing** at each partial day (tooltip "● Partial · no Robinhood Crypto, Venture X", header, hero, aria) — commit `194477d`.
- [x] **Account editable from its detail page** (name / institution / last4) — commit `8b66cda`. First slice of "nothing read-only".
- [x] **Statement ingestion + per-account storage (PRIMARY MISSION)** — built 3 real-bank PDF
  parsers (Chase College Checking, Discover it, Robinhood Crypto), re-architected the archive to
  per-account folders the DB references, and imported ALL 52 real files in `data/inbox`. Every file
  is now tracked in `import_files` (52 rows, was 13); 36 periods reconcile to the cent, 8 crypto
  value-anchors, 0 gaps; net worth @2026-07-10 unchanged (Δ=0); Chase 3522 history back to 2022-08-25;
  Discover last4 learned = 4741. See the (now historical) plan sections below. Details: [[moneyapp-statement-ingestion-2026-07-13]].
- [x] **Chart: also name the COVERED accounts** (not just missing) — shipped as adaptive phrasing:
  on a partial day the tooltip/header/hero/aria now name whichever list is more concise via the pure
  `src/lib/coverage-label.ts` helper — "only Chase ····3522" on 2022 days (1/9 covered), "missing
  Robinhood Brokerage, Robinhood Crypto +2 more" when most accounts are covered. One canonical verb
  (`kind`) across all four surfaces so wording can't drift. Verified on real data.
- [x] **Robinhood Crypto last4 — RESOLVED 2026-07-14 (user chose rename+migrate).** `last4=8474`,
  folder migrated to `data/statements/robinhood-crypto-8474/`, 8 `storage_path` rows repointed and
  verified on disk. Future uploads land in the new folder via the unchanged `accountSlug()`.
- [x] **4 orphan alt-export CSVs — RESOLVED 2026-07-14: they were FAKE.** Byte-identical to
  `tests/fixtures/synthetic/` fixtures (leftover demo seeds that survived the 2026-07-13 purge because
  they sat in `data/originals/` disguised as untracked "alt exports"). The old +$28,173.87 dry-run
  delta ≈ the fixtures' fake SoFi balances ($20,078.53 + $8,150.00) — it was never a dedupe-hash
  problem alone. Deleted (with a one-session scratch backup); `data/originals/` removed (empty; the
  real archive is `data/statements/`). The REAL fix that came out of it: cross-format reconciliation
  dedupe in the import pipeline (see S1b above), so any future overlapping re-export dedupes against
  the DB by design. Lesson recorded: **synthetic-looking patterns (arithmetic-perfect interest, rigid
  monthly transfers) are a data-authenticity smell — check `tests/fixtures` before importing.**

## 🧮 Spending math — review + fix (2026-07-13, pass 5)

User asked "why is Spent negative in Jan 2026?" + review the math for credit/debit/investment.
Adversarially verified (2 review workflows) against the real db.

**Root cause of negative Spent:** `periodTotals` netted positive amounts in expense categories
(refunds/credits) against outflows with NO floor → 9 months went negative (2024-09 = −$14,439,
2026-01 = −$12,260, …). Dominated by ~$86k of INFLOWS miscategorized as expense (see clusters below).
The per-account-TYPE sign math is otherwise sound (investment buys/sells excluded, dividends→income,
transfers transfer-kind); the problem is (a) fragile netting + (b) categorization.

- [x] **Part A — gross debit-only "Spent" (commit `0614faf`).** `periodTotals`/`cashFlowByPeriod`/
  `dailySpendHeatmap` now count only expense-category DEBITS as Spent (mirrors `period-activity.ts`,
  which the dashboard already used — the two surfaces now agree). Positive expense-category amounts →
  a new `refundsCents` field, never netted into Spent; `netCents = earned + refunds − spent` (net
  unchanged, nothing dropped). Spent StatCard drill-down gained `flow=out`. Real-data: Jan 2026 Spent
  −$12,260 → **+$4,808** ($17,068 refunds surfaced). Per-category breakdown (analytics.ts) stays netted
  (separate view, UI-clamped). The inflated savings-rate for the Fordham months normalized once Part B landed.
  - [x] **Part A follow-up — refunds surfaced (pass 7, this commit).** `refundsCents` now shows as a
    conditional 5th "Refunds" stat card on /spending (only when > 0, so refund-free periods keep the clean
    4-card grid; 19/48 real months have refunds, $4.76-$1,959.74 after Part B). It links to
    `category=spending, flow=in` — the EXACT rows summed into `refundsCents` (verified: uncategorized
    positives excluded from both) — so the number reconciles to the list it opens. Net now reads as
    "earned + refunds - spent" right on the row (derivable on-screen, was the gap). On the 2-col mobile grid
    the card spans full width (`col-span-2 lg:col-span-1`) so it's a divider band, not an orphan. Pure logic
    lives in `src/lib/spending-stat-cards.ts` (9 unit tests, 100%); `StatCard` gained an optional
    `className` (additive, reusable for S2). Verified on real data (Jul 2026 $150, Mar 2026 $1,248.80 both
    reconcile) at desktop + mobile; adversarial 4-lens review -> 0 findings.
- [x] **Part B — recategorized the miscategorized inflows (REAL-DB, done 2026-07-13).** 134 rows
  recategorized via `data/recategorize-inflows.ts` (backup `data/backups/pre-recategorize-2026-07-13.db`,
  in-txn Δ=0 + integrity guards). VERIFIED on the real db: **0 negative-spent months** (was 9-10),
  net worth @2026-07-10 unchanged ($94,144.53), integrity ok, 9040 active txns, 52 import_files.
  Jan 2026 now: spent $4,808 · earned $17,776 (aid counted as income) · savings 73%. Clusters + targets:
  - **Fordham "…INVOICE" lumps** (6 rows, checking, +$51,872, currently Education) → **Income › Financial
    Aid** (NEW subcat). User's words: dad pays tuition from his (untracked) account, aid is deducted and
    the balance refunded to the user — net-new money IN from outside, not the user's own money (so not a
    Transfer) and not a refund of the user's own spend. Income is the honest treatment; a distinct
    "Financial Aid" bucket keeps it separate from earned wages (rename to "Papa money" if wanted).
  - **Fordham biweekly** (46 rows, savings, +$30,716, currently Education) → **Income › Wages** (work-study).
  - **"HOUSE RENT" received** (1 row, checking, +$3,505, from REZAUL KARIM KHATUN, currently Housing/Rent) → **Income**.
  - **Brokerage "ACH Deposit"** (79 rows, investment acct, +$7,103, currently Other Income) → **Transfers**
    (the user's own cash moving INTO Robinhood; matches checking-side −$7,016 "ROBINHOOD" outflows).
  - **CC statement credits** ($41 "CREDIT NOT PROCESSED", $100 statement credit) → **Rewards** (consistent).
  - Predicates + a staged dry/apply harness basis live in `data/audit-spend-math.ts` + `data/diag-jan2026.ts`
    (gitignored). After Part B: 0 negative months, income correctly includes the aid/wages, savings-rate normal.

## 🔁 BIG FEATURE — Recurring charges as MULTI-EPISODE (start/end, historical vs active, intermittent)

User ask (2026-07-13, verbatim intent): a recurring charge is NOT always "one cadence forever."
It recurs in EPISODES. Examples the user gave:
- **StephanCodes** (Discover, $40): charged Aug 3 / Sep 3 / Oct 3 2025, then STOPPED. It was
  recurring only for that 3-month window. The user must be able to say "these 3 dates, then done"
  → it becomes a HISTORICAL (previously-recurring) series, not a currently-active one.
- **Netflix**: 5th of the month for 5 months → stop for a year → restart on the 13th for 2 months
  → stop → start again… SAME merchant/series, but MULTIPLE recurrence episodes, each with its own
  date range + cadence (even a different day-of-month per episode).

Requirements:
1. **Multiple episodes per series.** A recurring series owns 1..N episodes; each episode has a
   `start_on`, `end_on` (nullable = still open/active), a cadence (day-of-month OR weekday +
   interval like monthly/biweekly), and optionally its own amount. StephanCodes = 1 closed episode
   (2025-08 → 2025-10, monthly on the 3rd). Netflix = several episodes with different days.
2. **Active vs historical, everywhere.** "Currently recurring" = has an episode with `end_on` null
   (or ≥ today) whose cadence still produces charges near today. "Previously recurring" = all
   episodes ended in the past. The **calendar** must VISUALLY distinguish the two (e.g. active
   occurrences solid/accent, past-episode occurrences muted/outlined) and the series list should
   group/label them. The recurring-detail page (screenshot 2026-07-13) shows one series
   (StephanCodes, "Detected · Bill · Inactive", amount history Aug/Sep/Oct, "Next expected" Jul/Aug
   2026) — that "Next expected" is WRONG for a series that ended in Oct 2025; episodes fix this
   (a closed episode projects nothing forward).
3. **Fully editable.** On the series detail page: an EPISODES editor — list episodes, add/remove,
   set each episode's start/end, change its cadence + day, set/override amount, and a one-click
   "mark ended" (sets `end_on` to the last real charge). The editable cadence sentence
   ("charges monthly around the 3rd") becomes PER-EPISODE. Nothing read-only.
4. **Auto-detect episodes (the "AI/engine" part).** The detection engine
   (`src/services/recurring.ts`) should, for each detected series, SPLIT its linked-charge history
   into episodes by gap analysis: sort the charges, and when a gap between consecutive charges
   exceeds ~2× the local cadence interval, start a new episode; infer each episode's cadence +
   day-of-month/weekday from its own charges. So StephanCodes auto-splits into one closed episode;
   Netflix into several. The user then refines by hand what the engine got wrong (their words:
   "do it yourself with an engine like AI, and whatever you can't do, I'll do it").

Implementation notes (for whoever builds this):
- CURRENT model (single-cadence): `recurring_series` has `cadence`, `next_expected_on`,
  `status` (detected/confirmed/dismissed/merged), and user overrides (`user_amount_cents`,
  `user_cadence`, `user_next_expected_on`, `merged_into_id`); `transactions.recurring_series_id` +
  `series_link_source` (detected/user). Projection + isActive derive from the single cadence.
  Files: `src/services/recurring.ts` (detection), `recurring-links.ts` (attach/merge/detach),
  `recurring-detail.ts` + `recurring-calendar.ts`, `src/components/recurring/*`
  (SeriesDetail, CadenceSentence, RecurringCalendar, AmountHistoryChart).
- NEW model: add a **`recurring_episodes`** table (migration): `{id, series_id, start_on,
  end_on|null, cadence, day_spec, amount_cents|null, source: detected|user}`. Migrate each existing
  series to a single open episode (behavior-preserving). Rework projection (`toProjectable`/
  `forecast`) + `isSeriesActive` + the calendar day-state grammar to be EPISODE-aware. Keep the
  money-integrity guards (a closed episode never projects; merged series forward-map).
- This is a SCHEMA + detection + projection + calendar + UI change — its own multi-commit project.
  TDD the episode-split + projection math (pure, 100% src/lib). Real financial data: never
  fabricate a charge; a detected episode is a hypothesis the user confirms.

## 🧭 The big vision: "nothing read-only — everything editable, linkable, movable"

User's north star (2026-07-13): *"I don't want jack shit to be read only. I want to
be able to play around with everything and link everything and move things around."*
This is a program of work, broken into shippable slices:

### Editable everywhere
- [x] Account **name** editable inline on the detail page `<h1>` (pass 9, S2) — via the shared
  `<InlineEditableText>` primitive. (The breadcrumb reflects the saved name after refresh; it's a static
  mirror, not a second editor — one editing surface per value avoids double-edit confusion.)
- [x] Account **institution / type / subtype / last4** editable from the detail page (pass 10, S3):
  type/subtype unlocked behind an explicit "re-derives history" confirm; `editAccount` re-derives via
  `rebuildAccount` when the semantics change.
- [x] **Inline-rename anywhere a name is shown** (pass 10, S3): merchants (detail header + sheet),
  categories (detail `<h1>`, transfer/system kinds excluded — detection matches on their names),
  recurring series (detail `<h1>`), accounts (S2). Budgets already edited in place.
- [~] **Every number that's an input should be editable in place** — budget amounts [done],
  manual-txn amounts [done, S4 via `<InlineEditableAmount>`]; balances-as-anchors still via AnchorForm.
- [x] Transaction fields beyond category: **notes, date, amount (manual txns), merchant** — inline in
  the ledger row expander (pass 10, S4); imported rows stay the immutable audit trail.

### Linkable
- [ ] **Link transactions ↔ transactions** (transfer pairs) by drag or a "link" affordance, beyond the auto transfer-detection.
- [ ] **Link a transaction → a recurring series** by drag (attach), and **merge** series by drag.
- [ ] **Link merchants → categories** (a merchant-default rule) from the merchant page inline.
- [ ] **Link accounts** (e.g. a credit card ↔ its payment source) for smarter transfer inference.

### Movable / rearrangeable
- [ ] **Drag-reorder dashboard sections** (net worth / activity hub / accounts / recent) — persist per-user layout order (a `dashboard_layout` setting).
- [ ] **Drag-reorder accounts** (exists on /accounts via up/down; add true drag on the dashboard institution cards too).
- [ ] **Drag a transaction between categories** (kanban-style) as an alternative to the picker.
- [ ] **Move/merge categories** (re-parent a subcategory by drag) with re-derivation.

> Shared infra these need: an `<InlineEditableText>` / `<InlineEditableAmount>` primitive;
> a small drag-and-drop hook (pointer-based, reduced-motion-safe, keyboard alternative
> for every drag per a11y); value-returning server actions + optimistic UI + undo
> (the established Toast+undo pattern); persistence of user layout/order in `app_settings`.

## 📊 Data coverage (as of 2026-07-13, real db — POST statement ingestion)

Transactions per account (active). After ingesting the historical PDF statements the ledger
now reaches back to **2022-08** (Chase 3522). Balances are still anchored at **today (2026-07-10)**
and derived backward; net worth @2026-07-10 is unchanged.

| Account | Type | Txns | First txn | Last txn |
|---|---|---|---|---|
| Chase ····3522 | checking | 2395 | 2022-08-25 | 2026-07-10 |
| Chase Sapphire | credit | 1736 | 2025-02-04 | 2026-07-09 |
| Capital One Venture X | credit | 670 | 2026-01-16 | 2026-06-13 |
| Discover ····4741 | credit | 1024 | 2023-10-11 | 2026-06-23 |
| Robinhood Brokerage | investment | 2181 | 2024-08-15 | 2026-07-07 |
| Robinhood Cash | checking | 0 | — | |
| Robinhood Crypto | investment | 64 | 2025-11-04 | 2026-06-23 |
| SoFi Checking | checking | 670 | 2023-10-30 | 2026-05-31 |
| SoFi Savings | savings | 620 | 2023-10-27 | 2026-05-31 |

- `statement_periods` now: 36 reconciled-to-the-cent + 8 crypto value-anchors + 2 declared-range
  (Chase Sapphire spending reports), **0 gaps**. Chase 3522 + Discover gained full monthly periods.
- **Discover last4 is now 4741** — learned from the Discover it statement header on import.
- Robinhood Crypto's balance curve still comes from `holding_events × priceCache` (Stage 4a); the
  imported crypto statements add the activity ledger + tracking, not the balance.

## 🧾 Statement import — Chase ····3522 (2022-09 → 2024-07) — ✅ DONE (parser shipped)

**Shipped 2026-07-13:** `chaseCheckingStatementPdf` parser built + TDD'd + validated (21/21
statements reconcile to the cent on the printed running balance) and imported. The decoded-format
notes below are kept as reference. (Original staging plan follows.)

**Why a parser (not "Claude reads it"):** the app's PDF parser (`profiles/pdf-profile.ts`,
`statementPdf`) only matches the app's SYNTHETIC fixture header (`PERIOD_RE =
/Statement Period:\s*MM/DD/YYYY\s*-\s*MM/DD/YYYY/`). Real Chase statements use a different
layout, so all 21 fail with "No statement period found". A deterministic + reconcilable
parser is the correct standard for money (vs. one-off LLM hand-parsing, which isn't
reproducible). Build a new `chaseCheckingStatementPdf` profile and register it in
`profiles/index.ts` (before the generic `statementPdf`).

**Already done (staged, all gitignored under data/):**
- 21 unique statements deduped by statement-date → `data/statements/chase/YYYYMMDD-statements-3522-.pdf`
  (original filenames; dropped a same-date re-download `20230810 (1)` — the pipeline's SHA-dedup
  wouldn't catch a byte-different re-download of the same statement, so dedupe by date). Moved out
  of ~/Downloads. Institution-organized under `data/statements/<institution>/` for browsing.
- DB backed up → `data/backups/pre-3522-import-2026-07-13.db`.
- Dry-run harness → `data/import-3522.ts` (`node --import tsx data/import-3522.ts` = dry on a
  copy; `--apply` = real db). **Bug to fix in the harness:** also set `MONEYAPP_DB_PATH=<copy>`
  in the dry env so any stray `getDb()` can't touch the real db.

**Decoded real Chase College Checking format** (from `extractLines`):
- Period header line: `August 25, 2022 through September 13, 2022` →
  `/^([A-Z][a-z]+) (\d{1,2}), (\d{4}) through ([A-Z][a-z]+) (\d{1,2}), (\d{4})$/`.
- `Account Number: 000000889063522` (endsWith 3522 → owns this account).
- Summary section between `*start*summary` / `*end*summary`: `Beginning Balance $0.00`,
  `Ending Balance $2,923.30` (labeled amounts).
- Transaction detail between `*start*transaction detail` / `*end*transaction detail`, header
  `DATE DESCRIPTION AMOUNT BALANCE`, then rows:
  `MM/DD <description...> <amount> <running-balance>`
  - **Date is MM/DD (NO year)** → infer year from the period (period spans a year boundary for
    Dec→Jan statements: if the row month < period-start month, it's the period-END year).
  - **Amounts:** commas; **negatives sometimes have a space after the minus**: `- 2.08`,
    `- 5.98`. Normalize `-\s*` → `-`.
  - **Wrapped rows:** a trailing token like `7782` (or a continued description) can wrap to the
    NEXT line — the amount + balance are on the FIRST line; fold the orphan line into the prior
    row's description. Detect a "real" row by the leading `MM/DD` + a trailing amount+balance pair.
- **Reconciliation is exact:** each row's printed running balance = prev balance + amount, and
  the last row's balance = `Ending Balance`. Use this to validate every row (a mismatch =
  quarantined gap, never a fabricated number).

**Plan:**
1. TDD `chaseCheckingStatementPdf` against the real `data/incoming-3522/*.pdf` text (fixtures can
   be small hand-made line arrays; keep the real PDFs out of git). Register it.
2. Dry-run `data/import-3522.ts` on a COPY (with `MONEYAPP_DB_PATH=copy`, `MONEYAPP_FAKE_TODAY=2026-07-10`
   so ONLY early history changes). Confirm: 21 parsed, each period reconciles to the cent, the
   2024-07 statement dedups cleanly against the existing 2024-07-12+ rows, and the July/Nov-2023
   cadence gaps surface honestly (quarantined, not fabricated).
3. Verify net worth @2026-07-10 DELTA = 0 (today unchanged; only 2022→2024 interior added).
4. `--apply` on the real db (already backed up). Re-verify. Commit the parser code (db gitignored).
- Gaps: 2023-07 and 2023-11 statement dates are absent — likely just the Chase cycle (confirm from
  each neighbor's opening balance == prior ending balance during reconciliation).

## 🏗️ PRIMARY MISSION — clean per-account statement storage + ingest ALL real statements — ✅ DONE (2026-07-13)

**Shipped:** archive re-architected to `data/statements/<account-slug>/` (root env
`MONEYAPP_ORIGINALS_DIR`, default moved to data/statements); the DB's `import_files.storage_path`
points there; new uploads auto-store into the resolved account's folder (single-account → per-account
slug, multi-account → `<institution>-combined/`, parse-fail → institution bucket); the 13 legacy flat
files were migrated (`migrateStorageLayout`). Confirmed slugs: chase-checking-3522, chase-sapphire-9805,
capital-one-venturex-4147, discover-4741, robinhood-brokerage-3525, robinhood-crypto, robinhood-cash,
sofi-checking-9067, sofi-savings-5791. All 52 `data/inbox` files imported + tracked; 3 new parsers
(Chase checking, Discover it, Robinhood crypto) built + TDD'd. Key decode wins below (kept as reference):
the Discover statement prints only the TRANS date but bills by POST date → each txn's postedOn is clamped
into its statement's `[start,end]` (transactedOn keeps the real date) so date-range reconciliation is exact.

_Original goal (for reference):_ User goal: ONE clean `data/` with **per-account subfolders**, each holding that account's
statements; **the DB references those paths** (`import_files.storage_path`); **auto-store on
upload** into the right account folder; **every statement the user gave is tracked** (currently
only 13 of ~60 are). No fake data (done — see cleanup below).

Why this is the fresh session's job (not a tail-end change): it's coupled + trust-critical.
The parser resolves which account each statement belongs to → that drives the per-account
folder → so the storage change must happen AFTER parsing. And "track all files" REQUIRES
importing them, which needs the real-statement parsers. Doing it piecemeal leaves a
half-migrated pipeline on real financial data. Do it as ONE reconciled unit.

Current storage code (localized — the change is bounded): `src/services/import/service.ts`
`originalsDir()` (line ~190) + the archive step (line ~266-288) writes
`data/originals/<sha16>-<safeName>` and records `storage_path`. Change: after account
resolution, write to `data/statements/<account-slug>/<name>` and store THAT path. Migrate the
17 existing files + UPDATE their 13 `import_files.storage_path` rows. Multi-account statements
(e.g. a SoFi combined, a multi-account QFX) need a rule — recommend per-INSTITUTION folder as
the fallback, or the primary account. (Honest design note: per-institution is simpler and
handles combined statements; per-account is what the user asked — offer both, default to the
user's per-account with an institution-level bucket for combined files.)

**What to ingest (all real, currently scattered — consolidate + import + reconcile to the cent):**
- `data/inbox/` — 52 real statements the user gave that are NOT yet imported: chase 24 (the 21
  historical 3522 checking PDFs 2022-24 + Chase3522_Activity.CSV + 2 Chase Sapphire-9805 spending
  reports), discover 11 (real Discover it ****4741 statement PDFs 2023-24 + CSVs), robinhood 10
  (brokerage activity CSVs + crypto statement PDFs 2025-11/12), capital-one 5 (VentureX-4147
  statement PDFs), sofi 2 (Checking-9067 / Savings-5791 CSVs).
- `data/originals/` — 17 real ALREADY imported (13 tracked import_files + 4 untracked alt exports).
- Parsers needed (real formats, not the synthetic "Statement Period:" template): **Chase checking
  PDF** ("… through …" — decoded, see below), **Discover it PDF** ("DISCOVER IT CARD ENDING IN
  4741 | … | MM/DD/YYYY - MM/DD/YYYY"), **Robinhood crypto/brokerage PDF**, **Capital One VentureX
  PDF** ("Venture X Card | Visa Infinite ending in 4147 | <mon d> - <mon d>"). CSV/OFX parsers for
  Chase deposit / Discover / SoFi / Robinhood likely already exist (chaseDepositCsv etc.) — verify.
- Reconcile every statement (running balance / begin-end) to the cent; gaps quarantine, never fake.
  Pin MONEYAPP_FAKE_TODAY=2026-07-10 so only history extends, "today" stays put.

## 🗂️ Statement files — CLEANED (2026-07-13)

The DB is 100% real: 9 real accounts (VentureX-4147, Chase-3522, Sapphire-9805, Discover,
Robinhood Brokerage-3525/Crypto/Cash, SoFi-9067/5791), 0 synthetic. `import_files` tracks 13
real uploads; the rest of the 7296-txn data came via the `data/*rebuild*.ts` scripts (no
`import_files` rows), which is why the DB "doesn't track every statement".

**Cleanup done (user directive "delete every fake seed, keep only what I uploaded"):**
- DELETED **206 synthetic fixtures** from `data/originals` (223→17; fake accts
  ****4321/2222/3333/7777/5555, `"Statement Period:"` template; none DB-referenced; backed up to
  scratch tgz first). DELETED **`data/demo/`** (9.2M fake demo-seed db; regeneratable via
  `pnpm demo:load`). REMOVED redundant `data/statements/` browse copy. Real DB verified intact
  (`integrity_check ok`, 7296 txns; 9 real accounts, 0 synthetic).
- NOT deleted (isolated test infra, auto-regenerated, never touches real data): `data/e2e.db`,
  `data/e2e-originals` (the e2e suite rebuilds these every run). The app's `seedDatabase` only
  seeds the category taxonomy + institutions (reference data), not fake transactions.
- **Clean 2-folder state:** `data/inbox/` = 52 real statements TO IMPORT (per-institution);
  `data/originals/` = 17 real ALREADY imported (DB-linked archive). The app reads only
  `data/originals` (`MONEYAPP_ORIGINALS_DIR`).

## 🎬 Deferred feature track (original items 3–5 of docs/dashboard-dynamic-and-animations-plan.md)

- [ ] **§3 Focus mode** — click the chart → expand to a focus modal via the View
  Transitions API (shared-element morph), CSS fallback. Reuse the native-`<dialog>`
  focus-trap pattern from `src/components/ui/Sheet.tsx`. Lazy-load.
- [ ] **§5 Activity-hub redesign** — kill the "To review / Upcoming" dead gap; segmented
  or bento composition; everything clickable/expandable. (Overlaps the editability vision.)
- [ ] **§7 App-wide bold-&-playful motion** — page/route transitions (View Transitions),
  card-entrance stagger, hover depth, NumberRoll everywhere, spring micro-interactions,
  categorize checkmark-draw + confetti. All compositor-only + reduced-motion-gated.

## 🐞 Known small issues / polish (from reviews)

- [ ] **ScrubChart From/To picking a <2-point window** un-zooms the chart to the full
  series while the context keeps the 1-day window → chart and panel disagree
  (`ScrubChart.tsx` slice fallback). Only reachable via the date inputs, not the brush.
  Fix: when a controlled window yields <2 points, clamp/widen or reflect the fallback
  back to the context. (LOW; review of item 2.)
- [ ] Period panel **aria-live** on the hero announces on every brush — consider debouncing
  or announcing only the settled value if it proves chatty.
- [ ] Balance-history **% on a near-zero baseline** reads huge (e.g. "+14636.2%" when the
  3-month-ago derived balance was ~$7). Consider suppressing/soft-capping the % when the
  baseline is below a threshold (same honesty spirit as the net-worth partial-% suppression).

## 🚀 Standing roadmap (unchanged)

- [ ] **Deployment**: Turso/libSQL migration + **auth** before any public deploy of real
  financial data. Then **iOS**.
