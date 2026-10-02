import "server-only";
import type { SourceAdapter } from "../../adapter";
import type { SourceId } from "../../types";
import { adapter as cbdt } from "./cbdt";
import { adapter as cbic } from "./cbic";
import { adapter as cci } from "./cci";
import { adapter as egazette } from "./egazette";
import { adapter as gstCouncil } from "./gst-council";
import { adapter as ibbi } from "./ibbi";
import { adapter as mca } from "./mca";
import { adapter as sansad } from "./sansad";
import { adapter as sat } from "./sat";
import { adapter as sebi } from "./sebi";
import { adapter as rbi } from "./rbi";
import { adapter as itat } from "./itat";
import { adapter as aptel } from "./aptel";
import { adapter as reraAppellate } from "./rera-appellate";
import { cestat, cic, ncdrc } from "./disabled-tribunals";

/** Regulator, gazette, tax, Parliament and tribunal-listing adapters (owned by the regulators stream): ibbi, sebi-orders,
 *  sat-orders, cci-orders, egazette, cbic, gst-council, cbdt, mca-master, sansad, rbi, itat-orders, aptel,
 *  rera-appellate, and the disabled cestat-orders, ncdrc, cic-decisions. */
export const REGULATOR_ADAPTERS: Partial<Record<SourceId, SourceAdapter>> = {
  ibbi,
  "sebi-orders": sebi,
  "sat-orders": sat,
  "cci-orders": cci,
  egazette,
  cbic,
  "gst-council": gstCouncil,
  cbdt,
  "mca-master": mca,
  sansad,
  rbi,
  "itat-orders": itat,
  aptel,
  "rera-appellate": reraAppellate,
  "cestat-orders": cestat,
  ncdrc,
  "cic-decisions": cic,
};

export { backfillCursor, parseCursor } from "./common";
export { decodeCbicPdf } from "./cbic";
