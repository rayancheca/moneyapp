/**
 * Deterministic, filesystem-safe per-account folder slugs for the statement
 * archive (data/statements/<slug>/). The slug is institution + a human
 * descriptor + last4: the descriptor is the account name with the institution
 * words, card glyphs, and its own number stripped ("Chase Sapphire" → sapphire,
 * "Venture X" → venturex); when that leaves nothing, a checking/savings account
 * falls back to its type ("Chase ····3522" → chase-checking-3522) while a
 * named-elsewhere account (a solo card) leans on its last4 (Discover → discover-4741).
 * Stable across re-imports; a renamed account only affects folders written after
 * the rename, never the already-archived originals.
 */

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function institutionSlug(institutionName: string): string {
  return slugify(institutionName);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SluggableAccount {
  name: string;
  type: string;
  last4: string | null;
}

export function accountSlug(account: SluggableAccount, institutionName: string): string {
  const inst = institutionSlug(institutionName);

  // strip card glyphs and any long digit run (account/card numbers), then remove
  // the institution's own words, and collapse the remainder to one token
  let body = account.name.replace(/[·*•]/g, " ").replace(/\d{4,}/g, " ");
  for (const word of institutionName.split(/\s+/).filter(Boolean)) {
    body = body.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi"), " ");
  }
  const descriptor = body.replace(/[^a-z0-9]+/gi, "").toLowerCase();

  const typeIsDescriptive = account.type === "checking" || account.type === "savings";
  const desc = descriptor || (typeIsDescriptive ? account.type : "");

  const parts = [inst];
  if (desc) parts.push(desc);
  if (account.last4) parts.push(account.last4);
  // never a bare institution slug — a discriminator is always present
  if (parts.length === 1) parts.push(account.type);
  return parts.join("-");
}
