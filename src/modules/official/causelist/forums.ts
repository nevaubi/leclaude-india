/**
 * Cause-list forum keys (client-safe).
 *
 * Entries and calendars are stored per forum key:
 *   "sci"                 Supreme Court of India
 *   "hc-delhi", "hc-karnataka", ...   High Courts (registry court ids, src/lib/india/courts)
 *   "nclt-<bench>"        NCLT benches ("nclt-indore", "nclt-mumbai", "nclt-new-delhi", "nclt-principal", ...)
 *   "nclat-delhi", "nclat-chennai"    NCLAT Principal Bench (New Delhi) and Chennai Bench
 *   "nclt", "nclat"       family roots: tribunal-wide documents (calendars) and lists whose bench is not printed
 *
 * Matching is exact: an identifier's forum matches an entry's forum when they are equal, or when the identifier names
 * a family root ("nclt") and the entry belongs to that family ("nclt-indore"). NCLT case numbers repeat at every bench
 * ("CP(IB)/29(MP)2022" exists at Indore, "CP(IB)/29(MB)2022" at Mumbai), so a family-root identifier only matches NCLT
 * entries through a bench-qualified key ("CPIB/29/2022@MP"); an unqualified key needs the bench forum.
 */

export const FAMILY_ROOTS = new Set(["nclt", "nclat"]);

/** Forum ids used elsewhere in the app (forum directory, court registry) → cause-list forum keys. */
const ALIASES: Record<string, string[]> = {
  sc: ["sci"],
  "supreme-court": ["sci"],
  "delhi-hc": ["hc-delhi"],
  "bengaluru-hc": ["hc-karnataka"],
  "delhi-nclt": ["nclt-principal", "nclt-new-delhi"],
  "delhi-nclat": ["nclat-delhi"],
  "chennai-nclat": ["nclat-chennai"],
};

const FORUM_RE = /^[a-z][a-z0-9-]{1,40}$/;

export function isForumKey(v: unknown): v is string {
  return typeof v === "string" && FORUM_RE.test(v);
}

/** Forum keys an identifier's forum stands for (aliases resolved); [] for an invalid value. */
export function expandForum(forum: string): string[] {
  const f = forum.trim().toLowerCase();
  if (!isForumKey(f)) return [];
  return ALIASES[f] ?? [f];
}

export function forumFamily(forum: string): string {
  const i = forum.indexOf("-");
  const root = i > 0 ? forum.slice(0, i) : forum;
  return FAMILY_ROOTS.has(root) ? root : forum;
}

/** Exact forum compatibility (see the module comment). */
export function forumMatches(identForum: string, entryForum: string): boolean {
  return expandForum(identForum).some((f) => entryForum === f || (FAMILY_ROOTS.has(f) && entryForum.startsWith(`${f}-`)));
}

/**
 * Whether an exact case-key match between an identifier and an entry may bind them. NCLT numbers are bench-local, so
 * an unqualified key with a family-root forum is ambiguous and never binds.
 */
export function caseKeyBindable(identForum: string, key: string, entryForum: string): boolean {
  if (!forumMatches(identForum, entryForum)) return false;
  if (forumFamily(entryForum) === "nclt" && !key.includes("@")) {
    return expandForum(identForum).every((f) => f !== "nclt");
  }
  return true;
}

/** SQL fragment + params for a forum filter (exact key, or family prefix for "nclt"/"nclat"). */
export function forumFilterSql(forum: string, column: string, params: unknown[]): string | null {
  const fs = expandForum(forum);
  if (!fs.length) return null;
  const parts: string[] = [];
  for (const f of fs) {
    params.push(f);
    parts.push(`${column} = $${params.length}`);
    if (FAMILY_ROOTS.has(f)) {
      params.push(`${f}-%`);
      parts.push(`${column} LIKE $${params.length}`);
    }
  }
  return `(${parts.join(" OR ")})`;
}

export interface NcltBench {
  id: number;
  label: string;
  forum: string;
  court: string | null;
}

/** NCLT /all-cause-list bench filter ids (field_nclt_benches_list_target_id), as listed on 2026-10-02. */
export const NCLT_BENCHES: NcltBench[] = [
  { id: 88, label: "Ahmedabad-I", forum: "nclt-ahmedabad", court: "I" },
  { id: 89, label: "Ahmedabad-II", forum: "nclt-ahmedabad", court: "II" },
  { id: 90, label: "Allahabad", forum: "nclt-allahabad", court: null },
  { id: 91, label: "Amaravati", forum: "nclt-amaravati", court: null },
  { id: 92, label: "Bengaluru", forum: "nclt-bengaluru", court: null },
  { id: 93, label: "Chandigarh-I", forum: "nclt-chandigarh", court: "I" },
  { id: 137, label: "Chandigarh-II", forum: "nclt-chandigarh", court: "II" },
  { id: 94, label: "Chennai-I", forum: "nclt-chennai", court: "I" },
  { id: 95, label: "Chennai-II", forum: "nclt-chennai", court: "II" },
  { id: 96, label: "Cuttack", forum: "nclt-cuttack", court: null },
  { id: 97, label: "Guwahati", forum: "nclt-guwahati", court: null },
  { id: 98, label: "Hyderabad-I", forum: "nclt-hyderabad", court: "I" },
  { id: 99, label: "Hyderabad-II", forum: "nclt-hyderabad", court: "II" },
  { id: 100, label: "Indore", forum: "nclt-indore", court: null },
  { id: 101, label: "Jaipur", forum: "nclt-jaipur", court: null },
  { id: 102, label: "Kochi", forum: "nclt-kochi", court: null },
  { id: 104, label: "Kolkata-I", forum: "nclt-kolkata", court: "I" },
  { id: 138, label: "Kolkata-I", forum: "nclt-kolkata", court: "I" },
  { id: 103, label: "Kolkata-II", forum: "nclt-kolkata", court: "II" },
  { id: 139, label: "Kolkata-3", forum: "nclt-kolkata", court: "III" },
  { id: 105, label: "Mumbai-I", forum: "nclt-mumbai", court: "I" },
  { id: 106, label: "Mumbai-II", forum: "nclt-mumbai", court: "II" },
  { id: 107, label: "Mumbai-III", forum: "nclt-mumbai", court: "III" },
  { id: 108, label: "Mumbai-IV", forum: "nclt-mumbai", court: "IV" },
  { id: 109, label: "Mumbai-V", forum: "nclt-mumbai", court: "V" },
  { id: 128, label: "Mumbai-VI", forum: "nclt-mumbai", court: "VI" },
  { id: 110, label: "New Delhi-II", forum: "nclt-new-delhi", court: "II" },
  { id: 111, label: "New Delhi-III", forum: "nclt-new-delhi", court: "III" },
  { id: 112, label: "New Delhi-IV", forum: "nclt-new-delhi", court: "IV" },
  { id: 113, label: "New Delhi-V", forum: "nclt-new-delhi", court: "V" },
  { id: 114, label: "New Delhi-VI", forum: "nclt-new-delhi", court: "VI" },
  { id: 115, label: "Principal Bench", forum: "nclt-principal", court: null },
  // The registrar's list does not say which bench it belongs to: it stays on the family root.
  { id: 116, label: "Registrar", forum: "nclt", court: "Registrar" },
];

export interface NclatCourt {
  id: number;
  label: string;
  forum: string;
  court: string;
}

/** NCLAT /daily-cause-list court filter ids (field_court_name_target_id), as listed on 2026-10-02. */
export const NCLAT_COURTS: NclatCourt[] = [
  { id: 42, label: "Chairperson Court", forum: "nclat-delhi", court: "Chairperson" },
  { id: 44, label: "Court-2", forum: "nclat-delhi", court: "II" },
  { id: 45, label: "Court-3", forum: "nclat-delhi", court: "III" },
  { id: 46, label: "Court-4", forum: "nclat-delhi", court: "IV" },
  { id: 47, label: "Registrar Court", forum: "nclat-delhi", court: "Registrar" },
  { id: 43, label: "Chennai Bench", forum: "nclat-chennai", court: "Chennai" },
];
