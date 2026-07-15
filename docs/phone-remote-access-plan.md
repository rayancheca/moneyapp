# Phone Remote Access Plan — use MoneyApp from your phone, anywhere

> **Status:** design + implementation handoff. Nothing in this document has been built yet.
> **Author intent:** a complete, self-contained brief so that a fresh Claude Code session
> (with *no* memory of the conversation that produced this file) can execute the whole thing
> end-to-end, and so the human owner knows exactly which steps are theirs.
> **Written:** 2026-07-15. **Target app:** this repository (`moneyapp`).
> **Chosen approach:** run the app on the owner's own always-on computer, reach it from the
> phone over a **private Tailscale network** (never the public internet), and make it
> **installable to the phone home screen as a PWA**.

---

## 0. How to use this document

If you are the **executing Claude Code session**: read Parts 1–3 first (context + the one
architectural decision everything hangs on), then implement Parts 4 in order (Tracks A→E),
then walk the human through Part 5. Part 6 (security) is not optional for a finance app —
treat its checklist as acceptance criteria. Part 8 is your troubleshooting map; skim it
*before* you start so the gotchas don't surprise you. Every code block in the Appendix is a
**reference implementation** — adapt it to the real code you find, don't paste blindly.

If you are the **human owner**: the steps that only you can do (create a Tailscale account,
install the Tailscale app on your phone, tap "Add to Home Screen") are collected in Part 5
and flagged **[YOU]** everywhere else. Everything flagged **[SESSION]** is code an agent
writes for you.

### The one-paragraph version

MoneyApp is a local web server, not a phone app, and it is *deliberately* locked to
`localhost` for privacy — it has no login because "only this machine can reach it" was the
entire security model. To use it on your phone we keep it running on your computer, put it on
a **Tailscale tailnet** (a private mesh VPN that only your own devices can join), and let
Tailscale expose it to your phone over real HTTPS at a stable address like
`https://mac-mini.your-tailnet.ts.net`. Your phone joins the same tailnet, so it reaches that
address from your home Wi-Fi, from cellular, from anywhere — but the public internet cannot.
Because Tailscale gives it a valid HTTPS certificate, the browser treats it as a secure
origin, which unlocks "Add to Home Screen," so it installs as an app icon and opens
full-screen like a native app. Three code changes make this work and feel right: (1) teach the
app's Host-header guard to trust the Tailscale hostname, (2) add the PWA manifest / icons /
viewport so it's installable and full-screen, (3) polish the touch experience. One optional
change adds a passcode as a second lock. Nothing is ever deployed to a cloud host; your data
never leaves your computer.

### Definition of done (acceptance criteria)

- [ ] From an **iPhone/Android on cellular data** (Wi-Fi off, not on the home network), opening
      the Tailscale HTTPS URL loads the live dashboard with the owner's real data.
- [ ] The app is **installed to the phone home screen** and launches **full-screen** (no browser
      chrome), with a proper icon and a themed status bar that respects the notch/home indicator.
- [ ] The **loopback binding is unchanged** — the Node process still listens only on
      `127.0.0.1`; Tailscale is the *only* thing bridging the phone to it. (No raw `0.0.0.0`
      LAN exposure unless the owner explicitly opts in — see Track A.)
- [ ] The app is **not reachable from the public internet** (verified: Tailscale *Serve*, not
      *Funnel*; confirmed with `tailscale serve status` showing tailnet-only).
- [ ] Every existing test still passes: `pnpm test` green, `pnpm build && pnpm e2e` green,
      including the 320px-width visual baselines that already exist.
- [ ] The server **survives a reboot** of the host computer and comes back automatically.
- [ ] No secret, no database, and no `.env*` file is committed. `git status` is clean of `data/`.

---

## 1. Context — what MoneyApp actually is (read this even if you think you know)

MoneyApp is a **local-first personal-finance and net-worth app**. The owner feeds it the
statement files their banks already provide (CSV, OFX/QFX, PDF); it reconstructs a two-year
history of net worth, spending, budgets, subscriptions, and forecasts. Every statement must
reconcile to the cent or it is quarantined. The whole thing runs on one machine against a
single SQLite file.

### 1.1 Stack (verified from the repo, 2026-07-15)

| Thing | Value | Why it matters here |
|---|---|---|
| Framework | **Next.js `^16.2.10`** (App Router, RSC + server actions) | Metadata/PWA APIs are the Next 16 flavor (`export const viewport`, `app/manifest.ts`, file-based icons). |
| Runtime | **React `^19`**, Node **≥ 20** (built on Node 25 / pnpm 10, macOS) | The always-on host must run Node ≥ 20; launchd/pm2 must point at the right Node. |
| DB | **`better-sqlite3` `^12`** — native module, synchronous, one file on disk | **This is why it can't go serverless** (Vercel/Netlify). It needs a persistent writable disk. Do not try. |
| Package manager | **pnpm 10** (`onlyBuiltDependencies` pre-approves the native build) | Use `pnpm`, not npm/yarn. |
| Server bind | `next dev/start -H 127.0.0.1` (see `package.json` scripts) | **Loopback only, on purpose.** We keep it this way. |
| Host-header guard | `src/middleware.ts` rejects any Host ≠ localhost (403) | **The #1 thing that will break a Tailscale setup.** See Track A. |
| Themes | light + dark, WCAG AA, token system in `src/app/globals.css` | PWA `theme_color` and status-bar styling must match these tokens. |
| Money | integer cents end-to-end | Not relevant to access, but don't "fix" anything you see here. |

### 1.2 Repo map (the parts you'll touch or reference)

```
package.json                      scripts: dev/start bind 127.0.0.1; build; test; e2e; demo:load
next.config.ts                    serverExternalPackages: ["better-sqlite3"]; 100mb server-action body
src/middleware.ts                 ⚠ DNS-rebinding Host allowlist — MUST be extended (Track A)
src/app/layout.tsx                root layout; has `metadata`, NO `viewport`, NO manifest link (Track B)
src/app/globals.css               design tokens (light/dark); add safe-area insets here (Track C)
src/components/shell/AppShell.tsx sticky top header + <MobileNav/> strip; the mobile chrome lives here
src/components/shell/MobileNav.tsx horizontal scrolling nav shown below `md` (Track C — consider bottom bar)
src/components/shell/SideNav.tsx   desktop sidebar (≥ md)
e2e/visual.spec.ts + -snapshots/  ⭐ ALREADY has 320px-width baselines → mobile layout mostly exists
(no public/ dir yet)              you will create public/icons/ for the PWA assets (Track B)
data/                             gitignored: the SQLite DB, statement originals, backups — NEVER commit
```

### 1.3 The privacy model you must not violate

The README states it plainly: *"Your data never leaves your machine. The app binds to
127.0.0.1, statements live in `data/` (gitignored), and the database is a file you can copy,
back up, or delete."* The only outbound calls the app makes are opt-in (Yahoo/Coinbase prices,
and optional Anthropic merchant classification which sends only normalized descriptions).

**Everything in this plan must preserve that.** The acceptance test "not reachable from the
public internet" is a hard gate, not a nicety. A personal-finance app with **no
authentication** (by design) must never be exposed to the open web. This single fact drives the
entire architecture below.

### 1.4 Three findings that will trip up a naive attempt

A previous investigation of the codebase surfaced these. They are the difference between "it
works in an hour" and "why do I keep getting 403 / why won't it install."

1. **`src/middleware.ts` is a hard Host-header allowlist.** It exists to stop DNS-rebinding
   attacks against the loopback server. It returns `403 Forbidden` for *any* Host that isn't
   `localhost` / `127.0.0.1` / `::1`. Tailscale forwards the *original* Host header
   (`something.ts.net`), so **out of the box, every request through Tailscale gets a 403.**
   Track A fixes this the right way (explicit allowlist, no wildcard).

2. **There is no `public/` directory and zero PWA assets.** No favicon, no icons, no manifest,
   and `layout.tsx` has no `viewport`/`themeColor` export. Installability is greenfield —
   Track B builds it from nothing.

3. **The app is already responsive down to 320px.** `e2e/visual.spec.ts-snapshots/` contains
   committed baselines at widths `320 / 768 / 1024 / 1440` in both themes (e.g.
   `transactions-review-dark-320`, `settings-light-320`, `accounts-dark-320`). So the *layout*
   already reflows for phones. Track C is therefore about **touch, standalone-mode chrome, safe
   areas, and native feel** — not a responsive rebuild. Scope it accordingly; don't rewrite
   pages that already reflow.

---

## 2. The architecture decision (why Tailscale-Serve-within-the-tailnet + PWA)

This is the load-bearing decision. Understand it before writing code.

### 2.1 The requirement

"Reach it from anywhere" = the phone must reach the app from cellular or any foreign Wi-Fi, not
just the home LAN. That means *something* has to bridge the public internet to a server that we
refuse to put on the public internet. The bridge must be **private, authenticated at the
network layer, and give us HTTPS** (HTTPS is required for PWA install + service workers; browsers
only treat `https://…` and `http://localhost` as "secure contexts").

### 2.2 The choice: Tailscale, using **Serve** (not Funnel)

**Tailscale** is a mesh VPN built on WireGuard. You install it on the host computer and on the
phone, sign both into the same account, and they join a private network (a "tailnet"). Devices
on the tailnet reach each other by stable names via **MagicDNS**
(`hostname.tailnet-name.ts.net`) over encrypted WireGuard tunnels — **from anywhere**, because
Tailscale handles NAT traversal. Nothing is exposed publicly; only your own signed-in devices
can join.

Tailscale has two ways to expose a local service:

- **`tailscale serve`** — publishes the service **only inside your tailnet**, over HTTPS, with a
  valid Let's Encrypt certificate for the `.ts.net` name. ✅ **This is what we use.**
- **`tailscale funnel`** — publishes the service to the **entire public internet**. ❌ **Never
  use this for MoneyApp.** It would put an unauthenticated finance app on the open web.

**Why Serve is the elegant fit for *this* app specifically:** `tailscale serve` runs a reverse
proxy on the host that terminates HTTPS on the tailnet interface and forwards to
`http://127.0.0.1:3000`. That means **we do not have to change the app's loopback binding at
all.** The Node process keeps listening only on `127.0.0.1` (preserving 1.3); Tailscale is the
sole bridge; and because the bridge is HTTPS with a real cert, PWA install works. It is hard to
design a cleaner topology for an app that is intentionally loopback-only.

### 2.3 The end-state topology

```
        [ Your phone, anywhere ]                         [ Your always-on computer ]
        Tailscale app: ON                                Tailscale: ON, MagicDNS + HTTPS enabled
        Safari/Chrome / installed PWA                    tailscale serve --bg 3000
                 │                                                    │
                 │  https://mac-mini.tnet.ts.net                      │  reverse-proxy
                 │  (WireGuard tunnel, encrypted,                     ▼
                 │   only your tailnet can route it)          http://127.0.0.1:3000
                 └───────────  Tailscale mesh  ───────────►    next start  (bound to loopback)
                                                                        │
                                                              better-sqlite3 → data/moneyapp.db
       Public internet: ✗ no route in.  Other devices on home Wi-Fi: ✗ (app never binds the LAN).
```

### 2.4 Alternatives considered and explicitly rejected

Document these so the executing session doesn't "helpfully" reach for one.

| Option | Verdict | Why |
|---|---|---|
| **Tailscale Funnel** (public) | ❌ Reject | Exposes an unauthenticated finance app to the whole internet. Categorically wrong here. |
| **Cloudflare Tunnel + Cloudflare Access** | ⚠ Viable but heavier | Also gives a private-ish HTTPS path with an auth layer, but it routes your finance traffic through Cloudflare's edge and needs an Access policy configured correctly or it's public. More moving parts, more ways to misconfigure into exposure. Tailscale keeps traffic peer-to-peer and private by default. |
| **ngrok / localtunnel** | ❌ Reject | Public URLs (often guessable), session-scoped, and a third party sees your traffic. Same exposure problem as Funnel. |
| **Deploy to Vercel/Netlify/Fly** | ❌ Impossible/wrong | `better-sqlite3` needs a persistent writable disk; serverless has none. And it would mean uploading your finances to a cloud host — the exact thing the app is built to avoid. |
| **Home-router port-forward + Dynamic DNS** | ❌ Reject | Punches a hole in your home firewall to an unauthenticated app; you'd be maintaining TLS and getting scanned by bots within minutes. |
| **Plain LAN only (bind `0.0.0.0`, use local IP)** | ⚠ Partial | Works on home Wi-Fi *only*, fails the "from anywhere" requirement, exposes the app to every device/guest on the LAN, and has **no HTTPS** so the PWA won't install. We support it as an *opt-in fallback* in Track A but it is not the recommendation. |
| **Generic WireGuard / OpenVPN by hand** | ⚠ Overkill | Tailscale *is* managed WireGuard with NAT traversal, MagicDNS, and auto-HTTPS. Rolling your own is strictly more work for the same result. |

---

## 3. What changes, and who does it

| Track | What | Who | Reversible? |
|---|---|---|---|
| **A** | Trust the Tailscale hostname in the Host-header guard | [SESSION] code | yes (revert middleware) |
| **B** | PWA: manifest, icons, viewport, apple-web-app, safe areas | [SESSION] code | yes |
| **C** | Mobile/touch polish (audit-driven) | [SESSION] code | yes |
| **D** | Optional passcode (defense-in-depth) | [SESSION] code | yes |
| **E** | Always-on: production build + process manager | [SESSION] setup + [YOU] approve | yes |
| **5** | Tailscale account, `up`, MagicDNS/HTTPS, `serve`, phone app, install | [YOU] mostly, [SESSION] assists | yes |

No change touches the ingestion pipeline, the database schema, the money math, or the
reconciliation logic. This is all shell/host/transport.

---

## 4. Implementation tracks (code)

> Reference implementations live in the Appendix. Paths and APIs are grounded in the repo as of
> 2026-07-15; verify against the actual files before editing (the code may have moved on).

### Track A — Un-break remote hosts (the critical one)

**Problem.** `src/middleware.ts` allows only `localhost`/`127.0.0.1`/`::1`. Through Tailscale the
Host header is `hostname.tailnet.ts.net`, so **every request 403s**. This is the single most
likely reason a first attempt "doesn't work."

**Fix, done safely.** Do **not** replace the allowlist with a wildcard — that reopens the
DNS-rebinding hole the middleware exists to close. Instead, **union the built-in loopback set
with an explicit, deployment-provided allowlist** read from an env var, e.g.
`MONEYAPP_TRUSTED_HOSTS="mac-mini.tnet.ts.net"` (comma-separated to allow more than one). See
Appendix A.1 for the exact patch.

**⚠ Edge-runtime gotcha you must document and honor.** Next.js middleware runs on the **Edge
runtime**, where `process.env.MONEYAPP_TRUSTED_HOSTS` (a literal key) is **inlined at build
time**, not read at runtime. Therefore the env var **must be set before `pnpm build`**, and the
app **must be rebuilt** if the trusted host changes. The always-on runbook (Track E) sets it in
the build environment. If you would rather it be a pure runtime value, the alternative is to opt
the middleware into the Node.js runtime (`export const config = { runtime: "nodejs" }` — a Next
16 capability); pick one approach and state it in the code comment so the next person isn't
surprised. Primary recommendation: **build-time env**, it's the least magic.

**Host normalization.** Keep the existing IPv6-bracket handling. Compare **case-insensitively**
and strip the port (`hostname.split(":")[0]`), exactly as the current code does. `.ts.net`
names are lowercase; lowercase the incoming host before the set lookup.

**Do the icons/manifest still pass the guard?** Yes — the middleware filters by Host, not by
path, so once the ts.net host is trusted, `/manifest.webmanifest` and `/icons/*` served from
that host pass too. (If you later add passcode auth in Track D, *that* filter must exempt those
paths — see Track D.)

**Opt-in LAN fallback (only if the owner asks).** If the owner explicitly wants raw home-Wi-Fi
access without Tailscale, they can additionally: (1) run the server with `-H 0.0.0.0` (add a
`start:lan` script), (2) add their machine's LAN IP/hostname to `MONEYAPP_TRUSTED_HOSTS`, and
(3) accept that there is **no HTTPS** (so no PWA install) and that **every device on the LAN can
read their finances**. Document these trade-offs at the point of change; do not enable it by
default.

**Acceptance for Track A:** with `MONEYAPP_TRUSTED_HOSTS` set at build time and Tailscale Serve
running, loading `https://<name>.ts.net/` returns the app (200), not a 403. Loading it with a
*wrong* Host still 403s (guard intact).

### Track B — PWA installability (manifest, icons, viewport, standalone chrome)

Goal: tapping the browser's "Add to Home Screen" installs MoneyApp as an icon that launches
**full-screen** (no address bar), with a correct icon and a status bar themed to match the app.

**B.1 — Web app manifest.** Create `src/app/manifest.ts` exporting a
`MetadataRoute.Manifest` (Next 16 file convention → served at `/manifest.webmanifest`). Fields:
`name`, `short_name: "MoneyApp"`, `description`, `start_url: "/"`, `scope: "/"`,
`display: "standalone"`, `background_color`/`theme_color` matching the `--surface` token,
and an `icons` array (192, 512, and a 512 **maskable**). Reference: Appendix A.2.

**B.2 — Icons.** None exist. Create `public/icons/` (the `public/` dir itself doesn't exist yet —
create it) with at least:
- `icon-192.png` (192×192), `icon-512.png` (512×512) — `purpose: "any"`.
- `icon-maskable-512.png` (512×512) with the glyph inside the **central 80% safe zone** —
  `purpose: "maskable"` (Android adaptive icons crop to a circle/squircle).
- Plus the Next file-based icons for the tab/apple touch icon: `src/app/icon.png` (any square,
  e.g. 512) auto-wires `<link rel="icon">`, and `src/app/apple-icon.png` (**180×180**)
  auto-wires `<link rel="apple-touch-icon">` (iOS home-screen icon).

  The app has no logo asset; its visual identity is the **green accent dot + "MoneyApp"
  wordmark** (see `AppShell.tsx`: `size-2.5 rounded-full bg-accent`). A clean, on-brand icon is
  a solid rounded tile in the accent green (`--accent` ≈ deep teal-green) with a single centered
  glyph — a coin, a "$", or the accent dot over a subtle net-worth line. Appendix A.3 has a
  minimal SVG you can rasterize to all sizes with `sharp` (already a dependency) or any tool.
  Keep it simple; this is not a branding project.

**B.3 — Viewport + theme color + Apple web-app meta.** `src/app/layout.tsx` currently exports
only `metadata` (title/description). Add:
- `export const viewport: Viewport` with `themeColor` (light/dark via `media`), `width:
  "device-width"`, `initialScale: 1`, and **`viewportFit: "cover"`** (required for edge-to-edge
  + safe-area insets on notched phones).
- Extend `metadata` with `manifest: "/manifest.webmanifest"`, `applicationName: "MoneyApp"`,
  and **`appleWebApp: { capable: true, statusBarStyle: "default", title: "MoneyApp" }`** (emits
  the `apple-mobile-web-app-*` tags iOS uses for standalone launch + status bar). Reference:
  Appendix A.4.

**B.4 — Safe-area insets (notch / home indicator).** In standalone mode the app draws under the
status bar and home indicator. The sticky header in `AppShell.tsx` and the `MobileNav` strip
must pad for the insets or content hides behind the notch. Add `env(safe-area-inset-*)` padding
(gated behind `@supports`) in `globals.css` and apply to the header / bottom chrome. Reference:
Appendix A.5. Test on a real notched device — the simulator lies about insets.

**B.5 — Service worker: optional, and dangerous if done wrong.** Installability itself does
**not** require a service worker on iOS (a manifest + apple-touch-icon is enough to add to home
screen and launch standalone). Chrome/Android's *automatic* install prompt historically wants a
SW with a fetch handler, but the app is still installable via the browser menu without one.

**If you add a SW, obey these rules or you will show the owner stale financial numbers:**
- **Never** cache POST / server-action responses or any data/HTML response as authoritative.
  Use **network-first** for navigations; only fall back to a cached **offline page** when the
  network is truly gone.
- Only precache **static assets** (icons, fonts) and a minimal `/offline` route.
- Version the cache and clean old caches on `activate`.
- Register it only in production and only from a secure origin (it won't register over plain
  `http://<lan-ip>`; it *will* over the Tailscale HTTPS origin). Reference: Appendix A.6.

Recommendation: **ship without a service worker first.** Get install + standalone + safe areas
working (which is all iOS needs), verify, and only add a SW later if the owner specifically
wants an offline splash. The freshness hazard for a finance app outweighs the marginal polish.

**Acceptance for Track B:** on the phone, over the Tailscale HTTPS URL, the browser offers "Add
to Home Screen"; the installed icon is correct; launching it is full-screen with no browser bar;
the status bar and content clear the notch and home indicator in both themes.

### Track C — Mobile / touch polish (audit-driven, not a rewrite)

Remember finding 1.4.3: layout already reflows to 320px. So this track is a **targeted audit**,
not a redesign. Methodology and the specific things to check:

**C.1 — Drive it like a phone and fix what you find.** Add a mobile device project to
`playwright.config.ts` (e.g. `devices["iPhone 15 Pro"]`, which brings a real mobile UA, touch,
and DPR) and screenshot every route, in both themes. Reference: Appendix A.7. Use this to *find*
issues; deciding whether to add 30+ new **gated** baselines is a maintenance call for the owner
(the existing suite is width-based and darwin-pinned — adding a device project may produce
noisy diffs). Default: run it as an **exploratory, non-gating** pass, capture screenshots, fix,
and only promote to baselines if the owner wants them.

**C.2 — The known touch-specific risks to verify on every surface.** (Layout reflow is done;
these are the phone-only concerns.)
- **Tap targets ≥ 44×44px.** The `MobileNav` pills, icon buttons, chart legends, category
  chips, and inline-edit affordances (`InlineEditableText`/`InlineEditableAmount`, referenced in
  `docs/future-ideas.md`) are the usual offenders.
- **Input font-size ≥ 16px.** iOS Safari **auto-zooms** when you focus an input smaller than
  16px. Any `text-sm`/`text-xs` on an actual `<input>`/`<textarea>` (filters bar, amount edits,
  settings, the ⌘K field) will make the page jump on focus. Bump those inputs (not the whole UI)
  to 16px on touch.
- **Wide tables.** The Transactions ledger (`TransactionsLedger`), the Imports ledger, and any
  holdings/spending tables are the widest surfaces. At 320px they already reflow in the
  baselines — confirm they either horizontal-scroll inside their own container (never the page
  body) or collapse to a stacked/card layout, and that nothing forces the `<body>` to scroll
  sideways.
- **Charts (Recharts).** Net-worth chart (`NetWorthChartPanel`), spending stacks, budget bars.
  Confirm they use a responsive container and are legible/touchable at phone width; hover-only
  tooltips need a tap equivalent. The dashboard's chart **focus-mode dialog** (a shared-element
  morph, per the git log) should open and be dismissible by touch.
- **The Imports flow on a phone.** This is the one genuinely desktop-shaped interaction:
  statements are added by **drag-and-drop**, which **does not exist on touch**. Verify the
  Imports page also offers a visible **"Choose files"** control backed by a normal
  `<input type="file" multiple>` that accepts `.csv,.ofx,.qfx,.pdf`. On iOS this lets the user
  pick from the Files app / iCloud Drive / email attachments. Note the 100MB server-action body
  limit in `next.config.ts` — a big multi-PDF drop from a phone still needs to fit. If there is
  no tap-to-upload path today, adding one is the single highest-value mobile fix in this track.
- **The command palette (⌘K).** There's no keyboard on a phone. Ensure there is a **visible,
  tappable** entry point to search/navigation on mobile (a search icon in the header), or accept
  that ⌘K is desktop-only and that the `MobileNav` covers navigation. Don't leave a
  keyboard-only primary action with no touch equivalent.
- **Hover states.** Anything that reveals actions only on `:hover` (row action buttons, delete
  affordances) needs a touch-reachable equivalent (always-visible on touch, or via a tap/long-press).
- **Sheets / popovers / toasts.** Confirm bottom sheets and popovers (`Popover.tsx` does its own
  viewport-edge positioning) sit correctly above the on-screen keyboard and within safe areas,
  and that Escape-less dismissal works by tap-outside on touch.

**C.3 — Consider a bottom tab bar for standalone mode (optional, nice).** The current
`MobileNav` is a horizontal-scrolling strip under the header. In an installed full-screen PWA, a
**fixed bottom tab bar** (thumb-reachable, safe-area-padded) feels far more native. This is an
enhancement, not a requirement — propose it to the owner; if yes, it's a small, contained change
in `AppShell.tsx` + a new component, reusing `NAV_ITEMS` and the existing icon set (`Icon.tsx`).

**Acceptance for Track C:** every route is usable one-handed on a real phone; no sideways page
scroll; inputs don't trigger zoom; imports can be added without a mouse; charts are legible and
touchable; nothing important is hover-only.

### Track D — Optional passcode (defense-in-depth)

**Do you need it?** The app has **no authentication** because loopback was the moat. On a
tailnet, the moat becomes "only my signed-in devices," which is strong. A passcode is
**defense-in-depth**, not the primary control. It matters if: the owner shares a computer that's
on the tailnet, has other people's devices on their tailnet, or just wants a second lock on an
unlocked phone. Recommended, not mandatory. Confirm with the owner (Part 10).

**How, without fighting the Edge runtime.** The cleanest implementation keeps the *secret* out
of Edge middleware (where env is build-time-inlined and secrets are awkward):
- Add a server action `unlock(formData)` that constant-time-compares the submitted code to
  `process.env.MONEYAPP_PASSCODE` (runtime env, read in Node during the action) and, on success,
  sets a signed, **HttpOnly**, `Secure`, `SameSite=Lax` cookie (e.g. an HMAC of a fixed marker
  with a server secret, so it can't be forged).
- Gate access by checking that cookie in the root layout (or a thin `(protected)` layout group);
  if absent/invalid, render a minimal `/unlock` screen instead of the app.
- **Exempt** `/unlock`, `/manifest.webmanifest`, `/icons/*`, and the Next static assets from the
  gate, or the lock screen can't show its own icon and the PWA can't read its manifest.
- Rate-limit attempts (even a simple in-memory throttle) and never log the code.

Keep it proportionate — this is a second factor behind Tailscale, not a full auth system. Do not
add user accounts, OAuth, or a database table for this. Reference sketch: Appendix A.8.

**Acceptance for Track D (if built):** a fresh device on the tailnet must enter the passcode
before seeing any financial data; the manifest/icons still load on the lock screen; a wrong code
never reveals data and is throttled.

### Track E — Always-on: production build + process manager

The phone can only reach the app when the host process is running. `pnpm dev` is not for this —
use a **production build** (`pnpm build` → `pnpm start`, which binds `127.0.0.1`). Then keep it
alive across crashes and reboots.

**E.1 — Build with the right environment.** Because of the Track A edge-inlining gotcha, set the
trusted host **before building**:
```
export MONEYAPP_TRUSTED_HOSTS="<hostname>.<tailnet>.ts.net"
export MONEYAPP_DB_PATH="/Users/<you>/moneyapp/data/moneyapp.db"   # the REAL db, or demo.db to trial
# export ANTHROPIC_API_KEY=...   # optional
pnpm install
pnpm build
```

**E.2 — Keep it running. Two options; pick one:**
- **launchd (native macOS, best for always-on/boot).** A `~/Library/LaunchAgents/*.plist` with
  `RunAtLoad` + `KeepAlive`, absolute paths to `node`/`pnpm` (launchd has a minimal PATH — the
  #1 launchd failure), `WorkingDirectory` at the repo, and the env vars from E.1. Reference:
  Appendix A.9. Load with `launchctl load`.
- **pm2 (simplest cross-platform).** `pm2 start pnpm --name moneyapp -- start`, then
  `pm2 save` and `pm2 startup` (follow the printed sudo command) so it survives reboot.
  Reference: Appendix A.10.

**E.3 — Data & backups.** Point `MONEYAPP_DB_PATH` at the owner's real database (or a throwaway
`data/demo.db` built with `MONEYAPP_DB_PATH=data/demo.db pnpm demo:load` to trial the whole
thing on synthetic data before trusting it with real finances). The app takes crash-safe SQLite
backups; ensure the backups dir is writable by the launchd/pm2 user. Never commit any of `data/`.

**E.4 — Updates.** When code changes: `git pull` (or edit) → `pnpm install` if deps changed →
`pnpm build` (with the env from E.1) → restart the process (`launchctl kickstart -k …` or
`pm2 restart moneyapp`). Document this one-liner for the owner.

**Acceptance for Track E:** kill the process → it respawns; reboot the machine → the app is back
without manual steps; `curl -s http://127.0.0.1:3000` returns HTML.

---

## 5. The Tailscale + phone runbook (mostly [YOU], with [SESSION] assist)

This is the transport layer. Some of it only the human can do (accounts, phone apps, tapping
"install"). The executing session should walk the owner through it and verify each step.

### 5.1 On the always-on computer (the host)

1. **[YOU] Create a Tailscale account** at tailscale.com (free personal tier is plenty) — sign in
   with Google/GitHub/etc. This defines your tailnet.
2. **[YOU] Install Tailscale on the host.** macOS: the standalone/open-source **CLI build**
   (`brew install tailscale` for the `tailscale`/`tailscaled` CLI, or the app) is easiest for
   `tailscale serve`. The Mac App Store build sandboxes the CLI differently; if `tailscale` isn't
   on your PATH, it may live at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` — alias it.
3. **[YOU] Join the tailnet:** `tailscale up`. Authenticate in the browser. Confirm with
   `tailscale status` (you'll see the host with a `100.x.y.z` tailnet IP).
4. **[YOU] In the Tailscale admin console → DNS:** enable **MagicDNS**, and enable **HTTPS
   Certificates** (both toggles). MagicDNS gives the stable `hostname.tailnet.ts.net` name; HTTPS
   lets Serve provision a real Let's Encrypt cert for it. Note your host's full MagicDNS name —
   **this is the value for `MONEYAPP_TRUSTED_HOSTS`** in Tracks A/E.
5. **[SESSION or YOU] Build the app with that hostname** (Track E.1), then start it (Track E.2),
   and confirm `http://127.0.0.1:3000` serves locally.
6. **[YOU] Publish it to the tailnet over HTTPS (Serve, not Funnel):**
   ```
   tailscale serve --bg 3000
   ```
   This proxies `https://<hostname>.<tailnet>.ts.net` → `http://127.0.0.1:3000` and persists in
   the background across reboots. Verify with `tailscale serve status` — it must show a tailnet
   HTTPS endpoint and **must not** mention Funnel/public. (First HTTPS request may take a few
   seconds while the cert provisions.) Exact flags vary by version — check `tailscale serve
   --help`; the intent is "background HTTPS proxy of local port 3000, tailnet-only."
7. **Verify from the host browser:** open `https://<hostname>.<tailnet>.ts.net`. You should get
   the app over HTTPS (padlock, valid cert) — **not a 403** (proves Track A) and **not a cert
   warning** (proves HTTPS is live).

### 5.2 On the phone

8. **[YOU] Install the Tailscale app** (iOS App Store / Google Play), sign into the **same
   account**, and toggle it **on**. Your phone is now on the tailnet — from Wi-Fi *and* cellular.
9. **[YOU] Open `https://<hostname>.<tailnet>.ts.net`** in Safari (iOS) or Chrome (Android). It
   should load the app. Turn **Wi-Fi off** and reload over cellular to prove "from anywhere."
10. **[YOU] Install to home screen:**
    - **iOS Safari:** Share → **Add to Home Screen** → Add. Launch it from the new icon — it opens
      full-screen.
    - **Android Chrome:** menu (⋮) → **Install app** / **Add to Home screen**.
11. **[YOU] (if Track D built) Enter the passcode** once on the new device.

### 5.3 Optional hardening on the tailnet

12. **[YOU] Tighten Tailscale ACLs** (admin console → Access Controls). For a single user, the
    default (all your own devices can reach each other) is fine. If you ever add other users/devices
    to your tailnet, write an ACL so only your phone + laptop can reach the host's port 3000.
13. **[YOU] Enable device approval / key expiry** as you prefer; consider **Tailscale Lock** if
    you're advanced. Not required for a personal single-user setup.

---

## 6. Security hardening checklist (this is a finance app — treat as gating)

- [ ] **Serve, never Funnel.** Re-verify `tailscale serve status` shows tailnet-only, no public
      Funnel. This is the difference between "private" and "your bank statements on the internet."
- [ ] **Loopback binding preserved.** The Node process still binds `127.0.0.1`. Confirm with
      `lsof -iTCP -sTCP:LISTEN | grep 3000` (or `ss -ltnp`) that it is **not** on `0.0.0.0`
      unless the owner explicitly chose the LAN fallback and accepted its risks.
- [ ] **Host allowlist is explicit, not wildcard.** `MONEYAPP_TRUSTED_HOSTS` lists exact names;
      the DNS-rebinding defense still 403s unknown hosts.
- [ ] **HTTPS everywhere the phone touches.** Access is via the `.ts.net` HTTPS URL, not a plain
      `http://` LAN IP. (Required anyway for PWA/SW.)
- [ ] **No secrets or data in git.** `.env*` (except `.env.example`) and all of `data/` are
      gitignored; `git status` is clean; the PWA icons in `public/` are the only new committed
      static assets. Never commit `MONEYAPP_PASSCODE` or any cookie-signing secret — they live in
      the process env / launchd plist / pm2 ecosystem file (and that file, if it holds secrets,
      is gitignored).
- [ ] **Passcode (if built) is constant-time compared, HttpOnly/Secure cookie, rate-limited,
      never logged.**
- [ ] **Service worker (if built) never serves stale financial data** — network-first, offline
      page only, versioned caches.
- [ ] **Tailscale account itself is protected** — the tailnet is only as safe as that login. Turn
      on 2FA for the identity provider you used.
- [ ] **Phone lock screen** — the installed PWA is only as private as the phone; a device
      passcode/biometric is the real last line. (Worth stating to the owner.)
- [ ] **Anthropic key (if set)** is optional and only sends normalized merchant descriptions;
      nothing about remote access changes that. Keep the monthly cap in Settings.

---

## 7. Verification / acceptance test matrix

Run these top to bottom; each proves a specific claim.

| # | Test | Proves | Pass = |
|---|---|---|---|
| 1 | `pnpm test` | no regression in logic | green |
| 2 | `pnpm build && pnpm e2e` | UI + 320px baselines intact | green |
| 3 | Host: `curl -s http://127.0.0.1:3000 \| head` | server up on loopback | HTML |
| 4 | Host: `lsof -iTCP -sTCP:LISTEN \| grep 3000` | **not** on 0.0.0.0 | loopback only |
| 5 | Host browser: open `https://<name>.ts.net` | Track A + HTTPS | app loads, padlock, no 403 |
| 6 | Bad Host: `curl -H 'Host: evil.com' http://127.0.0.1:3000` | guard intact | 403 |
| 7 | Phone on **Wi-Fi**: open the ts.net URL | reachable on LAN via tailnet | app loads |
| 8 | Phone on **cellular** (Wi-Fi off): reload | "from anywhere" | app loads |
| 9 | Phone: Add to Home Screen, launch icon | PWA install + standalone | full-screen, correct icon |
| 10 | Phone: rotate / notch / home indicator | safe areas | no clipped content, themed status bar |
| 11 | Phone: add a statement via **Choose files** | imports work sans mouse | file imports + reconciles |
| 12 | Phone: focus an input | no iOS auto-zoom | page doesn't jump |
| 13 | Public check: from a device **off** the tailnet, open the ts.net URL | privacy | **fails to connect** (no public route) |
| 14 | Kill the server process | Track E KeepAlive | respawns |
| 15 | Reboot the host | Track E boot + persistent Serve | app reachable again with no manual steps |
| 16 | (if Track D) fresh device, no cookie | passcode gate | lock screen, no data until code entered |

---

## 8. Gotchas & troubleshooting (skim before you start)

- **403 Forbidden through Tailscale** → Track A not done, or `MONEYAPP_TRUSTED_HOSTS` was set at
  runtime but not at **build** time (edge inlining). Rebuild with the env exported. Confirm the
  exact Host the app receives (log it temporarily) matches the allowlist, lowercased.
- **Cert warning / `https` won't load** → HTTPS Certificates not enabled in the admin console, or
  the first cert provision hasn't finished (give it a few seconds and retry; check
  `tailscale serve status`).
- **"Add to Home Screen" missing or app opens in a browser tab** → no manifest, missing icons,
  `display` not `standalone`, or you're on a non-secure origin (a plain `http://` LAN IP won't
  install — must be the ts.net HTTPS URL or `localhost`). On iOS, also ensure `apple-icon.png`
  and `appleWebApp.capable` are present.
- **Content hidden under the notch / home indicator** → missing `viewportFit: "cover"` and/or
  `env(safe-area-inset-*)` padding (Track B.4).
- **Page jumps/zooms when tapping a field** → input font-size < 16px on iOS (Track C.2).
- **Sideways page scroll on phone** → a wide table/chart isn't inside its own
  `overflow-x:auto` container; the body must never scroll horizontally.
- **launchd starts nothing / exits immediately** → wrong `node`/`pnpm` path or empty PATH in the
  plist, wrong `WorkingDirectory`, or missing env. Check the plist's `StandardErrorPath` log.
- **Stale numbers after an import** → a service worker cached data. Don't cache data (Track B.5).
  Bump the cache version and re-`activate`, or ship without a SW.
- **`allowedDevOrigins` warning** → only relevant if the owner insists on running `pnpm dev`
  (not `start`) and hitting it from the ts.net/LAN origin; add the origin to
  `nextConfig.allowedDevOrigins`. The recommended production `pnpm start` path doesn't need it.
- **Tailscale `serve` command shape differs** → the CLI syntax has changed across versions;
  `tailscale serve --help` is authoritative. The invariant: background, HTTPS, proxy local
  :3000, tailnet-scoped (not Funnel).
- **It works at home but not on cellular** → the phone's Tailscale toggle is off, or a corporate/
  captive network blocks WireGuard; Tailscale falls back to its DERP relays automatically, but
  confirm the toggle is on and the phone shows "Connected."
- **Two hosts / hostname changed** → MagicDNS names follow the machine name; if you rename the
  host or move to a new machine, update `MONEYAPP_TRUSTED_HOSTS` **and rebuild**, and re-run
  `tailscale serve`.

---

## 9. Suggested commit / PR breakdown for the executing session

Keep changes reviewable and reversible. Suggested sequence (each builds + tests green before the
next):

1. `feat(mobile): trust configured hosts in the loopback guard` — Track A only (middleware +
   env doc). Smallest, highest-risk-if-wrong; land and verify first.
2. `feat(pwa): manifest, icons, viewport, apple web-app, safe areas` — Track B.
3. `feat(mobile): touch polish — tap targets, input zoom, file-picker imports, [bottom nav]` —
   Track C (may be several commits; imports-file-picker is the headline).
4. `feat(security): optional passcode gate behind Tailscale` — Track D (only if owner opts in).
5. `docs(ops): always-on runbook (launchd/pm2) + Tailscale serve` — Track E + Part 5, as docs
   and example config files (the launchd plist / pm2 ecosystem file as `.example`, since the real
   ones hold machine-specific paths and possibly secrets).

Open the PR as a **draft**. Do **not** commit any real `data/`, `.env*`, plist/ecosystem file
containing secrets, or the Tailscale hostname if the owner considers it sensitive (prefer to keep
it in local env, referenced by name in docs).

---

## 10. Open decisions to confirm with the owner before/while building

1. **Which computer is the always-on host?** (Mac mini / laptop that stays on? The app is only
   reachable when this machine is awake and running the process. A sleeping laptop = no access.)
2. **Passcode (Track D): yes or no?** Recommended as a second lock; adds a small login step on
   each new device. Tailscale alone already restricts to your devices.
3. **Real data or demo first?** Strongly suggest standing the whole path up on `data/demo.db`
   (`pnpm demo:load`) before pointing it at real finances.
4. **Bottom tab bar (Track C.3)?** Nicer native feel in standalone mode; small extra change.
5. **Service worker / offline page?** Default recommendation: skip initially (freshness hazard).
   Add later only if you want an offline splash.
6. **Phone OS?** (iOS vs Android changes the install taps and a couple of meta details; the plan
   covers both, but knowing narrows the runbook.)
7. **LAN fallback?** Do you also want raw home-Wi-Fi access without Tailscale (worse security, no
   PWA install), or is Tailscale-only fine? Recommend Tailscale-only.

---

## Appendix A — Reference implementations

> Adapt to the real code. APIs/paths verified against the repo on 2026-07-15 (Next 16, React 19).
> Color hexes are **approximations** of the OKLCH tokens in `globals.css` — derive exact values
> from `--surface` / `--accent` if you want a pixel match.

### A.1 — Track A: extend the Host allowlist (`src/middleware.ts`)

```ts
import { NextResponse, type NextRequest } from "next/server";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Explicit, per-deployment allowlist. NOTE: middleware runs on the Edge runtime,
// so this literal `process.env` read is INLINED AT BUILD TIME — set
// MONEYAPP_TRUSTED_HOSTS before `pnpm build`, and rebuild if it changes.
// Comma-separated, e.g. "mac-mini.tailnet-name.ts.net,192.168.1.50:3000".
const TRUSTED = new Set(
  (process.env.MONEYAPP_TRUSTED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * DNS-rebinding defense (unchanged intent): only known hosts may drive this
 * unauthenticated server. Loopback is always allowed; additional hosts (e.g. a
 * Tailscale MagicDNS name) come from MONEYAPP_TRUSTED_HOSTS. No wildcards.
 */
export function middleware(request: NextRequest): NextResponse {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0]!;
  if (LOOPBACK.has(hostname) || TRUSTED.has(hostname) || TRUSTED.has(host)) {
    return NextResponse.next();
  }
  return new NextResponse("Forbidden: host not allowed", { status: 403 });
}
```
(Match on both bare `hostname` and full `host:port` so a `host:port` entry also works for the
LAN fallback.)

### A.2 — Track B: web app manifest (`src/app/manifest.ts`)

```ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "MoneyApp",
    short_name: "MoneyApp",
    description: "Local-first personal finance and net worth",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f8f7f4", // ≈ --surface (light)
    theme_color: "#f8f7f4",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
```

### A.3 — Track B: a minimal on-brand icon (SVG source to rasterize)

```svg
<!-- 512x512 base. Accent-green rounded tile, centered glyph in the ~80% safe zone
     for maskable. Rasterize to 192/512 + a 180 apple-icon with `sharp`. -->
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#2f7d64"/>            <!-- ≈ --accent -->
  <circle cx="256" cy="200" r="34" fill="#f4fbf8"/>                    <!-- the accent dot -->
  <path d="M120 320 L210 260 L300 300 L392 210" fill="none"
        stroke="#f4fbf8" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```
Rasterize (sharp is already a dependency):
```
# pseudocode for a one-off script, not app code
sharp(svg).resize(512).png().toFile('public/icons/icon-512.png')
sharp(svg).resize(192).png().toFile('public/icons/icon-192.png')
sharp(svg).resize(180).png().toFile('src/app/apple-icon.png')
# maskable: same art but ensure the glyph sits within the central 80%
```

### A.4 — Track B: viewport + metadata (`src/app/layout.tsx`)

```ts
import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f7f4" }, // ≈ --surface light
    { media: "(prefers-color-scheme: dark)", color: "#1c1813" },  // ≈ --surface dark
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // required for safe-area insets on notched phones
};

export const metadata: Metadata = {
  title: { default: "MoneyApp", template: "%s — MoneyApp" },
  description: "Local-first personal finance and net worth",
  applicationName: "MoneyApp",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "MoneyApp" },
};
```

### A.5 — Track B: safe-area insets (`src/app/globals.css` + shell)

```css
/* Only pay the inset where the platform provides it. */
@supports (padding: max(0px)) {
  .safe-top    { padding-top: max(0.5rem, env(safe-area-inset-top)); }
  .safe-bottom { padding-bottom: max(0.5rem, env(safe-area-inset-bottom)); }
  .safe-x      { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
}
```
Apply `safe-top`/`safe-x` to the sticky `<header>` in `AppShell.tsx`, and `safe-bottom` to any
fixed bottom nav you add (Track C.3).

### A.6 — Track B.5 (OPTIONAL): minimal, freshness-safe service worker (`public/sw.js`)

```js
const CACHE = "moneyapp-shell-v1";
const OFFLINE = "/offline";
const PRECACHE = [OFFLINE]; // + static icon/font URLs if desired

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;          // never touch mutations / server actions
  if (request.mode === "navigate") {
    // network-first: always try live data; offline page only when truly offline
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
  }
  // (static assets could be cache-first here, but keep it minimal to avoid stale data)
});
```
Register only in production from a secure origin, e.g. a tiny client component mounted in the
layout:
```tsx
"use client";
import { useEffect } from "react";
export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
```
Add an `/offline` route with a static "You're offline — reconnect to see live numbers" page.

### A.7 — Track C: Playwright mobile project (`playwright.config.ts`)

```ts
projects: [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "iphone",   use: { ...devices["iPhone 15 Pro"] } }, // real mobile UA, touch, DPR
],
```
Use it to screenshot every route for the audit. Treat as **exploratory/non-gating** first; only
promote to committed baselines if the owner wants a mobile visual gate (the existing suite is
width-based and darwin-pinned — a device project may diff noisily).

### A.8 — Track D (OPTIONAL): passcode gate sketch

```ts
// unlock action (Node runtime — reads runtime env, sets HttpOnly cookie)
"use server";
import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.MONEYAPP_COOKIE_SECRET ?? "";       // runtime env, never committed
const PASSCODE = process.env.MONEYAPP_PASSCODE ?? "";
const token = () => createHmac("sha256", SECRET).update("moneyapp-unlocked").digest("hex");

export async function unlock(formData: FormData) {
  const given = String(formData.get("code") ?? "");
  const a = Buffer.from(given), b = Buffer.from(PASSCODE);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return { error: "Wrong code" };                     // + throttle attempts
  (await cookies()).set("ma_unlock", token(), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
}
```
Gate in the root layout by comparing the `ma_unlock` cookie to `token()`; if absent/invalid,
render the `/unlock` form instead of children. Exempt `/unlock`, `/manifest.webmanifest`,
`/icons/*`, and static assets so the lock screen and PWA install still work.

### A.9 — Track E: launchd LaunchAgent (`~/Library/LaunchAgents/com.moneyapp.server.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.moneyapp.server</string>
  <key>WorkingDirectory</key><string>/Users/YOU/moneyapp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/pnpm</string>   <!-- absolute path; `which pnpm` -->
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MONEYAPP_DB_PATH</key><string>/Users/YOU/moneyapp/data/moneyapp.db</string>
    <key>MONEYAPP_TRUSTED_HOSTS</key><string>mac-mini.your-tailnet.ts.net</string>
    <!-- Secrets (MONEYAPP_PASSCODE, MONEYAPP_COOKIE_SECRET, ANTHROPIC_API_KEY) go here too;
         this file is machine-local and must NOT be committed. -->
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/moneyapp.out.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/moneyapp.err.log</string>
</dict></plist>
```
```
launchctl load ~/Library/LaunchAgents/com.moneyapp.server.plist
launchctl kickstart -k gui/$(id -u)/com.moneyapp.server   # restart after a rebuild
```
Remember: `MONEYAPP_TRUSTED_HOSTS` is inlined at **build** time for middleware, so it must also
be present when you run `pnpm build` — the plist value covers the running `pnpm start`.

### A.10 — Track E: pm2 alternative

```
pnpm build                                  # with the E.1 env exported
pm2 start pnpm --name moneyapp -- start
pm2 save
pm2 startup                                 # run the sudo line it prints, to survive reboot
# restart after a rebuild:
pm2 restart moneyapp --update-env
```
For env with pm2, prefer an `ecosystem.config.cjs` (gitignored if it holds secrets) that sets
`env: { MONEYAPP_DB_PATH, MONEYAPP_TRUSTED_HOSTS, ... }`.

---

## Appendix B — Environment variables reference

| Var | Where set | Purpose | Notes |
|---|---|---|---|
| `MONEYAPP_TRUSTED_HOSTS` | **build + run** | Track A allowlist (comma-sep hostnames / host:port) | Edge-inlined → set before `pnpm build`; rebuild on change |
| `MONEYAPP_DB_PATH` | run | which SQLite file to serve | point at real db or `data/demo.db` |
| `MONEYAPP_FAKE_PRICES` | build/run | deterministic synthetic prices | used by `demo:load` |
| `ANTHROPIC_API_KEY` | run | optional merchant classification | already supported; monthly-capped in Settings |
| `MONEYAPP_PASSCODE` | run | Track D passcode (optional) | secret; never commit |
| `MONEYAPP_COOKIE_SECRET` | run | Track D cookie HMAC key (optional) | secret; never commit |
| `MONEYAPP_BACKUPS_DIR` / `MONEYAPP_ORIGINALS_DIR` | run | data locations (seen in e2e) | ensure writable by the service user |

## Appendix C — Glossary

- **Tailnet** — your private Tailscale network; only devices signed into your account join it.
- **MagicDNS** — Tailscale's automatic DNS giving each device a `name.tailnet.ts.net` address.
- **Tailscale Serve** — reverse-proxy a local port over HTTPS **to your tailnet only** (private).
- **Tailscale Funnel** — the same but **to the public internet** (❌ never for this app).
- **PWA (Progressive Web App)** — a website that, given a manifest + secure origin, can be
  installed to the home screen and run full-screen like a native app.
- **Maskable icon** — an icon whose art stays inside a central safe zone so Android can crop it to
  any shape without clipping the glyph.
- **Secure context** — an origin the browser trusts for install/service-worker APIs: `https://…`
  or `http://localhost`. A plain `http://<lan-ip>` is **not** one — hence the Tailscale HTTPS URL.
- **Safe-area insets** — the CSS `env(safe-area-inset-*)` values describing the notch / rounded
  corners / home indicator that full-screen content must pad around.
- **Loopback (127.0.0.1)** — the local-only network interface; MoneyApp binds here so nothing off
  the machine can reach it directly. Tailscale Serve bridges to it without changing that.

---

*End of plan. If you are the executing session: start with Track A, prove the 403 turns into a
200 through Tailscale, and everything else follows.*
