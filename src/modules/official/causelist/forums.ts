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
 *   "hc", "drt", "drat", "other"      ambiguous multi-court roots (IBBI mirrors orders of "High Courts", "DRTs",
 *                                     "DRATs" and "other courts" under one heading): which court is not known
 *
 * Matching is exact: an identifier's forum matches an entry's forum when they are equal, or when the identifier names
 * a family root ("nclt") and the entry belongs to that family ("nclt-indore"). NCLT case numbers repeat at every bench
 * ("CP(IB)/29(MP)2022" exists at Indore, "CP(IB)/29(MB)2022" at Mumbai), so a family-root identifier only matches NCLT
 * entries through a bench-qualified key ("CPIB/29/2022@MP"); an unqualified key needs exactly the bench forum, and never
 * binds an entry whose printed number carries a bench code ("CPIB/29/2022@MB" in its keys) — only the identifier
 * qualified with that same code does. Ambiguous roots never bind, on either side: "WPC/1234/2020" exists at every
 * High Court.
 */

/** Tribunal families whose benches are separate forums ("nclt-indore"); the root holds tribunal-wide documents. */
export const FAMILY_ROOTS = new Set(["nclt", "nclat"]);

/** Multi-court roots that do not say which court: an identifier or document there never binds on its own. */
export const AMBIGUOUS_ROOTS = new Set(["hc", "drt", "drat", "other"]);

/**
 * meta.caseKeysScope of an order whose meta.caseKeys hold only its caption's numbers (NCLAT orders read from page 1:
 * numbers cited in the body are kept as meta.mentionedCaseKeys and never bind).
 */
export const CAPTION_SCOPE = "caption";

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

/** Exact forum compatibility (see the module comment). Ambiguous roots match nothing, on either side. */
export function forumMatches(identForum: string, entryForum: string): boolean {
  if (AMBIGUOUS_ROOTS.has(entryForum)) return false;
  return expandForum(identForum).some((f) => !AMBIGUOUS_ROOTS.has(f) && (entryForum === f || (FAMILY_ROOTS.has(f) && entryForum.startsWith(`${f}-`))));
}

/** True when `keys` holds a bench-qualified form of the unqualified `key` ("CPIB/29/2022@MB" for "CPIB/29/2022"). */
export function hasQualifiedVariant(keys: Iterable<string>, key: string): boolean {
  if (key.includes("@")) return false;
  const prefix = `${key}@`;
  for (const k of keys) if (k.startsWith(prefix)) return true;
  return false;
}

/**
 * Whether an unqualified NCLT key may bind an NCLT-family entry for this identifier forum: only when the identifier
 * names exactly that bench (not the family root, not an alias covering several benches, not the bench-less root list).
 */
function ncltBenchExact(identForum: string, entryForum: string): boolean {
  const fs = expandForum(identForum);
  return fs.length === 1 && fs[0] === entryForum && entryForum !== "nclt";
}

/**
 * Whether an exact case-key match between an identifier and an entry (or order) may bind them.
 * - The forums must match exactly (ambiguous roots never do).
 * - NCLT numbers are bench-local: an unqualified key binds an NCLT entry only when the identifier names that bench.
 * - When the entry's printed number carries a bench code (`entryKeys` holds key@X), an unqualified key never binds;
 *   only the identifier qualified with the same code (key@X, matched exactly) does.
 */
export function caseKeyBindable(identForum: string, key: string, entryForum: string, entryKeys?: Iterable<string>): boolean {
  if (!forumMatches(identForum, entryForum)) return false;
  if (key.includes("@")) return true;
  if (entryKeys && hasQualifiedVariant(entryKeys, key)) return false;
  if (forumFamily(entryForum) === "nclt") return ncltBenchExact(identForum, entryForum);
  return true;
}

/**
 * Whether an identifier can bind anything at all (used to skip identifiers before querying): its forum must name a
 * court (not an ambiguous root), and an unqualified key whose forum covers only the NCLT family needs a single bench.
 */
export function identifierCanBind(identForum: string, kind: string, value: string): boolean {
  const fs = expandForum(String(identForum ?? ""));
  if (!fs.length || fs.every((f) => AMBIGUOUS_ROOTS.has(f))) return false;
  if (kind === "case_number" && !value.includes("@") && fs.every((f) => forumFamily(f) === "nclt")) {
    return fs.length === 1 && fs[0] !== "nclt";
  }
  return true;
}

/**
 * For a listing query (`/api/official/causelists?case=`): whether an unqualified key may list NCLT-family entries. With
 * no forum, or a forum that is not exactly one bench, the same NCLT number at another bench would be listed: it may not.
 */
export function unqualifiedNcltListable(forum: string | null | undefined): boolean {
  if (!forum) return false;
  const fs = expandForum(forum);
  return fs.length === 1 && forumFamily(fs[0]) === "nclt" && fs[0] !== "nclt";
}

/** Listing-side counterpart of caseKeyBindable for a query with an optional forum filter. */
export function caseKeyListable(forum: string | null | undefined, key: string, entryForum: string, entryKeys: Iterable<string>): boolean {
  if (forum) return caseKeyBindable(forum, key, entryForum, entryKeys);
  if (key.includes("@")) return true;
  if (hasQualifiedVariant(entryKeys, key)) return false;
  return forumFamily(entryForum) !== "nclt";
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
