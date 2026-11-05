import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { calleeName, lineOf, nodesUnder, scanServerActions } from "@/lib/server-action-scan";

/**
 * The two pure halves of the action runner. `useAction` itself is React and is
 * covered by e2e (no jsdom in this project), but the parts that decide whether
 * a call failed and whether a run still owns the UI are plain functions — and
 * they are exactly where the silent-failure bug lived.
 */

// the hook module imports the toast store for its default failure report; the
// pure exports under test never reach it
vi.mock("@/components/ui/Toast", () => ({ toast: vi.fn() }));

const { ACTION_FAILED, createRunGuard, settleAction } = await import("./useAction");

describe("settleAction", () => {
  it("passes a success straight through", async () => {
    const result = await settleAction(async () => ({ ok: true, data: 7 }) as const);
    expect(result).toEqual({ ok: true, data: 7 });
  });

  it("keeps the server's own message on a reported failure", async () => {
    const result = await settleAction(async () => ({ ok: false, error: "Rule not found" }) as const);
    expect(result).toEqual({ ok: false, error: "Rule not found" });
  });

  it("turns a REJECTED call into a failure instead of silence", async () => {
    const result = await settleAction(async () => {
      throw new Error("Failed to fetch");
    });
    expect(result).toEqual({ ok: false, error: "Failed to fetch" });
  });

  it("treats a synchronous throw as a failure too", async () => {
    const result = await settleAction(() => {
      throw new Error("boom");
    });
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("falls back when the rejection carries nothing readable", async () => {
    const nonError = await settleAction(async () => Promise.reject("nope"));
    const blank = await settleAction(async () => {
      throw new Error("   ");
    });
    expect(nonError).toEqual({ ok: false, error: ACTION_FAILED });
    expect(blank).toEqual({ ok: false, error: ACTION_FAILED });
  });

  it("falls back when the server reports a blank error", async () => {
    const result = await settleAction(async () => ({ ok: false, error: "" }) as const);
    expect(result).toEqual({ ok: false, error: ACTION_FAILED });
  });

  it("uses the caller's fallback wording", async () => {
    const result = await settleAction(async () => {
      throw new Error();
    }, "Couldn’t undo that");
    expect(result).toEqual({ ok: false, error: "Couldn’t undo that" });
  });
});

describe("createRunGuard", () => {
  it("keeps a lone run latest", () => {
    const isLatest = createRunGuard().begin();
    expect(isLatest()).toBe(true);
  });

  it("lets a later run supersede an earlier one, never the reverse", () => {
    const guard = createRunGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("gives each hook instance its own generations", () => {
    const a = createRunGuard();
    const b = createRunGuard();
    const runA = a.begin();
    b.begin();
    // b starting a run must not supersede a's
    expect(runA()).toBe(true);
  });
});

/** The head of the promise a `.then(` at `at` hangs off: `settleAction` for `settleAction(…).then(` */
function receiverHead(text: string, at: number): string {
  let i = at - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(text[i]!)) i--;
    if (text[i] === ")") {
      for (let depth = 0; i >= 0; i--) {
        if (text[i] === ")") depth++;
        else if (text[i] === "(" && --depth === 0) break;
      }
      i--;
      continue;
    }
    const end = i + 1;
    while (i >= 0 && /[\w$]/.test(text[i]!)) i--;
    let j = i;
    while (j >= 0 && /\s/.test(text[j]!)) j--;
    if (text[j] !== ".") return text.slice(i + 1, end);
    i = j - 1;
  }
}

/*
 * 🔴 Review of batch 9 F (2026-10-30): a65e948c settled a correction (`runCategoryCorrection`) — "a correction that
 * never reached the server says so" — and left the rule's siblings in the old shape, `void xAction(…).then(…)` with no
 * catch: the transaction sheet's Recategorize all, flags and notes (a refused notes save said nothing at all), the
 * review inbox's four presses, and more. A call that never reaches the server (restarted, wifi down) rejected
 * unhandled, and nothing reached him; a press that cleared its busy flag inside the `.then` stayed busy. A source gate,
 * as /imports' page.test.ts is: in a client file, every promise a `.then(` hangs off is settled (`settleAction`), so
 * what it says on a failure is the server's message or what the call threw, as `useAction` says it. A load is no press
 * (`load…`): it changes nothing, and is left as it is.
 */
describe("every press a client file makes is settled", () => {
  const root = path.join(process.cwd(), "src");
  const clientFiles = fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => [f.split(path.sep).join("/"), fs.readFileSync(path.join(root, f), "utf8")] as const)
    .filter(([, text]) => text.startsWith('"use client"'));

  it("no `.then(` hangs off a call that was not settled", () => {
    const unsettled = clientFiles.flatMap(([file, text]) =>
      [...text.matchAll(/\.then\(/g)].flatMap(({ index }) => {
        const line = text.slice(text.lastIndexOf("\n", index) + 1, text.indexOf("\n", index));
        if (/^\s*(\*|\/\/)/.test(line)) return [];
        const head = receiverHead(text, index);
        // settled where it is made, or bound to a settled call (`const kept = settleAction(…)`)
        if (head === "settleAction" || new RegExp(`\\b(?:const|let) ${head} = settleAction\\(`).test(text)) return [];
        if (/^load[A-Z]/.test(head)) return [];
        return [`${file}:${text.slice(0, index).split("\n").length} ${head}`];
      }),
    );
    expect(unsettled).toEqual([]);
  });

  /*
   * 🔴 Review of 7b7443b2 (2026-11-05): the test above reads only what a `.then(` hangs off, so a press AWAITED with no
   * catch walked round it green — the cadence sentence's three editors on /recurring/[id] (`async function save`, its
   * promise dropped by every caller: on a dev server over his ledger copy 10-29b, HBO Max's cadence menu picked Monthly
   * with the server down rejected "Failed to fetch" unhandled, no toast, and the sentence still read "charges annual"),
   * and the review inbox's row pick awaited inside `startTransition(async …)`, whose rejection a transition throws to
   * the page's error boundary. So every server action is read where it is used, in the parsed file
   * (`scanServerActions`): a call is settled — inside `settleAction`, a run (`useAction`'s, or a card's own that settles
   * what it is handed), an Undo card (`offerUndoToastWith`), the month pager (`useMonthPaging`), an inline edit's
   * `onSave` (`useInlineEdit` settles it) or a toast's `onAction` (`settleToastAction`) — or caught (`.catch(`, awaited
   * inside a `try` that catches, or bound to a name every use of which is), or a load (`load…`, as above) whose
   * rejection reaches no transition.
   */
  const scan = scanServerActions();
  // `useMonthPaging` runs the month load it is handed through `useAction`'s run
  const SETTLERS = new Set(["settleAction", "run", "offerUndoToastWith", "useMonthPaging"]);

  /** Is the promise `node` stands for settled where it is: handed to a settler, caught, or awaited in a `try`? */
  function settledAt(node: ts.Node): boolean {
    let awaited = false;
    for (let at: ts.Node = node; at.parent !== undefined; at = at.parent) {
      const up = at.parent;
      if (ts.isPropertyAccessExpression(up) && up.expression === at && up.name.text === "catch") return true;
      if (ts.isAwaitExpression(up)) awaited = true;
      if (ts.isTryStatement(up) && up.tryBlock === at && up.catchClause !== undefined && awaited) return true;
      if (ts.isFunctionLike(at)) {
        if (ts.isCallExpression(up) && up.arguments.some((a) => a === at) && SETTLERS.has(calleeName(up) ?? "")) return true;
        if (ts.isJsxExpression(up) && ts.isJsxAttribute(up.parent) && up.parent.name.getText() === "onSave") return true;
        if (ts.isPropertyAssignment(up) && up.name.getText() === "onAction") return true;
        // an await outside a function does not await what the function makes
        awaited = false;
      }
    }
    return false;
  }

  function settledCall(call: ts.CallExpression): boolean {
    if (settledAt(call)) return true;
    const bound = call.parent;
    if (!ts.isVariableDeclaration(bound) || bound.initializer !== call || !ts.isIdentifier(bound.name)) return false;
    const name = bound.name;
    const scope = ts.findAncestor(bound.parent, ts.isFunctionLike) ?? call.getSourceFile();
    const uses = nodesUnder(scope, ts.isIdentifier).filter((id) => id.text === name.text && id !== name);
    return uses.length > 0 && uses.every(settledAt);
  }

  /** Every use of a server action a file outside `"use server"` makes: the identifier, and the action it names. */
  const uses = scan.files
    .filter((scanned) => scanned.directive !== "use server")
    .flatMap((scanned) => {
      const bound = scan.bindingsIn(scanned);
      return nodesUnder(scanned.ast, ts.isIdentifier)
        .filter((id) => bound.has(id.text) && !ts.isImportSpecifier(id.parent) && ts.findAncestor(id, ts.isTypeNode) === undefined)
        .map((id) => ({ scanned, id }));
    });

  /**
   * Does `call`'s rejection reach a transition — awaited or returned by the function handed to `startTransition`,
   * which throws it to the page's error boundary?
   */
  function rejectsIntoTransition(call: ts.CallExpression): boolean {
    let reaches = false;
    for (let at: ts.Node = call; at.parent !== undefined; at = at.parent) {
      const up = at.parent;
      const returned = ts.isReturnStatement(up) || (ts.isArrowFunction(up) && up.body === at);
      if (ts.isAwaitExpression(up) || returned) reaches = true;
      if (ts.isFunctionLike(at)) {
        if (!reaches || !ts.isCallExpression(up)) return false;
        return up.arguments.some((a) => a === at) && calleeName(up) === "startTransition";
      }
    }
    return false;
  }

  /*
   * 🔴 Review of b96b7546 (2026-11-05, a dev server over his ledger copy 10-29b, /investments): with every server
   * action's POST failing as a down server's does, a tap on the P&L calendar's "Thu, Oct 1, 2026" replaced the whole
   * page with "This page didn't render … Failed to fetch" — `loadPnlDayAction`, awaited inside
   * `startTransition(async …)` and let through by its name, as /recurring's forecast load (`loadMonthForecastAction`)
   * was. A load changes nothing, and one left unsettled elsewhere replaces nothing; one whose rejection reaches a
   * transition is held as a press is.
   */
  it("a server action a client file calls is settled where it is called — awaited, or in a transition", () => {
    const unsettled = uses.flatMap(({ scanned, id }) => {
      const call = id.parent;
      if (!ts.isCallExpression(call) || call.expression !== id) return [];
      if (/^load[A-Z]/.test(id.text) && !rejectsIntoTransition(call)) return [];
      return settledCall(call) ? [] : [`${lineOf(scanned, call)} ${id.text}`];
    });
    expect(unsettled).toEqual([]);
  });

  it("…and one is handed on only as a form's `action` or to a settler, so every call is read where it is imported", () => {
    const handed = uses.flatMap(({ scanned, id }) => {
      const up = id.parent;
      // a load too: one handed to a hook that awaits it in a transition would be read nowhere
      if (ts.isCallExpression(up) && (up.expression === id || SETTLERS.has(calleeName(up) ?? ""))) return [];
      if (ts.isJsxExpression(up) && ts.isJsxAttribute(up.parent) && up.parent.name.getText() === "action") return [];
      return [`${lineOf(scanned, id)} ${id.text}`];
    });
    expect(handed).toEqual([]);
  });
});
