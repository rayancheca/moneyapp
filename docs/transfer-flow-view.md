# Transfer Flow — a new view for money moving between your own accounts

> **Status: SHIPPED.** The spine, the rhythm rail and the matrix landed in pass 26; **the Tower
> landed in pass 27**. Everything below is the original design spec, kept because its *reasoning*
> is still the reasoning — but several of its **mechanisms were overruled during implementation**.
> §0 is the record of what actually shipped. Where §0 and the rest of this document disagree, §0 is
> what is in the repo.
>
> **Prototype:** [`docs/design-directions/transfer-flow-prototype.html`](design-directions/transfer-flow-prototype.html) — open it directly with `file://`, no server, no network.
> **Hard constraint:** purely **ADDITIVE**. The Sankey, the balance chart, the portfolio chart, the
> heatmap, the donut and every lens on them are untouched. This is a new surface alongside them.

---

## 0. What actually shipped, and where it departs from this spec

Route is **`/flow`**, not `/transfers` (owner's call). View dimensions are
`measure` (gross|net) · `shape` (spine|tower) · `lens` (chart|table), in that order, with `lens`
last. The **dimension key is `shape`, not `flow`** — the route is already `/flow`, so `?flow=tower`
reads as nonsense while `?shape=tower` reads as English.

```
src/lib/transfer-tower-layout.ts        pure geometry + orthographic projection  (100% covered)
src/lib/transfer-tower-layout.test.ts   68 cases
src/components/charts/TransferTower.tsx the SVG renderer + the account rail
src/components/charts/TransferTower.test.ts  source + wiring contract
e2e/zz-zz-flow-views.spec.ts            enumerates FLOW_VIEW_SPEC — every option must render
```

### Eight deviations, each with its reason

| Spec said | Shipped | Why |
|---|---|---|
| **Canvas 2D**, dynamically imported with `ssr: false` (§9) | **SVG**, imported normally | The handoff had already reversed this (§5.1: "SVG + orthographic projection, not WebGL"), and `NetWorthTerrain` is the in-repo precedent. SVG is axe-inspectable, needs no CSS-variable resolution (`var(--cat-blue)` works directly in a `stroke`), and the browser hit-tests it for free. Separately: in **Next 16 `ssr: false` inside a Server Component is a hard build error**, so the canvas route also needed a client wrapper module that does not otherwise exist. |
| **Free orbit** — drag, scroll-zoom, arrow keys, `Home` resets (§6) | **Four named viewpoints** (`quarter`, `front`, `side`, `plan`), local state | The terrain's doctrine, verbatim: *"No free tumble: a camera that lies about which ribbon is in front is not offered."* Buttons are keyboard-reachable without inventing a drag gesture nobody can perform from a keyboard, and the geometry stays snapshot-stable. Viewpoint is **not** persisted and **not** in the URL — same as the terrain — so a shared `/flow?shape=tower` link always opens at the same camera. |
| Camera elevation **16°** (az −0.62 rad, el 0.28 rad) | **27°** | That figure came from the prototype, which projected in **perspective**, and perspective supplies depth on its own. This renderer is orthographic *on purpose* — a stroke encoding dollars must mean the same thing at the front and the back of the ring. Under orthographic projection 16° squashes the ring to 28% of its width and the pillars line up as a flat picket fence. 27° is also the terrain's quarter elevation, so both 3D figures in the app are now read from the same angle. **Found by screenshot; no assertion can see it.** |
| Geometry emitted as **`Float32Array` vertex buffers** (§5.2) | Plain objects, matching `SpineArc[]` | The argument for buffers was snapshot-testability without booting WebGL. Plain objects give exactly that (`toEqual` of two calls proves determinism just as well), the SVG renderer cannot consume a typed array any faster, and the buffers throw away the `(edge, month)` identity that the tooltip and the drill both need. |
| A hand-rolled **`pickTowerArc`** nearest-polyline hit test (§6) | Deleted — the browser does it | It was written, tested and then removed. Paint order is back-to-front, so the topmost SVG element under the cursor *is* the nearest arc. Shipping it would have been dead code. |
| **Every arc keyboard-focusable** (§8) | Arcs are pointer-only; the **rail** is the keyboard path | True and right for the spine, which has 13–17 arcs. The tower has one arc per (edge, month) — **167 on the real database** — and 167 tab stops between the viewpoint pills and the rest of the page is a trap, not access. The rail beside the plate names every account with its exact figures and is a real link to that account's ledger; the table lens carries every number. This is the terrain's bargain and it is why the terrain makes it. |
| The rhythm rail sits under every chart | Tower renders **without** the rhythm rail | The tower's own Y axis *is* time. A monthly rail under it would be a second, worse answer to a question already on screen. |
| Pillar radius from gross throughput (§3.2) | Same — and **held gross in net mode too** | Making the skeleton measure-invariant means switching gross → net changes only which arcs are drawn, so the eye tracks the change instead of re-acquiring the scene. |

### Two invariants this spec did not have, added because the geometry needed them

1. **The arch is bounded by the month spacing.** An arc lifts so it reads as a solid rather than a
   flat smear, but never by more than `0.4 × monthStep` — so an arc can never appear to sit at a
   month it does not belong to. The prototype's `0.055 + 0.075 · chord` had no such bound and on a
   short window would lift an arc clean past its neighbour. Asserted at 2, 8 and 60 months.

2. **The sideways bow is anchored to the pair's canonical direction, not the edge's own.** ⚠️ This
   was a real bug, caught by the invariant test on the first run. Reversing an edge flips the
   perpendicular *and* flips the sign, and **the two cancel**: computed the obvious way, A→B and
   B→A land on precisely the same control point and draw one exactly on top of the other — hiding
   the round-trip churn this entire surface exists to reveal. Taking the perpendicular along
   `low ringIndex → high` and the sign from the direction is what actually separates them.

### Verified, on the real database

167 arcs in gross and 125 in net across 7 accounts and 34 months; **zero horizontal overflow at 320,
375, 768, 1440**; zero console errors; axe clean (critical + serious) in the tower view; identical
markup across a resize cycle. The month labels live in a reserved left gutter — drawn at a fixed
`x = 8` they landed *on top of* the leftmost pillar at 375px and stranded themselves ~380px from a
self-centring figure at 1440px. Both were found by looking at a screenshot, and both are now pinned
by a test.

---

## 1. The problem this view exists to solve

The owner moves money between his own accounts constantly — 12–28 transfers a month, sustained for
2.7 years. Today that activity is *deliberately invisible*: `spendingSankey` excludes transfers,
because counting them as spending would double-count every dollar. That is correct for the Sankey and
wrong as a permanent answer. A meaningful slice of his financial life currently has no representation
anywhere in the app.

Two questions have no home today:

1. **Where does money actually settle?** Which accounts are sources, which are sinks.
2. **How much of the movement is real, and how much is churn?** He round-trips money. Gross
   overstates movement badly, and no chart in the app says so.

---

## 2. The data (measured read-only from the real DB)

6 accounts, 13 directed edges, 2023-10-20 → 2026-07-07.

| From | To | Count | Gross |
|---|---|---:|---:|
| SoFi Savings | SoFi Checking | 299 | $97,921.99 |
| Chase Checking | SoFi Savings | 23 | $78,995.61 |
| Chase Checking | Robinhood Cash | 14 | $51,173.09 |
| SoFi Checking | Robinhood Cash | 10 | $22,819.31 |
| Robinhood Cash | Chase Checking | 6 | $19,411.88 |
| SoFi Checking | SoFi Savings | 25 | $16,506.04 |
| SoFi Savings | Discover | 49 | $13,941.67 |
| SoFi Savings | Chase Checking | 22 | $11,823.21 |
| Chase Checking | Venture X | 27 | $10,533.97 |
| SoFi Savings | Venture X | 5 | $3,473.90 |
| Chase Checking | Discover | 34 | $3,312.90 |
| Robinhood Cash | SoFi Checking | 1 | $500.00 |
| Chase Checking | SoFi Checking | 1 | $100.00 |
| **Total** | | **516** | **$330,513.57** |

### 2.1 Derived facts the view is built around

**Gross $330,513.57 · Net $234,031.31 · Round-trip churn $96,482.26 (29.2% of gross).**

Churn is exactly `2 × Σ min(A→B, B→A)` over the four bidirectional pairs — the prototype computes it
both ways and they agree to the cent.

Net position per account (in − out), which **must sum to zero** and does:

| Account | Net |
|---|---:|
| Chase Checking | −$112,880.48 |
| SoFi Savings | −$31,659.12 |
| Venture X | +$14,007.87 |
| Discover | +$17,254.57 |
| Robinhood Cash | +$54,080.52 |
| SoFi Checking | +$59,196.64 |
| **Sum** | **$0.00** |

The story: **Chase Checking is the great source**; SoFi Checking and Robinhood Cash are the sinks;
SoFi Savings is the busiest node in the graph (299 transfers on one edge) yet a net *pass-through*.
Discover and Venture X only ever receive — they are card payments, money leaving the system.

### 2.2 ⚠️ Reconciliation gap — resolve before implementing

The transfer detector reports **650 transfer groups**. These 13 account-pair edges account for **516**.
**134 groups (~21%) are unattributed.** Most likely: legs whose counterparty account is outside these
six, groups with more than two legs, or groups with one leg only. The real service **must** either
reconcile to 650 or render the remainder explicitly (an "Unpaired / other" row in the table lens).
Shipping a view that silently drops 21% of the groups would violate the codebase's reconciliation
doctrine. This is the single highest-priority open question.

---

## 3. Chosen forms

### 3.1 2D — **"The Spine"**: a directed arc diagram on a vertical account spine, plus a monthly rhythm rail

Six accounts sit as fixed nodes on a vertical spine, **ordered by net position** (biggest net source
at the top, biggest net sink at the bottom). Every edge is a cubic arc leaving and re-entering the
spine:

- Arcs bulge **RIGHT** when money moves *down* the ladder (toward its net destination).
- Arcs bulge **LEFT** when money moves *back up*.

**Why this is the right form:** the left region is, by construction, exactly the round-trip return
flow. Flipping to **Net** empties it — you literally watch the churn evaporate. Gross-vs-net stops
being a number in a tooltip and becomes the primary gestalt of the chart. Verified in the prototype:
gross renders 13 edges with 4 left-bulging arcs; net renders 9 edges with 1.

Below it sits **"The Rhythm"** — a stacked monthly bar rail on the same colour scale, sharing hover
state with the spine. Topology and time are both present without either one being crammed into the
other's geometry.

#### Encodings — every channel carries meaning

| Channel | Encodes |
|---|---|
| Vertical position | Net position (source → sink) |
| **Side** of the spine | Direction relative to net flow — right = onward, left = returning |
| Arc **stroke width** | Dollars |
| Arc **dash gap** | Transfer **count** (cadence: gap shrinks as transfers/month rises) |
| Dash **drift** (motion) | Same thing, animated — the *gap* is static so meaning survives motion-off |
| **Hue** | The sending account |
| Region tint (left) | "This is money coming back" |

Fact 3 in the brief — count and volume are different stories — is solved by giving them **two
separate channels** (width vs cadence) rather than collapsing both into ribbon width.

### 3.2 3D — **"The Tower"**: time as the vertical axis, accounts as a fixed ring

Six account pillars stand on a deterministic ring (fixed angular positions, declared order). The
**Y axis is time** — Oct 2023 at the base, today at the top. Every (edge, month) bucket is a 3D
quadratic arc from source pillar to destination pillar at that month's height, with an arrowhead at
the destination.

**Why 3D is justified here at all:** the third dimension buys the one thing 2D genuinely cannot do —
**topology and time simultaneously**. You see the 299-transfer SoFi Savings → SoFi Checking edge as a
thick woven rope running the full height of the tower, and you see the Chase → Robinhood pulses as
sparse struts at specific altitudes. That is not decoration; it is a real reading of the data that no
2D panel in this app provides.

| Channel | Encodes |
|---|---|
| Angular position | Account (fixed order, deterministic) |
| **Y** | Date |
| Arc thickness | Dollars in that month on that edge |
| Arc colour | Sending account |
| Arc opacity | Depth (near/far cue only) |
| Arrowhead | Direction |
| Pillar radius | Gross throughput of the account |
| Pillar gradient | Time — faint at the base, solid at the top |

Camera has a **fixed deterministic default** (`az −0.62, el 0.28, zoom 1`, `Home` resets). No
auto-spin, no physics, no `Math.random`.

### 3.3 Table lens — the 6×6 directed flow matrix

`lens=table` does **not** render a flat list of 13 rows. It renders a real `<table>`: rows send,
columns receive, with **Out / In / Net** margins. Gross fills 13 cells; **Net folds the matrix** to 9,
keeping only the winning direction of each pair. The footer proves conservation: Out total = In total
= $330,513.57, Net column = $0.00. This is the precise, screen-reader-native representation — and it
is a genuinely better table than a list, because a matrix *is* the natural shape of directed flow.

---

## 4. Forms rejected, and why

| Rejected | Why |
|---|---|
| **Chord diagram** | The obvious choice, and the wrong one. Gutwin, Mairena & Bandi (CHI 2023) ran the head-to-head: participants were **slower and made more errors** with chord than Sankey, rated it higher-effort, and **42 of 51 preferred Sankey**. Directed chords between the same pair overlap, which is fatal precisely on the four bidirectional pairs that matter most here. Radial position also cannot encode net position. |
| **Force-directed network** | Non-deterministic by construction (physics settling) — breaks the 243 Playwright visual snapshots outright. And 6 nodes / 13 edges has no topology worth discovering. |
| **A second Sankey** | Would need each account duplicated into a left and a right copy. SoFi Savings appearing twice actively *hides* the round-trip — the exact fact the data most needs to surface. Also has no time axis. |
| **Matrix as the primary 2D view** | Rigorous but inert; it has no gestalt and no time. Demoted to the table lens, where it is excellent. |
| **Per-transfer arc timeline (650 arcs on one time axis)** | A hairball at 440px, and individual events cannot be netted, so it cannot honour the net/gross toggle. Monthly bucketing (what the Rhythm rail and the Tower both use) keeps the time reading and stays nettable. |
| **3D force graph / globe / 3D pie** | Non-deterministic, or the third axis encodes nothing. |
| **`<animate>` (SMIL) for the dash drift** | Playwright's `animations: "disabled"` does **not** freeze SMIL — it would have silently flaked the visual baselines. Replaced with a CSS animation, which it does freeze. This bug was found and fixed during prototype verification. |

---

## 5. Architecture — mirrors the Sankey trio exactly

The existing Sankey is the model: pure deterministic layout in `src/lib/`, DB query + aggregation in
`src/services/`, colour/interaction/rendering in `src/components/charts/`.

```
src/lib/transfer-flow-layout.ts        pure geometry   (unit-tested, no React/DOM/Date/random)
src/services/transfer-flow.ts          query + aggregate (mirrors services/sankey.ts)
src/components/charts/TransferSpine.tsx      2D renderer  (mirrors SankeyChart.tsx)
src/components/charts/TransferTowerCanvas.tsx 3D renderer  (dynamic, ssr:false)
src/components/charts/TransferMatrixTable.tsx table lens
src/app/transfers/page.tsx             the new route (RSC)
```

### 5.1 Service — `src/services/transfer-flow.ts`

Follows `spendingSankey(db, range)`'s signature and doctrine (split-aware, `status = 'active'`,
reconciles to the ledger).

```ts
export interface TransferAccount {
  id: string;
  label: string;
  /** `var(--cat-*)` from the category/account palette */
  color: string;
  /** in − out over the range, cents; the set ALWAYS sums to 0 */
  netCents: number;
  inCents: number;
  outCents: number;
  /** drill target for the account */
  href: string;
}

export interface TransferEdge {
  /** `${fromAccountId}>${toAccountId}` — stable, sortable */
  id: string;
  fromAccountId: string;
  toAccountId: string;
  /** gross cents on this directed edge over the range */
  grossCents: number;
  /** number of transfer groups on this directed edge */
  count: number;
  /** per-month gross, index-aligned to `months`; sums to grossCents */
  monthCents: readonly number[];
  /** per-month count, index-aligned to `months`; sums to count */
  monthCounts: readonly number[];
}

export interface TransferFlowData {
  accounts: readonly TransferAccount[];   // ordered by netCents ASC (source → sink)
  edges: readonly TransferEdge[];         // ordered by grossCents DESC, tie-break by id
  months: readonly string[];              // "YYYY-MM", ascending, gap-free
  totals: {
    grossCents: number;
    netCents: number;
    /** grossCents − netCents === 2 × Σ min(A→B, B→A) */
    churnCents: number;
    groupCount: number;
    /** groups the detector found that these edges do NOT explain — see §2.2 */
    unattributedGroupCount: number;
  };
}

export function transferFlow(db: AppDatabase, range: DateRange): TransferFlowData;
```

**The query.** One pass, keyed on `transfer_group_id`:

```sql
SELECT t.transfer_group_id,
       t.account_id,
       t.amount_cents,
       t.posted_on
  FROM transactions t
 WHERE t.status = 'active'
   AND t.transfer_group_id IS NOT NULL
   AND t.posted_on BETWEEN :from AND :to
```

Then in TypeScript, group by `transfer_group_id` and, per group:

- the **outflow leg** (`amount_cents < 0`) gives `fromAccountId`, the magnitude, and the **date**
  (detector convention — the outflow leg keys the group, per `transfer-links.ts`);
- the **inflow leg** (`amount_cents > 0`) gives `toAccountId`;
- groups that do not resolve to exactly one outflow + one inflow in two different accounts are
  **counted into `unattributedGroupCount`, never silently dropped**;
- edge amount uses `abs(outflow)`, so a wire fee never inflates the edge.

Net is derived, never stored: for each unordered pair keep `|A→B − B→A|` in the winning direction.
Netting money must **not** net away the events — a net edge carries `count = countA + countB`,
because both transfers really happened.

### 5.2 Pure layout — `src/lib/transfer-flow-layout.ts`

No React, no DOM, no `Date`, no `Math.random`. Emits **both** the 2D SVG geometry and the 3D vertex
positions from one deterministic projection, so the two views can never disagree about the data.

```ts
export interface SpineLayoutOptions { width: number; compactBelow?: number; }

export interface SpineNode {
  id: string; label: string; color: string; netCents: number;
  y: number; labelX: number;
}
export interface SpineArc {
  id: string; fromAccountId: string; toAccountId: string;
  cents: number; count: number;
  /** the gross behind a net arc, and how much round-tripped (0 in gross mode) */
  grossCents: number; returnedCents: number;
  /** SVG cubic path, both control points at the same x (a clean lobe) */
  path: string;
  /** stroke width px (dollars) */
  width: number;
  /** dash gap px (transfer cadence) + drift duration s */
  dashGap: number; dashDurationS: number;
  /** true when the arc bulges right = moves toward its net destination */
  isOnward: boolean;
  /** label anchor at the cubic's t=0.5 */
  labelX: number; labelY: number;
}
export interface SpineLayout {
  width: number; height: number;
  spineX: number; leftRegion: number; rightRegion: number;
  nodes: SpineNode[]; arcs: SpineArc[]; compact: boolean;
}

export function computeSpineLayout(
  data: TransferFlowData, measure: "gross" | "net", options: SpineLayoutOptions,
): SpineLayout;

export interface TowerVertexBuffers {
  /** flat XYZ triples, one polyline per (edge, month) */
  arcPositions: Float32Array;
  arcOffsets: Uint32Array;      // start index of each polyline
  arcWidths: Float32Array;
  arcAccountIndex: Uint16Array; // → palette lookup, so colour lives in the renderer
  pillarPositions: Float32Array;
  pillarRadii: Float32Array;
  /** ring y for every 6th month + its label index */
  timeRings: Float32Array;
}

export function computeTowerGeometry(
  data: TransferFlowData, measure: "gross" | "net",
): TowerVertexBuffers;
```

Emitting the 3D layer as **typed arrays from a pure function** means the geometry is snapshot-testable
in a unit test (`expect(buffers.arcPositions).toMatchSnapshot()`) without ever booting WebGL — which is
how determinism gets *proved* rather than hoped for.

**Bulge geometry is a function of node SPAN only**, never of the value. Two edges spanning different
distances can therefore never land on the same curve and hide each other, and the layout cannot shift
when the data does — critical for stable baselines.

### 5.3 Components

```tsx
interface TransferSpineProps {
  data: TransferFlowData;
  measure: "gross" | "net";
  /** taller in the focus dialog — same contract as SankeyChart */
  heightClass?: string;
  ariaLabel?: string;
  emptyLabel?: string;
  /** built by ledgerHref(); clicking an arc navigates here */
  hrefForEdge: (edge: SpineArc) => string;
}

interface TransferTowerProps {
  data: TransferFlowData;
  measure: "gross" | "net";
  /** hover is LIFTED so the spine, the rhythm rail and the tower highlight together */
  hoveredEdgeId: string | null;
  onHoverEdge: (id: string | null) => void;
  onSelectEdge: (id: string) => void;
}
```

Hover state is **lifted to the page**, not owned by each chart, so hovering an arc in the spine dims
the matching stack in the rhythm rail (proven in the prototype), and vice versa.

---

## 6. Interactions

| Interaction | Behaviour |
|---|---|
| **Hover arc (2D)** | Arc goes to full opacity + thickens; all others drop to 0.1. Floating card: `From → To`, amount, and either `N transfers · avg $X` (gross) or `$X gross · $Y round-tripped` (net). |
| **Hover node (2D)** | The node's arcs stay lit, the rest dim. |
| **Hover bar (rhythm)** | Card names the edge, the month, the amount and the count; the matching spine arc lights up. |
| **Hover arc (3D)** | Nearest-polyline hit test within 8px (deterministic, pure `segDist2`). Card names the **(edge, month)** bucket. Cursor becomes `pointer`. |
| **Click / Enter / Space** | Drills to `/transactions?transferFrom=…&transferTo=…&from=…&to=…`. Real `<a href>` in 2D so ⌘/Ctrl/middle-click keep native behaviour (same guard as `SankeyChart.drill`). In 3D, a pointer-up that did **not** orbit is a click. |
| **Orbit (3D)** | Drag = azimuth + elevation (elevation clamped −0.25…1.15). Scroll = zoom (0.55…3). `←/→/↑/↓` rotate, `Home` resets to the exact default camera. |
| **Range pills** | Reuses `ChartRangePills` verbatim. Recomputes every panel — verified: 3M gives $58,356.05 / 97 transfers. |
| **Net ⇄ Gross** | A first-class view dimension, not a checkbox. Left-hand arcs collapse; the matrix folds; the rhythm rail relabels; the rail stats stay side-by-side so both numbers are *always* visible. |
| **Chart ⇄ Table lens** | `LENS_DIMENSION` from `chart-lens.ts`, **appended** to the spec (never inserted — the positional-indexing warning in that file). |
| **Focus modal** | Wrapped in the existing `ChartFocus` with `renderPanel`, so the inline card and the dialog render the *same* panel and view parity is structural. |

---

## 7. Degenerate states

| State | Render |
|---|---|
| **No transfers in range** | The `emptyLabel` paragraph (`SankeyChart`'s pattern): "No transfers between your accounts in this period." Range pills stay live so the user can widen. Rail shows `$0.00` across the board, not `—`. |
| **One edge** | Spine renders two nodes and one arc; `MAX_SPAN` collapses to 1 so the bulge formula uses its `t = 1` branch (guarded — no divide-by-zero). Net === gross; the churn stat reads `$0.00 · 0% came back` rather than being hidden, because "there is no churn" is itself the answer. |
| **One account** | No edges exist. Empty state, plus an explanatory line: a transfer needs two accounts. The Tower is suppressed (a ring of one is meaningless) and the dimension switcher hides `3D`. |
| **All edges unidirectional** | Net === gross. The left region renders empty in *both* modes and its tint is dropped so it does not imply missing data. |
| **A net-zero pair** (A→B exactly equals B→A) | Dropped from the net view (`net === 0`), but its `grossCents` still counts toward churn, and the table lens shows it in gross mode. Total conservation is unaffected. |
| **Canvas not yet sized** | `drawTower` early-returns and sets `data-ready="false"`. Nothing is painted half-measured. |

---

## 8. Accessibility

The 2D view is the accessible, legible primary — **not** a performance fallback. It is fully usable
alone and is what assistive tech gets.

- **SVG root**: `role="img"` with `aria-labelledby` pointing at a `<title>` and a `<desc>`. The desc is
  a real sentence, generated from the data:
  > "$330,513.57 moved between 6 accounts across 516 transfers; $96,482.26 of that returned to where
  > it came from, leaving $234,031.31 net. Largest net source Chase Checking at −$112,880.48; largest
  > net destination SoFi Checking at +$59,196.64."
- **Every arc is keyboard-reachable**: a `<g class="focusable" tabindex="0" role="button">` with a
  complete `aria-label` — *"Chase Checking to SoFi Checking, $100.00 over 1 transfer. Activate to view
  the transactions."* Verified: 13 of 13 arcs focusable with full labels. `Enter`/`Space` drill.
  `:focus-visible` paints a 2px accent halo along the arc path.
- **Nodes** are `<a href>` with `aria-label` carrying label, net position and share.
- **Tooltip is `aria-hidden`** and is *not* a live region — announcing a new flow on every arc the
  cursor crosses would be hostile. All tooltip content is reachable via the table lens.
- **Table lens** is a real `<table>` with `<caption>`, `scope="col"`/`scope="row"` headers and a
  `<tfoot>` carrying the conservation proof. Verified: caption present, 10 column headers, 7 row
  headers, 6 body rows.
- **3D canvas** carries `role="img"` and an `aria-label` that names the view *and points to the
  equivalent accessible views*. It is keyboard-focusable for orbit, but it is never the only path to
  any fact.
- **Range pills / switchers** reuse `ChartRangePills` and `ViewSwitcher` — `role="group"` +
  `aria-pressed`, every control tabbable, arrows reserved for the plot.
- **`prefers-reduced-motion`**: the dash *drift* stops. The dash **gap** — which is what actually
  encodes count — is static and survives. No meaning is lost with motion off. The 3D never auto-spins.
- **Colour**: hue is the *sending account* and is always redundant with position, side and the text
  label. Every token comes from the OKLCH contract in `globals.css`, so both themes hold AA.

---

## 9. How the 3D loads without blocking first paint

Ordering is the only performance rule (the owner's hardware is an M5 / iPhone 17 Pro Max — do not trim
features, do not downscale).

1. **RSC renders first.** `src/app/transfers/page.tsx` calls `transferFlow(db, range)` on the server
   and streams the summary rail, the spine SVG and the matrix as HTML. Numbers and 2D geometry are on
   screen before any client JS.
2. **The 3D chunk is never in the initial bundle:**
   ```ts
   const TransferTowerCanvas = dynamic(
     () => import("@/components/charts/TransferTowerCanvas"),
     { ssr: false, loading: () => <TowerSkeleton /> },
   );
   ```
3. **It is only imported when `flow=tower` is the resolved view.** A user who never switches never
   downloads it.
4. **Geometry is computed by the pure module** (`computeTowerGeometry`) — cheap, synchronous, and
   shared with the unit tests. The client chunk only uploads buffers and draws.
5. **The 2D layer stays mounted underneath** during the switch, so there is never a blank frame.
6. `data-ready="true"` / `data-painted-at="WxH"` are set after a completed paint at the current size —
   the settle signal e2e waits on (see §10).

The prototype renders the 3D with a hand-authored perspective projection onto a 2D canvas (no library,
no CDN, works from `file://`). Production can keep exactly that, or move to WebGL2 — the pure module's
output (typed vertex buffers) is already the right shape for either.

---

## 10. Determinism and testing

The project has 243 Playwright e2e tests including visual snapshots. Everything below was verified in
the prototype, not assumed.

- **No `Math.random`, no `Date.now()`, no `new Date()`** anywhere in the render path. The prototype's
  synthetic month distribution uses a seeded `mulberry32`.
- **No physics, no settling, no barycentre iteration.** Node order comes from `netCents`; arc bulge is
  a function of span; the 3D paint list is a depth sort with a **stable id tie-break**.
- **Markup is byte-identical across re-layouts** — verified: `spine.innerHTML` and `rhythm.innerHTML`
  identical over a forced resize cycle (15,016 bytes, exact match).
- **Canvas is byte-identical across renders** — verified: three independent paints produced the same
  1,133,122-byte `toDataURL()`.
- **The one real flake risk is a measurement race**, not the renderer: screenshotting after the panel
  is un-hidden but before the `ResizeObserver` fires. Hence `data-ready`. E2E must do:
  ```ts
  await expect(page.locator('#tower')).toHaveAttribute('data-ready', 'true');
  await expect(page).toHaveScreenshot({ animations: 'disabled' });
  ```
- **Motion is CSS, never SMIL**, so `animations: "disabled"` genuinely freezes it.

Unit tests to write against the pure module: conservation (`Σ netCents === 0`), churn identity
(`gross − net === 2 × Σ min(A→B, B→A)`), monthly series sum back to edge totals, single-edge and
zero-edge layouts, and a vertex-buffer snapshot.

---

## 11. Where it lives

**New route: `/transfers`.** Nothing existing is edited.

Optionally (a second, separable PR) an inline `TransferSpine` card on `/accounts` linking through —
additive, and it does not touch the account charts.

View dimensions, declared the same way `view-state.ts` expects, with `LENS_DIMENSION` **appended**:

```ts
// src/app/transfers/view-spec.ts
import { LENS_DIMENSION } from "@/components/charts/chart-lens";
import type { ViewSpec } from "@/lib/view-state";

export const FLOW_DIMENSION    = { key: "flow",    options: ["spine", "tower"] } as const;
export const MEASURE_DIMENSION = { key: "measure", options: ["gross", "net"] } as const;

export const TRANSFERS_VIEW_SPEC: ViewSpec = [
  FLOW_DIMENSION,
  MEASURE_DIMENSION,
  LENS_DIMENSION,   // ALWAYS last
];
```

`resolveViewState` then gives the usual precedence — URL > persisted per-surface > spec default — so
`/transfers?flow=tower&measure=net` is shareable, the back button works, and the chosen view is sticky.
Defaults are `spine` / `gross` / `chart`, so the bare `/transfers` URL stays clean.

Range is handled by the existing `resolvePeriod` + `ChartRangePills`, untouched.

---

## 12. Effort estimate

| Piece | Size | Notes |
|---|---|---|
| `services/transfer-flow.ts` | **M** | The query is easy; the 650 vs 516 reconciliation (§2.2) is the real work and needs a real-DB investigation first. |
| `lib/transfer-flow-layout.ts` (2D spine) | **M** | Pure, well-specified, prototype-proven. Mostly transcription + unit tests. |
| `lib/transfer-flow-layout.ts` (tower buffers) | **S** | The projection already exists in the prototype; emitting typed arrays is mechanical. |
| `TransferSpine.tsx` + rhythm rail | **M** | Follows `SankeyChart.tsx` closely; hover lifting and a11y wiring are the bulk. |
| `TransferTowerCanvas.tsx` | **M** | Renderer + orbit + hit test. Port from the prototype, add `data-ready`. |
| `TransferMatrixTable.tsx` (lens) | **S** | Straight `<table>`; the fold logic lives in the service. |
| `/transfers` route + view spec | **S** | Boilerplate that `view-state.ts` already covers. |
| Unit tests | **S** | ~8 focused cases, all against the pure module. |
| E2E + visual baselines | **S** | 4–6 specs; the `data-ready` gate is what keeps them stable. |
| **Total** | **L** | ~2 focused passes. The service is the critical path, gated on §2.2. |

---

## 13. References

Checked for currency, maintenance and licence.

1. **Gutwin, Mairena & Bandi — "Showing Flow: Comparing Usability of Chord and Sankey Diagrams", CHI 2023.**
   https://dl.acm.org/doi/10.1145/3544548.3581119 — the empirical basis for rejecting a chord diagram:
   chord was slower and more error-prone, and 42/51 participants preferred Sankey.
2. **Wang et al. — "CHORDination: Evaluating Visual Design Choices in Chord Diagrams for Network Data", VINCI 2024.**
   https://arxiv.org/html/2408.02268v1 — found transparency-gradient direction encoding largely
   ineffective (only 4/24 read it as directional). Why the Tower uses explicit **arrowheads**, and the
   Spine uses **side-of-spine**, rather than a gradient.
3. **D3 `d3-chord` — `chordDirected` / `ribbonArrow`.** https://d3js.org/d3-chord/ribbon ·
   https://github.com/d3/d3-chord (ISC, maintained) — the reference implementation of directed ribbons,
   and the source of the convention that an asymmetric target radius is inset from the source.
4. **deck.gl `ArcLayer`.** https://deck.gl/docs/api-reference/layers/arc-layer — MIT, OpenJS
   Foundation, healthy release cadence (9.3.x). The canonical raised-arc flow encoding the Tower's arcs
   follow; two-colour source→target transition and arc height as a free channel.
5. **Nadieh Bremer — "Hacking a chord diagram to visualize a flow" / phone-brand switching.**
   https://www.visualcinnamon.com/2015/08/stretched-chord/ ·
   https://www.visualcinnamon.com/portfolio/phone-brand-switching/ — the best-known treatment of
   *asymmetric bidirectional* flow between a small set of nodes, and the clearest demonstration that
   the interesting signal is the imbalance, not the total.
6. **FlowmapBlue / flowmap.gl.** https://github.com/FlowmapBlue/FlowmapBlue (CC BY-NC 4.0 — **not**
   usable as a dependency here) · https://github.com/visgl/flowmap.gl (Apache-2.0, maintained by Ilya
   Boyandin) — origin-destination flow at scale; the source of the net-vs-gross toggle pattern as a
   first-class control rather than a setting.
7. **IIASA — "Circular Visualization of China's Internal Migration Flows 2010–2015".**
   https://pure.iiasa.ac.at/id/eprint/14736/1/EPN718375_pre-proof.pdf — the standard treatment of
   gross vs net in a bidirectional flow dataset: node arc length = gross (in + out), chord taper =
   directional imbalance. Directly informed the Spine's "gross on the node, net in the ordering".
8. **Alluvial diagrams — Data Viz Catalogue / Datasketch.**
   https://datavizcatalogue.com/blog/chart-snapshot-alluvial-diagrams-examples/ ·
   https://datasketch.co/blog/data-visualization-alluvial-diagram/ — the time-varying flow form the
   Rhythm rail is a simplification of; also the source of the "curve the streams, gradient the
   junctions" guidance.
9. **Observable Plot — matrix / co-occurrence visualisation.**
   https://observablehq.com/@observablehq/arsc-part-3-matrix-visualization ·
   https://github.com/observablehq/plot (ISC, maintained) — the model for the table lens: a matrix is
   the natural shape of directed flow, and margins carry the totals for free.
10. **D3 `d3-sankey` conventions**, as already embodied in `src/lib/sankey-layout.ts` — the in-repo
    precedent for a single shared vertical scale so the diagram *visibly conserves* money. The Spine
    inherits the same doctrine via its zero-sum net column.
