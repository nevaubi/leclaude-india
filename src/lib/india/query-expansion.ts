/**
 * Query expansion for Indian legal research (client-safe, deterministic; no model).
 *
 * A judgment written before 1 July 2024 says "Section 438 CrPC"; one written after says "Section 482 BNSS"; a lawyer
 * may type "s.482 BNSS", "u/s 438 Cr.P.C." or the full Act name. Full-text search ANDs its terms, so a query in one
 * vocabulary misses judgments written in the other. This module derives alternate retrieval queries:
 *
 *   1. criminal-code counterparts in both directions (IPC↔BNS, CrPC↔BNSS, IEA↔BSA) from the coded correspondence table
 *      (`mapSection`): a split section yields one variant per candidate; an unmapped section yields none (never a guess);
 *   2. Act short names ↔ full short titles from the statute registry ("NI Act" ↔ "Negotiable Instruments Act");
 *   3. citation-format variants ("(2014) 8 SCC 273" ↔ "2014 8 SCC 273"; "2024 INSC 735" ↔ "2024INSC735").
 *
 * Every variant is a separate query (never one giant OR): the lanes run them as separate retrieval calls and fuse the
 * results. The original query is always first.
 */
import { extractCitations } from "./citations";
import { mapSection, type CodeName } from "./criminal-code-map";
import { ACTS, extractStatutes, getAct, statuteKeys } from "./statutes";

export interface ExpansionNote {
  kind: "code_counterpart" | "act_name" | "citation_format";
  from: string;
  to: string;
  /** Correspondence status for code counterparts ("mapped" | "split"). */
  status?: string;
  confidence?: "high" | "medium";
}

export interface QueryExpansion {
  /** Original first, then variants (deduplicated, at most `max`). */
  queries: string[];
  notes: ExpansionNote[];
  /** Criminal-code sections detected in the query ("BNSS 482"), for filters and the transition note. */
  sections: { code: CodeName; section: string }[];
}

const CODE_BY_ACT: Record<string, CodeName> = { ipc: "IPC", crpc: "CrPC", iea: "IEA", bns: "BNS", bnss: "BNSS", bsa: "BSA" };
const ACT_BY_CODE: Record<CodeName, string> = { IPC: "ipc", CrPC: "crpc", IEA: "iea", BNS: "bns", BNSS: "bnss", BSA: "bsa" };

/** Bare "482 BNSS" / "438 CrPC" (no "section" word), which the statute parser does not take as a reference. */
const BARE_CODE_RE = /(?<![\w.(])(\d{1,3}[A-Z]{0,2}(?:\(\d{1,2}[a-z]?\))?)\s+(IPC|I\.P\.C\.|CrPC|Cr\.P\.C\.|BNSS|B\.N\.S\.S\.|BNS|B\.N\.S\.|BSA|B\.S\.A\.|IEA)(?![\w])/g;

function codeOfToken(t: string): CodeName | null {
  const k = t.replace(/\./g, "").toUpperCase();
  return k === "IPC" ? "IPC" : k === "CRPC" ? "CrPC" : k === "BNSS" ? "BNSS" : k === "BNS" ? "BNS" : k === "BSA" ? "BSA" : k === "IEA" ? "IEA" : null;
}

/** "Section 482 BNSS" style phrase for a code section (the form judgments print most often). */
export function sectionPhrase(code: CodeName, section: string): string {
  return `Section ${section} ${code}`;
}

/** Collapse whitespace; keep everything else (operators, quotes) as typed. */
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** Short Acts whose full title is worth searching too (the registry's abbreviations, unambiguous ones only). */
function actNameVariants(q: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const ref of extractStatutes(q)) {
    const act = getAct(ref.actId);
    if (!act || CODE_BY_ACT[act.id] || act.id === "constitution") continue;
    const written = ref.actText.trim();
    if (written.toLowerCase() === act.name.toLowerCase()) {
      if (act.abbr && act.abbr !== act.name) out.push({ from: written, to: act.abbr });
    } else out.push({ from: written, to: act.name });
  }
  // Abbreviations typed without a section ("NDPS bail", "POCSO"), unambiguous only (one Act per alias).
  for (const act of ACTS) {
    if (CODE_BY_ACT[act.id] || act.jurisdiction !== "central" || out.some((v) => v.to === act.name)) continue;
    // Abbreviation-like aliases ("NDPS", "POCSO Act", "IBC", "NI Act") that name exactly one Act in the registry.
    const shorts = [act.abbr, ...act.aliases].filter((a) => a !== act.name && /^[A-Z][A-Z&/.]{1,9}(?:\s+Act)?$/.test(a) && ACTS.filter((x) => x.aliases.includes(a) || x.abbr === a).length === 1);
    for (const a of Array.from(new Set(shorts)).sort((x, y) => y.length - x.length)) {
      const re = new RegExp(`(?<![\\w])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);
      const m = q.match(re);
      if (m) { out.push({ from: m[0], to: act.name }); break; }
    }
  }
  return out;
}

/**
 * Alternate retrieval queries for `query`. `max` bounds the list (default 4: the original plus three variants).
 * Pure; deterministic order: code counterparts, then Act names, then citation formats.
 */
export function expandIndianQuery(query: string, opts: { max?: number } = {}): QueryExpansion {
  const max = Math.max(1, opts.max ?? 4);
  const q = tidy(query);
  const notes: ExpansionNote[] = [];
  const sections: { code: CodeName; section: string }[] = [];
  const variants: string[] = [];
  if (!q) return { queries: [], notes, sections };

  // 1. Criminal-code counterparts (statute parser references, then bare "482 BNSS").
  const refs: { raw: string; code: CodeName; section: string }[] = [];
  for (const ref of extractStatutes(q)) {
    const code = ref.actId ? CODE_BY_ACT[ref.actId] : undefined;
    if (!code || ref.kind !== "section") continue;
    for (const s of ref.sections) refs.push({ raw: ref.raw, code, section: s });
  }
  for (const m of q.matchAll(BARE_CODE_RE)) {
    const code = codeOfToken(m[2]);
    if (code && !refs.some((r) => r.code === code && r.section === m[1])) refs.push({ raw: m[0], code, section: m[1] });
  }
  for (const r of refs) {
    if (!sections.some((s) => s.code === r.code && s.section === r.section)) sections.push({ code: r.code, section: r.section });
    const m = mapSection(r.code, r.section);
    if (m.status === "unmapped") continue;
    for (const c of m.candidates) {
      const to = sectionPhrase(c.code, c.section);
      // Replace only this reference (multi-section references keep their other sections in the original query).
      const variant = refs.filter((x) => x.raw === r.raw).length > 1 ? tidy(`${q} ${to}`) : tidy(q.replace(r.raw, to));
      variants.push(variant);
      notes.push({ kind: "code_counterpart", from: sectionPhrase(r.code, r.section), to, status: m.status, confidence: m.confidence });
    }
  }

  // 2. Act names ↔ abbreviations.
  for (const v of actNameVariants(q)) {
    variants.push(tidy(q.replace(v.from, v.to)));
    notes.push({ kind: "act_name", from: v.from, to: v.to });
  }

  // 3. Citation formats: the normalised form and a compact form for neutral citations.
  let cites: ReturnType<typeof extractCitations> = [];
  try { cites = extractCitations(q); } catch { cites = []; }
  for (const c of cites) {
    if ((c.kind !== "neutral" && c.kind !== "reporter") || !c.normalized) continue;
    const raw = c.raw.trim();
    const forms = new Set<string>([c.normalized]);
    if (c.kind === "reporter") forms.add(c.normalized.replace(/[()[\]]/g, "").replace(/\s+/g, " ").trim());
    if (/INSC/.test(c.normalized)) forms.add(c.normalized.replace(/\s+/g, ""));
    for (const f of forms) {
      if (f === raw) continue;
      variants.push(tidy(q.replace(raw, f)));
      notes.push({ kind: "citation_format", from: raw, to: f });
    }
  }

  const queries = Array.from(new Set([q, ...variants.filter((v) => v && v !== q)])).slice(0, max);
  return { queries, notes: notes.filter((n) => queries.some((x) => x.includes(n.to))), sections };
}

/** Corresponding sections for a set of code sections (both directions), for section filters. Unmapped → itself only. */
export function sectionFamily(code: CodeName, section: string): { code: CodeName; section: string }[] {
  const out = [{ code, section }];
  const m = mapSection(code, section);
  for (const c of m.candidates) if (!out.some((x) => x.code === c.code && x.section === c.section)) out.push({ code: c.code, section: c.section });
  return out;
}

/** Citator statute key ("BNSS 2023 s.482") for a code section; matches `statuteKeys` in statutes.ts. */
export function codeStatuteKey(code: CodeName, section: string): string {
  const act = getAct(ACT_BY_CODE[code])!;
  return `${act.abbr} ${act.year} s.${section}`;
}

/**
 * A statute-section filter ("s.482 BNSS", "Section 138 NI Act") as citator keys (with old/new code counterparts) and as
 * search phrases (used when the citator is not built). Unparseable input → no keys (the filter is reported as not applied).
 */
export function sectionFilter(input: string): { keys: string[]; phrases: string[] } {
  const keys: string[] = [];
  const phrases: string[] = [];
  const text = tidy(input);
  if (!text) return { keys, phrases };
  const add = (code: CodeName, section: string) => {
    for (const f of sectionFamily(code, section)) {
      const k = codeStatuteKey(f.code, f.section);
      if (!keys.includes(k)) keys.push(k);
      const p = sectionPhrase(f.code, f.section);
      if (!phrases.includes(p)) phrases.push(p);
    }
  };
  const refs = extractStatutes(/^\d/.test(text) ? `Section ${text}` : text);
  for (const ref of refs) {
    const code = ref.actId ? CODE_BY_ACT[ref.actId] : undefined;
    if (code && ref.kind === "section") { for (const s of ref.sections) add(code, s); continue; }
    for (const k of statuteKeys(ref)) if (!keys.includes(k)) keys.push(k);
    if (!phrases.includes(ref.raw)) phrases.push(ref.raw);
  }
  if (!refs.length) for (const m of text.matchAll(BARE_CODE_RE)) { const code = codeOfToken(m[2]); if (code) add(code, m[1]); }
  return { keys, phrases };
}
