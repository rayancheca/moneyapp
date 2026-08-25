# Handoff — 2026-08-25: passes 64 and 65, and a gate that has been blind for 131 commits

> **`main` = `8d79aea`**, tree clean, pushed.
> tsc clean · **181 files / 3,393 unit** (was 177 / 3,320) · coverage gate exit 0 ·
> `pnpm ledger-check` exit 0 · **E2E_GATE=1 e2e: 458 passed** (was 445), zero
> failed, zero flaky, zero skipped.
> Baseline churn: **24 PNGs**, accounted for in §4 — **ten of which were already
> stale before this session touched them.**
>
> **Real-DB writes: none.** (Pass 63's one settings-row write shipped yesterday.)

## 0. Read this first

**The visual gate cannot see a change smaller than 0.1% of the page, and on a
tall page that is a lot of change.**

`maxDiffPixelRatio: 0.001` on a 1440×2648 screenshot is an allowance of **3,813
pixels** — enough to hide a whole UI control. Three separate instances surfaced
this session, none of them found by the gate:

| what was hiding | size | found by |
|---|---|---|
| pass 62's "Bridge" hero tab | 2,289 px = 0.000752 | pass 63, when my section pushed the total over |
| my own InfoTip icon (pass 63) | 123 px = 0.0000323 | re-running with the tolerance set to 0 |
| **"YTD" and "All" pills on `/spending`** | under tolerance | pass 65, same way |

The third is the worst. Commit **`3a3f8bb`, 2026-08-06, 131 commits ago**, added
those two pills and regenerated **exactly one** baseline
(`category-light-1024`). The other 23 have carried a five-pill row through 131
commits of green gates.

🔴 **Recommendation, not yet done because it is a deliberate call:** the ratio
scales with page height, so the taller the page the more can hide. A
**`maxDiffPixels` floor** (a flat count, size-independent) alongside or instead
of the ratio would close this. Changing it will surface every baseline currently
stale under the old rule at once — which is the point, and is why it wants to be
its own pass rather than a footnote to this one.

**Meanwhile, the working practice that does catch it:** after any UI change,
temporarily set `maxDiffPixelRatio: 0` and run the affected specs. A passing
visual gate does not mean the baselines match.

## 1. Pass 64 — `/summary/[year]`

2025 reads: **earned $23,678.64**, **all money in $38,301.47**, and
**$49,100.00** that merely passed through. Those three figures *are* the page —
the misstatement it exists to prevent is adding the second to the first. Adding
the financial-aid refund to his wages would overstate what he earned by **43%**.

**The grouping is quoted, not invented** — `docs/income-ground-truth.md`'s own
rule, with each line's `basis` naming the clause it stands on.

⚠️ **`Income › Salary` is no longer pure Fordham.** Work-study ended 2026-05-13
and the cash job's deposits live there too, so the split is by **descriptor** and
the two are separate lines. A category-only split would report the cash job as
university wages.

**The XIRR is withheld unless both boundary valuations are complete.** 2025 opens
on a day covering one of two investment accounts — **$21.70** of visible
portfolio — so a return measured from it would read as an astronomical gain.
2026 computes **113.94%**, flagged as an annual rate from a part-year window.

Two half-truths its first working version told, both caught by reading its own
output:

- **The pass-through showed one leg.** "$49,100.00 passed through" with the trip
  back invisible, in the one section whose whole job is to say the money did not
  stay. The legs do **not** cancel — $49,100.00 in against $28,398.22 out — so
  showing both is the difference between a disclosure and a claim.
- **The XIRR was annualised and silent about it.** 113.94% from eight months.

**Three more found by looking at the render:** the hero repeated the earned
figure verbatim as the first section's total; each line cited up to twelve
filenames; and the print stylesheet was wrong **twice** — first matching no
shell selector at all, then hiding the `<aside>` and leaving the sheet
auto-placed into the shell grid's **216px first column**.

## 2. Pass 65 — merchant intelligence

`/merchants/[id]` was 91 lines across 893 merchants. Target now reads
**$59.28/month**, typical visit **$16.75**, 77 purchases, $2,648.95 since
2022-10-31.

**Two measurements turned features into refusals:**

- **454 of 702 merchants have exactly ONE visit** — 65%. The monthly rate is
  withheld below 3 visits or a 60-day span.
- **The mean ticket runs 2–2.7× the median.** Target $34.40 against $16.75. The
  median leads; the mean appears only when they materially disagree.

**Reachability was the actual gap.** `/spending`'s Top merchants card linked
every row to the filtered *ledger*, so the only route to the merchant page was a
transaction row's sheet. `profileHref` renders as a **sibling** link — the row is
already a link, and a link inside a link is invalid HTML and an axe
`nested-interactive` violation. `href` is untouched because a test follows it
through the real ledger filter layer and asserts the row count it returns.

## 3. What the reviews found, after every gate was green

**Pass 64, by mutation:** deleting the incomplete-opening XIRR guard **survived**
the service's tests — reaching that branch through the database needs a seeded
portfolio with prices and holdings, so in practice it was never reached. The
guard protecting the page's most dangerous figure was untested. Moving it to
`lib/money-weighted-return` put it under the 100%-branch gate; five mutants now
die there. Extracting it also surfaced a refusal the service never had: an
opening of **zero** — a first year of investing — where XIRR's answer depends
entirely on which day the money arrived.

**Three of my own tests asserted nothing** and are gone:
`expect(x).not.toContain;` (a matcher accessed, never called); a comparison of a
value with itself through a map that reproduced it exactly; and a
`if (empty) return 0` guard in `median` that could never run.

**Two dead branches made unrepresentable rather than tested around** — a
`sections.find(...)?.total ?? 0` whose fallback cannot fire, and the `median`
guard above.

## 4. The 24 baselines

All three routes that render `TopMerchantsCard`: `spending`, `spending-year`,
`category`, × light/dark × 320/768/1024/1440.

**Only 14 failed.** The other ten were already stale and passing — see §0 — so
all 24 were deleted and regenerated rather than just the ones the gate could
see. Two changes are in the churn:

1. **Mine**: a chevron link per linked-merchant row, which shifts each row's
   amount column. Confined to 14 narrow bands of 14–36 rows at list-row pitch.
2. **Not mine**: the YTD and All pills, stale since 2026-08-06.

Verified by inspection that the unlinked "DISCOVER E-PAYMENT" row correctly has
**no** chevron — it has no merchant record and so no page.

## 5. ⛔ NEXT — pass 66, the provenance service

`docs/program-passes-60-94.md` — 60, 61, 62a, 62b, 63, **64** and **65** are
ticked. Next is **pass 66**: `src/services/provenance.ts` and the
`<ProvenancePopover>` primitive. ~27 passes remain.

**Consider inserting a short pass for the tolerance fix (§0) first.** It is
cheap, it is blocking real regressions from being seen, and it gets more
expensive the longer the stale set grows.

## 6. Still open

- **The $560.54 on 2026-07-29** — self-to-self, routing 021000021.
- **Dad's remaining ~$5k** via Arno Search Capital LLC. ⚠️ Pass 64 measured the
  pass-through legs and they do **not** cancel: $49,100.00 in against $28,398.22
  out in 2025, $75,264.18 against $56,300.00 in 2026.
- **59 rows at `needs_review`.**
- **Statement uploads**: Robinhood July + August (no arbiter — pass 73), SoFi August.
- **69 exact opposite transfer pairs** the linker never linked; **24 transfer
  groups with one active member**.
- **`user_ends_on` mid-month keeps its full annualised rate** — latent, no writer.
  ⛔ Pass 84's episode editor creates one.
- **Scale**: `/investments` donut, holdings table, `/accounts` — pass 78.
- **New:** the first Progressive charge was **$357.58**; the registered series
  says **$361.49**. A real $3.91 gap, not reconciled.
- **New:** `notFound()` from a force-dynamic page returns **HTTP 200** with the
  not-found body app-wide — `/accounts/nonexistent-id` does the same, while an
  unmatched path returns 404. Pre-existing; every detail route is affected.
- **New:** `/summary/[year]` has **no visual baseline**. Deliberate for now — the
  overflow sweep measures it and its own spec covers structure and print — but a
  printable page is a reasonable candidate for one.
- **New:** pass 65 shipped **year bars, not the ScrubChart kit**, on the merchant
  page. The full scrub kit there is still open.

## 7. Notes for the next session

- ⚠️ **`Desktop/` is iCloud-synced** and makes `"… 2.png"` conflict copies during
  rapid baseline regeneration. `git status --porcelain` before believing a tree.
- ⚠️ **The Bash tool's cwd persists across calls.** A `cd` left every later
  relative path resolving inside the snapshots directory; a `find` and a python
  glob both silently found nothing and read as "already deleted".
- ⚠️ **Never pipe a gate run through `tail`.** One run reported "430 passed" in
  1.5h (normal: 6.5m) under load average 9.24, and the truncated log could not
  distinguish a regression from contention. Capture the whole log, then count
  `✓`/`✘` from it.
- ⚠️ **`aliasedTable` self-joins break drizzle's row inference** — the rows come
  back typed `never` while working perfectly at runtime, so `tsc` fails and the
  tests pass. Use `loadCategoryIndex` for category rollups; it is the one place
  that rollup is implemented anyway.
- ⚠️ **`tsc` catches what green tests do not.** `EmptyState` takes `description`
  not `body`, and `"imported"` is not a valid `importFiles.status` — both found
  by `tsc` after 17 service tests had passed.
- ⚠️ **`seedDatabase` predates several categories** the newer pages read —
  Tutoring, Financial Aid, Family pass-through, Gambling, Car. Tests must create
  them; skipping the case passes on a database where the feature cannot work.
- ⚠️ **The app themes on a `.dark` CLASS**, not `prefers-color-scheme`.
- ⚠️ **The Browser pane screenshots blank for this app** (the DOM reads fine via
  `javascript_tool`). Use Playwright for anything visual.
- The overflow sweep's route-coverage guard fires on any new `page.tsx` — register
  it in `ROUTES` or `DYNAMIC`.
- Push: `git -c credential.helper='!gh auth git-credential' push origin main`
