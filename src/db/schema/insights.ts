import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt } from "./common";

/**
 * A model's editorial judgement about ONE pool of already-true sentences.
 *
 * ⛔ Nothing here is content. The row holds an ORDER of claim keys, every one of
 * which the app already wrote, already gated and already proved. If this table
 * were dropped, every insight surface would render exactly what it rendered
 * before pass 72d — the app's own editorial order — which is what makes the
 * kill switch honest rather than a degraded mode.
 *
 * Keyed by the pool's CONTENT hash (`lib/insight-hash`), not by a surface: the
 * moment a figure moves, the judgement was made about a pool that no longer
 * exists and the row simply stops being found. Nothing has to expire it.
 */
export const insightSelections = sqliteTable(
  "insight_selections",
  {
    /** sha256 of the facts, the candidate list and the vocabulary */
    factHash: text("fact_hash").primaryKey(),
    /** which page asked — for the settings list and for deleting one surface's rows */
    surface: text("surface").notNull(),
    /** ordered candidate keys (`claimId:f1+f2`), JSON. A SUBSET is legal; unknown keys are dropped on read. */
    claimKeys: text("claim_keys").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("insight_selections_surface_idx").on(t.surface)],
);
