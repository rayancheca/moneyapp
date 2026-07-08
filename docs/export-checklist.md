# Export Checklist — do this now (windows are rolling)

Drop every file into `data/inbox/<institution>/`. Don't rename, don't open-and-resave.
Get BOTH the structured exports AND the monthly PDF statements — the PDFs carry the
begin/end balances that reconciliation anchors on, and they're the only source older than
each bank's structured window.

## Chase — `data/inbox/chase/` (checking, savings, credit card)
Structured history reaches back ~24 months and **falls off weekly** — do Chase first.
1. chase.com → each account → the download icon on the Activity page ("Download account activity").
2. For each of the 3 accounts, download **QFX (Quicken)** *and* **CSV**, in **3-month chunks**
   going back 24 months (8 chunks per account per format). Chunking avoids a reported silent
   ~1,000-row CSV truncation. Name pattern doesn't matter; just don't merge files.
3. Statements: each account → "Statements & documents" → download **every monthly PDF for the
   last 24 months** (checking, savings, credit card = ~72 PDFs).

## Discover — `data/inbox/discover/` (credit card)
No QFX/OFX exists (Discover killed it in 2022) — CSV + PDFs only.
1. discover.com → All Activity & Statements → Search Transactions → set date range →
   Download → **CSV**. Try the full 24 months in one go; if it only returns ~12 months,
   that's a known limit — the PDFs cover the rest.
2. Download **every monthly statement PDF for the last 24 months** (~24 PDFs).

## Capital One — `data/inbox/capital-one/` (360 checking, Venture X)
Structured export only reaches ~90 days — PDFs carry almost all of your history here.
1. capitalone.com on **desktop web** (the app has no export) → each account → Download
   Transactions → grab **OFX/QFX** *and* **CSV** for the last 90 days.
2. Download **every monthly statement PDF for the last 24 months** for both accounts (~48 PDFs).

## SoFi — `data/inbox/sofi/` (checking, savings)
1. sofi.com in a **web browser** (explicitly not the app) → Banking → select account →
   gear icon → **Export Transactions** → set the range to the **full 2 years** → CSV.
   Do it for checking and savings separately.
2. Statements section → download **every monthly PDF for the last 24 months**. SoFi often
   issues one combined PDF covering checking + savings — that's fine, the parser splits it.

## Robinhood — `data/inbox/robinhood/`
1. robinhood.com → Account → Reports and statements → **Account activity reports** → custom
   report, start date = 2 years ago (or account opening), end = today. It generates
   asynchronously (2–24h) and you get a notification to download the **CSV**. Covers stocks,
   options, dividends, interest, transfers — **not crypto**.
2. Account statements → download **every monthly (or quarterly) PDF for the last 24 months**.
3. Crypto (your ETH): Settings → Privacy/Security → **"Download my data"** — grab whatever it
   produces (likely a ZIP; drop it in as-is, the importer unpacks and inspects it). If it
   doesn't include crypto transactions, two fallbacks: the annual tax-season **Robinhood
   Crypto CSV** (in the app's Tax center, per calendar year), or manual entry of your ETH
   buys (you said you barely trade it — minutes of work).

## Sanity check when done (per-institution subtotals)
| Institution | Structured files | Monthly PDFs |
|---|---|---|
| Chase (3 accounts × 2 formats × 8 chunks) | 48 | ~72 |
| Discover | 1–2 | 24 |
| Capital One (2 accounts) | ~4 | 48 |
| SoFi (2 accounts) | 2 | ~24 (fewer if combined PDFs) |
| Robinhood | 1–2 (+ DMD zip) | 8–24 (quarterly when inactive months) |
| **Total** | **~56–58** | **~176–192** |

Every monthly PDF matters — each one is a reconciliation anchor. If a month is missing at
any bank, grab it; gaps become visible holes in your 2-year curve.
