# Competitor UX Research — MoneyApp UX Overhaul

**Date:** 2026-07-10

**Purpose:** This document compiles six competitor UX teardowns (Rocket Money x2, Copilot Money, Monarch Money, Robinhood, moomoo) as the primary research input for [docs/ux-overhaul-plan.md](../ux-overhaul-plan.md). Each brief documents core flows, interaction patterns, information architecture, visual design language, delight mechanics, and ranked "ideas worth stealing" with sources and confidence notes. The briefs are included verbatim as delivered by the research passes; nothing has been summarized or trimmed, so downstream planning can cite exact mechanics (tap sequences, UI labels, color grammars) without re-fetching sources.

## Table of Contents

1. [Rocket Money — Transactions & Categorization](#rocket-money--transactions--categorization)
2. [Rocket Money — Spending & Recurring/Calendar](#rocket-money--spending--recurringcalendar)
3. [Copilot Money — Full Teardown](#copilot-money--full-teardown)
4. [Monarch Money — Full Teardown](#monarch-money--full-teardown)
5. [Robinhood — Investing UX](#robinhood--investing-ux)
6. [moomoo — Charts & Data Viz](#moomoo--charts--data-viz)

---

# Rocket Money — Transactions & Categorization

# Rocket Money (ex-Truebill) — Transaction Review & Categorization UX Teardown

**Scope note:** Findings below are sourced primarily from Rocket Money's own help-center articles (which document exact tap sequences and UI labels), plus marketing pages, CNET/Penny Hoarder/Rob Berger/FinanceBuzz reviews, and Reddit-sentiment roundups. Where I could not verify a mechanic from any substantive source, I say so explicitly rather than guess.

## Core flows

### 1. Fix one transaction's category (the atomic flow)
1. Open the **Transactions** tab (bottom nav) or the **Recent Transactions** module on the Dashboard.
2. Scroll or use the search bar to find the transaction.
3. Tap the transaction row → a detail screen opens.
4. Tap the **category chip shown directly below the transaction description** — the category is a first-class tappable element on the detail screen, not buried in an "edit" mode.
5. A full category list appears; tap the correct category. Done — no save button is documented for this path.
- On the **web app** (Premium-only), the equivalent is **hover over a transaction row to expose inline adjustment controls** — category can be changed without opening a detail page.

### 2. "Category Review" — the swipe queue (their headline review mechanic)
1. Dashboard → scroll to **Recent Transactions** → tap **Category Review**.
2. Your **10 most recent transactions appear one at a time as cards**. Each card shows: transaction name, amount, and Rocket Money's auto-assigned category.
3. **Swipe right = "category is correct"** (confirm, advance to next card).
4. **Swipe left = "change it"** — the swipe reveals the category list; tap the preferred category, then the next card is dealt.
5. The tool disappears when the queue is empty and **reappears only after ≥10 new transactions** have posted since the last session — deliberately rationed so it always feels like a 30-second task, never a backlog.

### 3. Create a rule (Premium) — automation from repeated pain
Mobile: 1. **Settings ⚙️ (upper-left of Dashboard)** → 2. **"Categories, Tags & Rules"** → 3. **"Rules" tab** → 4. **"New Rule"** → 5. Tap **"If the transaction…"** to set match criteria — **match on name and/or amount** → 6. Choose the updates to apply.
Web: Settings → **"Transaction Rules"** → "New Rule" → **"Match on Name"** / **"Match on Amount"** → choose updates.
- Rule **actions** documented: change the category, **rename the transaction**, assign the charge to a bill, ignore it from budget "and so on."
- Canonical example in their docs: recurring Venmo payments auto-renamed to "Electric Bill" or "Doggie Daycare" and recategorized — rules solve the P2P-payment ambiguity problem.
- The Rules screen **displays how many transactions currently match each rule** — a live effectiveness counter.
- **Unverified/vague:** whether saving a rule retroactively rewrites past transactions is not documented; sources are silent. Also, I found no official confirmation of an inline "apply to all future transactions from this merchant?" prompt during a one-off category edit — rules appear to be a separate deliberate flow, not an upsell inside the edit flow. (The ignore flow's confirm button "Apply to 1 transaction" hints the codebase supports apply-to-N, but no source shows it offered during category edits.)

### 4. Split a transaction (Premium, mobile only)
1. Tap transaction → tap **"Split"**.
2. Pick split mode: **by specific amounts, by equal amounts, or by percentages**.
3. Tap **"Add Split"** for each portion.
4. Tap the **category icon to the left of each split's title** to assign its category.
5. Optionally add a **note per split** and **ignore individual splits**.
6. **"Save"** → the Transactions tab now shows the splits as separate line items.
- Undo: tap any split → **"Remove"** restores the original (deletes split notes/categories). Not available on web.

### 5. Ignore / exclude
1. Tap transaction → select the **"Ignore"** row.
2. Choose one of **two tiers**: **"Ignore from Budgets"** (stays in spending reports, excluded from budgeted spending — for planned one-offs like a car) or **"Ignore from Everything"** (excluded from all budget/spending reports).
3. Confirm via **"Apply to 1 transaction"**.
- Ignored transactions **remain visible in the Transactions tab**; a dedicated **"Ignored" box at the bottom of the Spending tab** collects them for audit.
- **Web bulk action:** check the **checkbox left of one or more rows** → choose Ignore from the options bar. This is the only documented bulk mechanic.

### 6. Tags, notes, toggles (the rest of the detail sheet)
- **Tags (Premium, mobile only):** transaction detail → **"Add tags"** → pick existing or create → **"Apply"**. Tag creation: Settings → Categories, Tags & Rules → **Tags → "Add Custom Tag"** → name + **color** → Save. Tagged spending is reviewed from the Spending tab (e.g., "Summer Vacation 2026" across many categories).
- **Notes (Premium):** free-text per transaction (and per split).
- **"Is Paycheck?" toggle:** on a deposit's detail screen; **turns green** when enabled, teaching the income detector.
- **"Is Tax Deductible" toggle:** on the detail screen; all flagged items collect under Spending tab → bottom → **"Non-Spending" → "Tax Deductible"**, with an **export link at top right** of that view. (Auto-tagging was discontinued March 2026 — now fully manual.)
- **Rename:** the transaction name is editable from the detail screen (and rules can rename automatically).
- Assembled detail-sheet inventory: name (editable), amount, date, account, **category chip**, Add tags, note, Split, Ignore, Is Paycheck?, Is Tax Deductible, Delete (manual transactions only). Ordering on screen is **not documented** anywhere I found.

### 7. Custom categories (Premium)
Settings ⚙️ → **"Categories, Tags & Rules"** (web: "Categories") → **"New Category"** → name → **choose an icon and a color** → choose **whether it counts toward spend or income** → choose **category group: "Expenses, Earnings, Ignored"** → **Save**. Deletion (mobile only): tap category name → **"Remove Category"**. Free tier: reviews report only ~2 custom budget categories; Premium is unlimited.

### 8. Manual transactions & export (Premium)
- Add: Transactions tab → **three-dot menu (upper right)** → **"Add Transaction"** → choose **Spend or Income** → four fields: **name, date, amount, category** → Save. No account/notes/recurring fields on the form. Mobile only.
- Export: mobile Transactions tab → menu → **"CSV Download"**; web → **"Export"**. **"Apply any filters"** first — the export respects the current filter state; the file arrives by **emailed link, desktop-download only**.

### 9. Recurring linkage (adjacent to review)
Recurring tab has **"Upcoming"** (calendar of next two weeks) and **"All"** views. Manual add: **"+"** → "Add a Bill or Subscription" → pick or create service name → **"Find Transactions"** tool to link past transactions to the bill → set due date/amount → Save. **Payday View** (mobile, requires 3 consistent paychecks detected) overlays bills due before your next paycheck and computes a **"safe to spend"** number.

## Interaction patterns

- **Tap-the-chip editing:** category is a visible, directly tappable chip on the detail screen — one tap to the picker, one tap to fix. No edit-mode ceremony.
- **Tinder-style swipe review:** right = confirm, left = correct. Binary gesture + a capped 10-card deck. The swipe-left transition doubles as navigation into the category picker (gesture reveals UI rather than opening a modal).
- **Green-state toggles** ("Is Paycheck?", "Is Tax Deductible") for boolean reclassification — color change is the confirmation.
- **Web = pointer idioms:** hover-to-edit on rows; **checkbox multi-select** for bulk ignore; mobile has no documented bulk select.
- **Overflow (three-dot) menus** hold rarer actions: Add Transaction, CSV Download (Transactions tab); add/remove (Watchlist).
- **Tap-and-hold drag** reorders Watchlist items on the Dashboard.
- **Sentence-builder rule UI:** "If the transaction…" phrasing turns rule creation into a fill-in-the-blank sentence rather than a form.
- **Confirm buttons state their blast radius:** "Apply to 1 transaction."
- **Search-first finding:** both platforms lean on a search bar in the Transactions tab; help docs repeatedly instruct "use the search bar" as step 1. Documented filterable dimensions are thin — export flow confirms filters exist, and the Spending tab acts as the de-facto category/merchant/tag filter surface. **Vague area:** no source enumerates a full filter panel (amount range, date range, account) — treat filter depth as unconfirmed.

## Information architecture

- **Bottom nav (mobile):** Dashboard, Transactions, Spending, Recurring are all confirmed as named tabs; a fifth (accounts/net-worth/credit area) exists but sources don't agree on its label — unverified.
- **Dashboard** (customizable order for Premium): account balances grouped (checking, credit card debt, "net cash", savings/investments) → **Watchlist items** ("below your linked accounts") → **Recent Transactions** (entry point to **Category Review**) → upcoming bills/insights. In-app banners deliver alerts here.
- **Transactions tab:** flat cross-account feed, searchable; overflow menu for add/export. Sources describe it as a single chronological feed; **date-grouping headers and merchant-logo rendering in rows are not explicitly documented** (their ML pipeline does map raw strings to "brands," and subscription screens show brand logos, so logos in the feed are plausible but unconfirmed).
- **Spending tab (the analytics + drill-down hub):** period selector (**week / month / quarter / year**) → earned vs. spent totals → **category breakdown (tap a category to see all its transactions)** → **top merchants** → **largest purchases** → bottom: **Non-Spending** boxes (**Ignored**, **Tax Deductible**), income view (Spending → Income). Merchant drill-down exists here — this, plus merchant **Watchlist** entries, is how you see "everything from this merchant"; there is **no documented merchant link on the transaction detail sheet itself**.
- **Recurring tab:** Upcoming (2-week calendar) / All; Payday View lives here.
- **Settings ⚙️ (upper-left):** "Categories, Tags & Rules" (categories, tags, rules tabs together), "Notifications & Alerts" (Alerts / Tips / Updates, each with push + email toggles).
- **Web app** (app.rocketmoney.com) is **Premium-gated** and feature-thinner: no splits, no tags, no manual transactions, no manual subscription add — but adds hover-editing and bulk select. Mobile is the primary surface; web is the power-user table view.

## Visual design language

- **Category system carries color + icon:** every category (default and custom) has a user-chosen **icon and color**; tags also carry colors. Reviews consistently describe "color-coded spending categories" and "colorful graphs."
- **Semantics through grouping, not just color:** categories belong to groups — **Expenses, Earnings, Ignored** — plus an orthogonal "counts toward spend/income" flag. Special plumbing categories ("Internal Transfer", "Credit Card Payment", "Reimbursements", "Payroll") exist so transfers don't pollute spending totals.
- **State color:** toggles turn **green** when active ("Is Paycheck?" confirmation).
- **Dark mode is described by Rocket Money as its "signature" aesthetic**; reviewers call the app "colorful and easy to read," "clean, easy-to-understand." Third-party palette sites list green/teal accents (#22d28d family) but I could not verify official brand hexes (Brandfetch blocked) — treat exact palette as unconfirmed.
- **Charts:** Spending tab uses simple comparative bars/donuts (this-month vs. previous months, top categories, top merchants). No source documents chart micro-interactions.
- **Cards as review units:** the Category Review deck renders transactions as large single cards — the same data as a list row, promoted to a focused card when a decision is required.

## What makes it fast / fun

1. **The rationed swipe deck.** Review is reframed from "maintain your ledger" to a 10-card game that only reappears when it's earned (10 new transactions). Binary gesture, zero typing, one card at a time = no visible backlog, no dread. This is the single most distinctive mechanic.
2. **Auto-categorize first, correct second.** ML (regex normalizers + brand-mapping models, per their Hugging Face case study) assigns everything instantly; the human only handles exceptions. Reddit confirms both the value and the failure mode ("It says groceries are entertainment") — which the swipe deck and rules exist to absorb.
3. **One-tap depth:** the category chip is tappable in place; toggles replace forms; splits reuse the category-icon tap.
4. **Rules kill repeat work at the source** — rename + recategorize + assign-to-bill in one rule, with a match counter proving it's working. A user quote on their marketing page: replaced "hours each month organizing every transaction in Excel."
5. **Two-tier ignore** preserves honesty: big one-offs can leave the budget without vanishing from history.
6. **Alerts close the loop:** new/large transaction, price-increase, duplicate-charge, low-balance (customizable threshold), fee alerts via push/email/in-app banners. **Unverified:** exact deep-link landing behavior when tapping a push notification is not documented anywhere I found. Reddit warning: over-alerting is a top complaint ("I feel nagged") — defaults matter.
7. **Friction deliberately added where it monetizes:** rules, tags, splits, notes, custom categories, web access are all Premium. Reviewers flag this as the main annoyance.

## Ideas worth stealing for MoneyApp (ranked)

1. **Swipe-card review queue, capped and rationed.** Surface a "Review categories" card on the dashboard only when N (≈10) unreviewed/low-confidence transactions exist. Right = confirm Claude's classification, left = slide into category picker. Perfect fit for the existing Claude-classification stage — use it as the human-confirmation loop, and feed confirmations back as training signal.
2. **Category chip as the tap target.** In both list rows and the detail sheet, make the category a visibly tappable chip that opens the picker in one tap. No edit mode.
3. **Rule creation as a sentence, with a match counter.** "If the transaction name contains ___ and amount is ___ → rename to ___, set category ___, ignore ___." Show "matches 14 transactions" live, and (improving on Rocket) offer retroactive apply explicitly.
4. **Offer the rule at the moment of correction.** Rocket makes rules a separate settings flow — steal the concept but fix the placement: after a manual category edit, inline-prompt "Always do this for <merchant>? (n past matches)". This out-does Rocket at its own game.
5. **Two-tier exclusion** ("ignore from budgets" vs. "ignore from everything") with a visible Ignored bucket at the bottom of the spending view — auditability prevents the "where did it go?" panic.
6. **Boolean toggles for reclassification** (Is Transfer? Is Paycheck? Is Tax Deductible?) that turn green — cheaper than category surgery for the common plumbing cases, and each maps to special non-spending categories (Internal Transfer / Credit Card Payment) so totals stay honest.
7. **Split with three modes** (exact amounts / equal / percentage), per-split category icon tap, per-split notes/ignore, splits render as separate feed rows, single "Remove" to undo.
8. **Merchant drill-down via the Spending surface + Watchlist pinning** — top merchants list, tap-through to all merchant transactions, pin merchants/categories/tags to the dashboard with drag-to-reorder. Go further than Rocket: add a "View all from this merchant" link directly on the transaction detail sheet (they apparently don't).
9. **Desktop = table idioms:** hover-reveal inline edit and checkbox bulk-select with an action bar (Ignore/Recategorize/Tag), while mobile stays gesture-first.
10. **Category taxonomy with groups + flags:** Expenses/Earnings/Ignored groups, spend-vs-income inclusion flag, icon + color per category, custom categories with the same picker.
11. **Blast-radius confirm copy** ("Apply to 12 transactions") on every batch mutation.
12. **Export honors current filters**, CSV, from the same overflow menu as manual add.

## Sources

- https://help.rocketmoney.com/en/articles/13778317-transaction-category-review
- https://help.rocketmoney.com/en/articles/3332081-editing-and-creating-transaction-categories
- https://help.rocketmoney.com/en/articles/10328100-creating-transaction-rules
- https://help.rocketmoney.com/en/articles/4363893-how-to-split-transactions
- https://help.rocketmoney.com/en/articles/3584535-ignoring-transactions
- https://help.rocketmoney.com/en/articles/12461821-create-and-apply-tags-for-transactions
- https://help.rocketmoney.com/en/articles/10770688-searching-my-transactions
- https://help.rocketmoney.com/en/articles/4402227-adding-transactions-manually
- https://help.rocketmoney.com/en/articles/10296106-exporting-transactions
- https://help.rocketmoney.com/en/articles/3584528-fixing-your-income-transactions
- https://help.rocketmoney.com/en/articles/3584527-working-with-credit-card-payments-transfers
- https://help.rocketmoney.com/en/articles/4839084-tax-deductible-transactions
- https://help.rocketmoney.com/en/articles/13704685-track-the-spending-that-matters-most-with-a-watchlist
- https://help.rocketmoney.com/en/articles/2185531-managing-your-bills-and-subscriptions
- https://help.rocketmoney.com/en/articles/934668-updating-your-notification-settings
- https://help.rocketmoney.com/en/articles/2677184-premium-membership-features
- https://help.rocketmoney.com/en/articles/6235627-enabling-payday-view (via search excerpt)
- https://help.rocketmoney.com/en/collections/18429347-get-the-most-accurate-view-of-your-transactions-with-rocket-money
- https://www.rocketmoney.com/learn/personal-finance/tracking-expenses-with-rocket-money
- https://www.rocketmoney.com/feature/spending-insights
- https://finance.yahoo.com/news/rocket-money-review-2025-cnets-150000066.html (CNET review)
- https://www.thepennyhoarder.com/budgeting/rocket-money-review/
- https://robberger.com/rocket-money-review/
- https://financebuzz.com/truebill-review
- https://www.wallstreetsurvivor.com/rocket-money-review/
- https://beelinger.com/rocket-money-complaints-reddit/ (Reddit sentiment roundup)
- https://huggingface.co/blog/rocketmoney-case-study (ML categorization pipeline)
- https://apps.apple.com/us/app/rocket-money-bills-budgets/id1130616675

---

# Rocket Money — Spending & Recurring/Calendar

## Core flows

### Flow 1 — Reviewing spending for a period (Spending tab)

1. User taps **Spending** in the bottom nav (mobile) or the left sidebar (web at app.rocketmoney.com).
2. Top of screen: a **period selector** — week / month / quarter / year. The web app encodes the selection in the URL (`app.rocketmoney.com/spending?period=lastMonth`), so "This month" / "Last month" / arbitrary periods are shareable, back-button-friendly state.
3. The header region shows **total dollars earned and total dollars spent within the selected timeframe** side by side — this is Rocket Money's de-facto cash-flow view (income vs. expenses per week/month/quarter/year). There is no separate "Cash Flow" tab; earned-vs-spent in Spending plus "Amount Left After Bills" in Budgets carry that job.
4. A **pie/donut chart** breaks the period's spending into categories with "the exact percentage breakdown of my monthly spending" (reviewer wording). A **Settings gear icon sits on/near the spend pie chart** and opens budget management — budget creation actually initiates from the Spending tab on mobile.
5. Scrolling down reveals stacked modules in this order: **spending by category**, **top merchants / most frequent retailers** ("total spent at your most frequent retailers"), and **largest purchases**. Reviews also describe "total monthly spend vs. previous months" comparison charts — current-month pacing against prior months is presented as a trend visual, not just a number.
6. Tapping a category opens that category's transaction list for the selected period (drill-down inherits the period). Sources describe this loosely ("monthly spending reports and detailed breakdowns across all categories," "search transactions across accounts"); the exact drill-down screen layout is not documented anywhere I found — flagging as inferred-but-consistent across sources.
7. From any transaction row, tapping the **three dots (•••)** lets the user edit/correct details; "it only takes a couple of taps to relabel charges." Users can also **split** a transaction (e.g., "separate out my half of the rent"), **ignore** transactions, and (Premium) apply **tags** and **custom categories** (name + icon + color, assigned to a category group like "Earnings").
8. Selecting **Income** inside the Spending tab filters to all income transactions — this is also where users verify income categorization.

### Flow 2 — Reviewing recurring charges (Recurring tab, Upcoming view)

1. User taps the **Recurring** icon (calendar 📆 glyph) in the bottom nav.
2. Default view is **Upcoming**: a **calendar strip at the top of the page** ("Coming Up") showing expected charges, with a **list of upcoming bills below, sorted by date of expected charge**.
3. Source conflict worth noting: the help center says Upcoming covers "the next two weeks"; Google Play's editorial says the calendar shows "upcoming charges scheduled for the next seven days, as well as a list of charges further in the future." Both agree the pattern is *short-horizon calendar on top + longer list below*; the exact horizon has apparently varied.
4. **Paychecks appear on the Recurring tab too**, within two weeks of the scheduled payday — income and bills share the calendar, which is what makes the "before your next paycheck" math legible.
5. Tapping the **double-headed (expand) arrow in the top right of "Coming Up"** opens the full-screen **Calendar view** (month grid of charge dates). On web, Calendar is a Premium-only heading. What tapping a specific day does is **not documented** in any source I found (the reasonable inference — day shows its charges — is unverified).
6. Scrolling past upcoming items shows charges from the past week (recently charged), per the Google Play editorial.

### Flow 3 — Auditing all subscriptions (All view) and series detail

1. In Recurring, tap the **All** heading: every bill and subscription **sorted alphabetically** (Google Play editorial says "separated into categories like utilities and streaming services" — likely grouped sections, another minor source divergence).
2. At the bottom, **"View inactive"** reveals series with no detected payment in the past month. Movement between Active and Inactive is automatic: a new detected charge reactivates a series with no user action.
3. Tapping a subscription opens its detail with due date, amount, and trend info ("the subscription dashboard makes it easy to review due dates, amounts, and trends" — App Store review). Price-increase detection exists as an **alert** ("sends alerts when it detects subscription price increases"); an explicit price-history chart on the detail page is claimed by third parties but not confirmed by official docs — vague, flagging it.
4. The **three dots (•••) to the right of a series row** is the verb menu: Edit, Cancel, etc.

### Flow 4 — Cancelling a subscription (the marquee flow)

1. Recurring → **All** → **•••** next to the subscription → **Cancel**.
2. Two options appear: **"Cancel This For Me"** (Premium concierge) or **"View Instructions"** (self-serve steps tailored to that provider, with phone/website icons to contact the company directly).
3. Choosing concierge: fill a **brief form** (sometimes subscription login info, sometimes a copy of the latest bill). The app shows **"how much you'll save per year by canceling"** — savings framing at the moment of decision.
4. Rocket Money processes in 2–10 business days and emails updates at key steps. If a provider isn't supported, no Cancel option renders at all — the affordance's absence *is* the capability signal.

### Flow 5 — Fixing detection errors

1. **Missing series**: Recurring → **"+"** → "Add a Bill or Subscription" → pick service from a preset list or type a custom name → a **"Find Transactions" toolbar** lets you search and attach the real transactions that belong to the series → adjust **next due date and amount** → Save. **Mobile-app only** — the website cannot add manual series.
2. **Wrong series / not actually recurring**: tap the series name → Options → **Edit** → **"Remove From List."** For miscategorized transactions, ••• → edit details.
3. **Frequency editing**: docs confirm editing due date and amount; explicit frequency-change and **series merging are not documented anywhere** — an App Store reviewer complains that a bill categorized "monthly on the 1st" re-forecasts "in 30 days (the 31st)," suggesting frequency handling is crude and merge doesn't exist. Genuine gap in their UX.
4. **Income errors**: open the deposit transaction → toggle **"Is Paycheck?"** (turns green when on). Income cannot be added manually; it must be detected.

### Flow 6 — Payday View ("$X in bills before your next paycheck")

1. Lives on the **Recurring tab**; app-only. Requires a connected checking account and **3+ detected paychecks** with consistent descriptions/cadence.
2. Setup: Transactions tab → search paycheck description → open most recent deposit → toggle **"Is Paycheck?"** → repeat for unassigned deposits → system recalibrates.
3. Once enabled, the recurring calendar is framed **payday-to-payday**: it shows **bills due before your next payday** and computes a **"safe to spend" number** — income minus bills remaining in the pay period. Limitations: variable/commission income unsupported; only bills paid from that checking account are included.

## Interaction patterns

- **••• three-dot menu is the universal verb container** — on transaction rows and recurring rows alike (Edit, Cancel, recategorize). Primary rows stay clean; destructive/administrative actions hide one tap away.
- **Tap row = drill in; tap ••• = act on.** Consistent split between navigation and mutation.
- **Toggles for classification**: "Is Paycheck?" is a green toggle on the transaction detail — classification is a switch, not a form.
- **Sliders + / − steppers** for all money-amount editing in budget setup (income estimate, bill totals, category budgets), with **Total Budget and Projected Savings recomputing live** as you drag.
- **Expand affordance**: double-headed arrow on the "Coming Up" calendar widget expands the inline strip into the full-screen calendar — a widget-to-screen promotion pattern.
- **Long-press → wiggle → drag** to reorder Watchlist items on the Dashboard (iOS-home-screen idiom); ••• in the section corner to add, ••• per item to remove.
- **URL-as-state on web**: `?period=lastMonth`, `?tab=upcoming`, `?tab=viewAll`, `?sort=dueDate` — periods, sub-tabs, and sort orders are all query params.
- **Notifications as an interaction surface**: "short, understandable sentences" pushed for unusual spend spikes, soon-to-renew subscriptions, price increases, duplicate charges, low balance, and weekly summaries; every alert type individually toggleable.
- **Relabeling is deliberately cheap**: "a couple of taps" to recategorize; recategorization, splitting, and ignoring all live on the transaction object.

## Information architecture

- **Mobile bottom nav** includes Dashboard, Spending, **Recurring** (its own top-level tab — the app's identity feature gets first-class nav), plus transactions/accounts surfaces. Web sidebar: Dashboard, Spending, Recurring, Budgets, Net Worth, with Calendar as a Premium heading.
- **Recurring tab = 3 sub-views**: **Upcoming** (default; calendar strip + date-sorted list) / **All** (alphabetical; "View inactive" appended) / **Calendar** (full month grid). Payday View is a mode of this same tab.
- **Spending tab owns**: period selector → earned vs. spent header → category donut → category list → top merchants → largest purchases → Income sub-view → transaction search. Budgets are configured *from* Spending (gear icon) but rendered as their own screen.
- **Dashboard** = accounts + "Upcoming" strip (paychecks within 1 week, bills) + recent transactions + **Watchlist** (Premium: pinned categories/merchants/tags below linked accounts) + insights.
- Hierarchy is shallow: nearly everything is tab → list → detail, two levels deep, with ••• menus preventing a third level for actions.

## Visual design language

- **Category color + icon system**: every category has an icon and color (user-configurable for custom categories), reused consistently across pie chart segments, category rows, and budget bars — color is the categorical join key.
- **Donut/pie for composition, bars for budgets**: percentage-of-spend donut on Spending; budgets render as "neat colored bars" of income / fixed costs / variable spending "so you see within seconds whether the month is drifting."
- **Green = confirmed/positive** (the "Is Paycheck?" toggle turns green; income figures green vs. spend).
- **Calendar-with-merchant-logos** on Upcoming; merchant logos also anchor recurring rows so a wall of subscriptions scans visually.
- Reviewers consistently describe it as "colorful and easy to read" / "clean, simple" — friendly consumer styling, not terminal-dense.
- **Savings framing rendered in dollars everywhere**: annual savings shown at cancel-time; "found $50/month" copy; Projected Savings in budget setup.

## What makes it fast/fun

- **Zero-effort start with an instant payoff reveal**: the app "scanned all of my accounts and in about 30 seconds came up with a list of subscriptions." The first-session aha — "I found 6+ subscriptions I forgot" — is the whole retention engine.
- **The app does the classifying; the user only corrects.** Detection (categories, recurring series, paychecks) is automatic; every correction is a one-toggle or two-tap fix.
- **Decision-point framing**: "$142/year saved" appears exactly when you're deciding to cancel; "safe to spend $X before payday" appears exactly when you'd overspend.
- **Concierge as the ultimate friction remover** — "Cancel This For Me" turns a dreaded phone call into a form ("nearly 2.5 million subscriptions" cancelled on members' behalf).
- **Payday-relative time, not calendar-month time**: real people budget paycheck-to-paycheck; Payday View reframes the whole recurring surface around that.
- **No confetti found.** I searched specifically; no evidence of confetti/streaks (that's Robinhood's retired pattern). Rocket Money's "delight" is celebratory *copy* and dollars-saved framing plus proactive short-sentence notifications. Some users report notification fatigue ("nagged").

## Ideas worth stealing for MoneyApp (ranked)

1. **Recurring as a first-class tab with Upcoming/All/Calendar sub-views** — calendar strip up top (next 7–14 days), date-sorted list below, expand-arrow to a full month grid. Highest leverage vs. effort.
2. **Payday View math**: detect paychecks (with a per-transaction "Is Paycheck?" toggle for corrections), then show "$X in bills before your next paycheck → $Y safe to spend." Do it better than Rocket: support manual/variable income, which their users explicitly complain about.
3. **Earned vs. spent header + period selector with URL state** (`?period=`): make the Spending view the cash-flow view; drill-downs inherit the period.
4. **Auto Active/Inactive series lifecycle**: no charge in ~1 month → auto-archive to an Inactive section ("View inactive" at list bottom); new charge → auto-restore. Keeps the list truthful with zero user gardening.
5. **"Find Transactions" attach flow for manual series** — when the user creates/corrects a series, let them search-and-link the actual transactions that constitute it. Beat Rocket by also offering **merge series** and **real frequency editing** (semimonthly, every-4-weeks), their two documented gaps.
6. **••• verb menu convention**: row-tap navigates, three-dots mutates, everywhere.
7. **Dollars-at-decision-point framing**: show annualized cost on every series detail and projected annual savings on any cancel/downgrade action.
8. **Watchlist**: pin categories/merchants/tags to the dashboard with wiggle-drag reorder — budget-lite for people who won't budget.
9. **Category icon+color as a system token** reused across donut, rows, bars, and calendar dots.
10. **Short-sentence event notifications** (price increase, new recurring charge detected, free-trial conversion, duplicate charge) — individually toggleable, with restraint, since notification fatigue is Rocket's most-cited annoyance.

## Sources

- https://help.rocketmoney.com/en/articles/3117398-where-can-i-view-my-subscriptions-and-bills (Recurring tab: Upcoming/All/Calendar mechanics)
- https://help.rocketmoney.com/en/articles/2185531-managing-your-bills-and-subscriptions (manual add, Find Transactions, Remove From List)
- https://help.rocketmoney.com/en/articles/934383-missing-subscriptions (detection algorithm, Inactive lifecycle)
- https://help.rocketmoney.com/en/articles/6235627-enabling-payday-view (Payday View, safe-to-spend, Is Paycheck toggle)
- https://help.rocketmoney.com/en/articles/4335689-tracking-your-income (Spending→Income, dashboard/recurring paycheck windows)
- https://help.rocketmoney.com/en/articles/934402-how-do-i-cancel-a-subscription + /4649463 + /13908897 (cancellation flow)
- https://help.rocketmoney.com/en/articles/2649810-creating-a-budget (sliders, Projected Savings, gear icon)
- https://help.rocketmoney.com/en/articles/13704685-track-the-spending-that-matters-most-with-a-watchlist (Watchlist)
- https://help.rocketmoney.com/en/articles/1940551-how-to-get-the-most-out-of-rocket-money (Spending tab overview, pie + gear)
- https://play.google.com/store/apps/editorial?id=mc_apps_phonesky_useredu_rocket_money_fcp (calendar horizon, Cancel for me, three-dots editing)
- https://www.rocketmoney.com/feature/manage-subscriptions ; https://www.rocketmoney.com/feature/spending-insights ; https://www.rocketmoney.com/ (marketing copy)
- https://www.thequalityedit.com/articles/rocket-money-review (pie chart %, relabel taps, splitting)
- https://www.thepennyhoarder.com/budgeting/rocket-money-review/ ; https://www.wallstreetsurvivor.com/is-rocket-money-worth-it/ (period selector, top merchants, largest purchases)
- https://www.ramseysolutions.com/budgeting/what-is-rocket-money ; https://robberger.com/rocket-money-review/ ; https://www.spokesman.com/stories/2026/jun/09/does-rocket-money-actually-help-you-save-cash/ (feature/UI corroboration)
- https://apps.apple.com/us/app/rocket-money-bills-budgets/id1130616675 (user reviews: frequency-forecast complaint, trends on subscription dashboard)
- https://beelinger.com/rocket-money-complaints-reddit/ (user complaints: miscategorization, notification fatigue)
- Web app URLs observed in search results: app.rocketmoney.com/spending?period=lastMonth, /recurring?tab=upcoming, /recurring?tab=viewAll, /recurring?sort=dueDate (URL-as-state evidence)

---

# Copilot Money — Full Teardown

## Core flows

### Flow 1: Onboarding (iOS)
1. Download → app opens into a guided setup; a **demo mode** is available before connecting anything ("take Copilot for a spin before connecting a single account") — the app is fully populated with realistic dummy data so every screen demos itself. Demo mode is also re-enterable later from Settings (for showing the app to someone without exposing your data).
2. Link accounts via Plaid: search bank by name **or website URL**; a "Not on Plaid?" escape hatch offers manual accounts. Historical transactions import immediately and drive everything downstream (initial budget, income detection, recurring detection).
3. Subscription step (trial start, annual/monthly choice, gift/referral code field) happens **during onboarding**, before full use.
4. Copilot **auto-generates an initial budget from your historical spending** — you edit numbers rather than build from zero. Reviewers describe initial auto-categorization as "freakishly spot-on"; a Money with Katie reviewer said full category setup took ~30 minutes total.
5. Copilot auto-detects likely recurrings during onboarding and pre-seeds the Recurrings tab.
6. First-run education funnels you toward one habit: clear the "To Review" inbox. After **30 reviewed transactions**, "Copilot Intelligence" (a per-user ML model) activates and starts predicting categories/types.

### Flow 2: Daily transaction review (the core loop)
1. Open app → Dashboard. Section order: **spending graph → To Review → Budgets → Upcoming (recurrings) → Net This Month → Free Months (referral)**. Sections are user-reorderable via drag handles in Settings > Appearance.
2. "To Review" lists new imported transactions grouped by day, each pre-categorized by the AI. A **light-blue dot indicator** marks unreviewed transactions everywhere in the app (not just this list), and they're resolvable from any transaction list view.
3. If everything looks right: tap one button, **MARK AS REVIEWED**, and the whole batch dismisses. This is the happy path and takes seconds.
4. If a category is wrong (~20% of the time per one power user): tap the transaction → a **detail drawer/sheet** opens → tap the category → pick a new one ("takes all of 8 seconds"). Date and name are edited inline by tapping the current value.
5. On category change, a **non-blocking prompt** offers "apply to all similar transactions" → "Create a Rule Based on the Name" → choose **Exact Match** or **Partial Match** (for Partial you select the substring of the name to match, e.g. "GasBill" from "GasBill032020"). Rules retro-apply to historic transactions. "No thanks" applies to just this one. Newer rule for the same name silently overwrites the old.
6. Every correction trains the personal model; the app explicitly nudges you to "keep your To Review inbox at 0."
7. AI-predicted categories carry an **Intelligence badge**; when confidence is lower, the category picker surfaces the model's **top two guesses at the front of the list**.

### Flow 3: Power review on Mac
1. ⌘1–⌘8 jump between tabs (Dashboard, Transactions, Goals, Cash Flow, Accounts, Investments, Categories, Recurrings); ⌘F is global search across transactions/accounts/categories/recurrings/holdings; ⌘R forces a data refresh; ⌘←/→ navigate view history; ⌘, opens Settings.
2. In Transactions: **arrow keys** move a selection cursor down the ledger; **X** selects, **R** marks reviewed, **C** opens the category picker, **F** opens filters; ⌘A / ⌘⇧A select/deselect all. A category can be quick-edited **without opening the transaction** by clicking its category chip in the row.
3. Multi-select via checkboxes on the left of each row → a **Bulk Edit bar pins to the bottom** with category / review-status / transaction-type actions and an overflow menu (select all, etc.).
4. Filtered sets can be exported to CSV directly from the tab.

### Flow 4: Category drill-down
1. Categories tab: top shows month spent vs. total budget comparison; below, categories sorted **by spend amount**, each row = icon/emoji + colored progress bar + remaining amount.
2. Tap a category → detail view: a spending chart, an editable **budget line label (tap the number to edit inline)**, and that category's transactions for the month.
3. Tap the chart → flips to yearly total + average monthly spend; tap next to "Yearly/Monthly Metrics" to page through past periods.
4. A **magic-wand "Rebalance"** action reallocates budget across categories based on actual spending while holding the total constant (bottom of screen on iOS, top on Mac/iPad).

### Flow 5: Recurrings
1. Tab sections: **This Month (paid / left to pay) → In the Future (less-frequent) → Paused → Archived**; iOS offers list/grid toggle (Mac/iPad list-only).
2. Detection is automatic; expected charges are **pre-counted against the month's budget from day 1** so a rent hit never looks like a spending spike.
3. Tap a recurring → detail view shows its matching **filters as underlined, tappable text** (name filter, amount, frequency) — editing feels like editing a sentence. Mac/iPad adds "Key Metric" and "Last Account Used."
4. Creating one: from a transaction detail ("Mark as recurring") or the + icon → "New Monthly Recurring" view with editable emoji, name, filters, category.
5. Dashboard "Upcoming" is a **horizontally scrolling** strip of expected charges — the closest thing to a calendar; there is no true calendar grid (confirmed gap; it's a top feature request).

### Flow 6: Month in Review
1. At each month boundary a **Month in Review** story appears in the Transactions tab (Year in Review at year end) — a Spotify-Wrapped-style slide deck of spending, income, investments, and trends.
2. **Any individual slide is shareable** (contact or social) via a button at the bottom.
3. Year in Review gifts loyal users (1+ year) an **exclusive legacy app icon** — a collectible reward.

## Interaction patterns

- **Tap = drill down; tap-the-value = edit.** Nearly every number/label (budget amount, transaction name, date, recurring filters) is edited by tapping the displayed value in place, not via an "Edit" mode.
- **Long-press** on a transaction (iOS) enters multi-select; **checkbox click** does it on Mac/iPad. No swipe-to-categorize exists anywhere I could verify — the "fast" feel comes from tap-quick-edit + one-button batch review, not swipes. (If you've seen swipe demos, they're not documented and reviewers never mention them.)
- **Tap-and-hold scrubbing** on charts (net worth, spending) shows exact-date data points; hover does this on Mac/web.
- **Non-blocking follow-up prompts**: rule creation appears as a dismissible suggestion after the primary action completes, never gating it.
- **Keyboard-first on Mac**: single-letter mnemonics (R/C/F/X) inside the list, ⌘-digits for nav — review becomes email triage.
- **Haptics**: light haptic tick on taps/confirmations ("a gentle jolt of recognition" — Money with Katie). Reviewers consistently call out haptic + spring-animation pairing as what makes it feel native.
- **Letter badges** on rows: **[I]** income, **[T]** internal transfer, **[R]** recurring — instant scan-ability of transaction type without color alone.
- **Horizontal scroll** for the Upcoming strip; **vertical everything else**.

## Information architecture

- **Tabs (iOS bottom bar / Mac sidebar, ⌘1–8):** Dashboard, Transactions, Goals, Cash Flow, Accounts, Investments, Categories, Recurrings. **Tab order is user-rearrangeable** (Settings > Appearance) except Dashboard stays home.
- **Dashboard = aggregator of teasers**; every section has a "view all >" style link that deep-links into the owning tab (To Review → Transactions; Budgets → Categories; Upcoming → Recurrings; Net This Month → Cash Flow). The dashboard never dead-ends.
- **Transactions** = flat ledger (multi-year, one list) + search + stackable filters (date, amount, category, account) + manual add (+) + Month in Review entry point.
- **Categories** = budgets live here (there is no separate "Budgets" tab); groups of categories, optional budgeting (can disable budgets entirely per category or globally).
- **Cash Flow** = income / spend / net income cards with MTD/YTD ranges; deliberately **backward-looking only** (excludes unpaid recurrings), which the help docs admit makes its totals differ from Categories — a documented, intentional inconsistency.
- **Accounts** = net worth graph → sections by type (Credit Cards with utilization %, Depository, Investments, Loans, Other incl. auto-created manual Cash account) → "Connections Needing Attention" banner for broken links.
- **Investments** = main chart (Returns/Balances toggle) → Top Movers → Accounts → Allocation donut → Holdings.
- Platform parity is deliberately uneven: iOS is the flagship; web (launched 2025) still lacks Goals, Cash Flow, and Month in Review.

## Visual design language

- **Design pedigree**: founded/designed by ex-Apple people; former design lead Matt Ström-Awn documented building the design system — **30+ shared components, 50+ custom icons, two color themes (light/dark), two platform variants**, plus a Cardinal-agency rebrand away from "cartoon visuals" toward a premium tone.
- **Color = budget state, continuously interpolated**: category bars go **green (on pace) → yellow/orange (trending over) → red (over)** — pace-aware, not just threshold-based. Past months collapse to binary green/red. **Outlined (hollow) bars = expected recurring spend** not yet posted. Credit utilization ≤33% gets a green dot. The dashboard spending line changes color based on where you are vs. the ideal pace.
- **Dashboard graph grammar**: solid line = actual cumulative spend; **dotted line = ideal pace** (last month spread evenly); headline number = "Free to Spend" (e.g. "$1,380 left"). Recurrings excluded so the curve stays smooth and legible.
- **Category identity** = emoji/**Genmoji** + user-chosen color + name; frequent merchants get recognizable icons/logos. Everything user-editable.
- **Charts as first-class components**: every tab leads with a chart; investment live estimate renders as a **dashed line** grafted onto the solid daily line; allocation is a donut by security type (Cash/Equity/ETF/Fixed Income/…).
- **Dark mode** with auto-switching, plus **alternate app icons** and vision-accessibility display settings.
- Known critique (Medium UX audit, 2021): **too many competing colors** (every label, bar, and pie slice colored; similar categories get near-identical hues), all-caps list labels, and bottom action buttons that scroll out of the viewport — the cost of its color-rich language.

## What makes it fast/fun

1. **The inbox-zero loop.** "To Review" turns bookkeeping into a clearable inbox with a visible zero state and a one-tap batch clear. The AI does the work; you only confirm. Users describe checking it like Instagram — "I'm in that shit constantly."
2. **Corrections compound.** Every fix trains a per-user model AND offers a permanent rule, so the app measurably gets quieter — "after two to three weeks the manual work nearly disappears." Effort → visible payoff is the retention engine.
3. **Edit-in-place everywhere.** No settings burrows; the number you see is the control (budget line, transaction name, recurring filters as tappable underlined text).
4. **Prompts never block.** Rule creation, similar-transaction application — all post-action, dismissible suggestions.
5. **Pace, not totals.** Dotted ideal line + pace-colored bars answer "am I okay *for day 14*?" rather than "did I overspend?" — smoothing recurrings out of the graph is the key trick.
6. **Micro-physics**: haptic tick + spring animation on every interaction; charts animate on load; it feels like a first-party Apple app because it obeys platform conventions (native macOS app, widgets, Watch, Siri, keyboard shortcuts, Genmoji).
7. **Ritualized reflection**: Month in Review is a shareable Wrapped-style story with collectible app-icon rewards — a monthly re-engagement mechanic disguised as celebration.
8. **Demo mode** kills the empty-state problem twice: pre-signup (try before trusting) and socially (show friends safely).

## Ideas worth stealing for MoneyApp

1. **To Review inbox with one-tap "Mark all as reviewed" + persistent light-blue unreviewed dots app-wide.** Highest leverage; it's Copilot's entire retention loop. MoneyApp already has Claude classification — surface it as an inbox to confirm, not a log to browse.
2. **Non-blocking rule prompt after every category correction** (exact vs. partial name match, substring picker, retro-apply to history, newest rule wins). Pairs perfectly with the existing bank-category stage.
3. **Pace-colored budget bars** (green→amber→red by *projected* pace, hollow outline segment = expected recurring not yet posted). This is one component that carries enormous information.
4. **Dashboard spending line: solid actual vs. dotted ideal, recurrings excluded, "Free to spend $X" headline.** Cheap to build on existing data; the single best glanceable answer in the genre.
5. **Keyboard triage on desktop**: arrow-move, R=reviewed, C=category, F=filter, X=select, ⌘1..n tab nav. MoneyApp is web-first — this is a differentiator Copilot's own web app still lacks.
6. **Tap-the-value inline editing** for budget amounts, names, dates — kill every modal you can.
7. **Letter badges [I]/[T]/[R]** for transaction types + logo/emoji category identity with user color.
8. **Month in Review shareable story** — a slide deck generated from the month's data; even 5 slides (total spend, top categories, biggest merchant, net income, investment change) creates ritual.
9. **Recurring filters rendered as an editable sentence** (underlined tappable tokens) and pre-counting expected recurrings against the month.
10. **Demo/sample-data mode** as both empty state and privacy screen.
11. **Budget rebalance "magic wand"** — one action redistributing budgets from actuals while preserving the total.

**Conflicts/uncertainty:** StackSwitch's review claims Android support, no dark mode, and CSV import absence — all contradicted by Copilot's own docs/other reviews (iOS/iPadOS/macOS/web only; dark mode exists; CSV *export* exists, import doesn't); treat that source as partially unreliable. "Swipe-to-categorize" is not documented anywhere official and no reviewer describes it — the speed comes from tap quick-edit and batch review. Month-in-Review slide-by-slide contents aren't publicly documented; only the scope (spending, income, investments, trends) and per-slide sharing are confirmed. Mobbin flow pages (onboarding, dashboard, bank-linking) exist but are behind a login (403) — worth screenshot-mining manually.

## Sources

- https://help.copilot.money/en/articles/6045480-dashboard-tab-overview
- https://help.copilot.money/en/articles/9554412-transactions-tab-overview
- https://help.copilot.money/en/articles/8182433-copilot-intelligence-for-spending
- https://help.copilot.money/en/articles/6778561-copilot-money-for-macos
- https://help.copilot.money/en/articles/7668990-bulk-editing-transactions
- https://help.copilot.money/en/articles/3971270-creating-name-rules
- https://help.copilot.money/en/articles/3971267-transaction-types
- https://help.copilot.money/en/articles/9504513-categories-tab-overview
- https://help.copilot.money/en/articles/9778259-recurrings-tab-overview
- https://help.copilot.money/en/articles/5377645-investments-tab-overview
- https://help.copilot.money/en/articles/6213732-accounts-tab-overview
- https://help.copilot.money/en/articles/9682232-cash-flow-tab-overview
- https://help.copilot.money/en/articles/10310024-month-and-year-in-review
- https://help.copilot.money/en/articles/11157550-quick-start-guide
- https://help.copilot.money/en/articles/11062072-settings-overview
- https://www.copilot.money/ and https://www.copilot.money/dispatch (changelog)
- https://mattstromawn.com/projects/copilotmoney/ (former design lead's case study)
- https://moneywithkatie.com/copilot-review-a-budgeting-app-that-finally-gets-it-right/
- https://medium.com/design-bootcamp/ux-ui-audit-4-improvements-for-the-copilot-app-57e9f8e4ac20
- https://goldpenguin.org/blog/copilot-money-review/
- https://www.thepennyhoarder.com/budgeting/budgeting-copilot-money-review/
- https://stackswitch.app/review/copilot-money (partially unreliable — see conflicts)
- https://mobbin.com/explore/flows/bec90a3f-1c1b-490a-b27d-8445cc6e62a7 (login-gated)

---

# Monarch Money — Full Teardown

## Core flows (step-by-step)

### 1. Dashboard → anywhere (the hub)
1. Dashboard is a vertical stack of widgets: Getting-started guide, Net worth, Budget, Spending trend, Transactions (recent), Recurring, Investments, Credit score, Advice, Monthly progress (mobile).
2. "Customize" button sits top-right on web (bottom of the dashboard on mobile) → enters an edit mode where widgets can be drag-and-dropped to reorder or toggled hidden. Web and mobile layouts are stored **independently** — different order/visibility per platform.
3. Every widget is a teaser that deep-links to its full page: Budget widget → Budget page, Net worth → Accounts, Recurring → Recurring page, Transactions widget rows → transaction drawer. A single "refresh all accounts" action updates all connections within ~60s.
4. Mobile adds a "Monthly progress" view: current-month cash flow, budget status, and net worth in one card, with the ability to page back to past months' end states.

### 2. Transactions: review → edit → rule (the signature loop)
1. Transactions page = filter bar on top (search box + filter chips: category, merchant, account, tags, date range, amount with debit/credit + eq/gt/lt/range operators, "Hidden only" under Other) above a dense chronological table grouped by date.
2. Click any row → it expands (web) / opens a drawer with editable fields: merchant, category, date, notes, tags, attachments, plus toggles for Hide, Split, Review status, Delete (Delete lives at bottom of the detail panel on web; behind a three-dot menu on mobile).
3. **The rule widget:** after ANY manual edit (e.g., recategorize a Nordstrom charge), a popup invites "Create rule" — pre-filled with the change you just made. Checking "Apply # changes to existing transactions" retroactively fixes history, with a live count. This is the single best interaction in the app: correction and automation are one gesture.
4. **Bulk edit:** click "Edit Multiple" → checkboxes appear on every row + "Select All" at top → select → "Edit # transactions" → one form edits merchant/category/date/notes/tags/hide/review-status/goal-link for all → Save → explicit confirm "Apply to all (# transactions)". Mobile: checkbox icon top-right → same flow → "Apply". (No source documents shift-click range selection; assume absent.)
5. **Review status:** new synced and/or uncategorized transactions can be auto-marked "Needs review" (Settings → Preferences toggles). "Needs review by" is assignable: anyone / me / specific household member. Clearing: tap the ✓ on a row, swipe right on mobile, Cmd/Ctrl+Enter with the transaction open, or bulk via Edit Multiple → Review Status → Reviewed. Filter dropdown "Needs Review by…" turns the page into an inbox.
6. **Splits:** in the drawer, "Split transaction" → split by percentage or dollar amount, "Add a split" for N parts, each part gets its own category/merchant. Rules can auto-split.
7. Pending transactions are read-only by default (opt-in edit via Preferences, with a warning that bank-posted data will overwrite).

### 3. Rules engine (Settings → Rules)
1. Conditions (all AND): Original statement (exact/contains — the raw bank string, pitched as the stable key), Merchant name (exact/contains), Amount (debit/credit; =, >, <, between), Category, Account, Owner (household member), Business entity.
2. Actions: rename merchant, set category, set owner, add tags, hide from budget/cash flow, set review status (+ assignee), link to a save-up/pay-down goal, assign business, **split by % or $**.
3. Rules execute top-down in list order and stack sequentially if multiple match; drag-and-drop reorder on web; desktop shows a **preview of affected transactions before saving**; retroactive-apply checkbox with count.

### 4. Cash Flow
1. Header: Summary card — total income, total expenses, net difference, savings-rate % for the selected period.
2. Toggle granularity monthly / quarterly / yearly; group the breakdown by **category, group, or merchant**; filter by accounts or tags.
3. Two chart modes: bar chart (income vs expense columns) and — **web only** — the Sankey diagram. Sankey display modes: Category, Group, or Category & Group (income sources flow into a central income node, out to expense groups, then categories; exact node hierarchy isn't officially documented — inferred from screenshots/reviews).
4. Universal drill-down contract: "most areas are interactive — hover a point for details, click to view all related transactions." Clicking any bar segment or Sankey band lands on the filtered transaction list.
5. Sankey is shareable as an image (OS share sheet) with an option to **hide all dollar amounts** — built for "show your advisor/spouse/Reddit."
6. Criticism (Kristen Berman): the chart is "accurate but unreadable" — no plain-language translation of what the graph means; she argues every chart needs an AI headline takeaway ("money comes in on the 22nd, leaves on the 30th").

### 5. Budget (Flex vs Category)
1. Two modes, switchable in Budget Settings (with a guided "Budget Walkthrough"): classic **Category budgeting** and **Flex budgeting** (now the default).
2. Layout (web): three columns — Budget / Actual / Remaining — under collapsible Income, Expenses, Contributions sections. Mobile shows two columns; **long-press a number or tap the column header to swap the third column**.
3. Flex model: every expense category is bucketed as **Fixed** (stable bills), **Non-monthly** (irregular-but-predictable; requires rollover ON + target amount + frequency; Monarch computes monthly set-aside = target ÷ frequency), or **Flex** (variable; tracked against ONE total number, not per-category). Unbudgeted Flex categories still count toward the Flex total; an "Unallocated Flexible Budget" line shows what's left after any category-level sub-budgets.
4. Status colors: green = under budget, yellow = on pace to exceed, red = over; a tick mark on the progress bar shows today's position in the month.
5. **Move money:** click the "pill" showing a category's remaining amount → transfer budget between categories/buckets (into Income, Fixed, Non-monthly, or the Flex total — not individual Flex categories). Reviewers note there is **no undo** here.
6. Rollover semantics differ by bucket: Fixed/Non-monthly rollovers affect both category- and bucket-level Remaining; Flex rollovers affect only the category line, never the Flex total.
7. Editing: click the budget cell → inline text box, with that category's historical spending shown alongside as guidance; initial budgets are seeded from a 6-month average. Hover right of a category name → gear icon → category settings. Flex categories auto-sort by actual spend (biggest first); Fixed/Non-monthly follow the user's custom sort. Clicking a category row shows its spend and links to its transactions.

### 6. Recurring
1. Detection is automatic from synced transactions; detected merchants land in a **suggestion review queue** — user confirms before they become recurring. Manual paths: search-and-add a merchant, or auto-track credit-card/loan bills ("Bill Sync" pulls statement balance + due date).
2. "Monthly" tab: **list ⇄ calendar toggle top-right** (web). Calendar semantics: green + checkmark = paid as expected; yellow + checkmark = paid, different amount; blue = upcoming; red + X = missed. Mobile "Upcoming" merges calendar + list with the same color dots.
3. "All Recurring" tab: every recurring merchant, sorted active vs canceled. Edit any series' frequency, expected amount, and due date inline; "Twice a month" schedules 1st/15th and shifts weekend dates to the prior business day.
4. Any transaction can be marked recurring/not-recurring from its drawer (linking it to a series). Two subscriptions at one merchant are handled by cloning the merchant into differentiated profiles ("Gym — Suzie").

### 7. Investments
1. Two tabs: **Holdings** (all securities, groupable by type / institution / account; columns: price, quantity, total value) and **Allocation** (portfolio by asset class — stocks, ETFs, mutual funds, cash, crypto).
2. Performance graph overlays the portfolio's **time-weighted return** against benchmarks (S&P 500 etc.); position-size-weighted. Click a holding → detail chart + per-account breakdown of that security.
3. "+ Add holding" for manual securities; manual holdings roll into allocation and net worth. Investment *transactions* are an opt-in beta (Settings → Preferences) that pipes trades into the Transactions page and cash flow. Users report benchmark gaps for unsupported funds and no dividend-income treatment.

### 8. Reports
1. Three tabs — Cash Flow, Spending, Income — each with **Breakdown** (totals) and **Trends** (over time) modes.
2. Chart types: Sankey, grouped/stacked bar, pie/donut, horizontal bar (web only). Dimensions: category, group, merchant, account, tag, fixed/flex classification. Filters: date range (presets from "Last 7 days" to "All time"), accounts, categories, merchants, goals, owner, business, amount, tags.
3. Any configuration can be **saved as a named report** that auto-updates and is retrievable from Cmd+K by name. CSV export and URL sharing are web-only.

## Interaction patterns

- **Cmd+K palette (web):** searches categories, merchants, accounts, goals, and saved reports; navigates pages; exposes **context-aware actions** ("Mark as reviewed," "Ask AI to explain this transaction" when a transaction is open); can generate reports from natural language; toggles dark mode. Notably it does *not* search individual transactions by amount/date.
- **Keyboard:** `g` then `r`/`a`/`i` → Reports/Accounts/Investments (Gmail-style go-to chords); `[` toggles the left nav; Cmd/Ctrl+Enter marks the open transaction reviewed. Full list surfaced inside the Cmd+K panel.
- **Hover reveals controls:** budget gear icons, chart tooltips, row actions appear on hover — keeps the resting UI clean and the table dense.
- **Click = drill down, everywhere:** chart segment → filtered transactions; budget category → its transactions; account row → account detail page (balance history chart, holdings, transactions); merchant → merchant page (editable details, custom logo upload, merge duplicates). Breadcrumbs (added in the 2025 refresh) trace the path back.
- **Inline/in-place editing:** budget amounts are inline text boxes; transaction fields edit inside the expanded row/drawer without navigation; changes autosave (review-status assignment "saves automatically").
- **Mobile gestures:** swipe right on a transaction = mark reviewed; long-press budget column numbers to toggle which column shows.
- **Confirmation asymmetry:** single edits autosave; bulk edits demand an explicit "Apply to all (n)" — the count in the button is the safety mechanism.
- **Micro-delight:** celebratory animation on a successful account connection; press/rating carousel during trial signup.

## Information architecture

- Left sidebar (web, collapsible via `[`, functional even when collapsed): Dashboard, Accounts, Transactions, Cash Flow, Reports, Budget (or "Plan"), Recurring, Investments, Goals, Advice/Assistant, Settings.
- Entity graph is the backbone: **Type (Income/Expense/Transfer, immutable) → Group → Category** (a transaction has exactly one category); **Tags** are many-to-many overlays (e.g., "HSA Reimbursable," trip tags); **Merchants** are first-class entities (logo, rename, merge, recurring flag); **Accounts** (with owner + institution); **Goals** and **Business entities** attach via links/rules. ~60 default categories, ML auto-categorization that reviewers say converges after ~2 weeks.
- Transfers are a special type excluded from budgets/cash flow to prevent double counting; "Hide" removes a transaction from budget/cash-flow math but keeps it in lists and search.
- Settings hosts the power tools: Rules, Categories, Merchants, Preferences (pending-edit toggle, auto-needs-review toggles), Budget settings (mode switch, recalculate/zero-out/walkthrough).
- Onboarding deliberately locks all nav except "Add account" until a connection succeeds (forced golden path).

## Visual design language

- **2025 brand refresh:** warmer, higher-contrast light and dark palettes (old "Navy Mode" dark theme retired); new wordmark of "two lines coming together" (collaboration metaphor) replacing the butterfly. Marketing palette anchors around deep indigo/blue (#395384-family) with vibrant accent hues; a public Storybook exists (storybook.monarchmoney.com) but is bot-blocked, so exact tokens are unverified.
- **Color is semantic, consistently:** green/yellow/red = under/at-risk/over budget and paid/partial/missed recurring; blue = upcoming/informational. The same traffic-light grammar spans budget bars, calendar dots, and category pills. Categories and groups carry their own hue + emoji-style icon that persists across charts, lists, and the Sankey bands.
- **Density as a feature:** the refresh explicitly reduced transaction row heights, tightened dashboard widgets, made account groups and budget sections collapsible, shrank nav width and modal margins. (Power users still install an extension for compressed fonts — density demand exceeds supply.)
- **Charts feel like one system:** soft rounded bars, generous tooltips, muted grid, category colors reused verbatim; Sankey is the showpiece/shareable artifact. Typography is a single friendly humanist sans, hierarchy via weight/size not face changes.
- Overall register: "lighter, friendlier, more approachable" than Copilot; "clean, colorful, thoughtfully designed" per reviewers — approachability over Bloomberg-ness.

## What makes it fast/fun

1. **Edit-becomes-rule:** the post-edit rule widget converts one-off corrections into permanent automation with a retroactive count. Zero-cost automation adoption is the core retention loop.
2. **The universal drill-down contract:** users learn once that *everything clickable ends at a filtered transaction list*. Trust in that invariant makes exploration free.
3. **Cmd+K + go-chords** make the web app feel like a productivity tool, not a bank portal.
4. **Inbox-model review:** "Needs review" turns bookkeeping into email triage — swipe/checkmark/Cmd+Enter, assignable to a spouse. Finishing the queue is a completable task.
5. **One-number Flex budget** removes the noisiest decision (per-category limits) while keeping fixed bills automated.
6. **Shareable Sankey with amounts hidden** — a social/advisor artifact that markets the product.
7. Friction that remains (fair warning): unreadable-without-translation charts, no undo on budget moves, retrospective-only alerts, connection maintenance (~10–15 min/month per one review).

## Ideas worth stealing for MoneyApp (ranked)

1. **Post-edit rule prompt with retroactive count** — after any manual recategorize/rename, offer "Create rule → Apply to N existing." Highest leverage, matches the existing categorization-stage work.
2. **Universal drill-down invariant** — every chart segment, budget row, widget number click-navigates to a pre-filtered transaction list with breadcrumb back. Make it a hard contract.
3. **Cmd+K palette** with entity search (categories/merchants/accounts/saved views), `g`-chord navigation, and context actions on the open transaction.
4. **Review-status inbox** — auto-flag new/uncategorized imports, ✓/Cmd+Enter/swipe to clear, filter as an inbox. Perfect for a statement-import app where classification confidence varies.
5. **Bulk edit pattern verbatim:** Edit Multiple → checkboxes + Select All → one form → "Apply to all (n)" confirm.
6. **Rules engine shape:** AND-conditions on raw statement text (stable key) + amount operators; actions include split and hide; ordered execution with drag reorder and pre-save preview.
7. **Recurring color grammar** (green paid / yellow amount-drift / blue upcoming / red missed) + list⇄calendar toggle.
8. **Flex three-bucket budget** with move-money pills and per-bucket rollover semantics — differentiated but simpler than envelopes.
9. **Merchant as first-class entity** — merge, rename, logo, recurring flag, own page.
10. **Saved reports as named, Cmd+K-searchable entities** that auto-refresh.
11. **AI headline over every chart** (Berman's critique — Monarch's gap, your opening): one plain-English sentence translating what the chart says.
12. **Density + breadcrumbs refresh learnings:** short rows, collapsible groups, semantic color with real contrast in both themes.

## Sources

- https://help.monarch.com/hc/en-us/articles/360048393372-Creating-Transaction-Rules (fetched via Zendesk API)
- https://help.monarch.com/hc/en-us/articles/4402645984916-Editing-Multiple-Transactions
- https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions
- https://help.monarch.com/hc/en-us/articles/5528707082516-Reviewing-Transactions
- https://help.monarch.com/hc/en-us/articles/20504904768020-Cash-Flow
- https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports
- https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting
- https://help.monarch.com/hc/en-us/articles/360048883631-Creating-Your-Budget-in-Monarch
- https://help.monarch.com/hc/en-us/articles/4890751141908-Tracking-Recurring-Expenses-and-Bills
- https://help.monarch.com/hc/en-us/articles/41855507661076-Investments-in-Monarch
- https://help.monarch.com/hc/en-us/articles/38610714553108-CommandK-Search-Bar-and-Shortcuts
- https://help.monarch.com/hc/en-us/articles/360058127551-Customizing-Your-Dashboard
- https://help.monarch.com/hc/en-us/articles/28953573066260-Tips-Tricks-for-Using-Monarch
- https://help.monarch.com/hc/en-us/articles/4411119762196-Rollover-Budgets
- https://help.monarch.com/hc/en-us/articles/15000751305108-Using-Goals / Goals 3.0 articles
- https://johnstone.substack.com/p/product-teardown-monarch-money
- https://kristenberman.substack.com/p/monarch-how-a-behavioral-scientist
- https://www.monarch.com/blog/monarch-brand-refresh
- https://www.monarch.com/blog/visualize-your-cash-flow-like-never-before
- https://www.monarch.com/blog/monthly-progress-view
- https://www.monarch.com/blog/new-net-worth-chart-investment-transactions-and-more
- https://envelopebudgeting.com/articles/monarch-money-review
- https://www.lionhoodfinancial.com/blog/-practical-guide-to-using-monarch-money-for-active-users
- https://www.emilyblasik.com/blog/how-i-budget-with-monarch-part-2
- https://github.com/RobertParesi/Monarch-Money-Tweaks (power-user extension revealing UI gaps)
- https://storybook.monarchmoney.com/ (design system exists; bot-blocked, tokens unverified)

**Confidence notes:** help-center mechanics are verbatim-reliable (fetched via Zendesk API after the HTML was bot-blocked). Sankey node hierarchy and the full keyboard-shortcut list are partially inferred — official docs confirm display modes and sample chords but not the complete set. Reddit was crawler-blocked; real-user texture comes from blog reviews, Bogleheads references inside search snippets, and the Tweaks extension instead. Some pre-2025 sources describe the old "Navy Mode" UI; the brand-refresh post is the authority on current visuals.

---

# Robinhood — Investing UX

# Robinhood Investing UX Teardown (Mobile + Web)

Confidence notes are inline. Everything sourced from Robinhood's official help center, newsroom posts, the PORTO ROCHA/COLLINS rebrand case studies, Google Design's profile of the app, and multiple design teardowns. Items I could not verify from a primary source are flagged.

## Core flows

### Flow 1: Portfolio home — "how am I doing?"
1. App opens directly to the Investing/home screen. Top block: portfolio value as the dominant element (largest type on screen), with today's return directly beneath in dollars AND percent, colored green/red.
2. Below the number: a full-bleed line chart of portfolio value. No axes, no gridlines, no labels — just the line. On the 1D range, a horizontal **dotted line** marks the previous close baseline; the line renders green where above it and red where below it (officially documented behavior).
3. Below the chart: a horizontal row of time-range pills — **1D / 1W / 1M / 3M / YTD / 1Y / ALL(MAX)**. Tapping a pill re-plots the chart with a range-appropriate interval (documented: 1D = 5–10 min points, 1W = 10–30 min, 1M = 1 hr, 3M–1Y = 1 day, 5Y = 1 week, MAX = 1 day–1 month). The selected pill is highlighted in the current gain/loss accent color.
4. **Scrub**: press-and-hold anywhere on the chart, then drag. A vertical hairline follows the finger; the big number at top swaps to the portfolio value at that point, and the return line recalculates from the range's start to the scrubbed point; a timestamp label appears. Official docs phrase it as "select and hold a specific point in the chart for the price on that day and time." Releasing snaps the header back to live values. (A subtle haptic tick while scrubbing is widely reported and consistent with Robinhood's documented use of haptics elsewhere, but I found no official doc confirming scrub haptics specifically — treat as very likely but unverified.)
5. Return baseline math (documented and worth copying): today's return uses the previous 4 PM ET close as baseline; if the user holds crypto, crypto uses 12 AM local-time fair value as its baseline. **External deposits/transfers are excluded from return calculations** so the chart shows performance, not cash flow.
6. Below the chart: a **buying power row** (tap to expand into a breakdown of cash/withdrawable/etc. in the Account area), then a swipeable **cards carousel** (feature announcements, order/dividend updates, daily top movers after close, breaking news — swipe left/right to page, dismissible), then holdings and watchlists.

### Flow 2: Holdings list → stock detail
1. Holdings are grouped by asset class ("Stocks & ETFs," "Options," "Crypto"). Each equity row: **ticker symbol** (not company name) + share count as the subtitle on the left; a **mini sparkline** of the day in the middle; **last price** and **day % change** on the right, colored green/red. (Sparkline presence is corroborated by Robinhood having open-sourced its own Android sparkline library, `robinhood/spark`.)
2. A **Sort by** control offers, per official docs: Symbol, Last price, Percent change, Your equity, Today's return, Total return, Total percent change (plus Time to expiration for options).
3. Watchlist rows show small **+ / − badges** when there's a pending buy/sell order on that symbol (documented). Long-press-and-drag reorders watchlist rows (documented).
4. Tap a row → stock detail page. (Google Design notes cards/rows "animate to fill the screen from their origin point.")

### Flow 3: Stock detail page (the workhorse screen)
Documented section order, top to bottom:
1. **Header**: ticker/company, live price, today's change ($ and %) — price digits roll ("odometer effect," corroborated by the Pratt critique).
2. **Chart** with the same range pills; same press-hold scrub; gear icon opens chart settings (Line vs Candlestick toggle, "Show all hours" toggle). 1D/1W charts now span 24 hours (12 AM–12 AM ET, Mon–Fri) covering overnight/extended sessions. An "Advanced" affordance inside the chart opens advanced charts.
3. **Pending orders** appear directly beneath the chart when they exist.
4. **Your position card** (only if owned): shares, market value, average cost, **portfolio diversity** (% of your portfolio), today's return, total return. Total return = (market price − average cost) × shares.
5. Then in order: Recurring investment prompt → About (company blurb) → **Stats** (market cap, P/E, dividend yield, avg volume, today's high/low, open, volume, 52-wk high/low, short availability/borrow rate) → Short interest → News (with "Show all") → **Analyst ratings** (buy/hold/sell % bar) → **Trading trends** (what Robinhood retail customers, hedge funds, insiders are doing) → Financials (Android, select stocks) → **Earnings** (expected vs actual EPS dots per quarter, earnings-call replay) → Related lists → "People also own" (horizontal scroll) → your trade History.
6. **Trade entry**: originally a single floating "Trade" button expanding to Buy/Sell/Options; the current design (per the 2025 Pratt critique) pins separate **Buy / Sell / Options** buttons that display live bid/ask prices updating in real time — Buy filled with the stock's current up/down accent color, Sell outlined.

### Flow 4: Buy order (mobile)
1. Tap **Buy** (or Trade → Buy). Order screen defaults to **dollars** input (fractional shares) with a large custom keypad; tap the "Dollars" label to switch to Shares or change order type (market/limit/stop, etc.).
2. As you type, the estimated shares/cost updates live.
3. **Review**: a summary screen with an Edit escape hatch.
4. **"Swipe up to submit"** — the commit action is a swipe, not a tap (official docs). This is deliberate friction on the irreversible step. (Note: an AppleVis forum thread exists about this gesture being problematic under VoiceOver — I couldn't fetch it, 403 — so treat swipe-commit as an accessibility risk to design around.)
5. Confirmation screen with celebration animation: confetti from 2016 until **March 31, 2021**, when it was replaced with "floating geometric shapes" after gamification criticism (CNBC/CNN/Bloomberg). Extended-hours orders convert to limit orders automatically; the app lets you queue orders while the market is closed.

### Flow 5: Advanced charts (mobile)
Documented gestures: **pinch** to zoom, **swipe** to pan through time, **long-press** to scrub with crosshair data readout, **drag the y-axis** to rescale price (double-tap the axis to reset auto-scale). Up to 10 indicators, swipeable list of common ones. Trading from the chart: tap Buy/Sell MKT for market orders; long-press to scrub then tap **+** on the price axis to drop a limit/stop at that price; **press-and-drag an existing order line to modify it**; X to cancel; optional "auto-send" skips the confirmation screen. Indicator sets sync to Legend.

### Flow 6: Crypto differences
- Crypto lives in a separate account/tab (Robinhood Crypto LLC) with its own buying-power pool; the Crypto tab lists coins like a watchlist.
- Detail page is a **reduced** stock page: Chart → Your position → Recurring → News → History. No stats/analyst/earnings/trading-trends sections.
- Chart ranges start at **1H** (advanced web interval down to 15 seconds) through 5Y; markets are 24/7 so there is no market-open/closed state and no previous-close dotted baseline — today's return runs on a midnight-local-time 24-hour cycle.
- Position card shows quantity in coin units (high decimal precision), value, average cost, portfolio diversity, today's/total return. Extra entry points: send/receive transfers.

### Flow 7: Web
- **Web classic**: same detail-page content, but the **order form is a persistent card in a right-hand column** next to the chart (Order type dropdown, Buy In: Dollars/Shares, "Review order" → "Buy" button — no swipe on web). Chart type toggle sits top-right of the chart; indicator picker bottom-right. Hover replaces scrub: a crosshair with value/date readout follows the pointer (behavior widely observed; official docs describe web scrub only for advanced charts — minor vagueness here).
- **Legend** (pro browser platform): widget-grid workspace — Chart (10 chart types, drawing tools with cross-chart "draw syncing"), Watchlist, Positions, Options chain, Ladder, Scanner (60+ filters), Snapshot, Recent orders, Account summary. Widgets resize/reposition freely, up to 8 charts per layout, and **widget linking** means clicking a symbol in one widget re-targets every linked widget. Sub-second real-time data.

## Interaction patterns

- **Press-hold + drag scrub** is the signature gesture: value and timestamp follow the finger everywhere a time series appears (portfolio, stock, crypto, options P&L modeling). Release always snaps back to live.
- **Tap** = navigate/select (range pills, rows, cards). **Swipe** = either browse (cards carousel, indicator list) or **commit** (swipe up to submit an order) — Eric Yi's teardown frames this explicitly: crucial actions get swipe, casual ones get tap, preventing accidental trades.
- **Long-press** = secondary mode: scrub on advanced charts, reorder watchlists.
- **Pinch/drag-axis** only inside advanced charts — the default chart deliberately has zero chart chrome.
- **Live numbers**: prices roll digit-by-digit (odometer) and tick with a brief blink/flash on change; trade buttons themselves show streaming bid/ask.
- **Feedback**: touch ripples on sensitive inputs, snackbars confirming watchlist add/remove, low-profile progress bars (Google Design). Haptics used for delight moments (documented in the Fractional Shares announcement, where the phone vibrates in sync with animation per GoodUX); scrub-tick haptics widely reported but unverified officially.
- **Pull-to-refresh** exists on the dashboard per third-party guides, but the app's core answer is streaming updates; don't over-index on it (weak sourcing).

## Information architecture

- **Mobile nav**: bottom tab bar (added ~2019, replacing a hamburger-style nav): roughly Home/portfolio, Investing/lists, Crypto, Search/Discover, Account — Robinhood's newsroom describes tabs for portfolio+watchlist, search, and account/statements; exact current tab set varies by rollout and product (retirement, spending) — sources are vague on the 2026 lineup.
- Hierarchy is intentionally shallow: **Home (portfolio) → asset detail → order flow** is the entire golden path; older teardowns describe the app as effectively "two pages" (dashboard + detail). Everything else (stats, news, earnings) is inlined as sections of the detail page rather than separate screens.
- Lists/watchlists (with pre-made "Robinhood Lists" by sector/theme) live in Investing; cards surface contextual items above them.
- **Web classic** mirrors mobile IA in a two-column layout (content left, order card right). **Legend** abandons page IA entirely for a linked-widget workspace.

## Visual design language

- **Color as state, not decoration**: the palette is essentially green / red / white / black. Green = gains, red = losses, and the accent state drives the whole screen — chart line, big number, range-pill highlight, and Buy button all inherit the current up/down color. The red is deliberately warmed with orange rather than pure #FF0000 alarm-red (Eric Yi). Candlesticks: green close>open, red close<open.
- **The famous market-clock theme**: historically the entire app inverted from white (market open) to black/"dusky grey" (market closed) — "glimpse the health and activity of the market without reading a single word" (Google Design, 2016 Google Play Design Award). Today this is a user-set light/dark theme rather than automatic; the inversion is a retired-but-legendary pattern.
- **Typography**: 2020 identity used **Capsule Sans** (warm, legible sans) + **Nib** (whimsical serif). The current PORTO ROCHA identity uses **Robinhood Phonic** (custom sans by Schick Toikka with "delicate ink-traps") + **Martina Plantijn** serif for headlines; brand accent **"Robin Neon"** (electric yellow-green) over black/white/mature neutrals — deliberately "less is more" against fintech's "rainbow approach." In-product type hierarchy: one huge number, small muted labels, almost nothing in between.
- **Charts as brand**: no axes, no gridlines on default charts; the illustration system is literally "inspired by financial graphs." Sparklines echo the main chart at row scale. The feather logomark was streamlined to emphasize the upward arrow inside it.
- **Iconography**: thin, geometric, monochrome; meaning carried by color and shape (+/− pending-order badges, filled vs outlined Buy/Sell buttons).

## What makes it fast/fun

1. **One question answered instantly**: the entire home screen is one number, one color, one line. Green screen = good day. Zero reading required.
2. **Scrubbing turns data into a toy**: the chart answers "what if I'd checked yesterday/last month" tactilely, with the value chasing the finger and (reportedly) haptic ticks. It rewards idle touching — the single stickiest interaction in the app.
3. **Everything streams**: rolling digits, blinking ticks, live bid/ask in buttons. The app feels alive, so users keep it open.
4. **Dollars-first fractional entry** kills the "how many shares can I afford" math — type $50, done.
5. **Friction is placed, not spread**: 5-minute onboarding, 2 taps to an order form, but the one irreversible act (submit) requires a deliberate swipe-up ceremony plus a review screen.
6. **Celebration with restraint**: milestone animations (post-confetti geometric shapes) mark firsts without nagging.
7. **Ruthless subtraction**: no axes, no jargon, ticker-not-name rows, four colors. Cognitive load is spent on exactly one decision.

## Ideas worth stealing for MoneyApp (ranked)

1. **Scrubbable net-worth/portfolio chart**: press-hold shows a hairline; header value + date swap to the scrubbed point; period return recalculates to that point; release snaps back to live. Add a light haptic tick per data point. This is the highest delight-per-effort feature in the genre.
2. **Range pills with correct interval math**: 1D/1W/1M/3M/YTD/1Y/ALL, each with a documented point interval (5min → daily → weekly), and a **dotted previous-close (or period-start) baseline** with the line green above / red below.
3. **State-driven accent color**: derive the screen accent (chart, delta text, highlighted pill) from the selected period's gain/loss. Keep MoneyApp's red warm/orange-tinted, never alarm red.
4. **Exclude transfers from performance**: Robinhood's documented baseline rules (returns exclude deposits; per-asset-class baselines) are exactly the correctness trap MoneyApp must get right so the chart shows performance, not cash flow.
5. **Position card pattern** on every holding detail: shares/quantity, market value, average cost, today's return, total return, **portfolio diversity %** — that last one is cheap and rarely copied.
6. **Sparkline holding rows** (ticker, quantity subtitle, day sparkline, price, colored day-change) + a Sort-by sheet (equity, today's return, total return, % change, symbol).
7. **Odometer digit-roll** on the big number and row prices when values update.
8. **One-screen-deep IA**: home → detail → action, with stats/news/history as inline sections of detail, not separate screens.
9. **Dismissible insight cards carousel** above the holdings list (account events, movers, alerts) — swipe to browse.
10. **Swipe-to-confirm** for destructive/irreversible actions (delete account link, execute rebalance) — but pair with an accessible tap fallback (VoiceOver users struggled with Robinhood's version).
11. **Web: persistent right-rail action card** beside the chart rather than modal flows; hover crosshair replaces scrub.
12. **Tasteful milestone moments** (first import completed, first positive month): floating geometric shapes, not confetti — celebration without gamification optics.

## Sources

- https://robinhood.com/us/en/support/articles/viewing-stock-detail-pages/ (stock detail sections, position card)
- https://robinhood.com/us/en/support/articles/using-charts/ (chart types, ranges/intervals, 24h charts, portfolio baselines)
- https://robinhood.com/us/en/support/articles/using-advanced-charts/ (pinch/pan/long-press/axis-drag, order-from-chart)
- https://robinhood.com/us/en/support/articles/viewing-cryptocurrency-detail-pages/ (crypto page sections, midnight baseline)
- https://robinhood.com/us/en/support/articles/buying-a-stock/ (buy flow, swipe up to submit, web flow)
- https://robinhood.com/us/en/support/articles/investing-tools/ (holdings sort-by options)
- https://robinhood.com/us/en/support/articles/watchlist-and-cards/ (cards carousel, reorder, pending-order badges)
- https://robinhood.com/us/en/support/articles/widgets-in-robinhood-legend/ (Legend widgets, linking, drawing tools)
- https://robinhood.com/us/en/newsroom/a-new-way-to-navigate-robinhood/ (bottom tab bar)
- https://robinhood.com/us/en/newsroom/a-visual-identity-that-better-reflects-our-vision/ (Capsule Sans, Nib)
- https://www.portorocha.com/robinhood (Robinhood Phonic, Martina Plantijn, Robin Neon, less-is-more)
- https://design.google/library/robinhood-investing-material (market-clock inversion, ripples, snackbars, card animations)
- https://ixd.prattsi.org/2025/02/design-critique-robinhood-ios-app/ (Buy/Sell/Options buttons, odometer effect)
- https://medium.com/@ericyi/ux-teardown-3-robinhood-79e310f7578 (swipe-for-crucial-actions, orange-tinted red, drag-to-scrub)
- https://medium.com/@jeffrey_zhong_35871/robinhoods-simple-user-interface-76a2ee7cd6e (white/black market state, color conventions)
- https://www.cnbc.com/2021/03/31/robinhood-gets-rid-of-confetti-feature-amid-scrutiny-over-gamification.html (confetti → geometric shapes)
- https://goodux.appcues.com/blog/robinhood-haptic-feature-announcement (haptics in announcements)
- https://github.com/robinhood/spark (open-sourced sparkline component)
- https://wearecollins.com/case-studies/robinhood/ (2020 rebrand outcomes)
- https://robinhood.com/us/en/legend/ and https://robinhood.com/us/en/support/articles/layouts-on-legend/ (Legend layouts)

---

# moomoo — Charts & Data Viz

# moomoo (Futu) — Charts & Data Visualization Teardown

Research basis: moomoo's official Help Center + Manual pages (US/SG/CA), moomoo Learn courses, moomoo Community posts, and third-party reviews (WallStreetZen, BrokerChooser, TradingView broker page, tradingtoolshub). Confidence notes are inline where sources conflict.

## Core flows

### Flow 1: Reading a stock chart (mobile quotes page)
1. From Watchlists, tap a symbol → its **Quotes page** opens with a chart near the top, a tab strip of timeframes above it: `Intraday / 5D / 1D / 1W / 1M …` plus pre-market/post-market/full-hours variants.
2. **Intraday and 5D are tick-plotted line charts — candlesticks are deliberately unavailable there.** To get candles at short horizons you switch to interval charts (1m…30m, 1h, 4h). This is an intentional split: the "today" view is a clean line; analysis views are candles.
3. Intraday charts expose only 5 indicators (VWAP, VOL, KDJ, MACD, RSI). Switching to any interval/range chart unlocks the full library (manual says "over 100"; marketing pages say "63 advanced indicators" and "38 drawing tools"; WallStreetZen says "50+ tools" — the counts conflict, but all agree intraday is intentionally limited and interval charts are deep).
4. Double-tap the chart → it expands to **fullscreen landscape**; double-tap again to return. Alternatives: an "expand screen" icon at bottom-right of the chart (toggleable in chart settings), or physically rotating the phone with orientation lock off. Landscape reveals *more timeframe tabs* and a pencil icon for drawing tools.
5. Tap the "More" icon on the chart bar → menu with **Indicators**, **Drawing Tools**, **Chart Markings**, chart settings (price adjustment: backward-adjusted / actual / cumulative; line toggles for cost line, current price line, crosshair curve).

### Flow 2: Adding/managing an indicator
1. Quotes page → chart-bar "More" icon → **Indicators**.
2. Indicators are split into **main-chart indicators** (overlays on the candles: MA, BOLL, etc.) and **sub-chart indicators** (MACD, RSI panes below). Multiple sub-chart panes can be stacked simultaneously.
3. Per indicator row: a **star icon** (tap = add to Favorites, tap again = remove), a **gear icon** (parameter settings), and a **bulb icon** in the header (opens an in-context tutorial explaining the indicator). "More" at top right opens the 100+ list.
4. Custom formula-built indicators (190+ preset functions) exist but are **desktop-only**; a "Custom" tab still appears in mobile navigation.

### Flow 3: Account performance review (the analytics crown jewel)
1. **Accounts tab → tap the Total Assets card → Assets Analysis.** (Alt path per help center: Accounts → account → More → My Assets → Asset Analysis.)
2. Top: **Assets Overview** — distribution of the account by **asset class** by default (stocks/options/cash), with a one-tap toggle to re-slice the same donut **by currency**.
3. Below: **Asset Trend** (line chart, y = NAV) and **P/L Trend** (line chart, y = cumulative return %). Time filters: 1W / 1M / YTD / custom range via a filter icon.
4. On any range longer than 5 days, you can overlay **benchmark indices** (S&P 500 etc.); the legend is interactive — tapping a legend item hides/shows that index line.
5. Return math is user-selectable among **Time-Weighted (TWR), Money-Weighted (Modified Dietz), and Simple** rate of return. The daily building block is explicit: `Return on day X = NAV(X) − NAV(X−1) − net inflows on X` — so deposits/withdrawals/stock transfers/RSUs never masquerade as gains. Trends update every 1–5 min (not tick-real-time; calendar numbers need manual refresh).
6. Bottom of page: **P/L Calendar** — a month-grid calendar where each day cell shows that day's P/L, with a **monthly view and a yearly view** and time filtering; the month footer shows the aggregated monthly total.
7. Separate **P/L Analysis** section: a market bar at top switches between markets/product types (US stocks, HK stocks, options); shows cumulative P/L per product type, then **"Top 5 Winners / Top 5 Losers"** with a toggle between the two lists; tap ">" for the full ranked list; **tap any symbol for its per-position P/L history**.
8. Back on the account page itself, **Total P/L and Today's P/L sit next to Market Value** near the top. Tapping **Today's P/L** generates pre-built **share cards** (daily %chg, P/L amount, per-stock performance) you can post to the moo community or social media — you pick which of the generated images to share.

### Flow 4: Market heat map
1. **Markets tab → Stocks (or pick a market) → swipe up to the Heat Map module → tap ">"** for the full page.
2. Treemap of industries: **block size = market cap (or volume/turnover, user-selectable); color = direction of change; shade depth = magnitude** (deeper red/green = bigger move). Default: top 50 industries by market cap, daily change.
3. Filters: draw by Market Cap / Volume / Turnover; show Top 30 / Top 50 / All; period: intraday, 5D, 10D, 20D, 60D, 120D, 250D, Year.
4. Icons at top-left toggle **block view ↔ list view**.
5. **Tap a block → that industry's quotes page** (constituents, price chart, news, comments) — the heatmap is a drill-down surface, not a poster.

### Flow 5: Capital flow / trade overview on a stock
1. Quotes page → swipe up past the chart to **Trade Overview** and **Money Flow** modules.
2. Trade Overview: a circular/donut display of intraday money flow bucketed by order size — **XL (top 10% of trades), L (10–30%), M (30–55%), S (bottom 45%)** — with values in millions and percentages. In the pie, green = net inflow, red = net outflow (under green-up setting), with different shades per order-size bucket.
3. Capital Trend chart: **5 simultaneous curves** (overall + the four size buckets). **Long-press summons crosshairs + a floating window** showing net inflow per order type at that exact time. Tap legend icons below the chart to hide/show individual size buckets.
4. Day/Week/Month tabs switch aggregation; "Historical Data" (upper right) opens a horizontally swipeable per-day list.

### Flow 6: Watchlist scanning
1. Watchlists page: rows of symbols. Per row: name/symbol (order configurable), optional market tag, optional status icon badges (with a legend), price, and a **colored change block**.
2. In display modes A/B/C the change value sits in a red/green block; you can **toggle the data block among %Chg / Chg / YTD Chg / Mkt Cap**. Portrait mode offers 4 preset column sets or a fully custom one.
3. During trading hours **prices flash on tick** (toggleable). Symbols across markets are "smart-sorted" so actively-trading markets float up. Pre/post/overnight quotes and HK-ADR equivalents are toggleable.
4. An optional **assets info card** pins your portfolio summary at the top of the watchlist. Newly purchased symbols auto-add to the watchlist.
5. Tap the **⊞ icon (top-left) → multi-chart grid view**: mini candlestick charts for every watchlisted symbol at once, with four global filters — watchlist selector, interval ("Daily" default), indicators (applied to all mini-charts, main + sub), and settings (chart markings, **column count**, price adjustment, line type). This is a visual screener: same indicator across 20 charts at a glance.

## Interaction patterns

- **Pinch (two fingers)**: zoom in/out on interval charts. Explicitly *disabled on intraday* charts (fixed session window).
- **One-finger horizontal drag**: pan back through history, in both portrait and landscape.
- **Double-tap chart**: enter/exit fullscreen landscape. (Community users celebrate discovering this — it's a hidden-but-loved gesture.)
- **Long-press on chart**: summon crosshair + floating data window (confirmed for capital-flow and money-flow charts; the price chart has a toggleable "cross curve," i.e., crosshair line). Long-press on a drawing's anchor point brings up a **magnifying glass** for pixel-precise placement — a lift from iOS text-cursor UX.
- **Tap a drawing** → its edit toolbar appears; tap empty chart → toolbar hides. **Long-press a drawing tool** in the palette → add to Favorites.
- Drawing palette has global switches: **Hide All**, **Continuous** (draw many without re-selecting), **Magnet** (snap to OHLC key prices), **Delete All**.
- **Interactive legends everywhere**: tap a legend item to hide/show that series (benchmark overlays, capital-flow buckets).
- **Tap-to-cycle data blocks** in watchlist rows (change% → change$ → YTD → mkt cap) — one thumb, no settings dive.
- **Swipe left on position-table columns** to reveal more columns; **tap any info column** on a position to summon an action bar of shortcuts (trade, close, etc.).
- **Swipe up** on quotes page = progressive module reveal (chart → order book → capital flow → news → comments).
- Desktop: scroll-wheel zoom, click-drag pan, right-click menus for Level 2; multi-pane layouts (up to 4 linked timeframes) with **saveable named layouts**; keyboard order shortcuts (Ctrl+B/Ctrl+S) — these last desktop specifics come from a lower-confidence third-party blog (tradingtoolshub) and I could not verify them against official docs.

## Information architecture

- Bottom tabs (mobile): **Watchlists / Markets / (moo Community) / Trade-Accounts / Me**.
- **Watchlists** → symbol → **Quotes page** (the deepest screen: chart + stacked swipe-up modules). Also hosts the ⊞ multi-chart grid.
- **Markets** → per-market dashboards → embedded modules (Heat Map, movers, capital flow leaders) → each module has a ">" to a full page → each full page drills into quotes pages. Consistent "module preview inline, ">" to full screen, tap element to drill" pattern.
- **Accounts** → account card (Market Value, Total P/L, Today's P/L) → Total Assets → **Assets Analysis** (overview donut → trends → calendar) and **P/L Analysis** (rankings → per-symbol history). Analytics live exactly one level below the balance you tap.
- **Me → Settings** centralizes cross-cutting display config: **Quote Preference → Quote Color** (red-up vs green-up), **Charts → Chart Markings** (trade marks, cost line, Pattern Finder toggle), **Watchlists & Quotes** (column sets, flash, icons), General → Dark/Light mode.
- Education is embedded at point of use (bulb icons on indicators, in-app Learn courses), not siloed.

## Visual design language

- **Color is directional first, decorative never.** Red/green encodes up/down on literally everything: quotes, change blocks, calendar cells, heatmap tiles, capital-flow pies. Critically, the mapping is **user-configurable** (Me → Settings → Quote Preference): Western green-up/red-down or Asian red-up/green-down, plus a **pink-green pair** option (colorblind accommodation). Any doc that says "green means X" is implicitly relative to this setting.
- **Shade depth = magnitude** (heatmap: darker = bigger move; capital pie: shade = order-size bucket). Two visual channels (hue = direction, saturation = size) on one mark.
- **Marks on price charts carry portfolio meaning**: 'B'/'S'/'T' arrow badges above candles for your fills (no price shown), or dot "price markings" plotted at the average fill price (red buys, green sells, purple intraday trades), plus a horizontal **position cost line** and current price line — your history is drawn into the market chart. All individually toggleable under Chart Markings.
- **Pattern Finder** auto-draws recognized candlestick patterns on the chart (on by default, ~20 patterns, 10 bullish/10 bearish), with a 3-day probability forecast and computed support/resistance levels; US/HK/Japan markets only.
- Chart-type breadth: candlestick, **hollow candle, "four-style candles"** (solid+hollow hybrid), OHLC bar, line, **area/mountain**, **Heikin Ashi**.
- Dark theme is the trader default (Me → Settings → General), light mode fully supported; numbers are the typographic heroes — big monospaced-feeling price displays, small dense grey labels. Reviewers describe it as "TD Ameritrade power with a Robinhood-like interface" and note the charting feels "simple to use and very responsive." (No official typography spec is published; this is observational/review-sourced.)
- Data density is managed by **progressive disclosure**, not omission: intraday = clean line + 5 indicators; interval charts = full 100-indicator arsenal; watchlist row = 3 data points with tap-to-cycle for the rest.

## What makes it fast/fun

1. **Every visualization is a door, not a poster.** Heatmap tile → industry page. Top-5 loser → position P/L history. Calendar day → that day's P/L. Legend item → toggle series. Nothing is view-only.
2. **Gesture-rich charts with zero chrome cost**: double-tap fullscreen, pinch zoom, long-press crosshair, drag pan. Power features are discoverable but never occupy screen space.
3. **Honest performance math made visible**: the TWR/MWR/Simple toggle plus the NAV-minus-inflows formula means the account curve can't lie to you about deposits — and moomoo shows you the methodology instead of hiding it.
4. **The P/L Calendar gamifies discipline**: a month of red/green day cells reads like a habit tracker; the yearly view is a personal "trading heatmap." Users screenshot and share it — which feeds the share-card loop (tap Today's P/L → pre-rendered brag/confession cards).
5. **One mental model, many surfaces**: the same red/green + shade-depth grammar covers quotes, treemaps, pies, calendars — you learn it once and can read every screen at a glance.
6. **Your trades live on the market chart** (B/S marks, cost line), collapsing "how is the stock doing" and "how am *I* doing" into one view.

## Ideas worth stealing for MoneyApp (ranked)

1. **P/L Calendar heatmap** for account daily change: month grid of red/green cells with day-level values, monthly total footer, yearly mini-view. Perfect fit for MoneyApp's daily-balance history; tap a day → that day's transactions/positions delta.
2. **Deposit-adjusted return math with a visible methodology toggle**: compute daily return as `NAV(t) − NAV(t−1) − net flows(t)`, offer TWR (default) and simple; label the chart with the method. This is the single biggest correctness win for an account-value curve fed by statement imports.
3. **Benchmark overlay with tap-to-toggle legend** on the account value/return chart (SPY/QQQ), enabled only for ranges > ~5 days.
4. **Top 5 winners/losers module** on the portfolio screen, toggle between the two, ">" to full ranking, tap symbol → per-position P/L history sparkline.
5. **Position cost line + buy/sell dot markings** rendered on each holding's price chart from imported trade history — moomoo's most emotionally resonant chart feature and cheap to build from data MoneyApp already has.
6. **Two-channel treemap of holdings**: size = market value, hue = daily change direction, saturation = magnitude; tap tile → holding detail. Include a block/list view toggle.
7. **Interaction grammar**: long-press crosshair with a floating data window; one-finger pan; pinch zoom on ranges; double-tap fullscreen. Also: interactive legends as the universal series-toggle.
8. **Tap-to-cycle data blocks** in account/holding rows (%chg → $chg → YTD → value) instead of a settings page.
9. **Configurable gain/loss colors** (green-up default, red-up option, colorblind pink-green pair) as one global token consumed by every chart, cell, and badge.
10. **Progressive indicator disclosure**: default charts stay minimal (line + value), with an opt-in "More" sheet for overlays — density as a choice, not a wall.
11. **Shareable P/L cards** (pre-rendered images from Today's P/L) — lower priority for a personal app, but a delightful export for milestones.

## Sources

- https://www.moomoo.com/us/support/topic3_33 (Help Center: Charts — gestures, periods, adjustments)
- https://www.moomoo.com/us/support/topic4_196 (Help Center: P&L Calendar)
- https://www.moomoo.com/us/support/topic4_37 (Help Center: Asset Analysis — TWR/MWR/Simple, NAV formula)
- https://www.moomoo.com/sg/manual/topic-14-365 (Manual: P/L Analysis — donut, trends, benchmark legend, top-5)
- https://www.moomoo.com/us/manual/topic-14-57 (Manual: Chart Indicators — star/bulb/gear icons, 100+ list)
- https://www.moomoo.com/us/manual/topic-14-39 (Manual: Drawing Tools — magnet, magnifier, favorites)
- https://www.moomoo.com/us/manual/topic-14-36 (Manual: Chart Markings)
- https://www.moomoo.com/us/manual/topic-14-79 (Manual: Heat Map)
- https://www.moomoo.com/us/manual/topic-14-13 (Manual: Customize Watchlists — modes A/B/C, quote colors, flash)
- https://www.moomoo.com/us/manual/topic-14-14 (Manual: Multi-chart view — ⊞ grid, 4 filters)
- https://www.moomoo.com/us/manual/topic-14-47 (Manual: Positions — columns, swipe, action bar)
- https://www.moomoo.com/us/manual/topic-14-59 (Manual: Trade Overview & Money Flow — XL/L/M/S buckets, long-press)
- https://www.moomoo.com/us/support/topic3_73 (Help Center: Share profit/loss cards)
- https://www.moomoo.com/us/support/topic3_662 + https://www.moomoo.com/us/manual/topic-14-52 (Pattern interpretation / Pattern Finder)
- https://support.moomoo.com/topic41 (Quote color setting: green-up/red-down)
- https://www.moomoo.com/community/feed/105985342570502 (Community: double-tap fullscreen)
- https://www.moomoo.com/community/feed/105987685023750 (Community: orientation + position cost)
- https://www.moomoo.com/au/learn/detail-decoding-chart-types-choosing-the-right-view-117885-250422006 (chart types incl. Heikin Ashi, hollow, four-style)
- https://www.moomoo.com/us/learn/detail-how-to-use-heat-map-52647-220730009 (Learn: Heat Map)
- https://www.moomoo.com/us/learn/detail-how-to-view-a-stocks-capital-flow-trend-52647-220348008 (Learn: Capital flow)
- https://www.wallstreetzen.com/blog/moomoo-trading-review/ (review: interface/charting assessment)
- https://brokerchooser.com/broker-reviews/moomoo-review (review: platform UX; page fetch blocked, summary via search)
- https://tradingtoolshub.com/blog/moomoo-tips-and-tricks/ (tips: desktop layouts, shortcuts — lower confidence, not corroborated by official docs)

Noted conflicts/uncertainty: indicator counts differ across sources (63 vs 100+ vs "50+ tools"; drawing tools 30+ vs 38); heatmap/pie color descriptions assume the green-up setting and invert under red-up; desktop keyboard shortcuts and 4-pane layout details come only from one third-party blog; price-chart crosshair specifics (vs capital-flow chart crosshair) are inferred from the "cross curve" toggle mention rather than an explicit walkthrough.
