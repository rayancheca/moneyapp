import { count, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db/client";
import type { AccountType } from "@/db/schema/accounts";
import { transactions } from "@/db/schema/transactions";
import type { IconName } from "@/components/shell/Icon";
import { agoPhrase } from "@/lib/coverage-detail";
import { diffDays, todayIso } from "@/lib/dates";
import { formatDayFull } from "@/lib/format-date";
import { VERDICT_PRESENTATION, type ProvenanceTone } from "@/lib/provenance-verdict";
import { accountCoverage, type CoverageGrade } from "./coverage";
import { countedDays, missedBalances, provenanceFor, weakestVerdict, type ProvenanceVerdict } from "./provenance";

/**
 * "Can you trust this?" — how much of what the app says is standing on a
 * document.
 *
 * Every other card on the dashboard publishes a figure. This one publishes the
 * figure's *footing*, and it is the only card whose best answer is often bad
 * news: the honest headline on 2026-08-26 is that five of twelve accounts are
 * not checked by arithmetic at all.
 *
 * ## ⛔ This card GRADES NOTHING
 *
 * Two services already answer the whole question and both are tested:
 * `accountCoverage` decides each account's grade, and
 * `provenanceFor(db, { kind: "netWorth" })` decides what the assembled picture
 * is worth and writes the sentence that says so. Provenance's own docstring
 * says re-deriving any of it "would give the app two answers to one question,
 * and the second one would be the untested one" — so this module composes and
 * counts, and the only per-account judgement it makes is the one neither of
 * them publishes as data (see the hole note below).
 *
 * That is also why the words come from `VERDICT_PRESENTATION`. "adds up" and
 * "nothing checks it" are the same phrases the badge beside net worth uses; a
 * card that invented friendlier synonyms would be a second vocabulary for one
 * set of facts, and the reader would have to work out whether the two agree.
 *
 * ## ⛔ `carried` is not a weakness, and neither is an empty account
 *
 * Both traps are load-bearing here because this card counts things.
 *
 *  - **`carried`** means no transaction has happened since the last recorded
 *    balance, so the day is exactly as proven as the anchor it came from. It is
 *    the most common basis in the ledger — measured 2026-08-26, 785 of 7,404
 *    days — and counting it as unchecked would announce a tenth of the app's
 *    history as unproven. `days.unchecked` is `derived_unverified + gap`,
 *    nothing else, and `days.carried` is published separately so the card can
 *    say out loud that those days are fine.
 *  - **An empty account** — no rows and no balance — contributes $0 and is
 *    missing nothing. An account with ROWS and no balance is a hole: money the
 *    ledger holds and no total can see. Both grade `unknown`, so the grade
 *    alone cannot tell them apart, and the row count below is read for exactly
 *    this one distinction. The RULE that turns a hole into a weakness still
 *    lives in provenance, where it sets `verdict` and writes the ⚠️ clause this
 *    card prints verbatim.
 *
 * ## No spend is measured here, so nothing is netted
 *
 * There is deliberately not one sum of money in this service. Counting rows to
 * separate an empty shelf from a hole uses the same `status IN (active,
 * excluded)` predicate provenance uses — `excluded` hides a row from analytics
 * but not from the balance replay, which is precisely where a plug would hide.
 */

/** One account, as its two graders already described it. */
export interface TrustAccountLine {
  accountId: string;
  name: string;
  /** `accountCoverage`'s verdict, never recomputed */
  grade: CoverageGrade;
  /** the same grade in provenance's vocabulary */
  verdict: ProvenanceVerdict;
  /**
   * Provenance's own clause for this account — "adds up through Aug 2, 2026",
   * "nothing checks it since Dec 5, 2023". Never re-worded here, so the card
   * and the net-worth popover cannot describe one account two ways.
   */
  detail: string | null;
  /** `derived_unverified + gap` — days whose balance nothing checks */
  uncheckedDays: number;
  /**
   * How many of those are in the run `detail`'s "since" date opens.
   *
   * ⛔ The count beside a date has to be the count that date is about. Robinhood
   * Cash has 52 unchecked days in two runs 946 checked days apart, so "52 days"
   * beside any single date is a span nobody can find. See `AccountCoverage`.
   */
  uncheckedRunDays: number;
  /**
   * Rows the ledger holds for an account with no recorded balance. `0` for
   * every account that has a balance, and for a genuinely empty one.
   */
  strandedRows: number;
  /** true only when `strandedRows > 0` — an absence is not a hole */
  isHole: boolean;
  /** no rows and no balance: nothing to check, and nothing missing either */
  isEmpty: boolean;
}

/** Every account sharing one grade, wearing that grade's badge word. */
export interface TrustGroup {
  grade: CoverageGrade;
  verdict: ProvenanceVerdict;
  /** `VERDICT_PRESENTATION`'s word, so this cannot disagree with a badge */
  word: string;
  icon: IconName;
  tone: ProvenanceTone;
  accounts: TrustAccountLine[];
}

export interface TrustDays {
  /** every day in `daily_balances`, across every account */
  total: number;
  derivedUnverified: number;
  gap: number;
  /** ⛔ NOT unchecked — see the header note */
  carried: number;
  /** `derivedUnverified + gap` */
  unchecked: number;
  /**
   * Days whose balance stands on a count of his and nothing else (`countedDays`) — neither unchecked nor a chain that
   * closes: his word, not a check. Disjoint from `unchecked`; `carried` days carried from his count are in it.
   */
  counted: number;
  /**
   * Unchecked days as a percentage of all of them.
   *
   * ⛔ Null when the ledger has no derived days at all. `0 / 0` is `NaN` and
   * renders as "NaN% of days", which is worse than saying nothing; a ledger
   * with nothing derived has no share to publish.
   */
  uncheckedSharePct: number | null;
  /**
   * The whole day story in one sentence, written here rather than in the card
   * so the count, the share and the accounts named cannot drift apart.
   */
  sentence: string;
  /**
   * What the carried days are, said out loud — null when there are none.
   *
   * ⛔ Present because the reader will otherwise wonder what the rest of the
   * days are, and the wrong answer is the one an earlier draft of the
   * provenance service gave: `carried` looks like a weak basis and is not one.
   */
  carriedNote: string | null;
}

export interface TrustCard {
  /** the figure: "7 of 12" */
  headline: string;
  /**
   * What the figure counts, in provenance's own words rather than a synonym.
   *
   * Deliberately NOT pluralised: `netWorthProvenance` writes "accounts add up"
   * at every count, so a card that said "1 account adds up" beside a badge
   * reading "1 of 12 accounts add up" would be two grammars for one fact.
   */
  headlineNoun: string;
  /**
   * The rest of provenance's own sentence about the assembled picture — the
   * clause the headline above already states is removed, never rewritten.
   */
  summary: string;
  /** the weakest thing the whole picture rests on */
  verdict: ProvenanceVerdict;
  verdictWord: string;
  verdictTone: ProvenanceTone;
  /** worst footing first; empty accounts are not in here */
  groups: TrustGroup[];
  /**
   * Accounts holding nothing at all. Listed apart from the groups because an
   * absence is not a weakness — see the note beside `emptyAccounts` below.
   */
  emptyAccounts: TrustAccountLine[];
  /** one sentence naming them, or null when every account holds something */
  emptyNote: string | null;
  accountsCounted: number;
  accountsAddUp: number;
  /** the last day the WHOLE picture provably added up */
  checkedThrough: string | null;
  /** how long ago that was; null when nothing is checked at all */
  daysSinceChecked: number | null;
  /**
   * The same elapsed count as a PHRASE — "today" / "1 day ago" / "39 days ago".
   *
   * 🔴 The card built this itself, as `` ` — ${daysSinceChecked} days ago` ``,
   * so the day the owner finally imports every account up to date it reads
   * "checked through 2026-09-08 — 0 days ago", and the day after "— 1 days
   * ago". `agoPhrase` is the app's rule for exactly this number and had ONE
   * caller: `/imports`' coverage row, whose own docstring records "1 days"
   * shipping there and being fixed. `cards-owed` states the other half —
   * "a statement that closed today is dated and not aged: '0 days ago' is
   * noise". Both were true of the row six lines above this sentence, which
   * pluralises, and not of the sentence itself.
   */
  checkedThroughAgo: string | null;
  /** why the date is that one and not the newest statement's */
  checkedThroughExplanation: string;
  days: TrustDays;
  /** accounts carrying unchecked days, most first */
  uncheckedByAccount: { name: string; days: number }[];
  today: string;
}

/**
 * Group order, taken from the app's ONE ranking of verdicts.
 *
 * `weakestVerdict` is exported precisely because the rank behind it is not
 * public, and asking it which of two verdicts is worse is the same question
 * sorting asks. Copying the rank table into this file would be a second
 * ordering of one idea — the app already has two (`VERDICT_RANK` in provenance,
 * `GRADE_ORDER` in the coverage panel) and they disagree about whether
 * `unknown` is worse than `unverified`. Groups are keyed by verdict, so no two
 * ever tie.
 */
function worstFirst(a: TrustGroup, b: TrustGroup): number {
  if (a.verdict === b.verdict) return 0;
  return weakestVerdict([a.verdict, b.verdict]) === a.verdict ? -1 : 1;
}

/** The clause `netWorthProvenance` opens its sentence with, after the count. */
const HEADLINE_NOUN = "accounts add up against a document";

/**
 * Provenance's sentence with its opening clause removed — the one this card
 * already prints, in 30px, directly above it.
 *
 * ⛔ A removal, never a rewrite. The sentence is the tested one and it carries
 * the market-value, hand-counted, unchecked and ⚠️ hole clauses that nothing
 * else publishes as data; paraphrasing it would put a second author on the
 * app's most load-bearing paragraph. And a duplicated phrase is not merely
 * ugly: a card that prints one string twice breaks the exact-count text
 * locators this codebase reads pages with.
 *
 * If provenance ever rewords its opening, this stops matching and the whole
 * sentence survives — the card degrades to saying it twice, never to saying
 * something else.
 */
function withoutOpening(sentence: string, opening: string): string {
  for (const separator of [", ", ". "]) {
    const prefix = `${opening}${separator}`;
    if (sentence.startsWith(prefix)) return sentence.slice(prefix.length);
  }
  return sentence;
}

/** "1 day" / "7,404 days" — thousands separated, because these run to five figures. */
function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * What the unchecked days are, named.
 *
 * Two populations, and they are not the same news: `derived_unverified` is the
 * replay running past the last recorded balance with nothing left to land on,
 * and `gap` is the replay landing somewhere else than the next recorded
 * balance. The first means nobody has checked; the second means the check
 * FAILED. Folding them into one number would let a real break hide inside a
 * backlog of unimported statements.
 */
function daySentence(
  total: number,
  unchecked: number,
  gap: number,
  sharePct: number | null,
  byAccount: readonly DaysIn[],
  missed: readonly MissedBalance[],
  countedBy: readonly DaysIn[],
): string {
  if (total === 0) return "No day of balances has been derived yet, so there is nothing here to check.";
  if (unchecked === 0) return closedOrCountedSentence(total, countedBy);
  const gapClause =
    gap === 0
      ? " No day provably fails to add up — these are days nobody has checked, not days that broke."
      : ` ${gap.toLocaleString("en-US")} of them provably ${gap === 1 ? "does" : "do"} not add up: the replay missed ${missedWords(missed)}.`;
  return `${unchecked.toLocaleString("en-US")} of ${plural(total, "day")} of balances${shareWords(sharePct)} rest on nothing — ${namedDays(byAccount)}.${gapClause}`;
}

/** Days counted in one account — `uncheckedByAccount`'s shape, most first. */
type DaysIn = { name: string; days: number };

/** "28 in Cash on Hand, 4 in Robinhood Cash" */
function namedDays(byAccount: readonly DaysIn[]): string {
  return byAccount.map((a) => `${a.days.toLocaleString("en-US")} in ${a.name}`).join(", ");
}

/**
 * " (4.2% of them)" — null when there is no share to publish (`uncheckedSharePct`), and a real remainder is never
 * rounded down to a flat "0.0%".
 */
function shareWords(sharePct: number | null): string {
  return sharePct === null ? "" : sharePct < 0.1 ? " (under 0.1% of them)" : ` (${sharePct.toFixed(1)}% of them)`;
}

/**
 * The day story when no day rests on nothing: a chain that closes — unless a day rests on his count alone.
 *
 * 🔴 Every such day "rests on a chain that closes". A wallet resting on nothing but his two counts read "Every one of
 * 66 days of balances rests on a chain that closes." beside its own line "you counted it on Aug 20, 2026, and nothing
 * else checks it" and its balance proof "Both are your own counts, so nothing else confirms Cash on Hand"; a value he
 * typed on an investment account read the same beside "1 is held at a balance you counted" (temp ledger through the
 * real services, review 2026-10-06 — not on his ledger, where Cash on Hand still has an open unchecked run).
 *
 * ⚖️ ONE verb for a balance he typed, "counted" (his answer, 2026-10-05). The days on his count are each day's own
 * proof's (`countedDays`); the sentence says nothing of the others, so it calls none of them a chain that closes.
 */
function closedOrCountedSentence(total: number, countedBy: readonly DaysIn[]): string {
  const counted = countedBy.reduce((n, a) => n + a.days, 0);
  if (counted === 0) return `Every one of ${plural(total, "day")} of balances rests on a chain that closes.`;
  const opening =
    counted === total
      ? `Every one of ${plural(total, "day")} of balances rests`
      : `${counted.toLocaleString("en-US")} of ${plural(total, "day")} of balances${shareWords((counted / total) * 100)} ${counted === 1 ? "rests" : "rest"}`;
  return `${opening} on a balance you counted — ${namedDays(countedBy)} — your word, not a check. No day rests on nothing, and none fails to add up.`;
}

/** A balance a replay missed — `missedBalances`, one account's. */
type MissedBalance = { anchoredOn: string; source: string };

/**
 * The balance the replay missed on the days that do not add up, in each day's own proof's words for it.
 *
 * 🔴 Every one was "the next recorded balance", his count included. A wallet whose $40.00 recount for Sep 1 does not
 * add up read "28 of them provably do not add up: the replay missed the next recorded balance." beside its own
 * balance proof, "…the one you counted on Sep 1, 2026" (temp ledger through the real services, 2026-10-06).
 *
 * ⚖️ ONE verb for a balance he typed, "counted" (his answer, 2026-10-05); a document's keeps "recorded". One count
 * is named by its day, as its proof names it; several are not listed, and a statement's and his are both said.
 */
function missedWords(missed: readonly MissedBalance[]): string {
  const counts = missed.filter((m) => m.source === "manual");
  if (counts.length === 0) return "the next recorded balance";
  const count = counts.length === 1 ? `the one you counted on ${formatDayFull(counts[0]!.anchoredOn)}` : null;
  if (counts.length < missed.length) return `the next recorded balance, or ${count ?? "the next one you counted"}`;
  return count === null ? "the next balance you counted" : `the next balance, ${count}`;
}

export function trustCard(db: AppDatabase, today: string = todayIso()): TrustCard | null {
  const coverage = accountCoverage(db, today);
  // nothing to be honest about yet — a fresh install has no accounts, and a
  // card of zeroes is worse than no card (the rule `carCard` already follows)
  if (coverage.length === 0) return null;

  /*
   * `netWorthProvenance` builds `inputs` by mapping the SAME
   * `accountCoverage(db, today)` this just called, so index i is the same
   * account in both lists. The label check below asserts that invariant rather
   * than papering over it: pairing one account's name with another's basis is
   * the one failure this card must never ship, so a mismatch falls back to a
   * name lookup and then to no detail at all — never to a guess.
   */
  const netWorth = provenanceFor(db, { kind: "netWorth", day: today });
  // `netWorthProvenance` never returns null today; if it ever cannot answer,
  // this card has no sentence to print and must not invent one
  if (!netWorth) return null;
  /*
   * Joined by ACCOUNT ID, which `ProvenanceInput` publishes for exactly this.
   * The first version matched by array index with a label fallback — an
   * invariant across a service boundary rather than a contract, holding only
   * because netWorthProvenance happens to build `inputs` as `coverage.map(...)`.
   * A reorder or filter there would have silently mispaired every row, and two
   * accounts sharing a name would have collided.
   */
  const inputById = new Map(netWorth.inputs.filter((i) => i.id !== undefined).map((i) => [i.id!, i] as const));

  /*
   * Rows per account, for the empty-versus-hole split ONLY. `excluded` counts:
   * an excluded row is hidden from analytics and still moves the balance
   * replay, so an account holding only excluded rows is still money a total
   * cannot see.
   */
  const rowCounts = new Map(
    (
      db
        .select({ accountId: transactions.accountId, n: count() })
        .from(transactions)
        .where(inArray(transactions.status, ["active", "excluded"]))
        .groupBy(transactions.accountId)
        .all() as { accountId: string; n: number }[]
    ).map((r) => [r.accountId, r.n] as const),
  );

  const lines: TrustAccountLine[] = coverage.map((c) => {
    const input = inputById.get(c.accountId);
    const rows = rowCounts.get(c.accountId) ?? 0;
    // stranded only while there is no balance to check the rows against; an
    // account with a derived history is in the total whatever its grade
    const stranded = c.grade === "unknown" ? rows : 0;
    return {
      accountId: c.accountId,
      name: c.accountName,
      grade: c.grade,
      verdict: input?.verdict ?? "unknown",
      detail: input?.detail ?? null,
      uncheckedDays: c.days.derived_unverified + c.days.gap,
      uncheckedRunDays: c.uncheckedRunDays,
      strandedRows: stranded,
      isHole: stranded > 0,
      /*
       * ⛔ Taken from provenance, not re-derived. `isEmpty` used to restate the
       * predicate netWorthProvenance uses to drop an account from its verdict,
       * so the two could drift and the card would disagree with the badge it
       * exists to explain. One definition, published as data.
       */
      isEmpty: input?.isEmpty ?? (c.grade === "unknown" && rows === 0),
    };
  });

  /*
   * ⛔ Empty accounts leave the grade groups, exactly as they leave
   * `netWorthProvenance`'s `weighed` list. Without this the loudest thing on
   * the card is Capital One 360 Checking — an account with no rows, no balance
   * and nothing wrong with it — sorted ABOVE the two accounts carrying 42
   * unchecked days, because `unknown` outranks `unverified` in the app's own
   * worst-first order. That order is right about a FIGURE with no basis and
   * wrong about an empty shelf, so the shelf is moved rather than the order.
   *
   * They stay inside `accountsCounted`, so "7 of 12" is still the same 12 the
   * net-worth badge counts.
   */
  const emptyAccounts = lines.filter((l) => l.isEmpty);
  const graded = lines.filter((l) => !l.isEmpty);

  const byGrade = new Map<CoverageGrade, TrustAccountLine[]>();
  for (const line of graded) {
    const bucket = byGrade.get(line.grade);
    if (bucket) bucket.push(line);
    else byGrade.set(line.grade, [line]);
  }

  const groups: TrustGroup[] = [...byGrade.entries()]
    .map(([grade, accounts]) => {
      // every member of a grade carries the same verdict by construction, so
      // this is the group's verdict rather than a reduction of dissimilar ones
      const verdict = weakestVerdict(accounts.map((a) => a.verdict));
      const present = VERDICT_PRESENTATION[verdict];
      return {
        grade,
        verdict,
        word: present.word,
        icon: present.icon,
        tone: present.tone,
        accounts: [...accounts].sort((a, b) => b.uncheckedDays - a.uncheckedDays || a.name.localeCompare(b.name)),
      };
    })
    .sort(worstFirst);

  /*
   * The proven count is the `verified` grade's size, which is the same
   * population provenance counts as `derived || sourced` — GRADE_VERDICT maps
   * `verified → derived` and no other grade reaches it. Counting is not
   * grading; a test pins this against the badge word so the two cannot drift.
   */
  const accountsAddUp = groups.find((g) => g.grade === "verified")?.accounts.length ?? 0;
  const accountsCounted = coverage.length;

  const tally = coverage.reduce(
    (acc, c) => ({
      total: acc.total + c.days.anchored + c.days.derived + c.days.derived_unverified + c.days.carried + c.days.gap,
      derivedUnverified: acc.derivedUnverified + c.days.derived_unverified,
      gap: acc.gap + c.days.gap,
      carried: acc.carried + c.days.carried,
    }),
    { total: 0, derivedUnverified: 0, gap: 0, carried: 0 },
  );
  const unchecked = tally.derivedUnverified + tally.gap;
  // ⛔ the guard, not a formality: an account list with no derived days at all
  // makes this 0 / 0, which is NaN rather than zero
  const uncheckedSharePct = tally.total === 0 ? null : (unchecked / tally.total) * 100;

  const uncheckedByAccount = lines
    .filter((l) => l.uncheckedDays > 0)
    .map((l) => ({ name: l.name, days: l.uncheckedDays }))
    .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));

  // the balances the replay missed, read from each broken account's own proofs (`missedBalances`)
  const missed = coverage.filter((c) => c.days.gap > 0).flatMap((c) => missedBalances(db, c.accountId));
  // the days on his count alone, as each day's own proof reads them (`countedDays`); an `unknown` account has none
  const countedByAccount = coverage
    .filter((c) => c.grade !== "unknown")
    .map((c) => ({
      name: c.accountName,
      days: countedDays(db, { id: c.accountId, type: c.accountType as AccountType }).size,
    }))
    .filter((a) => a.days > 0)
    .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));

  const days: TrustDays = {
    ...tally,
    unchecked,
    counted: countedByAccount.reduce((n, a) => n + a.days, 0),
    uncheckedSharePct,
    sentence: daySentence(
      tally.total,
      unchecked,
      tally.gap,
      uncheckedSharePct,
      uncheckedByAccount,
      missed,
      countedByAccount,
    ),
    carriedNote:
      tally.carried === 0
        ? null
        : `${plural(tally.carried, "day")} had no activity to replay, so the balance before them was carried forward — as proven as that balance, and not a gap.`,
  };

  const checkedThrough = netWorth.checkedThrough;
  const overall = VERDICT_PRESENTATION[netWorth.verdict];

  return {
    headline: `${accountsAddUp} of ${accountsCounted}`,
    headlineNoun: HEADLINE_NOUN,
    summary: withoutOpening(netWorth.headline, `${accountsAddUp} of ${accountsCounted} ${HEADLINE_NOUN}`),
    verdict: netWorth.verdict,
    verdictWord: overall.word,
    verdictTone: overall.tone,
    groups,
    emptyAccounts,
    emptyNote:
      emptyAccounts.length === 0
        ? null
        : `${emptyAccounts.map((a) => a.name).join(", ")} ${emptyAccounts.length === 1 ? "holds" : "hold"} no rows and no balance — nothing to check, and nothing missing from any total.`,
    accountsCounted,
    accountsAddUp,
    checkedThrough,
    daysSinceChecked: checkedThrough === null ? null : diffDays(checkedThrough, today),
    checkedThroughAgo: checkedThrough === null ? null : agoPhrase(diffDays(checkedThrough, today)),
    checkedThroughExplanation:
      "The whole picture stops being proven at the first account that stops being checked, so this is the oldest of those dates and not the newest statement.",
    days,
    uncheckedByAccount,
    today,
  };
}
