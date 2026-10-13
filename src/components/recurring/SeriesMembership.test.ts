import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SeriesMergeCandidate } from "@/services/recurring-detail";

// the server actions pull in next/cache and the database client
vi.mock("@/app/recurring/actions", () => ({
  attachToSeriesAction: vi.fn(),
  detachFromSeriesAction: vi.fn(),
  mergeIntoSeriesAction: vi.fn(),
  searchAttachCandidatesAction: vi.fn(),
}));
// the toasts a press raises, read as raised
vi.mock("@/components/ui/Toast", async (actual) => ({ ...(await actual<object>()), toast: vi.fn() }));
vi.mock("@/components/transactions/undo-toast", () => ({ offerUndoToast: vi.fn() }));

const { MergeConfirmation, pressAttach, pressMerge } = await import("./SeriesMembership");
const { attachToSeriesAction, mergeIntoSeriesAction } = await import("@/app/recurring/actions");
const { toast } = await import("@/components/ui/Toast");
const { offerUndoToast } = await import("@/components/transactions/undo-toast");
const { settleAction } = await import("@/hooks/useAction");

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The confirmation as it renders: its question, as he reads it, and the buttons under it. */
function confirmation(candidate: SeriesMergeCandidate): { question: string; buttons: string[] } {
  const html = renderToStaticMarkup(
    createElement(MergeConfirmation, { candidate, merging: false, onCancel: () => {}, onConfirm: () => {} }),
  );
  const question = /<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  return {
    question: decode(question.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    buttons: [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => decode(m[1] as string).trim()),
  };
}

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 54): merging a series in files its rows not filed yet under this series' category,
 * and the confirmation SAYS so before he presses — a merge has no undo button. That sentence was his condition for
 * merge filing at all.
 *
 * 🔴 Review 2026-10-08: no test rendered it. The labels tests covered `mergeFilingClause` on its own and the one e2e
 * merge files nothing (income into a subscription), so deleting the sentence from the page left every test green.
 */
describe("the merge confirmation, as rendered (§6A 54)", () => {
  const base = { id: "s2", name: "CAPITAL ONE 360 TRANSFER", kind: "bill" } as const;

  test("names the exact count and the category path before the press", () => {
    const { question } = confirmation({
      ...base,
      filing: { categoryId: "c1", categoryPath: "Subscriptions > Software", count: 24 },
    });
    expect(question).toBe(
      "Merge CAPITAL ONE 360 TRANSFER into this series? Its charges move here and it ends. " +
        "24 not filed yet will be filed under Subscriptions > Software.",
    );
  });

  test("nothing to file → the sentence he has always read, unchanged", () => {
    const { question } = confirmation({ ...base, name: "Rent", filing: null });
    expect(question).toBe("Merge Rent into this series? Its charges move here and it ends.");
  });

  test("the choice under it is still Cancel or Merge in", () => {
    expect(confirmation({ ...base, filing: null }).buttons).toEqual(["Cancel", "Merge in"]);
  });

  /*
   * ⛔ What moves is what the CANDIDATE posts, in the page's own words for it (`seriesPostingWords`) — the "Nothing
   * expected" card's, the End dialog's, "Per deposit". 🔴 It said "Its charges move here" whatever was picked: on his
   * ledger copy 2026-10-13 every series page but his pay's offers "It America LLC (weekly pay)" to merge in, and
   * picking it read "Its charges move here" of his weekly payroll deposits.
   */
  test("names what the candidate posts — his pay's deposits, a transfer's transfers, an `other` series' payments", () => {
    const pay = { id: "p", name: "It America LLC (weekly pay)", kind: "income", filing: null } as const;
    expect(confirmation(pay).question).toBe(
      "Merge It America LLC (weekly pay) into this series? Its deposits move here and it ends.",
    );
    expect(confirmation({ ...pay, name: "Savings sweep", kind: "transfer" }).question).toContain(
      "Its transfers move here and it ends.",
    );
    expect(confirmation({ ...pay, name: "Card credit", kind: "other" }).question).toContain(
      "Its payments move here and it ends.",
    );
    // a bill's and a subscription's read as he has always read them
    expect(confirmation({ ...pay, name: "HBO Max", kind: "subscription" }).question).toContain(
      "Its charges move here and it ends.",
    );
  });
});

/**
 * `useAction().run` without React — the same settle (`settleAction`) and the same routing: a success to `onSuccess`, a
 * failure to `onError`. A run here is always the newest, so nothing is superseded.
 */
const run: Parameters<typeof pressMerge>[0] = async (task, options) => {
  const result = await settleAction(task, options?.fallback);
  if (result.ok) options?.onSuccess?.(result.data);
  else options?.onError?.(result.error);
  return result;
};

/*
 * ⚖️ §6A 54 (2026-10-08): the confirmation names what the merge files, and the toast names what it filed.
 * 🔴 Review of §6A 54: the toast's filing was tested only on its label function — `MergeControl` could hand it a loose
 * `null` with every test green — and the confirmation, read when the page rendered, went to the merge unchecked. The
 * press is now made here, where `MergeControl` makes it.
 */
describe("the merge press, as MergeControl makes it (§6A 54)", () => {
  const filing = { categoryId: "c1", categoryPath: "Car > Lease", count: 2 };
  const candidate: SeriesMergeCandidate = { id: "s2", name: "Car lease 2", kind: "bill", filing };
  const after = { close: vi.fn(), onChanged: vi.fn() };

  beforeEach(() => {
    vi.mocked(toast).mockClear();
    after.close.mockClear();
    after.onChanged.mockClear();
  });

  test("carries what the confirmation showed, and the toast names what the merge filed", async () => {
    const merged = { relinked: 3, targetId: "s1", filed: filing };
    vi.mocked(mergeIntoSeriesAction).mockResolvedValue({ ok: true, data: merged });

    await pressMerge(run, "s1", candidate, after);

    expect(mergeIntoSeriesAction).toHaveBeenLastCalledWith({ sourceId: "s2", targetId: "s1", shown: filing });
    expect(toast).toHaveBeenCalledWith({ title: "Car lease 2 merged in · 3 moved · 2 filed under Car > Lease" });
    expect(after.close).toHaveBeenCalledOnce();
    expect(after.onChanged).toHaveBeenCalledOnce();
  });

  test("nothing shown, nothing filed — the toast he has always read", async () => {
    const merged = { relinked: 3, targetId: "s1", filed: null };
    vi.mocked(mergeIntoSeriesAction).mockResolvedValue({ ok: true, data: merged });

    await pressMerge(run, "s1", { ...candidate, name: "Rent", filing: null }, after);

    expect(mergeIntoSeriesAction).toHaveBeenLastCalledWith({ sourceId: "s2", targetId: "s1", shown: null });
    expect(toast).toHaveBeenCalledWith({ title: "Rent merged in · 3 moved" });
  });

  test("a refusal says why, stays open, and re-reads the page — so it names what the merge files now", async () => {
    const refusal =
      "Nothing was merged — what it would file has changed since you opened it. Read it again before you merge.";
    vi.mocked(mergeIntoSeriesAction).mockResolvedValue({ ok: false, error: refusal });

    await pressMerge(run, "s1", candidate, after);

    expect(toast).toHaveBeenCalledWith({ title: refusal, tone: "negative" });
    expect(after.close).not.toHaveBeenCalled();
    expect(after.onChanged).toHaveBeenCalledOnce();
  });
});

/*
 * 🔴 Review of §6A 54 (2026-10-08): the merge's toast named what it filed while attaching — the same rule, §6A 47 —
 * said only "2 attached". The attach press is made here, where `AttachPanel` makes it.
 */
describe("the attach press, as AttachPanel makes it", () => {
  test("its undo toast names what attaching filed, from the attach's own result", async () => {
    const undo = { rows: [] };
    const filed = { categoryId: "c1", categoryPath: "Car > Lease", count: 1 };
    vi.mocked(attachToSeriesAction).mockResolvedValue({ ok: true, data: { attached: 2, undo, filed } });
    const after = { cleared: vi.fn(), onChanged: vi.fn() };

    await pressAttach(run, "s1", ["t1", "t2"], after);

    expect(attachToSeriesAction).toHaveBeenLastCalledWith({ seriesId: "s1", transactionIds: ["t1", "t2"] });
    expect(offerUndoToast).toHaveBeenCalledWith("2 attached · 1 filed under Car > Lease", undo, after.onChanged);
    expect(after.cleared).toHaveBeenCalledOnce();
    expect(after.onChanged).toHaveBeenCalledOnce();
  });
});
