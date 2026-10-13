import type { ReactElement, ReactNode } from "react";

/*
 * One component's hook state, held across calls, so a test can call a function component, fire a prop its output
 * wires up, let the answers it asked for land, and call it again — which is what paging IS, and what a static render
 * cannot do. The repo has no DOM environment; this steps the components' own code rather than a copy of it.
 *
 * A test file routes React's hooks here while a component is being stepped, and to React otherwise, so its static
 * renders stay real renders:
 *
 *   vi.mock("react", async (importOriginal) =>
 *     (await import("@/hooks/hook-slots.harness")).routeHooks(await importOriginal<typeof import("react")>()));
 *
 * ⚠️ This module must not import React at runtime: the mock above loads it while "react" itself is being mocked.
 */

type ReactModule = typeof import("react");

let host: HookSlots | null = null;

/** React, with the hooks the stepped components call sent to the `HookSlots` stepping them, when one is. */
export function routeHooks(real: ReactModule): ReactModule {
  const routed = {
    useState: (init: unknown) => (host ? host.useState(init) : real.useState(init)),
    useTransition: () => (host ? host.useTransition() : real.useTransition()),
    // 🔴 5d156a4 gave RecurringCalendar the month last asked for in a ref; unrouted, React's own useRef ran outside a
    // render and the badge's paging test died on a null dispatcher instead of guarding anything (2026-10-13)
    useRef: (init: unknown) => (host ? host.useRef(init) : real.useRef(init)),
    useCallback: (fn: () => void, deps: unknown[]) => (host ? host.useCallback(fn) : real.useCallback(fn, deps)),
    useMemo: (fn: () => unknown, deps: unknown[]) => (host ? host.useMemo(fn) : real.useMemo(fn, deps)),
  };
  return { ...real, ...routed } as unknown as ReactModule;
}

export class HookSlots {
  private readonly values: unknown[] = [];
  private cursor = 0;

  render<P>(component: (props: P) => ReactNode, props: P): ReactNode {
    const previous = host;
    this.cursor = 0;
    host = this;
    try {
      return component(props);
    } finally {
      host = previous;
    }
  }

  useState(init: unknown): [unknown, (next: unknown) => void] {
    const slot = this.cursor++;
    if (!(slot in this.values)) this.values[slot] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (next: unknown): void => {
      this.values[slot] = typeof next === "function" ? (next as (prev: unknown) => unknown)(this.values[slot]) : next;
    };
    return [this.values[slot], set];
  }

  // the same box on every call, so a write between calls is what the next call reads
  useRef(init: unknown): { current: unknown } {
    const slot = this.cursor++;
    if (!(slot in this.values)) this.values[slot] = { current: init };
    return this.values[slot] as { current: unknown };
  }

  // recomputed on every call: a stepped component is called a handful of times, and no test here measures memoizing
  useCallback<F>(fn: F): F {
    this.cursor++;
    return fn;
  }

  useMemo<T>(fn: () => T): T {
    this.cursor++;
    return fn();
  }

  useTransition(): [boolean, (fn: () => unknown) => void] {
    this.cursor++;
    return [false, (fn) => void fn()];
  }

  /**
   * Let every answer already given finish what it started — the awaits behind a resolved action, and the state they
   * set. An answer the test has not given yet stays pending: settling never waits on it.
   */
  async settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  }
}

type Element = ReactElement<Record<string, unknown>>;

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && "$$typeof" in node && "type" in node && "props" in node;
}

/** The first element of `type` in a rendered tree (through `children`), whose props include `props` when given. */
export function findElement(node: ReactNode, type: unknown, props: Record<string, unknown> = {}): Element | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type, props);
      if (found) return found;
    }
    return null;
  }
  if (!isElement(node)) return null;
  if (node.type === type && Object.entries(props).every(([key, value]) => node.props[key] === value)) return node;
  return findElement(node.props.children as ReactNode, type, props);
}
