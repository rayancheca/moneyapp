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
 * mounted once in the root layout — never a module-level cache, which would outlive the page),
 * and dropped the moment the server state moves under it by anything that is not a press:
 * Back/Forward, a link, another page. A commit of a URL a press asked for is a press landing,
 * not a move.
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
   * every other param of the URL on screen (another switcher's view only the URL holds)
   */
  params: Record<string, string>;
  /** true when built on an ask (a press may be in flight), false when on the server's view */
  asked: boolean;
}

/** Any origin: hrefs here are same-origin paths, and URL needs one to parse them. */
const ORIGIN = "http://page-asks.invalid";

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
 * screen, in its order — never this surface's own dimensions, which the press writes itself. A
 * URL on another page (one not committed yet) adds nothing.
 */
function onScreen(at: PressTarget, own: ReadonlySet<string>, shown: string | null): Record<string, string> {
  if (shown === null || pathnameOf(shown) !== pathnameOf(at.basePath)) return at.baseParams;
  const params: Record<string, string> = { ...at.baseParams };
  for (const [key, value] of new URL(shown, ORIGIN).searchParams) {
    // the first of a repeated key, as the server reads it (`firstParam`)
    if (!own.has(key) && !Object.hasOwn(params, key)) params[key] = value;
  }
  return params;
}

/**
 * What a press on `at` builds on. With no ask on its page, the server's view, and its params
 * with every other param of `shown` (the URL on screen) beside them. With one, the newest
 * asked URL's params (minus this surface's own dimensions, which the press writes itself) and
 * the server's view with every key a press asked for laid over it — the asked URL already
 * started from the one on screen.
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
    if (!own.has(key)) params[key] = value;
  }
  return { view, params, asked: true };
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
 * True when a navigation starting for `href` is not one a press asked for — a link, the period
 * picker, any `router.push` that did not build on the ask — so the page is about to move under
 * it. Every press, range pill and benchmark pick asks for its URL before it navigates.
 */
export function isForeign(ask: PageAsk | null, href: string): boolean {
  return ask !== null && !ask.trail.includes(canonicalHref(href));
}

/**
 * What a switcher Back/Forward drew saves again (`PageAsks.backSave`): each dimension of `spec`
 * the page drew from his saved view — one `shown`, the URL Back landed on, does not hold (a value
 * that is no option holds nothing: the server skipped it too) — and, of those it holds, only one
 * a press of his asked for that URL with (`pressed`). Null when that is none.
 *
 * ⚖️ 2026-10-06, by 7b36d72's own rule (a linked view is kept in the URL and never saved; a first
 * load saves nothing): Back never saves a view only the URL held. 🔴 It saved every dimension it
 * drew: a shared `/?chart=bridge`, Grid on the cards, Back — and the bridge became his saved hero
 * view. A view in the URL that his own press asked for is his, saved when he pressed it: Table,
 * Graph, Back to the Table saves the Table again (B2). Narrowed to the views his saved one drew
 * alone, the next period drew the Graph under the Table on screen.
 */
export function backSave(
  spec: ViewSpec,
  state: ViewState,
  shown: string | null,
  pressed: Readonly<ViewState>,
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
  base(at: PressTarget): PressBase;
  /** the newest asked URL's params on `pathname`, or null when nothing is asked there */
  paramsOn(pathname: string): Record<string, string> | null;
  ask(href: string, dims: ViewState): void;
  /**
   * Where a press navigates once its write has landed.
   *
   * - Something asked: the NEWEST asked URL, which every press and URL writer since built on —
   *   never its own, or a range pill pressed meanwhile would be navigated away from. (An ask
   *   made after any move is newer than the press, and is where the page is going anyway.)
   * - A link followed since (the period picker, a /recurring tab, the next holding): that link,
   *   made again as it was made. It carries no view, so its page draws the SAVED one — and the
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
  /** a push or replace to `href` is starting: one nobody asked for drops the ask */
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
   * dimensions its saved view drew, and of those the URL holds, the ones a press of his asked for
   * that URL with — never a linked view. Null when that is none.
   */
  backSave(spec: ViewSpec, state: ViewState): ViewState | null;
}

export function createPageAsks(): PageAsks {
  let current: PageAsk | null = null;
  // the newest link followed since one dropped the ask: what a press in flight makes again
  let overtaken: { href: string; kind: HistoryKind } | null = null;
  // the URL the router last committed, which the switchers' props were rendered for
  let shown: string | null = null;
  // a Back/Forward started and not yet landed; how many have landed; the one on screen
  let traversing = false;
  let landings = 0;
  let back: number | null = null;
  // every URL a press or URL writer asked for, in one spelling: the view keys his presses had
  // asked for when it was (they are all in it, and every one was saved by its press)
  const pressed = new Map<string, ViewState>();
  return {
    base: (at) => pressBase(current, at, shown),
    paramsOn: (pathname) => askedParams(current, pathname),
    ask(href, dims) {
      current = withAsk(current, href, dims);
      overtaken = null; // the ask is newer than any link before it
      const at = canonicalHref(href);
      pressed.set(at, { ...pressed.get(at), ...current.dims });
    },
    landing() {
      if (current !== null) return { href: current.href, kind: "push", scroll: false };
      return overtaken === null ? null : { ...overtaken, scroll: true };
    },
    departing(href, kind) {
      // a push or replace — a press's, a link's: whatever it draws is not Back's page
      traversing = false;
      back = null;
      // an asked URL leaves the ask be; with nothing asked, only a link since one dropped it counts
      if (current === null ? overtaken === null : !isForeign(current, href)) return;
      current = null;
      overtaken = { href, kind };
    },
    committed(href) {
      shown = href;
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
      traversing = true;
    },
    backLanding: () => back,
    backSave: (spec, state) =>
      backSave(spec, state, shown, shown === null ? {} : (pressed.get(canonicalHref(shown)) ?? {})),
  };
}
