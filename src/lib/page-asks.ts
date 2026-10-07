import type { ViewSpec, ViewState } from "./view-state";

/**
 * The view a press ASKED for, one per page — what the next press builds on while the server has
 * not drawn it yet.
 *
 * A view press persists its surface's view and then navigates to the WHOLE page URL, and the
 * server resolves every view on the page from that URL (URL > persisted > default). Until that
 * navigation commits, everything the page was handed — each switcher's `state`, each page's
 * `baseParams`, the URL `useSearchParams` reads — is the page from BEFORE the press.
 *
 * 🔴 So a second press built on it silently undid the first: on a holding, Return then Table
 * saved `view: "value"` over the Return and landed on the Price table; on /spending a cash
 * press then a "Where it went" press landed without the cash view (two hooks, two specs, one
 * URL); on /investments a range pill pressed while a view press was in flight navigated to the
 * URL without the view, and a view press made while a range was in flight took the range back.
 * The first fix (3c5d3ea) kept the asked view PER HOOK and was reverted (555a4ef): a lost press
 * survives across two hooks and across the page's other URL writers, and Back/Forward commits
 * outside any transition, so a press built on the asked view brought back a view he had left.
 *
 * Hence ONE asked URL per page, shared by every switcher and URL writer on it (the store below,
 * mounted once in the root layout — never a module-level cache, which would outlive the page).
 * Every press and every URL writer — a range pill, the benchmark, a period link ‹ ›, a /recurring
 * tab — asks for its URL before it navigates, so following one builds the ask on; it never drops
 * it. What drops it is the page moving under it by anything nobody asked for: Back/Forward as it
 * starts; a push or replace to a URL no press or writer asked for as it starts (a crumb's link,
 * the sidebar's, a link to another page — `isForeign`); a commit of any other URL (a redirect). A
 * commit of a URL a press asked for is a press landing, not a move. Until anything is drawn after
 * such a link dropped it, the page's writers still build on the ask it dropped
 * (`PageAsks.departing`): the page on screen is still the one that ask was built on.
 *
 * Once the newest asked URL has committed the ask is kept, not dropped: it then says exactly
 * what the page shows (every press made since has its write before its navigation), and the
 * commit that would prove the LAST press drawn is invisible when that press asked for the URL
 * already on screen (a default view's URL is the clean one).
 *
 * With nothing asked, a press starts from the URL the router last committed — the one on
 * screen. 🔴 It started from the params the server handed its own switcher, and a shared link
 * holds views he never saved: Grid pressed on `/?chart=bridge` (the decision cards are handed
 * no params) went to `/?cards=grid`, and the hero, read from his saved preference, went back to
 * Net worth. The same from the hero's pills over a linked `?cards=grid`, and on /spending over a
 * linked lens at its default (the server hands each card the other's only when it is not).
 */
export interface PageAsk {
  /** the page every press in it was made on */
  readonly pathname: string;
  /** the newest asked URL as written — every press still in flight navigates to it */
  readonly href: string;
  /** that URL's query: every param on the page, the view's and the rest (period, range, …) */
  readonly params: Readonly<Record<string, string>>;
  /** every view key a press has asked for since the ask began (dimensions and carried keys) */
  readonly dims: Readonly<Record<string, string>>;
  /** every URL asked since the newest one last committed, in one spelling (`canonicalHref`) */
  readonly trail: readonly string[];
}

/** A press's surface, as `useViewState` is handed it. */
export interface PressTarget {
  /** the route the press navigates within */
  basePath: string;
  spec: ViewSpec;
  /** the view the server resolved */
  state: ViewState;
  /** the URL params the server says to keep beside the view (period, the other card's lens) */
  baseParams: Record<string, string>;
  /** keys the surface persists beside its spec and carries in its URL (the dashboard's `accts`) */
  carry: readonly string[];
}

/** What a press builds on. */
export interface PressBase {
  /** the surface's view: the server's, with every key a press on this page asked for over it */
  view: ViewState;
  /**
   * the params beside the view: the newest asked URL's; with nothing asked, the server's and
   * every other param of the URL on screen (another switcher's view only the URL holds) — never a
   * one-shot message (`ONE_SHOT_PARAMS`)
   */
  params: Record<string, string>;
  /** true when built on an ask (a press may be in flight), false when on the server's view */
  asked: boolean;
}

/** Any origin: hrefs here are same-origin paths, and URL needs one to parse them. */
const ORIGIN = "http://page-asks.invalid";

/**
 * The params a page reads once, for a message about an action that already happened: the `?error=`
 * a refused form action redirects back with (`errorParam`, ErrorBanner.tsx), and /transactions'
 * `?notice=` (`parseNotice`; no press sits on that page today, and none ever carries it).
 *
 * ⚖️ Owner 2026-10-06 (§6A 44): a press CLEARS a stale banner, as the /recurring tabs always did — a
 * press is a new action. 🔴 Built on every param on screen (`onScreen`), it carried one: Compact
 * pressed on `/recurring?error=…&tab=calendar` kept telling him Detect now had failed. So no press,
 * range pill or same-page link (`pressBase`, `pageLinkHref`, ChartFocus's `useRangeParam`) keeps
 * one; every view and filter of the URL still rides.
 */
export const ONE_SHOT_PARAMS: readonly string[] = ["error", "notice"];

/** True for a param no press or same-page link carries on (`ONE_SHOT_PARAMS`). */
function isOneShot(key: string): boolean {
  return ONE_SHOT_PARAMS.includes(key);
}

/**
 * A URL in one spelling: pathname as the router encodes it, query keys sorted. The router's
 * committed URL and a press's href spell the same page differently — a view's params come
 * after the page's own in `viewHrefQuery`, a range pill appends, and `,` may or may not be
 * escaped — and a trail compared byte for byte would call a press landing a foreign move.
 */
export function canonicalHref(href: string): string {
  const url = new URL(href, ORIGIN);
  const query = [...url.searchParams]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .sort()
    .join("&");
  return query === "" ? url.pathname : `${url.pathname}?${query}`;
}

function pathnameOf(href: string): string {
  return new URL(href, ORIGIN).pathname;
}

/** The newest asked URL's params, when there is an ask on `pathname`. */
export function askedParams(ask: PageAsk | null, pathname: string): Record<string, string> | null {
  return ask !== null && ask.pathname === pathnameOf(pathname) ? { ...ask.params } : null;
}

/**
 * The params a press with nothing asked builds on: the server's (they win: it normalized them —
 * a validated `accts`, a resolved period), then every other param of `shown`, the URL on
 * screen, in its order — never this surface's own dimensions, which the press writes itself, nor a
 * one-shot message (`ONE_SHOT_PARAMS`). A URL on another page (one not committed yet) adds nothing.
 */
function onScreen(at: PressTarget, own: ReadonlySet<string>, shown: string | null): Record<string, string> {
  if (shown === null || pathnameOf(shown) !== pathnameOf(at.basePath)) return at.baseParams;
  const params: Record<string, string> = { ...at.baseParams };
  for (const [key, value] of new URL(shown, ORIGIN).searchParams) {
    // the first of a repeated key, as the server reads it (`firstParam`)
    if (!own.has(key) && !isOneShot(key) && !Object.hasOwn(params, key)) params[key] = value;
  }
  return params;
}

/**
 * What a press on `at` builds on. With no ask on its page, the server's view, and its params
 * with every other param of `shown` (the URL on screen) beside them. With one, the newest
 * asked URL's params (minus this surface's own dimensions, which the press writes itself) and
 * the server's view with every key a press asked for laid over it — the asked URL already
 * started from the one on screen. Never a one-shot message (`ONE_SHOT_PARAMS`): a press is a new
 * action.
 */
export function pressBase(ask: PageAsk | null, at: PressTarget, shown: string | null = null): PressBase {
  const own = new Set(at.spec.map((dim) => dim.key));
  if (ask === null || ask.pathname !== pathnameOf(at.basePath)) {
    return { view: at.state, params: onScreen(at, own, shown), asked: false };
  }
  const view: ViewState = { ...at.state };
  for (const key of [...own, ...at.carry]) {
    const asked = ask.dims[key];
    if (asked !== undefined) view[key] = asked;
  }
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(ask.params)) {
    if (!own.has(key) && !isOneShot(key)) params[key] = value;
  }
  return { view, params, asked: true };
}

/** What a same-page link writes: a value for some of the keys it owns (a missing one is left out). */
export type LinkParams = Readonly<Record<string, string | null | undefined>>;

/**
 * Where a same-page link that changes only params beside the page's views goes — the period
 * picker, a /recurring tab: `pathname`, `set` first, then every param of `base` (the page's
 * current URL) whose key the link does not own, in its order — never a one-shot message
 * (`ONE_SHOT_PARAMS`), whatever keys the link owns.
 *
 * ⚖️ Owner 2026-10-06 (§6A 40): a period arrow KEEPS a view only the URL held, the way a press
 * does. 🔴 It wrote the period alone: `/spending?period=2026-07&where=relief` with List saved,
 * ‹ — and June opened on List, the link's Relief gone. Followed, its `base` is the newest asked
 * URL while a press may be in flight (`PageAsks.paramsOn`), not the one on screen: built on that,
 * a link carries the OLD value of the press's dimension, and the press drawing its page again
 * (`landing`) would land the view it replaced.
 */
export function pageLinkHref(
  pathname: string,
  base: Iterable<readonly [string, string]>,
  owns: readonly string[],
  set: LinkParams,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(set)) if (value) query.set(key, value);
  const skip = new Set(owns);
  for (const [key, value] of base) {
    // the first of a repeated key, as the server reads it (`firstParam`)
    if (!skip.has(key) && !isOneShot(key) && !query.has(key)) query.set(key, value);
  }
  const out = query.toString();
  return out === "" ? pathname : `${pathname}?${out}`;
}

/** The ask after a press (or a URL writer) asked for `href`, recording the view keys it chose. */
export function withAsk(ask: PageAsk | null, href: string, dims: ViewState): PageAsk {
  const pathname = pathnameOf(href);
  const params = Object.fromEntries(new URL(href, ORIGIN).searchParams);
  const at = canonicalHref(href);
  if (ask === null || ask.pathname !== pathname) {
    return { pathname, href, params, dims: { ...dims }, trail: [at] };
  }
  return { pathname, href, params, dims: { ...ask.dims, ...dims }, trail: [...ask.trail, at] };
}

/**
 * The ask after the router committed `href`. The newest asked URL: kept, and the older ones
 * forgotten — the router never commits an older navigation after a newer one, so seeing one
 * again would be a link or Back, not a press. An older asked URL: a press landing while a newer
 * one is still in flight, kept. Anything else moved the page under the ask: dropped.
 */
export function afterCommit(ask: PageAsk | null, href: string): PageAsk | null {
  if (ask === null) return null;
  const at = canonicalHref(href);
  if (at === ask.trail.at(-1)) return ask.trail.length === 1 ? ask : { ...ask, trail: [at] };
  return ask.trail.includes(at) ? ask : null;
}

/**
 * True when a navigation starting for `href` is not one a press asked for — a link nobody asked
 * for (a crumb's, the sidebar's), any `router.push` that did not build on the ask — so the page is
 * about to move under it. Every press, range pill, benchmark pick, period link and /recurring tab
 * asks for its URL before it navigates, and is never foreign.
 */
export function isForeign(ask: PageAsk | null, href: string): boolean {
  return ask !== null && !ask.trail.includes(canonicalHref(href));
}

/**
 * The view keys of `his` (what his presses had asked for on `from`, the URL an ask built on) that
 * `href`, the URL it asked for, still holds at the same value: his press put them in `from`, and
 * the ask carried them on. Nothing from a URL of another page, which no ask on `href`'s builds on.
 */
function carriedOn(from: string | null, his: Readonly<ViewState>, href: string): ViewState {
  if (from === null || pathnameOf(from) !== pathnameOf(href)) return {};
  // the first of a repeated key, as the server reads it (`firstParam`)
  const url = new URL(href, ORIGIN).searchParams;
  const out: ViewState = {};
  for (const [key, value] of Object.entries(his)) if (url.get(key) === value) out[key] = value;
  return out;
}

/**
 * What a switcher Back/Forward drew saves again (`PageAsks.backSave`): each dimension of `spec`
 * the page drew from his saved view — one `shown`, the URL Back landed on, does not hold (a value
 * that is no option holds nothing: the server skipped it too) — and, of those it holds, only one
 * a press of his put in that URL (`pressed`: asked for it with, or carried on into it from the
 * URL that ask built on); of its `carry` keys, only one his press put in that URL. Null when that
 * is none.
 *
 * ⚖️ 2026-10-06, by 7b36d72's own rule (a linked view is kept in the URL and never saved; a first
 * load saves nothing): Back never saves a view only the URL held. 🔴 It saved every dimension it
 * drew: a shared `/?chart=bridge`, Grid on the cards, Back — and the bridge became his saved hero
 * view. A view in the URL that his own press put there is his, saved when he pressed it: Table,
 * Graph, Back to the Table saves the Table again (B2). Narrowed to the views his saved one drew
 * alone, the next period drew the Graph under the Table on screen.
 *
 * ❓ That press exception is the session's reading of B2 (owner, 2026-10-05) beside 7b36d72's
 * rule, not words of his: the literal 2026-10-06 rule (only what his saved view drew) flips B2's
 * Forward. Which of the two he wants is his call, still open; until he answers, B2 is kept whole.
 */
export function backSave(
  spec: ViewSpec,
  state: ViewState,
  shown: string | null,
  pressed: Readonly<ViewState>,
  carry: readonly string[] = [],
): ViewState | null {
  // the first of a repeated key, as the server reads it (`firstParam`)
  const url = shown === null ? new URLSearchParams() : new URL(shown, ORIGIN).searchParams;
  const out: ViewState = {};
  for (const dim of spec) {
    const value = state[dim.key];
    const held = url.get(dim.key);
    if (value === undefined) continue;
    if (held === null || !dim.options.includes(held) || pressed[dim.key] === held) out[dim.key] = value;
  }
  // a carried key (the hero's `accts`) only as the URL holds it, and only when a press of his put it
  // there: the page draws every account when neither the URL nor his saved view holds one, and saving
  // that would curate a selection he never made
  for (const key of carry) {
    const held = url.get(key);
    if (held !== null && pressed[key] === held) out[key] = held;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** How a navigation enters the browser's history. */
export type HistoryKind = "push" | "replace";

/** Where a press navigates once its write has landed, and how (`PageAsks.landing`). */
export interface Landing {
  href: string;
  kind: HistoryKind;
  /**
   * false for an asked URL (a mid-page chart stays under the cursor); true for a link made
   * again — Next's default, which every link in the app keeps (none passes `scroll: false`)
   */
  scroll: boolean;
}

/**
 * The page's ask, as one mutable cell the root layout holds and every switcher reads.
 */
export interface PageAsks {
  /**
   * What a press on `at` builds on (`pressBase`): the ask, or — after a link nobody asked for
   * dropped it, until anything is drawn — the ask it dropped (see `departing`).
   */
  base(at: PressTarget): PressBase;
  /**
   * the newest asked URL's params on `pathname` — or the dropped ask's, as `base` — or null when
   * nothing is asked there
   */
  paramsOn(pathname: string): Record<string, string> | null;
  ask(href: string, dims: ViewState): void;
  /** true while `href` is the newest asked URL: nothing asked, followed or gone Back to since */
  isNewest(href: string): boolean;
  /**
   * Where a press navigates once its write has landed.
   *
   * - Something asked: the NEWEST asked URL, which every press and URL writer since built on —
   *   never its own, or a range pill pressed meanwhile would be navigated away from. (An ask
   *   made after any move is newer than the press, and is where the page is going anyway.) A
   *   period link or a /recurring tab is such a writer since 2026-10-06 (`pageLinkHref`): built
   *   on what this press asked for, its page draws the press once drawn again.
   * - A link followed since (the next holding, the sidebar's, a crumb's): that link, made
   *   again as it was made. It carries no view, so its page draws the SAVED one — and the
   *   server may have drawn it before this write landed. 🔴 Nothing drew it again: the pill
   *   un-pressed over a saved choice, a reload showing it. Made again now, its page draws the
   *   press, as it would have had the write landed first (and when it did, that is one more
   *   render of the same page: a push to the URL on screen replaces it). He stays where the
   *   link took him.
   * - Back/Forward since: null. ⚖️ Owner 2026-10-05: Back shows the page he went back to; he
   *   is not dragged anywhere. The press's write still lands — and Back's own save of the view
   *   it shows (`backLanding`), sent after it, is the one that stays.
   */
  landing(): Landing | null;
  /**
   * A push or replace to `href` is starting: one nobody asked for drops the ask. Until anything
   * is drawn, `base`, `paramsOn` and the next `ask` still build on the ask it dropped: the page
   * on screen is still the one that ask was built on, and a press it holds may still be being
   * written. 🔴 Built on the URL on screen, ‹ followed after a crumb's link carried the view a press
   * in flight had replaced, and the press, landing on ‹'s URL, drew that view back.
   */
  departing(href: string, kind: HistoryKind): void;
  /** the router committed `href` (pathname and query): the URL on screen a press starts from */
  committed(href: string): void;
  /** Back/Forward: the page moved under the ask, whatever URL it lands on */
  moved(): void;
  /**
   * The Back/Forward whose page is on screen, numbered from the first: from the commit its URL
   * landed in (`committed`) until he next navigates — a press, a link (their navigation's
   * start) or another Back. Null before any, and from then on: a first load, a link and a
   * press draw no Back's page.
   *
   * ⚖️ Owner 2026-10-05 (B2): Back/Forward RE-SAVES the view of the page he returns to. Back
   * draws that history entry as it was drawn, from before the press he walked away from, while
   * the saved preference is still that press's. 🔴 So anything he pressed next that carries no
   * view in its URL drew the saved one, the view he had left: /investments?range=1Y, Return,
   * Back (Value), 1M → the 1M chart on Return; /spending, cash Table, Back (Chart), Relief → the
   * cash card on Table. Each switcher sends a save of its own, once per landing — what
   * `backSave` keeps of the view Back drew it with — and the action merges each per key.
   *
   * Not only the commit the URL landed in: 🔴 the router draws a page of the same route a
   * commit LATER (its layout router reads the page through `useDeferredValue`, and a restore is
   * urgent), and a save made only in the URL's commit never ran in Chromium.
   */
  backLanding(): number | null;
  /**
   * What a switcher on the page Back landed on saves of the view it drew (`backSave`): the
   * dimensions its saved view drew, and of those the URL holds, the ones a press of his put there —
   * asked for with that URL, or carried on into it by an ask built on a URL his press put them in —
   * never a linked view; and each `carry` key (the hero's `accts`) the URL holds only when a press
   * of his put it there. Null when that is none. 🔴 Without the carried key, Back to an account
   * selection his pill made left the one he had walked away from saved, and the nav link drew it.
   */
  backSave(spec: ViewSpec, state: ViewState, carry?: readonly string[]): ViewState | null;
  /** a switcher's save of the view Back drew (`backSave`) is being written */
  backSaveSent(save: Promise<unknown>): void;
  /**
   * Settles once every save of Back's view sent so far has landed; null when none is being
   * written. ⚖️ B2: a URL writer that writes nothing (a range pill) navigates after it — a
   * navigation overtakes a server action in Next's queue, and 🔴 the pill's page, drawn before
   * Back's save landed, drew the saved view he had walked away from.
   */
  backSavesLanding(): Promise<void> | null;
}

export function createPageAsks(): PageAsks {
  let current: PageAsk | null = null;
  // the newest link followed since one dropped the ask: what a press in flight makes again
  let overtaken: { href: string; kind: HistoryKind } | null = null;
  // the ask that link dropped, until anything is drawn: what the page's writers still build on
  let dropped: PageAsk | null = null;
  // the saves of Back's view still being written
  let backSaves: readonly Promise<void>[] = [];
  // the URL the router last committed, which the switchers' props were rendered for
  let shown: string | null = null;
  // a Back/Forward started and not yet landed; how many have landed; the one on screen
  let traversing = false;
  let landings = 0;
  let back: number | null = null;
  // every URL a press or URL writer asked for, in one spelling: the view keys his presses had
  // asked for when it was (every one was saved by its press), and the ones it kept from the URL it
  // built on that his presses had put there
  const pressed = new Map<string, ViewState>();
  const hisOn = (href: string | null): ViewState =>
    href === null ? {} : (pressed.get(canonicalHref(href)) ?? {});
  // what the page's writers build on: the ask, or the one a link dropped while nothing is drawn
  const building = (): PageAsk | null => current ?? dropped;
  return {
    base: (at) => pressBase(building(), at, shown),
    paramsOn: (pathname) => askedParams(building(), pathname),
    ask(href, dims) {
      // what it built on (`pressBase`): the newest asked URL on its page, or else the one on screen.
      // 🔴 Only the ask's own keys were kept: Return, Value, Back, the 1M pill (on the URL on screen,
      // nothing asked), Value, Back to `?view=returns&range=1M` — Back took his Return for a link's
      // and saved nothing, and the nav link drew the Value. The same with a lens press for the pill.
      const prior = building();
      const same = prior !== null && prior.pathname === pathnameOf(href);
      const from = same ? prior.href : shown;
      // a dropped ask's presses are still asked for (their writes are in flight); its URLs are not
      current = current === null && same ? withAsk(null, href, { ...prior.dims, ...dims }) : withAsk(current, href, dims);
      overtaken = null; // the ask is newer than any link before it
      dropped = null;
      const at = canonicalHref(href);
      pressed.set(at, { ...pressed.get(at), ...carriedOn(from, hisOn(from), href), ...current.dims });
    },
    isNewest: (href) => current !== null && current.trail.at(-1) === canonicalHref(href),
    landing() {
      if (current !== null) return { href: current.href, kind: "push", scroll: false };
      if (overtaken === null) return null;
      // made again to the URL on screen, the link draws no new one: from then, that is the page
      if (shown !== null && canonicalHref(overtaken.href) === canonicalHref(shown)) dropped = null;
      return { ...overtaken, scroll: true };
    },
    departing(href, kind) {
      // a push or replace — a press's, a link's: whatever it draws is not Back's page
      traversing = false;
      back = null;
      // an asked URL leaves the ask be; with nothing asked, only a link since one dropped it counts
      if (current === null ? overtaken === null : !isForeign(current, href)) return;
      if (current !== null) dropped = current;
      current = null;
      overtaken = { href, kind };
    },
    committed(href) {
      shown = href;
      dropped = null; // a page is drawn: from now on, a writer builds on it
      current = afterCommit(current, href);
      if (!traversing) return;
      // Back/Forward landed. A page of another route is drawn in this same commit, after this
      // (the provider's URL reader comes before the page); one of the same route, a commit later.
      traversing = false;
      landings += 1;
      back = landings;
    },
    moved() {
      current = null;
      overtaken = null;
      dropped = null;
      traversing = true;
    },
    backLanding: () => back,
    backSave: (spec, state, carry = []) => backSave(spec, state, shown, hisOn(shown), carry),
    backSaveSent(save) {
      const landed = save.then(
        () => undefined,
        () => undefined,
      );
      backSaves = [...backSaves, landed];
      void landed.then(() => {
        backSaves = backSaves.filter((pending) => pending !== landed);
      });
    },
    backSavesLanding: () => (backSaves.length === 0 ? null : Promise.all(backSaves).then(() => undefined)),
  };
}
