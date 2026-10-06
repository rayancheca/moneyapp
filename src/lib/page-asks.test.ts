import { describe, expect, test } from "vitest";
import {
  afterCommit,
  askedParams,
  backSave,
  canonicalHref,
  createPageAsks,
  isForeign,
  pressBase,
  withAsk,
  type PageAsk,
  type PressTarget,
} from "./page-asks";
import type { ViewSpec } from "./view-state";

const SPEC: ViewSpec = [
  { key: "view", options: ["value", "returns"] },
  { key: "lens", options: ["chart", "table"] },
];
const PRICE_CHART = { view: "value", lens: "chart" };
const holding = (over: Partial<PressTarget> = {}): PressTarget => ({
  basePath: "/h",
  spec: SPEC,
  state: PRICE_CHART,
  baseParams: { range: "1Y" },
  carry: [],
  ...over,
});

describe("canonicalHref", () => {
  test("spells one URL one way, whatever order its params were written in", () => {
    expect(canonicalHref("/h?view=returns&range=1M")).toBe(canonicalHref("/h?range=1M&view=returns"));
  });

  test("reads an escaped comma and a bare one alike, as the router and URLSearchParams differ", () => {
    expect(canonicalHref("/?accts=a%2Cb")).toBe(canonicalHref("/?accts=a,b"));
  });

  test("drops an empty query, and keeps an absolute URL's path alone", () => {
    expect(canonicalHref("/h?")).toBe("/h");
    expect(canonicalHref("https://example.test/h?a=1")).toBe("/h?a=1");
  });

  test("tells two values of one param apart", () => {
    expect(canonicalHref("/h?view=returns")).not.toBe(canonicalHref("/h?view=value"));
  });
});

describe("pressBase", () => {
  test("with nothing asked, is the server's view and params, untouched", () => {
    const at = holding();
    const base = pressBase(null, at);
    expect(base).toEqual({ view: PRICE_CHART, params: { range: "1Y" }, asked: false });
    expect(base.view).toBe(at.state);
  });

  test("with nothing asked, adds every other param of the URL on screen, the server's first", () => {
    // another switcher's view only the URL holds; the server's own range wins over the URL's spelling
    const base = pressBase(null, holding(), "/h?cards=grid&range=1M&view=returns&lens=table");
    expect(base).toEqual({ view: PRICE_CHART, params: { range: "1Y", cards: "grid" }, asked: false });
    expect(Object.keys(base.params)).toEqual(["range", "cards"]); // the server's order, then the URL's
  });

  test("with nothing asked, a key the URL repeats is taken as the server reads it, the first", () => {
    expect(pressBase(null, holding(), "/h?cards=grid&cards=deck").params).toEqual({ range: "1Y", cards: "grid" });
  });

  test("with nothing asked, a URL on another page adds nothing", () => {
    expect(pressBase(null, holding(), "/spending?cards=grid").params).toEqual({ range: "1Y" });
  });

  test("with an ask, the URL on screen adds nothing: the asked URL already started from it", () => {
    const ask = withAsk(null, "/h?range=1M&view=returns", { view: "returns" });
    expect(pressBase(ask, holding(), "/h?cards=grid").params).toEqual({ range: "1M" });
  });

  test("with an ask on another page, is the server's", () => {
    const ask = withAsk(null, "/spending?cash=table", { cash: "table" });
    expect(pressBase(ask, holding()).asked).toBe(false);
  });

  test("lays every asked key of this surface over the server's view, and takes the asked URL's other params", () => {
    const ask = withAsk(null, "/h?range=1M&view=returns", { view: "returns", lens: "chart" });
    expect(pressBase(ask, holding())).toEqual({
      view: { view: "returns", lens: "chart" },
      params: { range: "1M" }, // the asked range, not the server's 1Y; never the view's own keys
      asked: true,
    });
  });

  test("keeps the server's value for a dimension no press asked for", () => {
    const ask = withAsk(null, "/h?range=1M", {});
    expect(pressBase(ask, holding()).view).toEqual(PRICE_CHART);
  });

  test("lays a carried key over the view only once a press asked for it", () => {
    const at = holding({ carry: ["accts"] });
    expect(pressBase(withAsk(null, "/h?range=1M", {}), at).view).not.toHaveProperty("accts");
    const ask = withAsk(null, "/h?accts=b", { accts: "b" });
    expect(pressBase(ask, at).view).toMatchObject({ accts: "b" });
    // a carried key rides the params too; the press overwrites it with its own
    expect(pressBase(ask, at).params).toEqual({ accts: "b" });
  });
});

describe("askedParams", () => {
  test("is the newest asked URL's params on its page, and nothing elsewhere", () => {
    const ask = withAsk(null, "/h?view=returns", { view: "returns" });
    expect(askedParams(ask, "/h")).toEqual({ view: "returns" });
    expect(askedParams(ask, "/spending")).toBeNull();
    expect(askedParams(null, "/h")).toBeNull();
  });
});

describe("withAsk", () => {
  test("starts an ask on a page", () => {
    expect(withAsk(null, "/h?view=returns", { view: "returns" })).toEqual({
      pathname: "/h",
      href: "/h?view=returns",
      params: { view: "returns" },
      dims: { view: "returns" },
      trail: ["/h?view=returns"],
    });
  });

  test("on the same page, the newest URL wins and every asked key is kept", () => {
    const first = withAsk(null, "/h?view=returns", { view: "returns" });
    const second = withAsk(first, "/h?view=returns&lens=table", { view: "returns", lens: "table" });
    expect(second.href).toBe("/h?view=returns&lens=table");
    expect(second.dims).toEqual({ view: "returns", lens: "table" });
    expect(second.trail).toEqual(["/h?view=returns", "/h?lens=table&view=returns"]);
  });

  test("on another page, starts over", () => {
    const first = withAsk(null, "/h?view=returns", { view: "returns" });
    expect(withAsk(first, "/spending?cash=table", { cash: "table" }).dims).toEqual({ cash: "table" });
  });
});

describe("afterCommit", () => {
  const a = withAsk(null, "/h?view=returns", {});
  const ab = withAsk(a, "/h?view=returns&lens=table", {});

  test("the newest asked URL landing keeps the ask and forgets the older URLs", () => {
    expect(afterCommit(ab, "/h?lens=table&view=returns")?.trail).toEqual(["/h?lens=table&view=returns"]);
    expect(afterCommit(a, "/h?view=returns")).toBe(a);
  });

  test("an older asked URL landing, while a newer one is in flight, keeps it whole", () => {
    expect(afterCommit(ab, "/h?view=returns")).toBe(ab);
  });

  test("any other URL is the page moving under the ask", () => {
    expect(afterCommit(ab, "/h")).toBeNull();
    expect(afterCommit(ab, "/elsewhere?view=returns")).toBeNull();
    expect(afterCommit(null, "/h")).toBeNull();
  });
});

describe("isForeign", () => {
  test("a URL a press asked for is not; any other is, while something is asked", () => {
    const ask: PageAsk = withAsk(null, "/h?view=returns", {});
    expect(isForeign(ask, "/h?view=returns")).toBe(false);
    expect(isForeign(ask, "/spending")).toBe(true);
    expect(isForeign(null, "/spending")).toBe(false);
  });
});

describe("createPageAsks", () => {
  test("a press navigates to the NEWEST asked URL, and builds on it", () => {
    const asks = createPageAsks();
    expect(asks.landing()).toBeNull();
    asks.ask("/h?view=returns", { view: "returns" });
    asks.ask("/h?view=returns&range=1M", {});
    expect(asks.landing()).toEqual({ href: "/h?view=returns&range=1M", kind: "push", scroll: false });
    expect(asks.paramsOn("/h")).toEqual({ view: "returns", range: "1M" });
    expect(asks.base(holding()).view).toEqual({ view: "returns", lens: "chart" });
  });

  test("Back/Forward drops the ask", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns", {});
    asks.moved();
    expect(asks.landing()).toBeNull();
    expect(asks.paramsOn("/h")).toBeNull();
  });

  test("a navigation nobody asked for drops the ask; one a press asked for does not", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns", {});
    asks.departing("/h?view=returns", "push");
    expect(asks.landing()?.href).toBe("/h?view=returns");
    asks.departing("/spending", "push");
    expect(asks.paramsOn("/h")).toBeNull();
    expect(asks.base(holding()).asked).toBe(false);
  });

  test("with nothing asked, a press builds on the URL the router last committed", () => {
    const asks = createPageAsks();
    expect(asks.base(holding()).params).toEqual({ range: "1Y" }); // nothing committed yet
    asks.committed("/h?cards=grid");
    expect(asks.base(holding()).params).toEqual({ range: "1Y", cards: "grid" });
    asks.committed("/h?bench=QQQ"); // a link, or Back
    expect(asks.base(holding()).params).toEqual({ range: "1Y", bench: "QQQ" });
  });

  test("a commit of an asked URL keeps the ask; any other drops it", () => {
    const asks = createPageAsks();
    asks.committed("/h"); // nothing asked: nothing to drop
    expect(asks.landing()).toBeNull();
    asks.ask("/h?view=returns", {});
    asks.committed("/h?view=returns");
    expect(asks.landing()?.href).toBe("/h?view=returns");
    asks.committed("/h");
    expect(asks.landing()).toBeNull();
  });
});

describe("createPageAsks: a link followed while a press is being written", () => {
  test("the press makes the link again once its write lands, as the link was made", () => {
    const asks = createPageAsks();
    asks.ask("/spending?period=2026-07&cash=table", { cash: "table" });
    asks.departing("/spending?period=2026-06", "push");
    expect(asks.landing()).toEqual({ href: "/spending?period=2026-06", kind: "push", scroll: true });
  });

  test("a replace is made again as a replace", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns", {});
    asks.departing("/h/b", "replace");
    expect(asks.landing()).toEqual({ href: "/h/b", kind: "replace", scroll: true });
  });

  test("of two links, the newest; and making it again leaves it the newest", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns", {});
    asks.departing("/h/b", "push");
    asks.departing("/h/c", "push");
    expect(asks.landing()?.href).toBe("/h/c");
    asks.departing("/h/c", "push"); // the press making it again
    expect(asks.landing()?.href).toBe("/h/c");
  });

  test("a press made after the link is newer: its URL, and the link is forgotten", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns", {});
    asks.departing("/h/b", "push");
    asks.ask("/h?unit=percent", {});
    expect(asks.landing()).toEqual({ href: "/h?unit=percent", kind: "push", scroll: false });
    asks.committed("/h/redirected"); // the page moved under that ask with nothing announced
    expect(asks.landing()).toBeNull();
  });

  test("Back after the link: nothing is made again", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns", {});
    asks.departing("/h/b", "push");
    asks.moved();
    expect(asks.landing()).toBeNull();
    asks.departing("/h/c", "push"); // a link after Back, with nothing asked since: nothing to redo
    expect(asks.landing()).toBeNull();
  });

  test("a link with nothing ever asked is nothing to redo", () => {
    const asks = createPageAsks();
    asks.departing("/spending", "push");
    expect(asks.landing()).toBeNull();
  });
});

describe("createPageAsks: the Back/Forward whose page is on screen", () => {
  test("lands with its URL, and stays until he next navigates", async () => {
    const asks = createPageAsks();
    asks.committed("/h?view=returns");
    asks.moved();
    expect(asks.backLanding()).toBeNull(); // started, not landed
    asks.committed("/h");
    expect(asks.backLanding()).toBe(1);
    await Promise.resolve(); // the page of the same route is drawn a commit later
    expect(asks.backLanding()).toBe(1);
    asks.departing("/h?unit=percent", "push"); // a press's navigation, or a link
    expect(asks.backLanding()).toBeNull();
  });

  test("every Back/Forward is a landing of its own", () => {
    const asks = createPageAsks();
    asks.moved();
    asks.committed("/h");
    asks.moved();
    asks.committed("/h?view=returns");
    expect(asks.backLanding()).toBe(2);
  });

  test("a later commit with no navigation, a redirect, is the same landing", () => {
    const asks = createPageAsks();
    asks.moved();
    asks.committed("/h");
    asks.committed("/h?unit=percent");
    expect(asks.backLanding()).toBe(1);
  });

  test("a first load, a press landing and a link are none", () => {
    const asks = createPageAsks();
    asks.committed("/h"); // the first load
    expect(asks.backLanding()).toBeNull();
    asks.ask("/h?view=returns", { view: "returns" });
    asks.departing("/h?view=returns", "push");
    asks.committed("/h?view=returns"); // the press landing
    expect(asks.backLanding()).toBeNull();
    asks.departing("/spending", "push");
    asks.committed("/spending"); // a link
    expect(asks.backLanding()).toBeNull();
  });

  test("a link started after Back, before it landed, is the next commit: none", () => {
    const asks = createPageAsks();
    asks.moved();
    asks.departing("/spending", "push");
    asks.committed("/spending");
    expect(asks.backLanding()).toBeNull();
  });
});

describe("backSave", () => {
  test("saves every dimension the URL on screen does not hold: the page drew it from the saved one", () => {
    expect(backSave(SPEC, PRICE_CHART, "/h?range=1Y", {})).toEqual({ view: "value", lens: "chart" });
  });

  test("never one the URL holds that no press of his asked for there: a link's", () => {
    expect(backSave(SPEC, { view: "returns", lens: "chart" }, "/h?view=returns", {})).toEqual({ lens: "chart" });
  });

  test("one the URL holds is his when a press asked for that URL with that value", () => {
    const state = { view: "returns", lens: "table" };
    expect(backSave(SPEC, state, "/h?view=returns&lens=table", { lens: "table" })).toEqual({ lens: "table" });
    expect(backSave(SPEC, state, "/h?view=returns&lens=table", { view: "value", lens: "table" })).toEqual({
      lens: "table",
    });
  });

  test("a value the URL holds that is no option is not held: the page drew the saved one", () => {
    expect(backSave(SPEC, PRICE_CHART, "/h?view=garbage&lens=chart", {})).toEqual({ view: "value" });
  });

  test("reads the first of a repeated key, as the server does", () => {
    expect(backSave(SPEC, { view: "returns", lens: "chart" }, "/h?view=returns&view=garbage", {})).toEqual({
      lens: "chart",
    });
    expect(backSave(SPEC, PRICE_CHART, "/h?view=garbage&view=returns", {})).toEqual(PRICE_CHART);
  });

  test("is null when the URL holds every dimension and he asked for none of them", () => {
    expect(backSave(SPEC, { view: "returns", lens: "table" }, "/h?view=returns&lens=table", {})).toBeNull();
  });
});

describe("createPageAsks: what Back's page re-saves", () => {
  test("a dimension the URL Back landed on holds, only when a press of his asked for that URL", () => {
    const asks = createPageAsks();
    asks.committed("/h?view=returns"); // opened by a link: Return is the link's
    asks.ask("/h?view=returns&lens=table", { view: "returns", lens: "table" }); // he presses Table
    asks.departing("/h?view=returns&lens=table", "push");
    asks.committed("/h?view=returns&lens=table");
    asks.moved();
    asks.committed("/h?view=returns"); // Back to the link
    expect(asks.backSave(SPEC, { view: "returns", lens: "chart" })).toEqual({ lens: "chart" });

    asks.moved();
    asks.committed("/h?lens=table&view=returns"); // Forward to his press, in another spelling
    expect(asks.backSave(SPEC, { view: "returns", lens: "table" })).toEqual({ view: "returns", lens: "table" });
  });

  test("a press asked on a linked view holds his own keys only: another switcher's stays the link's", () => {
    const asks = createPageAsks();
    asks.committed("/?chart=bridge");
    asks.ask("/?chart=bridge&cards=grid", { cards: "grid" });
    asks.departing("/?chart=bridge&cards=grid", "push");
    asks.committed("/?chart=bridge&cards=grid");
    asks.departing("/elsewhere", "push");
    asks.committed("/elsewhere");
    asks.moved();
    asks.committed("/?chart=bridge&cards=grid");
    const hero: ViewSpec = [{ key: "chart", options: ["combined", "bridge"] }];
    const cards: ViewSpec = [{ key: "cards", options: ["deck", "grid"] }];
    expect(asks.backSave(hero, { chart: "bridge" })).toBeNull();
    expect(asks.backSave(cards, { cards: "grid" })).toEqual({ cards: "grid" });
  });

  /** with nothing asked an ask builds on the URL on screen, and its views his presses put there are his */
  test("an ask built on the URL on screen keeps his presses' views there that its URL still holds", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns&lens=table", { view: "returns", lens: "table" });
    asks.departing("/h?view=returns&lens=table", "push");
    asks.committed("/h?view=returns&lens=table");
    asks.moved();
    asks.committed("/h?lens=table&view=returns"); // Back to his press, nothing asked any more
    asks.ask("/h?view=returns&lens=table&range=1M", {}); // the range pill, on the URL on screen
    asks.departing("/h?view=returns&lens=table&range=1M", "replace");
    asks.committed("/h?view=returns&lens=table&range=1M");
    asks.ask("/h?view=returns&range=1M", { view: "returns", lens: "chart" }); // Chart, on the ask
    asks.departing("/h?view=returns&range=1M", "push");
    asks.committed("/h?view=returns&range=1M");

    asks.moved();
    asks.committed("/h?view=returns&lens=table&range=1M"); // Back to the pill's page
    expect(asks.backSave(SPEC, { view: "returns", lens: "table" })).toEqual({ view: "returns", lens: "table" });
  });

  test("and carries them on through every ask built on it", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns", { view: "returns" });
    asks.moved();
    asks.committed("/h?view=returns");
    asks.ask("/h?view=returns&range=1M", {}); // on the URL on screen
    asks.ask("/h?view=returns&range=3M", {}); // on that ask
    asks.ask("/h?view=returns&range=3M&lens=table", { lens: "table" }); // on that one
    asks.moved();
    asks.committed("/h?view=returns&range=3M&lens=table");
    expect(asks.backSave(SPEC, { view: "returns", lens: "table" })).toEqual({ view: "returns", lens: "table" });
  });

  test("never a linked one, nor his once an ask changed it, though an ask on that one puts it back", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns&lens=table", { view: "returns" }); // his Return, on a linked Table
    asks.moved();
    asks.committed("/h?view=returns&lens=table");
    asks.ask("/h?view=value&lens=table&range=1M", {}); // a writer that changed his view…
    asks.ask("/h?view=returns&lens=table&range=3M", {}); // …and one on it that put it back
    asks.moved();
    asks.committed("/h?view=value&lens=table&range=1M");
    expect(asks.backSave(SPEC, { view: "value", lens: "table" })).toBeNull();
    asks.moved();
    asks.committed("/h?view=returns&lens=table&range=3M");
    expect(asks.backSave(SPEC, { view: "returns", lens: "table" })).toBeNull();
  });

  test("nor one held by a URL on screen of another page", () => {
    const asks = createPageAsks();
    asks.ask("/h/b?view=returns", { view: "returns" });
    asks.moved();
    asks.committed("/h/b?view=returns");
    asks.ask("/h?view=returns&range=1M", {}); // not built on /h/b: nothing of it carries
    asks.moved();
    asks.committed("/h?view=returns&range=1M");
    expect(asks.backSave(SPEC, { view: "returns", lens: "chart" })).toEqual({ lens: "chart" });
  });

  test("two asks of one URL each add the keys they asked for", () => {
    const asks = createPageAsks();
    asks.ask("/h?view=returns&lens=table", { view: "returns" });
    asks.departing("/elsewhere", "push"); // a link drops that ask
    asks.ask("/h?view=returns&lens=table", { lens: "table" });
    asks.moved();
    asks.committed("/h?view=returns&lens=table");
    expect(asks.backSave(SPEC, { view: "returns", lens: "table" })).toEqual({ view: "returns", lens: "table" });
  });
});
