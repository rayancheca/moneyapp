# Inspiration Library

Compiled 2026-07-27 from six research scouts and three design directions. Every repo below was checked
for existence, star count, last-commit recency and licence on that date. Where something could not be
verified, it says so.

**Read this first — the three findings that outrank everything else in this document:**

1. **`font-variant-numeric: tabular-nums` in `globals.css` is currently a no-op.** Verified by extracting
   the OpenType tables from this repo's own `node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf`:
   Geist Sans ships `aalt ccmp dnom frac kern locl ss01–ss09` and **no `tnum`, no `lnum`, no `zero`**.
   Digit advances are proportional (`1` = 384/1000 em vs `0` = 663/1000 — a 42% swing). The `.figures`
   rule only aligns columns because it *also* switches family to Geist Mono. Every number outside
   `.figures` — including every recharts axis tick, whose tick objects carry only `fill` and `fontSize` —
   renders with jittering digit widths today.
2. **There is not one `loading.tsx`, `error.tsx` or `not-found.tsx` anywhere in `src/app`,** across all
   15 routes. Every route is a blank gap while SQLite queries, and any throw hits Next's default error
   page with none of the design system.
3. **The gain/loss pair is invisible to a protanope.** Machado-2009 simulation over the app's own tokens:
   ΔE2000 56.3 to normal vision, 14.5 deuteranopia, **8.9 protanopia** — `#58564f` against `#6e6032`,
   two muddy olives. A blue/orange pair measures 60.3 under deuteranopia. Ship it as an opt-in toggle
   (Bloomberg and Robinhood both did exactly this), never as a forced default.

All three design directions independently reached all three conclusions. That is as close to certainty
as this document gets.

---

## The shortlist — 15 references worth the owner's time

Ranked by what he actually gains from opening the tab. These are the ones to look at; everything else is
in the topic sections.

| # | Name | URL | What to steal | Where it goes in MoneyApp |
|---|------|-----|---------------|---------------------------|
| 1 | **NYT — 3-D View of the Yield Curve** (Aisch & Cox) | <https://www.nytimes.com/interactive/2015/03/19/upshot/3d-yield-curve-economic-growth.html> · verified secondhand via <https://policyviz.com/2022/12/09/updating-the-new-york-times-yield-curve-graphic/> (nytimes.com blocks automated fetch) | Discrete **ribbons, not a smooth mesh**; orthographic camera; the front-most curve reads as a normal 2D line; explicit degraded mobile mode | The design template for the `/` net-worth terrain. This is the single most important reference in the doc — it is the proof 3D can beat 2D in finance, and the rulebook for how |
| 2 | **openstatusHQ/data-table-filters** (live demo) | <https://data-table.openstatus.dev> · repo <https://github.com/openstatusHQ/data-table-filters> · MIT · 2,171★ | Faceted filter chips with **live counts**, URL-serialized filter state, command-driven filter entry, details sheet — over genuinely dense data | `/transactions` — `FiltersBar.tsx` is a submit-on-GET `<form>` with three bare `<select>`s today. This is the finished design. ⚠️ The parent repo `openstatusHQ/openstatus` is AGPL-3.0 — copy only from the filters repo |
| 3 | **Actual Budget** | <https://github.com/actualbudget/actual> · MIT · 27,770★ · pushed 2026-07-27 | The CSV import flow: field mapping with a "Choose field…" opt-out, **the interpreted date echoed back in green** so format inference is confirmed, "negate all amounts" toggle, separate inflow/outflow columns, duplicate matching on near-date + amount + similar payee | `/imports` — the weakest route in the app. Also its rules engine. The only major peer app whose code you can lift freely (MIT) |
| 4 | **Linear — Method + the technical breakdown** | <https://linear.app/method> · <https://performance.dev/how-is-linear-so-fast-a-technical-breakdown> · <https://gunpowderlabs.com/2024/12/22/linear-delightful-patterns> | Single-key shortcuts on the *focused row*; **shortcut hints rendered inline so they're learnable**; mutations applied locally then reconciled; animations under the ~100ms causality threshold; every view URL-addressable | The `/transactions` review queue. The app already has `KeyScopeProvider`, `BulkActionBar` and lossless inverse-patch undo and has never wired them into a j/k/x/e loop |
| 5 | **Recharts — Coordinate & dimension systems** | <https://recharts.github.io/en-US/guide/coordinateSystems/> · MIT | `useCartesianScale` / `usePlotArea` / `useOffset`, and the inverse hooks `useXAxisInverseDataSnapScale` + `getRelativeCoordinate` | Replaces the hand-rolled pointer→index math in `src/lib/scrub.ts` and the three `ReferenceArea` drag-select blocks in `ScrubChart.tsx` (1,010 lines). Also the foundation for the chart annotation layer. Needs the 3.9.2 → 3.10.1 bump |
| 6 | **Datawrapper Academy — colourblindness pt 1 & 2** (Lisa Charlotte Muth) | <https://www.datawrapper.de/blog/colorblindness-part2/> · <https://www.datawrapper.de/academy> | Blue is the safest hue; blue+orange is optimal for red-green CVD; **saturation cannot compensate, only lightness can**; cap at 3–4 hues per chart; direct-label instead of a legend | `src/lib/category-palette.ts` (12 hues, all sitting at L 0.50–0.53 — effectively isoluminant), `AllocationDonut`, `SankeyChart`, the `/spending` category charts |
| 7 | **Emil Kowalski — Great Animations** | <https://emilkowal.ski/ui/great-animations> | Interruptibility, natural easing, why overshoot means "physical object I moved", reduced-motion and performance obligations | The whole motion vocabulary section below is downstream of this essay |
| 8 | **FT Visual Vocabulary** | <https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary> · repo MIT, **poster PDFs © FT, all rights reserved — consult, do not redistribute or trace** · 3,301★ | Nine chart families. Gap analysis: MoneyApp covers Change-over-time, Part-to-whole and Flow well and has **nothing** in Deviation, Ranking or Distribution | `/spending` (waterfall = Deviation, ordered dot-plot = Ranking), `/transactions` (beeswarm/histogram = Distribution) |
| 9 | **scroll-driven-animations.style** (Bramus, Chrome DevRel) | <https://scroll-driven-animations.style/> · site source Apache-2.0 | `animation-timeline: view()` and `scroll()`, with a CSS *and* a WAAPI version of every demo, plus a DevTools extension for debugging scroll timelines | `/transactions` row reveal (the only approach that stays at 60fps with 1,673 rows — compositor-driven, zero JS), sticky group headers that compress as they pin. **Zero bundle, and the existing reduced-motion CSS block already covers it** |
| 10 | **three.js r185 WebGPU examples** | <https://github.com/mrdoob/three.js> · MIT · 114,042★ · r185 released 2026-07-01 | 221 `webgpu_*` examples. Specifically `webgpu_instance_points`, `webgpu_compute_particles`, `webgpu_tsl_compute_attractors_particles` — the reference implementations for GPU-instanced point clouds | The terrain ribbons and the Sankey particle overlay. TSL compiles one shader to both WGSL and GLSL |
| 11 | **Nadieh Bremer — Visual Cinnamon** | <https://www.visualcinnamon.com/> · editorial, all rights reserved | "Abstract but readable": radial layouts, custom SVG gradients and filters, hand-tuned annotation, and long-form write-ups showing the *reasoning* | The visual direction for "think abstract". Her SVG gradient/glow technique keeps the DOM inspectable — unlike canvas or WebGL, it does not blind the axe scans |
| 12 | **Bloomberg — Designing the Terminal for Color Accessibility** + **Robinhood "Accessible colors"** | <https://www.bloomberg.com/ux/2021/10/14/designing-the-terminal-for-color-accessibility/> (⚠️ 403s to automated fetch — cited via search index, reasoning corroborated) · <https://robinhood.com/us/en/support/articles/accessibility-options> (verified live) | Move up/down semantics off red/green in a high-stakes financial product — **shipped as a user-selectable scheme, not forced** | The `data-cvd` toggle in `/settings`, beside the existing next-themes switch |
| 13 | **Codrops (three.js tag)** | <https://tympanus.net/codrops/tag/three-js/> · articles editorial; demos carry their own (usually MIT) licences — check per demo | Shader gradients, atmosphere, scroll choreography, WebGPU compute | Material and motion language for the focus-modal backdrop. **Honest label: I checked the recent archive and essentially none of it is data visualisation.** Mine it for material, not for how to encode money |
| 14 | **Radix Colors** | <https://github.com/radix-ui/colors> · MIT · 1,641★ | Twelve steps each with a *declared job* (1–2 backgrounds, 3–5 fills, 6–8 borders, 9–10 solids, 11–12 text), and a dark scale authored independently rather than inverted | Expanding `category-palette.ts` from a solid/soft pair into a stepped scale, so chart fills, hover states, borders and chip text draw from declared steps instead of ad-hoc alpha |
| 15 | **deck.gl `examples/website/plot`** | <https://github.com/visgl/deck.gl/tree/master/examples/website/plot> · MIT · 14,339★ | The custom PlotLayer's **axis, tick and label code** for a 3D surface — the part that makes a 3D chart readable and the part nobody else ships | **Read it, don't install it.** Port the axis logic into the terrain and the extruded treemap. At 7,300 points you need none of deck.gl's scale machinery |

---

## By topic

### 3D & spatial

**The core judgement, stated plainly:** 1,673 transactions, ~7,300 daily-balance points and ~20 holdings
is *tiny* for a GPU. No 3D here is justified by performance or scale. It is justified only where a
genuine third variable exists — time × account × balance, or area × height. Any 3D view encoding one or
two variables is decoration wearing a chart's clothes, and perspective foreshortening plus occlusion
will make it strictly *less* accurate than the 2D chart it replaced.

| Reference | URL | Licence | What to steal | Fit |
|---|---|---|---|---|
| **react-three-fiber** | <https://github.com/pmndrs/react-three-fiber> | MIT · 31,542★ · pushed 2026-07-27 · v9.6.1 | The documented async `gl` prop for `WebGPURenderer`; `frameloop="demand"`; the scaling-performance guide (regress on interaction, adaptive DPR, <1000 draw calls) | React 19 ✅ (peer `react ">=19 <19.3"`, app is on 19.2.7). Next 16 ✅ **as a `'use client'` leaf only**, `next/dynamic({ssr:false})`. Does not render in RSC |
| **three.js r185** | <https://github.com/mrdoob/three.js> | MIT · 114,042★ | `webgpu_instance_points` for the ribbon/point instancing; TSL node materials for attribute-driven colour ramps | Import `three/webgpu` + `three/tsl` **only** inside the client 3D leaf so the WebGPU build never enters the server bundle |
| **drei** | <https://github.com/pmndrs/drei> | MIT · 9,765★ | `<Instances>/<Instance>`, `<Text>` (troika SDF), `<Html>` (real DOM labels — the only way to keep currency crisp and selectable), `<OrthographicCamera>`, `<CameraControls>`, `<Bvh>`, `<AdaptiveDpr>` | ⚠️ **Cadence has slowed.** Stable is 10.7.7 (2025-11-13); v11 alpha-only since 2026-02-03; default-branch commits stop ~2026-01-30. Works with R3F 9 / React 19 today. **Pin the exact version** |
| **three-mesh-bvh** | <https://github.com/gkjohnson/three-mesh-bvh> | MIT · 3,435★ · 0.9.13 (2026-07-18) | BVH-accelerated raycasting — per-pixel hover picking against thousands of instances without dropping to 15fps on a phone | Every hit resolves to a real transaction/account id, so a click opens the existing detail sheet. Used via drei `<Bvh>` |
| **yomotsu/camera-controls** | <https://github.com/yomotsu/camera-controls> | MIT · 2,418★ · 3.1.2 | `fitToBox` / `fitToSphere` and promise-based transitions | The clickthrough: click an account ribbon → camera flies and frames it → drop to the 2D table lens for exact figures. The difference between a toy you fight and a chart that flies to what you clicked |
| **d3-hierarchy** | <https://github.com/d3/d3-hierarchy> | ISC · 1,267★ | `d3.treemap()` squarify tiling | Pure layout module in `src/lib/treemap-layout.ts`, mirroring how `sankey-layout.ts` is already structured and unit-tested. Feeds both the R3F `<Instances>` renderer and the SVG fallback |
| **Niekes/d3-3d** | <https://github.com/Niekes/d3-3d> | BSD-3-Clause · 413★ · 2.0.2 (2026-01-23) | Projects 3D data to 2D and hands you SVG paths | **The honest alternative.** Output is real DOM: every bar is focusable, labelable, axe-scannable and deterministically snapshottable. Pure functions, so it lives in `src/lib/` beside `sankey-layout.ts` |
| **troika-three-text** | <https://github.com/protectwise/troika> | MIT · 1,961★ · 0.52.5 (2026-07-24) | SDF text that stays crisp at any camera distance and DPR | Axis labels only. **Text is what kills most 3D charts** — extruded or bitmap text turns `$1,234.56` to mush at 30° tilt. Rule: troika for labels that rotate with the scene, drei `<Html>` for anything selectable |
| **@paper-design/shaders-react** | <https://github.com/paper-design/shaders> | Apache-2.0 · 3,198★ · 0.0.78 (2026-07-27) | Zero-dependency canvas shaders — mesh gradients, grain, warp — as React components. Read its offscreen-pause logic; that's what most hand-rolled shader components get wrong | "Depth without 3D" for the hero and focus-modal backdrop. ⚠️ Still 0.0.x — pin exact, expect breaking patch releases |
| **regl-scatterplot** | <https://github.com/flekschas/regl-scatterplot> | MIT · 237★ but genuinely active · 1.16.0 (2026-05-08) | GPU 2D scatter with lasso selection, brushing, point connections | **The counter-proposal to a 3D spend scatter.** Same GPU power and lasso interactivity, in 2D where amounts stay comparable |
| **plotly.js + react-plotly.js** | <https://plotly.com/javascript/3d-surface-plots/> | MIT · react-plotly 4.0.0 (2026-06-18) declares peer `react ^18 \|\| ^19` | A working, labelled, hoverable 3D surface in an afternoon | **Prototype only, then delete.** ~1.7 MB for gl3d, ignores your CSS custom properties entirely, imperative so it can never join the lens/URL-state system |
| **echarts-gl** | <https://github.com/ecomfe/echarts-gl> | ⚠️ Repo says BSD-3-Clause, npm says MIT — **unresolved discrepancy** · 2,710★ | surface / bar3D / scatter3D with axes and tooltips wired | **Avoid.** Requires echarts as a third chart engine; canvas output is invisible to the axe scans and the 127 snapshots and cannot read the token contract |
| **react-force-graph-3d** | <https://github.com/vasturiano/react-force-graph> | MIT · 3,244★ | Drop-in 3D force graph | **Spectacle.** At this data size it's a hairball; the sorted merchants table answers every real question better. Its React peer is `*` — meaning React 19 support is *untested*, not asserted |
| **LYGIA shader library** | <https://github.com/patriciogonzalezvivo/lygia> | ⚠️ **Prosperity Public License 3.0.0 — NONCOMMERCIAL only**, verified by reading LICENSE.md. Not MIT | Granular GLSL/WGSL includes: noise, sdf, colour space, easing | Fine for a private personal app; needs a sponsorship the moment it is ever commercialised |
| **MDN WebGPU compat** | <https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API> | — | Ground truth, against the blog hype | Safari 26 ✅ (macOS + iOS), Chrome 113→144 ✅, **Firefox 141 partial** (no Linux, no Intel macOS). MDN still classifies it **"Limited availability", not Baseline.** Several highly-ranked 2026 posts (utsubo.com, vr.org, byteiota.com) claim otherwise and are wrong |

**Proposals for this app**

| Effort | Proposal | Route | Detail |
|---|---|---|---|
| **M** | **`Scene3D.tsx` host — build this FIRST** | new `src/components/charts/Scene3D.tsx`, sibling to `ChartFocus.tsx` | One client-only `<Canvas>` owning the entire fallback and perf policy: WebGL2 as the tested default with WebGPU behind the async `gl` prop; `frameloop="demand"`; `dpr={[1,2]}` + `<AdaptiveDpr>`; IntersectionObserver pause; refuses to mount under reduced-motion or below 768px. Every later scene mounts inside it, so the policy is written once |
| **L** | **Net-worth terrain as a third lens** | `/` — `NetWorthChartPanel.tsx`, added as `{key:"lens", value:"terrain"}` in `chart-window.ts` | ~730 days × 10 accounts is the only genuine 3-variable dataset in the app. Discrete ribbons per account, orthographic camera, four snapped viewpoints, **default camera dead-on front where it reads as today's 2D chart**. Click a ribbon → `fitToBox` → deep-link `/accounts/[id]`. Liabilities extrude *below* the zero plane, so sign is encoded spatially before chromatically |
| **M** | **Extruded portfolio treemap** | `/investments` — a *view option* beside `AllocationDonut.tsx`, never replacing it | Area = position weight, height = total return %, negative returns as sunken pits. Depth carries a *second variable* instead of decorating the first — the most defensible 3D chart available. Pure `treemap-layout.ts` means the same layout drives R3F and the d3-3d SVG fallback |
| **M** | **Cash-flow particles on the existing Sankey** | `/spending` — overlay only, `sankey-layout.ts` untouched | Emission rate ∝ $/month. **Honest label: 60% spectacle, 40% encoding.** Nobody reads dollars off particle density; band widths and StatCards stay authoritative. Killed by reduced-motion, paused off-screen, never on touch |
| **S** | **Say no to the globe** | n/a | cobe and react-globe.gl are the classic "make it look expensive" picks. This app has **zero** geospatial dimension. A spinning globe on a personal-finance dashboard is a lie about the data. Listed so the option is explicitly rejected rather than quietly reappearing |

---

### Animation & motion

MoneyApp starts from an unusually good position: zero animation dependencies, native View Transitions
already working in `ChartFocus.tsx` (`document.startViewTransition` with a correct
`'startViewTransition' in document` feature-detect), a motion token block in `globals.css`, a blanket
`prefers-reduced-motion` collapse, and a "money never wiggles" tabular-nums rule. **Extend that spine;
do not replace it.**

| Reference | URL | Licence | What to steal | Fit |
|---|---|---|---|---|
| **Motion** (ex-Framer Motion) | <https://github.com/motiondivision/motion> | MIT · 32,977★ · pushed 2026-07-27 · v12.42.2 | The layout-projection engine at `packages/motion-dom/src/projection/node/create-projection-node.ts` — FLIP done correctly through nested transformed/scrolled ancestors. Also the duration-based spring API (`visualDuration` + `bounce`) and `MotionConfig reducedMotion="user"` | React 19 ✅ (peer `^18 \|\| ^19`), RSC-safe via a real `./react-client` subpath export. 44.3 kB gzip full; docs claim ~4.6 kB via `LazyMotion` + `m` (vendor figure, unmeasured) |
| **scroll-driven-animations.style** | <https://scroll-driven-animations.style/> | Apache-2.0 (site source) | `animation-timeline: view()` / `scroll()`, with CSS *and* WAAPI versions side by side, plus a DevTools extension | **Zero bundle, zero React coupling, off the main thread.** Chrome 115+, Firefox 132+, Safari 18+. And because they're real CSS animations, the existing reduced-motion block already covers them with no new code |
| **caniuse — View Transitions** | <https://caniuse.com/view-transitions> | CC-BY-4.0 (data) | 88.46% global · Chrome 111+ · Safari 18+ (incl. iOS) · Firefox 144+ | Validates the zero-dependency path already in `ChartFocus.tsx` as the long-term bet, not a stopgap |
| **next-view-transitions** (Shu Ding) | <https://github.com/shuding/next-view-transitions> | MIT · 2,385★ · pushed 2026-03-06 | ~100 lines showing exactly where the App Router navigation lifecycle gives you a hook, and how to avoid the double-transition problem | Cross-route shared-element morphs the app doesn't have: transaction row → merchant header, holding row → symbol page, account card → account page. **Read it before hand-rolling** — Next 16 streams RSC payloads, so the new page may not be painted when the snapshot is taken |
| **NumberFlow** | <https://github.com/barvian/number-flow> | MIT · 7,592★ · 0.6.2 | Odometer built on `Intl.NumberFormat` (formatting is the source of truth, not a string hack), WAAPI inside a custom element with Declarative Shadow DOM, `respectMotionPreference` **true by default**, plus a `nonce` prop for strict CSP | ⚠️ **The app already has `NumberRoll.tsx`** with fixed `w-[1ch]` slots and a `data-changed` attribute. Shipping two odometers is worse than shipping one. See the verdict table |
| **AutoAnimate** | <https://github.com/formkit/auto-animate> | MIT · 13,880★ · pushed 2026-07-10 | 3.2 kB, a few hundred readable lines — genuinely the minimal correct FLIP. Exposes a plugin API so you can override the keyframes to your own vocabulary | `/transactions` on filter/sort change, the review queue, `/budgets`, `/recurring`. ⚠️ **It does not read `prefers-reduced-motion` itself**, and because it drives WAAPI the `globals.css` `!important` collapse does not reach it |
| **Sonner** (Emil Kowalski) | <https://github.com/emilkowalski/sonner> | MIT · 12,720★ · pushed 2025-12-23 | The height-and-stack animation: measure heights imperatively, drive everything through CSS custom properties on transform/opacity only. Plus **hover pauses the dismissal timer** | **Read, don't necessarily adopt.** The measure-then-set-a-CSS-var technique transfers to the split editor and the heatmap day sheet. The hover-pause is a real bug fix: a 5s undo window that expires while you're reading it is a defect on a money app |
| **Vaul** (Emil Kowalski) | <https://github.com/emilkowalski/vaul> | MIT · 8,517★ · pushed 2025-10-03 | Drag-to-dismiss physics: velocity tracking, rubber-band resistance past bounds, snap points, and the scroll-vs-drag disambiguation nobody gets right independently | The owner wants this on a phone, where a centred `<dialog>` is the wrong affordance. ⚠️ ~9-month gap — verify against React 19.2 rather than assuming |
| **anime.js v4** | <https://github.com/juliangarnier/anime> | MIT · 71,546★ · 4.5.0 · pushed 2026-06-22 | ESM-first rewrite with a real timeline, WAAPI mode, draggable and spring modules. **Far more readable source than GSAP's minified-in-repo distribution** | The lighter GSAP alternative if you want scroll-linked timelines without a non-OSI licence in the tree |
| **GSAP + ScrollTrigger** | <https://github.com/greensock/GSAP> | ⚠️ **Standard "no charge" license — free commercial use but NOT OSI-approved.** Verified: `gsap@3.15.0`'s npm licence field literally reads this. All former Club plugins free since April 2025 | ScrollTrigger's batching of DOM reads/writes into a single rAF, and its scroll normalisation. SplitText for character reveals that preserve the accessible text node | A `/spending` "year in review" scroll narrative, if that ever ships. Framework-agnostic so zero React 19 risk. Restriction: cannot be used to build a no-code animation tool competing with Webflow — irrelevant here |
| **Lenis** | <https://github.com/darkroomengineering/lenis> | MIT · 15,004★ · 1.3.25 | The virtual-scroll normalisation across trackpad/wheel/touch in `src/index.ts` — that normalisation *is* the product | **Do not apply app-wide.** Smooth scroll on a dense 1,673-row table actively harms the user's sense of position, desyncs from CSS scroll timelines, and is a recurring a11y complaint. A dedicated scrollytelling section only |
| **Motion Primitives / Magic UI** | <https://github.com/ibelick/motion-primitives> (MIT · 5,758★) · <https://github.com/magicuidesign/magicui> (MIT · 21,701★) | MIT | Magic UI's **animated beam** — connecting two DOM nodes with an animated SVG path that survives resize. Motion Primitives' morphing dialog as a clean `layoutId` read | Pattern quarry, not dependencies. ⚠️ Much of both catalogues assumes Tailwind v3 + `tailwindcss-animate`, which does not work with Tailwind v4's CSS-first config |
| **React `<ViewTransition>` reference** | <https://react.dev/reference/react/ViewTransition> | Docs | The API shape to *imitate* with the native API: `name` for shared elements, `enter`/`exit`/`update`/`share` slots, and the rule that only `startTransition` / `<Suspense>` / `useDeferredValue` updates trigger it | ⚠️ **Not usable here.** Verified empirically in this worktree: `react@19.2.7` exports neither `ViewTransition` nor `unstable_ViewTransition` (both `undefined`). It is canary-only. Next 16's `experimental.viewTransition` flag would force a `react@canary` pin, and Vercel's own docs say "not recommended for production" |

**Proposals for this app**

| Effort | Proposal | Route | Detail |
|---|---|---|---|
| **S** | **Codify the motion vocabulary as tokens before adding any library** | `globals.css` + new `src/lib/motion.ts` | Write the rulebook first, then make every library conform. Full spec below. Enforce it by having `motion.ts` export the only duration/easing constants any JS animation may use, with a lint rule or unit test asserting no raw ms literals in components |
| **M** | **Extend the proven native View Transition to route navigation** | `/transactions → /merchants/[id]`, `/investments → /[assetType]/[symbol]`, `/accounts → /accounts/[id]` | The hard part already works in `ChartFocus.tsx`. Assign a stable `view-transition-name` to the shared element on each side and reuse the existing 440ms morph. ⚠️ Names must be **unique per document at transition time** — set it imperatively on the clicked element only, then clear it |
| **S** | **CSS scroll-driven animations for list reveal** | `/transactions`, `/accounts/[id]`, `/spending` | `view()` on rows for opacity+translateY reveal; `scroll()` on a reading-position rail; sticky group headers that compress as they pin. Wrap in `@supports (animation-timeline: view())`. Follow the existing globals.css doctrine that **every keyframe's resting frame IS the correct final visible state** |
| **M** | **Motion as the ONE JS animation library, narrowly scoped** | `chart-lens.ts`, `ChartFocus.tsx`, `/budgets`, the heatmap day sheet | Four things CSS genuinely cannot do: `AnimatePresence` exits on unmounted elements; `layoutId` morph for the chart⇄table lens; `Reorder` with `useDragControls` (grip handle only — accidental drags on a finance app are hostile); `useSpring` on the scrub crosshair. Mount `<MotionConfig reducedMotion="user">` at the root client boundary |
| **S** | **AutoAnimate on lists that change shape** | `/transactions` filter/sort, `/budgets`, `/recurring`, the review queue | Makes "this row moved" and "this row left" visually distinct — a real comprehension win on a dense table. **Use this instead of Motion's `layout` prop on lists**: layout animations force synchronous layout reads per item. Cap to the rendered window, never the full 1,673 |
| **M** | **Drag-dismissible bottom sheets below the tablet breakpoint** | heatmap day sheet, transaction detail, `ChartFocus` | Keep the native `<dialog>` + `@starting-style` backdrop on desktop; swap to a sheet on small viewports. ⚠️ The sheet's drag must not steal the horizontal drag from a chart's range brush — constrain drag to the handle area |

---

### Data-viz systems

**Verdict up front: stay on recharts.** Not inertia — recharts 3.9/3.10 shipped exactly the escape hatch
this app has been hand-rolling. `useXAxisScale`, `useYAxisScale`, `useCartesianScale`, `useOffset` and
`usePlotArea` were confirmed present in the installed 3.9.2 type definitions; the inverse snap hooks
arrive in 3.10.1. That is a complete data↔pixel bridge — the exact reason teams historically flee
recharts for visx.

Migration cost if you left: rewriting `ScrubChart.tsx` (1,010), `CashFlowChart.tsx` (367),
`CashFlowGraph.tsx` (191), `AllocationDonut.tsx` (156), `AmountHistoryChart.tsx` (155) — ~1,880 lines —
plus reimplementing axes, tooltips, legends, responsive containers and reduced-motion handling, then
re-baselining 127 snapshots. 3–5 sessions with a high regression surface, in exchange for capabilities
3.10 already provides. **Don't.**

| Reference | URL | Licence | What to steal | Fit |
|---|---|---|---|---|
| **recharts** | <https://github.com/recharts/recharts> | MIT · 27,423★ · pushed 2026-07-27 · v3.10.1 (2026-07-25) | The coordinate hooks, `Brush`, `Treemap` (3.9 added `nodeInset`/`nodeGap`), the Sankey a11y layer | Already the renderer for five components. Peer `react ^16.8 \|\| ^17 \|\| ^18 \|\| ^19`. SVG output means the token contract and the axe/snapshot coverage keep working |
| **visx** | <https://github.com/airbnb/visx> | MIT · 20,984★ · v4.0.0 (2026-06-11), peer `react ^18 \|\| ^19` | `@visx/brush` is the reference resizable-brush-with-handles implementation; the `@visx/scale` + `@visx/axis` split is a clean tick-generation model | **Read, don't migrate.** Maintenance caveat is real: Discussion #1908 records a Nov 2025 → Jun 2026 alpha-to-stable gap and users leaving over review latency |
| **Apache ECharts 6** | <https://github.com/apache/echarts> | Apache-2.0 · 66,919★ · 6.1.0 | The new **matrix** and **calendar coordinate systems**, plus chord and beeswarm series — the strongest match in the field for "think abstract" | **Recommended against.** Canvas is invisible to axe and to the 127 visual snapshots, and cannot read the Tailwind v4 custom properties that define the whole token contract — you'd maintain a parallel JS theme and re-apply on every next-themes switch. Build the chord in bespoke SVG instead, reusing the `sankey-layout.ts` approach |
| **TradingView Lightweight Charts** | <https://github.com/tradingview/lightweight-charts> | Apache-2.0 (⚠️ TradingView's terms request a visible attribution notice) · 16,720★ · v5.2.0 | Crosshair tracking without re-rendering the series; price-scale animation decoupled from data updates. The "render the series once to a canvas layer, render the interactive overlay separately" pattern | `/investments/[assetType]/[symbol]` candlesticks + volume pane. **No React peer dependency at all**, so React 19 is a non-issue. `yahoo-finance2` is already a dependency and returns OHLCV |
| **Observable Plot** | <https://github.com/observablehq/plot> | ISC · 5,330★ | Faceted small multiples in three lines; the `document` option renders against a virtual DOM | The only genuine RSC story in this list — pure SVG from a Server Component, zero client JS. ⚠️ **Highest uncertainty here**: 0.6.17 published 2025-02-14 (~17 months), and the SSR path is a one-line capability note with no official React server example. Spike with a hard abort criterion |
| **nivo** | <https://github.com/plouc/nivo> | MIT · 14,069★ | `@nivo/calendar`'s layout, `@nivo/sankey`'s link-path generation | **Reference only.** `@nivo/core` 0.99.0 published 2025-05-23 (~14 months), brings `@react-spring/web` as a hard peer, and its JS-object theming fights the CSS-variable contract. ⚠️ The unscoped `nivo` npm package is a stale trap (0.31.0, peer `react <17`) |
| **Mosaic** (UW IDL) | <https://github.com/uwdata/mosaic> | ⚠️ Site states BSD; **GitHub API reports NOASSERTION — verify** · 1,341★ · pushed 2026-07-27 | The coordinator/selection/client separation — the correct mental model for brushing-and-linking across many charts | Architectural reference for a crossfilter layer over `DashboardWindowContext.tsx`. At 1,673 rows you emphatically do not need DuckDB-WASM |
| **Vega-Lite** | <https://github.com/vega/vega-lite> | BSD-3-Clause · 5,421★ | The clearest formalisation anywhere of interaction grammar: interval/point selection types, `bind`/`resolve` semantics, the facet model | Spec reference. Use its interval-selection semantics to decide what a shared brush *means*: does brushing the net-worth chart **filter** the transaction table, or only **highlight**? |
| **cal-heatmap** | <https://github.com/wa0x6e/cal-heatmap> | MIT · 3,144★ · pushed 2026-07-26 | The **subDomain/domain nesting model**, the legend/tooltip plugin split, month-boundary gutters, day-of-week alignment | Steal the domain/subDomain abstraction into `SpendHeatmap.tsx` so one component renders year-by-day, month-by-day and week-by-hour without a rewrite. Don't add the dep — it's imperative and D3-based |
| **uPlot** | <https://github.com/leeoniya/uPlot> | MIT · 10,350★ | Tens of thousands of points at interactive frame rates | **Listed so the decision is explicit: do not adopt.** Your heaviest series is ~730 points — two orders of magnitude below where it matters. You'd trade CSS-variable theming and axe coverage for a perf problem you don't have |
| **Tremor** | <https://github.com/tremorlabs/tremor> | Apache-2.0 · 3,535★ | — | **A trap.** `@tremor/react` 3.18.7 last published 2025-01-13; repo last pushed 2025-10-10. It's a recharts wrapper with Tailwind v3 conventions. Any 2026 listicle recommending it is repeating stale copy |
| **chroma.js** | <https://github.com/gka/chroma.js> | ⚠️ GitHub reports NOASSERTION; project states Apache-2.0 — verify · 10,576★ | Perceptually-uniform Lab/LCH scale generation, `chroma.contrast()` for programmatic WCAG verification | devDependency that emits static CSS custom properties, keeping it out of the client bundle |

**Proposals for this app**

| Effort | Proposal | Route | Detail |
|---|---|---|---|
| **S** | **Bump recharts 3.9.2 → 3.10.1 and adopt the coordinate hooks** | all chart routes | Do this **first** — several proposals depend on it. Replaces `ratioToIndex`/`clampIndex`/`stepScrubIndex` in `scrub.ts` and the three `ReferenceArea` blocks in `ScrubChart.tsx`. ⚠️ **3.10's Legend change REPLACED the previous alignment props with `position`/`offset` — a silent layout change, not an error. Grep every Legend usage before bumping** |
| **M** | **Small-multiples category grid** | `/spending` | 12 mini sparks on an identical shared y-scale, sorted by total, each in its category hue. Build with the **existing bespoke `Sparkline.tsx` (54 lines, pure SVG)** — stays a Server Component, ships zero client JS, every spark is real DOM. Offer shared-vs-per-cell scale as a lens (shared is honest but crushes small categories flat) |
| **M** | **Annotation layer for life events** | `/` net-worth chart, `/accounts/[id]` | `useCartesianScale` to place `{date,label}`, `usePlotArea` to keep callouts inside the plot. Mark the real story: the Bronx→Miami move, the cash job starting, the Robinhood contribution runs, financial-aid disbursements. **The cheapest "coolness" win on this list.** ⚠️ Do NOT use `susielu/d3-annotation` — 763★ but last pushed 2022-12-03 |
| **L** | **Brushing and linking — one selection, every chart** | `/`, `/spending` | Promote the brush from a per-chart concern to a shared crossfilter selection. Unselected portions **dim rather than disappear**. Persist in the URL beside the lens/range params. ⚠️ Add a persistent "Showing 12 Mar – 4 Jun · Clear" chip, and every StatCard total must recompute against the selection or the page contradicts itself |
| **M** | **Waterfall for budget vs actual** | `/budgets`, `/spending` | The absent FT "Deviation" family. Reuses the `spendingSankey` reconciliation that already provably conserves value. ⚠️ The transparent-base trick means the tooltip must be customised or it reports the invisible base — the classic waterfall bug |
| **S** | **Allocation treemap as a lens on the donut** | `/investments` | 20 holdings makes donut wedges unhoverable; treemap area stays honest at any count and supports in-tile labels. Reuse the pass-23 hover-highlight so both lenses feel like one component |
| **S** | **Ordered dot-plot replacing the top-merchants list** | `/spending` | Cleveland-style, two dots per row (this period vs last, connected). Shows rank AND change in one glance. Pure SVG in an RSC. ⚠️ Pass-23 lesson applies: `truncate` inside a flex item needs `min-w-0` on the flex child |
| **M** | **Candlesticks + volume** | `/investments/[assetType]/[symbol]` | The one place a specialist library beats anything you'd build. Keep the recharts line chart as the default and the accessible path; candlesticks as a lens. ⚠️ Mirror the light/dark token values into its options object and re-apply on theme change |

---

### Fintech & dashboard UI

MoneyApp is past the point where a component library helps — it already has `TransactionsLedger`,
`BulkActionBar`, `CategorizeMode`, `ReviewInbox`, `SplitEditor`, `CommandPalette`, `DataTable`,
`NumberRoll` and a chart⇄table lens. What it lacks is the **interaction grammar**. So the highest-value
references here are behavioural, not visual.

| Reference | URL | Licence | What to steal | Fit |
|---|---|---|---|---|
| **Actual Budget** | <https://github.com/actualbudget/actual> | MIT · 27,770★ · pushed 2026-07-27 | Import flow (see shortlist #3), the rules engine, the budget table. Also "Reimport deleted transactions" so deleted rows don't resurrect | `/imports`, `/budgets`. **The one peer app you may lift code from freely.** React SPA, not App Router, so it's a porting reference |
| **Actual Budget — import docs** | <https://actualbudget.org/docs/transactions/importing> | Vendor docs | Precise enough to implement from: interpreted date shown in green, "negate all amounts" instead of explaining sign conventions, always favour the imported transaction on conflict, near-date + amount + similar-payee duplicate matching | ⚠️ "Imported wins" needs care here: this app's doctrine is that `daily_balances` is a derived cache and truth is transactions + anchors. Imported rows should win over derived state but **must never silently overwrite `source='user'` categories** |
| **Lunch Money — Transaction Actions** | <https://support.lunchmoney.app/finances/transactions/transaction-actions> | Vendor docs (verified by direct fetch) | Far-left checkbox per row; **SHIFT to select a range**; bulk date/payee/category/notes/currency/account/tags, "Link all recurring", "Mark all as reviewed/unreviewed". And: **matched transfer pairs collapse into a single zero-sum row** | `/transactions`. The collapsed-transfer row is directly applicable — the app has a transfer detector and `LinkPanels` already, so the data exists |
| **Monarch Money — reviewing transactions + rules** | <https://help.monarch.com/hc/en-us/articles/5528707082516-Reviewing-Transactions> | Vendor docs | Swipe-right or ✓ to mark reviewed; "Edit multiple" bulk mode; rules that auto-split by percent or dollar **and that can mark a transaction as needing review** | The detail to internalise: **rules should be able to ADD to the queue (flag suspicious rows), not only drain it** |
| **Firefly III** | <https://github.com/firefly-iii/firefly-iii> | ⚠️ **AGPL-3.0** · 24,154★ · pushed 2026-07-27 | The most complete open-source rules engine: triggers, actions, rule groups with ordering, and crucially **"test this rule against existing transactions" preview before applying** | Design reference only (PHP/Laravel). The preview interaction maps exactly onto the guarded dry-run discipline this project already uses for real-DB writes |
| **Midday** | <https://github.com/midday-ai/midday> | ⚠️ **AGPL-3.0** · 14,715★ | Transaction-table density, inline categorization affordances, server-action patterns under App Router | The closest modern reference implementation of *this exact stack*. **Look, don't copy** — AGPL's network clause would arguably apply once this is hosted |
| **Ghostfolio** | <https://github.com/ghostfolio/ghostfolio> | ⚠️ **AGPL-3.0** · 9,016★ · pushed 2026-07-27 | Allocation-by-asset-class/sector/currency breakdowns; benchmark comparison; presenting ~20 holdings without a wall of numbers | `/investments` layout reference. Angular + NestJS, so there's no code to port anyway |
| **YNAB — progress bars guide** | <https://support.ynab.com/en_us/progress-bars-a-guide-SkDEhot09> | Vendor docs | **One row element carrying three states**: where you've overspent, how much is still needed to meet a target, whether you've overspent. Plus the "Ready to Assign" live total | `/budgets` — `BudgetRow.tsx` shows pace status; one bar encoding spent/budgeted/pace compresses three numbers into a glance. The equivalent of "Ready to Assign" here is forecast income minus total budgeted, which `PredictBudgets` already computes |
| **Fintech Dashboard Design (2026)** | <https://www.themasterly.com/blog/fintech-dashboard-design-guide> | Article | The **Role-Metric-Density-Action** framework with checkable examples: Ramp leads with *savings*, Mercury with balance + visible trend, Wise with *pending transfer status* because that's the actual anxiety, Stripe pairs volume/success-rate/error-breakdown with linked logs | `/` — an audit lens. This owner's real question is closer to "am I okay and what needs my attention", which argues for net worth + delta as the hero with the review-queue count as an **attached action, not a co-equal stat** |
| **ScreensDesign / Mobbin** | <https://screensdesign.com/showcase/ynab> · <https://mobbin.com> | Reference sites | Real production screen recordings with timestamps. YNAB's Edit Plan screen with a live-updating "Cost to Be Me" total | The only way to study Copilot Money, which is **iOS/macOS-only with no web app** — every claim about its interface in any research is necessarily second-hand |
| **TanStack Virtual** | <https://github.com/TanStack/virtual> | MIT · 7,021★ · v3.14.8, peer includes `^19` | Headless offsets, you keep your own markup — critical because the ledger rows are bespoke | Only worth it if pagination goes. ⚠️ Breaks Cmd+F, breaks locator-based Playwright assertions, changes what axe sees, and needs measured (not assumed) row heights because `LedgerRowExpander` makes rows variable |
| **TanStack Table v8** | <https://github.com/TanStack/table> | MIT · 28,236★ | `getFacetedUniqueValues` / `getFacetedMinMaxValues` for live filter counts; row-selection state incl. shift-range | ⚠️ **npm's latest is 8.21.3 from 2025-04-14** even though the repo was pushed 2026-07-26 — the recent activity is v9 development. Pin v8. TanStack's own docs warn the React adapter may not work with the React Compiler |
| **React Aria Components** | <https://github.com/adobe/react-spectrum> | Apache-2.0 · 15,727★ · rac 1.19.0 | The only widely-used correct keyboard/ARIA grid model: roving tabindex, arrow-key cell navigation, type-ahead, shift+arrow range select, selection-change announcements. Also **`useNumberField`** for locale-aware currency parsing and clamping | `/transactions` triage, `CategoryPicker`, and as the spec for hardening `InlineEditableAmount.tsx`. **The app runs axe scans — hand-rolling a keyboard grid is the fastest way to start failing them** |
| **Glide Data Grid** | <https://github.com/glideapps/glide-data-grid> | MIT · 5,275★ | — | ⚠️ **Not React 19 compatible.** `@glideapps/glide-data-grid` 6.0.3 declares peer `react '^16.12.0 \|\| 17.x \|\| 18.x'` — 19 is absent |
| **maybe-finance/maybe** | <https://github.com/maybe-finance/maybe> | AGPL-3.0 · 54,358★ | — | ⚠️ **ARCHIVED** (archived=true, last push 2025-07-24). It dominates every "open source personal finance" listicle. Do not build on it or treat its patterns as current |

**Proposals for this app**

| Effort | Proposal | Route | Detail |
|---|---|---|---|
| **M** | **Keyboard triage on the review queue — the single highest-value change** | `/transactions` — `ReviewInbox`, `CategorizeMode`, `TransactionsLedger` | j/k move focus, c opens the category picker, e marks reviewed, s splits, u undoes, x toggles selection, shift+j/k extends, ? opens the sheet. **Render the shortcut hint inline on the focused row.** Wrap the mutation in `useOptimistic` so the row exits before the SQLite write returns. Use React Aria's grid model so axe keeps passing |
| **L** | **Rebuild `/imports` as file → map → validate → commit** | `/imports` | The route with the most real-money consequence. ⚠️ **A mis-mapped sign column silently inverts income.** The commit step must report a delta summary (rows added, income Δ, net worth Δ) before writing, matching the guard pattern used in prior DB passes. And the dev server holds the SQLite file open — that has bitten this project before |
| **L** | **A rules engine that both drains and fills the queue** | `/transactions` `TransactionSheet` + new `/settings/rules` | Born from the action ("Always categorize STARBUCKS as Coffee"), not from a settings page. ⚠️ **Rules must never override rows with `source='user'` — enforce in the service layer with test coverage before any UI is built**, or they destroy the hand-categorization work from passes 18/24. Every rule needs Firefly's "test against existing transactions" preview |
| **S** | **Shift-range select + select-all-matching-filter** | `/transactions` `BulkActionBar`, `FiltersBar` | Two small mechanics that unlock the bulk actions already built. The Gmail escalation ("All 50 on this page are selected — select all 1,204 matching these filters instead") turns bulk categorization from a page-at-a-time grind into one action. ⚠️ Must display the exact affected count and route through the same undo path |
| **S** | **Net-worth hero: one number, one delta, one next action** | `/` | Net worth at very large scale, delta beside it in semantic colour, and **"N transactions need review" as a button, not a stat**. Wire the existing `NumberRoll` so scrubbing the chart rolls the hero figure in sync with the crosshair. Demote the remaining StatCards to a quieter secondary row so hierarchy is scale-driven |
| **M** | **Budget rows carrying three states in one bar** | `/budgets` | YNAB's row language + a live "forecast income minus total budgeted" plan header. ⚠️ The 12-hue ramp plus a red/green pace signal on the same bar risks colour collision — encode pace by position or a tick mark, not hue alone |
| **M** | **Make the command palette act, not just navigate** | global `CommandPalette.tsx` (257 lines, already correct on `<dialog>` + `aria-activedescendant`) | With rows selected, ⌘K offers "Categorize selected as →" (nested page), "Mark selected reviewed", "Add tag", "Split". Show each command's shortcut inline so the palette *teaches* the triage keys. ⚠️ The palette header must show what it will act on ("3 transactions selected"), and nested pages need a clean Escape-to-parent model |
| **S** | **Collapse matched transfer pairs into single net-zero rows** | `/transactions` | Pure rendering change — the detector and `LinkPanels` already exist. ⚠️ **Presentation only**: both rows stay in the database and in every total. Make it a toggle in `FiltersBar`, not a default. Only auto-paired transfers collapse; single-sided detector matches only FLAG |

---

### Interaction craft

| Reference | URL | Licence | What to steal | Fit |
|---|---|---|---|---|
| **Next.js intercepting + parallel routes** | <https://nextjs.org/docs/app/api-reference/file-conventions/intercepting-routes> · <https://nextjs.org/docs/app/api-reference/file-conventions/parallel-routes> | Official docs (v16.2.12) | `(.)` interception renders a detail as a sheet over the list in-app, and as a full standalone page on cold load / refresh / shared link | **There is no `/transactions/[id]` route today** — `TransactionSheet.tsx` is client-only, so a transaction is unlinkable and Back doesn't close it. A direct hit on "view it from phone, tablet and monitor". Same gap for the heatmap day and the P&L calendar day |
| **React `useOptimistic` reference** | <https://react.dev/reference/react/useOptimistic> | Official docs | The rollback contract, stated precisely: if the Action throws, the transition ends and React re-renders the base value — **rollback is automatic but SILENT** | The app uses `useOptimistic` in ~20 components. ⚠️ **On a money app this is the highest-severity item in the whole document**: a recategorization the owner believes landed can quietly revert, and the next thing he sees is a wrong income total |
| **react-error-boundary** | <https://github.com/bvaughn/react-error-boundary> | MIT · 7,973★ · 6.1.2 | `ErrorBoundary`, `useErrorBoundary`, `onReset`/`resetKeys`, `FallbackComponent` | Wrap independently-failing widgets (Yahoo price fetch, Sankey, XIRR) so one degrades in place instead of blanking the route. Pair with Next's `error.tsx` `reset()` prop |
| **IBM Carbon — Loading pattern** | <https://carbondesignsystem.com/patterns/loading-pattern/> · <https://carbondesignsystem.com/patterns/empty-states-pattern/> | Public docs (Carbon is Apache-2.0) | Skeletons on **container/data components only** — never buttons, inputs, checkboxes, toggles, toasts, dropdown items, or the modal itself (elements *inside* a modal may skeleton). Load progressively in batches, structure first | Direct spec for rewriting `Skeleton.tsx` (currently 29 lines, one generic `aria-hidden` pulse) into per-surface skeletons |
| **NN/g — Skeleton Screens 101 + Progressive Disclosure** | <https://www.nngroup.com/articles/skeleton-screens/> · <https://www.nngroup.com/articles/progressive-disclosure/> | Copyrighted — cite, don't copy | When a skeleton beats a spinner, and the insistence that **the skeleton must mimic the final layout** — mismatched skeletons cause layout shift and feel worse than nothing | Governs every new `loading.tsx`. Progressive disclosure governs `LedgerRowExpander`, `TransactionSheet` field order, and how much of the split editor shows before it's asked for |
| **W3C WAI-ARIA APG** | <https://www.w3.org/WAI/ARIA/apg/patterns/> | W3C doc licence | Grid (roving tabindex + multi-select), Combobox, Dialog Modal, Disclosure, Window Splitter, Toolbar, Alert — with working reference implementations | **axe cannot detect a missing keyboard interaction model, only bad markup.** Use APG as the manual checklist: `BulkActionBar` as a toolbar with roving tabindex, `LedgerRowExpander` as a disclosure, the splitter's arrow-key resize |
| **react-resizable-panels** | <https://github.com/bvaughn/react-resizable-panels> | MIT · 5,330★ · v4.12.2 (2026-07-12) | Correct WAI-ARIA `separator` semantics with arrow-key increments, constrained min/max, collapsible panels, `autoSaveId` layout persistence. Its README even cites the Apple HIG 20pt/28pt hit-target guidance | Upgrades the chart⇄table lens from either/or into a real **`split`** value: chart left, `ScrubTable` right, draggable divider, layout persisted **per breakpoint** so phone, tablet and monitor each remember their own |
| **react-grid-layout v2** | <https://github.com/react-grid-layout/react-grid-layout> | MIT · 22,370★ · 2.2.3 (2026-03-24) | v2.0.0 is a full TypeScript rewrite with a hooks API (`useContainerWidth`, `useGridLayout`, `useResponsiveLayout`) and **no `findDOMNode` dependency** — which React 19 removed | A user-composed dashboard. ⚠️ Breaking change: `width` is now required. ⚠️ **Drag is pointer-only — you MUST ship a keyboard alternative or the dashboard becomes keyboard-inoperable and axe will not catch it** |
| **Pragmatic drag and drop** (Atlassian) | <https://github.com/atlassian/pragmatic-drag-and-drop> | Apache-2.0 per npm; ⚠️ GitHub shows NOASSERTION for the monorepo | Built on native HTML5 DnD rather than pointer events — ~4.7 kB core, framework-agnostic, **so it does not couple to a React version at all**. Powers Jira and Trello | The safest drag choice on React 19. Category ordering, budget priority, dragging a transaction onto a category chip |
| **React Aria — drag and drop** | <https://react-spectrum.adobe.com/react-aria/dnd.html> | Apache-2.0 | **The only mainstream DnD with a genuine keyboard path** — Enter to pick up, arrows to move, Enter to drop, with screen-reader announcements | Every other library here is mouse/touch-only. Read it and implement the keyboard mode even if you use another library for the pointer path |
| **Radix Hover Card** | <https://www.radix-ui.com/primitives/docs/components/hover-card> | MIT · 19,098★ · 1.1.23, peer `react ^19.0` | Hover-intent timing that prevents flicker when the pointer crosses a gap; Floating UI positioning; collision handling | Merchant/category/holding preview cards. ⚠️ **Its own docs say: "intended for sighted users only, the content will be inaccessible to keyboard users."** Nothing may live *only* in a preview — and hover doesn't exist on the tablet he wants to use |
| **nuqs** | <https://github.com/47ng/nuqs> | MIT · 10,708★ · 2.9.2 (2026-07-24) | Search params as `useState`-shaped hooks with parsers, defaults, shallow-vs-server routing, transition integration | ⚠️ **Two-sources-of-truth risk**: adopting it while `transactions/query.ts` and `chart-lens.ts` still hand-parse searchParams gives two systems writing the same URL, and filter state desyncs on back/forward. Migrate a surface completely or leave it alone |
| **cmdk** | <https://github.com/dip/cmdk> | MIT · 12,837★ | Fuzzy scoring, **nested "pages"** with a breadcrumb, `Command.Loading` for async sources, `Command.Empty` | ⚠️ **The repo MOVED** — `pacocoursey/cmdk` now 301-redirects to `dip/cmdk`. Last push 2025-10-29, npm 1.1.1 published 2025-03-14. **Reference, don't adopt** — the app's palette is already better-integrated |

**Proposals for this app**

| Effort | Proposal | Route | Detail |
|---|---|---|---|
| **M** | **Ship per-route `loading.tsx`, `error.tsx`, `not-found.tsx` — the biggest verified gap in the app** | all 15 routes; start with `/transactions`, `/investments`, `/spending`, `/accounts/[id]` | Skeletons that **match that route's real layout**; error copy that names what failed ("Could not reach the price service — your balances are unaffected") rather than "Something went wrong"; `not-found.tsx` for the five dynamic segments. ⚠️ Pair every skeleton with `aria-busy` or an `aria-live` "Loading…" — the current `Skeleton.tsx` is `aria-hidden` with no companion, so screen-reader users get total silence |
| **L** | **Faceted filter chips with live counts, URL-backed** | `/transactions` `FiltersBar.tsx`, `query.ts` | Chips open popovers of facet values **with counts** ("Groceries 214", "Chase •4821 619"), individually removable, "x filters · N of 1,673" inline. Compute counts server-side — you have 1,673 rows in SQLite and the server already knows the totals. Result count in an `aria-live="polite"` region |
| **M** | **Give a transaction a real URL** | new `src/app/transactions/[id]/` + `@modal` slot | Sheet from the ledger, full page on cold load. Back closes the sheet; Cmd-click opens the page; the URL is shareable **from the monitor to the phone**. Same pattern for the heatmap day and the P&L calendar day. ⚠️ Needs `default.tsx` in the modal slot, and `router.back()` after a full-page entry can escape the app — test both paths |
| **S** | **Harden optimistic updates + pause the undo timer on hover** | ~20 `useOptimistic` call sites, `Toast.tsx`, `undo-toast.ts` | Every catch emits a destructive-variant toast naming what reverted. Hover or focus **pauses** the dismissal countdown, and the toast is swipe-dismissable on touch. Fix all call sites or the failure feedback becomes unpredictable, which is worse than uniformly silent |
| **L** | **Chart⇄table lens becomes a resizable split; dashboard becomes rearrangeable** | `/`, `/accounts/[id]`, `/investments/[assetType]/[symbol]`, `/spending` | `split` joins `chart`/`table` — **additive, per the standing "don't delete anything" rule**. `autoSaveId` persistence per breakpoint. ⚠️ A user-rearrangeable dashboard invalidates fixed visual snapshots unless tests pin a known layout |
| **S** | **Three-variant, action-bearing `EmptyState`** | app-wide (currently 15 lines, no action slot, no variants) | **No data yet** ("No budgets yet" → "Create a budget from last month's spending", which `PredictBudgets` can already generate) · **No results** ("No transactions match these 3 filters" → "Clear filters" + the nearest non-empty facet) · **Error** (distinct treatment + retry). With 1,673 rows and dense filters, empty results are common |
| **M** | **Hover-preview cards on merchant / category / holding chips** | `/transactions`, `/spending`, `/investments` | 6-month sparkline, total, count, default category. ⚠️ Precompute the aggregates server-side with the page — a query per hover will hammer SQLite as the pointer sweeps a table. And the chip must **also** be a real link, because hover cards are keyboard-inaccessible by design |

---

### Colour & typography

Every number in this section was computed, not asserted — culori's Machado-2009 CVD matrices for the
simulations, the repo's own `contrastRatio()` (Ottosson OKLab→sRGB) for the WCAG figures, and fontTools
against this repo's own `node_modules` for the font tables.

| Reference | URL | Licence | What to steal | Fit |
|---|---|---|---|---|
| **culori** | <https://github.com/Evercoder/culori> | MIT · 1,217★ · pushed 2026-07-02 | OKLCH, `differenceCiede2000`, `wcagContrast`, and `filterDeficiencyDeuter` / `filterDeficiencyProt` / `filterDeficiencyTrit` built on Machado, Oliveira & Fernandes (2009) | **devDependency.** Extends `src/lib/category-palette.test.ts` with a CVD gate. Pure JS, no DOM, no React — orthogonal to everything |
| **Okabe & Ito — Color Universal Design** | <https://jfly.uni-koeln.de/color/> | Public educational resource (page last modified 2008 — cite, don't claim authorship) | The canonical CVD-safe eight, and the **redundancy principle**: shape, position, line type, pattern alongside colour, never colour alone | The calibration constant. Benchmarked: worst pair ΔE 21.7 normal / **12.6 deuteranopia** / 12.9 protanopia. Converted to OKLCH they land at L 0.53–0.90 — deliberately **not** isoluminant, which is exactly what MoneyApp's ramp is missing |
| **Radix Colors** | <https://github.com/radix-ui/colors> | MIT · 1,641★ | Twelve steps with declared jobs; the dark scale authored independently rather than inverted; steps 11/12 carry a guaranteed APCA Lc 60 / Lc 90 contract against step 2 | Structural model for expanding `category-palette.ts` past a solid/soft pair. **A contrast contract expressed as a design rule** — the same discipline the palette test already enforces in WCAG terms |
| **Harmony / Harmonizer** (Evil Martians) | <https://github.com/evilmartians/harmony> | MIT · 247★ · pushed 2026-07-25 (actively maintained) | Palettes with consistent chroma **and** consistent APCA contrast across every level and hue | Would regenerate the whole `CATEGORY_PALETTE` table as a contrast-consistent ramp with a deliberate lightness staircase. ⚠️ Use this, **not** `ardov/huetone` — huetone is still cited everywhere as *the* APCA tool but was last pushed 2023-11-19 |
| **oklch.com** (Evil Martians) | <https://oklch.com/> | Site free to use; ⚠️ repo reports NOASSERTION — verify before vendoring code | Live sRGB/P3 gamut boundaries drawn on the chroma slider — it shows the moment a chosen L/C/H falls out of gamut | Day-to-day authoring. The app already has `isInSrgbGamut()` in `color-contrast.ts`, so tool and test agree on the same constraint |
| **apcach** | <https://github.com/antiflasher/apcach> | MIT · 186★ · updated 2026-07-08 | Composes colours **to a target APCA contrast** — inverts the workflow: declare "Lc 60 against `--surface`" and get the chroma-maximal OKLCH that satisfies it | Chart strokes, 1px gridlines and 11px ticks are graphical objects where WCAG 2.x luminance is known to misjudge, especially light-on-dark |
| **APCA / SAPC-APCA** | <https://github.com/Myndex/SAPC-APCA> | ⚠️ **NOASSERTION on GitHub — carries a custom beta licence.** Use the `apca-w3` npm package | The perceptual model behind the WCAG 3 draft | **Add beside `contrastRatio()`, never replace it.** APCA is a draft, not ratified, and its own author warns against conformance claims from beta versions. WCAG 2.x is the legally-referenced one |
| **Adobe Leonardo** | <https://github.com/adobe/leonardo> | Apache-2.0 · 2,131★ | Generates scales **from contrast ratios** rather than hand-picked stops; adaptive theming re-derives the whole palette from a background lightness parameter | Would make the light/dark pair *derived* rather than independently authored, removing a class of drift the palette test currently has to police |
| **Inter** | <https://github.com/rsms/inter> | SIL OFL-1.1 · 19,749★ · v4.1 (2024-11-16) | `tnum` (documented for tabular data), `zero` (slashed), `frac`, `sups`/`subs`, ss01–ss08, wght 100–900, optical size | **The figures face.** ⚠️ Repo last pushed 2024-11-19 — stable and finished, not abandoned, but expect no bugfixes |
| **Geist** | <https://github.com/vercel/geist-font> | SIL OFL-1.1 · 3,549★ · pushed 2026-07-14 | — | **Keep for chrome. Stop relying on it for figures.** Verified in-repo: no `tnum`, no `lnum`, no `zero`; proportional digits. Also switch the loaded face to `Geist-Variable.ttf` to collapse 40 static instances to one axis |
| **IBM Plex** | <https://github.com/IBM/plex> | SIL OFL-1.1 · 11,527★ · pushed 2026-06-12 | The only coherent Sans + Serif + Mono + Condensed superfamily from one design brief | The "one family, whole system" option — solves the pairing problem and the numerals problem in one decision. A bigger swing than adding Inter |
| **Fraunces** | <https://github.com/undercasetype/Fraunces> | SIL OFL-1.1 · 742★ · pushed 2026-02-11 | Variable opsz / SOFT / WONK axes — restrained at 14px, genuinely characterful at 96px, from one file | The display face. What turns "editorial finance" from a colour claim into a typographic one. ⚠️ **Its `tnum` table was NOT verified locally** — run the same fontTools check before shipping it on a hero numeral |
| **Martian Mono** (Evil Martians) | <https://github.com/evilmartians/mono> | SIL OFL-1.1 · 2,706★ · pushed 2026-07-23 | A variable **width** axis: narrow in a dense ledger, wide in a hero, from one file | Alternative to Geist Mono for `.figures` if you want to stay monospaced. ⚠️ It is a deliberately WIDE mono — the 320px ledger is the test that decides between it and IBM Plex Mono |
| **Roboto Flex** | <https://github.com/googlefonts/roboto-flex> | SIL OFL-1.1 · 522★ · pushed 2026-06-17 | The **GRAD axis** (−200…150): changes apparent stroke weight **without changing advance widths**, so text does not reflow | The only correct technical fix for dark-mode optical bloom. On Geist (wght only) the same effect requires a weight step-down, which **does** shift widths and would move every money column |
| **Utopia** | <https://utopia.fyi/type/calculator/> | Free tool; the CSS is yours | Fluid `clamp()` scales from min/max viewport, size and ratio, with a visualiser for behaviour between breakpoints | `globals.css` defines radius, duration and easing tokens and **zero type-scale tokens** — sizes are ad-hoc Tailwind utilities across 122 components. One scale then covers phone, tablet and monitor with no per-breakpoint overrides |

**Proposals for this app**

| Effort | Proposal | Route | Detail |
|---|---|---|---|
| **M** | **Fix the numerals foundation** | `globals.css` `.figures` (lines 230–234), `layout.tsx`, **every recharts `tick` object** | Load a `tnum`-carrying face as `--font-figures`, repoint `.figures` with `tabular-nums lining-nums` + `'zero' 1`, add `fontFamily` to every tick object, apply `.figures` to the four components that never reference it (`BudgetRow`, `RecurringCalendar`, `CashFlowView`, `MonthlyTrendBars`). **Then add a unit test that greps the TTF feature table** so the guarantee cannot silently regress — the same test-the-invariant discipline `category-palette.test.ts` already uses. (171 `formatCents` call sites; only 25 on a line that also names `figures`) |
| **M** | **Ship an "Accessible colours" toggle** | `globals.css` `--gain`/`--loss`, a control in `/settings` beside the theme switch | Two token swaps behind a `data-cvd` attribute on `<html>`, riding the same mechanism as `.dark`. **Opt-in, never forced** — green-up/red-down is a convention the owner has used his whole investing life. Independently, add a ▲/▼ or +/− glyph everywhere sign matters so colour is never the only channel |
| **S** | **Add a CVD gate to the existing palette test** | `category-palette.test.ts` + new `src/lib/color-vision.ts` | Assert minimum ΔE2000 under `filterDeficiencyDeuter(1)` and `filterDeficiencyProt(1)` for the gain/loss pair and for any set of hues one chart shows simultaneously. **Anchor the threshold on Okabe-Ito's measured ~12.6 floor and put that provenance in a comment**, or a future reader changes the constant on vibes. Today the ramp would fail at ΔE 0.8 |
| **M** | **Cap simultaneous categorical colour at ~6** | `category-palette.ts`, `AllocationDonut`, `SankeyChart`, `/spending` charts, heatmap | Twelve CVD-distinguishable hues is **not achievable** — Okabe-Ito's canonical eight bottom out at 12.6 and an L-staircase rewrite of the twelve only reaches 3.2. Split the jobs: keep 12 as *identity* (chip, dot, icon — always adjacent to a text label), never let more than ~6 carry meaning alone in one chart. Colour the top N by magnitude, collapse the tail into one neutral "Other", **direct-label instead of a legend**. Nothing gets deleted |
| **M** | **Break the isoluminant ramp with a lightness staircase** | `category-palette.ts` + its `globals.css` mirror | All 12 light solids sit at L 0.50–0.53, all dark at 0.72–0.75. A tested alternating staircase (~0.42/0.62) improved the worst *normal-vision* pair from ΔE 8.9 to 14.6. **Honest: it does NOT fix colourblindness** (0.8 → 3.2 only) — but it makes the ramp survive greyscale, cheap displays and screenshots, and gives charts a natural hierarchy. Also fixes the dark `-soft` tints, all pinned at exactly L 0.30 — that is naive derivation, not a designed dark scale |
| **M** | **Introduce a real type pairing and a fluid scale** | `globals.css` `@theme inline`, `layout.tsx`, section headers | Register `--text-*` clamp tokens; add a variable display serif for hero figures and section heads. **The app is currently one neo-grotesque plus its own mono — that is not a pairing.** ⚠️ Fonts are render-blocking in a way JS is not: they hit LCP and CLS directly, so "the owner doesn't care about bundle size" does not fully apply. Subset aggressively, use `next/font`, set `size-adjust` on the fallback |
| **M** | **APCA layer for data ink** | `color-contrast.ts` + chart stroke/gridline/tick tokens | Declare Lc targets for chart strokes and 11px ticks separately from chrome. **Add beside the WCAG gate, never replace it** |

---

## Libraries to actually install

Bundle figures are gzip. Where a number comes from a vendor claim rather than a measurement, it says so.
**Nothing in this table was installed and measured in this codebase** — every compatibility claim comes
from declared peer ranges, package `exports` maps and vendor docs. Validate with a real install plus
`pnpm typecheck` and the 1,536-test gate before committing.

| Library | Purpose here | Bundle | React 19 / Next 16 / TW4 | Verdict | What it replaces / augments |
|---|---|---|---|---|---|
| **recharts 3.10.1** (bump from 3.9.2) | Inverse scale hooks, `getRelativeCoordinate`, Treemap gutters, Sankey a11y layer | already present | ✅ peer includes `^19`; needs `'use client'` (already is) | **ADOPT — do this first** | Replaces hand-rolled math in `scrub.ts` + `ScrubChart.tsx`. ⚠️ Grep every `Legend` — 3.10 replaced alignment props with `position`/`offset` |
| **culori** | CVD + contrast maths in tests | 0 (devDep) | ✅ pure JS, no React coupling | **ADOPT** | Extends `category-palette.test.ts` with a colour-vision gate |
| **react-error-boundary** 6.1.2 | Per-widget degradation | ~2 kB | ✅ peer `^18 \|\| ^19` | **ADOPT** | Wraps the price fetch, Sankey, XIRR. Pairs with the new `error.tsx` files |
| **react-resizable-panels** 4.12.2 | The `split` lens value | ~9 kB | ✅ peer `^18 \|\| ^19`, client-only, className-styled | **ADOPT** | Augments `chart-lens.ts` — adds a third lens value, deletes nothing |
| **react-aria-components** 1.19.0 | Correct grid keyboard model, `useNumberField` | tree-shakeable; import per-component | ✅ peer includes `^19`; client-only hooks | **ADOPT (scoped)** | Wraps `TransactionsLedger` rows for triage. Prevents the axe regression a hand-rolled keyboard grid would cause |
| **Inter Variable** (`next/font/local`) | The figures face | ~1 font file, subsettable | ✅ `next/font` is a Next 16 first-class API | **ADOPT** | Replaces Geist Mono inside `.figures`. **Verify `tnum` with fontTools first — 30 seconds, and Geist looked fine on paper too** |
| **@react-three/fiber 9.6.1 + three r185** | The 3D engine | ~205 kB (three ~170 + R3F ~35), route- and lens-split | ⚠️ peer `react ">=19 <19.3"` — installs on 19.2.7, **breaks on a routine 19.3 bump**. Client leaf only, `next/dynamic({ssr:false})` | **ADOPT (scoped, pin React)** | New capability. Must never reach the initial bundle — add a bundle-budget assertion in CI |
| **@react-three/drei 10.7.7** | Instances, SDF text, Html, ortho camera, BVH, AdaptiveDpr | ~30 kB (subset) | ✅ peer `react ^19`, `@react-three/fiber ^9` | **ADOPT — pin EXACT** | ⚠️ v11 alpha-only since 2026-02-03, branch commits stop ~2026-01-30. Budget for vendoring the 4–5 helpers actually used if it stalls |
| **three-mesh-bvh 0.9.13** | Hover picking at 60fps on a phone | ~25 kB | ✅ peer is `three` only | **ADOPT (with R3F)** | Makes "everything is interactive" a frame-budget reality rather than an aspiration |
| **d3-hierarchy** | Squarified treemap layout | ~10 kB | ✅ pure functions, runs server-side and in tests | **ADOPT (with the treemap)** | Powers `src/lib/treemap-layout.ts`, feeding both the R3F and SVG renderers |
| **motion 12.42.2** | `AnimatePresence` exits, `layoutId` morph, `Reorder`, `useSpring` | 44.3 kB full; vendor claims ~4.6 kB via `LazyMotion` + `m` (**unmeasured**) | ✅ peer `^18 \|\| ^19`, real `./react-client` RSC export | **TRIAL** | ⚠️ Its JS animations **bypass the `globals.css` `!important` reduced-motion collapse entirely** — `MotionConfig reducedMotion="user"` is what covers you. Add an e2e assertion under emulated reduced motion |
| **@formkit/auto-animate** | FLIP on lists that change shape | 3.2 kB | ✅ no React constraint in peers | **TRIAL** | ⚠️ Does not read `prefers-reduced-motion` itself and drives WAAPI, so the CSS collapse doesn't reach it. Gate with `matchMedia` |
| **lightweight-charts 5.2.0** | Candlesticks + volume | ~50 kB, route-split | ✅ **no React peer dependency at all** | **TRIAL (one route)** | Augments — the recharts line chart stays the default and the accessible path. ⚠️ Apache-2.0 but TradingView requests visible attribution |
| **vaul** | Mobile bottom sheets | ~12 kB + Radix Dialog | ✅ but ⚠️ last push 2025-10-03 — **verify against React 19.2, don't assume** | **TRIAL** | ⚠️ Brings a Radix Dialog dependency that duplicates the native `<dialog>` approach. Decide on one modal primitive, or read it and port the velocity/rubber-band maths |
| **@number-flow/react 0.6.2** | Odometer on money figures | 6.1 kB | ✅ peer `^18 \|\| ^19`; needs `'use client'` (custom element) | **HOLD** | **The app already has `NumberRoll.tsx`** with fixed `1ch` slots, a never-on-mount contract and a `data-changed` attribute nothing consumes. Two odometers is worse than one. Spend the effort wiring `NumberRoll` to the hero and the scrub instead |
| **@tanstack/react-virtual** | Unpaginated 1,673-row ledger | ~5 kB | ✅ peer includes `^19` | **HOLD** | Only if pagination goes — it's a *prerequisite for keyboard triage*, not a perf fix. ⚠️ Breaks Cmd+F, breaks row-counting Playwright locators, changes what axe sees |
| **@tanstack/react-table 8.21.3** | Faceted counts, selection state | ~14 kB | ✅ peer `>=16.8`; ⚠️ docs warn about the React Compiler | **HOLD** | Compute facet counts **server-side** — you have 1,673 rows in SQLite and the server already knows the totals. Adding a second table system beside `DataTable.tsx` invites drift |
| **nuqs 2.9.2** | URL-as-state | ~5 kB | ✅ peer `next >=14.2`, `react ^19` | **HOLD** | ⚠️ Two sources of URL truth while `query.ts` and `chart-lens.ts` still hand-parse. Migrate a surface completely or not at all |
| **@paper-design/shaders-react 0.0.78** | Ambient grain/gradient | 73.9 kB full — import individual shaders | ✅ peer `^18 \|\| ^19` | **HOLD** | Purely decorative. ⚠️ 0.0.x, API not stable, pin exact. Must stay behind content at low contrast or it eats the AA-verified pairs |
| **dnd-kit / pragmatic-drag-and-drop** | Reordering | ~10 kB / ~4.7 kB | ✅ (pragmatic has no React coupling at all) | **HOLD** | Only when a reorder feature actually ships. ⚠️ `@dnd-kit/react` is 0.5.0 — the pre-1.0 rewrite; the mature path is `@dnd-kit/core` + `/sortable` |
| **GSAP 3.15** | Scroll-linked timelines | 26.7 kB core + ScrollTrigger | ✅ framework-agnostic | **HOLD** | Only if the `/spending` scrollytelling ever ships. ⚠️ Free but **NOT OSI-approved** — worth knowing if MoneyApp is ever open-sourced |
| **visx 4.0.0** | Treemap, beeswarm, voronoi | per-package | ✅ peer `^18 \|\| ^19` | **HOLD** | recharts 3.10's Treemap plus bespoke SVG covers the realistic need. Read `@visx/brush`'s handle/resize model and port the ideas |
| **Observable Plot** | RSC-rendered faceted small multiples | ~50 kB server-side | ⚠️ virtual-DOM SSR path is a one-line capability note, no React server example | **HOLD (spike only)** | Timebox with a hard abort criterion. ⚠️ 0.6.17 published 2025-02-14 — ~17 months without a release |
| **react-plotly.js 4.0.0** | Prototype the terrain's legibility | ~1.7 MB gl3d | ✅ peer `^18 \|\| ^19` | **TRIAL — then DELETE** | ⚠️ **The trap is keeping it.** It ignores your CSS custom properties, and it's imperative so it can never join the lens/URL-state system. One hour on a throwaway `/design` route, then remove |
| **echarts / echarts-gl** | Chord, matrix, calendar coordinates | 60 MB unpacked; needs a custom `echarts/core` build | ✅ imperative, no React issue | **AVOID** | Canvas is invisible to axe and to 127 visual snapshots, and cannot read the Tailwind v4 custom properties. Build the chord in bespoke SVG reusing the `sankey-layout.ts` approach |
| **nivo** | Calendar, sunburst | — | ✅ scoped packages only | **AVOID** | `@nivo/core` 0.99.0 published 2025-05-23; brings `@react-spring/web` as a hard peer; JS-object theming fights the CSS-variable contract |
| **Tremor** | "Fintech dashboard components" | — | ⚠️ Tailwind v3 conventions | **AVOID** | Stale (npm 2025-01-13). It's recharts underneath, and its whole value proposition — pre-styled dashboard defaults — is the opposite of what this app wants |
| **Glide Data Grid** | Data grid | — | ❌ **peer caps at React 18** | **AVOID** | Use TanStack Virtual with your own row markup |
| **uPlot** | Fast time series | ~40 kB | ✅ | **AVOID** | Solves a perf problem you don't have, at the cost of CSS-variable theming and snapshot/axe coverage |
| **react-force-graph-3d** | Merchant constellation | large | ⚠️ peer is `*` — untested, not asserted | **AVOID** | Hairball at this data size. The sorted merchants table conveys strictly more |
| **Lenis** | Smooth scroll | 5.2 kB | ✅ | **AVOID app-wide** | Degrades sense of position on a dense table, desyncs from CSS scroll timelines, recurring a11y complaint |
| **tw-animate-css** | Tailwind v4 replacement for `tailwindcss-animate` | ~3 kB CSS | ✅ TW4-specific | **AVOID** | Only needed if you paste Magic UI / shadcn snippets. **The app has a deliberate token contract; a second utility vocabulary dilutes it.** Hand-write the four or five keyframes you need |
| **deck.gl** | 3D plot axes | 14 MB+ | ✅ | **AVOID as a dependency** | **Read** `examples/website/plot`'s axis/tick/label code. You need none of its scale machinery for 7,300 points |
| **LYGIA** | Shader includes | — | ✅ | **AVOID** | ⚠️ **Prosperity Public License 3.0.0 — noncommercial.** Fine privately; needs a sponsorship if ever commercialised |
| **cmdk** | Command menu | ~8 kB | ✅ peer `^18 \|\| ^19` | **AVOID (read instead)** | The app's `CommandPalette.tsx` is already better-integrated. Steal the nested-pages model and `Command.Loading` |
| **Base UI** | Unstyled primitives | — | ✅ peer `^17 \|\| ^18 \|\| ^19` | **HOLD** | Latest published is `1.0.0-rc.0` (2025-12-04). Read it; don't build load-bearing surfaces on it yet |

---

## The motion vocabulary

One spec for the whole app. It **extends** the existing block in `globals.css` — nothing currently there
is redefined, so no existing animation changes behaviour until it opts in.

The three gaps in what's there today: (1) no comfortable middle between 150ms and 300ms; (2) the 440ms
`::view-transition-group(chart-focus)` duration is a hard-coded magic number rather than a token; (3)
`--ease-spring` has no stated rule for *when* overshoot is legitimate, so it will eventually get applied
to a number the user never touched.

### The laws

1. **Money decelerates; it does not bounce.** `--ease-spring` (overshoot) is for **direct-manipulation
   results only** — a drag release, a sheet snap, the chart-focus morph the user initiated. Overshoot
   reads as "physical object I pushed", which is a lie about a figure that changed on its own.
2. **Nothing animates that the user is currently reading.** Axis ticks and gridlines freeze during a
   scrub — only the crosshair moves. Table row height never changes on hover. Column widths never move.
3. **Money never animates on mount.** Counting a figure up from 0 on first paint fabricates a change
   event that did not happen. This is the single most common finance-dashboard motion sin, and
   `NumberRoll.tsx` already gets it right — preserve that contract everywhere.
4. **The sign, currency symbol and decimal point never move.** Digits translate vertically inside
   fixed-width slots. `NumberRoll`'s `w-[1ch]` slot already guarantees this regardless of the font's own
   metrics.
5. **Exits are ~0.8× entrances, and use ease-in.** Content leaving must not linger.
6. **Stagger caps at ~300ms total regardless of count** — per-item delay `min(30ms, 300ms / n)`. The
   1,673-row ledger never staggers per row; stagger the ~8 visible day-groups.
7. **Every keyframe's resting frame IS the correct final visible state.** Already documented at
   `globals.css:203` — this is what makes the reduced-motion collapse safe. Do not regress it.
8. **One morph duration app-wide.** Inline-card → focus modal, ledger row → transaction page, chart →
   3D lens all use `--duration-morph`, so every spatial transition feels like one system.

### The tokens

```css
@theme inline {
  /* ── existing, unchanged ───────────────────────────────────────────── */
  --duration-fast: 150ms;              /* hover, focus, chip toggle, tooltip     */
  --duration-normal: 300ms;            /* NumberRoll already uses this           */
  --duration-slow: 600ms;              /* RESERVED: scroll narrative only        */
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.3, 0.64, 1);
  --ease-in-out-sine: cubic-bezier(0.37, 0, 0.63, 1);

  /* ── added ─────────────────────────────────────────────────────────── */
  --duration-tap: 120ms;               /* active press, cell flash start          */
  --duration-medium: 280ms;            /* THE MISSING MIDDLE: row expand, sheet
                                          open, lens swap, bar + annotation fade  */
  --duration-morph: 440ms;             /* promotes the hard-coded chart-focus
                                          value to a real token                   */
  --duration-camera: 620ms;            /* 3D viewpoint flights only               */

  --ease-settle: cubic-bezier(0.22, 0.92, 0.30, 1);   /* arrives and STOPS.
                                          The default for anything entering or
                                          settling that the user did not drag.    */
  --ease-exit: cubic-bezier(0.50, 0, 0.85, 0.35);     /* accelerating; exits      */
  --ease-camera: cubic-bezier(0.22, 1, 0.28, 1);      /* long tail, ZERO overshoot */

  /* ── choreography ──────────────────────────────────────────────────── */
  --stagger-step: 34ms;                /* per item; cap total at ~300ms          */
  --stagger-cap: 300ms;

  /* ── entrance ──────────────────────────────────────────────────────── */
  --animate-settle: settle var(--duration-medium) var(--ease-settle) both;
}

@keyframes settle {
  from { opacity: 0; transform: translateY(9px); filter: blur(4px); }
  to   { opacity: 1; transform: none;            filter: none;      }
}

/* Changed-digit "ink bleed": NumberRoll ALREADY emits data-changed per slot
   (NumberRoll.tsx:56) and nothing currently consumes it. Changed digits look
   freshly stamped; unchanged digits hold perfectly still. */
@keyframes digit-mark { 0%, 100% { opacity: 1; } 45% { opacity: 0.55; } }
[data-changed="true"] { animation: digit-mark var(--duration-medium) var(--ease-settle); }

/* Value-changed cell flash — fires on a REAL change (price refresh, scrub
   landing on a new day, a bulk edit settling). NEVER on mount. */
@keyframes tick-flash { 0% { opacity: 0; } 12% { opacity: 1; } 100% { opacity: 0; } }
.tick-flash::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: currentColor; opacity: 0;
  animation: tick-flash 600ms var(--ease-exit);
}

@media (prefers-reduced-motion: reduce) {
  /* the existing blanket collapse already zeroes duration AND delay.
     Two additions it cannot express: */
  .settle { filter: none; }        /* a 0.01ms blur can still flash          */
  .tick-flash::after { display: none; }
}
```

### What animates, and what must never

| Animates | Never animates |
|---|---|
| Opacity, transform, `clip-path`, `filter` (sparingly) | `width`, `height`, `top`, `left`, `margin`, `padding`, `border`, `font-size` |
| Enter/exit of sheets, dialogs, toasts, rows | The y-position of a figure while it's being read |
| Focus ring, hover tint, active press | Axis ticks and gridlines during a scrub — **only the crosshair moves** |
| The scrub crosshair (slightly damped, never lagging) | Table row height on hover, or any column width |
| Chart→table lens crossfade; chart→focus-modal morph | Anything under the pointer during a drag-select |
| Digit slots inside a fixed-width odometer | The sign, currency symbol, or decimal point of a money value |
| Camera between named 3D viewpoints | A number counting up from 0 on mount |

### How numbers transition

Only the digits that **actually changed** animate, translating vertically inside fixed-width slots so
the decimal never shifts. Direction is semantic — increasing rolls **up**, decreasing rolls **down** —
and the roll direction must agree with the gain/loss colour so motion and colour tell the same story.
Duration `--duration-normal` (300ms) with `--ease-settle`. If a delta spans more than ~3 orders of
magnitude, **cross-fade instead of rolling**; a 40-digit spin is noise, not information.

### Page transitions

Use the native `document.startViewTransition` pattern already proven in `ChartFocus.tsx` — feature-
detected with `'startViewTransition' in document`, skipped under reduced motion. **Do not** enable
`experimental.viewTransition` in `next.config`: `react@19.2.7` exports neither `ViewTransition` nor
`unstable_ViewTransition` (verified empirically in this worktree), so that flag forces a `react@canary`
pin, and Vercel's own docs say it is "not recommended for production".

Assign a stable `view-transition-name` to the shared element on each side of a navigation — merchant
name on a row and on `/merchants/[id]`; holding symbol on the list and on the detail page; account card
on `/accounts` and `/accounts/[id]` — reusing `--duration-morph` so route morphs and chart morphs feel
like the same system. ⚠️ **Names must be unique per document at transition time**: set it imperatively
on the clicked element only, immediately before starting the transition, and clear it afterwards.

### The reduced-motion contract

**This is the trap in this codebase.** The existing block:

```css
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … !important } }
```

covers **CSS animations only**. It does **not** stop Motion, GSAP, AutoAnimate, react-spring, or any
WAAPI/rAF-driven animation, and it does **not pierce shadow DOM** (so it would never reach NumberFlow's
internals). Every JS-driven addition carries its own gate:

| Layer | Its gate |
|---|---|
| CSS animations & transitions | The existing blanket collapse ✅ |
| CSS scroll-driven animations (`view()`, `scroll()`) | Same collapse ✅ — a reason to prefer them |
| Motion | `<MotionConfig reducedMotion="user">` at the root client boundary. Disables transform/layout while **preserving opacity and colour** — the correct degradation for a data app |
| AutoAnimate | Explicit `matchMedia('(prefers-reduced-motion: reduce)')` check or a plugin returning zero-duration keyframes |
| GSAP | `gsap.matchMedia()` |
| Any WebGL scene | **Does not mount at all.** Render the 2D fallback instead — "3D but frozen" is still an unreadable occluded mess, whereas the fallback is a legible chart |
| Custom elements / shadow DOM | The library's own flag (e.g. NumberFlow's `respectMotionPreference`) |

**Add an e2e assertion under emulated reduced motion for every one of these** rather than trusting the
CSS rule still covers you. For the 3D case specifically: assert that **no `<canvas>` element exists**.

---

## The 3D question

**Short answer: yes, but in exactly two places, and only if the front-on view is as readable as the 2D
chart it sits beside.**

### Where 3D genuinely helps this app's data

A third dimension is honest only where a third variable exists. This app has exactly two:

| View | The three variables | Why it's legitimate |
|---|---|---|
| **Net-worth terrain** (`/`) | time × account × balance — ~730 days × 10 accounts | The canonical case, and the same shape as the NYT yield curve. Discrete ribbons per account (not a mesh — there is no continuum between "Chase Checking" and "Robinhood"). **Liabilities extrude below the zero plane**, so debt stops being a red number and becomes a hole in the ground — and sign is then encoded *spatially*, which survives colour-blindness for free |
| **Extruded portfolio treemap** (`/investments`) | footprint area = position weight, height = total return %, hue = category | Depth carries a **second variable** instead of decorating the first. Losing positions become sunken pits — portfolio damage acquires a shape you can see from across the room. 20 holdings = 20 instanced boxes = one draw call |

### Where it actively hurts legibility

| Problem | Consequence | Mitigation (none of these are fixes) |
|---|---|---|
| **Perspective foreshortening** | Near bars render bigger than far bars. Silently corrupts every comparison | **Orthographic camera, always, for anything quantitative.** Non-negotiable |
| **No shared baseline** | Two bars at different depths don't sit on a common baseline, so length comparison degrades to position/area estimation. Cleveland & McGill rank "position along a common scale" first and volume near the bottom — **a 3D bar chart is provably a worse quantitative encoder than the 2D bar it replaced** | The 2D lens stays always reachable |
| **Occlusion** | Tall columns hide short ones — and the small positions you'd forget you own are exactly the ones that vanish | Snapped-corner rotation, hover x-ray that fades occluders, sort-by-height toggle. **Permanent limitation, not a deferred bug** |
| **Volume is misread** | People systematically underestimate volume differences | Hard rule: **only ONE dimension of a box may vary with the value being read.** Never scale a box uniformly by value |
| **Labels degrade at angle** | Text at 35° loses ~40% of effective x-height; `$1,234.56` turns to mush | troika SDF text with an outline pass for in-scene labels; **a DOM HUD in tabular figures for every actual number.** No currency is ever read off a tilted surface |
| **Depth dies on a phone** | At 390pt the z-axis compresses to ~120px; ten ribbons at 12px each is below the threshold where the third axis carries information | **On phones the field lens degrades to small multiples. It is not a 3D scene.** Taken directly from the NYT mobile lesson |
| **A canvas is invisible to axe** | It will not *fail* the scan — it will silently **pass** while carrying zero information, which is worse | `role="img"` + `aria-label`, plus an adjacent visually-hidden table carrying the same numbers, plus the permanently-reachable table lens |
| **GPU antialiasing differs per machine** | Canvas snapshots are permanently flaky | Every `?lens=field` snapshot must pass `mask: [page.locator('canvas')]` |

### What it costs on a mid-range phone

| Cost | Figure | Note |
|---|---|---|
| Geometry (terrain) | ~14,600 triangles, ~25 draw calls | Well under 2ms GPU on an A15. **This dataset is tiny for a GPU** |
| Geometry (treemap) | 20 instanced boxes, 1 draw call | Trivial |
| Bundle | ~250–280 kB gzip for the 3D chunk (three ~170, R3F ~35, drei subset ~30, troika ~40) | **Route-split AND lens-split** — loads on `?lens=field`, never on `/`. If it reaches the initial bundle, the <2.5s LCP budget is gone |
| Parse + shader compile | ~150–350 ms parse + ~120–400 ms compile & first frame | Budget **0.5–0.8s** from tapping "Field" to first pixel. That is why it is never the default |
| Thermals — idle | **~0 with `frameloop="demand"`** | The single most important mobile decision here |
| Thermals — continuous | ~0.8–1.5 W; phone warms within ~3 minutes | Which is why nothing animates continuously |
| Postprocessing (bloom, DoF) | Fill-rate bound — the fastest way to cook an iPhone | **Off the table entirely.** This is a real thing being surrendered: no "expensive product video" look |

⚠️ **WebGPU is not universal.** MDN's own compat data: Safari 26 ✅ (macOS + iOS), Chrome 113→144 ✅,
Firefox 141 **partial** (no Linux, no Intel macOS), and the API is still classified **"Limited
availability", not Baseline**. Several highly-ranked 2026 blog posts claim otherwise; they are wrong.
**WebGL2 is the tested default path** — it is also what headless Playwright chromium will use in CI.
WebGPU buys this app nothing anyway (14,600 triangles needs no compute shaders); the only reason to
initialise it is TSL giving one shader source for both backends, which is a maintenance win, not a perf
win.

### Recommended scope — the ambitious version that is still defensible

| Phase | What | Effort | Cuttable? |
|---|---|---|---|
| **0** | **`Scene3D.tsx` host.** One client-only `<Canvas>` owning the whole policy: WebGL2 default + optional WebGPU, `frameloop="demand"`, `dpr={[1,2]}`, `<AdaptiveDpr>`, IntersectionObserver pause, refuses to mount under reduced-motion or below 768px, `next/dynamic({ssr:false})`. **Written once; every scene mounts inside it** | 1.5 sessions | No — prerequisite |
| **1** | **Prototype the terrain in react-plotly on a throwaway `/design` route.** One hour, real `daily_balances`, answers the legibility question before you spend three sessions on bespoke R3F. **Then delete it** | 1 hour | No — it's the cheap insurance |
| **2** | **Net-worth terrain** as `{key:"lens", value:"terrain"}`. Pure ribbon-geometry module + tests, four snapped viewpoints, BVH picking, DOM HUD, small-multiple SVG fallback | 3 sessions | **THE GATE — see below** |
| **3** | **Extruded portfolio treemap** as a view option beside the donut. `treemap-layout.ts` + tests, instanced boxes, hover x-ray, SVG fallback | 2 sessions | Yes, cleanly |
| **4** | **Sankey particle overlay.** Emission rate ∝ $/month | 1 session | **First thing to cut** |

**THE GATE, and it is a real gate:** after Phase 2, put the terrain at its Front camera side by side with
today's `ScrubChart` on the same data. **If Front is not as readable as the existing 2D chart, cut the
feature — do not ship it with an apology.** This is the highest-probability outcome that kills the 3D
work, and it must be tested before Phases 3–4 are funded.

**Two architectural rules that make the whole thing safe:**

- **3D is an ADDITIVE lens value.** `chart` and `table` stay untouched and `chart` stays the default.
  Because lens state is URL-driven, **every existing visual snapshot renders at `?lens=chart` exactly as
  today** — the 3D work causes zero snapshot churn on its own. That is a concrete payoff from the
  additive rule and the main reason to insist on it. (Per `chart-lens.ts`'s own warning, append `field`
  — both investments panels index their spec positionally as `SPEC[0]`/`SPEC[1]`.)
- **R3F is the ONLY new rendering engine.** The app already runs recharts + bespoke SVG. deck.gl is a
  read-only reference; plotly is a time-boxed throwaway; echarts-gl is rejected. Four engines with four
  visual languages, only two of which read `globals.css`, is how a design system dies.

**Explicitly rejected, so it doesn't quietly reappear:**

- **A globe.** cobe (5.5k★) and react-globe.gl are the classic "make it look expensive" picks. This app
  has **zero** geospatial dimension. A spinning globe on a personal-finance dashboard is a lie about the
  data. Spend that budget on the terrain's material instead, where the pixels describe his money.
- **A 3D spend scatter.** The heatmap shipped in passes 23/24 is a strictly better encoder — shared
  baseline, no occlusion, every cell states its own number. If GPU exploration is wanted on `/spending`,
  the honest answer is regl-scatterplot in 2D with lasso-select: same interactivity, no occlusion.
- **A merchant force-graph.** Hairball. The sorted merchants table conveys more.
- **Postprocessing on touch devices.** Bloom is how you cook an iPhone.

**The ongoing tax, stated once:** adopting R3F means React upgrades become R3F-coordinated changes
(peer `react ">=19 <19.3"`, and 19.3 breaks install), drei must be pinned exactly against a
visibly-slowing release cadence, and every canvas region needs Playwright masking forever. That is not a
one-time cost.

---

## Design directions

Three complete directions, each with a working single-file mockup (zero external references, verified to
run offline with no console errors):

- **A — Ledger & Letterpress** · [`docs/design-directions/direction-A.html`](./design-directions/direction-A.html) (62 KB)
- **B — The Terminal** · [`docs/design-directions/direction-B.html`](./design-directions/direction-B.html) (53 KB)
- **C — Deep Field** · [`docs/design-directions/direction-C.html`](./design-directions/direction-C.html) (58 KB)

### Summary

| | **A — Ledger & Letterpress** | **B — The Terminal** | **C — Deep Field** |
|---|---|---|---|
| **Thesis** | The app is tokenised but not *typeset*. Finish the foundation rather than replace it | An instrument you operate, not a report you read | Money as a place with geography, under an honest camera |
| **Signature** | The cover numeral — net worth in Fraunces at 96px with cents at 0.34em raised to the cap line, rolling live with the chart crosshair | The tick flash — any cell whose value changed washes green/red for 600ms and decays. Amber is chrome, **never** money | Liabilities are underground — credit cards extrude *downward* through the zero plane |
| **Colour** | **Zero token churn.** All 60 existing OKLCH values byte-identical; 4 tokens added, every ratio computed (worst 5.27:1) | Full rewrite, dark-first. Cold-paper light theme. All values computed; ramp solved numerically | Additive only. New `--depth-*` and 6-slot `--mass-*` ramps beside the untouched existing tokens |
| **Type** | Fraunces display + Geist chrome + Geist Mono figures | Inter chrome + Martian Mono figures, density base 14–15px | Geist chrome + Inter figures + Fraunces display ≥48px |
| **3D** | One axonometric SVG account relief (~40 lines, zero deps) | Two opt-in orthographic "scopes" — terrain + treemap | Terrain + massif + Sankey particles. The heaviest, and the most honestly bounded |
| **Snapshot churn** | All 127, once (staged across 7 commits) | **All 127, three times** (tokens, then type, then density) | All 127 once in Phase 0; **the 3D phases cause zero churn** because the lens defaults to `chart` |
| **Effort** | 5–6 sessions | 9–13 sessions | 12–13 (MVP 6.5) |
| **Wrong for** | Someone who wants a spectacle, or scans this like a Bloomberg screen | Someone who wants finance to feel calm; anyone in light mode (measured: gain/loss separability 36.1/10.8 dark vs 26.4/**5.5** light); **touch — 26px rows vs a ~44px thumb target, and he wants this on a phone** | Triage. If the daily job is categorizing 400 rows, this gives you almost nothing |
| **Best at** | Highest floor, least regression risk, most distinctive-looking per session spent | Workflow, clickthrough, keyboard density, "everything is interactive" | The heavy-3D ask, and the only one whose architecture avoids snapshot churn for its flagship feature |

### My recommendation

**Build a hybrid: A's foundation → C's 3D → B's workflow. In that order.**

None of the three is right alone, and the reasons are specific rather than diplomatic.

**Reject B as a whole direction** — but keep its best ideas. Two disqualifiers. First, it needs **three
separate 127-snapshot re-baselines** (tokens, then typography, then density), and the honest risk
assessment in its own write-up is that batching them makes the diff unreviewable while not batching them
costs half a session of review each. Second, and more decisive: its density floor is ~26px rows with
3–4px padding, which is right for a monitor and **wrong for a thumb**. The owner explicitly wants this
on his phone and tablet. Solving that needs a `@media (pointer: coarse)` branch, which forks the layout
and roughly **doubles the visual-test matrix** on every route with a table. And its light theme is
measurably the weaker half — a translation, not the original — which matters if he ever works in
daylight.

**A alone fails the brief.** He asked to go as heavy as possible on 3D. A ships one axonometric SVG
chart and argues the rest of the budget belongs in type and layout. That argument is *correct on the
merits* — but it is not what he asked for, and "the current app, but better" may not be the sentence he
wants to hear.

**C alone under-serves the daily job.** Its investment in `/transactions` is deliberately small. If the
recurring work is triage (and passes 18 and 24 say it is), the spatial views are a thing he shows people
rather than a thing he uses.

**The hybrid, sequenced:**

| Stage | From | What | Sessions | Why here |
|---|---|---|---|---|
| **1** | **A** | Type foundation: tabular figures (the verified `tnum` bug), `--text-*` clamp tokens into `@theme inline`, `PageHeader`, the TTF feature-table gate test, recharts tick `fontFamily` | ~1 | **Everything downstream reads it.** It is also the single highest-leverage file change in the repo — `PageHeader.tsx`'s flat `text-2xl` H1 becoming a display face changes the felt hierarchy of all 15 routes at once |
| **2** | **A** | Letterpress depth + motion tokens: emboss/`--press-*`, `SurfaceCard`, the grain layer, the motion vocabulary above, `NumberRoll`'s `data-changed` ink bleed | ~1 | Cheap, additive, and it makes stage 4's 3D feel like part of one designed system instead of a bolted-on WebGL toy |
| **3** | **shared** | The unglamorous prerequisites all three directions independently demanded: per-route `loading.tsx` / `error.tsx` / `not-found.tsx`; the CVD toggle + palette gate test; the recharts 3.10.1 bump; the optimistic-rollback audit | ~1.5 | Zero of these exist today. The `useOptimistic` silent-rollback is the **highest-severity item in this entire document** on a real-money app |
| **4** | **A** | Hero + marginalia rail + chart annotation layer (the Miami move, the cash job, the contribution runs) | ~2 | The annotation layer is the cheapest "this is a real product" win available, and it needs the recharts bump from stage 3 |
| **5** | **C** | `Scene3D.tsx` host → plotly legibility prototype → terrain as an additive `field` lens → **THE GATE** → treemap | ~6.5 | The heavy-3D ask, delivered with zero snapshot churn because the lens defaults to `chart`. Gated on a real readability test rather than on enthusiasm |
| **6** | **B** | Keyboard triage (j/k/x/e over the existing `KeyScopeProvider` + `BulkActionBar` + lossless undo), faceted filter chips with server-computed counts, `split` lens via react-resizable-panels, `/transactions/[id]` intercepting route | ~3 | The workflow and clickthrough ask. Deliberately **without** B's density rewrite and dark-first token churn |

**What this hybrid deliberately drops from B:** the dark-first token rewrite, the 14–15px density base,
the permanent status bar, the live tick tape. Keep the tick *flash* (it's in the motion vocabulary above)
— drop the tape, which is an always-on animation on a device he leaves in his pocket.

**One warning that applies to the whole plan.** Stages 1, 2 and 4 each re-baseline all 127 snapshots.
**Do them as separate commits, review per viewport (320/768/1024/1440), and never run
`--update-snapshots` across two unrelated changes.** The moment that discipline slips, a real regression
lands inside a green diff and the suite's entire value evaporates. That is the single most likely way
this goes quietly wrong.

---

### Verification notes and things that could not be confirmed

- **NYT yield curve**: nytimes.com blocks automated fetch. Authorship, design and liveness verified via
  PolicyViz (2022), not the page itself.
- **Bloomberg colour-accessibility articles**: both return HTTP 403 to automated fetch. The substance
  (blue/red for up/down, amber kept non-semantic, ~20,000 affected Terminal users, separate deuteranopia
  and protanomaly schemes) came from the search index, not a direct read. The reasoning is corroborated
  across sources; treat the specific figures as second-hand.
- **Carbon's categorical-palette page and ibm.com/plex** also 403 — no specific Carbon colour rule is
  cited as fact here.
- **`tnum` was verified locally only for Geist** (by absence). Inter, IBM Plex, Martian Mono, Roboto Flex
  and Fraunces rest on vendor docs. **Run the same check before committing to any of them**: load the
  TTF with fontTools, inspect the GSUB FeatureList tags, compare digit advances in `hmtx`. Thirty
  seconds — and Geist looked perfectly fine on paper too.
- **Licences reporting NOASSERTION on GitHub** (verify the LICENSE file before vendoring code):
  `uwdata/mosaic` (site says BSD), `gka/chroma.js` (project says Apache-2.0), `Myndex/SAPC-APCA` (custom
  beta licence), `evilmartians/oklch-picker`, `atlassian/pragmatic-drag-and-drop` monorepo (npm says
  Apache-2.0), `ecomfe/echarts-gl` (repo says BSD-3-Clause, npm says MIT).
- **AGPL-3.0 and this app's hosting goal**: Midday, Ghostfolio, Firefly III and `cosscom/coss` (formerly
  `origin-space/originui`) are all AGPL-3.0. Reading them is unrestricted; copying code in and then
  serving it over a network could oblige offering MoneyApp's source to viewers. **Actual Budget (MIT) is
  the one you can lift from freely.**
- **CVD simulation figures** use Machado/Oliveira/Fernandes (2009) matrices — a perceptual model, not
  ground truth. The figures are directionally solid and internally consistent (the same method scores
  Okabe-Ito well and MoneyApp's ramp badly, which is the expected result). No simulation substitutes for
  testing with an actual colourblind person.
- **No library in the install table was installed and measured in this codebase.** All compatibility
  claims come from declared peer ranges, `exports` maps and vendor docs. All bundle figures are vendor
  or bundlephobia numbers. Validate with a real install plus `pnpm typecheck` and the 1,536-test gate.
- **No performance claim here was benchmarked on MoneyApp** — compositor-thread view transitions,
  virtualization frame rates, 3D thermals. Verify against the app's own Lighthouse/CWV budget.
