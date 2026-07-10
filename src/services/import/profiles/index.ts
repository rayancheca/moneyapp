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
import { ofxProfile } from "./ofx-profile";
import { statementPdf } from "./pdf-profile";
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
  chaseSpendingReportPdf,
  capitalOneStatementPdf,
  statementPdf,
];
