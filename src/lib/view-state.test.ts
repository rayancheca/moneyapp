import { describe, expect, test } from "vitest";
import {
  dimensionDefault,
  resolveViewState,
  setDimension,
  specDefaults,
  viewHrefQuery,
  viewStateToParams,
  type ViewSpec,
} from "./view-state";

// A representative /spending-style spec: chart type (default "bars") + group-by.
const SPEC: ViewSpec = [
  { key: "chart", options: ["bars", "table", "donut"] },
  { key: "group", options: ["category", "merchant"] },
];

describe("dimensionDefault", () => {
  test("is the first option", () => {
    expect(dimensionDefault({ key: "chart", options: ["bars", "table"] })).toBe("bars");
  });

  test("degrades to empty string for a malformed (optionless) dimension, never throws", () => {
    expect(dimensionDefault({ key: "x", options: [] })).toBe("");
  });
});

describe("specDefaults", () => {
  test("every dimension at its first option", () => {
    expect(specDefaults(SPEC)).toEqual({ chart: "bars", group: "category" });
  });
});

describe("resolveViewState", () => {
  test("a valid URL value wins over everything", () => {
    expect(resolveViewState(SPEC, { chart: "table" }, { chart: "donut" })).toEqual({
      chart: "table",
      group: "category",
    });
  });

  test("an invalid URL value falls through to a valid persisted preference", () => {
    expect(resolveViewState(SPEC, { chart: "pie" }, { chart: "donut" })).toEqual({
      chart: "donut",
      group: "category",
    });
  });

  test("both invalid → the spec default (a bad URL never throws)", () => {
    expect(resolveViewState(SPEC, { chart: "pie" }, { chart: "nope" })).toEqual({
      chart: "bars",
      group: "category",
    });
  });

  test("no URL param and a persisted preference → the persisted value", () => {
    expect(resolveViewState(SPEC, {}, { group: "merchant" })).toEqual({
      chart: "bars",
      group: "merchant",
    });
  });

  test("no URL and no persisted → all defaults", () => {
    expect(resolveViewState(SPEC, {}, undefined)).toEqual({ chart: "bars", group: "category" });
  });
});

describe("viewStateToParams", () => {
  test("only non-default dimensions are encoded", () => {
    expect(viewStateToParams(SPEC, { chart: "table", group: "category" })).toEqual({ chart: "table" });
  });

  test("an all-default view encodes to nothing", () => {
    expect(viewStateToParams(SPEC, { chart: "bars", group: "category" })).toEqual({});
  });

  test("invalid values are dropped, valid non-defaults kept", () => {
    expect(viewStateToParams(SPEC, { chart: "pie", group: "merchant" })).toEqual({ group: "merchant" });
  });
});

describe("setDimension", () => {
  const base = { chart: "bars", group: "category" };

  test("changes one dimension immutably", () => {
    const next = setDimension(SPEC, base, "chart", "table");
    expect(next).toEqual({ chart: "table", group: "category" });
    expect(next).not.toBe(base);
  });

  test("an unknown dimension key is a no-op (same reference)", () => {
    expect(setDimension(SPEC, base, "zzz", "x")).toBe(base);
  });

  test("an invalid value is a no-op (same reference)", () => {
    expect(setDimension(SPEC, base, "chart", "pie")).toBe(base);
  });

  test("setting the current value is a no-op (referential stability)", () => {
    expect(setDimension(SPEC, base, "chart", "bars")).toBe(base);
  });
});

describe("viewHrefQuery", () => {
  test("preserves base params and appends non-default view dimensions", () => {
    expect(viewHrefQuery(SPEC, { chart: "table", group: "category" }, { period: "2026-07" })).toBe(
      "?period=2026-07&chart=table",
    );
  });

  test("an all-default view over an empty base is the empty string (clean URL)", () => {
    expect(viewHrefQuery(SPEC, { chart: "bars", group: "category" }, {})).toBe("");
  });

  test("base-only when the view is all default", () => {
    expect(viewHrefQuery(SPEC, { chart: "bars", group: "category" }, { period: "2026-07" })).toBe(
      "?period=2026-07",
    );
  });

  test("skips empty base values and keeps real ones alongside the view dims", () => {
    expect(
      viewHrefQuery(SPEC, { chart: "table", group: "category" }, { period: "", from: "2026-01-01" }),
    ).toBe("?from=2026-01-01&chart=table");
  });
});
