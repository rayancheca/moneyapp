# MoneyApp — Ideas & Future Implementation

> Living backlog. **Every working pass must expand + polish this list and tick off
> what shipped.** Newest thinking near the top of each section. Dates are absolute.

Last updated: 2026-07-13.

---

## 🎯 Active priorities (this thread)

- [x] **Dynamic dashboard §1** — shared window-history reducer + lifted ScrubChart brush state (commit `7a97003`).
- [x] **Dynamic dashboard §2/§4** — brush the net-worth chart → linked activity panel + ← Back/→ timeframe history (commit `913a090`).
- [ ] **Per-account coverage report** — done as analysis (see "Data coverage" below); no code artifact.
- [ ] **Chart: show WHICH accounts are covered at each point** (not just "5/9"). Same single line. Scrub/tooltip should name the exact covered + missing accounts for that day. *In progress.*
- [ ] **Account name editable on the detail page** (`/accounts/[id]`) — first slice of "nothing read-only".
- [ ] **Import Chase ····3522 statements 2022-09 → 2024-07** into the real db (extends history back from the current 2024-07 floor). *See "Statement import" below.*

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

## 🧾 Statement import — Chase ····3522 (2022-09 → 2024-07)

21 monthly Chase checking PDFs provided (gaps at 2023-07 and 2023-11 — likely just the
statement-cycle cadence; confirm with the user or from the next-statement's opening balance).

Pipeline: `src/services/import/service.ts` + `profiles/pdf-profile.ts` (generic
`statementPdf` handles deposit/checking statements with a balance column). Registry in
`profiles/index.ts`. UI action: `src/app/imports/actions.ts` `uploadStatementsAction`.

Plan (STRICT — real financial data):
1. Move + dedupe PDFs (SHA-256) into the repo import storage; discard byte-dupes.
2. **Back up** `data/moneyapp.db` → `data/backups/`.
3. Dry-run parse each via the real profile; verify it extracts txns + begin/end balances
   for the Chase checking format (may need a small Chase-checking tweak to the generic
   PDF profile).
4. Dedup against existing 2024-07+ rows (the 2024-07 statement overlaps the current floor).
5. Apply; each statement's ending balance becomes a **verified anchor**; reconcile to the
   cent (mismatch → quarantined gap, per the trust layer — never fabricate).
6. Re-derive; verify net worth **today** unchanged (interior extends earlier).
7. Verify visually on real data; commit code (parser tweaks) — db stays gitignored.

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
