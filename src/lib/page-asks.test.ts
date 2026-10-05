import { describe, expect, test } from "vitest";
import {
  afterCommit,
  askedParams,
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
