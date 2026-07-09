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
import { ofxProfile } from "./ofx-profile";
import { statementPdf } from "./pdf-profile";

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
  statementPdf,
];
