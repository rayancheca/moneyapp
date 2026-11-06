import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/app/transactions/action-types";
import { refusalShownFields } from "@/components/ui/ErrorBanner";
import { calleeName, lineOf, nodesUnder, scanServerActions } from "@/lib/server-action-scan";
import { landBack, type Landing } from "./refusal-landing";

/** each `redirect()` a landing asks for, with the history entry it asks Next for (`undefined`: Next's default) */
const navigations = vi.hoisted(() => [] as { url: string; type: string | undefined }[]);
vi.mock("next/navigation", () => ({
  redirect: (url: string, type?: string): never => {
    navigations.push({ url, type });
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

/**
 * ⚖️ Owner 2026-10-06 (§6A 44): a view press on /recurring clears a stale `?error=` banner, as the tabs do. A `<form
 * action>` adapter that stays on its page when its press lands keeps the URL the refusal left, so the page re-renders
 * with `?error=` and the banner stays beside the work the press just did. ONE rule takes it away (`landBack`): the
 * form carries `REFUSAL_SHOWN` while its page shows a refusal, and only then does a press that lands go back with none.
 * Forms only: a press that returns a value moves no URL, and leaves the banner where it is (⏳ his call, `landBack`).
 *
 * 🔴 425ae02c built it for /imports alone, and the review of it (2026-11-05, a dev server over his ledger copy 10-29b)
 * measured the rest unchanged: on /settings a cleared "Price staleness (hours)" refused to `?error=Price staleness
 * window: Too small: expected number to be >=1`, the next Save landed (4 → 6), and the banner stayed beside the saved
 * 6 — every adapter but /imports' returned on a success. The same review unwired all three of /imports' forms and
 * every test stayed green. So these read every adapter and every form that binds one, in source: a page is an async
 * server component reading the database, and a render cannot reach a form a ledger has no row for (an un-import).
 *
 * 🔴 …and they left out every adapter that leaves its page on every press, as /budgets' do — the page the rule names as
 * its origin. The review of cb2e89ac (2026-11-05, a dev server over the copy 10-29b): on /budgets "Create budget" with
 * Housing, Annual, 0 pushed `/budgets?error=Budget amount must be positive` (history 3 → 4), 12.34 landed on /budgets
 * (4 → 5), and one Back brought the alert back above the budget he had just created. /transactions' header strip and
 * a new account (/accounts) leave the same way. Every form adapter lands through `landBack` now, and every form bound
 * to one carries the field: a page left out fails here, by name.
 */

const scan = scanServerActions();

/** The adapters React binds to a `<form action>`: exported async functions of a `"use server"` module, `Promise<void>`. */
const adapters = [...scan.actions].filter(([, fn]) => fn.type?.getText() === "Promise<void>");
const adapterKeys = new Set(adapters.map(([key]) => key));

/** The `return`s of `fn` itself — not of a function written inside it. */
function ownReturns(fn: ts.FunctionDeclaration): ts.ReturnStatement[] {
  return nodesUnder(fn.body!, ts.isReturnStatement).filter((r) => ts.findAncestor(r, ts.isFunctionLike) === fn);
}

describe("every form adapter lands through one rule, and every form bound to one says when a refusal shows", () => {
  it("the scan reads the adapters — those that stay on their page and those that leave it on every press", () => {
    expect(adapters.length, "found no form adapters at all — did the scan break?").toBeGreaterThan(10);
    for (const key of [
      "src/app/settings/actions.ts#updateSettingsAction",
      "src/app/budgets/actions.ts#createBudgetAction",
      "src/app/budgets/actions.ts#deactivateBudgetAction",
      "src/app/transactions/actions.ts#runCategorizationAction",
      "src/app/accounts/actions.ts#createAccountAction",
    ]) {
      expect(adapterKeys, key).toContain(key);
    }
  });

  it("every adapter lands through `landBack` — none redirects on its own, and none returns before it", () => {
    const unlanded = adapters
      .filter(([, fn]) => {
        const calls = nodesUnder(fn.body!, ts.isCallExpression);
        return (
          ownReturns(fn).length > 0 ||
          calls.some((call) => calleeName(call) === "redirect") ||
          !calls.some((call) => calleeName(call) === "landBack")
        );
      })
      .map(([key]) => key);
    expect(unlanded).toEqual([]);
  });

  /** Does the element binding the action carry the field — in its `<form>`, or among the fields it is handed? */
  function carriesRefusal(element: ts.JsxOpeningLikeElement): boolean {
    // a component that writes the form out (`ConfirmActionButton`): `...refusalShownFields(…)` among its fields
    const fields = element.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === "fields");
    const handed = fields !== undefined && ts.isJsxAttribute(fields) ? fields.initializer : undefined;
    const literal = handed !== undefined && ts.isJsxExpression(handed) ? handed.expression : undefined;
    if (literal !== undefined && ts.isObjectLiteralExpression(literal)) {
      return literal.properties.some(
        (p) => ts.isSpreadAssignment(p) && ts.isCallExpression(p.expression) && calleeName(p.expression) === "refusalShownFields",
      );
    }
    // a `<form>` written out here: the field among what it holds
    if (!ts.isJsxOpeningElement(element) || element.tagName.getText() !== "form") return false;
    return nodesUnder(element.parent, ts.isJsxSelfClosingElement).some((child) => child.tagName.getText() === "RefusalShownField");
  }

  it("every form bound to one carries the field while its page shows a refusal", () => {
    const unwired = scan.files.flatMap((scanned) => {
      const bound = scan.bindingsIn(scanned);
      return nodesUnder(scanned.ast, ts.isJsxAttribute).flatMap((attribute) => {
        const value = attribute.initializer;
        if (attribute.name.getText() !== "action" || value === undefined || !ts.isJsxExpression(value)) return [];
        const action = value.expression !== undefined && ts.isIdentifier(value.expression) ? bound.get(value.expression.text) : undefined;
        if (action === undefined || !adapterKeys.has(action)) return [];
        return carriesRefusal(attribute.parent.parent) ? [] : [`${lineOf(scanned, attribute)} ${value.expression!.getText()}`];
      });
    });
    expect(unwired).toEqual([]);
  });
});

/*
 * 🔴 The review of b96b7546 (2026-11-05, a dev server over his ledger copy 10-29b, /settings): a cleared "Price
 * staleness (hours)" refused to `?error=Price staleness window: Too small: expected number to be >=1` (history 7 → 8),
 * 6 typed and saved landed back on /settings (8 → 9), and one Back brought the refusal back above the 6 he had saved.
 * In a server action Next's `redirect()` PUSHES unless told otherwise, so the landing stacked the clean page over the
 * refusal's entry. A press made while the page shows a refusal takes that entry's place — with the page, or with the
 * next refusal — and a first refusal is pushed, so Back from it is the page as it stood.
 */
describe("a press made while a refusal shows takes the refusal's place in his history", () => {
  const form = (showing: boolean): FormData => {
    const fd = new FormData();
    for (const [name, value] of Object.entries(refusalShownFields(showing ? "Too small" : null))) fd.set(name, value);
    return fd;
  };
  /** where `landBack` sends a press on /settings, and the history entry it asks for */
  const land = <T>(showing: boolean, result: ActionResult<T>, landing?: Landing<T>): typeof navigations => {
    navigations.length = 0;
    try {
      landBack("/settings", form(showing), result, landing);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("NEXT_REDIRECT")) throw error;
    }
    return [...navigations];
  };

  it("a press that lands while one shows replaces its entry — Back is the page before the refusal", () => {
    expect(land(true, { ok: true, data: null })).toEqual([{ url: "/settings", type: "replace" }]);
  });

  it("…and so does the next refusal, on its page or another — Back is never the refusal before it", () => {
    expect(land(true, { ok: false, error: "Too big" })).toEqual([
      { url: "/settings?error=Too%20big", type: "replace" },
    ]);
    expect(land(true, { ok: false, error: "Gone" }, { refusedOn: "/accounts" })).toEqual([
      { url: "/accounts?error=Gone", type: "replace" },
    ]);
  });

  it("a first refusal is pushed — Back from it is the page as it stood", () => {
    expect(land(false, { ok: false, error: "Too small" })).toEqual([
      { url: "/settings?error=Too%20small", type: "push" },
    ]);
  });

  it("a press that lands with none shown stays where it is", () => {
    expect(land(false, { ok: true, data: null })).toEqual([]);
  });
});

/*
 * 🔴 The review of cb2e89ac (2026-11-05): a form that leaves its page on every press kept Next's default, a push, so
 * on /budgets the budget created after a refusal stacked /budgets over it and one Back brought the alert back. Where
 * such a press lands is its own (`landsOn`) — /budgets, the filtered view /transactions was pressed from, a new
 * account's page — and it takes the refusal's entry as a press that stays does.
 */
describe("a form that leaves its page on every press lands where it goes, in a shown refusal's place", () => {
  const form = (showing: boolean): FormData => {
    const fd = new FormData();
    for (const [name, value] of Object.entries(refusalShownFields(showing ? "Budget amount must be positive" : null))) {
      fd.set(name, value);
    }
    return fd;
  };
  const land = <T>(
    page: string,
    showing: boolean,
    result: ActionResult<T>,
    landing: Landing<T>,
  ): typeof navigations => {
    navigations.length = 0;
    try {
      landBack(page, form(showing), result, landing);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("NEXT_REDIRECT")) throw error;
    }
    return [...navigations];
  };
  const toBudgets: Landing<unknown> = { landsOn: () => "/budgets" };

  it("a budget created while /budgets shows a refusal replaces its entry — one Back is /budgets as it stood", () => {
    expect(land("/budgets", true, { ok: true, data: null }, toBudgets)).toEqual([{ url: "/budgets", type: "replace" }]);
  });

  it("…and one created with none shown goes to /budgets as it always did", () => {
    expect(land("/budgets", false, { ok: true, data: null }, toBudgets)).toEqual([{ url: "/budgets", type: "push" }]);
  });

  it("a refusal there is pushed, and one over it takes its place", () => {
    expect(land("/budgets", false, { ok: false, error: "Budget amount must be positive" }, toBudgets)).toEqual([
      { url: "/budgets?error=Budget%20amount%20must%20be%20positive", type: "push" },
    ]);
    expect(land("/budgets", true, { ok: false, error: "Pick a category" }, toBudgets)).toEqual([
      { url: "/budgets?error=Pick%20a%20category", type: "replace" },
    ]);
  });

  it("where the press lands is its own: a new account's page, in the place of /accounts' refusal", () => {
    expect(
      land("/accounts", true, { ok: true, data: { id: "acct-1" } }, { landsOn: ({ id }) => `/accounts/${id}` }),
    ).toEqual([{ url: "/accounts/acct-1", type: "replace" }]);
  });

  it("a refusal on a page with a query of its own follows it with `&error=` — /transactions' filtered view", () => {
    const view = "/transactions?view=review&page=2";
    expect(land(view, false, { ok: false, error: "No run" }, { landsOn: () => view })).toEqual([
      { url: `${view}&error=No%20run`, type: "push" },
    ]);
    expect(land(view, true, { ok: true, data: null }, { landsOn: () => `${view}&notice=no-api-key` })).toEqual([
      { url: `${view}&notice=no-api-key`, type: "replace" },
    ]);
  });
});
