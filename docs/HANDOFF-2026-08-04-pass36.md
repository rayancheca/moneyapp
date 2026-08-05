# Handoff — 2026-08-04, pass 36

> The owner's instruction was **"i want to finish polishing the app so i can host it."** This pass
> did the polish and the ~2 hours of perimeter work hosting actually needs. **No hosting migration
> was attempted, and none should be** — §7.0 of the pass-35 handoff already measured that answer
> and it has not changed.
>
> **⚠️ Pass 37 starts at §6. Read §2 before touching the transfer detector — the work item as
> written was based on a false premise, and the part that survives is blocked on an owner
> decision (§5).**

## 1. Repo state

`main` = run `git rev-parse main` (do not trust a copied hash). Four commits this pass.

Real DB **untouched** — this pass wrote nothing to it, which is correct, because nothing here
needed a data migration. Verified byte-identical to pass 35: **9,827 txns, 10 accounts, 33
needs_review, 0 duplicate_candidates, 0 superseded.**

| gate | before | after |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| unit | 143 files / 2,500 | **146 files / 2,534** |
| `next build` | clean | clean (2 pre-existing NFT warnings, unrelated — trace is `next.config.ts → db/backup.ts → db/boot.ts → instrumentation.ts`) |
| `E2E_GATE=1 pnpm e2e:fresh` | 383/383 | **383/383** |
| visual-baseline churn | — | **zero** |

---

## 2. 🔴 THE LESSON: the work item was real, its stated cause was not

Pass 35 recorded the 33-row review queue as needing an N:N transfer-pairing feature, and gave a
precise diagnosis: PASS 2 re-flags unconditionally, `nearest.length === 1` blocks pairing, so the
detector must learn to pair N equal outflows against N equal inflows.

Every sentence of that is true about the code. The conclusion was still wrong, because it never
asked whether another part of the app already solved it. **It does.** `linkTransferPair`
(`transfer-links.ts:161-210`) stamps `transferGroupId` + category + `needsReview: false` on both
legs with lossless undo; it is exposed as `linkTransferAction`; it is wired to a **"Link as
transfer…" button on the ordinary transaction sheet** (`TransactionSheet.tsx:258` →
`LinkPanels.tsx:141`). Because it stamps `transferGroupId`, the rows drop out of `candidates` at
`categorize.ts:424` and **PASS 2 can never re-flag them.** The owner can empty all 33 today, by
hand, permanently, with undo. A second permanent escape exists at `bulk-edit.ts:196`.

**The generalisable rule: before building a mechanism to make a queue drainable, check whether a
shipped UI already drains it.** The handoff described the detector honestly and the *product*
inaccurately, and a pass that trusted it would have shipped a delicate money-path feature to
solve a problem the owner could already click through.

What is actually missing is narrower and was never named: **a dismissal does not survive the next
run.** There is no way to say "I looked, it's fine" that PASS 2 respects — only stamping
`transferGroupId` sticks. That is the real item, and it is a schema change (§6.2).

---

## 3. What shipped

### 3.1 The perimeter — hosting's entire code prerequisite (§7.1, closed)

`src/middleware.ts` → **`src/proxy.ts`** (Next 16 convention; the deprecation warning is gone).
The hard-coded loopback allowlist moved to **`src/lib/allowed-hosts.ts`**, where
`MONEYAPP_ALLOWED_HOSTS` can extend it. Loopback is hard-coded and never sourced from env, so an
**unset variable reproduces the old local-only posture byte for byte**.

**The perimeter had zero tests. It now has 24**, deliberately in `src/lib` so the repo's
100%-branch gate covers them. `src/proxy.ts` is a ~6-line adapter outside that gate.

⚠️ **Three traps, all measured, all worth keeping:**

- **A root-level `proxy.ts` builds clean with NO warning, no tree entry — and serves
  `Host: evil.com` a 200.** Next resolves the convention against the directory containing `app/`.
  A wrong *export name* fails the build loudly; a wrong *location* fails silently. **The file must
  be `src/proxy.ts`.**
- **`fetch()` rewrites `Host`**, so it reports a false 200 pass against a working perimeter. Only
  `curl`/`node:http` prove anything.
- **Assert on manifests, not stdout.** The tree line is `ƒ Proxy (Middleware)` with U+0192 (a grep
  for `f Proxy` misses), and it prints for edge middleware too. The real proof is
  `functions['/_middleware'].runtime === 'nodejs'` and `middleware-manifest.middleware === {}`.

Verified live: a bad Host **403s on Server Action POSTs and on `/_next/static` assets** (matcher
is `^.*$`), the env read survives bundling **un-inlined** (per-request, not frozen at build), and
with the variable set, `other.ts.net:443` is normalized and admitted as `other.ts.net`.

A refuted claim worth recording: the migration was said to be **mandatory before** the env work,
because edge middleware supposedly freezes env at build time. **False** — measured, edge merges
the live `process.env` at sandbox creation. The ordering was a preference, not a safety
constraint.

### 3.2 Wallet creation — three ways to a frozen balance, closed

All three present as *"I entered spending and the number did not move."*

1. **The generic "add an account" form anchors on TODAY.** Right for a bank account, wrong for a
   wallet, whose number is an *opening* that replays forward — a wallet minted there freezes for
   every entry dated today or earlier. Cash is now filtered from the picker, and the action
   refuses it as a backstop pointing at the wallet form.
2. **Flipping an existing wallet to `investment`** routed derivation down the holdings branch,
   which carries the anchor forward and never reads the day sums — discarding every entry after
   the opening, **upward**, because the opening is the oldest date the wallet has. Measured:
   **$1,150.00 → $1,800.00.** Now refused.
3. **The account and its anchor were two loose writes**, so a throwing anchor left an account the
   owner was told had not been created. Now one transaction.

⚠️ **The guard on (2) keys on manual rows for a narrower reason than the obvious one.** It is
*not* that "manual is what derivation cares about" — derivation filters on `status` and never
reads provenance (an imported account suffers the same freeze: measured 70000 → 100000). It is
that manual rows have **no external ground truth to re-anchor from**. An imported account's newest
anchor is a recent statement, so the next import restates it; blocking that case too would break
the legitimate repair of a stub created as `checking` that is really a brokerage. **That wider
behaviour is now pinned by a test as accepted, confirm-gated** — do not "fix" it.

Both new tests were **confirmed RED** before the fix (`expected [Function] to throw`;
`expected true to be false`).

### 3.3 An open duplicate is visible from every route

A second, **warning-toned** pill on the Transactions nav item — not merged into the review badge.
Review and duplicates are different questions with different answers, and one number would tell
the owner neither what is wrong nor where to go. The source itself argues this at
`DuplicatePairs.tsx:13-18`.

⚠️ **The count lives in a LEAF module (`src/services/duplicate-count.ts`), and that IS the
change, not a tidy-up.** `duplicate-resolution.ts` imports the statement importer, which reaches
a **2.2 MB PDF parser**; the root layout renders on every route. `duplicate-resolution.ts`
re-exports it so the queue and the badge cannot drift apart.

⚠️ **`safeDuplicateCount` is a SEPARATE try/catch from `safeReviewCount`, deliberately.**
`duplicate_candidates` arrives only in migration 0008, so on an older database a shared catch
would zero the **review** badge too — the exact silent-zero failure the original comment exists to
prevent.

The existing review pill is **byte-identical** (same markup, same `ml-auto`, no shared flex
wrapper), which is why 143 nav-bearing baselines saw **zero churn**. The label says **"duplicate
pairs"**, not "possible duplicates": the count is of candidate PAIRS, and two identical charges in
each of two files produce **four** (`duplicate-resolution.test.ts:350`).

Also added the **soft-tint contrast gate that did not exist**. The suite checked every tone on the
*sheet*, never on its own tint, so `bg-warning-soft` + `text-warning` was ungated (it measures
4.71:1 in light — passing by 0.21). Confirmed the new gate bites by retuning the token.

⚠️ A prior report cited `src/lib/state-contrast.test.ts` as already gating this. **That file does
not exist** — the path was inherited from a stale comment at `Badge.tsx:5-6` without opening it.

### 3.4 The test clock's zone is pinned

`vitest.config.ts` now sets `TZ=Pacific/Kiritimati`.

**UTC would have been the wrong pin.** Eastern is UTC−5, so running under UTC on an Eastern box
makes the local date *equal* the UTC date — hiding exactly the disagreement pass 30's bug was made
of. Kiritimati is UTC+14 with **no DST**: 19 hours from Eastern, deterministic year-round.

Measured **before** pinning, not after: the suite is already timezone-independent — **2,534 green
at UTC+14, UTC−11, UTC+9 and UTC**. This costs nothing today and fails loudly if the bug class
returns. A probe inside the runner confirms the option is **not inert**
(`TZ=Pacific/Kiritimati`, `getTimezoneOffset() -840`).

---

## 4. Process notes

**10 agents: five investigations, each adversarially refuted.** Nine completed; the `testinfra`
refuter died on the session limit (see §6.3 for the consequence).

**All four surviving verdicts came back `partly-wrong`** — the same ratio as pass 35, and the
refutations changed the plan four times, twice in ways that mattered:

- The detector work item's entire premise (§2). The scout proposed shipping an N:N pairing rule;
  the refuter found the shipped UI that already solves it.
- A *fabricated test gate* — a cited contrast test that does not exist. The scout inherited the
  path from a stale code comment without opening it, which is precisely this repo's recorded
  failure mode.
- A false "mandatory ordering" for the perimeter, refuted by building a scratch app.
- `.env.example` was claimed gitignored; `.gitignore:19` has an explicit `!.env.example`
  negation, so it is **tracked** — the edit is a committed deliverable, not a local note.

⚠️ **The most valuable agent output this pass was a refutation, not a plan.** Had I implemented
the detector report as written, I would have shipped a delicate money-path feature to solve a
problem the owner can already click through — and touched the one component (§5) that nothing in
the ledger can verify.

⚠️ **Guards that earned their keep again:** `E2E_GATE=1 pnpm e2e:fresh` (never a stale `.next`),
and `git status --porcelain e2e/` as the churn signal. Zero churn was a *prediction* made before
the run, from the byte-identical-pill argument — and it held.

---

## 5. ⛔ ASKED AND ANSWERED — "leave it alone" (owner, 2026-08-04)

**The owner was asked directly and chose: not sure, leave it alone.** That is a decision, not a
gap — treat it as standing until they revisit it.

**Consequences, binding on pass 37+:**
- **Do NOT auto-pair the $6,000 component.** Absent an answer, pairing it would be a guess about
  real money.
- **Do NOT flag it as a duplicate** either. Both readings are still live; surfacing it as a
  duplicate asserts one of them.
- **Leave all 33 rows exactly as they are.** They are safe, correctly categorized as transfers,
  and affect no total.
- **Do not re-ask spontaneously.** The owner can check the Robinhood app when convenient. Re-ask
  only if new evidence arrives — e.g. a second Robinhood export that would let
  `duplicate-flags` see across import files, or a statement period that gives Robinhood Cash a
  reconciliation arbiter for the first time.

The question, for whenever they do revisit it:

**Are the two identical Robinhood +$6,000 rows on 2025-07-07 two real fundings, or one charge
imported twice?**

Nothing in the ledger can answer this. **Robinhood Cash has zero `statement_periods`**, so the
reconciliation arbiter — the tool that settled every comparable question in passes 34 and 35 — is
simply unavailable there. Both rows came from one import file, so `duplicate-flags` cannot see
them either (`duplicate-flags.ts:66` requires different `import_file_id`).

The 33 rows are **safe either way** and no total is affected: all 33 already carry
`transfer`-kind categories. This question only gates whether a future detector change may
auto-pair that component.

**Do not guess.** Pass 33 shipped a dedupe fix that silently deleted real charges, on exactly this
kind of inference. If the answer is "two real fundings", the component must never be auto-paired.

---

## 6. Road ahead

### 6.1 Hosting — still 5–7 hours, still no rewrite, and the code side is now DONE

**Everything in §7.1 of the pass-35 handoff is closed.** What remains is entirely the owner's own
machine setup, per `docs/hosting-and-auth-plan.md` §3: install Tailscale on Mac/phone/tablet,
MagicDNS + HTTPS certs, `tailscale serve --bg 3000`, a `launchd` plist, and Energy Saver. Then set
`MONEYAPP_ALLOWED_HOSTS=<tailnet name>` in `.env`.

⚠️ **`tailscale funnel` must NEVER be enabled** — Serve is private-tailnet-only; Funnel is the
public internet.

⚠️ **A5 in `docs/future-ideas.md` is now closed, but A4 (auth) is NOT.** The allowlist admits a
*host*; it does not authenticate a *person*. On a private tailnet that is the correct trade — the
tailnet is the auth boundary. On the public internet it is not.

⚠️ **The one deploy-day check that cannot be run from this machine:** after `tailscale serve`,
curl the tailnet URL from a second device and confirm from the server log **which `Host` actually
arrived**. If Tailscale rewrites it to `127.0.0.1`, then `MONEYAPP_ALLOWED_HOSTS` is a no-op **and
the perimeter is bypassed for anything reaching loopback** — stop before exposing real data.

⚠️ **Still do not propose a hosted-DB migration.** 79 files, 448 sync call sites, 211 functions,
30+ money transactions where a missed `await` silently commits partial state. Batch PDF import
breaks on serverless regardless (4.5 MB vs 100 MB).

⚠️ **Phase 5 of the hosting plan is the one not to skip: off-machine encrypted backups.**
Tailscale solves access, not durability. Back up `data/backups/daily-*.db`, **never** the live
`moneyapp.db`, and verify a restore once on a copy.

### 6.2 Correctness

1. **Make a dismissal survive PASS 2** (§2) — the real remedy for the review queue. Recommended: a
   `review_dismissed_at` column; PASS 2 skips a row whose dismissal is newer than its last
   mutation. The alternative (reusing `bulk-edit.ts:196`'s self-group) needs no schema change but
   overloads `transferGroupId` with "dismissed" and silently opts the row out of duplicate-flags.
2. **N:N transfer pairing** — optional, and the **$6,000 component is now explicitly excluded by
   owner decision (§5), not merely unresolved**. If built, it must skip that component. Otherwise:
   run the unique-nearest fixpoint to a stall, then commit ONE saturated block, repeat. Do **not**
   relax to `min(N,M)` — the leftover row freezes with a stale `needs_review` that PASS 2 can no
   longer re-derive. Expect exactly **4 pairs / 8 rows / 33 → 25**; any other count means stop.
   Note the corrected money gate: the two $2,000 corrections **stack to −$4,000 on 2025-05-16**
   (overlapping windows), so a gate expecting −$2,000 fails a *correct* implementation.
   Before shipping it, settle what `commitPair` should do when both legs are user-categorized with
   *different* categories — today it creates a group violating its own documented invariant.
3. **The remaining pass-35 §5 items** — nothing re-flags a duplicate after one side is
   categorized; a cross-account double count is undetectable by construction (the join requires
   the same account); a dismissed pair whose row is later hard-deleted keeps suppressing its
   `pair_key` invisibly.

### 6.3 Quality — and the two items I deliberately did NOT ship

4. **Touch emulation.** `playwright.config.ts` is a single desktop chromium with no `hasTouch`, so
   every `pointer: coarse` branch has never executed — and the owner's iPhone is the only device
   that runs them. **Not shipped because its refuter died on the session limit**, leaving an
   unrefuted plan for a change with a measured hazard: `fullyParallel: false, workers: 1` and the
   specs share ONE database with the golden-path spec mutating it last, so a second project would
   double-run everything against shared state. Scope it to a subset, or give it its own DB, and
   refute the plan first.
5. **`maxDiffPixelRatio`** is 0.001, looser than it looks (pass 29 removed a visible pill and moved
   no baseline). Same reason for deferring; tightening also forces a baseline regeneration.
6. **Re-measure the Phase 2 perf backlog before touching it.** Pass 31's 16.4× `compareDates` fix
   moved what is actually slow; items 24/26/32/30/29/25 were prioritised against the old profile.
   Re-profile first — pass 31's own lesson is that the backlog named the right symptom and the
   wrong cause.
7. **Responsive sweep at 320/375** on real routes as new surfaces land.
8. **The bounded batch-boundary import test** (pass 34 §5 item 6) — test the BATCH BOUNDARY, not
   permutations; permuting one call is a provable no-op because the service sorts its input.
