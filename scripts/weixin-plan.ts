/**
 * The China-trip mapping — ONE source of truth, imported by both the probe that
 * shows the plan and the script that applies it, so the two cannot drift.
 *
 * All 202 `WEIXIN*` rows sit on Chase Sapphire inside a single 2025-06-29 →
 * 2025-07-17 window. WeChat Pay is a payment RAIL, not a merchant, and Chase's
 * merchant-category code guessed the whole rail — 113 rows into a bare
 * `Shopping`, ten more into `Personal Care`, and a handful into `Travel`.
 *
 * The owner's rule, chosen 2026-08-26: **file by what it actually is.** Metro
 * and Didi are Transport; museums and temples are Entertainment; only rail and
 * Ctrip stay Travel. That rule is applied to the WHOLE trip, not just the 113 —
 * leaving his own metro taps split between `Travel` and `Transport` because of
 * which wrong bucket the bank happened to pick would be the same defect this
 * pass exists to remove.
 *
 * ⛔ 45 rows are DELIBERATELY LEFT in bare `Shopping`. 23 of them are literally
 * `WEIXIN*Scan QR code fo` — WeChat's placeholder for a merchant that never
 * registered a name — and the rest are truncated to nothing usable
 * (`Zhengzhou Cit`, `Sanchong Player`, `Stroll in the C`). His call: leave them
 * rather than invent a category. ⚠️ Note the descriptor is hard-truncated at 22
 * characters, so no more information is recoverable from the ledger.
 *
 * ⛔ The Rocket Money export is NOT used here. It labels the entire rail
 * "Dining & Drinks", metro fares included.
 */
export interface PlanEntry {
  /** target category path, `Parent > Child` or a bare root */
  to: string;
  /** why this group is what it is — the evidence, not the label */
  why: string;
  /** predicate over `t.raw_description`, evaluated inside the WEIXIN scope */
  where: string;
}

export const WEIXIN_SCOPE = `t.status='active' AND t.raw_description LIKE 'WEIXIN%'`;

export const WEIXIN_PLAN: PlanEntry[] = [
  {
    to: "Transport > Rideshare",
    why: "Didi Chuxing — China's rideshare app, $1.10–$5.50 a ride",
    where: `t.raw_description LIKE '%Didi Chuxing%'`,
  },
  {
    to: "Transport > Public Transit",
    why: "metro fares, the Shanghai transit card, and bike-share taps — 23 rows averaging $0.39",
    where: `(t.raw_description LIKE '%subway operatio%' OR t.raw_description LIKE '%Guangzhou Qi %'
             OR t.raw_description LIKE '%Hangang Metro%' OR t.raw_description LIKE '%Hangzhou City P%'
             OR t.raw_description LIKE '%Shanghai public%' OR t.raw_description LIKE '%Shanghai One-Ca%')`,
  },
  {
    to: "Food > Delivery",
    why: "Meituan — China's food-delivery super-app",
    where: `t.raw_description LIKE '%Meituan%'`,
  },
  {
    to: "Food > Groceries",
    why: "convenience stores and supermarkets — Lawson, FamilyMart, Lianhua, Yonghui, City Super, Yike",
    where: `(t.raw_description LIKE '%Yike Convenienc%' OR t.raw_description LIKE '%LAWSON%'
             OR t.raw_description LIKE '%Shanghai Lianhu%' OR t.raw_description LIKE '%Shanghai Family%'
             OR t.raw_description LIKE '%citysuper%' OR t.raw_description LIKE '%Zhejiang Yonghu%')`,
  },
  {
    to: "Food > Dining",
    why: "McDonald's (Maidanglao), a bar, a chocolate shop, a juice bar",
    where: `(t.raw_description LIKE '%Zhengzhou Maida%' OR t.raw_description LIKE '%DRUNK%'
             OR t.raw_description LIKE '%Choke Chocolate%' OR t.raw_description LIKE '%Hangzhou Oran%')`,
  },
  {
    to: "Entertainment > Events",
    why: "museums, temples, pagodas, scenic areas and a cableway — West Lake, Leifeng, Songshan, Yuyuan, Henan Museum",
    where: `(t.raw_description LIKE '%Henan Museum%' OR t.raw_description LIKE '%Yellow River Cu%'
             OR t.raw_description LIKE '%Chenghuang Pavi%' OR t.raw_description LIKE '%Hangzhou Xihu%'
             OR t.raw_description LIKE '%Hangzhou Leifen%' OR t.raw_description LIKE '%Henan Songsha%'
             OR t.raw_description LIKE '%Songyang Cablew%' OR t.raw_description LIKE '%West Lake sceni%'
             OR t.raw_description LIKE '%Songshan Scen%' OR t.raw_description LIKE '%Zhengzhou Yel%'
             OR t.raw_description LIKE '%Shanghai Yuyu%')`,
  },
  {
    to: "Entertainment > Games",
    why: "internet cafés — the Wangyu (网鱼) chain, and one that says 'Internet C' outright",
    where: `(t.raw_description LIKE '%wangyu internet%' OR t.raw_description LIKE '%Jela Internet%')`,
  },
  {
    to: "Travel > Other Travel",
    why: "Ctrip bookings — matches the Ctrip row he categorised himself",
    where: `t.raw_description LIKE '%Ctrip%'`,
  },
  {
    to: "Shopping > General",
    why: "Taobao, Dennis department store, Decathlon",
    where: `(t.raw_description LIKE '%Taobao%' OR t.raw_description LIKE '%Dennis departme%'
             OR t.raw_description LIKE '%Decathlon%')`,
  },
  {
    to: "Shopping > Electronics",
    why: "an electronics merchant",
    where: `t.raw_description LIKE '%Shuofang Elec%'`,
  },
  {
    to: "Personal Care",
    why: "Smell Library (气味图书馆) — a fragrance brand",
    where: `t.raw_description LIKE '%Smell Library%'`,
  },
  {
    to: "Shopping > Clothing",
    why: "Adidas — the bank code had filed it TRAVEL; Uniqlo already sits in Shopping > Clothing",
    where: `t.raw_description LIKE '%Adidas%'`,
  },
];
