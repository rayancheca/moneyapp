import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SimAccount, SimPeriod } from "./simulate";

/**
 * Synthetic statement PDFs with per-institution layouts, mirroring the
 * structures the research verified (deposit statements print Beginning/
 * Ending Balance; credit statements print Previous/New Balance with charges
 * positive; Robinhood prints portfolio values + a holdings table). These are
 * digitally-generated text PDFs — exactly what the deterministic parser
 * (unpdf x/y clustering) is built for.
 */

const PAGE = { width: 612, height: 792 } as const;
const MARGIN = 54;
const ROW_HEIGHT = 14.5;
const BODY_SIZE = 8.5;

const mdy = (day: string): string => `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
const usd = (cents: number): string => {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
};

interface Writer {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  bold: PDFFont;
}

async function newDoc(): Promise<Writer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE.width, PAGE.height]);
  return { doc, page, y: PAGE.height - MARGIN, font, bold };
}

function text(w: Writer, s: string, x: number, opts: { bold?: boolean; size?: number; rightAt?: number } = {}) {
  const font = opts.bold ? w.bold : w.font;
  const size = opts.size ?? BODY_SIZE;
  const drawX = opts.rightAt !== undefined ? opts.rightAt - font.widthOfTextAtSize(s, size) : x;
  w.page.drawText(s, { x: drawX, y: w.y, size, font, color: rgb(0.1, 0.1, 0.12) });
}

function line(w: Writer) {
  w.page.drawLine({
    start: { x: MARGIN, y: w.y - 3 },
    end: { x: PAGE.width - MARGIN, y: w.y - 3 },
    thickness: 0.5,
    color: rgb(0.75, 0.75, 0.75),
  });
}

function down(w: Writer, amount = ROW_HEIGHT) {
  w.y -= amount;
}

function ensureRoom(w: Writer, needed = ROW_HEIGHT * 2) {
  if (w.y < MARGIN + needed) {
    w.page = w.doc.addPage([PAGE.width, PAGE.height]);
    w.y = PAGE.height - MARGIN;
  }
}

export interface PdfRenderOptions {
  /** drop this many transactions from the LISTING while keeping printed balances — corruption demo */
  omitTxnIndex?: number;
}

export async function renderStatementPdf(
  account: SimAccount,
  period: SimPeriod,
  options: PdfRenderOptions = {},
): Promise<Uint8Array> {
  const w = await newDoc();
  const isCredit = account.type === "credit";
  const isInvestment = account.type === "investment";

  text(w, account.institution.toUpperCase(), MARGIN, { bold: true, size: 16 });
  down(w, 18);
  text(w, `${account.name} Statement`, MARGIN, { size: 11 });
  down(w, 16);
  text(w, `Account: ${account.name} ****${account.last4}`, MARGIN);
  down(w);
  text(w, `Statement Period: ${mdy(period.periodStart)} - ${mdy(period.periodEnd)}`, MARGIN);
  down(w, 22);

  // ── balance summary ───────────────────────────────────────────────────
  if (isInvestment) {
    text(w, "Portfolio Summary", MARGIN, { bold: true, size: 10 });
    down(w);
    text(w, "Beginning Portfolio Value", MARGIN);
    text(w, usd(period.beginCents), 0, { rightAt: PAGE.width - MARGIN });
    down(w);
    text(w, "Ending Portfolio Value", MARGIN);
    text(w, usd(period.endCents), 0, { rightAt: PAGE.width - MARGIN });
    down(w, 22);

    text(w, `Holdings as of ${mdy(period.periodEnd)}`, MARGIN, { bold: true, size: 10 });
    down(w);
    text(w, "Symbol", MARGIN, { bold: true });
    text(w, "Quantity", 0, { bold: true, rightAt: 300 });
    text(w, "Price", 0, { bold: true, rightAt: 400 });
    text(w, "Market Value", 0, { bold: true, rightAt: PAGE.width - MARGIN });
    line(w);
    down(w);
    for (const h of period.holdings ?? []) {
      ensureRoom(w);
      text(w, h.symbol, MARGIN);
      text(w, (h.quantityE8 / 1e8).toFixed(8), 0, { rightAt: 300 });
      text(w, usd(Math.round(h.price * 100)), 0, { rightAt: 400 });
      text(w, usd(h.valueCents), 0, { rightAt: PAGE.width - MARGIN });
      down(w);
    }
    text(w, "Cash", MARGIN);
    text(w, usd(period.cashCents ?? 0), 0, { rightAt: PAGE.width - MARGIN });
    down(w, 22);
  } else {
    const labels = isCredit ? ["Previous Balance", "New Balance"] : ["Beginning Balance", "Ending Balance"];
    // credit statements display the positive amount owed
    const display = (cents: number) => usd(isCredit ? -cents : cents);
    text(w, "Account Summary", MARGIN, { bold: true, size: 10 });
    down(w);
    text(w, labels[0]!, MARGIN);
    text(w, display(period.beginCents), 0, { rightAt: PAGE.width - MARGIN });
    down(w);
    text(w, labels[1]!, MARGIN);
    text(w, display(period.endCents), 0, { rightAt: PAGE.width - MARGIN });
    down(w, 22);
  }

  // ── activity table ────────────────────────────────────────────────────
  const showBalance = !isCredit && !isInvestment;
  text(w, "Account Activity", MARGIN, { bold: true, size: 10 });
  down(w);
  text(w, "Date", MARGIN, { bold: true });
  text(w, "Description", 120, { bold: true });
  text(w, "Amount", 0, { bold: true, rightAt: showBalance ? 460 : PAGE.width - MARGIN });
  if (showBalance) text(w, "Balance", 0, { bold: true, rightAt: PAGE.width - MARGIN });
  line(w);
  down(w);

  let running = period.beginCents;
  for (const [index, t] of period.txns.entries()) {
    running += t.amountCents;
    if (options.omitTxnIndex === index) continue; // corruption: listed rows no longer sum
    ensureRoom(w);
    text(w, mdy(t.postedOn), MARGIN);
    text(w, t.rawDescription.slice(0, 58), 120);
    // credit statements print charges positive, payments/credits negative
    const displayAmount = isCredit ? -t.amountCents : t.amountCents;
    text(w, usd(displayAmount), 0, { rightAt: showBalance ? 460 : PAGE.width - MARGIN });
    if (showBalance) text(w, usd(running), 0, { rightAt: PAGE.width - MARGIN });
    down(w);
  }

  down(w, 8);
  line(w);
  down(w);
  text(w, `Total activity: ${period.txns.length - (options.omitTxnIndex !== undefined ? 1 : 0)} transactions`, MARGIN, { size: 7.5 });

  return w.doc.save();
}

/** SoFi issues one combined PDF with a section per account (checking + savings). */
export async function renderSofiCombinedPdf(
  sections: { account: SimAccount; period: SimPeriod }[],
): Promise<Uint8Array> {
  const w = await newDoc();
  text(w, "SOFI", MARGIN, { bold: true, size: 16 });
  down(w, 18);
  text(w, "SoFi Checking & Savings Statement", MARGIN, { size: 11 });
  down(w, 16);
  const first = sections[0]!;
  text(w, `Statement Period: ${mdy(first.period.periodStart)} - ${mdy(first.period.periodEnd)}`, MARGIN);
  down(w, 24);

  for (const { account, period } of sections) {
    ensureRoom(w, ROW_HEIGHT * 8);
    text(w, `${account.name} ****${account.last4}`, MARGIN, { bold: true, size: 10 });
    down(w);
    text(w, "Beginning Balance", MARGIN);
    text(w, usd(period.beginCents), 0, { rightAt: PAGE.width - MARGIN });
    down(w);
    text(w, "Ending Balance", MARGIN);
    text(w, usd(period.endCents), 0, { rightAt: PAGE.width - MARGIN });
    down(w, 18);

    text(w, "Date", MARGIN, { bold: true });
    text(w, "Description", 120, { bold: true });
    text(w, "Amount", 0, { bold: true, rightAt: 460 });
    text(w, "Balance", 0, { bold: true, rightAt: PAGE.width - MARGIN });
    line(w);
    down(w);
    let running = period.beginCents;
    for (const t of period.txns) {
      running += t.amountCents;
      ensureRoom(w);
      text(w, mdy(t.postedOn), MARGIN);
      text(w, t.rawDescription.slice(0, 58), 120);
      text(w, usd(t.amountCents), 0, { rightAt: 460 });
      text(w, usd(running), 0, { rightAt: PAGE.width - MARGIN });
      down(w);
    }
    down(w, 14);
  }
  return w.doc.save();
}
