import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { noScheduleReason, type SeriesEvidence, type SeriesStatusForCopy } from "@/lib/series-evidence";

// the server action pulls in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({ setSeriesOverridesAction: vi.fn() }));
// what a Save says — asked of the toast it raises
vi.mock("@/components/ui/Toast", () => ({ toast: vi.fn() }));

const { CadenceSentence, pressSeriesOverride } = await import("./CadenceSentence");
const { setSeriesOverridesAction } = await import("@/app/recurring/actions");
const { toast } = await import("@/components/ui/Toast");
const { ACTION_FAILED } = await import("@/hooks/useAction");

const EVERY_EVIDENCE: readonly SeriesEvidence[] = ["active", "never-billed", "awaiting-statements", "running-late", "lapsed", "schedule-ended"];
const EVERY_STATUS: readonly SeriesStatusForCopy[] = ["detected", "confirmed", "dismissed", "ended"];

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type SentenceProps = Parameters<typeof CadenceSentence>[0];

/** Amazon Prime as his ledger stores it on 2026-10-08: last charge Jul 5, stored next 2026-08-05. */
function propsOf(
  status: SeriesStatusForCopy,
  evidence: SeriesEvidence,
  overrides: Partial<SentenceProps> = {},
): SentenceProps {
  return {
    seriesId: "s1",
    kind: "subscription",
    cadence: "monthly",
    nextExpectedOn: "2026-08-05",
    amountCents: -499,
    userCadence: null,
    userNextExpectedOn: null,
    userAmountCents: null,
    detectedCadence: "monthly",
    accountName: "Chase Sapphire",
    status,
    evidence,
    // Amazon Prime has charged — its last on Jul 5
    neverPosted: false,
    oneCharge: null,
    // billed on its own: its days fall due on themselves
    dueWith: null,
    onChanged: () => undefined,
    ...overrides,
  };
}

function render(
  status: SeriesStatusForCopy,
  evidence: SeriesEvidence,
  overrides: Partial<SentenceProps> = {},
): { text: string; dialogTriggers: number; menuTriggers: number } {
  const html = renderToStaticMarkup(createElement(CadenceSentence, propsOf(status, evidence, overrides)));
  return {
    text: decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    // the date token and the amount token each open a dialog; the cadence token opens a menu
    dialogTriggers: [...html.matchAll(/aria-haspopup="dialog"/g)].length,
    menuTriggers: [...html.matchAll(/aria-haspopup="menu"/g)].length,
  };
}

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56): the one-time Nov 11 car-insurance balance reads as ONE CHARGE. 🔴 Its page
 * read "charges monthly around the 11th, about $72.74" — a rhythm it does not have — over a CADENCE stat of "Monthly".
 */
describe("CadenceSentence — a schedule of one charge says once, and on which day", () => {
  const nov11 = {
    kind: "bill",
    nextExpectedOn: "2026-11-11",
    amountCents: -7274,
    userNextExpectedOn: "2026-11-11",
    userAmountCents: -7274,
    // the bank has never charged it
    neverPosted: true,
    oneCharge: { day: "2026-11-11", label: "Nov 11" },
  } as const satisfies Partial<SentenceProps>;

  test("the Nov 11 balance: once, its day, its amount — and no cadence menu, since one charge takes no step", () => {
    const { text, dialogTriggers, menuTriggers } = render("confirmed", "never-billed", nov11);
    expect(text).toBe("charges once on Nov 11, about $72.74 from Chase Sapphire.");
    expect(menuTriggers).toBe(0);
    // its day and its amount are still his to correct
    expect(dialogTriggers).toBe(2);
  });

  /*
   * ⛔ …and "was expected", never "charged": the bank never charged it. 🔴 Review of 49cc98f: from Nov 12 its page read
   * "charged once on Nov 11, about $72.74" over "Linked transactions · 0" (his ledger copy, 2026-10-12).
   */
  test("once it is over the day stays — a one-off's day is its schedule, not a rhythm read off a stale date", () => {
    for (const [status, evidence] of [
      ["ended", "never-billed"],
      ["confirmed", "schedule-ended"],
    ] as const) {
      const { text, dialogTriggers } = render(status, evidence, nov11);
      expect(text, `${status} · ${evidence}`).toBe("was expected once on Nov 11, about $72.74 from Chase Sapphire.");
      expect(dialogTriggers).toBe(1);
    }
    // paid, it was charged
    expect(render("confirmed", "schedule-ended", { ...nov11, neverPosted: false }).text).toBe(
      "charged once on Nov 11, about $72.74 from Chase Sapphire.",
    );
  });
});

/**
 * 🔴 THE 2026-09-10 DEFECT, BACK FOR A LAPSED SERIES. On a copy of the owner's ledger 2026-10-08,
 * `/recurring/<Amazon Prime>` (detected, lapsed that morning) read "charges monthly around the 5th, about $4.99." above
 * "Nothing expected · This series has gone quiet past the point a bill stops, so it is no longer forecast and nothing
 * more is expected from it". The 5th was read off the stored 2026-08-05 — a date the forecast does not expect — and
 * its editor saved a `userNextExpectedOn` that toasted "Next expected …" while the lapse, which reads
 * `lastMatchedOn`, kept the page saying "Nothing expected". `noScheduleReason` had learned the lapse privately and
 * this sentence still asked `seriesIsOver` alone.
 */
describe("CadenceSentence — a series the forecast has let go is described in the past, with no day to edit", () => {
  test("Amazon Prime's sentence: past tense, the cadence and amount detection measured, no day clause", () => {
    for (const status of ["detected", "confirmed"] as const) {
      const { text, dialogTriggers } = render(status, "lapsed");
      expect(text, status).toBe("charged monthly, about $4.99 from Chase Sapphire.");
      // only the amount's editor — no "Next expected date" editor whose save the page would not honour
      expect(dialogTriggers, status).toBe(1);
    }
  });

  test("a late bill the forecast still carries keeps its present-tense schedule and its date editor", () => {
    const { text, dialogTriggers } = render("detected", "running-late");
    expect(text).toBe("charges monthly around the 5th, about $4.99 from Chase Sapphire.");
    expect(dialogTriggers).toBe(2);
  });

  test("the sentence's tense and the 'Nothing expected' card turn on one predicate, for every status and evidence", () => {
    // the linkage, not two lists that happen to agree today
    for (const status of EVERY_STATUS) {
      for (const evidence of EVERY_EVIDENCE) {
        const { text, dialogTriggers } = render(status, evidence);
        const nothingExpected = noScheduleReason(status, evidence, "subscription", true) !== null;
        expect(text.startsWith("charged "), `${status} · ${evidence}`).toBe(nothingExpected);
        expect(text.includes("around the"), `${status} · ${evidence}`).toBe(!nothingExpected);
        expect(dialogTriggers, `${status} · ${evidence}`).toBe(nothingExpected ? 1 : 2);
      }
    }
  });
});

/*
 * 🔴 His pay's page read "deposits weekly on Thursdays, about $1,141.92 from Wells Fargo Everyday Checking." — pay does
 * not come FROM the account it lands in (a copy of his ledger, 2026-10-13). The account clause says which way the money
 * moves through it: into it for pay, out of it for a bill — and a transfer series, which is one leg of a move between
 * his own accounts, by its own sign.
 */
describe("CadenceSentence — the account clause says which way the money moves through it", () => {
  const pay = {
    kind: "income",
    cadence: "weekly",
    nextExpectedOn: "2026-10-15",
    amountCents: 114_192,
    userAmountCents: 114_192,
    detectedCadence: "weekly",
    accountName: "Wells Fargo Everyday Checking",
  } as const satisfies Partial<SentenceProps>;

  test("his pay lands INTO Wells Fargo — present tense, as his ledger copy reads it on 2026-10-13", () => {
    expect(render("confirmed", "active", pay).text).toBe(
      "deposits weekly on Thursdays, about $1,141.92 into Wells Fargo Everyday Checking.",
    );
  });

  test("…and still into it once the pay is over, deposited or never", () => {
    expect(render("ended", "active", pay).text).toBe("deposited weekly, about $1,141.92 into Wells Fargo Everyday Checking.");
    expect(render("ended", "active", { ...pay, neverPosted: true }).text).toBe(
      "was expected weekly, about $1,141.92 into Wells Fargo Everyday Checking.",
    );
  });

  test("a bill still leaves FROM its account", () => {
    expect(render("detected", "running-late").text).toBe("charges monthly around the 5th, about $4.99 from Chase Sapphire.");
  });

  test("a transfer goes by its leg's sign: the autopay out of checking, the card's payment into the card", () => {
    const autopay = { kind: "transfer", nextExpectedOn: "2026-10-24", accountName: "Chase Checking" } as const;
    expect(render("detected", "active", { ...autopay, amountCents: -99_302 }).text).toBe(
      "moves monthly around the 24th, about $993.02 from Chase Checking.",
    );
    expect(render("detected", "active", { ...autopay, amountCents: 99_302, accountName: "Chase Sapphire" }).text).toBe(
      "moves monthly around the 24th, about $993.02 into Chase Sapphire.",
    );
  });
});

/**
 * The sentence's date editor as the sentence hands it over — what it calls its date, and its Save — read off the
 * element tree: the popover that prints them mounts only while open (`Popover`).
 */
type DateEditor = { fieldLabel: string; onSave: (date: string | null) => void };
function dateEditorOf(overrides: Partial<SentenceProps>): DateEditor {
  const found: DateEditor[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement<Partial<DateEditor> & { children?: ReactNode }>(n)) return;
    if (typeof n.props.fieldLabel === "string") found.push(n.props as DateEditor);
    walk(n.props.children);
  };
  walk(CadenceSentence(propsOf("confirmed", "active", overrides)));
  expect(found).toHaveLength(1);
  return found[0]!;
}

/*
 * ⚖️ default (B), built, not asked (2026-10-30): a day of what the rent carries FALLS DUE with the rent's day it pairs
 * with, and its page's list, the All tab and Upcoming name that day — while the sentence's day token and its date
 * editor are its OWN schedule's, the date a Save writes (on the rent's day, a Save with nothing changed would retype
 * it onto the rent's). 🔴 Review of a456a6fc, on his ledger copy 2026-10-29b with his rent retyped Nov 16 (Wells Fargo
 * read through Nov 9), on Nov 10: "Rent utilities & fees" read "charges monthly around the 1st" and its editor "Next
 * expected date" opened on Nov 1 over "Next expected Nov 16 · Dec 16 · Jan 16" and the All tab's Nov 16 — two next
 * dates for one charge, and nothing on the page saying which is which. Now the sentence says both, and the editor calls
 * its date its own (`dueWithPhrase`, `nextDateWords`).
 */
describe("CadenceSentence — what the rent carries says the day it falls due beside its own", () => {
  // his utilities, billed with the rent retyped Nov 16: their own Nov 1 falls due with its Nov 16
  const utilities = {
    kind: "bill",
    nextExpectedOn: "2026-11-01",
    amountCents: -18_221,
    userAmountCents: -18_221,
    accountName: "Wells Fargo",
    dueWith: { carrierName: "Flamingo South Beach (rent)", on: "2026-11-16", label: "Nov 16" },
  } as const satisfies Partial<SentenceProps>;

  test("their own 1st, due with the rent on the 16th — the day their list names; the editor's date their own", () => {
    const { text, dialogTriggers } = render("confirmed", "active", utilities);
    expect(text).toBe(
      "charges monthly around the 1st, due with the rent on the 16th, about $182.21 from Wells Fargo.",
    );
    // the 1st still opens the editor, and the editor says whose date it is
    expect(dialogTriggers).toBe(2);
    expect(dateEditorOf(utilities).fieldLabel).toBe("Its own next date");
  });

  test("…and on his ledger, the rent and the utilities both on the 1st: no clause, and 'Next expected date'", () => {
    const his = { ...utilities, dueWith: null };
    expect(render("confirmed", "active", his).text).toBe(
      "charges monthly around the 1st, about $182.21 from Wells Fargo.",
    );
    expect(dateEditorOf(his).fieldLabel).toBe("Next expected date");
  });

  test("their own 25th beside the rent's 1st: due with the rent on the 1st — 'Already due' and the list's day", () => {
    const on25 = {
      ...utilities,
      nextExpectedOn: "2026-11-25",
      dueWith: { ...utilities.dueWith, on: "2026-12-01", label: "Dec 1" },
    };
    expect(render("confirmed", "active", on25).text).toBe(
      "charges monthly around the 25th, due with the rent on the 1st, about $182.21 from Wells Fargo.",
    );
  });

  test("weekly, it names the weekday it falls due on; a schedule of one charge, the date", () => {
    const weekly = {
      ...utilities,
      cadence: "weekly",
      detectedCadence: "weekly",
      // a Monday, due with the rent's Thursday
      nextExpectedOn: "2026-11-02",
      dueWith: { ...utilities.dueWith, on: "2026-11-05", label: "Nov 5" },
    } as const;
    expect(render("confirmed", "active", weekly).text).toBe(
      "charges weekly on Mondays, due with the rent on Thursdays, about $182.21 from Wells Fargo.",
    );
    const once = { ...utilities, oneCharge: { day: "2026-11-01", label: "Nov 1" } };
    expect(render("confirmed", "active", once).text).toBe(
      "charges once on Nov 1, due with the rent on Nov 16, about $182.21 from Wells Fargo.",
    );
    expect(dateEditorOf(once).fieldLabel).toBe("Its own next date");
  });

  test("over, the clause goes with the day it qualifies", () => {
    expect(render("ended", "active", utilities).text).toBe(
      "charged monthly, about $182.21 from Wells Fargo.",
    );
    expect(render("ended", "active", { ...utilities, oneCharge: { day: "2026-11-01", label: "Nov 1" } }).text).toBe(
      "charged once on Nov 1, about $182.21 from Wells Fargo.",
    );
  });

  test("…and its Save says the date is its own — 'Next expected' of a series billed on its own", async () => {
    vi.mocked(setSeriesOverridesAction).mockResolvedValue({ ok: true, data: {} });
    vi.mocked(toast).mockClear();
    dateEditorOf(utilities).onSave("2026-11-05");
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Its own next date 2026-11-05" }));
    vi.mocked(toast).mockClear();
    dateEditorOf({ ...utilities, dueWith: null }).onSave("2026-11-05");
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Next expected 2026-11-05" }));
  });

  // 🔴 Review of 933b29e2 (L78): beside a field called "Its own next date", "Use detected" toasted "Next date reset to
  // detected" — the one message left that did not say which date it meant
  test("…and its 'Use detected' says the date it reset is its own — 'Next date' of one billed on its own", async () => {
    vi.mocked(setSeriesOverridesAction).mockResolvedValue({ ok: true, data: {} });
    vi.mocked(toast).mockClear();
    dateEditorOf(utilities).onSave(null);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Its own next date reset to detected" }));
    vi.mocked(toast).mockClear();
    dateEditorOf({ ...utilities, dueWith: null }).onSave(null);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Next date reset to detected" }));
  });
});

/** The sentence's three editors as it hands them over, read off the element tree, as `dateEditorOf` reads one. */
function editorsOf(overrides: Partial<SentenceProps>): {
  pick: (cadence: "monthly" | null) => void;
  saveDate: (date: string | null) => void;
  saveAmount: (cents: number | null) => void;
} {
  const props: Record<string, unknown>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement<Record<string, unknown> & { children?: ReactNode }>(n)) return;
    props.push(n.props);
    walk(n.props.children);
  };
  walk(CadenceSentence(propsOf("confirmed", "active", overrides)));
  const one = <T,>(key: string, test: (p: Record<string, unknown>) => boolean): T => {
    const found = props.filter(test);
    expect(found, key).toHaveLength(1);
    return found[0]![key] as T;
  };
  return {
    pick: one("onPick", (p) => typeof p.onPick === "function"),
    saveDate: one("onSave", (p) => typeof p.onSave === "function" && typeof p.fieldLabel === "string"),
    saveAmount: one("onSave", (p) => typeof p.onSave === "function" && typeof p.cents === "number"),
  };
}

/*
 * 🔴 Review of 7b7443b2 (2026-11-05, a dev server over his ledger copy 10-29b): the sentence's three editors awaited
 * their save with no catch, and each dropped the promise — on HBO Max's page, Monthly picked from the cadence menu with
 * the server down rejected "Failed to fetch" unhandled: no toast, and the sentence still read "charges annual". Settled
 * (`settleAction`), a save that never reached the server says what it threw, as a refusal says its reason, and nothing
 * is re-read as if it had landed.
 */
describe("CadenceSentence — an editor's save that is refused, or never reaches the server, says why", () => {
  const onChanged = vi.fn();
  const toasts = () => vi.mocked(toast).mock.calls.map(([t]) => t);

  beforeEach(() => {
    vi.mocked(setSeriesOverridesAction).mockReset();
    vi.mocked(toast).mockClear();
    onChanged.mockClear();
  });

  test("a save that lands re-reads the page and says what it set", async () => {
    vi.mocked(setSeriesOverridesAction).mockResolvedValue({ ok: true, data: {} });

    await pressSeriesOverride("s1", { userCadence: "monthly" }, "Cadence set to monthly", onChanged);

    expect(setSeriesOverridesAction).toHaveBeenCalledExactlyOnceWith({ seriesId: "s1", userCadence: "monthly" });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(toasts()).toEqual([{ title: "Cadence set to monthly" }]);
  });

  test("a refusal says its reason, and nothing is re-read", async () => {
    vi.mocked(setSeriesOverridesAction).mockResolvedValue({ ok: false, error: "Series not found" });

    await pressSeriesOverride("s1", { userAmountCents: -1599 }, "Amount updated", onChanged);

    expect(toasts()).toEqual([{ title: "Series not found", tone: "negative" }]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("a save that never reached the server says what it threw — or what every press says", async () => {
    vi.mocked(setSeriesOverridesAction).mockRejectedValueOnce(new Error("Failed to fetch")).mockRejectedValueOnce("nope");

    await pressSeriesOverride("s1", { userCadence: "monthly" }, "Cadence set to monthly", onChanged);
    await pressSeriesOverride("s1", { userCadence: "monthly" }, "Cadence set to monthly", onChanged);

    expect(toasts()).toEqual([
      { title: "Failed to fetch", tone: "negative" },
      { title: ACTION_FAILED, tone: "negative" },
    ]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("…and each of the three editors saves through it: the cadence menu, the date, the amount", async () => {
    vi.mocked(setSeriesOverridesAction).mockRejectedValue(new Error("Failed to fetch"));
    const editors = editorsOf({ nextExpectedOn: "2026-11-15" });

    editors.pick("monthly");
    editors.saveDate("2026-11-20");
    editors.saveAmount(-1599);

    await vi.waitFor(() => expect(toasts()).toHaveLength(3));
    expect(toasts()).toEqual(Array.from({ length: 3 }, () => ({ title: "Failed to fetch", tone: "negative" })));
  });
});
