# MoneyApp — Master Plan (v2, pending approval)

Local-first personal-finance and net-worth app. Rocket Money feature parity minus bill
negotiation and credit score. Runs on the user's Mac; statements never leave the machine;
near-zero cost; Claude API only for rare, batched fallbacks.
v2 incorporates the 4-reviewer adversarial pass (40 findings; ~30 accepted).

Companion docs: [schema.md](./schema.md) (locked schema — approve before any feature work),
[export-checklist.md](./export-checklist.md) (do this now — rolling windows are decaying),
[research/discovery-2026-07-08.md](./research/discovery-2026-07-08.md) (verified source research).

## 1. Final tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript strict + Tailwind v4 | User fluency; RSC keeps DB access server-side naturally |
| DB | SQLite (one file, WAL mode) | Local-first, free, backup-friendly |
| ORM | **Drizzle 0.45.x + better-sqlite3 v12** | Only mainstream combo with truly **synchronous transactions** — import/reconciliation batches commit atomically with no event-loop interleaving (Prisma 7 is async-only). drizzle-kit emits plain hand-editable SQL migrations. better-sqlite3 is in Next's default `serverExternalPackages`; `globalThis`-cached singleton connection (dev hot-reload) |
| Validation | Zod at every boundary (files, routes, rules JSON, Claude responses) | Bank files ARE untrusted input |
| CSV | papaparse | maintained, delimiter-tolerant |
| OFX/QFX | **Hand-rolled tolerant parser (~200 lines)** modeled on Actual Budget's production `ofx2json` | npm OFX ecosystem is thin; the leading OSS finance app hand-rolls for exactly this reason. `ofx-js` (revived May 2026) as fallback |
| PDF | **unpdf** (`extractTextItems` → x/y coordinates → row clustering) | Deterministic table reconstruction; zero pdfjs-dist bundler pain in Next server code. Claude structuring only when the deterministic parse fails its own checksums |
| AI | Anthropic SDK. Haiku 4.5 for merchant classification (batched, cached forever); Sonnet 4.6 for PDF-structure fallback only | Cheapest capable model per job; every call logged with cost |
| Stock prices | **yahoo-finance2** — batch quotes + 2y adjusted daily history, keyless | Actively maintained (Jul 2026). History fallback: Stooq daily CSV (throttled). **Recorded decision**: during a Yahoo outage, quotes degrade to last cached close with a visible "as of" stamp — acceptable for a personal app; a Finnhub `/quote` adapter (free key) is an optional later add |
| Crypto prices | **Coinbase Exchange public API** (keyless, US-friendly, full 2y daily candles) | CoinGecko free caps history at 365 days → fallback for current prices only |
| Charts | **Recharts v3 via the shadcn chart pattern** (CSS-variable theming) | Covers area+brush, stacked bars, donut, sparklines; React 19 native |
| Tests | Vitest (unit/integration on temp SQLite) + Playwright (E2E + visual regression at 320/768/1024/1440, both themes) | Per-module quality gates |
| Runtime | `pnpm dev`/`pnpm start`, localhost-only binding. No auth/encryption (user decision) | launch-at-login wrapper deferred |
| Backups | **better-sqlite3 online backup API (`db.backup()` / `VACUUM INTO`)** — never a raw file copy of a live WAL database (misses -wal contents, can corrupt). On start + first request of each day; rotation 14 daily + 6 monthly. Acceptance includes: snapshot taken mid-write opens cleanly with committed data | corruption/mistake recovery that actually restores |

Repo hygiene from day one: `git init`; `.gitignore` covers `data/` (inbox, originals, DB,
backups) and `.env*`. **Test-fixture policy** (user waived privacy): selected real
statements are copied into a committed `tests/fixtures/<institution>/` directory so the
golden suite runs on any checkout; `data/` stays ignored. `ANTHROPIC_API_KEY` in
`.env.local`; the app fully works without it (AI features queue and show "key missing").

**Why not fork an existing app** (Actual Budget, Firefly III, Maybe): the core of this brief —
anchor-chained 2-year reconstruction, statement-grade reconciliation with quarantine,
Claude-assisted ingestion of five specific institutions — is the part none of them have,
and their budget-first schemas fight the balance-anchor model. We steal proven patterns
(Actual's OFX parser shape) instead of inheriting architecture.

## 2. Category taxonomy (seeded; user-editable; subcategories on)

| Top-level (kind) | Subcategories |
|---|---|
| **Income** (income) | Salary, Interest, Dividends, Refunds & Reimbursements, Other Income |
| **Housing** (expense) | Rent, Home Supplies, Furniture |
| **Utilities** (expense) | Electricity, Water/Gas, Internet, Mobile |
| **Food** (expense) | Groceries, Dining, Coffee, Delivery |
| **Transport** (expense) | Gas, Rideshare, Public Transit, Parking & Tolls, Auto Maintenance |
| **Travel** (expense) | Flights, Hotels, Other Travel |
| **Shopping** (expense) | Clothing, Electronics, General |
| **Subscriptions** (expense) | Streaming, Software, Memberships |
| **Health** (expense) | Medical, Pharmacy, Fitness |
| **Entertainment** (expense) | Events, Hobbies, Games |
| **Personal Care / Education / Gifts & Donations** (expense) | — |
| **Cash & ATM** (expense) | ATM Withdrawals |
| **Fees** (expense) | Bank Fees, Card Annual Fees, Interest Charges, ATM Fees |
| **Rewards** (rewards) | Cash Back, Statement Credits — excluded from income |
| **Transfers** (transfer) | Credit Card Payment, Internal Transfer, Investment Contribution |
| **Investments** (investment) | Buys, Sells (dividends/interest map to Income) |
| **Uncategorized** (system) | landing zone; drives the review queue |

Encoded decisions: **merchant refunds** stay in the merchant's expense category as negative
spend (never flip a merchant's mapping — see schema.md direction guard);
`Income > Refunds & Reimbursements` is only for category-less reimbursements. Statement
credits: matched to their originating purchase where possible (pipeline step 6 below), else
Rewards. Venture X annual fee → Fees; its $300 travel credit → reduces Travel.
Dividends/interest count as **Income**. **Salary**: weekly cash via ATM — a seeded rule
(regex `ATM|CASH DEPOSIT`, inbound, ≥ $200) maps qualifying deposits → Income:Salary **and
assigns the synthetic merchant "Employer (cash)"** so recurring detection can see the series.
The rule is account-unscoped until accounts exist (direction + minimum bound false hits;
review catches the rest). A second seeded rule maps `PAYMENT THANK YOU` descriptors →
Transfers:Credit Card Payment as a day-one hint; Phase 3's transfer detection pairs the
counterpart legs and owns ambiguous cases. Any uncategorized credit ≥ $200 into a deposit
account is force-flagged for review during backfill (historical income was heterogeneous —
expect one manual tagging session).

## 3. Categorization pipeline (per transaction, in order)

0. **Normalize** raw description (versioned normalizer — used for matching only; dedupe
   hashes raw text, so the normalizer can evolve freely).
1. **Explicit user assignment** on the transaction — permanent, beats everything.
2. **User rules** (priority order) — override the merchant map.
3. **Merchant map**: alias lookup exact → prefix → contains → merchant's default category.
   `bank_category` (from card CSVs) is used as a prior/corroborator, never an authority.
4. **Claude fallback**: unknown merchants queue; one batched Haiku call (≤50 merchants,
   2–3 sample descriptions each) classifies against the fixed taxonomy → stored as
   merchant + alias + default (`mapping_source='claude'`), never asked again. Confidence
   below threshold ⇒ `needs_review`.
5. **Corrections**: user fix updates the map permanently (subject to the direction guard)
   and offers one-click retroactive recategorization.
6. **Credit matching** (statement credits/refunds): a credit matching a prior debit on the
   same account (same merchant or similar description, amount ≤ original, within 30 days)
   inherits the original category (`categorization_source='credit_match'`; auto at high
   confidence, else review). Unmatched credits → Rewards.

**Transfer detection**: opposite-signed equal-cent amounts across two accounts within ±4
days + descriptor hints ("PAYMENT THANK YOU", "ACH … ROBINHOOD"). Auto-pair at high
confidence; ambiguous → review. **Coverage metric** on dashboard: % auto-categorized + AI
spend to date.

## 4. Phased roadmap

**Global phase gate** (replaces "polished" with checkable proxies): a phase ships when its
acceptance criteria pass, unit/integration tests are green, Playwright visual baselines pass
at 320/768/1024/1440 in **both themes**, and its screens have zero critical a11y violations.

### Phase 0 — Foundation
Scaffold (Next.js, TS strict, Tailwind v4, Drizzle, Vitest, Playwright); migration 0001 =
approved schema; seed taxonomy/institutions/rules; design system (tokens, typography, theme,
shell); money/date/hash/**normalizer v1** utilities; DB singleton + WAL; online-backup
snapshotter.
**Done when**: app boots to an empty-state shell in both themes; migrations apply from zero;
utilities at 100% unit coverage (cents math, UUIDv7, dedupe hash + occurrence_index
algorithm, date/period boundaries incl. ISO weeks + year edges); a snapshot taken while a
write transaction is in flight opens cleanly containing the committed data; visual baselines
captured.

### Phase 1 — Net Worth (manual) — value on day one
CRUD institutions/accounts (typed, real topology); manual balance entry → anchors;
daily_balances derivation v1 (anchors + carry-forward, spans styled `carried`/approximate —
Phase 2's replay upgrades them); net-worth dashboard (hero number, assets/liabilities split,
account cards, 2-year chart, partial-day annotation); anchor history editing.
**Done when**: your real 10 accounts + balances yield hand-verified net worth (credit
negative); anchor edit/delete recomputes; chart honestly renders 1 anchor, N anchors, gaps,
and partial days; derivation unit tests incl. credit signs and same-date anchor precedence
(manual vs statement); Playwright golden path.

### Phase 2a — Structured ingestion + reconciliation core (the trust layer)
Upload UI → managed storage (archives unpacked before sniffing) → format sniffing → the
**9 structured profiles**: `chase-checking-csv`, `chase-card-csv`, `chase-qfx`,
`discover-card-csv`, `capitalone-card-csv`, `capitalone-360-csv`, `capitalone-ofx`,
`sofi-csv`, `robinhood-activity-csv`. Canonical normalization (signs, dates, `bank_category`
capture); dedupe (raw-hash + occurrence_index + ownership policy incl. takeover/demotion);
statement periods; **both reconciliation identities** (cash/credit exact; investment
value-anchor + market_change); quarantine flow; anchor-chain replay → daily_balances;
per-account coverage bars; import review screen **including a minimal fuzzy-duplicate
review surface** (list + keep/merge) and un-import/re-parse.
**Fixtures-first**: synthetic fixture files built from the research-verified layouts (exact
Chase/Discover/CapOne-card/Robinhood headers, `($x.xx)` negatives, quoted commas, trailing
disclaimer rows, ISO-8859-1 OFX, `INTU.*` tags) make every parser/reconciliation test runnable
**before any real export exists**; real files then extend the goldens. `sofi-csv` and
`capitalone-360-csv` stay **provisional** until a real file confirms their unverified headers.
**Done when**: all structured exports import end-to-end; every cash/credit period reconciles
to the cent via QFX LEDGERBAL / running-balance columns or shows an explicit gap; re-import
of any file adds 0 rows; **import-order permutation test passes** ({CSV then QFX} ≡ {QFX
then CSV} incl. preserved user attributes); truncated-chunk occurrence_index fixture passes;
property test: Σtxns between anchors = Δanchors on every reconciled chain.

### Phase 2b — PDF ingestion + the 2-year backfill
The **5 PDF profiles** (`chase-statement-pdf`, `discover-statement-pdf`,
`capitalone-statement-pdf`, `sofi-statement-pdf` incl. combined checking+savings split,
`robinhood-statement-pdf` incl. detecting-and-excluding crypto rows from the brokerage
anchor); Claude PDF fallback (accepted only when extracted rows reproduce the statement's
own printed totals); full backfill run; boundary-drift re-dating suggestions; coverage bars
to 24 months.
**Done when**: your full PDF set imports; every statement reconciles or shows an explicit
gap; each cash/credit account shows a continuous 2-year curve or honest flagged gaps
(**crypto account explicitly exempt** until Phase 7); net-worth chart shows real 2-year
history with partial-day honesty; PDF extraction golden tests validate against printed
statement totals; deterministic-vs-Claude fallback path tested with a deliberately mangled fixture.

### Phase 3 — Categorization engine
Pipeline above; merchants/aliases/rules CRUD; **review queue** (low-confidence, ≥$200
uncategorized credits, fuzzy dupes from 2a); batched Haiku classification; credit matching;
retroactive recategorize; coverage + AI-spend widgets; **minimal settings page** (AI cap,
thresholds, staleness, week start).
**Done when**: after one pass over the backfill, ≥90% of transactions auto-categorized, rest
in an actionable queue; identical merchant never sent to Claude twice (asserted via ai_calls
in tests); precedence matrix unit-tested (user > rule > map > Claude); direction-guard
tested (a refund correction does not flip the merchant default without confirmation);
credit-matching unit-tested; **transfer pairing: 100% of true card payments between your own
accounts paired; a seeded adversarial set of coincidental equal-amount pairs produces 0
auto-pairs (they go to review)**. Claude mocked in tests; one live smoke test behind an env flag.

### Phase 4 — Spending & income analytics
Category/time breakdowns (stacked bars), drill-down to transaction lists, income view
(salary + interest + dividends timeline — investment-account income included by
construction), MoM and trailing-3-month trends, range selection.
**Done when**: every displayed number reconciles exactly to a visible filterable transaction
list; month totals match manual sums on real data; period-boundary math reuses the Phase 0
tested utilities.

### Phase 5 — Budgets
Budgets per category node at daily/weekly/monthly/annual; actual-vs-budget with subtree
rollup (child counts toward parent; alerts independent; aggregates never double-count —
semantics in schema.md); leftover/overrun visible, never rolls over; in-app alerts at
80%/100%.
**Done when**: all four period types compute correctly across month/year boundaries against
the ISO-week convention (unit-tested with fixed oracles); parent/child overlap behaves per
schema semantics (tested); alert thresholds render correctly; budget actuals match Phase 4
analytics exactly.

### Phase 6 — Recurring detection + forecasting
Detection job (merchant-grouped + `(account, normalized_description)` fallback for
merchant-less rows; median-gap cadence fit; amount stability; ≥3 occurrences); series
management UI + upcoming-bills calendar; forecast engine: fixed baseline (confirmed series
due in window) + variable categories (trailing 3-month average with simple trend,
recurring-tagged excluded) → projected inflow/outflow, EOM cash, net-worth trajectory;
**"show the math" panel**; optional Claude anomaly annotations (annotate-only).
**Done when**: salary ("Employer (cash)", weekly Thu), rent, subscriptions, and card
payments detected from real history with correct next dates/amounts; forecast components sum
exactly to displayed projections; synthetic-corpus targets fixed **now**: ≥95% precision /
≥90% recall on cadence detection, exact next-date on noiseless series; anomaly notes only
above the configurable deviation threshold.

### Phase 7 — Holdings & live prices (independent; can run any time after Phase 1)
Holdings CRUD; optional one-time Robinhood-connector seed — **gated**: fetch accounts,
verify portfolio ≈ $90k (not the $25 agent account), display exactly what would be inserted,
write only on explicit confirm. Price providers behind one interface (yahoo-finance2 /
Coinbase; CoinGecko fallback), lookups keyed by (symbol, asset_type); cache + staleness
policy (refresh on open if >4h). **Live-value flow**: each price refresh upserts a
`source='live'` anchor dated today on investment accounts (excluded from chain checks) so
the net-worth dashboard reflects market value by construction. **Crypto history v1**: derive
the crypto account's daily_balances from the ETH quantity timeline (manual/DMD-entered
trades) × cached Coinbase daily closes — closing the Phase 2b exemption. Portfolio view:
value, day change, P/L vs avg cost, allocation donut.
**Done when**: portfolio value matches the Robinhood app within quote staleness; **net-worth
dashboard total = cash balances + holdings × latest cached prices, unit-tested**; 2-year
price backfill fetched once, served from cache thereafter (asserted); provider outage
degrades to cached prices with an "as of" stamp, never an error page; crypto account shows a
2-year value curve; P/L math unit-tested.

## 5. Design direction (chosen per your delegation)

**"Ledger"** — editorial finance, light-first with an intentional dark mode. Warm
paper-white surfaces, ink-dark text, one confident accent (deep green) for inflows,
restrained warm red for outflows — color always means something. Geist for UI, Geist Mono
with tabular numerals for every figure (money never wiggles). Data-dense tables with
generous section rhythm; charts monochrome + accent; depth via layered surfaces. All tokens
as CSS custom properties (oklch) shared by both themes and the charts. First screen:
net-worth dashboard.

## 6. Risks & mitigations

1. **Rolling export windows** (Chase ~24mo, CapOne ~90d structured) — export pass happens NOW.
2. **Unverified CSV layouts** (SoFi, CapOne 360) — profiles validate header rows, fail loudly,
   stay provisional until real files confirm.
3. **Chase CSV ~1,000-row silent truncation** (reported) — 3-month chunks; coverage computed
   from observed row dates, never the requested range; row counts cross-checked.
4. **Cross-format duplicates** — ownership policy with defined takeover/demotion + order-
   independence invariant + fuzzy review queue.
5. **FITID instability/absence** — raw-content hash is primary everywhere.
6. **yahoo-finance2 breakage** — provider interface + full local price cache; recorded
   staleness decision; Finnhub adapter optional.
7. **Robinhood crypto gap** — transactions: "Download my data" (unpacked + inspected) or
   manual ETH entry; **valuation history: quantity timeline × cached Coinbase closes (Phase 7)**;
   statement parser excludes crypto rows from brokerage anchors to prevent double-counting.
8. **Cash-salary opacity** — seeded rule + synthetic merchant + review queue; recurring
   detector locks on after ~3–4 deposits; one manual session for heterogeneous history.
9. **PDF parser fragility** — deterministic extraction must reproduce the statement's own
   printed totals; then Claude fallback; then quarantine. Reconciliation is the backstop.
10. **AI cost creep** — batching, permanent caching, ai_calls ledger + in-app cap (settings).
11. **Forecast scope creep** — statistics only; every number traceable in the math panel.
12. **Sync-later constraint** — UUIDv7 keys, repository layer, no Mac-isms in the schema.
