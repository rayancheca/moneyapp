import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/app/transactions/action-types";
import { refusalShownFields } from "@/components/ui/ErrorBanner";
import { calleeName, lineOf, nodesUnder, scanServerActions, type ScannedFile } from "@/lib/server-action-scan";
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
 *
 * 🔴 …and they read only that a form carries the field, never what it is handed. The review of ba9e0388 (2026-11-06)
 * set `refusal={null}` where /budgets hands BudgetRow and BudgetForm theirs, /accounts AccountForm and /transactions
 * HeaderStrip — and `error={null}` in the header strip's three fields — and every unit test stayed green (44 files,
 * 571 tests; re-measured the same on 2026-11-06): /budgets after a refusal was back to one Back bringing the alert
 * back. So each field is traced to the refusal its page shows — the page's own `errorParam(…)`, in its
 * `<ErrorBanner>` — through every component between them, and a break is named where it is.
 */

const scan = scanServerActions();

/** The adapters React binds to a `<form action>`: exported async functions of a `"use server"` module, `Promise<void>`. */
const adapters = [...scan.actions].filter(([, fn]) => fn.type?.getText() === "Promise<void>");
const adapterKeys = new Set(adapters.map(([key]) => key));

/** The `return`s of `fn` itself — not of a function written inside it. */
function ownReturns(fn: ts.FunctionDeclaration): ts.ReturnStatement[] {
  return nodesUnder(fn.body!, ts.isReturnStatement).filter((r) => ts.findAncestor(r, ts.isFunctionLike) === fn);
}

/** Every element binding an adapter to its `action` — a `<form>`, or a component that writes one out — where it is. */
const boundForms = scan.files.flatMap((scanned) => {
  const bound = scan.bindingsIn(scanned);
  return nodesUnder(scanned.ast, ts.isJsxAttribute).flatMap((attribute) => {
    const value = attribute.initializer;
    if (attribute.name.getText() !== "action" || value === undefined || !ts.isJsxExpression(value)) return [];
    const name = value.expression;
    if (name === undefined || !ts.isIdentifier(name)) return [];
    const action = bound.get(name.text);
    if (action === undefined || !adapterKeys.has(action)) return [];
    return [{ scanned, element: attribute.parent.parent, where: `${lineOf(scanned, attribute)} ${name.text}` }];
  });
});

/** A JSX element, opening or self-closing: what writes out a form, or renders a component. */
function isElement(node: ts.Node): node is ts.JsxOpeningLikeElement {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
}

/** `element`'s attribute `name`, if it has one. */
function attributeOf(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

/** What `name={…}` hands `element`, if it hands it an expression. */
function handedTo(element: ts.JsxOpeningLikeElement, name: string): ts.Expression | undefined {
  const value = attributeOf(element, name)?.initializer;
  return value !== undefined && ts.isJsxExpression(value) ? value.expression : undefined;
}

/**
 * What each field the element binding an adapter carries is handed: `refusalShownFields(…)` among the fields a
 * component that writes the form out (`ConfirmActionButton`) is handed, or `error={…}` on a `<RefusalShownField>` in
 * the `<form>` written out here. None when it carries no field.
 */
function refusalsHanded(element: ts.JsxOpeningLikeElement): ts.Expression[] {
  const fields = handedTo(element, "fields");
  if (fields !== undefined && ts.isObjectLiteralExpression(fields)) {
    return fields.properties.flatMap((p) =>
      ts.isSpreadAssignment(p) && ts.isCallExpression(p.expression) && calleeName(p.expression) === "refusalShownFields"
        ? p.expression.arguments.slice(0, 1)
        : [],
    );
  }
  if (!ts.isJsxOpeningElement(element) || element.tagName.getText() !== "form") return [];
  return nodesUnder(element.parent, ts.isJsxSelfClosingElement)
    .filter((child) => child.tagName.getText() === "RefusalShownField")
    .flatMap((child) => handedTo(child, "error") ?? []);
}

/** Where a refusal handed to a field comes from: the pages that show it, and each place it stops being theirs. */
interface Trace {
  /** the pages whose `<ErrorBanner>` shows the refusal handed */
  readonly shownOn: readonly string[];
  /** where what is handed stops being that refusal, by file:line — a page, or a component, handing something else */
  readonly breaks: readonly string[];
}

const brokenAt = (at: string): Trace => ({ shownOn: [], breaks: [at] });

/** Every element in src, and the file it is in. */
const elements = scan.files.flatMap((scanned) =>
  nodesUnder(scanned.ast, isElement).map((element) => ({ scanned, element })),
);
/** What each file's imports bind, by file — resolved by the one scan. */
const imported = new Map(scan.files.map((scanned) => [scanned.file, scan.importsIn(scanned)]));

/** Every element rendering the component `name` that `file` declares: there by that name, elsewhere as imported. */
function rendersOf(file: string, name: string): { scanned: ScannedFile; element: ts.JsxOpeningLikeElement }[] {
  return elements.filter(({ scanned, element }) => {
    const tag = element.tagName.getText();
    return scanned.file === file ? tag === name : imported.get(scanned.file)?.get(tag) === `${file}#${name}`;
  });
}

/** The names a scope declares: a block's `const`s, or a function's parameters. */
function namesDeclaredIn(scope: ts.Node): ts.BindingName[] {
  if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
    const statements = scope.statements.filter(ts.isVariableStatement);
    return statements.flatMap((s) => s.declarationList.declarations.map((d) => d.name));
  }
  return ts.isFunctionLike(scope) ? scope.parameters.map((p) => p.name) : [];
}

/** The declaration the name `read` reads, nearest scope first: a `const`, a parameter, or a name bound in either. */
function declarationOf(read: ts.Identifier): ts.Node | undefined {
  const bound = (name: ts.BindingName): ts.Node | undefined => {
    if (ts.isIdentifier(name)) return name.text === read.text ? name.parent : undefined;
    for (const element of name.elements) {
      const found = ts.isOmittedExpression(element) ? undefined : bound(element.name);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (let scope: ts.Node | undefined = read.parent; scope !== undefined; scope = scope.parent) {
    for (const name of namesDeclaredIn(scope)) {
      const found = bound(name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The name a component is declared by — `function X(…)`, or `const X = (…) =>` — and none for an inline callback. */
function componentName(fn: ts.SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  const holder = fn.parent;
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !ts.isVariableDeclaration(holder)) return undefined;
  return ts.isIdentifier(holder.name) ? holder.name.text : undefined;
}

/** The component whose props `declaration` is, and the prop `value` reads there: `{ refusal }`, or `props.refusal`. */
function propOf(declaration: ts.Node, value: ts.Expression): { component: string; prop: string } | undefined {
  const pattern = ts.isBindingElement(declaration) ? declaration.parent : undefined;
  const parameter = ts.isParameter(declaration)
    ? declaration
    : pattern !== undefined && ts.isObjectBindingPattern(pattern) && ts.isParameter(pattern.parent)
      ? pattern.parent
      : undefined;
  if (parameter === undefined || parameter.parent.parameters[0] !== parameter) return undefined;
  const component = componentName(parameter.parent);
  // `props.refusal` reads the parameter itself; `{ refusal }`, or `{ refusal: shown }`, a name bound in it
  const prop = ts.isPropertyAccessExpression(value)
    ? (declaration === parameter ? value.name.text : undefined)
    : ts.isBindingElement(declaration) ? (declaration.propertyName ?? declaration.name).getText() : undefined;
  return component === undefined || prop === undefined ? undefined : { component, prop };
}

/** `value` as a gate names it: on the element it is handed to, `<X refusal={null}>`, or in its call. */
function named(value: ts.Expression): string {
  const holder = value.parent;
  if (ts.isJsxExpression(holder) && ts.isJsxAttribute(holder.parent)) {
    return `<${holder.parent.parent.parent.tagName.getText()} ${holder.parent.getText()}>`;
  }
  return ts.isCallExpression(holder) ? holder.getText() : value.getText();
}

/** The page's own refusal: `const error = errorParam(…)` — and the `<ErrorBanner message={error}>` showing it. */
function pageRefusal(scanned: ScannedFile, declaration: ts.VariableDeclaration): Trace {
  const read = declaration.initializer;
  const name = declaration.name;
  if (read === undefined || !ts.isCallExpression(read) || calleeName(read) !== "errorParam" || !ts.isIdentifier(name)) {
    return brokenAt(`${lineOf(scanned, declaration)} ${declaration.getText()}`);
  }
  const page = ts.findAncestor(declaration, ts.isFunctionLike);
  const banners = (page === undefined ? [] : nodesUnder(page, isElement)).filter(
    (element) => element.tagName.getText() === "ErrorBanner",
  );
  const shows = banners.some((banner) => {
    const message = handedTo(banner, "message");
    return message !== undefined && ts.isIdentifier(message) && message.text === name.text;
  });
  return shows
    ? { shownOn: [scanned.file], breaks: [] }
    : brokenAt(`${lineOf(scanned, declaration)} ${declaration.getText()}, shown in no <ErrorBanner>`);
}

/**
 * How `value`, read in `scanned`, comes to be the refusal its page shows: the page's own `errorParam(…)`
 * (`pageRefusal`), or a prop of the component it is read in that every element rendering the component hands such
 * a value — followed through every component between the page and the field.
 */
function traceRefusal(scanned: ScannedFile, value: ts.Expression, followed: ReadonlySet<string> = new Set()): Trace {
  const read = ts.isPropertyAccessExpression(value) ? value.expression : value;
  const declaration = ts.isIdentifier(read) ? declarationOf(read) : undefined;
  if (declaration !== undefined && read === value && ts.isVariableDeclaration(declaration)) {
    return pageRefusal(scanned, declaration);
  }
  const prop = declaration === undefined ? undefined : propOf(declaration, value);
  if (prop === undefined) return brokenAt(`${lineOf(scanned, value)} ${named(value)}`);
  const key = `${scanned.file}#${prop.component}.${prop.prop}`;
  if (followed.has(key)) return { shownOn: [], breaks: [] };
  const renders = rendersOf(scanned.file, prop.component);
  if (renders.length === 0) return brokenAt(`${scanned.file} ${prop.component}: rendered nowhere the scan reads`);
  const traces = renders.map(({ scanned: at, element }) => {
    const handed = handedTo(element, prop.prop);
    if (handed !== undefined) return traceRefusal(at, handed, new Set([...followed, key]));
    const attribute = attributeOf(element, prop.prop);
    const tag = element.tagName.getText();
    return attribute === undefined
      ? brokenAt(`${lineOf(at, element)} <${tag}> leaves ${prop.prop} out`)
      : brokenAt(`${lineOf(at, attribute)} <${tag} ${attribute.getText()}>`);
  });
  return { shownOn: traces.flatMap((t) => t.shownOn), breaks: traces.flatMap((t) => t.breaks) };
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
    // …and the forms bound to them: a scan that resolves no import finds none, and the gates below pass on nothing
    expect(boundForms.length, "found no form bound to an adapter — did the scan's imports break?").toBeGreaterThan(15);
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

  it("every form bound to one carries the field while its page shows a refusal", () => {
    const unwired = boundForms.filter(({ element }) => refusalsHanded(element).length === 0).map(({ where }) => where);
    expect(unwired).toEqual([]);
  });

  it("…handed the refusal its page shows: the page's own `errorParam`, through every component between them", () => {
    const traces = boundForms.flatMap(({ scanned, element }) =>
      refusalsHanded(element).map((value) => traceRefusal(scanned, value)),
    );
    // a page, or a component, that hands its forms anything else — `refusal={null}`, a prop left out — by name
    expect([...new Set(traces.flatMap((t) => t.breaks))].sort()).toEqual([]);
    // …and the trace reaches each page whose forms it reads, through the components between them
    const shownOn = new Set(traces.flatMap((t) => t.shownOn));
    for (const page of [
      "src/app/budgets/page.tsx",
      "src/app/transactions/page.tsx",
      "src/app/accounts/page.tsx",
      "src/app/accounts/[id]/page.tsx",
      "src/app/settings/page.tsx",
      "src/app/imports/page.tsx",
      "src/app/recurring/page.tsx",
      "src/app/investments/page.tsx",
    ]) {
      expect(shownOn, page).toContain(page);
    }
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
