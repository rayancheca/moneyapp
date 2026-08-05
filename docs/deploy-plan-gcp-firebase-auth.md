# Deployment plan — a real URL, Google sign-in, $0/month

> **Owner's requirement (2026-08-05):** *"i just want to be able to go online from any device and
> search up a url and see this app"*, gated by auth, **not** hosted on a personal computer, and
> free.
>
> **Decision (owner, 2026-08-05):** free GCP VM keeping SQLite + **Firebase Auth, Google sign-in,
> restricted to his account only**.

## 1. Where it actually runs

**Google Compute Engine `e2-micro`, Always Free tier, `us-central1` (Iowa).** A Linux server in a
Google data centre, running 24/7 — the same infrastructure Firebase itself sits on. Nothing runs on
the owner's machine, and his laptop can be closed, offline, or replaced.

You reach it at a normal HTTPS URL from any device. Sign in with Google. Done.

### Why not Firebase App Hosting, given he asked for Firebase

Two disqualifying facts, both verified rather than assumed:

1. **App Hosting requires the Blaze (pay-as-you-go) plan** — a card on file — and bills the
   underlying Cloud Run and Cloud Build at Google Cloud rates.
2. **It runs on Cloud Run, whose filesystem is ephemeral.** `data/moneyapp.db` and the statement
   archive in `data/originals/` would be **destroyed on every deploy**.

(2) is the real blocker. Making the app survive there means replacing SQLite outright: **79 files,
448 synchronous call sites, 211 functions that become `async`, and 30+ `db.transaction()` money
paths where a single missed `await` silently commits partial state** — against a ledger reconciled
to the cent. Plus `src/db/backup.ts` uses SQLite's online-backup API, which exists in no other
driver, and `next.config.ts` sets a 100 MB body limit for batch PDF import that Cloud Run will not
accept.

**Firebase Auth is used regardless** — it is a client SDK plus server-side token verification, and
has no dependency on where the app is hosted. So the owner gets exactly the Google sign-in he
asked for, without the rewrite.

## 2. Architecture

```
  phone / laptop (anywhere)
        │  https://<domain>
        ▼
  Caddy  :443           ← auto HTTPS via Let's Encrypt, renews itself
        │  http://127.0.0.1:3000
        ▼
  Next.js (systemd service, bound to loopback ONLY)
        │
        ├── src/proxy.ts      ← Host allowlist (already shipped) + Firebase session check
        └── data/moneyapp.db  ← SQLite on the VM's persistent disk, unchanged
                │
                └── nightly backup → Google Cloud Storage (free tier)
```

**The app keeps binding to `127.0.0.1`.** Caddy is the only thing listening publicly, so the Node
process is unreachable except through the TLS terminator. This is the same reasoning that kept
`-H 127.0.0.1` for the Tailscale plan, and it still holds.

## 3. The URL

The VM's external IP is free while the instance is running, but **HTTPS needs a name**. Two options:

- **Free:** a DuckDNS (or equivalent) subdomain — `something.duckdns.org` — pointed at the static
  IP. Caddy gets a real Let's Encrypt certificate for it. Total cost $0.
- **~$10/year:** a real domain. Nicer to type, same setup.

Either way `MONEYAPP_ALLOWED_HOSTS` is set to that hostname, and the perimeter shipped in pass 36
does its job unchanged.

## 4. Auth — the part that must not be sloppy

Chosen: **Firebase Auth, Google provider, allowlisted to the owner's Workspace account only.**

Non-negotiables:

1. **Verify server-side, on every request.** A client-side redirect is not auth. The Firebase Admin
   SDK verifies the session cookie in `src/proxy.ts`, whose matcher is `^.*$` — measured in pass 36
   to cover pages, static assets **and Server Action POSTs**.
2. **Allowlist one identity.** Not "any Google account", not "any account on the domain" — the
   specific UID/email. Anything else gets 403, exactly like a bad `Host` does today.
3. **Defence in depth inside Server Actions.** Next's own docs warn that a matcher change or a
   refactor can silently remove proxy coverage from a Server Function, and this app has **78 Server
   Actions and 0 API routes** — every mutation is a Server Action. A shared `requireSession()`
   helper is called at the top of each mutating action so proxy coverage is never the *only* thing
   standing between the internet and the ledger.
4. **Fail closed.** Any error verifying a token is a 403, never a pass-through. The existing
   perimeter already fails closed on a missing `Host`; match that.

⚠️ Do NOT rely on `x-forwarded-host` for the Host check. Caddy sets it, and it is attacker
controllable end-to-end; the allowlist keeps reading the real `Host`.

## 5. Backups — the thing that actually loses money

The ledger is currently a single file on one laptop. Moving to a VM does **not** fix that; it just
changes which single disk it is on.

- Nightly `sqlite3 .backup` (the safe online-backup path — **never** copy the live DB, that is the
  corruption `backup.ts` exists to avoid) → upload to a Google Cloud Storage bucket (free tier
  covers this comfortably at ~13 MB/night with lifecycle expiry).
- **Verify a restore once, on a copy.** An unverified backup is not a backup.

## 6. Build note — 1 GB of RAM

`e2-micro` has ~1 GB. A Next.js production *server* fits fine; `next build` may not. Options, in
order of preference:

1. Build locally, ship `.next` + `package.json` + `node_modules` (or a standalone output) to the VM.
2. Add a 2 GB swapfile on the VM and build there — slower but self-contained.

Decide once and script it; do not hand-run builds on a box with 1 GB of RAM and expect consistency.

## 7. Order of work

1. Firebase project + Google provider + single-identity allowlist; `requireSession()` wired into
   `proxy.ts` and every mutating Server Action. **This is the only real code work.**
2. VM: create, static IP, firewall (443 only), Node, systemd unit, Caddy.
3. DNS + certificate, then set `MONEYAPP_ALLOWED_HOSTS`.
4. Deploy script (build → ship → restart).
5. Nightly backup to GCS + one verified restore.

⚠️ Nothing here is reachable from the public internet until step 1 is done and tested. Do not point
DNS at the VM before auth is verified working — an unauthenticated URL serving real statements is
irreversible PII disclosure, and it is the one mistake in this plan that cannot be undone.
