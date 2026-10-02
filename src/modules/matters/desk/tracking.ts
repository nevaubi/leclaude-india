/**
 * Tracked case identifiers (client-safe, deterministic): validation and normalization through the official-sources
 * case-number contract (`src/modules/official/case-numbers.ts`). An identifier that does not normalize is rejected with
 * the reason; nothing is guessed (no inferred type, number or year, no "closest" forum).
 */
import { COURTS } from "@/lib/india/courts";
import { caseNumberKeys, isCaseKey, isDiaryKey, normalizeCaseNumber, normalizeDiaryNo, qualifiedCaseKey } from "@/modules/official/case-numbers";
import { caseKeyBindable, expandForum, forumFamily, forumMatches } from "@/modules/official/causelist/forums";
import { formatCaseNumber, validateCnr, type IndianCaseInfo } from "../india";
import type { CauseListEntry, MatterCaseIdentifier, TrackedIdentifier, TrackedIdentifierKind } from "./types";

export const MAX_IDENTIFIERS = 12;
export const MAX_ADVOCATE_NAMES = 8;
const FORUM_RE = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * Forums whose cause lists the official-sources pipeline parses (sci-causelist, dhc-causelist, nclt, nclat). A tracked
 * forum outside this list gets no automatic listings; manual hearings and the court's own pages apply there.
 * "nclt" covers bench keys such as "nclt-mumbai".
 */
export const PARSED_LIST_FORUMS: readonly string[] = ["sci", "hc-delhi", "nclt", "nclat"];

export function forumHasParsedLists(forum: string): boolean {
  return PARSED_LIST_FORUMS.some((f) => forum === f || forum.startsWith(`${f}-`));
}

export interface ForumOption { id: string; label: string; parsed: boolean }

const TRIBUNALS: { id: string; label: string }[] = [
  // NCLT numbers repeat at every bench: the bench code printed in the number ("(MB)") is part of the tracked key.
  { id: "nclt", label: "National Company Law Tribunal (bench from the case number)" },
  { id: "nclat", label: "National Company Law Appellate Tribunal" },
];

/** Forum keys offered when adding an identifier: the Supreme Court, the High Courts (registry ids) and NCLT / NCLAT. */
export function trackingForumOptions(): ForumOption[] {
  const courts = COURTS.filter((c) => c.level === "supreme" || c.level === "high").map((c) => ({ id: c.id, label: c.name }));
  return [...courts, ...TRIBUNALS].map((o) => ({ ...o, parsed: forumHasParsedLists(o.id) }));
}

export function forumLabel(forum: string): string {
  return trackingForumOptions().find((o) => o.id === forum)?.label ?? (forum.startsWith("nclt-") ? `NCLT ${forum.slice(5).replace(/-/g, " ")}` : forum);
}

/** Compact forum label for dense rows ("Kar HC", "SC", "NCLT Mumbai"); the key itself when unknown. */
export function forumShortLabel(forum: string): string {
  const c = COURTS.find((x) => x.id === forum);
  if (c) return c.shortName;
  if (forum === "nclt") return "NCLT";
  if (forum === "nclat") return "NCLAT";
  if (forum.startsWith("nclt-")) return `NCLT ${forum.slice(5).replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase())}`;
  return forum;
}

export type IdentifierResult = { ok: true; identifier: TrackedIdentifier } | { ok: false; error: string };

/** Validate and normalize one identifier. The printed form is kept; the value is the normalized key used for matching. */
export function normalizeIdentifier(raw: { forum?: unknown; kind?: unknown; value?: unknown; printed?: unknown }): IdentifierResult {
  const forum = typeof raw.forum === "string" ? raw.forum.trim().toLowerCase() : "";
  if (!FORUM_RE.test(forum)) return { ok: false, error: "Choose the court or tribunal for this identifier." };
  const kind = raw.kind as TrackedIdentifierKind;
  if (kind !== "case_number" && kind !== "diary_no" && kind !== "cnr") return { ok: false, error: "Identifier kind must be case number, diary number or CNR." };
  const printedRaw = typeof raw.printed === "string" && raw.printed.trim() ? raw.printed : typeof raw.value === "string" ? raw.value : "";
  const printed = printedRaw.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!printed) return { ok: false, error: "Enter the identifier as the court prints it." };
  if (kind === "case_number") {
    const n = normalizeCaseNumber(printed);
    if (!n) return { ok: false, error: `"${printed}" is not a single recognisable case number. Enter it as printed, e.g. "SLP(C) No. 1234/2026" or "W.P.(C)-5812/2016".` };
    if (forumFamily(forum) === "nclt") {
      // The same NCLT number exists at every bench: only the bench-qualified key ("CPIB/29/2022@MB") identifies one case.
      const q = qualifiedCaseKey(n);
      if (!q) return { ok: false, error: `"${printed}" has no bench code. NCLT numbers repeat at every bench: enter the number with the bench code as printed, e.g. "CP(IB)/29(MB)2022".` };
      return { ok: true, identifier: { forum, kind, value: q, printed } };
    }
    return { ok: true, identifier: { forum, kind, value: n.key, printed } };
  }
  if (kind === "diary_no") {
    if (forum !== "sci") return { ok: false, error: "Diary numbers are Supreme Court identifiers; choose the Supreme Court." };
    const d = normalizeDiaryNo(printed);
    if (!d || !/^\s*(?:Diary\s*No\.?\s*)?\d{1,7}\s*[-/]\s*(?:19|20)\d{2}\s*$/i.test(printed)) return { ok: false, error: `"${printed}" is not a diary number. Enter it as "54583/2026" or "Diary No. 54583-2026".` };
    return { ok: true, identifier: { forum, kind, value: d, printed } };
  }
  const v = validateCnr(printed);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, identifier: { forum, kind, value: v.cnr, printed } };
}

export type TrackingInputResult =
  | { ok: true; identifiers: TrackedIdentifier[] }
  | { ok: false; error: string; field: string };

/** Validate a whole PUT body. Duplicates (same forum, kind and value) collapse to one. */
export function validateTrackingInput(body: Record<string, unknown>): TrackingInputResult {
  const rawIds = body.identifiers;
  if (!Array.isArray(rawIds)) return { ok: false, error: "identifiers must be a list.", field: "identifiers" };
  if (rawIds.length > MAX_IDENTIFIERS) return { ok: false, error: `Track at most ${MAX_IDENTIFIERS} identifiers per matter.`, field: "identifiers" };
  const out: TrackedIdentifier[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawIds.length; i++) {
    const r = rawIds[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "Each identifier must be an object.", field: `identifiers.${i}` };
    const res = normalizeIdentifier(r as Record<string, unknown>);
    if (!res.ok) return { ok: false, error: res.error, field: `identifiers.${i}` };
    const key = `${res.identifier.forum}|${res.identifier.kind}|${res.identifier.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(res.identifier);
  }
  return { ok: true, identifiers: out };
}

/**
 * Whether the official sources can match an identifier at all (mirrors the facade's own rules): a case number or a
 * diary number with a known forum. CNRs are not printed in cause lists or in order metadata, and an NCLT number without
 * its bench code never binds, so neither is looked up; both are reported as not checkable.
 */
export function identifierCheckable(i: MatterCaseIdentifier): boolean {
  const forums = expandForum(i.forum);
  if (!forums.length) return false;
  if (i.kind === "case_number") return isCaseKey(i.value) && !(forums.includes("nclt") && !i.value.includes("@"));
  if (i.kind === "diary_no") return isDiaryKey(i.value);
  return false;
}

/**
 * Defence in depth on a facade match: it names one of the matter's own identifiers, the forums are compatible, and the
 * entry's own printed numbers (or diary number) carry that exact key. Anything else is dropped, never shown.
 */
export function listingMatchHolds(match: { entry: CauseListEntry; matchedOn: MatterCaseIdentifier }, own: MatterCaseIdentifier[]): boolean {
  const on = match.matchedOn;
  if (!own.some((i) => i.forum === on.forum && i.kind === on.kind && i.value === on.value) || !identifierCheckable(on)) return false;
  if (on.kind === "case_number") return caseKeyBindable(on.forum, on.value, match.entry.forum) && match.entry.caseNumbers.some((c) => caseNumberKeys(c.printed).includes(on.value));
  return on.kind === "diary_no" && match.entry.diaryNo === on.value && forumMatches(on.forum, match.entry.forum);
}

/** Advocate names for exact list matching: 2–80 characters with at least two letters; case-insensitive duplicates collapse. */
export function normalizeAdvocateNames(raw: unknown[]): { ok: true; names: string[] } | { ok: false; error: string } {
  if (raw.length > MAX_ADVOCATE_NAMES) return { ok: false, error: `Save at most ${MAX_ADVOCATE_NAMES} advocate names.` };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") return { ok: false, error: "Advocate names must be text." };
    const name = v.replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (name.length > 80 || (name.match(/\p{L}/gu) ?? []).length < 2) return { ok: false, error: `"${name.slice(0, 40)}" is not a usable advocate name.` };
    const key = advocateKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return { ok: true, names: out };
}

/** Upper-case tokens of a name ("Siddharth Panda" → ["SIDDHARTH", "PANDA"]); punctuation separates tokens. */
export function advocateTokens(name: string): string[] {
  return name.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function advocateKey(name: string): string {
  return advocateTokens(name).join(" ");
}

/** Courtesy titles printed before a name ("MR.", "SMT.") and annotations after it ("(AOR 1234)", "[R-1]"). */
const TITLE_TOKENS = new Set(["MR", "MS", "MRS", "DR", "SH", "SHRI", "SMT", "KUM", "KUMARI"]);

function nameTokens(name: string): string[] {
  let s = name.trim();
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/\s*[([][^()[\]]*[)\]]\s*$/u, "").trim(); }
  const t = advocateTokens(s);
  while (t.length > 1 && TITLE_TOKENS.has(t[0])) t.shift();
  return t;
}

/**
 * Whole-name match of a saved name against a printed advocate entry: the same tokens in the same order, after dropping
 * courtesy titles and trailing bracketed annotations ("Siddharth Panda" matches "MR. SIDDHARTH PANDA (AOR 1234)").
 * A part of a name never matches ("Kumar" does not match "RAJESH KUMAR"). Never fuzzy.
 */
export function advocateMatches(name: string, printed: string): boolean {
  const want = nameTokens(name);
  const have = nameTokens(printed);
  return want.length > 0 && want.length === have.length && want.every((t, i) => have[i] === t);
}

/**
 * Identifiers implied by a matter's case particulars, offered as a prefill the user confirms (never saved silently).
 * Only particulars that normalize are offered; a CNR is offered as a CNR.
 */
export function suggestIdentifiers(india: IndianCaseInfo | undefined): TrackedIdentifier[] {
  if (!india?.courtId) return [];
  const forum = india.courtId;
  if (!FORUM_RE.test(forum)) return [];
  const out: TrackedIdentifier[] = [];
  const printed = formatCaseNumber(india.caseType, india.caseNumber, india.caseYear);
  if (printed) {
    const r = normalizeIdentifier({ forum, kind: "case_number", printed });
    if (r.ok) out.push(r.identifier);
  }
  if (india.cnr) {
    const r = normalizeIdentifier({ forum, kind: "cnr", printed: india.cnr });
    if (r.ok) out.push(r.identifier);
  }
  return out;
}
