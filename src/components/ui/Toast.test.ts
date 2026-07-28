import { describe, expect, it } from "vitest";
import type { ActionResult } from "@/app/transactions/action-types";
import { settleToastAction, TOAST_ACTION_FAILED } from "./Toast";

/**
 * The card's settle rule. The bug this encodes against: the toast used to be
 * dismissed synchronously on click, so a failed Undo took its own patch with
 * it — a dismissal that means "done" must only ever follow a success.
 */

describe("settleToastAction", () => {
  it("dismisses a fire-and-forget action that resolves with nothing", () => {
    expect(settleToastAction({ status: "resolved", value: undefined })).toEqual({
      dismiss: true,
      error: null,
    });
  });

  it("dismisses on a reported success", () => {
    expect(settleToastAction({ status: "resolved", value: { ok: true } })).toEqual({
      dismiss: true,
      error: null,
    });
  });

  it("KEEPS the card on a reported failure, showing the server's message", () => {
    expect(
      settleToastAction({ status: "resolved", value: { ok: false, error: "Unknown transaction" } }),
    ).toEqual({ dismiss: false, error: "Unknown transaction" });
  });

  it("keeps the card when the action THREW", () => {
    expect(
      settleToastAction({ status: "rejected", reason: new Error("Failed to fetch") }),
    ).toEqual({ dismiss: false, error: "Failed to fetch" });
  });

  it("falls back when a failure carries nothing readable", () => {
    expect(settleToastAction({ status: "resolved", value: { ok: false } })).toEqual({
      dismiss: false,
      error: TOAST_ACTION_FAILED,
    });
    expect(settleToastAction({ status: "resolved", value: { ok: false, error: "  " } })).toEqual({
      dismiss: false,
      error: TOAST_ACTION_FAILED,
    });
    expect(settleToastAction({ status: "rejected", reason: "a string" })).toEqual({
      dismiss: false,
      error: TOAST_ACTION_FAILED,
    });
  });

  it("ignores a resolved value that is not an outcome (an action may return anything)", () => {
    const notAnOutcome = { restored: 3 } as unknown as undefined;
    expect(settleToastAction({ status: "resolved", value: notAnOutcome })).toEqual({
      dismiss: true,
      error: null,
    });
  });

  it("reads an ActionResult unchanged — what run()/settleAction() hand back", () => {
    const undone: ActionResult<{ restored: number }> = { ok: true, data: { restored: 300 } };
    const failed: ActionResult<{ restored: number }> = {
      ok: false,
      error: "Couldn’t undo that — the change is still in place",
    };
    expect(settleToastAction({ status: "resolved", value: undone })).toEqual({
      dismiss: true,
      error: null,
    });
    expect(settleToastAction({ status: "resolved", value: failed })).toEqual({
      dismiss: false,
      error: "Couldn’t undo that — the change is still in place",
    });
  });
});
