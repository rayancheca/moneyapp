import { describe, expect, test } from "vitest";
import { matchesRestorePhrase, RESTORE_PHRASE } from "./restore-phrase";

describe("matchesRestorePhrase", () => {
  test("accepts the word, in any case, with stray whitespace", () => {
    for (const input of [RESTORE_PHRASE, "restore", " Restore ", "\tRESTORE\n"]) {
      expect(matchesRestorePhrase(input)).toBe(true);
    }
  });

  test("rejects everything that is not the word", () => {
    for (const input of ["", " ", "y", "yes", "RESTOR", "RESTOREE", "re store", "confirm"]) {
      expect(matchesRestorePhrase(input)).toBe(false);
    }
  });
});
