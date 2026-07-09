"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ASSET_TYPES } from "@/db/schema/holdings";
import { isValidIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";
import { parseQuantityToE8, upsertHolding } from "@/services/holdings";
import { refreshPrices } from "@/services/prices";

const addHoldingFormSchema = z.object({
  accountId: z.string().min(1, "Pick an account"),
  symbol: z.string().trim().min(1, "Enter a symbol"),
  assetType: z.enum(ASSET_TYPES),
  quantity: z.string().trim().min(1, "Enter a quantity"),
  avgCost: z.string().trim().optional(),
  occurredOn: z.string().refine(isValidIsoDate, "Invalid date").optional(),
});

export async function addHoldingAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = addHoldingFormSchema.parse({
    accountId: raw.accountId,
    symbol: raw.symbol,
    assetType: raw.assetType,
    quantity: raw.quantity,
    avgCost: typeof raw.avgCost === "string" && raw.avgCost !== "" ? raw.avgCost : undefined,
    occurredOn:
      typeof raw.occurredOn === "string" && raw.occurredOn !== "" ? raw.occurredOn : undefined,
  });

  // quantity is parsed with string math — floats never touch it
  const quantityE8 = parseQuantityToE8(parsed.quantity);
  const avgCostCents = parsed.avgCost !== undefined ? parseAmountToCents(parsed.avgCost) : null;
  if (avgCostCents !== null && avgCostCents < 0) {
    throw new Error("Average cost must be positive");
  }

  upsertHolding(getDb(), {
    accountId: parsed.accountId,
    symbol: parsed.symbol,
    assetType: parsed.assetType,
    quantityE8,
    avgCostCents,
    occurredOn: parsed.occurredOn,
  });

  revalidatePath("/");
  revalidatePath("/investments");
}

/**
 * Provider outages degrade to cached prices with the "as of" stamp —
 * a refresh must never take the page down (Phase 7 acceptance).
 */
export async function refreshPricesAction(): Promise<void> {
  await refreshPrices(getDb());
  revalidatePath("/");
  revalidatePath("/investments");
}
