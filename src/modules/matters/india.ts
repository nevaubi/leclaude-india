/**
 * Indian case particulars for matters (client-safe, pure): court and bench from the registry, case type and number,
 * CNR, court hall, hearing dates and cause-list status.
 *
 * Superior courts come from the court registry (`src/lib/india/courts.ts`). Subordinate forums in the focus cities
 * (civil, commercial, sessions and magistrate courts at Bengaluru and Hyderabad) are listed here until the registry
 * carries district courts; each names the High Court it sits under so binding-authority logic still applies.
 * [VERIFY] Forum designations (which Additional City Civil & Sessions Judge sits as the Commercial Court, court-hall
 * numbers) change by notification; the list names the forum, never a specific court hall.
 */
import { COURTS, FOCUS_COURT_IDS, courtById, type Court, type StateCode } from "@/lib/india/courts";
import { CASE_TYPES, caseTypeById, CIVIL_SUIT_STAGES, CRIMINAL_TRIAL_STAGES, formatCaseNumber as registryFormatCaseNumber, parseCaseNumber as registryParseCaseNumber, resolveCaseType, type CaseCategory, type CaseType as RegistryCaseType } from "@/lib/india/procedure";

/** A subordinate forum (district-level court) in a focus city. */
export interface Forum {
  id: string;
  name: string;
  shortName: string;
  level: "district";
  state: StateCode;
  city: string;
  /** High Court with superintendence over the forum (registry id). */
  highCourtId: string;
  focus: true;
}

export const SUBORDINATE_FORUMS: Forum[] = [
  { id: "ka-blr-city-civil", name: "City Civil Court, Bengaluru", shortName: "CCC Bengaluru", level: "district", state: "KA", city: "Bengaluru", highCourtId: "hc-karnataka", focus: true },
  { id: "ka-blr-commercial", name: "Commercial Court, Bengaluru", shortName: "Com. Court Bengaluru", level: "district", state: "KA", city: "Bengaluru", highCourtId: "hc-karnataka", focus: true },
  { id: "ka-blr-sessions", name: "City Civil and Sessions Court, Bengaluru (Sessions)", shortName: "Sessions Bengaluru", level: "district", state: "KA", city: "Bengaluru", highCourtId: "hc-karnataka", focus: true },
  { id: "ka-blr-acmm", name: "Court of the Additional Chief Metropolitan Magistrate, Bengaluru", shortName: "ACMM Bengaluru", level: "district", state: "KA", city: "Bengaluru", highCourtId: "hc-karnataka", focus: true },
  { id: "ts-hyd-city-civil", name: "City Civil Court, Hyderabad", shortName: "CCC Hyderabad", level: "district", state: "TS", city: "Hyderabad", highCourtId: "hc-telangana", focus: true },
  { id: "ts-hyd-commercial", name: "Commercial Court, Hyderabad", shortName: "Com. Court Hyderabad", level: "district", state: "TS", city: "Hyderabad", highCourtId: "hc-telangana", focus: true },
  { id: "ts-hyd-sessions", name: "Metropolitan Sessions Court, Hyderabad", shortName: "Sessions Hyderabad", level: "district", state: "TS", city: "Hyderabad", highCourtId: "hc-telangana", focus: true },
  { id: "ts-hyd-mm", name: "Court of the Metropolitan Magistrate, Hyderabad", shortName: "MM Hyderabad", level: "district", state: "TS", city: "Hyderabad", highCourtId: "hc-telangana", focus: true },
];

export type ForumOrCourt = { kind: "court"; court: Court } | { kind: "forum"; forum: Forum };

export function forumById(id: string | null | undefined): Forum | null {
  return id ? SUBORDINATE_FORUMS.find((f) => f.id === id) ?? null : null;
}

/** Resolve a court id from the registry or the subordinate-forum list. Unknown ids return null (never the nearest court). */
export function resolveCourt(id: string | null | undefined): ForumOrCourt | null {
  const c = courtById(id);
  if (c) return { kind: "court", court: c };
  const f = forumById(id);
  return f ? { kind: "forum", forum: f } : null;
}

export function courtName(id: string | null | undefined): string | null {
  const r = resolveCourt(id);
  return r ? (r.kind === "court" ? r.court.name : r.forum.name) : null;
}

/** Picker options: focus High Courts and focus-city forums first, then the Supreme Court, then other High Courts. */
export function courtOptions(): { group: string; options: { id: string; label: string; hint?: string }[] }[] {
  const focusHc = FOCUS_COURT_IDS.map((id) => courtById(id)!).filter((c) => c.level === "high");
  return [
    { group: "Karnataka", options: [...focusHc.filter((c) => c.territory.includes("KA")), ...SUBORDINATE_FORUMS.filter((f) => f.state === "KA")].map(opt) },
    { group: "Telangana", options: [...focusHc.filter((c) => c.territory.includes("TS")), ...SUBORDINATE_FORUMS.filter((f) => f.state === "TS")].map(opt) },
    { group: "Andhra Pradesh", options: focusHc.filter((c) => c.territory.includes("AP")).map(opt) },
    { group: "Supreme Court", options: COURTS.filter((c) => c.level === "supreme").map(opt) },
    { group: "Other High Courts", options: COURTS.filter((c) => c.level === "high" && !c.focus).map(opt) },
  ].filter((g) => g.options.length);
}

function opt(c: Court | Forum) {
  return { id: c.id, label: c.name, hint: "seat" in c ? c.seat : c.city };
}

// ---------------------------------------------------------------------------
// Case types
// ---------------------------------------------------------------------------

/** Case type offered in the matter form: the registry's abbreviation and name (`src/lib/india/procedure.ts`). */
export interface CaseType { code: string; label: string; kind: CaseCategory | "commercial"; registry: boolean }

const fromRegistry = (t: RegistryCaseType): CaseType => ({ code: t.abbr, label: t.name, kind: t.category, registry: true });

/**
 * Case types used in focus-city subordinate forums that the registry does not code yet (commercial-court and
 * sessions/magistrate miscellaneous numbering). Kept here, labelled as local, until the registry carries them.
 */
const LOCAL_TYPES: Record<string, CaseType[]> = {
  commercial: [
    { code: "Com.O.S.", label: "Commercial Original Suit", kind: "commercial", registry: false },
    { code: "Com.A.P.", label: "Commercial arbitration petition (A&C Act s.34)", kind: "commercial", registry: false },
    { code: "Com.Ex.", label: "Commercial execution", kind: "commercial", registry: false },
  ],
  civil: [{ code: "Misc.", label: "Miscellaneous", kind: "civil", registry: false }],
  sessions: [{ code: "Crl.Misc.", label: "Criminal Miscellaneous (bail)", kind: "criminal", registry: false }],
  magistrate: [
    { code: "P.C.R.", label: "Private Complaint Register", kind: "criminal", registry: false },
    { code: "Crl.Misc.", label: "Criminal Miscellaneous", kind: "criminal", registry: false },
  ],
};

const SUBORDINATE_BY_FORUM: Record<string, { registry: string[]; local: keyof typeof LOCAL_TYPES }> = {
  "ka-blr-city-civil": { registry: ["os", "ep"], local: "civil" },
  "ts-hyd-city-civil": { registry: ["os", "ep", "as"], local: "civil" },
  "ka-blr-commercial": { registry: ["ep"], local: "commercial" },
  "ts-hyd-commercial": { registry: ["ep"], local: "commercial" },
  "ka-blr-sessions": { registry: ["sc-case", "crl-a", "crl-rp"], local: "sessions" },
  "ts-hyd-sessions": { registry: ["sc-case", "crl-a", "crl-rp"], local: "sessions" },
  "ka-blr-acmm": { registry: ["cc"], local: "magistrate" },
  "ts-hyd-mm": { registry: ["cc"], local: "magistrate" },
};

/** Case types for a court: registry types used in that court; for a subordinate forum, its registry types plus local ones. */
export function caseTypesFor(courtId: string | null | undefined): CaseType[] {
  if (!courtId) return [];
  const forum = SUBORDINATE_BY_FORUM[courtId];
  if (forum) {
    const local = LOCAL_TYPES[forum.local];
    const reg = forum.registry.map((id) => caseTypeById(id)).filter((t): t is RegistryCaseType => !!t).map(fromRegistry);
    return [...(forum.local === "commercial" ? local : []), ...reg, ...(forum.local === "commercial" ? [] : local)];
  }
  return CASE_TYPES.filter((t) => t.usedIn.includes(courtId)).map(fromRegistry);
}

/** "O.S. No. 4521 of 2022" — the registry's canonical form when the type is coded, else the same shape. */
export function formatCaseNumber(type: string | undefined, number: string | number | undefined, year: number | string | undefined): string {
  if (!type || !number) return "";
  const t = resolveCaseType(type);
  if (t && year && Number(year) && Number(number)) return registryFormatCaseNumber(t, Number(number), Number(year));
  return `${type} No. ${number}${year ? ` of ${year}` : ""}`;
}

/** Parse "O.S. No. 4521 of 2022", "W.P. No.18234/2024", "Com.O.S. 1187 of 2023". Null when the text is not a case number. */
export function parseCaseNumber(raw: string): { type: string; number: string; year?: number; subject?: string } | null {
  const reg = registryParseCaseNumber(raw);
  if (reg) return { type: reg.caseType.abbr, number: String(reg.number), year: reg.year, ...(reg.subject ? { subject: reg.subject } : {}) };
  const m = raw.trim().match(/^((?:Com|Crl)\.?\s*[A-Za-z][A-Za-z.() ]{0,16}?|P\.C\.R\.|Misc\.)\s*(?:No\.?\s*)?(\d{1,7})\s*(?:(?:of|\/)\s*((?:19|20)\d{2}))?$/i);
  if (!m) return null;
  return { type: m[1].trim(), number: m[2], ...(m[3] ? { year: Number(m[3]) } : {}) };
}

// ---------------------------------------------------------------------------
// CNR (eCourts Case Number Record)
// ---------------------------------------------------------------------------

/**
 * CNR: 16 characters — a 4-letter establishment prefix (State + court/district code, e.g. "KAHC"), a 2-digit
 * establishment number, a 6-digit case serial and the 4-digit filing year ("KAHC010123452024"). The prefix is checked
 * against the registry when the court has one; a mismatch is reported, never corrected.
 */
export function validateCnr(raw: string, courtId?: string | null): { ok: true; cnr: string; year: number; warning?: string } | { ok: false; error: string } {
  const cnr = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{4}\d{12}$/.test(cnr)) return { ok: false, error: "A CNR has 16 characters: 4 letters then 12 digits (e.g. KAHC010123452024)." };
  const year = Number(cnr.slice(12));
  if (year < 1950 || year > new Date().getUTCFullYear() + 1) return { ok: false, error: `The CNR's filing year ${year} is not plausible.` };
  const prefix = courtId ? courtById(courtId)?.cnrPrefix : undefined;
  if (prefix && !cnr.startsWith(prefix)) return { ok: true, cnr, year, warning: `CNR prefix ${cnr.slice(0, 4)} does not match ${courtById(courtId)!.shortName} (${prefix}).` };
  const forum = forumById(courtId);
  if (forum && !cnr.startsWith(forum.state === "TS" ? "T" : forum.state)) return { ok: true, cnr, year, warning: `CNR prefix ${cnr.slice(0, 4)} does not look like a ${forum.state === "TS" ? "Telangana" : "Karnataka"} establishment.` };
  return { ok: true, cnr, year };
}

// ---------------------------------------------------------------------------
// Hearings and cause list
// ---------------------------------------------------------------------------

export type CauseListStatus = "listed" | "not_listed" | "adjourned" | "part_heard" | "reserved" | "disposed" | "unknown";

export const CAUSE_LIST_STATUSES: { id: CauseListStatus; label: string }[] = [
  { id: "listed", label: "Listed" },
  { id: "not_listed", label: "Not listed" },
  { id: "adjourned", label: "Adjourned" },
  { id: "part_heard", label: "Part-heard" },
  { id: "reserved", label: "Reserved for orders" },
  { id: "disposed", label: "Disposed" },
  { id: "unknown", label: "Not checked" },
];

export function causeListLabel(s: CauseListStatus | undefined): string {
  return CAUSE_LIST_STATUSES.find((x) => x.id === s)?.label ?? "Not checked";
}

/** Stage suggestions for Indian civil and criminal matters, from the procedure registry (the field stays free text). */
export const INDIA_STAGES: string[] = Array.from(new Set([...CIVIL_SUIT_STAGES.map((s) => s.label), "Interlocutory applications", "Bail", ...CRIMINAL_TRIAL_STAGES.map((s) => s.label)]));

/** Case particulars stored on a matter (`india` on the matter record). */
export interface IndianCaseInfo {
  /** Registry court id ("hc-karnataka") or subordinate forum id ("ka-blr-commercial"). */
  courtId?: string;
  benchId?: string;
  caseType?: string;
  caseNumber?: string;
  caseYear?: number;
  cnr?: string;
  /** Court hall / court number ("Court Hall 12", "CCH-85"). */
  courtHall?: string;
  nextHearing?: string;
  lastHearing?: string;
  /** Purpose of the next hearing ("Cross-examination of DW-1"). */
  hearingPurpose?: string;
  causeList?: { status: CauseListStatus; item?: number; listDate?: string; checkedAt?: string; source?: "manual" | "ecourts" };
  /** Offence date for criminal matters: decides IPC/CrPC vs BNS/BNSS (the transition is 1 July 2024). */
  offenceDate?: string;
}

/** Display label for the case particulars ("Com.O.S. No. 1187 of 2023 · Commercial Court, Bengaluru"). */
export function caseTitle(info: IndianCaseInfo | undefined): string {
  if (!info) return "";
  const n = formatCaseNumber(info.caseType, info.caseNumber, info.caseYear);
  const c = courtName(info.courtId);
  return [n, c].filter(Boolean).join(" · ");
}

/**
 * Which substantive criminal code governs an offence (deterministic): IPC for offences committed before 1 July 2024,
 * BNS on or after. Procedure follows the date proceedings were instituted (BNSS s.531 saves pending CrPC
 * proceedings), so it is returned only when that date is known.
 */
export function criminalCodesFor(offenceDate: string | undefined, proceedingsFrom?: string): { substantive: "IPC" | "BNS"; procedure?: "CrPC" | "BNSS" } | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!offenceDate || !iso.test(offenceDate)) return null;
  const substantive = offenceDate < "2024-07-01" ? "IPC" : "BNS";
  if (!proceedingsFrom || !iso.test(proceedingsFrom)) return { substantive };
  return { substantive, procedure: proceedingsFrom < "2024-07-01" ? "CrPC" : "BNSS" };
}
