import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/app/transactions/action-types";
import { refusalShownFields } from "@/components/ui/ErrorBanner";
import {
  calleeName,
  lineOf,
  nodesUnder,
  scanServerActions,
  SRC_TREE,
  type ScannedFile,
  type ServerAction,
  type ServerActionScan,
} from "@/lib/server-action-scan";
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
 *
 * 🔴 …and they picked the adapters by what they declare, `: Promise<void>`, from a scan that read only `export async
 * function`: an adapter written otherwise took its form out of every gate (the review of 63847994, 2026-11-06, its
 * cases staged below). A form adapter is every server action an `action={…}` binds, and an `action={…}` binding
 * anything else is named.
 */

/** An element binding a server action to its `action` — a `<form>`, or a component writing one out — and where. */
interface BoundForm {
  readonly scanned: ScannedFile;
  readonly element: ts.JsxOpeningLikeElement;
  /** the server action it binds, by `file#name` */
  readonly action: string;
  readonly where: string;
}

/** What the gates read in a scan: the form adapters, the forms binding them, and each `action={…}` that is neither. */
interface FormReading {
  readonly adapters: readonly (readonly [string, ServerAction])[];
  readonly boundForms: readonly BoundForm[];
  /** each `action={…}` binding no server action the scan reads, and handing on no `action` of its component's own */
  readonly unreadForms: readonly string[];
}

/**
 * The adapters React binds to a `<form action>`: every server action an `action={…}` binds — whatever it declares —
 * and every one declared `Promise<void>`, as an adapter is. 🔴 Picked by `: Promise<void>` alone, an adapter written
 * without it took its form out of every gate (the review of 63847994, below). An `action={…}` binding anything else —
 * a function of the file's own, an inline one — is named: no gate could read what its press does.
 */
function formReading(actionScan: ServerActionScan): FormReading {
  const attributes = actionScan.files.flatMap((scanned) => {
    const bindings = actionScan.bindingsIn(scanned);
    return nodesUnder(scanned.ast, ts.isJsxAttribute).flatMap((attribute) => {
      const value = attribute.initializer;
      if (attribute.name.getText() !== "action" || value === undefined || !ts.isJsxExpression(value)) return [];
      const name = value.expression;
      const action = name !== undefined && ts.isIdentifier(name) ? bindings.get(name.text) : undefined;
      return [{ scanned, attribute, name, action }];
    });
  });
  const boundForms = attributes.flatMap(({ scanned, attribute, name, action }) => {
    if (action === undefined || name === undefined) return [];
    const where = `${lineOf(scanned, attribute)} ${name.getText()}`;
    return [{ scanned, element: attribute.parent.parent, action, where }];
  });
  // what binds none is named — but a component's own `action`, handed on to the `<form>` it writes out
  // (ConfirmActionButton's): each element rendering it binds an `action={…}` read here too
  const unreadForms = attributes
    .filter(({ name, action }) => action === undefined && (name === undefined || propRead(name)?.prop !== "action"))
    .map(({ scanned, attribute }) => `${lineOf(scanned, attribute)} ${attribute.getText()}`);
  const bound = new Set(boundForms.map(({ action }) => action));
  const adapters = [...actionScan.actions].filter(
    ([key, fn]) => bound.has(key) || fn.type?.getText() === "Promise<void>",
  );
  return { adapters, boundForms, unreadForms };
}

const scan = scanServerActions();
const { adapters, boundForms, unreadForms } = formReading(scan);
const adapterKeys = new Set(adapters.map(([key]) => key));

/** The `return`s of `fn` itself — not of a function written inside it. */
function ownReturns(fn: ServerAction): ts.ReturnStatement[] {
  return nodesUnder(fn.body!, ts.isReturnStatement).filter((r) => ts.findAncestor(r, ts.isFunctionLike) === fn);
}

/** Each adapter not declared `Promise<void>`, with what it declares instead. */
function undeclared(found: FormReading["adapters"]): string[] {
  return found.flatMap(([key, fn]) => {
    const declared = fn.type?.getText();
    return declared === "Promise<void>" ? [] : [`${key}: ${declared ?? "no return type declared"}`];
  });
}

/** Each adapter that redirects on its own, returns before it lands, or never lands through `landBack`. */
function unlanded(found: FormReading["adapters"]): string[] {
  return found
    .filter(([, fn]) => {
      const calls = nodesUnder(fn.body!, ts.isCallExpression);
      return (
        ownReturns(fn).length > 0 ||
        calls.some((call) => calleeName(call) === "redirect") ||
        !calls.some((call) => calleeName(call) === "landBack")
      );
    })
    .map(([key]) => key);
}

/** Each element binding an adapter that carries no field saying its page shows a refusal. */
function unwired(forms: FormReading["boundForms"]): string[] {
  return forms.filter(({ element }) => refusalsHanded(element).length === 0).map(({ where }) => where);
}

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

/** The prop of its component that `value` reads — `{ refusal }`, or `props.refusal` — if it reads one. */
function propRead(value: ts.Expression): { component: string; prop: string } | undefined {
  const read = ts.isPropertyAccessExpression(value) ? value.expression : value;
  const declaration = ts.isIdentifier(read) ? declarationOf(read) : undefined;
  return declaration === undefined ? undefined : propOf(declaration, value);
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
  const declaration = ts.isIdentifier(value) ? declarationOf(value) : undefined;
  if (declaration !== undefined && ts.isVariableDeclaration(declaration)) return pageRefusal(scanned, declaration);
  const prop = propRead(value);
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

  it("every adapter is declared `Promise<void>` — one a form binds is an adapter whatever it declares", () => {
    expect(undeclared(adapters)).toEqual([]);
  });

  it("every `action={…}` binds a server action the scan reads, or hands on its component's own `action`", () => {
    expect(unreadForms).toEqual([]);
  });

  it("every adapter lands through `landBack` — none redirects on its own, and none returns before it", () => {
    expect(unlanded(adapters)).toEqual([]);
  });

  it("every form bound to one carries the field while its page shows a refusal", () => {
    expect(unwired(boundForms)).toEqual([]);
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
 * 🔴 The review of 63847994 (2026-11-06): the adapters were picked by the return they declare, `: Promise<void>`, and
 * the scan read only `export async function`. With addAnchorAction's annotation taken off (its `landBack` kept) and
 * AnchorForm's `<RefusalShownField error={refusal} />` made `{null}` — or the adapter written `export const
 * addAnchorAction = async (formData: FormData): Promise<void> =>`, the form unwired the same — refusal-landing,
 * useAction and accounts/actions passed 49/49 and tsc was clean (re-measured 2026-11-06: the same). He would see it on
 * /accounts/[id]: after a refused balance, the next balance that lands stays under `?error=`, the banner beside it —
 * 425ae02c's defect with every gate green. The review's cases are staged here over the real tree, as it made them.
 */
describe("a form's adapter is held to every gate whatever it declares, and however it is written", () => {
  /** `[file, text, its replacement]`: one edit a case makes to the real tree */
  type Edit = readonly [file: string, from: string, to: string];
  const ACTIONS = "src/app/accounts/actions.ts";
  const FORM = "src/components/accounts/AnchorForm.tsx";
  const DECLARED = "export async function addAnchorAction(formData: FormData): Promise<void> {";
  const UNWIRED: Edit = [FORM, "<RefusalShownField error={refusal} />", "{null}"];
  const ANCHOR_FORM_LINE = /^src\/components\/accounts\/AnchorForm\.tsx:\d+ /;

  /** The gates' reading of the real tree with `edits` made — each finds its text once, or the case stages nothing. */
  function staged(...edits: readonly Edit[]): FormReading {
    const texts = new Map<string, string>();
    for (const [file, from, to] of edits) {
      const text = texts.get(file) ?? SRC_TREE.read(file) ?? "";
      expect(text.split(from).length - 1, `${file} no longer reads "${from}" once`).toBe(1);
      texts.set(file, text.replace(from, to));
    }
    const tree = { paths: () => SRC_TREE.paths(), read: (file: string) => texts.get(file) ?? SRC_TREE.read(file) };
    return formReading(scanServerActions(tree));
  }

  it("an adapter a form binds that declares no `Promise<void>` is named — and its form, left unwired", () => {
    const reading = staged([ACTIONS, DECLARED, "export async function addAnchorAction(formData: FormData) {"], UNWIRED);
    expect(undeclared(reading.adapters)).toEqual([`${ACTIONS}#addAnchorAction: no return type declared`]);
    expect(unwired(reading.boundForms)).toEqual([expect.stringMatching(ANCHOR_FORM_LINE)]);
  });

  it("…and one written `export const … = async` is read as one written `export async function`", () => {
    const arrow = "export const addAnchorAction = async (formData: FormData): Promise<void> => {";
    const reading = staged([ACTIONS, DECLARED, arrow], UNWIRED);
    expect(reading.adapters.map(([key]) => key)).toContain(`${ACTIONS}#addAnchorAction`);
    expect(unwired(reading.boundForms)).toEqual([expect.stringMatching(ANCHOR_FORM_LINE)]);
  });

  it("a form bound to a function of its own, which calls the adapter, is named — no gate reads what it binds", () => {
    // caught, as useAction's gate asks, and tsc takes it: made in AnchorForm itself, 63847994's gates passed 49/49
    // and only this names it (2026-11-06)
    const wrapper = [
      "const submit = async (formData: FormData): Promise<void> => {",
      "  await addAnchorAction(formData).catch(() => undefined);",
      "};",
      "",
      "export function AnchorForm(",
    ].join("\n");
    const reading = staged(
      [FORM, "action={addAnchorAction}", "action={submit}"],
      [FORM, "export function AnchorForm(", wrapper],
    );
    const submitLine = new RegExp(`${ANCHOR_FORM_LINE.source}action=\\{submit\\}$`);
    expect(reading.unreadForms).toEqual([expect.stringMatching(submitLine)]);
    expect(reading.boundForms.filter(({ scanned }) => scanned.file === FORM)).toEqual([]);
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
