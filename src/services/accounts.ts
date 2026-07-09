import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDatabase } from "@/db/client";
import { accounts, ACCOUNT_TYPES, ACCOUNT_SUBTYPES, isLiability } from "@/db/schema/accounts";
import { institutions } from "@/db/schema/institutions";
import { latestBalances, type AccountBalance } from "./derivation";

export const accountInputSchema = z.object({
  institutionId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  type: z.enum(ACCOUNT_TYPES),
  subtype: z.enum(ACCOUNT_SUBTYPES).nullish(),
  last4: z
    .string()
    .trim()
    .regex(/^\d{4}$/)
    .nullish(),
});
export type AccountInput = z.infer<typeof accountInputSchema>;

export interface AccountView {
  id: string;
  institutionId: string;
  institutionName: string;
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  subtype: (typeof ACCOUNT_SUBTYPES)[number] | null;
  last4: string | null;
  isActive: boolean;
  isLiability: boolean;
  balance: AccountBalance | null;
}

export function listInstitutions(db: AppDatabase) {
  return db.select().from(institutions).orderBy(asc(institutions.name)).all();
}

export function listAccounts(db: AppDatabase): AccountView[] {
  const rows = db
    .select({
      id: accounts.id,
      institutionId: accounts.institutionId,
      institutionName: institutions.name,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      last4: accounts.last4,
      isActive: accounts.isActive,
      displayOrder: accounts.displayOrder,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .orderBy(asc(institutions.name), asc(accounts.displayOrder), asc(accounts.name))
    .all();

  const balances = latestBalances(db);
  return rows.map((r) => ({
    id: r.id,
    institutionId: r.institutionId,
    institutionName: r.institutionName,
    name: r.name,
    type: r.type,
    subtype: r.subtype,
    last4: r.last4,
    isActive: r.isActive,
    isLiability: isLiability(r.type),
    balance: balances.get(r.id) ?? null,
  }));
}

export function getAccount(db: AppDatabase, id: string) {
  return db.select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}

export function createAccount(db: AppDatabase, input: AccountInput): string {
  const parsed = accountInputSchema.parse(input);
  if (parsed.subtype && parsed.type !== "investment") {
    throw new Error("Subtype applies only to investment accounts");
  }
  const row = db
    .insert(accounts)
    .values({
      institutionId: parsed.institutionId,
      name: parsed.name,
      type: parsed.type,
      subtype: parsed.subtype ?? null,
      last4: parsed.last4 ?? null,
    })
    .returning({ id: accounts.id })
    .get();
  return row.id;
}

export function updateAccount(db: AppDatabase, id: string, input: Partial<AccountInput> & { isActive?: boolean }) {
  const parsed = accountInputSchema.partial().extend({ isActive: z.boolean().optional() }).parse(input);
  const existing = getAccount(db, id);
  if (!existing) throw new Error(`Unknown account ${id}`);
  db.update(accounts)
    .set({
      ...(parsed.institutionId !== undefined && { institutionId: parsed.institutionId }),
      ...(parsed.name !== undefined && { name: parsed.name }),
      ...(parsed.type !== undefined && { type: parsed.type }),
      ...(parsed.subtype !== undefined && { subtype: parsed.subtype }),
      ...(parsed.last4 !== undefined && { last4: parsed.last4 }),
      ...(parsed.isActive !== undefined && { isActive: parsed.isActive }),
    })
    .where(eq(accounts.id, id))
    .run();
}
