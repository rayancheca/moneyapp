# Monarch Money — deep dive + what MoneyApp should learn from it

> **Purpose.** The user saw a Monarch ad ("You don't need a new budget. You need a
> clearer picture.") and loves how Monarch *shows* money. This file is the research +
> a grounded comparison against MoneyApp + a prioritized "what to steal" plan, so we can
> walk through it next pass and decide what to build. Researched 2026-07-15 (pass 13) from
> Monarch's own help/marketing docs, third-party reviews, and a fresh inventory of THIS
> repo. Each Monarch claim is tagged **[doc]** (official), **[rev]** (reviews), or
> **[inf]** (inferred). Sources at the bottom.
>
> **One-line framing:** Monarch is a **hosted, multi-user, aggregator-fed SaaS** whose
> superpower is *presentation + breadth*. MoneyApp is a **local-first, single-user,
> statement-fed** app whose superpower is *data-correctness rigor + total editability*.
> So we copy Monarch's **clarity and features**, not its **plumbing** — and on several
> "honesty" mechanics MoneyApp is already **more correct** than Monarch (§9).

---

## 0. TL;DR — the decisions this file wants from you

**Steal these (high value, fit MoneyApp's architecture):**
1. **Sankey cash-flow diagram** — Monarch's "fan favorite." We already have every
   categorized dollar; it's a pure-SVG viz. Biggest visible "clearer picture" win.
2. **Split transactions** — genuinely *missing* in MoneyApp. One Costco charge →
   groceries + household + electronics. Core ledger capability.
3. **Tags** — an orthogonal label dimension (reimbursable / vacation / tax-deductible)
   on top of the single category. Missing today.
4. **Goals** (save-up + pay-down) — a whole pillar MoneyApp has *zero* of.
5. **Reports "Breakdown vs Trends" + click-a-chart-to-filter-the-ledger** — turn charts
   into inputs, not just outputs. We already have an interactive ScrubChart to build on.
6. **AI "ask your money" assistant** — we already have Claude infra + an API key + a
   cost cap. Natural-language Q&A over the ledger is very on-brand.

**Reconsider (a deliberate MoneyApp "no" that Monarch shows is worth revisiting):**
- **Rollover budgets** (MoneyApp is "no rollover by design"). Monarch's formula is trivial.
- **Flex ("one number") budgeting** as an optional mode alongside category budgets.

**Do NOT copy (MoneyApp is right to differ — §9):**
- Plaid/MX/Finicity **aggregation** (MoneyApp is statement-fed & reconciled-to-the-cent).
- Monarch's **transfer dedup by category-exclusion** (MoneyApp's evidence-based two-sided
  detector is stricter and better).
- Monarch's **"as if you held today's securities"** hypothetical TWR (MoneyApp's
  contribution-timed, NAV-consistent TWR is more correct).
- **Households/multi-user, credit-score bureau, Zillow/VinAudit auto-valuation** — out of
  scope for a single-user local app (manual home/vehicle assets ARE worth adding, §8).

---

## 1. What Monarch is (context + pricing)

- **Company.** Founded 2018 by Val Agostino (the *first PM on the original Mint*), Jon
  Sutherland, Ozzie Osman. After Intuit killed Mint (March 2024), Monarch became the
  default refugee destination: ~20x subscriber growth, **500k+ paying / ~1M users**, a
  **$75M Series B at ~$850M valuation** (May 2025). [doc/rev]
- **Positioning / philosophy** [doc]: *"When you are paying for a service, you are the
  customer"* (not the product) · *"We never sell your financial data"* · ad-free ·
  **collaboration-first** (couples get equal full access, free) · **clarity/planning over
  restriction** (vs YNAB's stricter zero-based discipline).
- **Pricing (2026)** [doc]:
  - **Monarch Core** — $14.99/mo or **$99.99/yr (~$8.33/mo)**, 7-day trial (card required),
    **household sharing included free**. No free tier.
  - **Monarch Plus** — **$199/yr** (annual only): Morningstar-powered multi-year
    **Forecasting/what-if**, deeper investment analysis, business/rental tracking, equity
    comp. Reviewers say Plus is "hard to justify" for most; Core suffices.
  - Frequent first-year promos (WELCOME ~30% off; seasonal 50%-off).
- **Reception** [rev]: 4.9 App Store / 4.7 Google Play. **Loved:** best-in-class household
  collaboration, clean modern UI, strong net-worth+investment tracking, monthly reports,
  ad-free. **Disliked:** price (hardest for ex-free-Mint users), **Plaid sync/re-auth
  breakage** at smaller banks/CUs, tedious custom-category setup, Plus feature-gating.
- **Marketing voice to note** (the user liked it): *"Your home base for money clarity" ·
  "See where your money really goes" · "Reports and charts that are as powerful as they are
  beautiful" · "One app, two ways to budget" · "the fan favorite Sankey diagram."*

---

## 2. Full feature map — Monarch's nine pillars [doc]

1. **Account aggregation** — 13,000+ institutions via **three aggregators at once
   (Plaid + MX + Finicity)**; banks, cards, loans, investments, crypto, **real estate
   (Zillow Zestimate)**, **vehicles (VinAudit)**, **equity comp (RSU/ISO/NSO/RSA)**, and
   **manual accounts** (incl. "manual investment holdings" that still auto-price).
2. **Transactions** — unified searchable list; edit merchant/category/date/notes/tags;
   **split** (incl. AI "smart split"), hide, review, **attachments**, assign owner;
   AI auto-categorization; **CSV import** + first-class **Mint migration**.
3. **Budgeting** — pick **Flex** (one number: Fixed/Flexible/Non-monthly buckets) *or*
   **Category** budgeting; both support **rollovers**, category groups, custom emojis,
   forward forecasting.
4. **Cash Flow** — income vs expenses + the interactive, shareable **Sankey** diagram.
5. **Goals 3.0** — **Save-Up** goals and **Pay-Down** (debt) goals; on-track/at-risk
   status; avalanche-vs-snowball payoff calculator.
6. **Recurring / Bills** — auto-detected subscriptions/bills/paychecks; **calendar + list**
   with **green/yellow/red** paid-states; **Bill Sync** pulls statement balances; reminders.
7. **Investments** — holdings, allocation, performance, top movers across stocks/ETF/401k/
   crypto.
8. **Net worth** — assets − liabilities over time on a customizable dashboard.
9. **Reports** — Breakdown (donut/bar/Sankey) + Trends (grouped/stacked bars); saved reports.

**Plus the "modern SaaS" layer:** households + "yours/mine/ours" **Shared Views**,
notifications + weekly recap, iOS/Android apps + home-screen widgets, a **Chrome extension**
(Amazon/Target itemization), **credit-score tracking**, **Receipt Scanning**, and an **AI
Assistant** (natural-language Q&A + "sparkle" insights). SOC 2 Type II (Jan 2026).

---

## 3. How Monarch handles DATA [doc unless noted]

- **Aggregation.** Monarch is *not* the aggregator — it consumes Plaid/MX/Finicity feeds
  (each has different bank relationships → they use all three for coverage). Provider is
  auto-selected per institution, **user-overridable** if one is flaky. Read-only; *"can't
  access your money, ever."* Credentials live in the aggregator, never Monarch.
- **Sync.** Auto-refresh targeted **≥ every 24h**; manual force-refresh with a progress
  bar; freshness bounded by bank→aggregator cadence (a manual refresh can't pull data the
  bank hasn't released). Connections break/expire → "Update login settings" re-auth.
- **Auto-categorization** — merchant/description → category from a default set; on
  re-categorize, offers to make a **rule** (future and/or past). Known weak spot: Zelle/
  Venmo/checks default to Transfers.
- **Rules engine (if-then)** — match on **original statement text** (recommended — the raw
  string is stable), merchant, amount, account, with *exactly/contains*; actions: rename
  merchant, set category, add tags, set owner, mark reviewed, **hide from budget/cash-flow**,
  **Smart Split**. Runs at ingest; can apply retroactively.
- **Merchant cleanup** — normalize raw descriptors → readable names + logos; **merge**
  variants to one canonical merchant (keeps the raw string so rules stay stable).
- **Splits** — manual (by $ or %) or **Smart Split** (a rule that auto-splits matching
  charges). Each leg independently categorized; parent marked split.
- **Tags** — many-to-one: a txn has **one category** but **many tags**; filter/report by tag.
- **Review flow** — per-txn reviewed/needs-review; mobile swipe; filter the queue (e.g.
  amounts > threshold, super-stores) and sort by date/amount.
- **Transfer dedup** — **exclusion-by-category**: both legs sit in the *Transfers* group
  (special *Credit Card Payment* category) and are dropped from totals. **Not a hard
  two-sided matcher** — users still fix mislabeled legs (Monarch's own docs admit this).
- **Import** — keyword-mapped CSV (date/merchant/amount in any order), three merge modes
  (**Prioritize CSV** = replace date-range, **Prioritize Monarch** = add-missing-only,
  **Import all** = may dup). First-class **Mint** path + open-source mint-export extension.
- **Security** — encryption at rest + in transit (256-bit TLS [rev]), **SOC 2 Type II**,
  US AWS, read-only, **MFA/OTP**, breached-password warnings, **no data sales / no ads / no
  third-party AI training**.
- **API** — **no official public API**; a community of **reverse-engineered Python libs**
  (hammem/monarchmoney et al.) hit the private GraphQL `api.monarch.com` (auth = email+pw+MFA;
  read: accounts/holdings/history/budgets/recurring/transactions/cashflow; write:
  create/update/delete txn + category, set_budget_amount, create_manual_account). [rev]

---

## 4. How Monarch DOES THE CALCULATIONS (the part you asked about) [doc unless noted]

> This is the crux. Monarch's numbers are a **category-typed, cash-basis transaction ledger
> layered over account balances**. Compare each to MoneyApp inline.

- **Net worth** = `Σ(asset-account balances) − Σ(liability balances)`. Asset groups: Cash,
  Investments, Real Estate, Vehicles, Other; liabilities: Credit Cards, Loans. Chart = daily
  balances summed across accounts, **filterable by account type**, hover = daily Δ. History
  comes from aggregator syncs; gaps **backfilled from a per-account balance CSV**; real
  estate = **Zillow Zestimate (weekly Monday refresh)**, vehicles = **VinAudit (~monthly)**;
  manual accounts hold the last entered balance. *How the daily curve is interpolated between
  syncs is undocumented* [inf].
  → **MoneyApp is arguably stronger here:** its derivation engine reconstructs a daily
  per-account curve from **reconciled-to-the-cent statement anchors + transaction replay**
  with an **honest basis tag** (anchored/carried/derived/gap) and coverage-completeness that
  *names the missing accounts* — Monarch just sums whatever the aggregator returned.
- **Cash flow** = income − expenses, **cash-basis** (recorded when you *swipe*, not when you
  move cash to cover it). Income = money from a third party; expense = money to a third
  party. **Transfers (incl. Credit Card Payment) are excluded** so internal moves don't
  double-count.
  → MoneyApp's `/spending` already does gross debit-only "Spent" + a separate never-netted
  `refundsCents`, and excludes transfer/investment/rewards/system — same spirit, more explicit.
- **Budgets — Category mode:** set a planned amount per category/group; **Left to Budget =
  budgeted income − Σ(budgeted expense categories)**; default planned = **trailing 6-month
  average** per category. → MoneyApp seeds from a 6-month average too, and adds **pace
  projection** (spend-to-date + still-expected recurring + extrapolated remainder) — which
  Monarch approximates with a "ticket marker," see §5.
- **Budgets — Flex mode:** three buckets. **Flex number = income − Σ(fixed) − Σ(non-monthly)
  − Σ(goal allocations)**, presented as *one* target; categories inside Flex need no
  per-category budget. → MoneyApp has **no Flex mode** (single-tier category budgets only).
- **Rollover math:** `Remaining(next) = Rollover(prev) + Planned(this) − Actual(this)`;
  overspend carries as **negative** rollover. In **Flex**, rollover touches only the
  category's Remaining (not the bucket); in **Fixed/Non-monthly** it propagates to the
  bucket. → MoneyApp has **no rollover** (deliberate) — this formula is trivial to add (§8).
- **Investments — value** = `Σ(quantity × latest close)` (prices from **Financial Modeling
  Prep**); allocation grouped by asset class. → MoneyApp uses **Yahoo (equities) + Coinbase
  (crypto)** and now carries the last close forward to today (pass 13).
- **Investments — return (important caveat):** Monarch uses a **time-weighted, position-size
  weighted** return, **BUT** because brokerages rarely supply lot buy dates/prices, the
  performance chart shows *"how your portfolio would have performed as if you had held your
  current securities for the entire date range"* — a **hypothetical**, not a
  contribution-timed money-weighted IRR. Cost basis is entered/imported separately on a
  Gains & Losses tab. → **MoneyApp is more correct:** it replays the real **holding-event
  timeline** (`Σ Δqty × same-day close`) so buys/sells/splits are return-neutral by
  construction and the TWR reflects actual contribution timing. **Do not regress to
  Monarch's method.** (MoneyApp *is* missing cost-basis tax-lots / a Gains&Losses tab, §8.)
- **Recurring detection:** on each sync, scans cleaned merchant groups for regular-frequency
  items (mortgage/utilities/subs/**paychecks/transfers**), **~80% recall** [doc], predicts
  next date/amount, notifies **3 days ahead**, and marks each occurrence **green = paid as
  expected · yellow = paid, different amount · red = missed**. Exact frequency/amount-variance
  thresholds undocumented [inf]. → MoneyApp's detector is *statistical & transparent* (median
  gap + CV<0.2 + stored confidence, shows its math) but is **single-cadence** and has **no
  green/yellow/red occurrence states** — both addressed by Track 1 + §8.
- **Pending vs posted:** tracked separately; **editing pending discouraged** (edits can be
  lost on posting); reconcile balance against **posted** only.
- **Splits & refunds:** split = parent partitioned into independently-categorized children
  (legs sum to parent). **Refund offsets by carrying the same category** → category net =
  expenses − refunds. → MoneyApp: refunds already handled as a separate bucket; **splits
  don't exist**.
- **Multi-currency: essentially unsupported** — no FX conversion; everything rendered "$";
  mixing currencies gives **arithmetically wrong** totals. Monarch says connect only USD/CAD.
  → **Potential MoneyApp differentiator** (the user has EUR-from-dad flows): MoneyApp could
  *lead* here with real per-account currency + FX-at-date.

---

## 5. The DASHBOARD + DATA-VIZ (how they "show you") [doc unless noted]

Monarch's data-viz *is* its brand. Details worth copying:

- **Customizable drag-and-drop dashboard** — *"Your home base for money clarity."* Users
  **add / remove / hide / reorder** widget cards; **web and mobile layouts are independent**.
  Cards: Net Worth, Recent Transactions, Investments (value + today's Δ + top movers),
  Cash Flow, Budget, Goals, Upcoming/Recurring, Credit Score, a swipeable **Monthly Review**.
  → MoneyApp already has **drag+keyboard reorder** persisted per-user (`ArrangeableSections`,
  `app_settings.dashboardLayout`) — it's *missing* add/remove/hide + a widget catalog (§8).
- **Net-worth-over-time chart** — scrub/tap any point for that day's value + Δ; **filter by
  account type** (isolate Cash vs Investments vs Loans). → MoneyApp's **vivid ScrubChart** is
  already this (glow line, live scrub dot, coverage band, brush-to-zoom, ChartFocus expand) —
  and arguably nicer. *Missing:* the **filter-by-account-type** toggle on the net-worth chart.
- **Sankey cash-flow diagram** (**the fan favorite**) — income sources fan in on the left,
  split out to category/group/merchant spending on the right; **band width = dollar
  magnitude**; hover for detail, **click a flow → its transactions**; daily→yearly; **share
  the Sankey with all dollar amounts hidden** for privacy. → **MoneyApp has none — the single
  highest-wow steal (§8).**
- **Reports: Breakdown vs Trends dual mode** — **Breakdown** (period totals) = Sankey /
  donut / horizontal bar; **Trends** (over time) = grouped or stacked bars; sliceable by
  category/group/merchant; daily→yearly; **Saved Reports** with relative dates ("This month",
  "Last 2 quarters") that auto-refresh. → MoneyApp has strong `/spending` charts but **no
  unified report builder, no saved reports, no stacked-trend bars, no export**.
- **Charts are inputs, not just outputs** — on desktop, **click a bar/segment/category and
  the transaction list below filters live**, same page (mobile: tap-to-filter). This is the
  defining interaction from their brand refresh. → MoneyApp's stat cards already drill to an
  exact-query ledger, but **charts aren't clickable filters yet** — a great pattern to adopt.
- **Budget viz: traffic-light + "ticket marker"** — each category row is a progress bar,
  **green under / yellow on-pace-to-exceed / red over**, plus a **ticket mark that slides
  left→right with the day-of-month** so you read spend-pace vs time-elapsed at a glance;
  each row shows Budget / Actual / Remaining, custom emoji. → MoneyApp already computes
  pace-projected green/amber/red + a "today" tick — the **ticket-marker visual** is the nice
  bit to borrow.
- **Recurring calendar** — calendar + list at once; **green ✓ (paid as expected) / yellow ✓
  (paid, different amount) / red ✗ (missed)** cells. → MoneyApp has a recurring calendar;
  **add the three paid-states** (folds into Track 1).
- **Monthly Review / Month-in-Review** — auto month-end recap: top spending categories, cash-
  flow trends, **net-worth change broken into assets vs liabilities**; shown as a swipeable
  card + email. → MoneyApp has all the data; **no recap exists** (§8).
- **Color + design language** — signature **warm orange** accent (a deliberate break from
  bank-blue/fintech-green), refreshed **true dark mode** (retired "Navy Mode"), higher info
  density, collapsible nav, an Accounts **Total-vs-Percent** toggle. Reviewers: *"clean,
  intuitive," "easy to spot trends at a glance,"* not flashy. A public design-system
  Storybook exists (storybook.monarchmoney.com). → MoneyApp's design is already deliberate;
  treat this as a *reference*, not a mandate. The **"toggle totals ↔ percentages"** and
  **collapsible groups** are cheap, nice touches.
- **Documented weakness** [rev]: the desktop dashboard can read "dense/utilitarian" and
  Reports were long web-only. Monarch's win is **clarity + interactivity**, not decorative
  flair — which is exactly the bar MoneyApp should clear.

---

## 6. Reception & competitive frame [rev]

| App | Price (2026) | Platform | Superpower | Budget philosophy |
|---|---|---|---|---|
| **Monarch** | $14.99/mo · $99.99/yr (+$199 Plus) | Web/iOS/Android | Broad ad-free hub + couples | Clarity/planning, not restriction |
| Mint (dead 3/2024) | free, ad-supported | — | (was) free | light |
| YNAB | $14.99/mo · $109/yr | Web/iOS/Android | Behavior-change discipline | **strict zero-based** |
| Copilot | $13/mo · $95/yr | **Apple only** | best AI auto-cat + design | flexible |
| Empower | free | Web/iOS/Android | best investment/net-worth analytics | weak budgeting (advisory upsell) |

**Why users switched to Monarch:** ad-free + no data-selling, one broad hub, real couples
collaboration, and a clean UI. **The recurring complaint is aggregator sync flakiness** —
which is *precisely the failure mode MoneyApp avoids* by being statement-fed and
reconciled-to-the-cent. That's the story: **MoneyApp trades "auto-magic sync" for
"provably-correct numbers."**

---

## 7. Monarch vs MoneyApp — the honest scoreboard

Legend: **✅ MoneyApp strong · 🟡 partial · ⛔ missing · ★ MoneyApp already *ahead* of Monarch**

| Dimension | Monarch | MoneyApp today | Verdict |
|---|---|---|---|
| Account aggregation | Plaid/MX/Finicity, 13k inst. | Statement-fed, no aggregator (by design) | 🟡 different bet — see §9 |
| Manual accounts / cash | Manual + Zillow/VinAudit + manual holdings | Cash wallets ✅; **no home/vehicle assets** | 🟡 add manual assets (§8) |
| Statement import | keyword CSV + Mint path | **Deterministic per-bank PDF/CSV/OFX, reconciled to the cent** ★ | ★ ahead |
| Transactions + rules | rules, merchant merge, review | Full ledger, rules, merchant learning, review ✅ | ✅ at par |
| **Splits** | manual + Smart Split | **⛔ none** | ⛔ **build (§8)** |
| **Tags** | many tags per txn | **⛔ categories only** | ⛔ **build (§8)** |
| Transfer dedup | exclusion-by-category (users fix legs) | **evidence-based two-sided detector** ★ | ★ ahead |
| Budgets | Category **+ Flex** + **rollover** | Category + **pace projection** ✅; no Flex/rollover | 🟡 add options (§8) |
| **Goals** | Save-Up + Pay-Down + payoff calc | **⛔ nothing** | ⛔ **build (§8)** |
| Cash flow | income/expense + **Sankey** | `/spending` stat cards + charts ✅; **no Sankey** | 🟡 add Sankey (§8) |
| Reports | Breakdown/Trends + saved + **chart-as-filter** | strong spending views; **no report builder/export/click-filter** | 🟡 extend (§8) |
| Recurring | detect + **calendar green/yellow/red** + Bill Sync | statistical detector + calendar ✅; **single-cadence, no paid-states** | 🟡 Track 1 + states |
| Investments value | qty×close (FMP) | qty×close (Yahoo/Coinbase), carry-forward ✅ | ✅ at par |
| Investment **return** | **hypothetical "as if held today's"** TWR | **contribution-timed NAV-consistent TWR** ★ | ★ ahead |
| Cost basis / tax lots | Gains&Losses tab | running-average only (display) | 🟡 gap (§8) |
| Net worth engine | sum aggregator balances | **honest basis + coverage + carry-forward derivation** ★ | ★ ahead |
| Net-worth chart | scrub + **filter by account type** | vivid ScrubChart + focus ✅; no type-filter | 🟡 add filter |
| Dashboard | add/remove/hide/reorder widgets | **drag+keyboard reorder** ✅; no add/remove | 🟡 extend |
| Monthly recap | auto Month-in-Review | **⛔ none** | ⛔ build (§8) |
| AI | NL assistant + insights | Claude *categorize* infra + API key ✅; **no assistant** | 🟡 build (§8) |
| Editability | edit fields | **"nothing read-only" everywhere** ★ | ★ ahead |
| Multi-currency | ⛔ none (wrong totals) | ⛔ none | opportunity (§9) |
| Collaboration | households, Shared Views | ⛔ single-user (by design) | out of scope |
| Credit score | native | ⛔ | out of scope |
| Security/auth | SOC 2, MFA | **⛔ no auth** (localhost guard only) | ⛔ deploy-blocker |
| Hosting / mobile | SaaS + native apps + widgets | ⛔ local-only (deploy plan researched) | see deploy plan |

**Read:** MoneyApp already **beats** Monarch on the trust-critical core (import correctness,
net-worth honesty, transfer detection, return math, editability). The gaps that matter are
**feature breadth** (splits, tags, goals) and **presentation** (Sankey, report builder,
chart-as-filter, recap) — plus the already-planned auth/deploy.

---

## 8. Recommendations — what to build, prioritized

> Each: *what Monarch does → why it fits MoneyApp → how to build here (files) → effort →
> verdict.* Effort is rough (S/M/L). Nothing here is committed — this is the menu.

### Tier A — high value, strong fit, do soon

- **A1. Split transactions.** [M] One charge → N categorized legs (by $ or %). Fits the
  ledger + "nothing read-only." Build: a `transaction_splits` model (or child rows with a
  `parentId`), make `derivation.ts`/`analytics.ts` treat a split parent as its legs (parent
  excluded from category sums, legs included; balance replay still uses the parent amount),
  a split editor in `LedgerRowExpander`/`TransactionSheet`. Guard: legs must sum to parent
  (string-math cents). **Verdict: build — it's a genuine ledger gap.**
- **A2. Tags.** [S–M] Orthogonal labels (reimbursable / vacation / tax-deductible), many per
  txn, filterable + as a rule action. Build: `tags` + `transaction_tags` tables, chip UI in
  the sheet/expander, a tag filter in `transactions-query.ts`, a `addTags` rule action in
  `rules.ts`. **Verdict: build — cheap, high daily utility.**
- **A3. Sankey cash-flow diagram.** [M] The signature "clearer picture" viz. Pure SVG from
  data we already have (income kinds → category/group/merchant spend). Build: a pure
  `src/lib/sankey.ts` (node/link layout, deterministic → unit-testable), a
  `CashFlowSankey.tsx` on `/spending` (or a new Reports tab), **click a flow → drill to its
  transactions** (reuse the existing exact-query drill pattern), and a **"hide amounts"**
  toggle. Reduced-motion-safe. **Verdict: build — biggest visible win.**
- **A4. "Ask your money" AI assistant.** [M–L] We already have `claude-categorize.ts`,
  `ai_calls` caching, an `ANTHROPIC_API_KEY`, and a monthly USD cap pattern. Build a chat
  that answers NL questions ("why did net worth drop in March?", "how much on food last
  quarter?") by letting Claude call a **small set of typed tools over the existing services**
  (spending, netWorthSeries, portfolio, recurring) — never raw SQL, so answers reconcile to
  the app's own numbers. Cap cost with the existing setting; keep it **local-only until auth
  ships** (it reads the whole ledger). **Verdict: build — on-brand, infra mostly exists.**
- **A5. Chart-as-filter interactivity.** [S–M] Make the `/spending` category bars/donut and
  the net-worth chart **clickable to filter the ledger/panel live** (Monarch's defining
  interaction). We already have the drill-query plumbing; this wires chart clicks to it.
  **Verdict: build — small lift, big "it feels alive" payoff.**

### Tier B — high value, more work / more design

- **B1. Goals (Save-Up + Pay-Down).** [L] A whole missing pillar. Save-Up: target amount +
  date + planned monthly → on-track/at-risk + projected completion; link income/transfer txns
  to a goal. Pay-Down: bring a credit/loan account into a payoff plan with avalanche-vs-
  snowball + extra-payment modeling. Build: `goals` schema, `goals.ts` service (pure
  projection math, TDD), `/goals` page, links from the txn sheet, a dashboard Goals widget.
  Fits editability + accounts. **Verdict: build when you want a new pillar (biggest scope).**
- **B2. Reports builder + Trends + saved reports + export.** [M–L] A `/reports` surface:
  **Breakdown** (donut / horizontal bar / Sankey) + **Trends** (grouped/stacked bars over
  months), slice by category/group/merchant, save reports with relative dates, and **export
  CSV/PDF** (the one place MoneyApp genuinely lacks output). Reuse `analytics.ts` so every
  number reconciles. **Verdict: build — turns strong data into a first-class reporting tab.**
- **B3. Recurring paid-states + calendar polish.** [M, folds into Track 1] Add
  **green/yellow/red** occurrence states (paid-as-expected / paid-different-amount / missed)
  by matching predicted occurrences to posted txns, on the existing `RecurringCalendar`.
  Sequence with the **multi-episode** Track 1 work (S11–S14). **Verdict: build with Track 1.**
- **B4. Monthly Review recap.** [M] Auto month-end "Month in Review": top categories,
  cash-flow trend, **net-worth Δ split into assets vs liabilities**, biggest movers — as a
  dashboard card (swipeable) and optionally an exportable summary. All data exists. **Verdict:
  build — high-clarity, moderate effort.**
- **B5. Cost-basis / Gains & Losses.** [M] A per-holding realized/unrealized G/L view with
  entered/imported cost basis and a long-term-cap-gains (1-year) flag. Extends the strong
  investments module. **Verdict: build if investments are a focus.**

### Tier C — reconsider a deliberate "no"

- **C1. Rollover budgets (optional).** [S] MoneyApp is "no rollover by design," but Monarch
  shows the demand + the formula is trivial: `Remaining(next) = Rollover(prev) + Planned −
  Actual` (overspend = negative). Offer it as a **per-budget toggle** so purists keep the
  clean model. **Verdict: cheap; add as an opt-in.**
- **C2. Flex ("one number") budgeting mode.** [M] `Flex = income − fixed − non-monthly −
  goal allocations`, one tracked target. A second budgeting mode alongside category budgets.
  **Verdict: optional — only if the user wants the "one number" experience.**
- **C3. Manual home/vehicle/other assets.** [S–M] Extend cash wallets to manual **asset**
  accounts (home, car, valuables) so net worth is a full balance sheet. Manual valuations
  first; a Zillow-style fetch is a later optional integration (US-only). **Verdict: build —
  completes net worth.**
- **C4. Dashboard widget catalog (add/remove/hide).** [S–M] We have reorder; add show/hide +
  an "Add widget" menu over the existing dashboard services. **Verdict: cheap extension.**
- **C5. "Hide amounts" privacy mode + Totals↔Percent toggle.** [S] A global blur/hide-dollars
  toggle (great for screenshots/sharing) and an accounts Total-vs-Percent toggle. **Verdict:
  cheap delight.**
- **C6. Net-worth chart: filter by account type.** [S] Toggle Cash / Investments / Credit /
  Loans on the existing ScrubChart to isolate what's driving movement. **Verdict: cheap.**

### Tier D — attachments (ties to deploy)

- **D1. Receipt/PDF attachments on transactions.** [M] Attach a receipt image/PDF to a txn.
  Naturally pairs with the **Vercel Blob** storage work in the deploy plan (private blobs).
  **Verdict: build alongside deployment.**

---

## 9. What NOT to copy — where MoneyApp is right to differ

1. **Don't add Plaid/aggregator sync.** MoneyApp's statement-fed, reconciled-to-the-cent
   model is the *reason its numbers are trustworthy*; aggregator flakiness is Monarch's #1
   complaint, and an aggregator means a third party holds your bank connection. Keep
   statement-fed as the identity. (If "auto-import" is ever wanted, prefer emailed-statement
   ingestion over a credential aggregator.)
2. **Don't downgrade transfer handling to exclusion-by-category.** Monarch drops anything
   *tagged* Transfer and admits users fix mislabeled legs. MoneyApp's evidence-based
   **two-sided** detector (same-day mirror / linked payment-source / both-hinted +
   mutual-nearest; single-sided → review) is stricter and *doesn't silently mislabel*. Keep it.
3. **Don't adopt Monarch's "as if you held today's securities" TWR.** MoneyApp's
   contribution-timed, NAV-consistent return is more honest. Monarch's is a documented
   hypothetical born from missing lot data — a limitation, not a target.
4. **Skip households/multi-user, credit-score bureau, Zillow/VinAudit auto-valuation** for
   now — they need a hosted multi-tenant model and third-party integrations that fight the
   local-first, single-user, statement-fed design. (Manual home/vehicle assets, C3, are the
   in-scope subset.)
5. **Multi-currency is an *opportunity*, not a copy.** Monarch flatly can't do it (mixed
   currencies produce wrong totals). The user has real EUR flows — MoneyApp could **lead**
   here with per-account currency + FX-at-transaction-date, turning a Monarch weakness into a
   differentiator. (Scope carefully; it touches every money sum.)

---

## 10. Open decisions for you (let's pick next pass)

1. **Which Tier-A items first?** (Sankey + splits + tags are the highest "clearer picture +
   real-ledger" trio; the AI assistant is the flashiest.)
2. **Goals — yes/when?** It's the biggest single missing pillar (Tier B, L effort).
3. **Budgets — add rollover + Flex as *options*, or keep the clean single model?**
4. **AI assistant — worth the token cost + do we gate it behind the (planned) auth** since it
   reads the whole ledger?
5. **Reports tab + export — is CSV/PDF export of spending/net-worth wanted?** (The one true
   output gap.)
6. **Multi-currency — pursue as a differentiator, or stay USD-only for now?**
7. **Design cues — adopt a warmer accent / higher info-density, or keep the current look?**
8. Sequencing vs the existing backlog: these interleave with **P0.1 (RH cash), P0.5
   (in-transit bridging), P1.1 (review clusters), Track 1 (multi-episode recurring)**, and
   the **deploy + auth** work. Goals/AI/reports are net-new pillars; Sankey/splits/tags/recap
   slot into existing surfaces.

---

## Sources (selected)

**Monarch official:** monarch.com (features/dashboard, /tracking, /spending, /budgeting,
/investments, /net-worth, /pricing, /security, /for-couples, /whats-new); help.monarch.com
(Cash Flow, Transfers & Credit Card Payments, Using Flex Budgeting, Rollover Budgets,
Creating Your Budget, Transaction Rules, Splitting Transactions, Tags, Investments,
Gains/Losses, Recurring, Bill Sync, Data Providers, Goals 3.0 / Save-Up / Pay-Down,
Customizing Your Dashboard, Forecasting, AI Assistant, Privacy & Security, Importing);
monarch.com/blog (winter-release, monarch-plus, flex-vs-category, goals, shared-views,
visualize-your-cash-flow, brand-refresh, new-net-worth-chart). storybook.monarchmoney.com.
**Reviews/analysis:** NerdWallet, PCMag, Forbes Advisor, Experian, FinanceBuzz, The Penny
Hoarder, Rob Berger, WallStreetSurvivor, The Motley Fool; r/monarchmoney; CNBC/PRNewswire
($75M raise / Plus launch). **Unofficial API:** github.com/hammem/monarchmoney (+ forks).
**MoneyApp:** this repo — `docs/future-ideas.md` (MASTER GUIDE) + the pass-13 code inventory
(services/derivation, categorize, portfolio, recurring, budgets, spending, analytics; the
import pipeline; ScrubChart/ChartFocus; inline-edit primitives).
