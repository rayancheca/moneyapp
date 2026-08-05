# Hosting & Auth Plan

**Date:** 2026-07-27
**Question:** How does the owner VIEW MoneyApp from phone, tablet and monitor, for free, with auth, without putting his real financial data at risk?

**Answer, in one line:** Run the app on the Mac it already runs on, and put it on a Tailscale tailnet. Zero code rewrite, $0/month forever, real data never leaves the machine, and the network *is* the auth.

---

## 1. The constraints, measured (not assumed)

Everything below was measured against the current worktree, not inferred.

### 1.1 The synchronous-driver blast radius

`src/db/client.ts` uses `better-sqlite3` + `drizzle-orm/better-sqlite3`. This is a **synchronous** driver, and that sync-ness has propagated through the entire codebase:

| Metric | Count | How it was measured |
|---|---|---|
| Files importing `getDb` / `getDbBundle` / `createDatabase` | **79** | `grep -rln` across `src`, `scripts`, `e2e`, `tests` |
| Files referencing the `AppDatabase` type | 47 | `grep -rl AppDatabase` |
| Sync terminal call sites (`.all()` / `.get()` / `.run()` / `.values()`) | **448** | `grep -rEc` across `src` |
| **Non-async** exported functions in `src/services` | **211** | `grep -rE "^export function " src/services` |
| Already-`async` exported functions in `src/services` | **5** | `grep -rE "^export async function " src/services` |
| Files using drizzle's **sync** `db.transaction(cb)` | **17** (30+ call sites) | `grep -rn "\.transaction("` |
| Test files that open a database | 43 | `grep -rl` in `*.test.ts` |
| Non-test service files | 56 | `find src/services` |

**The 211-vs-5 ratio is the whole story.** The service layer is written as ordinary synchronous functions that return values, not promises. Making the driver async does not mean "add `await` in 79 files" — it means:

1. 448 call sites get `await`.
2. 211 exported service functions become `async` and their return types become `Promise<T>`.
3. Every **caller** of those 211 functions becomes `async` and awaits — transitively, until the change reaches a React Server Component (which can await) or a Server Action (which can await). RSCs absorb this gracefully; the pure `lib/` modules do not.
4. All 30+ `db.transaction((tx) => {...})` callbacks become `async (tx) => {...}` and every statement inside gets awaited. **This is the highest-risk item** — these wrap the money-mutating paths (`categorize.ts`, `transaction-splits.ts`, `bulk-edit.ts`, `import/service.ts`, `transfer-links.ts`, `derivation.ts`). A missed `await` inside a transaction does not throw; it silently commits a partial transaction. That is a data-corruption class of bug in a financial ledger.
5. 43 test files get reworked; 1536 unit tests must stay green.

**Honest estimate for the sync→async conversion alone: 25–40 engineering hours**, and it carries the highest defect risk of anything in this document. The prior pass-13 finding ("Turso is NOT a drop-in, ~68 files") is **confirmed and if anything understated** — the true import count is 79 files / 448 call sites / 211 function signatures.

### 1.2 What else is locked to the local filesystem

- **`src/db/backup.ts`** uses `sqlite.backup()` — better-sqlite3's *online backup API*. The file header explicitly warns this must never be a raw file copy of a live WAL database. This API does not exist in `@libsql/client` or in any Postgres driver. Backups would need a complete rewrite under options (b), (c), (d).
- **`src/services/import/service.ts`** writes statement originals to disk with `fs.writeFileSync` / `fs.mkdirSync` / `fs.renameSync` under `data/statements/<account-slug>/` (override: `MONEYAPP_ORIGINALS_DIR`). It even has an `EXDEV` cross-device fallback. Any ephemeral-filesystem host silently loses this archive on every redeploy.
- **`src/instrumentation.ts` → `src/db/boot.ts`** runs migrations + seed + a daily snapshot **once at server boot**. This assumes a long-lived process. On a scale-to-zero serverless host, this runs on *every cold start*.
- **`next.config.ts`** sets `serverExternalPackages: ["better-sqlite3"]` (native module, cannot be bundled) and `serverActions.bodySizeLimit: "100mb"` for statement batches. Most serverless platforms cap request bodies far below 100 MB (Vercel's limit is 4.5 MB on serverless functions) — **batch PDF import would break on serverless regardless of the database**.

### 1.3 Data footprint — reassuringly tiny

```
data/moneyapp.db      3.6 MB   (+1.1 MB WAL)
data/statements       1.2 MB   (348 statement files)
data/backups          7.3 MB
TOTAL                  17 MB
```

This fits inside every free tier discussed. **Storage is never the constraint** — the constraint is always "does the filesystem survive a redeploy, and does the driver have to change."

### 1.4 Two Next.js 16 findings that affect the auth design

**(a) `middleware.ts` is deprecated in Next 16.** ✅ **DONE in pass 36** — the app now ships
`src/proxy.ts` exporting `proxy`, and the build no longer prints the deprecation warning.

The codemod was **not** used, and should not be: `@next/codemod` needs network, has repo-wide
blast radius, and every one of its other transforms had zero targets here. The whole migration
was `git mv` plus renaming one identifier.

⚠️ **The file must be `src/proxy.ts`.** Next resolves the convention against the directory
containing `app/`, so a **root-level `proxy.ts` builds cleanly with no warning, no tree entry —
and the perimeter is silently gone** (measured: `Host: evil.com` → 200). A wrong *export name*
fails the build loudly; a wrong *location* does not. Verify against
`.next/server/functions-config-manifest.json` (`functions['/_middleware'].runtime === 'nodejs'`),
never against a stdout string.

**(b) Proxy does NOT reliably cover Server Actions.** The docs are explicit:

> "Server Functions are not separate routes in this chain. They are handled as POST requests to the route where they are used, so a Proxy matcher that excludes a path will also skip Proxy coverage. A matcher change or a refactor that moves a Server Function to a different route can silently remove Proxy coverage. **Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone.**"

This app has **78 Server Actions across 14 files**, 15 pages, and **0 API routes**. All mutation goes through Server Actions. So *any* proxy-only auth scheme is one matcher refactor away from exposing every write path. This is a real design input, addressed in §4.

### 1.5 The Host guard — ✅ made configurable in pass 36

It used to hard-reject any `Host` that was not loopback, which was the single line blocking
*any* remote-access plan. `src/proxy.ts` now delegates to `src/lib/allowed-hosts.ts`:

- loopback (`localhost`, `127.0.0.1`, `[::1]`) is **hard-coded and unconditional** — never from env
- extra hostnames come from `MONEYAPP_ALLOWED_HOSTS` (comma-separated, no wildcard)
- **unset == the historical local-only posture, byte for byte**

Set it on deploy day: `MONEYAPP_ALLOWED_HOSTS=moneyapp.your-tailnet.ts.net`.

Env is read **per request**, not at module scope, so an operator's edit is not frozen until a
rebuild. Entries run through the same normalizer as the incoming `Host`, so a pasted
`name:443` still matches. There is deliberately **no `x-forwarded-host` fallback** — that header
is attacker-controlled and would defeat the rebinding defense this file exists for.

⚠️ **Keep `next start -H 127.0.0.1` in `package.json`.** Counter-intuitive but correct:
Tailscale Serve terminates TLS and proxies *to* loopback, so the app stays reachable only
through the tailnet and never on the LAN. Changing the bind is strictly less safe.

⚠️ **Verify with `curl`, never `fetch()`** — `fetch` rewrites `Host`, so it reports a false
200 pass against a perimeter that is actually working.

---

## 2. Option-by-option evaluation

### (a) Keep SQLite, host on an always-on container with a persistent volume

**Code change: ~0 hours. The attraction is real.** But "what actually stays free" is now a short list.

| Platform | Free? | Persistent disk? | Verdict |
|---|---|---|---|
| **Fly.io** | **No.** The free tier was discontinued in 2024; new users get a trial of 2 VM-hours or 7 days. Volumes are billed hourly *whether or not the machine is running*. | Yes (paid) | ~$2–5/mo. Works technically, not free. |
| **Railway** | **No.** No free tier; Hobby is $5/mo. | Yes | $5/mo. Works, not free. |
| **Render** | Free tier exists, but **free web services cannot attach a persistent disk** — the docs state it plainly: *"Paid services can preserve local filesystem changes by attaching a persistent disk, but Free web services cannot."* Free services also spin down after 15 min idle. | **No on free** | **Disqualified on free.** The DB and the statements archive would be wiped on every spin-down/redeploy. Paid: $7/mo + $0.25/GB. |
| **Google Cloud Run + GCS FUSE volume mount** | Yes, generous free tier | Technically | **Actively dangerous — disqualified.** Google's own docs: *"Cloud Storage FUSE does not provide concurrency control for multiple writes (file locking) to the same file... the last write wins and all previous writes are lost."* SQLite depends on POSIX file locking for WAL integrity. This is a corruption risk against a real financial ledger. Do not do this. |
| **Google Compute Engine e2-micro ("Always Free")** | **Yes — genuinely, permanently free** | **Yes — 30 GB standard persistent disk, a real filesystem** | **The only actually-free always-on container option.** See §3 runner-up. |

**What happens to the file on redeploy** — the question that kills most of these: on Fly/Railway/Render-paid the volume survives because it is a mounted block device separate from the image. On Render-free, Cloud Run without a volume, or any serverless target, the filesystem is ephemeral and **the database is destroyed on every deploy and every scale-to-zero**. There is no partial credit here.

**Cost: $0 (GCE e2-micro) to $7/mo (Render paid). Engineering: 2–5 hours** (Dockerfile, volume mount, host allowlist change).

### (b) Migrate to hosted SQLite (Turso / libSQL)

**The prior finding is CONFIRMED.** Drizzle's official libSQL adapter (`drizzle-orm/libsql`, using `@libsql/client`) is **async** — every query returns a promise. That triggers the full 25–40 hour conversion in §1.1, plus a `backup.ts` rewrite.

Turso's free plan is otherwise excellent: 100 databases, **5 GB storage, 500M row-reads/mo, 10M row-writes/mo** — this app would use a rounding error of that.

**One genuinely interesting escape hatch, presented as a hypothesis not a promise:** the [`libsql` npm package](https://github.com/tursodatabase/libsql-js) (tursodatabase/libsql-js, **MIT**, ~334 stars, published ~2 months ago) is explicitly *"API bindings for Node, which aims to be compatible with better-sqlite3, but with opt-in promise API"* — i.e. **a synchronous, better-sqlite3-shaped API** — and it supports **embedded replicas** that sync against a remote Turso database. Because `drizzle-orm/better-sqlite3` only calls `prepare/run/all/get/values/transaction`, there is a plausible path where you swap the driver object and keep all 448 sync call sites.

If that works, Turso becomes a ~4–8 hour change instead of a 25–40 hour one. **But it is unofficial, untested here, and the write path would be blocking network I/O on the Node event loop.** It deserves a timeboxed 2-hour spike before anyone plans around it — it must not be assumed.

**Cost: $0/mo. Engineering: 25–40 hours (official path) or 4–8 hours (unverified sync-driver path).**

### (c) Migrate to Postgres (Neon / Supabase free tier)

Drizzle makes the *query builder* portable. Almost nothing else is.

What actually breaks:

- **All of §1.1** — the async conversion, in full. Postgres has no sync driver. Non-negotiable.
- **All 17 schema files rewritten** from `sqlite-core` to `pg-core`, and all 7 migrations regenerated. The existing migration history is SQLite DDL and cannot be replayed.
- **Dialect breaks in raw SQL.** There are **25 raw ``sql`...` `` fragments** in `src`. Confirmed problems:
  - `` sql`is_active = 1` `` — SQLite booleans are integers; Postgres requires `is_active = true`. Hard error.
  - `` sql`... LIKE ${pattern} ESCAPE '\\'` `` — **SQLite `LIKE` is case-INSENSITIVE for ASCII by default; Postgres `LIKE` is case-SENSITIVE.** This is a *silent* behaviour change in the merchant-matching and transaction-search paths. Nothing throws; results just quietly get worse. This is the nastiest item in the whole migration.
  - Timestamps are stored as `text` throughout (SQLite has no date type). Portable, but leaves the Postgres schema with text dates — you inherit the SQLite modelling without gaining Postgres's date semantics.
- **`backup.ts` rewritten entirely** — `sqlite.backup()` becomes `pg_dump` against a remote host, on a schedule you now have to own.
- **The statements archive still needs a home** — Postgres solves the DB, not the 348 files on disk.

**Cost: $0/mo (Neon/Supabase free). Engineering: 45–70 hours, with a silent-correctness landmine.** For a single-user app whose entire dataset is 3.6 MB, this is a large amount of risk purchased for no benefit.

### (d) Firebase, since he has Workspace admin

Two separate questions; they deserve opposite answers.

**Firestore as the database: no. Emphatically.** This schema is deeply relational — 17 schema modules with foreign keys, `transaction_splits` overlaying `transactions`, `holding_events`, `recurring` links, `transfer_links`, and a documented invariant that `daily_balances` is a *derived cache* whose truth is `txns + anchors`. The app's core operations are joins and aggregations across 1,673 transactions and 2 years of daily balances. Firestore has no joins, no aggregate SQL, and charges per document read — a net-worth series that scans daily balances becomes thousands of billed reads per page load. You would be rewriting every query in `src/services` (56 files) against a data model that cannot express the app's invariants, and the 1536 unit tests would need a Firestore emulator. **This is the single worst option on the list. 100+ hours to arrive somewhere strictly worse.**

**Firebase App Hosting for the Next app: possible, but not free.** The docs are explicit: *"create a Firebase project and make sure it has the Blaze pricing plan enabled."* App Hosting **requires the Blaze (pay-as-you-go) plan** — the free Spark plan is not sufficient. It also runs on Cloud Run underneath, which means ephemeral filesystem, which means better-sqlite3 is out. Blaze has generous free *quotas*, so the bill would likely round to ~$0–2/mo, but it requires a credit card on file and it does not solve the database.

**Firebase Auth even if the DB lives elsewhere: yes — this part is genuinely good.** See §4. It is free (Spark tier covers auth), it supports Google sign-in, and restricting to his own Workspace domain or a single hard-coded UID is trivial. It works fine with a DB that lives anywhere.

### (e) Don't host the app at all — local machine + Tailscale

Taking this seriously, as instructed — and it wins.

**What it is:** the app keeps running exactly as it does today (`pnpm start`, bound to `127.0.0.1:3000`). Tailscale creates a private WireGuard mesh between his Mac, phone, tablet and monitor. `tailscale serve` publishes `localhost:3000` to that private network over HTTPS with a real certificate. He opens `https://macbook.<tailnet>.ts.net` on his phone and sees the app. Nothing is on the public internet at any point.

**Why it dominates every other option:**

| Dimension | Result |
|---|---|
| Code change | **Effectively zero.** No driver rewrite. The 79 files / 448 call sites / 211 sync functions / 30 transactions are untouched. |
| Cost | **$0/month, permanently.** Tailscale's Personal plan was made *more* generous in April 2026: **up to 6 users with unlimited user-owned devices** (phones, tablets, laptops all count as user devices). |
| Real financial data | **Never leaves his machine.** No third party ever holds it. |
| Statement import | Works unchanged — 100 MB Server Action bodies, `fs` writes to `data/statements/`, all fine on a real filesystem. |
| Backups | `sqlite.backup()` keeps working exactly as written. |
| Auth | Solved at the network layer by WireGuard device keys. There is no login form to phish, no password to leak, no session to steal. |
| Performance | Best of all options — the DB is a local file, not a network hop. |

**The honest costs:**

1. **The Mac must be awake and the server running.** Fix: `sudo pmset -a sleep 0` / "Prevent automatic sleeping when the display is off" in Energy Saver, plus a `launchd` plist to keep `pnpm start` alive across reboots. If the Mac is a laptop that travels closed, this is friction — a ~15 minute setup, but real ongoing friction.
2. **No access if the Mac is off.** For a personal finance dashboard checked a few times a week, this is a genuinely acceptable trade.
3. Every viewing device needs the Tailscale app installed and logged in once. That is a one-time 2-minute step per device — and it is *also* the auth enrolment step.

**Static export is NOT a viable sub-option** and should be dismissed: the app is 15 RSC pages driven entirely by live database reads, with 78 Server Actions. `output: 'export'` supports neither Server Actions nor Proxy (the docs' platform-support table lists Static export as "No" for Proxy). A static export would be a dead screenshot of the app, and would additionally mean publishing his real financial figures as plain JSON in a public bundle.

**Cost: $0/mo. Engineering: 2–4 hours.**

---

## 3. Recommendation

### PRIMARY: Local machine + Tailscale (option e), with Tailscale Serve

This is the recommendation with high confidence. It is the only option that is simultaneously **free, zero-rewrite, and privacy-preserving**. Every hosted option asks him to pay for something — either dollars, or 25–70 hours of high-risk refactoring, or handing his complete financial history to a third party — in exchange for a benefit ("works when the Mac is asleep") that is small for a personal dashboard.

The strongest argument is the risk asymmetry. The migration options put the *money-mutating transaction paths* (`categorize.ts`, `bulk-edit.ts`, `transaction-splits.ts`, `import/service.ts`) through a mechanical async conversion where a single missed `await` inside a transaction silently commits partial state. Against a ledger the owner has spent 24 documented passes reconciling to the cent — including hand-categorizing 434 merchants and de-double-counting the Robinhood buys — that is a genuinely bad trade for remote access.

#### Step-by-step migration plan

**Phase 0 — prerequisites (30 min)**
1. Install Tailscale on the Mac (`brew install --cask tailscale`), sign in with his Google account.
2. Install Tailscale on phone and tablet from the App Store / Play Store; sign in with the same account. Confirm all three appear in the admin console.
3. Note the Mac's tailnet DNS name, e.g. `macbook.tailnet-xyz.ts.net`. Enable MagicDNS and HTTPS certificates in the admin console.

**Phases 1 and 2 — ✅ ALREADY DONE (pass 36). No code work remains before deploy day.**

Steps 4–8 are complete and verified: `src/proxy.ts` exports `proxy`, the allowlist lives in
`src/lib/allowed-hosts.ts` and reads `MONEYAPP_ALLOWED_HOSTS` **per request**, and the perimeter
has 24 unit tests where it previously had none. The one step left for the owner:

7. Set `MONEYAPP_ALLOWED_HOSTS=macbook.tailnet-xyz.ts.net` in `.env` (it is gitignored;
   `.env.example` documents the variable).

Do **not** re-run the codemod — the migration is already done, and running it now would find
nothing to change.

9. **Keep `-H 127.0.0.1` in `package.json`.** This is important and slightly counter-intuitive: Tailscale Serve terminates TLS and proxies *to* loopback, so the Next server should continue to bind loopback only. The app is then reachable *exclusively* through the tailnet — it is not listening on the LAN at all. This is the safest possible posture and it requires changing nothing.

⚠️ **Deploy-day check that cannot be run from this machine.** After `tailscale serve`, curl the
tailnet URL from a second device and confirm from the server log which `Host` actually arrived.
If Tailscale rewrites it to `127.0.0.1`, then `MONEYAPP_ALLOWED_HOSTS` is a no-op **and the
perimeter is bypassed for anything that reaches loopback** — stop and rethink before exposing
real financial data.

**Phase 3 — publish to the tailnet (30 min)**
10. `pnpm build && pnpm start`
11. `tailscale serve --bg 3000`
12. Open `https://macbook.tailnet-xyz.ts.net` on the phone. Verify HTTPS padlock and that charts render.
13. **Confirm `tailscale funnel` is OFF.** Serve = private tailnet only. Funnel = public internet. Funnel must never be enabled for this app.

**Phase 4 — keep it running (1 hour)**
14. Energy Saver: prevent sleep when display is off (or `sudo pmset -a sleep 0` for a desktop).
15. Create a `launchd` plist (`~/Library/LaunchAgents/com.moneyapp.server.plist`) with `KeepAlive` so `pnpm start` survives reboots and crashes.
16. Verify: reboot the Mac, then load the app from the phone without touching the keyboard.

**Phase 5 — off-machine backups (2 hours) — do not skip this**
17. Tailscale solves *access*, not *durability*. The 17 MB in `data/` is currently single-copy on one laptop. Add a nightly encrypted off-machine copy: `restic` or `rclone` to Google Drive (he has Workspace), encrypted client-side with a passphrase stored in his password manager.
18. Back up `data/backups/daily-*.db` (already produced by `backup.ts` via the safe online-backup API), **not** the live `moneyapp.db` — copying a live WAL database is exactly the corruption the existing code was written to avoid.
19. Verify the restore path once, on a copy. An unverified backup is not a backup.

**Total: 5–7 hours, $0/month.**

### RUNNER-UP: Google Compute Engine e2-micro "Always Free" + Docker + persistent disk

If the "Mac must be awake" constraint proves genuinely annoying, this is the named runner-up — and it is the *only* always-on hosted option that is actually free.

- **Free forever**: 1 e2-micro instance + **30 GB standard persistent disk** + 1 GB/mo egress, in `us-west1`, `us-central1`, or `us-east1` only. He already has GCP through Workspace admin.
- **Zero database rewrite** — it is a real VM with a real filesystem. better-sqlite3, `sqlite.backup()`, the statements archive and the 100 MB Server Action limit all keep working.
- **Deploy**: Dockerfile with `output: "standalone"`, `data/` on the persistent disk, systemd unit, Tailscale installed *on the VM* so it joins the same tailnet (keeps auth identical to the primary plan and keeps the app off the public internet).

**Caveats, stated honestly:**
- e2-micro is **1 GB RAM / 0.25 vCPU baseline**. A Next 16 production build will very likely OOM there. Build locally or in CI and ship the built image; do not `next build` on the box. Add 2 GB of swap regardless.
- **Must use "Standard" persistent disk** — Balanced/SSD are not free.
- **1 GB/month free egress.** For one user with browser caching this is fine, but a heavy 3D-chart bundle loaded uncached on cellular will eat into it. Worth watching, given the deliberate decision not to optimise bundle size.
- Wrong region = full price. Pin the region carefully.

**Cost: $0/mo. Engineering: 8–12 hours.**

### Explicitly rejected

- **Firestore** — relational schema, join-heavy queries, per-read billing. 100+ hours to a worse outcome.
- **Cloud Run + GCS FUSE for the real DB** — no file locking, documented data-loss-on-concurrent-write. Corruption risk against a financial ledger.
- **Render free tier** — no persistent disk on free; the database would be destroyed on every spin-down.
- **Static export** — cannot run Server Actions or Proxy, and would publish real financial figures in a public bundle.

---

## 4. Auth — what the minimum responsible auth actually is

**Plainly: on the primary (Tailscale) plan, the minimum responsible auth is Tailscale itself, plus the existing host allowlist. Nothing else is required.**

That is not a cop-out, and it is worth being precise about why it is *stronger* than a login form, not weaker:

- Access is gated by **WireGuard device keys**, enrolled per device and revocable from the admin console. There is no password, so there is nothing to phish, reuse, or leak in a breach.
- The app is **not on the public internet**. There is no URL an attacker can reach. Every hosted-app-plus-password design leaves a public login page exposed to the entire internet forever; this design has no attack surface to defend.
- Device loss is handled correctly: revoke the device in Tailscale and it is off the network immediately, without rotating a shared secret.
- The identity layer is his Google account, which already has whatever MFA his Workspace enforces.

**This is a single-user app.** Adding Clerk or Auth.js on top of a private tailnet would add a `users` table, a session store, a login page, an OAuth callback, and 78 Server Actions to individually guard — real complexity and new failure modes — to defend against an attacker who by construction cannot reach the app. That is over-engineering, and the brief explicitly asked not to.

### The one hardening step that IS worth doing

Add a **defence-in-depth device check** to guard against the Server Actions gap documented in §1.4(b). Tailscale Serve injects identity headers (`Tailscale-User-Login`, `Tailscale-User-Name`) that cannot be spoofed from outside the tailnet:

```ts
// src/lib/auth.ts
export function requireTailnetUser(h: Headers): void {
  if (process.env.MONEYAPP_REQUIRE_TAILNET !== "1") return; // local dev unchanged
  const login = h.get("tailscale-user-login");
  if (login !== process.env.MONEYAPP_OWNER_EMAIL) {
    throw new Error("Unauthorized");
  }
}
```

Call it at the top of the mutating Server Actions. Because the 78 actions live in only **14 files**, this is a contained change — roughly **3–4 hours** including tests. It means that even if the Proxy matcher is later refactored and silently stops covering a path (the exact failure Next's docs warn about), writes still fail closed.

### If he later moves to a hosted plan, the auth ranking changes

| Option | Verdict for this app |
|---|---|
| **Tailscale device auth** | **Best.** Free, no code, no public surface. Works for primary *and* runner-up (install Tailscale on the VM too). |
| **Firebase Auth, restricted to his Workspace domain or a single UID** | **Best choice if the app ever must be publicly reachable.** Free on Spark, he already has Workspace admin, Google sign-in he already uses. Pair it with a `requireUser()` helper in all 14 action files — do not rely on Proxy alone. ~8 hours. |
| **Clerk free tier** | Works, generous (free to **50,000 monthly retained users** as of Feb 2026), fastest to integrate. But it is a third-party dependency and a hosted session store for a one-person app. ~4 hours. Fine, unnecessary. |
| **Auth.js / NextAuth v5** | **Do not choose this for new work.** It has a **peer-dependency conflict with Next 16** (`next@"^12.2.5 \|\| ^13 \|\| ^14 \|\| ^15"`), installable only with `--legacy-peer-deps`/`--force`, and its own maintainers now point new projects at Better Auth. |
| **Better Auth** | The credible modern alternative if a real auth library is ever needed — framework-agnostic TypeScript, **MIT**, ~29.3k stars, actively maintained, Drizzle adapter, passkey support. Correct pick over Auth.js. Still unnecessary for a single user behind a tailnet. |
| **Middleware/Proxy + a single hard-coded password** | **Do not.** It would be a hand-rolled auth scheme (constant-time compare, session cookie, CSRF, rate limiting — all easy to get subtly wrong) guarding real financial data, and per §1.4(b) it would not reliably cover Server Actions. Strictly worse than Tailscale for more work. |

---

## 5. The operational questions

### How do statement files get uploaded when the app is remote?

**On the primary plan: unchanged, and this is a real advantage.** The Mac is the server, so `data/inbox/` and the import UI behave exactly as they do today. The 100 MB Server Action body limit and the batch-PDF drop keep working. He can also just drag files into `data/inbox/` in Finder.

Note that **remote upload from the phone is the weakest part of every hosted option** — mobile Safari uploading ~190 statement PDFs over cellular to a 1 GB-egress VM is not a workflow anyone wants. In practice statement import is a desktop, once-a-month activity. Designing the hosting around remote upload would be optimising for something that will not happen; the phone is for *viewing*, which is exactly what he asked for.

### Where does the originals archive live?

`data/statements/<account-slug>/` on the Mac's own disk (override: `MONEYAPP_ORIGINALS_DIR`). 348 files, 1.2 MB. On the runner-up VM it moves to the 30 GB persistent disk at the same relative path — no code change, just the env var.

### How do backups work off-machine?

This is the **one genuine weakness of the local-first plan and it must not be skipped** (Phase 5 above). Today `backup.ts` writes daily and monthly snapshots into `data/backups/` — on the same disk as the database. That protects against corruption and bad writes; it does **not** protect against laptop theft, loss, or drive failure.

The fix is 2 hours: nightly `restic`/`rclone` of `data/backups/daily-*.db` + `data/statements/` to Google Drive, encrypted client-side. Back up the *snapshots*, never the live WAL database. Verify one restore.

Notably, **this weakness is not unique to local hosting** — it applies to every option. A Turso database or a GCE disk also needs an independent off-site copy.

### Should his real financial data be on someone else's server at all?

**No — and it does not need to be.** This is the deciding argument for the primary recommendation.

The dataset is his complete financial identity: every transaction across 10 accounts for 2 years, account numbers, income including a documented cash job, gambling activity, family money transfers, an account in another person's name, and ~20 holdings. It is 3.6 MB. There is no technical benefit to putting it on a third-party server — no scale problem, no collaboration requirement, no compute he lacks. The only thing hosting buys is "reachable when the Mac is asleep," which Tailscale already delivers whenever the Mac is awake, which is whenever he would actually look at it.

**The redacted/demo-copy option is excellent and already 90% built.** `scripts/demo/load-demo.ts` builds a complete synthetic database by driving the *real* pipelines end-to-end — fixture statements → import/reconcile → categorize → recurring detection → holdings → fake-mode prices → budgets. Run with `MONEYAPP_FAKE_PRICES=1 pnpm demo:load`.

So the clean split is:

- **Real data** → local Mac, Tailscale-only, never public. `$0`.
- **Demo data** → if he ever wants to *show the app* to someone (portfolio, a recruiter, a friend), deploy the synthetic DB anywhere public — Vercel Hobby, GCE, anywhere — because it contains no real financial information. That deployment can even skip auth entirely.

That gets him a shareable, public, impressive artifact **and** keeps his actual money data on hardware he owns. The demo build already exists; wiring it to a public host is ~4 hours whenever he wants it, and it is completely independent of everything above.

---

## 6. Summary table

| Option | $/month | Eng. hours | DB rewrite? | Real data exposed? | Verdict |
|---|---|---|---|---|---|
| **(e) Local + Tailscale** | **$0** | **5–7** | **No** | **No** | ✅ **RECOMMENDED** |
| (a) GCE e2-micro + disk | $0 | 8–12 | No | Yes (Google) | 🥈 **RUNNER-UP** |
| (a) Fly.io / Railway | $2–7 | 5–8 | No | Yes | Works, not free |
| (a) Render free | $0 | — | No | — | ❌ No persistent disk |
| (a) Cloud Run + GCS FUSE | $0 | 6–10 | No | Yes | ❌ No file locking — corruption risk |
| (b) Turso, official adapter | $0 | 25–40 | **Yes (async)** | Yes | Costly; no benefit here |
| (b) Turso, sync `libsql` driver | $0 | 4–8 | Maybe not | Yes | ⚠️ Unverified — spike first |
| (c) Postgres (Neon/Supabase) | $0 | 45–70 | **Yes + dialect** | Yes | ❌ Silent `LIKE` case bug |
| (d) Firestore | $0–? | 100+ | **Total rewrite** | Yes | ❌ Wrong data model |
| (d) Firebase App Hosting | Blaze req'd | 10–15 | Yes (ephemeral FS) | Yes | Not free; doesn't solve DB |
| Static export | $0 | — | — | **Yes, publicly** | ❌ No Server Actions |

---

## Sources

- [Next.js — `proxy.js` file convention (middleware deprecation, Server Function coverage warning)](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Render — Free instance types documentation](https://render.com/docs/free)
- [Fly.io — Cost management](https://fly.io/docs/about/cost-management/)
- [Google Cloud — Cloud Storage volume mounts for Cloud Run](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts)
- [Google Cloud — Compute Engine free tier getting started](https://cloud.google.com/free/docs/compute-getting-started)
- [Firebase — App Hosting documentation (Blaze plan requirement)](https://firebase.google.com/docs/app-hosting)
- [Tailscale — Pricing update, April 2026](https://tailscale.com/blog/pricing-v4)
- [Tailscale — Pricing](https://tailscale.com/pricing)
- [Turso — Pricing](https://turso.tech/pricing)
- [tursodatabase/libsql-js — better-sqlite3-compatible Node bindings (MIT)](https://github.com/tursodatabase/libsql-js)
- [Drizzle ORM — SQLite drivers](https://orm.drizzle.team/docs/get-started-sqlite)
- [better-auth/better-auth (MIT, ~29.3k stars)](https://github.com/better-auth/better-auth)
- [next-auth issue #13302 — Next.js 16 peer dependency conflict](https://github.com/nextauthjs/next-auth/issues/13302)
- [Clerk — Pricing](https://clerk.com/pricing)
