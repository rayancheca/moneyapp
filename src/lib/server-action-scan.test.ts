import { describe, expect, it } from "vitest";
import { scanServerActions, SRC_TREE, type ScanTree } from "./server-action-scan";

/**
 * What the scan reads as a server action — the one reading behind every gate that reads one where it is used
 * (hooks/useAction.test.ts, app/refusal-landing.test.ts).
 *
 * 🔴 The review of 63847994 (2026-11-06): it read only `export async function`, so an adapter written `export const
 * addAnchorAction = async (formData: FormData): Promise<void> =>`, with AnchorForm's field unwired, was no server
 * action to any gate — refusal-landing, useAction and accounts/actions passed 49/49 and tsc was clean (re-measured
 * 2026-11-06: the same). A "use server" module exports nothing but async functions, so every value it exports is read
 * as one, or the scan stops and names it: a gate that cannot see an export passes on it unseen.
 */

/** A tree of these files alone: how a module's shape is staged without touching src. */
function treeOf(files: Readonly<Record<string, string>>): ScanTree {
  return { paths: () => Object.keys(files), read: (file) => files[file] };
}

const ACTIONS = "src/app/staged/actions.ts";
const FORM = "src/components/staged/StagedForm.tsx";

/** The message the scan stops with on `tree`, or none. */
function refusalOf(tree: ScanTree): string | null {
  try {
    scanServerActions(tree);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("the server actions the scan reads", () => {
  it("reads `export const … = async` — an arrow or a function — as it reads `export async function`", () => {
    const scan = scanServerActions(
      treeOf({
        [ACTIONS]: [
          `"use server";`,
          `export async function declared(formData: FormData): Promise<void> {}`,
          `export const arrow = async (formData: FormData): Promise<void> => {};`,
          `export const expression = async function (formData: FormData): Promise<void> {};`,
          `export interface Staged { readonly ok: boolean }`,
          `export type Kind = "a" | "b";`,
          `async function unexported(): Promise<void> {}`,
        ].join("\n"),
        [FORM]: [
          `"use client";`,
          `import { arrow as add, declared, expression } from "@/app/staged/actions";`,
          `export function StagedForm() { return <form action={add} />; }`,
        ].join("\n"),
      }),
    );
    expect([...scan.actions.keys()]).toEqual([`${ACTIONS}#declared`, `${ACTIONS}#arrow`, `${ACTIONS}#expression`]);
    expect(Object.fromEntries(scan.bindingsIn(scan.files.find(({ file }) => file === FORM)!))).toEqual({
      add: `${ACTIONS}#arrow`,
      declared: `${ACTIONS}#declared`,
      expression: `${ACTIONS}#expression`,
    });
  });

  it("stops on a value a \"use server\" module exports that it cannot read as one, and names each", () => {
    const refusal = refusalOf(
      treeOf({
        [ACTIONS]: [
          `"use server";`,
          `async function addAnchorAction(formData: FormData): Promise<void> {}`,
          `export { addAnchorAction };`,
          `export default async function (formData: FormData): Promise<void> {}`,
          `export const wrapped = logged(async (formData: FormData): Promise<void> => {});`,
          `export const LIMIT = 5;`,
          `export function notAsync(): void {}`,
          `export type { Kind } from "./kinds";`,
        ].join("\n"),
      }),
    );
    expect(refusal?.split("\n").slice(1)).toEqual([
      `${ACTIONS}:3 export { addAnchorAction };`,
      `${ACTIONS}:4 export default async function (formData: FormData): Promise<void> {}`,
      `${ACTIONS}:5 wrapped = logged(async (formData: FormData): Promise<void> => {})`,
      `${ACTIONS}:6 LIMIT = 5`,
      `${ACTIONS}:7 export function notAsync(): void {}`,
    ]);
  });

  it("…and over src it reads every value a \"use server\" module exports", () => {
    // it stops, naming each, on one it cannot read
    const { actions } = scanServerActions(SRC_TREE);
    expect(actions.size, "found almost no server actions — did the scan break?").toBeGreaterThan(100);
  });
});
