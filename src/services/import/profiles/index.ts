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
  // real-bank PDF statements (filename-routed) before the generic PDF fallback
  chaseSpendingReportPdf,
  capitalOneStatementPdf,
  chaseCheckingStatementPdf,
  discoverItStatementPdf,
  robinhoodCryptoStatementPdf,
  sofiCombinedStatementPdf,
  statementPdf,
];
