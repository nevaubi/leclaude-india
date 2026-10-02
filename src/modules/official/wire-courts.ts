import "server-only";
import { registerOfficialImpl } from "./service";
import { causeListEntries, listingsForMatters, ordersForIdentifiers } from "./causelist/query";
import { courtCalendar } from "./calendars/query";

/**
 * Courts stream → service facade: cause-list entries, listings for matters, orders for identifiers, court calendars.
 * Importing this module registers the implementations (idempotent); `wireCourts()` does the same explicitly.
 */
export function wireCourts(): void {
  registerOfficialImpl({ causeListEntries, listingsForMatters, ordersForIdentifiers, courtCalendar });
}

wireCourts();
