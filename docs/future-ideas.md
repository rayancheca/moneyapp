# MoneyApp — Ideas & Future Implementation

> Living backlog. **Every working pass must expand + polish this list and tick off
> what shipped.** Newest thinking near the top of each section. Dates are absolute.

Last updated: 2026-07-13 (pass 2).

---

## 🎯 Active priorities (this thread)

- [x] **Dynamic dashboard §1** — shared window-history reducer + lifted ScrubChart brush state (commit `7a97003`).
- [x] **Dynamic dashboard §2/§4** — brush the net-worth chart → linked activity panel + ← Back/→ timeframe history (commit `913a090`).
- [x] **Per-account coverage report** — done as analysis (see "Data coverage" below).
- [x] **Chart names WHICH accounts are missing** at each partial day (tooltip "● Partial · no Robinhood Crypto, Venture X", header, hero, aria) — commit `194477d`.
- [x] **Account editable from its detail page** (name / institution / last4) — commit `8b66cda`. First slice of "nothing read-only".
- [ ] **Import Chase ····3522 statements 2022-09 → 2024-07** — DEFERRED to a fresh session (user's call); needs a new Chase-checking PDF parser. Fully staged + spec'd below.
- [ ] **Chart: also name the COVERED accounts** (not just missing) — maybe an expandable "coverage" line, or list covered when few are covered. Low priority; missing is the useful direction.

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

## 📊 Data coverage (as of 2026-07-13, real db)

Transactions per account (active): the whole ledger currently **floors at mid-2024** —
that's why history "only goes to 2024". Balances are anchored at **today (2026-07-10)**
and derived backward.

| Account | Type | Txns | First txn | Last txn |
|---|---|---|---|---|
| Chase ····3522 | checking | 1114 | 2024-07-12 | 2026-07-10 |
| Chase Sapphire | credit | 1736 | 2025-02-04 | 2026-07-09 |
| Capital One Venture X | credit | 670 | 2026-01-16 | 2026-06-13 |
| Discover ····???? | credit | 625 | 2024-07-21 | 2026-06-23 |
| Robinhood Brokerage | investment | 2181 | 2024-08-15 | 2026-07-07 |
| Robinhood Cash | checking | 0 | (derived from statements) | |
| Robinhood Crypto | investment | 0 | (derived) | |
| SoFi Checking | checking | 505 | 2024-09-15 | 2026-05-31 |
| SoFi Savings | savings | 465 | 2024-07-15 | 2026-05-31 |

- Only Chase Sapphire (2) + Venture X (5) have `statement_periods` rows — most accounts
  were built from CSV/OFX/rebuild scripts, not PDF statements. Chase 3522's existing
  data has **no statement_periods** (came from a CSV/QFX or a rebuild).
- **Discover last4 is unknown ("????")** — a name to fix once a Discover statement is on hand.

## 🧾 Statement import — Chase ····3522 (2022-09 → 2024-07) — NEEDS A REAL PARSER (fresh session)

**Decision 2026-07-13:** do this in a **fresh focused session** (real financial data + a new
parser = its own careful unit). Everything below is staged and ready.

**Why a parser (not "Claude reads it"):** the app's PDF parser (`profiles/pdf-profile.ts`,
`statementPdf`) only matches the app's SYNTHETIC fixture header (`PERIOD_RE =
/Statement Period:\s*MM/DD/YYYY\s*-\s*MM/DD/YYYY/`). Real Chase statements use a different
layout, so all 21 fail with "No statement period found". A deterministic + reconcilable
parser is the correct standard for money (vs. one-off LLM hand-parsing, which isn't
reproducible). Build a new `chaseCheckingStatementPdf` profile and register it in
`profiles/index.ts` (before the generic `statementPdf`).

**Already done (staged, all gitignored under data/):**
- 21 unique statements deduped by statement-date → `data/incoming-3522/YYYYMMDD-3522.pdf`
  (dropped a same-date re-download `20230810 (1)` — the pipeline's SHA-dedup wouldn't catch
  a byte-different re-download of the same statement, so dedupe by date).
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
