import type { ParserProfile } from "../types";
import {
  capOne360Csv,
  capOneCardCsv,
  chaseCardCsv,
  chaseDepositCsv,
  discoverCardCsv,
  robinhoodActivityCsv,
  sofiCsv,
} from "./csv-profiles";
import { capitalOneStatementPdf } from "./capitalone-statement-profile";
import { chaseCardStatementPdf } from "./chase-card-statement-profile";
import { chaseCheckingStatementPdf } from "./chase-checking-statement-profile";
import { discoverItStatementPdf } from "./discover-statement-profile";
import { ofxProfile } from "./ofx-profile";
import { rocketMoneyCsv } from "./rocket-money-csv";
import { statementPdf } from "./pdf-profile";
import { robinhoodBrokerageStatementPdf } from "./robinhood-brokerage-statement-profile";
import { robinhoodCryptoStatementPdf } from "./robinhood-crypto-statement-profile";
import { sofiCombinedStatementPdf } from "./sofi-statement-profile";
import { chaseSpendingReportPdf } from "./spending-report-profile";

/** Ordered registry — most specific matchers first. */
export const PROFILES: ParserProfile[] = [
  chaseDepositCsv,
  chaseCardCsv,
  discoverCardCsv,
  capOneCardCsv,
  capOne360Csv,
  sofiCsv,
  robinhoodActivityCsv,
  /*
   * A secondary export, and the only source this ledger has for Wells Fargo.
   * Its header is unlike any bank's, so ordering is not load-bearing — but it
   * emits ONLY the accounts in its own allowlist, because its descriptions are
   * rewritten and would therefore not dedupe against the seven accounts here
   * that do have real statements. See the file's header comment.
   */
  rocketMoneyCsv,
  ofxProfile,
  /*
   * Every PDF profile below matches ALL pdfs and is separated by matchesContent
   * alone, because filenames do not identify the institution: Chase ships
   * checking and card statements under one name, SoFi ships opaque UUIDs, and
   * the names the other profiles used to require were coined by hand at ingest.
   *
   * Order is therefore not load-bearing for correctness — the gates are
   * disjoint, verified over all 236 statements on disk. It stays meaningful for
   * one reason: selectProfile returns the FIRST candidate that passes its gate
   * OR HAS NO GATE, so an ungated profile here would shadow every gated one
   * after it. Do not add a PDF profile without a matchesContent.
   */
  chaseSpendingReportPdf,
  capitalOneStatementPdf,
  chaseCardStatementPdf,
  chaseCheckingStatementPdf,
  discoverItStatementPdf,
  robinhoodCryptoStatementPdf,
  // after the crypto profile: both are Robinhood PDFs, and while the brokerage
  // gate excludes the crypto markers explicitly, keeping the narrower product
  // first means a future loosening cannot silently swallow it
  robinhoodBrokerageStatementPdf,
  sofiCombinedStatementPdf,
  // synthetic fixtures only — see isSyntheticStatementText
  statementPdf,
];
