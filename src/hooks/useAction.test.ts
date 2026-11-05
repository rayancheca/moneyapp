import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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
});
