import "server-only";
import type { SourceAdapter } from "../../adapter";
import type { SourceId } from "../../types";
import { adapter as sciCauselist } from "./sci-causelist";
import { adapter as sciOrders } from "./sci-orders";
import { adapter as sciCalendar } from "./sci-calendar";
import { adapter as hcCalendars } from "./hc-calendars";
import { adapter as dhcCauselist } from "./dhc-causelist";
import { adapter as nclt } from "./nclt";
import { adapter as nclat } from "./nclat";
import { adapter as ngtOrders } from "./ngt-orders";

/** Court and tribunal adapters (owned by the courts stream): sci-causelist, sci-orders, sci-calendar, hc-calendars,
 *  dhc-causelist, nclt, nclat, ngt-orders. */
export const COURT_ADAPTERS: Partial<Record<SourceId, SourceAdapter>> = {
  "sci-causelist": sciCauselist,
  "sci-orders": sciOrders,
  "sci-calendar": sciCalendar,
  "hc-calendars": hcCalendars,
  "dhc-causelist": dhcCauselist,
  nclt,
  nclat,
  "ngt-orders": ngtOrders,
};
