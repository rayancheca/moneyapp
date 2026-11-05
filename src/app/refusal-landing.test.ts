import ts from "typescript";
import { describe, expect, it } from "vitest";
import { calleeName, lineOf, nodesUnder, scanServerActions } from "@/lib/server-action-scan";

/**
 * ⚖️ Owner 2026-10-06 (§6A 44): a press clears a stale banner — a press is a new action. A `<form action>` adapter that
 * stays on its page when its press lands keeps the URL the refusal left, so the page re-renders with `?error=` and
 * the banner stays beside the work the press just did. ONE rule takes it away (`landBack`): the form carries
 * `REFUSAL_SHOWN` while its page shows a refusal, and only then does a press that lands go back with none.
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
