# Moving MoneyApp off the Desktop — the runbook

> Written 2026-08-28, at `main` = `390f270`. Every number below was measured on
> this machine, not estimated.

## Why, in one line each

**1. iCloud has been copying the live database's write-ahead log.** Not a
theory — there are five dated conflict copies sitting in `data/` right now:

```
data/moneyapp 2.db-shm   Aug  6 10:27      data/moneyapp 5.db-shm   Aug 24 12:20
data/moneyapp 2.db-wal   Aug  6 10:23      data/moneyapp 5.db-wal   Aug 24 12:20
data/moneyapp 3.db-shm   Aug  6 16:23      data/moneyapp 6.db-shm   Aug 25 12:48
data/moneyapp 3.db-wal   Aug  6 16:21      data/moneyapp 6.db-wal   Aug 25 12:48
data/moneyapp 4.db-shm   Aug 24 12:19
data/moneyapp 4.db-wal   Aug 24 12:12
```

iCloud produced those on five separate occasions over three weeks. There is no
conflict copy of `moneyapp.db` itself and the ledger checks green — but a sync
daemon racing a SQLite write-ahead log is how a database gets torn, and this is
the ledger.

**2. The suites lie under the resulting load.** Fifteen tests failed once each
across nine runs last session and not one reproduced. Every `pnpm build`
rewrites 1.7 GB inside a folder iCloud watches; `bird` was caught at 59% CPU
with nothing else running, and once `next build` could not delete its own
`.next/server` (`ENOTEMPTY`).

**3. The footer says something that is not true.** Every page reads
*"Local-first · your data never leaves this Mac."* `data/moneyapp.db` — the
whole ledger — and `.env`, which holds an `ANTHROPIC_API_KEY`, are both inside
iCloud Drive. Neither is in git; iCloud does not read `.gitignore`.

## The one thing that actually breaks

⛔ **`import_files.storage_path` holds 329 ABSOLUTE paths**, every one rooted at
`/Users/rayankarimcheca/Desktop/Dev/MoneyApp/`. Move the repo and all 329 point
at a directory that no longer exists.

No money depends on them — transactions, balances and anchors are all in the
database — but the link from an import back to the document it came from is the
whole reason the archive exists. `scripts/repoint-statement-paths.ts` fixes them
in one command, and step 7 runs it.

Everything else is already relative and travels fine: `core.hooksPath` is
`.githooks`, `.claude/launch.json` uses a port, `statementsRoot()` derives from
`process.cwd()`, and there is exactly one git worktree (the checkout itself).

## Facts you'll want in advance

| | |
|---|---|
| repo size | **2.8 GB** — `data` 1.4G, `node_modules` 755M, `.git` 422M, `.next` 57M |
| free space | 129 GB |
| destination | `~/Dev/MoneyApp` — `~/Dev` is neither Desktop nor Documents, so iCloud does not sync it |
| iCloud placeholders | **0** — every file is local, nothing has to download first |
| `.env` | one line: `ANTHROPIC_API_KEY` |

---

# The steps

Run them in order. Steps 1–4 are reversible; step 5 is the move.

### 1. Quit everything holding the database

The dev server, any `pnpm`/`vitest`/`playwright` run, and any Claude Code
session working in the folder. Then confirm nothing is left:

```bash
pgrep -fl "next dev|vitest|playwright|tsx scripts" || echo "clear"
```

### 2. Prove the starting point is good

If anything goes wrong later, this is what "before" means. All three must pass.

```bash
cd ~/Desktop/Dev/MoneyApp && git status --short && npx tsx scripts/ledger-check.ts && npx vitest run --reporter=dot 2>&1 | tail -3
```

A clean `git status`, `exit 0` from the ledger check, and 4,223 passing tests.
The code is already on GitHub at `390f270`; the database is not, which is what
step 3 is for.

### 3. Take a backup that lives OUTSIDE the repo

⚠️ **Never `cp` a live SQLite database** — it drops the `-wal` and copies a torn
file. This uses SQLite's own online-backup API, and puts the copy in your home
directory so it is not inside the thing you are about to move.

```bash
cd ~/Desktop/Dev/MoneyApp && sqlite3 data/moneyapp.db ".backup '$HOME/moneyapp-premove-$(date +%Y%m%d).db'" && ls -lh ~/moneyapp-premove-*.db
```

### 4. Fold the write-ahead log into the database, and clear the junk

A checkpointed database is a single self-contained file, which is the safest
thing to move. Then delete what does not need to travel — this takes the move
from 2.8 GB to about 2 GB and removes the iCloud conflict copies at the same
time.

```bash
cd ~/Desktop/Dev/MoneyApp && sqlite3 data/moneyapp.db "PRAGMA wal_checkpoint(TRUNCATE);" && rm -rf .next .trial test-results && rm -f data/*" "[0-9].db-shm data/*" "[0-9].db-wal
```

Then check the conflict copies are gone:

```bash
ls data/ | grep -E " [0-9]\." || echo "no conflict copies left"
```

### 5. Move it

```bash
mkdir -p ~/Dev && mv ~/Desktop/Dev/MoneyApp ~/Dev/MoneyApp && ls -d ~/Dev/MoneyApp
```

⚠️ This copies rather than renames, because it is crossing out of the
iCloud-managed tree — expect a minute or two for 2 GB, and let it finish. When
it is done, iCloud will remove its cloud copy of the old location. That is the
point, and step 3 is why it is safe.

### 6. Check it arrived intact

```bash
cd ~/Dev/MoneyApp && git status --short && git log --oneline -1 && sqlite3 data/moneyapp.db "PRAGMA integrity_check;" && sqlite3 data/moneyapp.db "select count(*) from transactions where status='active'"
```

Expect: a clean tree, `390f270`, `ok`, and **10111**.

### 7. Repoint the 329 archived originals

Dry run first — it prints how many rows point outside the new directory and
what it would do about them. Then apply.

```bash
cd ~/Dev/MoneyApp && npx tsx scripts/repoint-statement-paths.ts
```

```bash
cd ~/Dev/MoneyApp && npx tsx scripts/repoint-statement-paths.ts --apply
```

It only ever repoints a row whose file it can actually see at the new location;
anything genuinely missing is reported and left alone. It takes its own
pre-mutation snapshot before writing.

### 8. Reinstall and re-verify

`node_modules` travelled, but some native modules (`better-sqlite3` is one) bake
their build path in. Rebuilding is cheaper than debugging it later.

```bash
cd ~/Dev/MoneyApp && pnpm install && npx tsx scripts/ledger-check.ts && npx tsc --noEmit && npx vitest run --reporter=dot 2>&1 | tail -3
```

`pnpm install` also re-runs `prepare`, which re-points `core.hooksPath` at
`.githooks` — so the pre-commit ledger check keeps working.

### 9. The one that proves it worked

```bash
cd ~/Dev/MoneyApp && rm -rf .next && E2E_GATE=1 pnpm e2e:fresh 2>&1 | tail -5
```

**582 passed.** If it comes back green on a first run, without the scattered
non-reproducing failures of the last few sessions, the flakiness really was the
sync daemon.

### 10. Point your tools at the new path

- Your terminal's saved directory / any shell alias
- The editor's open workspace
- Any Claude Code session: start it in `~/Dev/MoneyApp`
- Nothing inside the repo needs editing — checked.

---

## If something goes wrong

The code is on GitHub. The database is in `~/moneyapp-premove-<date>.db` from
step 3, plus `data/backups/` travelled with the repo. To restore:

```bash
cd ~/Dev/MoneyApp && cp ~/moneyapp-premove-*.db data/moneyapp.db && rm -f data/moneyapp.db-wal data/moneyapp.db-shm && npx tsx scripts/ledger-check.ts
```

## Afterwards

Once a full gate has passed from the new location, delete the pre-move backup —
or keep it a week. And the footer becomes true again, which was the third
reason.
