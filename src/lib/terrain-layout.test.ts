import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { balanceAnchors } from "@/db/schema/balances";
import { institutions } from "@/db/schema/institutions";
import { transactions } from "@/db/schema/transactions";
import { dedupeHash } from "@/lib/hash";
import { addDays } from "@/lib/dates";
import { createAccount } from "@/services/accounts";
import { dashboardChartData } from "@/services/dashboard-series";
import { netWorthSeries, rebuildAccount } from "@/services/derivation";
import { bridgedNetWorthSeries } from "@/services/in-flight";
import {
  TERRAIN_VIEWPOINTS,
  computeTerrainLayout,
  nearestVertex,
  pointsAttr,
  reconcileTerrain,
  ribbonsFromSeries,
  sampleIndices,
  terrainColor,
  unionDays,
  type TerrainLayoutOptions,
  type TerrainRibbonInput,
} from "./terrain-layout";

/**
 * The terrain is a money figure before it is a drawing, so the reconciliation
 * tests come first — including one against the REAL services, because the whole
 * claim of this chart is that its nine ribbons add up to the net-worth line
 * above it. The geometry tests then pin the encodings (height = balance, depth =
 * account, below the rule = owed), the two honesty rules (an unverified span is
 * never drawn as a surface; a broken debt scale is always stated), and the
 * determinism the visual baselines depend on.
 */

const OPTS: TerrainLayoutOptions = {
  width: 720,
  height: 320,
  camera: TERRAIN_VIEWPOINTS.quarter,
};

function ribbon(over: Partial<TerrainRibbonInput> & { id: string }): TerrainRibbonInput {
  return {
    label: over.id,
    isLiability: false,
    points: [
      { day: "2026-01-01", valueCents: 100_000, verified: true },
      { day: "2026-01-02", valueCents: 120_000, verified: true },
      { day: "2026-01-03", valueCents: 140_000, verified: true },
    ],
    ...over,
  };
}

/** two assets and a card — one of every sign */
const RIBBONS: TerrainRibbonInput[] = [
  ribbon({ id: "checking", label: "Chase Checking" }),
  ribbon({
    id: "savings",
    label: "SoFi Savings",
    points: [
      { day: "2026-01-01", valueCents: 40_000, verified: true },
      { day: "2026-01-02", valueCents: 41_000, verified: true },
      { day: "2026-01-03", valueCents: 42_000, verified: true },
    ],
  }),
  ribbon({
    id: "card",
    label: "Venture X",
    isLiability: true,
    points: [
      { day: "2026-01-01", valueCents: -5_000, verified: true },
      { day: "2026-01-02", valueCents: -6_000, verified: true },
      { day: "2026-01-03", valueCents: -4_000, verified: true },
    ],
  }),
];

/** two years of daily coverage — a real axis, for the tick and sampling tests */
const LONG_POINTS = Array.from({ length: 730 }, (_, i) => ({
  day: addDays("2024-08-01", i),
  valueCents: 100_000 + i * 37,
  verified: true,
}));

function ribbonById(layout: ReturnType<typeof computeTerrainLayout>, id: string) {
  const found = layout.ribbons.find((r) => r.id === id);
  if (!found) throw new Error(`no ribbon ${id}`);
  return found;
}

// ── Reconciliation, against the real services ────────────────────────

describe("the terrain reconciles with the net-worth series it is drawn beside", () => {
  const TODAY = "2026-07-08";
  let dir: string;
  let bundle: DbBundle;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-terrain-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function institutionId(name: string): string {
    const row = bundle.db.select().from(institutions).where(eq(institutions.name, name)).get();
    if (!row) throw new Error(`missing institution ${name}`);
    return row.id;
  }

  function anchor(accountId: string, anchoredOn: string, balanceCents: number): void {
    bundle.db.insert(balanceAnchors).values({ accountId, anchoredOn, balanceCents, source: "statement" }).run();
  }

  function txn(accountId: string, postedOn: string, amountCents: number, gid: string | null): void {
    const raw = `T-${accountId.slice(0, 4)}-${postedOn}-${amountCents}`;
    bundle.db
      .insert(transactions)
      .values({
        accountId,
        postedOn,
        amountCents,
        rawDescription: raw,
        normalizedDescription: raw,
        status: "active",
        transferGroupId: gid,
        dedupeHash: dedupeHash({ accountId, postedOn, amountCents, rawDescription: raw, occurrenceIndex: 0 }),
      })
      .run();
  }

  /** checking + savings with a different-day $100 transfer pair, plus a card */
  function fixture() {
    const a = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "A", type: "checking" });
    const b = createAccount(bundle.db, { institutionId: institutionId("SoFi"), name: "B", type: "savings" });
    const card = createAccount(bundle.db, { institutionId: institutionId("Chase"), name: "Card", type: "credit" });
    anchor(a, "2026-07-01", 100_000);
    anchor(a, "2026-07-05", 90_000);
    anchor(b, "2026-07-01", 50_000);
    anchor(b, "2026-07-05", 60_000);
    anchor(card, "2026-07-01", -20_000);
    txn(a, "2026-07-02", -10_000, "g1");
    txn(b, "2026-07-04", 10_000, "g1");
    for (const id of [a, b, card]) rebuildAccount(bundle.db, id, TODAY);
    return { a, b, card };
  }

  /** exactly what the component feeds the geometry */
  function terrainRibbons(): TerrainRibbonInput[] {
    return ribbonsFromSeries(dashboardChartData(bundle.db, "accounts").series);
  }

  test("the summed ribbons equal the net-worth series, to the cent, at sampled days", () => {
    // Arrange
    fixture();
    const ribbons = terrainRibbons();
    const raw = netWorthSeries(bundle.db);
    const sampled = sampleIndices(raw.length, 12).map((i) => raw[i]!);
    expect(sampled.length).toBeGreaterThan(4);

    // Act + Assert — day by day, no tolerance
    let complete = 0;
    for (const point of sampled) {
      if (!point.complete) continue;
      complete += 1;
      let total = 0;
      for (const r of ribbons) {
        const found = r.points.find((p) => p.day === point.day);
        if (found) total += found.valueCents;
      }
      expect(total, `net worth disagrees on ${point.day}`).toBe(point.totalCents);
    }
    expect(complete).toBeGreaterThan(0);
  });

  test("reconcileTerrain balances against the BRIDGED series the hero chart draws", () => {
    fixture();
    const reference = bridgedNetWorthSeries(bundle.db);
    // the fixture's transfer pair really does put money in the air, so the
    // in-flight subtraction below is exercised, not hypothetically correct
    expect(reference.some((p) => p.inTransitCents !== 0)).toBe(true);

    const check = reconcileTerrain(terrainRibbons(), reference);

    expect(check.residuals).toEqual([]);
    expect(check.balanced).toBe(true);
    expect(check.checkedDays).toBeGreaterThan(0);
  });

  test("a ribbon dropped from the figure is caught, never silently absorbed", () => {
    const { card } = fixture();
    const short = terrainRibbons().filter((r) => r.id !== card);

    const check = reconcileTerrain(short, bridgedNetWorthSeries(bundle.db));

    expect(check.balanced).toBe(false);
    // the card is owed money, so dropping it OVERSTATES the terrain
    expect(check.worstResidualCents).toBeGreaterThan(0);
    expect(check.residuals[0]?.residualCents).toBe(20_000);
  });

  test("the real series draws as a terrain: ribbons, columns, a plane and a today", () => {
    const { a } = fixture();
    const ribbons = terrainRibbons();
    const layout = computeTerrainLayout(ribbons, OPTS);

    expect(layout.ribbonCount).toBe(ribbons.length);
    expect(layout.columnCount).toBeGreaterThan(1);
    expect(layout.plane).not.toBeNull();
    expect(layout.lastDay).toBe(TODAY);
    // today's net worth is the ledger's, summed from the ribbons themselves
    expect(layout.totalLatestCents).toBe(netWorthSeries(bundle.db).at(-1)!.totalCents);
    expect(layout.assetsLatestCents - layout.owedLatestCents).toBe(layout.totalLatestCents);
    expect(ribbonById(layout, a).lastCents).toBe(90_000);
  });
});

// ── reconcileTerrain, in the pure ─────────────────────────────────────

describe("reconcileTerrain", () => {
  const REF = [
    { day: "2026-01-01", totalCents: 135_000, complete: true },
    { day: "2026-01-02", totalCents: 155_000, complete: true },
    { day: "2026-01-03", totalCents: 178_000, complete: true },
  ];

  test("balances when every ribbon's day sums to the series' total", () => {
    const check = reconcileTerrain(RIBBONS, REF);
    expect(check).toEqual({
      balanced: true,
      checkedDays: 3,
      skippedDays: 0,
      residuals: [],
      worstResidualCents: 0,
    });
  });

  test("subtracts the in-flight bridge — money in the air is in no account's ledger", () => {
    const bridged = [{ day: "2026-01-02", totalCents: 165_000, complete: true, inTransitCents: 10_000 }];
    expect(reconcileTerrain(RIBBONS, bridged).balanced).toBe(true);
    // the same day WITHOUT the bridge stated is a real disagreement
    const unstated = [{ day: "2026-01-02", totalCents: 165_000, complete: true }];
    expect(reconcileTerrain(RIBBONS, unstated).residuals[0]?.residualCents).toBe(-10_000);
  });

  test("skips the days the series itself calls partial, and says how many", () => {
    const check = reconcileTerrain(RIBBONS, [
      { day: "2026-01-01", totalCents: 999_999, complete: false },
      { day: "2026-01-02", totalCents: 155_000, complete: true },
    ]);
    expect(check.skippedDays).toBe(1);
    expect(check.checkedDays).toBe(1);
    expect(check.balanced).toBe(true);
  });

  test("an account that covers nothing that day contributes nothing — and it shows", () => {
    // the series calls 01-04 complete, but no ribbon reaches it: the terrain
    // must NOT invent a carried balance to make the sum come out
    const check = reconcileTerrain(RIBBONS, [{ day: "2026-01-04", totalCents: 178_000, complete: true }]);
    expect(check.checkedDays).toBe(1);
    expect(check.residuals[0]).toEqual({
      day: "2026-01-04",
      terrainCents: 0,
      referenceCents: 178_000,
      residualCents: -178_000,
    });
  });

  test("reports every disagreement and keeps the worst one by magnitude", () => {
    const check = reconcileTerrain(RIBBONS, [
      { day: "2026-01-01", totalCents: 135_100, complete: true },
      { day: "2026-01-02", totalCents: 100_000, complete: true },
      { day: "2026-01-03", totalCents: 178_000, complete: true },
    ]);
    expect(check.balanced).toBe(false);
    expect(check.residuals.map((r) => r.day)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(check.residuals[0]).toEqual({
      day: "2026-01-01",
      terrainCents: 135_000,
      referenceCents: 135_100,
      residualCents: -100,
    });
    expect(check.worstResidualCents).toBe(55_000);
  });
});

// ── ribbonsFromSeries ────────────────────────────────────────────────

describe("ribbonsFromSeries", () => {
  const SERIES = [
    {
      key: "chk",
      label: "Checking",
      owedFrame: false,
      points: [
        { day: "2026-01-01", valueCents: 100_000, complete: true },
        { day: "2026-01-02", valueCents: null, complete: false },
        { day: "2026-01-03", valueCents: 90_000, complete: false },
      ],
    },
    {
      key: "card",
      label: "Card",
      owedFrame: true,
      points: [{ day: "2026-01-01", valueCents: 5_000, complete: true }],
    },
  ];

  test("negates the owed frame so the cards extrude BELOW the rule", () => {
    const [, card] = ribbonsFromSeries(SERIES);
    expect(card!.isLiability).toBe(true);
    expect(card!.points).toEqual([{ day: "2026-01-01", valueCents: -5_000, verified: true }]);
  });

  test("drops an uncovered day instead of drawing a zero balance nobody claimed", () => {
    const [checking] = ribbonsFromSeries(SERIES);
    expect(checking!.points.map((p) => p.day)).toEqual(["2026-01-01", "2026-01-03"]);
    // and an incomplete day arrives UNVERIFIED, for the geometry to break
    expect(checking!.points.at(-1)!.verified).toBe(false);
  });

  test("takes the caller's identity colours, and falls back to the shared ramp", () => {
    expect(ribbonsFromSeries(SERIES, { chk: "var(--x)" })[0]!.color).toBe("var(--x)");
    expect(ribbonsFromSeries(SERIES)[0]!.color).toBe(terrainColor(0));
  });
});

// ── The two honesty rules ────────────────────────────────────────────

describe("an unverified span is never drawn as a surface", () => {
  test("a run the ledger could not verify becomes its own broken segment", () => {
    const layout = computeTerrainLayout(
      [
        ribbon({
          id: "chk",
          points: [
            { day: "2026-01-01", valueCents: 100_000, verified: true },
            { day: "2026-01-02", valueCents: 100_000, verified: false },
            { day: "2026-01-03", valueCents: 140_000, verified: true },
          ],
        }),
      ],
      OPTS,
    );

    const r = ribbonById(layout, "chk");
    // 01-01→01-02 unverified, 01-02→01-03 unverified: ONE broken run, no
    // verified surface anywhere near the hole
    expect(r.segments.map((s) => s.verified)).toEqual([false]);
    expect(r.unverifiedSpanCount).toBe(2);
    expect(r.fullyVerified).toBe(false);
    expect(layout.unverifiedSpanCount).toBe(2);
  });

  test("verified and unverified spans split into separate segments, in order", () => {
    const layout = computeTerrainLayout(
      [
        ribbon({
          id: "chk",
          points: [
            { day: "2026-01-01", valueCents: 100_000, verified: true },
            { day: "2026-01-02", valueCents: 110_000, verified: true },
            { day: "2026-01-03", valueCents: 120_000, verified: false },
            { day: "2026-01-04", valueCents: 130_000, verified: true },
            { day: "2026-01-05", valueCents: 140_000, verified: true },
          ],
        }),
      ],
      OPTS,
    );

    const r = ribbonById(layout, "chk");
    expect(r.segments.map((s) => s.verified)).toEqual([true, false, true]);
    // the verified segments are real curtains, the broken one is too — the
    // difference is what the renderer is told, never a missing polygon
    expect(r.segments.every((s) => s.face.length >= 4)).toBe(true);
    expect(r.segments[0]!.crest).toHaveLength(2);
    expect(r.segments[1]!.crest).toHaveLength(3); // 01-02→01-03→01-04
  });

  test("SAMPLING CANNOT HIDE A HOLE: an unverified day between two columns breaks the span", () => {
    // 41 days, sampled down to 3 columns (day 0, 20, 40). The unverified day is
    // day 10 — invisible to the columns themselves. A naive sampler would draw
    // a smooth verified surface straight over the span derivation refused.
    const points = Array.from({ length: 41 }, (_, i) => ({
      day: addDays("2026-01-01", i),
      valueCents: 100_000 + i,
      verified: i !== 10,
    }));

    const layout = computeTerrainLayout([ribbon({ id: "chk", points })], {
      ...OPTS,
      maxColumns: 3,
    });

    const r = ribbonById(layout, "chk");
    expect(layout.columnDays).toEqual(["2026-01-01", "2026-01-21", "2026-02-10"]);
    expect(r.segments.map((s) => s.verified)).toEqual([false, true]);
    expect(r.unverifiedSpanCount).toBe(1);
  });

  test("a hole in coverage breaks the ribbon — the two sides are never bridged", () => {
    const layout = computeTerrainLayout(
      [
        ribbon({
          id: "chk",
          points: [
            { day: "2026-01-01", valueCents: 100_000, verified: true },
            { day: "2026-01-02", valueCents: 110_000, verified: true },
            // 01-03 absent: this account covers nothing that day
            { day: "2026-01-04", valueCents: 130_000, verified: true },
            { day: "2026-01-05", valueCents: 140_000, verified: true },
          ],
        }),
        ribbon({
          id: "other",
          points: [{ day: "2026-01-03", valueCents: 1_000, verified: true }],
        }),
      ],
      OPTS,
    );

    const r = ribbonById(layout, "chk");
    expect(r.segments).toHaveLength(2);
    expect(r.segments.every((s) => s.verified)).toBe(true);
    expect(r.vertices.map((v) => v.day)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-04",
      "2026-01-05",
    ]);
  });

  test("a single covered day is a mark, not a curtain", () => {
    const layout = computeTerrainLayout(
      [
        ribbon({ id: "chk", points: [{ day: "2026-01-01", valueCents: 100_000, verified: true }] }),
        ribbon({ id: "empty", points: [] }),
      ],
      OPTS,
    );

    expect(ribbonById(layout, "chk").segments).toEqual([]);
    expect(ribbonById(layout, "chk").vertices).toHaveLength(1);
    const empty = ribbonById(layout, "empty");
    expect(empty).toMatchObject({
      segments: [],
      vertices: [],
      firstDay: null,
      lastDay: null,
      firstCents: 0,
      lastCents: 0,
      deltaCents: 0,
      fullyVerified: true,
    });
  });
});

describe("the debt scale is broken out loud, or not at all", () => {
  test("a card worth ~1% of the assets gets its own scale, and the factor is stated", () => {
    const layout = computeTerrainLayout(RIBBONS, OPTS);
    expect(layout.maxAssetCents).toBe(140_000);
    expect(layout.minLiabilityCents).toBe(-6_000);
    expect(layout.debtMultiple).not.toBeNull();
    expect(layout.debtMultiple!).toBeGreaterThan(1);
  });

  test("no break when the debt already reads at the assets' own scale", () => {
    const layout = computeTerrainLayout(
      [
        ribbon({ id: "chk", points: [{ day: "2026-01-01", valueCents: 100_000, verified: true }] }),
        ribbon({
          id: "loan",
          isLiability: true,
          points: [{ day: "2026-01-01", valueCents: -900_000, verified: true }],
        }),
      ],
      OPTS,
    );
    expect(layout.debtMultiple).toBe(1);
  });

  test("nothing to break: no debt at all, or no assets to break it against", () => {
    expect(computeTerrainLayout(RIBBONS.slice(0, 2), OPTS).debtMultiple).toBeNull();
    const owedOnly = computeTerrainLayout(
      [
        ribbon({
          id: "card",
          isLiability: true,
          points: [{ day: "2026-01-01", valueCents: -5_000, verified: true }],
        }),
      ],
      OPTS,
    );
    expect(owedOnly.debtMultiple).toBeNull();
    expect(owedOnly.valueTicks.map((t) => t.valueCents)).toEqual([0, -5_000]);
  });
});

// ── The encodings ────────────────────────────────────────────────────

describe("computeTerrainLayout encodings", () => {
  test("assets rise ABOVE the zero plane and liabilities extrude BELOW it, at every viewpoint", () => {
    for (const [name, camera] of Object.entries(TERRAIN_VIEWPOINTS)) {
      const layout = computeTerrainLayout(RIBBONS, { ...OPTS, camera });
      for (const r of layout.ribbons) {
        for (const v of r.vertices) {
          // SVG y grows downward: above the plane means a SMALLER y than its foot
          const above = v.point.y < v.foot.y;
          expect(above, `${r.id} at ${v.day} from ${name}`).toBe(!r.isLiability);
        }
      }
    }
  });

  test("height stays proportional to the balance — the projection is orthographic", () => {
    for (const camera of Object.values(TERRAIN_VIEWPOINTS)) {
      const layout = computeTerrainLayout(
        [
          ribbon({
            id: "chk",
            points: [
              { day: "2026-01-01", valueCents: 50_000, verified: true },
              { day: "2026-01-02", valueCents: 100_000, verified: true },
              { day: "2026-01-03", valueCents: 150_000, verified: true },
            ],
          }),
        ],
        { ...OPTS, camera },
      );
      const [a, b, c] = ribbonById(layout, "chk").vertices;
      const lift = (v: (typeof layout.ribbons)[number]["vertices"][number]) => v.foot.y - v.point.y;
      // the only slack is the 0.01px rounding of a projected point, which bites
      // hardest from plan (a 82° elevation flattens the lift towards nothing)
      expect(Math.abs(lift(b!) / lift(a!) - 2)).toBeLessThan(0.02);
      expect(Math.abs(lift(c!) / lift(a!) - 3)).toBeLessThan(0.03);
    }
  });

  test("depth is the account: one plane rule each, and a painter's order far → near", () => {
    const layout = computeTerrainLayout(RIBBONS, OPTS);
    expect(layout.plane!.depthRules).toHaveLength(RIBBONS.length);
    expect(layout.separationPx).toBeGreaterThan(0);
    expect(layout.fillClarity).toBeGreaterThan(0);
    // quarter view: the LAST input account sits nearest the reader, so it is
    // drawn last (over the others)
    expect(layout.ribbons.map((r) => r.id)).toEqual(["checking", "savings", "card"]);
  });

  test("dead on, depth carries nothing — the fills must give way to the crests", () => {
    const front = computeTerrainLayout(RIBBONS, { ...OPTS, camera: TERRAIN_VIEWPOINTS.front });
    expect(front.separationPx).toBe(0);
    expect(front.fillClarity).toBe(0);
  });

  test("colour is account identity: the stride-5 walk the account chips use", () => {
    expect(terrainColor(0)).toBe("var(--cat-red)");
    expect(terrainColor(1)).toBe("var(--cat-teal)");
    expect(terrainColor(12)).toBe(terrainColor(0));
    expect(terrainColor(-3)).toBe(terrainColor(0));
    const layout = computeTerrainLayout(RIBBONS, OPTS);
    expect(ribbonById(layout, "checking").color).toBe(terrainColor(0));
    expect(ribbonById(layout, "card").color).toBe(terrainColor(2));
  });

  test("the ribbon states its own span: first, last and the change between", () => {
    const r = ribbonById(computeTerrainLayout(RIBBONS, OPTS), "card");
    expect(r).toMatchObject({
      firstDay: "2026-01-01",
      lastDay: "2026-01-03",
      firstCents: -5_000,
      lastCents: -4_000,
      deltaCents: 1_000,
      isLiability: true,
    });
  });

  test("today's figures come out of the ribbons themselves", () => {
    const layout = computeTerrainLayout(RIBBONS, OPTS);
    expect(layout.assetsLatestCents).toBe(182_000);
    expect(layout.owedLatestCents).toBe(4_000);
    expect(layout.totalLatestCents).toBe(178_000);
  });
});

// ── The plate ────────────────────────────────────────────────────────

describe("the drawing fits its plate", () => {
  test("every projected point lands inside the canvas at every viewpoint", () => {
    for (const [name, camera] of Object.entries(TERRAIN_VIEWPOINTS)) {
      const layout = computeTerrainLayout(RIBBONS, { ...OPTS, camera });
      const pts = [
        ...layout.plane!.sheet,
        ...layout.plane!.timeRules.flat(),
        ...layout.valueTicks.map((t) => t.point),
        ...layout.timeTicks.map((t) => t.point),
        ...layout.ribbons.flatMap((r) => r.vertices.flatMap((v) => [v.point, v.foot])),
      ];
      for (const p of pts) {
        expect(p.x, `${name} x`).toBeGreaterThanOrEqual(-0.01);
        expect(p.x, `${name} x`).toBeLessThanOrEqual(OPTS.width + 0.01);
        expect(p.y, `${name} y`).toBeGreaterThanOrEqual(-0.01);
        expect(p.y, `${name} y`).toBeLessThanOrEqual(OPTS.height + 0.01);
      }
    }
  });

  test("the value axis gives way once the camera has collapsed it", () => {
    // a line of 10.5px figures needs ~13px of leading; MEASURED on this
    // fixture, neighbouring ticks sit 6.8px apart from Plan (they collide) and
    // 36.7px or more from every other viewpoint
    const gaps = (camera: (typeof TERRAIN_VIEWPOINTS)["plan"]) => {
      const ys = computeTerrainLayout(RIBBONS, { ...OPTS, camera }).valueTicks.map((t) => t.point.y);
      return Math.min(...ys.slice(1).map((y, i) => Math.abs(y - ys[i]!)));
    };
    expect(computeTerrainLayout(RIBBONS, { ...OPTS, camera: TERRAIN_VIEWPOINTS.plan }).valueAxisLegible).toBe(
      false,
    );
    expect(gaps(TERRAIN_VIEWPOINTS.plan)).toBeLessThan(13);
    // and it survives everywhere it still reads
    for (const name of ["front", "quarter", "side"] as const) {
      expect(
        computeTerrainLayout(RIBBONS, { ...OPTS, camera: TERRAIN_VIEWPOINTS[name] }).valueAxisLegible,
        name,
      ).toBe(true);
      expect(gaps(TERRAIN_VIEWPOINTS[name]), name).toBeGreaterThan(13);
    }
    expect(computeTerrainLayout([], { ...OPTS, camera: TERRAIN_VIEWPOINTS.plan }).valueAxisLegible).toBe(false);
  });

  test("a phone-width plate labels three days, not five that would collide", () => {
    const wide = computeTerrainLayout(RIBBONS, OPTS);
    const phone = computeTerrainLayout(RIBBONS, { ...OPTS, width: 408 });
    expect(wide.timeTicks).toHaveLength(3); // this fixture only HAS three days
    expect(phone.timeTicks).toHaveLength(3);
    // with a real axis behind it the wide plate labels five and the phone three
    const long = [ribbon({ id: "chk", points: LONG_POINTS })];
    expect(computeTerrainLayout(long, OPTS).timeTicks).toHaveLength(5);
    expect(computeTerrainLayout(long, { ...OPTS, width: 408 }).timeTicks).toHaveLength(3);
    // and the ends are always among them — the axis states the real span
    const ticks = computeTerrainLayout(long, { ...OPTS, width: 408 }).timeTicks;
    expect(ticks[0]!.day).toBe(LONG_POINTS[0]!.day);
    expect(ticks.at(-1)!.day).toBe(LONG_POINTS.at(-1)!.day);
  });

  test("the value axis is SET in a gutter, so a $51k label is never clipped off", () => {
    // the fit only ever sees a tick's anchor point; the label hangs to the left
    // of it, and the gutter is what keeps it on the plate
    for (const camera of Object.values(TERRAIN_VIEWPOINTS)) {
      const layout = computeTerrainLayout(RIBBONS, { ...OPTS, camera });
      for (const tick of layout.valueTicks) {
        expect(tick.point.x).toBeGreaterThanOrEqual(40);
      }
    }
  });

  test("a tiny plate still draws — the canvas has a floor, never a negative scale", () => {
    const layout = computeTerrainLayout(RIBBONS, { ...OPTS, width: 10, height: 10 });
    expect(layout.width).toBe(80);
    expect(layout.height).toBe(80);
    expect(layout.ribbons.every((r) => r.vertices.every((v) => Number.isFinite(v.point.x)))).toBe(true);
  });

  test("the caller can set every world dimension", () => {
    const layout = computeTerrainLayout(RIBBONS, {
      ...OPTS,
      maxColumns: 2,
      span: 400,
      depthStep: 12,
      upPx: 100,
      downPx: 20,
    });
    expect(layout.columnCount).toBe(2);
    expect(layout.columnDays).toEqual(["2026-01-01", "2026-01-03"]);
  });

  test("nothing to draw is a layout, not a crash", () => {
    const empty = computeTerrainLayout([ribbon({ id: "a", points: [] })], OPTS);
    expect(empty.plane).toBeNull();
    expect(empty.ribbons).toEqual([]);
    expect(empty.ribbonCount).toBe(1);
    expect(empty.columnDays).toEqual([]);
    expect(empty.firstDay).toBeNull();
    expect(empty.lastDay).toBeNull();
    expect(empty.debtMultiple).toBeNull();
    expect(empty.totalLatestCents).toBe(0);
    expect(computeTerrainLayout([], OPTS).ribbonCount).toBe(0);
  });

  test("the same rows always produce byte-identical points", () => {
    const a = computeTerrainLayout(RIBBONS, OPTS);
    const b = computeTerrainLayout(RIBBONS.map((r) => ({ ...r })), { ...OPTS });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── Small pure helpers ───────────────────────────────────────────────

describe("unionDays", () => {
  test("is the sorted unique union of every ribbon's days", () => {
    expect(
      unionDays([
        ribbon({ id: "a", points: [{ day: "2026-01-03", valueCents: 1, verified: true }] }),
        ribbon({
          id: "b",
          points: [
            { day: "2026-01-01", valueCents: 1, verified: true },
            { day: "2026-01-03", valueCents: 1, verified: true },
          ],
        }),
      ]),
    ).toEqual(["2026-01-01", "2026-01-03"]);
    expect(unionDays([])).toEqual([]);
  });
});

describe("sampleIndices", () => {
  test("keeps every index when the axis already fits", () => {
    expect(sampleIndices(4, 10)).toEqual([0, 1, 2, 3]);
    expect(sampleIndices(1, 10)).toEqual([0]);
  });

  test("always keeps the first and last day", () => {
    for (const count of [5, 37, 104, 731, 5_000]) {
      const idx = sampleIndices(count, 12);
      expect(idx[0]).toBe(0);
      expect(idx.at(-1)).toBe(count - 1);
      expect(idx.length).toBeLessThanOrEqual(12);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      expect(new Set(idx).size).toBe(idx.length);
    }
  });

  test("degenerate asks degrade instead of throwing", () => {
    expect(sampleIndices(0, 10)).toEqual([]);
    expect(sampleIndices(-2, 10)).toEqual([]);
    expect(sampleIndices(9, 0)).toEqual([0, 8]);
    expect(sampleIndices(9, 1.9)).toEqual([0, 8]);
  });
});

describe("pointsAttr", () => {
  test("writes an SVG points attribute", () => {
    expect(pointsAttr([{ x: 1, y: 2 }, { x: 3.5, y: 4 }])).toBe("1,2 3.5,4");
    expect(pointsAttr([])).toBe("");
  });
});

describe("nearestVertex", () => {
  test("finds the crest nearest a point on the plate, at any angle", () => {
    const layout = computeTerrainLayout(RIBBONS, OPTS);
    const target = ribbonById(layout, "savings").vertices[1]!;
    const hit = nearestVertex(layout.ribbons, { x: target.point.x + 0.4, y: target.point.y - 0.3 });
    expect(hit?.ribbon.id).toBe("savings");
    expect(hit?.vertex.day).toBe(target.day);
  });

  test("nothing drawn, nothing picked", () => {
    expect(nearestVertex([], { x: 0, y: 0 })).toBeNull();
  });
});
