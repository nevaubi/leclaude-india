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

/** Regulator, gazette, tax and Parliament adapters (owned by the regulators stream): ibbi, sebi-orders, sat-orders,
 *  cci-orders, egazette, cbic, gst-council, cbdt, mca-master, sansad. */
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
};

export { backfillCursor, parseCursor } from "./common";
export { decodeCbicPdf } from "./cbic";
