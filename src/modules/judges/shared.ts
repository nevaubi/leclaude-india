/** Judges directory: response shapes shared by the API and the UI (client-safe). */

export type JudgeStatus = "sitting" | "off_roster" | "former";

export interface JudgePhoto {
  mediaId: string;
  url: string;
  sourceUrl: string | null;
  alt: string | null;
}

export interface JudgeSummary {
  id: string;
  courtId: string;
  court: string | null;
  name: string;
  designation: string | null;
  status: JudgeStatus;
  dateOfAppointment: string | null;
  retirementDate: string | null;
  termExpires: string | null;
  photo: JudgePhoto | null;
}

export interface CourtJudgeCount {
  courtId: string;
  court: string | null;
  total: number;
  sitting: number;
  withPhoto: number;
}

export interface RosterSourceInfo {
  courtId: string;
  url: string;
  title: string;
  verified: "content" | "listing" | "unreachable";
  checkedAt: string;
}

export interface LastRunInfo {
  at: string;
  target: string;
  stop: string;
}

export interface JudgesListResponse {
  judges: JudgeSummary[];
  total: number;
  courts: CourtJudgeCount[];
  sources: RosterSourceInfo[];
  lastRun: LastRunInfo | null;
}

export interface JudgeJudgment {
  id: string;
  title: string;
  decisionDate: string | null;
  neutralCitation: string | null;
  caseNumber: string | null;
  textStatus: string;
  pdfUrl: string | null;
}

export interface JudgeProfile extends JudgeSummary {
  printedName: string;
  profileUrl: string | null;
  sourceUrl: string;
  sourceTitle: string | null;
  checkedAt: string | null;
  firstSeenAt: string | null;
  photoPublisher: string | null;
  photoPageUrl: string | null;
}

export interface JudgeJudgments {
  /** False when the judgment corpus is not available on this deployment. */
  available: boolean;
  /** Matched judgments (exact name as printed, same court). */
  count: number;
  /** True when the count stopped at the scan cap. */
  capped: boolean;
  recent: JudgeJudgment[];
  /** Why matching could not run (e.g. the name has no searchable word). */
  note?: string;
}

export interface JudgeProfileResponse {
  judge: JudgeProfile;
  judgments: JudgeJudgments;
}

export interface CoramMatch {
  name: string;
  judge: { id: string; name: string; photo: JudgePhoto | null } | null;
}

export interface CoramResponse {
  courtId: string;
  matches: CoramMatch[];
}

export interface CourtEmblemInfo {
  courtId: string;
  kind: "emblem" | "logo" | "building";
  mediaId: string;
  url: string;
  sourceUrl: string;
  pageUrl: string | null;
}

export interface CourtEmblemsResponse {
  emblems: Record<string, CourtEmblemInfo>;
}

export function judgeHref(id: string): string {
  return `/judges/${encodeURIComponent(id)}`;
}

export const STATUS_LABEL: Record<JudgeStatus, string> = {
  sitting: "Sitting",
  off_roster: "Not on current roster",
  former: "Former",
};
