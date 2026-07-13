# MoneyApp — Ideas & Future Implementation

> Living backlog. **Every working pass must expand + polish this list and tick off
> what shipped.** Newest thinking near the top of each section. Dates are absolute.

Last updated: 2026-07-13 (pass 4 — session roadmap + loose-end follow-ups).

---

## 🗺️ Session roadmap — how the remaining work splits into sessions

> User decision (2026-07-13): tackle the four tracks in priority order **4 → 3 → 2 → 1**
> (loose ends → nothing-read-only → motion/focus → multi-episode recurring), one focused
> session at a time, each ending with a handoff prompt for the next. Sizes are estimates —
> sessions can merge or split. Polish items (see "Known small issues") fold into the nearest
> relevant session. Deployment (Turso/libSQL + auth, then iOS) stays gated until the end.

**Track 4 — Loose ends (option 4)**
- [x] **S1 — covered-accounts chart phrasing** shipped (commit `2e26bc3`): adaptive "only …"/"missing …"
  labels via `src/lib/coverage-label.ts`. See "Active priorities".
- [ ] **S1b — data hygiene (DEFERRED, needs care + a decision)** — the two remaining option-4 items
  turned out to need more than a tidy: the orphan-CSV import is UNSAFE as-is (double-counts +$28k — see
  "Active priorities") and needs a dedup-aligned / new-rows-only reconciliation; the Robinhood last4
  needs a slug-vs-folder decision. Both are real-db mutations → their own careful pass. Not blocking
  Track 3.

**Track 3 — "Nothing read-only" (option 3, ~6 sessions)** — the north star; each a shippable slice.
- [ ] **S2** — shared `<InlineEditableText>` + `<InlineEditableAmount>` primitives (click→input→save on
  blur/enter, Esc cancels, optimistic + Toast-undo). First use: account name inline on the detail
  page + breadcrumb. TDD the pure edit-state hook.
- [ ] **S3** — inline-rename everywhere a name shows (merchants, categories, recurring series) via the
  primitive + value-returning server actions + optimistic/undo. Account institution/type/subtype/last4
  editable from the detail page with a "this re-derives history" confirm.
- [ ] **S4** — inline transaction fields in the ledger-row expander: notes, date, amount (manual txns),
  merchant (not only in the sheet).
- [ ] **S5** — linkable: link txns↔txns (transfer pairs) by drag/affordance; link a txn→recurring
  series by drag (attach) + merge series by drag. Needs the pointer-based drag hook (reduced-motion-safe,
  keyboard alternative per a11y).
- [ ] **S6** — linkable cont.: link merchants→categories (a merchant-default rule) inline; link accounts
  (card ↔ payment source) for smarter transfer inference.
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
- [ ] **Robinhood Crypto last4 — DEFERRED (needs a decision, cosmetic).** Statements carry account
  311070628474 (last4 8474). Populating `accounts.last4` is trivially safe for balances, BUT
  `accountSlug()` appends last4 → the archive slug would become `robinhood-crypto-8474`, contradicting
  the user-confirmed `robinhood-crypto` folder layout. Options: (a) special-case the slug so the folder
  name stays `robinhood-crypto`; (b) accept the rename + migrate the folder + repoint its 8
  `storage_path` rows; (c) leave last4 NULL. Purely cosmetic (UI shows "····8474"); no rush.
- [ ] **4 orphan alt-export CSVs — DEFERRED (import is UNSAFE as-is).** Discover-RecentActivity,
  robinhood_activity_report, short SoFi Checking/Savings exports, still in `data/originals/`, untracked.
  **Dry-run finding (2026-07-13):** they are NOT clean subsets — they overlap the existing ledger
  (e.g. Discover-RecentActivity spans 2025-12→2026-07, over the imported Discover through 2026-06-23)
  AND their alt-export dedupe hashes do NOT match the primary exports → importing inserts 294 txns
  with **0 deduped**, double-counting the overlap and moving net worth @2026-07-10 by **+$28,173.87**
  (≈ SoFi Savings $20,078 + SoFi Checking $8,150). Δ must be 0. **To import safely:** either align the
  dedupe hash across export formats, or import ONLY the genuinely-new rows (dates newer than each
  account's current last txn: Discover >2026-06-23, SoFi >2026-05-31, RH-brokerage the >2026-07-07
  tail + the 2024-07→08 head), then reconcile. Staged dry/apply harness: `data/import-orphans.ts`
  (gitignored). Real db verified untouched by the dry-run (integrity ok · 9040 txns · 52 files · $94,144.53).

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
- [ ] Account **name** editable inline on the detail page (and breadcrumb) — not just the /accounts manage sheet. *(next)*
- [ ] Account **institution / type / subtype / last4** editable from the detail page too (type/subtype currently deliberately locked because they reshape the balance curve — offer it with a clear "this re-derives history" confirm instead of hiding it).
- [ ] **Inline-rename anywhere a name is shown** (merchants, categories, recurring series, budgets) via a shared `<InlineEditableText>` primitive (click → input → save on blur/enter, Esc cancels, optimistic + undo).
- [ ] **Every number that's an input should be editable in place** (balances-as-anchors, budget amounts [done], category names, merchant display names).
- [ ] Transaction fields beyond category: **notes, date, amount (manual txns), merchant** — inline in the ledger row expander, not only in the sheet.

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
| SoFi Checking | checking | 505 | 2024-09-15 | 2026-05-31 |
| SoFi Savings | savings | 465 | 2024-07-15 | 2026-05-31 |

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
