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
import { statementPdf } from "./pdf-profile";
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
  sofiCombinedStatementPdf,
  // synthetic fixtures only — see isSyntheticStatementText
  statementPdf,
];
