import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type DbBundle } from "@/db/client";
import { seedDatabase } from "@/db/seed";
import { merchants } from "@/db/schema/merchants";
import { recurringSeries } from "@/db/schema/recurring";
import { transactions } from "@/db/schema/transactions";
import { merchantIntelligence } from "@/services/merchants";
import { seedHisCarSeries, type OneChargeLedger } from "@/services/one-charge-fixture";
import { MerchantProfileCards } from "./MerchantProfileCards";

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/*
 * ⚖️ Owner decision 2026-10-08 (§6A 56): a schedule of ONE charge is billed once, on its day — "Billed once, on Nov 11,
 * as …" — and a monthly bill in its last months is still "Billed monthly as …". 🔴 Review of 3044ea6 put the sentence
 * back on the stored cadence ("Billed monthly as Car insurance — Nov 11 balance …") with every component test still
 * green: only the service's `oneChargeLabel` was asked. From his two series as stored, at the insurer both charge
 * through, as `merchantIntelligence` reads it for `/merchants/<id>`.
 */
describe("MerchantProfileCards — 'Billed … as' says once for a schedule of one charge", () => {
  const TODAY = "2026-10-08";
  let dir: string;
  let bundle: DbBundle;
  let his: OneChargeLedger;
  let insurerId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "moneyapp-merchant-cards-"));
    bundle = createDatabase(path.join(dir, "t.db"));
    seedDatabase(bundle.db);
    his = seedHisCarSeries(bundle.db);
    insurerId = bundle.db
      .insert(merchants)
      .values({ canonicalName: "Progressive" })
      .returning({ id: merchants.id })
      .get().id;
    // his two posted insurance charges, at the insurer — the visits the card needs to draw at all
    bundle.db.update(transactions).set({ merchantId: insurerId }).run();
  });

  afterEach(() => {
    bundle.sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** the card's sentence, with the insurer billing him through `seriesId` alone */
  function billedSentence(seriesId: string): string {
    bundle.db.update(recurringSeries).set({ merchantId: insurerId }).where(eq(recurringSeries.id, seriesId)).run();
    const html = renderToStaticMarkup(
      createElement(MerchantProfileCards, { intelligence: merchantIntelligence(bundle.db, insurerId, TODAY) }),
    );
    const words = decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ");
    return /Billed [^.]*\./.exec(words)?.[0] ?? "";
  }

  test("the Nov 11 balance is billed once, on Nov 11", () => {
    expect(billedSentence(his.balanceId)).toBe(
      "Billed once, on Nov 11, as Car insurance — Nov 11 balance after the $1,000 early payment.",
    );
  });

  test("Car insurance, two charges left, is billed monthly", () => {
    expect(billedSentence(his.insuranceId)).toBe("Billed monthly as Car insurance.");
  });
});
