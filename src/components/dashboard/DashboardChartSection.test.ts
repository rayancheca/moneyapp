import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DashboardAccountOption } from "@/services/dashboard-series";

/*
 * The dashboard hero stepped by hand (no jsdom here): its hooks are routed to `Section`
 * below while a test steps it, and to React otherwise. `Section` re-renders the way React
 * does around a press — `isPending` turns true as soon as one starts, and the props the
 * server resolved do not move until the test says the press's navigation has committed.
 */
const host = vi.hoisted(() => ({ current: null as null | Section }));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useCallback: <T>(fn: T, deps: unknown[]): T =>
      host.current ? fn : real.useCallback(fn as never, deps),
    useMemo: <T>(fn: () => T, deps: unknown[]): T => (host.current ? fn() : real.useMemo(fn, deps)),
    useRef: (init: unknown) => (host.current ? host.current.useRef(init) : real.useRef(init)),
    useTransition: () => (host.current ? host.current.useTransition() : real.useTransition()),
  };
});

const saves = vi.hoisted(() => [] as Record<string, string>[]);
const pushes = vi.hoisted(() => [] as string[]);
vi.mock("@/app/settings/actions", () => ({
  saveViewPreferenceAction: async (_surface: string, state: Record<string, string>) => {
    saves.push(state);
    return { ok: true };
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => pushes.push(href),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { DashboardChartSection } = await import("./DashboardChartSection");
type Props = Parameters<typeof DashboardChartSection>[0];

class Section {
  private readonly slots: unknown[] = [];
  private cursor = 0;
  private pending = false;
  private readonly inFlight: Promise<unknown>[] = [];

  /** the hero's panel as ChartFocus would draw it inline */
  render(props: Props): ReactNode {
    this.cursor = 0;
    host.current = this;
    try {
      const focus = DashboardChartSection(props) as ReactElement<{
        renderPanel: (opts: { activeRange: string; onRangeChange: () => void }) => ReactNode;
      }>;
      return focus.props.renderPanel({ activeRange: "1Y", onRangeChange: () => undefined });
    } finally {
      host.current = null;
    }
  }

  useRef(init: unknown): { current: unknown } {
    const slot = this.cursor++;
    if (!(slot in this.slots)) this.slots[slot] = { current: init };
    return this.slots[slot] as { current: unknown };
  }

  useTransition(): [boolean, (fn: () => unknown) => void] {
    this.cursor++;
    return [
      this.pending,
      (fn) => {
        this.pending = true;
        this.inFlight.push(Promise.resolve(fn()));
      },
    ];
  }

  /** every press's write and push has run, and its navigation has committed */
  async settle(): Promise<void> {
    while (this.inFlight.length > 0) await this.inFlight.shift();
    this.pending = false;
  }
}

type Element = ReactElement<Record<string, unknown>>;

function find(node: ReactNode, match: (el: Element) => boolean): Element {
  const walk = (n: ReactNode): Element | null => {
    if (Array.isArray(n)) {
      for (const child of n) {
        const hit = walk(child as ReactNode);
        if (hit) return hit;
      }
      return null;
    }
    if (!isValidElement<Record<string, unknown>>(n)) return null;
    if (match(n)) return n;
    return walk(n.props.children as ReactNode);
  };
  const hit = walk(node);
  if (!hit) throw new Error("element not found");
  return hit;
}

function pressAccount(panel: ReactNode, id: string): void {
  const pill = find(panel, (el) => el.type === "button" && el.key === id);
  (pill.props.onClick as () => void)();
}

function pressMode(panel: ReactNode, mode: string): void {
  const switcher = find(panel, (el) => el.props.ariaLabel === "Net worth chart view");
  (switcher.props.onSelect as (value: string) => void)(mode);
}

const ACCOUNTS: DashboardAccountOption[] = [
  { id: "a", label: "Checking", isLiability: false },
  { id: "b", label: "Savings", isLiability: false },
  { id: "c", label: "Card", isLiability: true },
];
const ON_ACCOUNTS: Props = {
  netWorthPoints: [],
  chartData: null,
  state: {
    chart: "accounts",
    terrainLens: "relief",
    terrainView: "quarter",
    sankeyLens: "flow",
    bridgeLens: "chart",
  },
  accounts: ACCOUNTS,
  selectedAccountIds: ["a", "b", "c"],
  acctsParam: "a,b,c",
  sankeyByRange: null,
  bridgeByRange: null,
  today: "2026-07-08",
};

beforeEach(() => {
  saves.length = 0;
  pushes.length = 0;
});

/**
 * 🔴 The account pills were the dashboard's SECOND copy of the view write, with the same
 * flaw as `setView`'s: each toggle was built from the selection and view the server resolved
 * before any press in flight, so a second toggle — or a mode press — made before the first
 * one's navigation committed persisted and navigated to a selection without it.
 */
describe("the hero's account pills, pressed while another press is in flight", () => {
  test("a second toggle keeps the first", async () => {
    const section = new Section();
    pressAccount(section.render(ON_ACCOUNTS), "b");
    // re-rendered while the first toggle is in flight: the server still resolves a, b, c
    pressAccount(section.render(ON_ACCOUNTS), "c");
    await section.settle();

    expect(saves.map((s) => s.accts)).toEqual(["a,c", "a"]);
    expect(pushes).toEqual(["/?accts=a%2Cc&chart=accounts", "/?accts=a&chart=accounts"]);
  });

  test("a mode press keeps the toggle in the URL it navigates to", async () => {
    const section = new Section();
    pressAccount(section.render(ON_ACCOUNTS), "b");
    pressMode(section.render(ON_ACCOUNTS), "combined");
    await section.settle();

    expect(saves.at(-1)).toMatchObject({ chart: "combined", accts: "a,c" });
    // `accts` from the URL outranks the persisted one (app/page.tsx), so a stale `a,b,c`
    // here would put the toggled-off account straight back on the chart
    expect(pushes.at(-1)).toBe("/?accts=a%2Cc");
  });
});
