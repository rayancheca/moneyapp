import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Mirrors the statement archive to iCloud Drive.
 *
 * The archive is the only irreplaceable data in this project: the database is
 * DERIVED from these files and can be rebuilt at any time, while the files
 * cannot be rebuilt from the database. `data/` is gitignored, so without this
 * the ground truth lives in exactly one copy on exactly one machine.
 *
 * ADDITIVE ONLY, BY DESIGN. It never deletes from the destination and never
 * overwrites a byte-different file in place — it parks the incoming copy beside
 * the existing one instead. A mirror that deletes is not a backup: it would
 * faithfully propagate an accidental `rm -rf data/` into the one copy that was
 * supposed to survive it. The cost is that a genuinely removed statement
 * lingers in iCloud, which is the direction you want to be wrong in.
 *
 *   pnpm backup:statements            # copy anything new
 *   pnpm backup:statements --dry-run  # say what it would copy
 */

const DEST_ROOT = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "MoneyApp Statements",
);

/*
 * Two sources, because a statement is ground truth from the moment it lands on
 * disk — not from the moment it is imported. `data/statements/` is the archive
 * the importer writes; `statements/` is the drop folder files sit in first, and
 * a run of downloads can live there for days before anything imports them.
 * Backing up only the archive would leave exactly the newest, least replaceable
 * files unprotected.
 */
const SOURCES: { root: string; label: string; destSubdir: string }[] = [
  { root: path.join(process.cwd(), "data", "statements"), label: "archive", destSubdir: "archive" },
  { root: path.join(process.cwd(), "statements"), label: "inbox", destSubdir: "inbox" },
];

const DRY_RUN = process.argv.includes("--dry-run");

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    // .DS_Store and friends are noise, not ground truth
    return entry.name.startsWith(".") ? [] : [full];
  });
}

interface Tally {
  files: number;
  copied: number;
  identical: number;
  conflicted: number;
  bytes: number;
}

function backupSource(sourceRoot: string, destSubdir: string): Tally {
  const tally: Tally = { files: 0, copied: 0, identical: 0, conflicted: 0, bytes: 0 };
  const files = walk(sourceRoot);
  tally.files = files.length;

  for (const src of files) {
    const rel = path.relative(sourceRoot, src);
    const dest = path.join(DEST_ROOT, destSubdir, rel);

    if (fs.existsSync(dest)) {
      // same name: only a byte-for-byte match is genuinely already backed up.
      // Anything else is a collision, and the existing copy is never the one
      // that loses — it is older, and older here means more likely to be the
      // one a later mistake overwrote.
      if (sha256(dest) === sha256(src)) {
        tally.identical += 1;
        continue;
      }
      const parsed = path.parse(dest);
      const sha = sha256(src).slice(0, 12);
      const beside = path.join(parsed.dir, `${parsed.name}.conflict-${sha}${parsed.ext}`);
      if (fs.existsSync(beside)) {
        tally.identical += 1;
        continue;
      }
      tally.conflicted += 1;
      console.log(`  ! differs, parking beside: ${rel}`);
      if (!DRY_RUN) fs.copyFileSync(src, beside);
      tally.bytes += fs.statSync(src).size;
      continue;
    }

    tally.copied += 1;
    tally.bytes += fs.statSync(src).size;
    if (!DRY_RUN) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  return tally;
}

function main(): void {
  const iCloudRoot = path.dirname(DEST_ROOT);
  if (!fs.existsSync(iCloudRoot)) {
    console.error(`iCloud Drive not found at ${iCloudRoot}. Is iCloud Drive enabled?`);
    process.exit(1);
  }
  if (!SOURCES.some((s) => fs.existsSync(s.root))) {
    console.error(`No statements found — run this from the repo root.`);
    process.exit(1);
  }

  console.log(DRY_RUN ? "DRY RUN — nothing written\n" : "Backing up to iCloud Drive\n");
  console.log(`  destination: ${DEST_ROOT}\n`);

  let moved = 0;
  let bytes = 0;
  for (const source of SOURCES) {
    const t = backupSource(source.root, source.destSubdir);
    moved += t.copied + t.conflicted;
    bytes += t.bytes;
    const detail = [
      `${t.files} file${t.files === 1 ? "" : "s"}`,
      `${t.identical} already safe`,
      `${DRY_RUN ? "would copy" : "copied"} ${t.copied}`,
      t.conflicted > 0 ? `${t.conflicted} conflicts parked beside` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(`  ${source.label.padEnd(8)} ${detail}`);
  }

  console.log(`\n  ${DRY_RUN ? "would transfer" : "transferred"}: ${(bytes / 1_048_576).toFixed(1)} MB`);
  if (!DRY_RUN && moved > 0) {
    console.log("  iCloud syncs in the background — leave the Mac awake and online until it finishes.");
  }
}

main();
