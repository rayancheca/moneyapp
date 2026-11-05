import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/app/transactions/action-types";
import { refusalShownFields } from "@/components/ui/ErrorBanner";
import { calleeName, lineOf, nodesUnder, scanServerActions } from "@/lib/server-action-scan";
import { landBack } from "./refusal-landing";

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
 */

const scan = scanServerActions();

/** The adapters React binds to a `<form action>`: exported async functions of a `"use server"` module, `Promise<void>`. */
const adapters = [...scan.actions].filter(([, fn]) => fn.type?.getText() === "Promise<void>");

/** The `return`s of `fn` itself — not of a function written inside it. */
function ownReturns(fn: ts.FunctionDeclaration): ts.ReturnStatement[] {
  return nodesUnder(fn.body!, ts.isReturnStatement).filter((r) => ts.findAncestor(r, ts.isFunctionLike) === fn);
}

/** An adapter that leaves its page on every press: no `return`, and a `redirect(…)` its last statement (/budgets). */
function redirectsEveryPress(fn: ts.FunctionDeclaration): boolean {
  const last = fn.body!.statements.at(-1);
  return (
    ownReturns(fn).length === 0 &&
    last !== undefined &&
    ts.isExpressionStatement(last) &&
    ts.isCallExpression(last.expression) &&
    calleeName(last.expression) === "redirect"
  );
}

/** The adapters whose press, landing, stays on its page — each must take a shown refusal away. */
const staysPut = new Set(adapters.filter(([, fn]) => !redirectsEveryPress(fn)).map(([key]) => key));

describe("a form whose press stays on its page takes a refusal it shows away", () => {
  it("the scan reads the adapters — /budgets' leave on every press, the rest stay", () => {
    expect(adapters.length, "found no form adapters at all — did the scan break?").toBeGreaterThan(10);
    expect(staysPut).toContain("src/app/settings/actions.ts#updateSettingsAction");
    expect(staysPut).not.toContain("src/app/budgets/actions.ts#createBudgetAction");
  });

  it("every adapter that stays on its page lands through `landBack`, and returns before it nowhere", () => {
    const unlanded = [...staysPut].filter((key) => {
      const fn = scan.actions.get(key)!;
      const calls = nodesUnder(fn.body!, ts.isCallExpression);
      return ownReturns(fn).length > 0 || !calls.some((call) => calleeName(call) === "landBack");
    });
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
        if (action === undefined || !staysPut.has(action)) return [];
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
  const land = (showing: boolean, result: ActionResult<unknown>, refusedOn?: string): typeof navigations => {
    navigations.length = 0;
    try {
      landBack("/settings", form(showing), result, refusedOn);
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
    expect(land(true, { ok: false, error: "Gone" }, "/accounts")).toEqual([
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
