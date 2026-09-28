/** Matter contracts shared by the matters API and UI. Client-safe. */
import type { Matter, PracticeArea } from "@/lib/types/domain";
import type { IndianCaseInfo } from "./india";

export type { IndianCaseInfo } from "./india";

export const PRACTICE_AREAS: readonly PracticeArea[] = ["Litigation", "Products Liability", "Commercial", "Corporate / M&A", "Employment", "Regulatory", "IP", "Real Estate"];
export const MATTER_STATUSES: readonly Matter["status"][] = ["active", "pre-suit", "on hold", "closed"];
export const CLIENT_SIDES: readonly Matter["clientSide"][] = ["plaintiff", "defendant", "petitioner", "respondent", "buyer", "seller", "other"];

/** List filter: a stored status, "open" (everything not archived, the default), "archived" or "all". */
export type MatterStatusFilter = Matter["status"] | "open" | "archived" | "all";
export const MATTER_STATUS_FILTERS: readonly MatterStatusFilter[] = ["open", "active", "pre-suit", "on hold", "closed", "archived", "all"];

/** Stored matter plus the bookkeeping fields the matters module adds. */
export interface MatterRecord extends Matter {
  /** Firm matter / docket number; unique within the workspace when present. */
  number?: string;
  createdAt?: string;
  updatedAt?: string;
  createdById?: string;
  /** Archived matters keep every record; archiving is a status change, never a delete. */
  archivedAt?: string;
  /** Indian case particulars: court/bench (registry), case type and number, CNR, hearings, cause-list status. */
  india?: IndianCaseInfo;
}

/** Row returned by GET /api/matters (names resolved server-side). */
export interface MatterRow extends MatterRecord {
  leadAttorneyName?: string;
  team: { id: string; name: string; title?: string }[];
  archived: boolean;
}

export interface MatterInput {
  name?: string;
  shortName?: string;
  number?: string;
  caption?: string;
  client?: string;
  clientSide?: Matter["clientSide"];
  practiceArea?: PracticeArea;
  court?: string;
  jurisdiction?: string;
  judge?: string;
  status?: Matter["status"];
  stage?: string;
  description?: string;
  openedAt?: string;
  teamIds?: string[];
  leadAttorneyId?: string | null;
  /** Replaces the stored case particulars; null clears them. */
  india?: IndianCaseInfo | null;
}

export function statusLabel(s: MatterStatusFilter): string {
  switch (s) {
    case "open": return "Open";
    case "all": return "All";
    case "archived": return "Archived";
    case "pre-suit": return "Pre-suit";
    case "on hold": return "On hold";
    default: return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

export function sideLabel(s: Matter["clientSide"]): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
