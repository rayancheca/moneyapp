import { describe, expect, test } from "vitest";
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES } from "@/db/schema/accounts";
import {
  ACCOUNT_SUBTYPE_LABEL,
  ACCOUNT_TYPE_LABEL,
  accountSubtypeLabel,
  accountTypeLabel,
} from "./account-label";

describe("account-label", () => {
  test("every stored type and subtype has a word", () => {
    for (const t of ACCOUNT_TYPES) expect(ACCOUNT_TYPE_LABEL[t]).toBeTruthy();
    for (const s of ACCOUNT_SUBTYPES) expect(ACCOUNT_SUBTYPE_LABEL[s]).toBeTruthy();
  });

  /**
   * 🔴 THE LINE PRINTED ONE MAPPED WORD AND ONE RAW ENUM, TWO WORDS APART.
   * `/accounts/<Robinhood Brokerage>` read "Investment · brokerage · ····3525"
   * while the Edit sheet a button away said "Brokerage", and the /investments
   * account picker read "Robinhood Brokerage (brokerage)".
   */
  test("a subtype is a label, not the column value", () => {
    expect(accountSubtypeLabel("brokerage")).toBe("Brokerage");
    expect(accountSubtypeLabel("crypto")).toBe("Crypto");
    // the defect, spelled out: the raw value is not the word
    expect(accountSubtypeLabel("brokerage")).not.toBe("brokerage");
  });

  test("no subtype is no word — never an empty segment in the line", () => {
    expect(accountSubtypeLabel(null)).toBeNull();
    expect(accountSubtypeLabel(undefined)).toBeNull();
    expect(accountSubtypeLabel("")).toBeNull();
  });

  /**
   * ⛔ A column is a wider type than a union. A row written before a value was
   * retired, or by a migration this build does not know, must still print
   * something — the stored value beats "undefined".
   */
  test("an unknown stored value falls back to itself", () => {
    expect(accountTypeLabel("loan")).toBe("loan");
    expect(accountSubtypeLabel("futures")).toBe("futures");
  });

  test("a known type maps", () => {
    expect(accountTypeLabel("credit")).toBe("Credit card");
    expect(accountTypeLabel("investment")).toBe("Investment");
  });
});
