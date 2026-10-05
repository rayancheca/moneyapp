import {
  createContext,
  createElement,
  startTransition,
  use,
  useContext,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { onRouterTransitionStart } from "@/instrumentation-client";
import type { ViewState } from "@/lib/view-state";

/*
 * A page of switchers, in REAL React 19 over a port of Next 16's router action queue — the
 * harness the review of 3c5d3ea used (scratchpad/skeptic-3c5d3ea), made something the suite can
 * keep: no jsdom (this project has none), and no timers deciding the order of events.
 *
 * - React: `react-dom/client` renders a tree that mounts no DOM node, into a stand-in container.
 *   Every hook under test is real — transitions, their entanglement, effects, context.
 * - The router: `dispatchAction` / `runAction` / `runRemainingActions` follow
 *   next/dist/client/components/app-router-instance.js (16.2.10) line for line: a navigation
 *   or a restore DISCARDS the pending action and runs at once, anything else queues behind it,
 *   and a restore (Back/Forward) resolves with a bare setState — outside any transition. Every
 *   push, replace and Back/Forward calls the app's own `onRouterTransitionStart` first, as Next
 *   does with src/instrumentation-client.ts.
 * - The server: every write and every page render WAITS until the test serves it, so a test
 *   says exactly which press is in flight when the next one is made.
 *
 * A test file mocks `next/navigation` and `@/app/settings/actions` with `nextNavigation` and
 * `settingsActions` below, then drives a `World`.
 */

// ------------------------------------------------------------------------- the browser bits
// React DOM reads `window.event` to pick an update's priority and walks `window` for the
// focused element around a commit; a tree that renders no element needs nothing else.
const g = globalThis as unknown as { window?: EventTarget };
const browser: EventTarget = (g.window ??= Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));

const noop = (): void => {};
function standInContainer(): Element {
  return {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    textContent: "",
    addEventListener: noop,
    removeEventListener: noop,
    ownerDocument: { addEventListener: noop, removeEventListener: noop },
  } as unknown as Element;
}

const realSetImmediate = setImmediate;
/** React schedules its work on setImmediate in node: let it run until it has none left. */
export async function idle(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => realSetImmediate(resolve));
}

// ------------------------------------------------------------------------- the router state
export interface RouterState<P> {
  /** pathname + query, as the router committed it */
  url: string;
  /** what the server rendered for it */
  rsc: P;
}

/** A page: what the server renders for a URL, and the client tree (it must mount no element). */
export interface HarnessPage<P> {
  server(url: URL, persisted: Readonly<Record<string, ViewState>>): P;
  Client: ComponentType<{ rsc: P }>;
}

type Action<P> =
  | { type: "server-action"; surface: string; state: ViewState; resolve(value: unknown): void }
  | { type: "navigate"; url: string; history: "push" | "replace" }
  | { type: "restore"; to: RouterState<P> };

interface QueuedAction<P> {
  payload: Action<P>;
  next: QueuedAction<P> | null;
  discarded?: boolean;
  resolve(state: RouterState<P>): void;
}

/** One write or one page render the server has received and not yet answered. */
export interface ServerWork {
  kind: "write" | "render";
  /** the surface and state written, or the URL rendered */
  label: string;
}

const RouterContext = createContext<RouterState<unknown> | null>(null);

let current: World<unknown> | null = null;
function world(): World<unknown> {
  if (current === null) throw new Error("no harness world is mounted");
  return current;
}

/** `next/navigation`, as the page sees it */
export const nextNavigation = {
  useRouter: () => world().router,
  usePathname: (): string => new URL(useRouterState().url, "http://x").pathname,
  useSearchParams: (): URLSearchParams => {
    const url = useRouterState().url;
    return useMemo(() => new URL(url, "http://x").searchParams, [url]);
  },
};

function useRouterState(): RouterState<unknown> {
  const state = useContext(RouterContext);
  if (state === null) throw new Error("rendered outside the harness router");
  return state;
}

/** `@/app/settings/actions`, as the page sees it */
export const settingsActions = {
  saveViewPreferenceAction: (surface: string, state: ViewState): Promise<unknown> =>
    new Promise((resolve) => {
      // a server action dispatches into the router queue, in a transition (server-action reducer)
      startTransition(() => world().dispatch({ type: "server-action", surface, state, resolve }));
    }),
};

export class World<P> {
  readonly persisted: Record<string, ViewState>;
  /** every write the server applied, in order */
  readonly writes: { surface: string; state: ViewState }[] = [];
  /** the browser's history: the committed URLs, and which one is shown */
  readonly history: RouterState<P>[];
  private at = 0;
  private readonly inbox: { work: ServerWork; serve(): void }[] = [];
  private readonly queue: { state: RouterState<P>; pending: QueuedAction<P> | null; last: QueuedAction<P> | null };
  private setState: ((value: RouterState<P> | Promise<RouterState<P>>) => void) | null = null;
  private root: Root | null = null;

  readonly router = {
    push: (href: string): void => this.navigate(href, "push"),
    replace: (href: string): void => this.navigate(href, "replace"),
    refresh: (): void => {},
    prefetch: (): void => {},
    back: (): void => this.back(),
    forward: (): void => {},
  };

  constructor(
    private readonly page: HarnessPage<P>,
    url: string,
    persisted: Record<string, ViewState> = {},
    /** what the root layout wraps every page in (the app: the page-asks provider) */
    private readonly layout: (children: ReactNode) => ReactNode = (children) => children,
  ) {
    this.persisted = structuredClone(persisted);
    const initial = { url, rsc: page.server(new URL(url, "http://x"), this.persisted) };
    this.history = [initial];
    this.queue = { state: initial, pending: null, last: null };
  }

  /** the URL on screen */
  get url(): string {
    return this.history[this.at]!.url;
  }

  /** what the server rendered for the page on screen */
  get shown(): P {
    return this.history[this.at]!.rsc;
  }

  /** what the server has received and not answered, oldest first */
  get pending(): ServerWork[] {
    return this.inbox.map((entry) => entry.work);
  }

  async mount(): Promise<void> {
    current = this as World<unknown>;
    this.root = createRoot(standInContainer());
    this.root.render(createElement(this.Root));
    await idle();
  }

  async unmount(): Promise<void> {
    this.root?.unmount();
    await idle();
    current = null;
  }

  /** answer the oldest request the server holds (of `kind`, when given), then let React run */
  async serve(kind?: ServerWork["kind"]): Promise<ServerWork> {
    const index = this.inbox.findIndex((entry) => kind === undefined || entry.work.kind === kind);
    if (index < 0) throw new Error(`the server holds no ${kind ?? "request"}: ${JSON.stringify(this.pending)}`);
    const [entry] = this.inbox.splice(index, 1);
    entry!.serve();
    await idle();
    return entry!.work;
  }

  /** answer everything, in the order it arrives, until nothing is left in flight */
  async settle(): Promise<void> {
    await idle();
    for (let guard = 0; this.inbox.length > 0; guard++) {
      if (guard > 100) throw new Error("the page never settled");
      await this.serve();
    }
  }

  /** the browser's Back button: popstate, then Next's handler (app-router.js `onPopState`) */
  back(): void {
    this.at -= 1;
    const to = this.history[this.at]!;
    browser.dispatchEvent(new Event("popstate"));
    startTransition(() => {
      // dispatchTraverseAction
      onRouterTransitionStart(new URL(to.url, "http://x").href, "traverse");
      this.dispatch({ type: "restore", to });
    });
  }

  /** `router.push` / `router.replace`, and a Link: dispatchNavigateAction, in a transition */
  private navigate(href: string, history: "push" | "replace"): void {
    startTransition(() => {
      onRouterTransitionStart(href, history);
      this.dispatch({ type: "navigate", url: href, history });
    });
  }

  private hold(work: ServerWork): Promise<void> {
    return new Promise((resolve) => this.inbox.push({ work, serve: () => resolve() }));
  }

  /** the router reducer: a server action writes, a navigation renders, a restore is instant */
  private async reduce(state: RouterState<P>, action: Action<P>): Promise<RouterState<P>> {
    if (action.type === "server-action") {
      await this.hold({ kind: "write", label: `${action.surface} ${JSON.stringify(action.state)}` });
      this.persisted[action.surface] = { ...this.persisted[action.surface], ...action.state };
      this.writes.push({ surface: action.surface, state: action.state });
      action.resolve({ ok: true });
      return state;
    }
    if (action.type === "navigate") {
      await this.hold({ kind: "render", label: action.url });
      const url = new URL(action.url, "http://x");
      return { url: `${url.pathname}${url.search}`, rsc: this.page.server(url, this.persisted) };
    }
    return action.to;
  }

  /** the router's committed state moved: keep the history the way Next's HistoryUpdater does */
  private commitHistory(action: Action<P>, next: RouterState<P>): void {
    if (action.type !== "navigate") return;
    if (action.history === "push" && next.url !== this.url) {
      this.history.splice(this.at + 1, Infinity, next);
      this.at += 1;
    } else {
      this.history[this.at] = next;
    }
  }

  // --- next/dist/client/components/app-router-instance.js, 16.2.10
  private runRemainingActions(): void {
    if (this.queue.pending !== null) {
      this.queue.pending = this.queue.pending.next;
      if (this.queue.pending !== null) this.runAction(this.queue.pending);
    }
  }

  private runAction(action: QueuedAction<P>): void {
    const prevState = this.queue.state;
    this.queue.pending = action;
    const handleResult = (nextState: RouterState<P>): void => {
      if (action.discarded) {
        this.runRemainingActions();
        return;
      }
      this.queue.state = nextState;
      this.commitHistory(action.payload, nextState);
      this.runRemainingActions();
      action.resolve(nextState);
    };
    void this.reduce(prevState, action.payload).then(handleResult);
  }

  dispatch(payload: Action<P>): void {
    const setState = this.setState!;
    let resolve: (state: RouterState<P>) => void = setState;
    if (payload.type !== "restore") {
      const deferred = new Promise<RouterState<P>>((r) => {
        resolve = r;
      });
      startTransition(() => setState(deferred));
    }
    const action: QueuedAction<P> = { payload, next: null, resolve };
    if (this.queue.pending === null) {
      this.queue.last = action;
      this.runAction(action);
    } else if (payload.type === "navigate" || payload.type === "restore") {
      this.queue.pending.discarded = true;
      action.next = this.queue.pending.next;
      this.runAction(action);
    } else {
      if (this.queue.last !== null) this.queue.last.next = action;
      this.queue.last = action;
    }
  }

  // --- the app router's root: `useActionQueue` (a state that may be a pending promise)
  private readonly Root = (): ReactNode => {
    const [state, setState] = useState<RouterState<P> | Promise<RouterState<P>>>(this.queue.state);
    this.setState = setState;
    const shown = state instanceof Promise ? use(state) : state;
    const page = createElement(this.page.Client, { rsc: shown.rsc });
    return createElement(RouterContext, { value: shown as RouterState<unknown> }, this.layout(page));
  };
}
