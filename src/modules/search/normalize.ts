/**
 * Normalize raw toolkit results (CourtListener, eCFR, Federal Register,
 * GovInfo, library, e-discovery) into the unified SearchHit shape, plus
 * Bluebook-style citation formatting. Client-safe and fully unit-tested.
 */
import type { CodingDecision } from "@/lib/types/domain";
import { classifyAuthority, courtAbbreviation } from "./jurisdictions";
import { formatJudgmentCitation, formatStatuteHit, indianDate, shortJudgmentCite } from "./india-citations";
import type { SearchHit, SearchSource } from "./types";

// ---- raw shapes as returned by the toolkit execute() functions ---------------

export interface RawCaseLaw { case_name?: string; citations?: string[]; court?: string; court_id?: string; date_filed?: string; docket_number?: string; status?: string; cite_count?: number; judge?: string; snippet?: string; opinion_id?: number; cluster_id?: number; url?: string }
export interface RawDocket { case_name?: string; docket_number?: string; court?: string; court_id?: string; date_filed?: string; date_terminated?: string | null; assigned_to?: string; nature_of_suit?: string; cause?: string; parties?: string[]; attorneys?: string[]; docket_id?: number; url?: string }
export interface RawCfr { cite: string; title?: string; part?: string; section?: string; heading?: string; part_heading?: string; excerpt?: string; effective?: string; url: string }
export interface RawFr { title: string; type?: string; agencies?: (string | undefined)[]; published: string; citation?: string; effective_on?: string; comments_close_on?: string; document_number: string; docket_ids?: string[]; abstract?: string; url: string; pdf_url?: string }
export interface RawStatute { title?: string; package_id?: string; granule_id?: string; date?: string; collection?: string; teaser?: string; text_url?: string; pdf_url?: string; url?: string }
export interface RawLibrary { id: string; name: string; type: string; description?: string; tags?: string[]; practice_area?: string; office_doc_id?: string; passage: string; score: number }
export interface RawEdoc { id: string; bates: string; date: string; custodian: string; type: string; subject: string; from?: string; to?: string[]; passage: string; score: number; ai_score?: number; coding?: CodingDecision }

export interface NormalizeContext { jurisdiction: string; courts?: string }

const MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

export function bluebookDate(iso?: string) {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

export function yearOf(iso?: string) {
  return iso?.match(/^\d{4}/)?.[0] ?? "";
}

function clean(s?: string) {
  return (s ?? "").replace(/<\/?[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Prefer an official reporter over other parallel cites. */
export function preferredCitation(citations: string[] = []): string | undefined {
  if (!citations.length) return undefined;
  const rank = (c: string) => (/\bU\.S\.(\s|$)/.test(c) ? 0 : /\bF\.(2d|3d|4th)\b/.test(c) ? 1 : /\bF\. ?Supp\./.test(c) ? 2 : /\bS\. ?Ct\.(\s|$)/.test(c) ? 3 : /\bCal\. ?(5th|4th|App)/.test(c) ? 1 : /\bWL\b/.test(c) ? 8 : 5);
  return [...citations].sort((a, b) => rank(a) - rank(b))[0];
}

export function normalizeCaseLaw(raw: RawCaseLaw, ctx: NormalizeContext, index = 0): SearchHit {
  const cite = preferredCitation(raw.citations);
  const id = `caselaw:${raw.cluster_id ?? raw.opinion_id ?? index}`;
  const hit: SearchHit = {
    id,
    source: "caselaw",
    title: clean(raw.case_name) || "Untitled opinion",
    subtitle: [raw.court, raw.docket_number ? `No. ${raw.docket_number}` : ""].filter(Boolean).join(" · "),
    cite,
    citations: raw.citations ?? [],
    court: raw.court,
    courtId: raw.court_id,
    date: raw.date_filed,
    status: raw.status,
    citeCount: raw.cite_count,
    snippet: clean(raw.snippet),
    url: raw.url,
    judge: raw.judge,
    docketNumber: raw.docket_number,
    opinionId: raw.opinion_id,
    clusterId: raw.cluster_id,
    authority: classifyAuthority(raw.court_id, ctx.jurisdiction, ctx.courts),
    readRef: raw.opinion_id ? { kind: "opinion", id: raw.opinion_id } : raw.url ? { kind: "url", url: raw.url } : undefined,
  };
  return hit;
}

export function normalizeDocket(raw: RawDocket, ctx: NormalizeContext, index = 0): SearchHit {
  return {
    id: `dockets:${raw.docket_id ?? index}`,
    source: "dockets",
    title: clean(raw.case_name) || "Untitled docket",
    subtitle: [raw.court, raw.docket_number ? `No. ${raw.docket_number}` : ""].filter(Boolean).join(" · "),
    court: raw.court,
    courtId: raw.court_id,
    date: raw.date_filed,
    dateTerminated: raw.date_terminated ?? null,
    status: raw.date_terminated ? "Terminated" : "Open",
    snippet: [raw.nature_of_suit ? `NOS: ${raw.nature_of_suit}` : "", raw.cause ? `Cause: ${raw.cause}` : ""].filter(Boolean).join(" · "),
    url: raw.url,
    docketId: raw.docket_id,
    docketNumber: raw.docket_number,
    parties: raw.parties,
    attorneys: raw.attorneys,
    natureOfSuit: raw.nature_of_suit,
    cause: raw.cause,
    assignedTo: raw.assigned_to,
    authority: classifyAuthority(raw.court_id, ctx.jurisdiction, ctx.courts),
    readRef: raw.url ? { kind: "url", url: raw.url } : undefined,
  };
}

export function normalizeCfr(raw: RawCfr, index = 0): SearchHit {
  const title = raw.title ? parseInt(String(raw.title), 10) : undefined;
  return {
    id: `regulations:${raw.title ?? "t"}-${raw.section ?? raw.part ?? index}`,
    source: "regulations",
    title: raw.heading ? `${raw.cite} — ${clean(raw.heading)}` : raw.cite,
    subtitle: raw.part_heading ? `Part ${raw.part ?? ""} · ${clean(raw.part_heading)}` : `Title ${raw.title ?? ""}`,
    cite: raw.cite,
    date: raw.effective,
    snippet: clean(raw.excerpt),
    url: raw.url,
    cfr: { title: raw.title, part: raw.part, section: raw.section, heading: raw.heading, partHeading: raw.part_heading, effective: raw.effective },
    authority: "n/a",
    readRef: title && raw.section ? { kind: "cfr", title, section: raw.section } : { kind: "url", url: raw.url },
  };
}

export function normalizeFederalRegister(raw: RawFr, index = 0): SearchHit {
  const agencies = (raw.agencies ?? []).filter((a): a is string => Boolean(a));
  return {
    id: `federal_register:${raw.document_number ?? index}`,
    source: "federal_register",
    title: clean(raw.title),
    subtitle: [raw.type, agencies.join(", ")].filter(Boolean).join(" · "),
    cite: raw.citation,
    date: raw.published,
    status: raw.type,
    snippet: clean(raw.abstract),
    url: raw.url,
    fr: { documentNumber: raw.document_number, type: raw.type, agencies, effectiveOn: raw.effective_on, commentsCloseOn: raw.comments_close_on, docketIds: raw.docket_ids, pdfUrl: raw.pdf_url },
    authority: "n/a",
    readRef: raw.document_number ? { kind: "fr", id: raw.document_number } : { kind: "url", url: raw.url },
  };
}

export function normalizeStatute(raw: RawStatute, index = 0): SearchHit {
  const url = raw.text_url ?? raw.url ?? raw.pdf_url;
  return {
    id: `statutes:${raw.granule_id ?? raw.package_id ?? index}`,
    source: "statutes",
    title: clean(raw.title) || raw.granule_id || raw.package_id || "Statute",
    subtitle: [raw.collection, raw.package_id].filter(Boolean).join(" · "),
    cite: guessStatuteCite(raw.title),
    date: raw.date,
    snippet: clean(raw.teaser),
    url: raw.url ?? raw.pdf_url,
    statute: { packageId: raw.package_id, granuleId: raw.granule_id, collection: raw.collection, textUrl: raw.text_url, pdfUrl: raw.pdf_url },
    authority: "n/a",
    readRef: url ? { kind: "statute", url, id: raw.granule_id ?? raw.package_id } : undefined,
  };
}

/** "15 U.S.C. 2607" style cite from a GovInfo title such as "15 U.S.C. 2607 - Reporting and retention of information". */
export function guessStatuteCite(title?: string): string | undefined {
  if (!title) return undefined;
  const m = title.match(/(\d+)\s*U\.?S\.?C\.?\s*(?:§+\s*)?([\dA-Za-z\-–.]+(?:\([^)]*\))*)/);
  if (m) return `${m[1]} U.S.C. § ${m[2].replace(/\.$/, "")}`;
  const pl = title.match(/Public Law\s+(\d+)[-–](\d+)/i);
  if (pl) return `Pub. L. No. ${pl[1]}-${pl[2]}`;
  return undefined;
}

/** Keyword excerpts often start with the item's own name; strip it so the card does not repeat the title. */
function trimTitleFromSnippet(title: string, snippet: string) {
  const t = clean(title), s = clean(snippet).replace(/^…/, "");
  if (t && s.toLowerCase().startsWith(t.toLowerCase())) return s.slice(t.length).replace(/^[\s—–:.\-]+/, "").trim();
  return s;
}

export function normalizeLibrary(raw: RawLibrary): SearchHit {
  return {
    id: `library:${raw.id}`,
    source: "library",
    title: raw.name,
    subtitle: [raw.type.toUpperCase(), raw.practice_area].filter(Boolean).join(" · "),
    snippet: trimTitleFromSnippet(raw.name, raw.passage) || clean(raw.description),
    score: raw.score,
    library: { type: raw.type, tags: raw.tags, practiceArea: raw.practice_area, officeDocId: raw.office_doc_id, description: raw.description },
    authority: "n/a",
    readRef: { kind: "library", id: raw.id },
    url: raw.office_doc_id ? `/office/${officeKindFor(raw.type)}/${raw.office_doc_id}` : `/library?item=${raw.id}`,
  };
}

function officeKindFor(type: string) {
  return type === "xlsx" ? "sheet" : type === "pptx" ? "slides" : type === "pdf" ? "pdf" : "word";
}

export function normalizeEdoc(raw: RawEdoc): SearchHit {
  return {
    id: `ediscovery:${raw.id}`,
    source: "ediscovery",
    title: raw.subject,
    subtitle: `${raw.bates} · ${raw.custodian} · ${raw.type}`,
    cite: raw.bates,
    date: raw.date,
    snippet: clean(raw.passage),
    score: raw.score,
    edoc: { bates: raw.bates, custodian: raw.custodian, type: raw.type, from: raw.from, to: raw.to, aiScore: raw.ai_score, coding: raw.coding },
    authority: "n/a",
    readRef: { kind: "edoc", id: raw.id },
    url: `/ediscovery?doc=${raw.id}`,
  };
}

// ---- India: judgments (SC/HC corpus, Indian Kanoon) and India Code sections ------------------

/** Row shape returned by search_judgments (src/lib/ai/toolkit/india.ts judgmentRow). */
export interface RawJudgment { source: string; title: string; content?: string[]; id: string; court?: string; court_id?: string | null; unresolved_court?: string; bench_id?: string; bench_strength?: number; decided?: string; neutral_citation?: string; reporter_citations?: string[]; judges?: string[]; case_number?: string; case_type?: string; language?: string; translations?: { language: string; origin: string }[]; statutes?: string[]; treatment?: unknown; case_name?: string; url?: string; provider?: string; score?: number }

/** Row shape returned by search_statutes (India Code). */
export interface RawIndiaSection { source: string; title: string; content?: string[]; id: string; enactment?: string; section?: string; heading?: string; replaced_by?: string; in_force_from?: string; url?: string; year?: number }

export function normalizeJudgment(raw: RawJudgment, ctx: NormalizeContext): SearchHit {
  const courtId = raw.court_id ?? null;
  const treatment = Array.isArray(raw.treatment) ? (raw.treatment as { status: string; by?: string; note?: string }[]) : undefined;
  return {
    id: `judgment:${raw.id}`,
    source: "caselaw",
    title: clean(raw.case_name ?? raw.title) || "Untitled judgment",
    subtitle: [raw.court, raw.case_number, raw.bench_strength ? `${raw.bench_strength}-judge bench` : ""].filter(Boolean).join(" · "),
    cite: raw.neutral_citation ?? raw.reporter_citations?.[0],
    citations: [raw.neutral_citation, ...(raw.reporter_citations ?? [])].filter((x): x is string => Boolean(x)),
    court: raw.court,
    courtId: courtId ?? undefined,
    date: raw.decided,
    snippet: clean((raw.content ?? []).join(" ")).slice(0, 600),
    url: raw.url,
    score: raw.score,
    judge: raw.judges?.join(", "),
    docketNumber: raw.case_number,
    authority: classifyAuthority(courtId, ctx.jurisdiction, ctx.courts, raw.decided),
    readRef: { kind: "judgment", id: raw.id },
    india: { judgmentId: raw.id, courtId, unresolvedCourt: raw.unresolved_court, benchId: raw.bench_id, benchStrength: raw.bench_strength, judges: raw.judges, neutralCitation: raw.neutral_citation, reporterCitations: raw.reporter_citations, caseNumber: raw.case_number, caseType: raw.case_type, language: raw.language, translations: raw.translations, statutes: raw.statutes, corpusTreatment: treatment?.length ? treatment : undefined, provider: raw.provider },
  };
}

export function normalizeIndiaSection(raw: RawIndiaSection): SearchHit {
  return {
    id: `section:${raw.id}`,
    source: "statutes",
    title: raw.title,
    subtitle: [raw.enactment, raw.replaced_by ? `replaced by ${raw.replaced_by}` : ""].filter(Boolean).join(" · "),
    cite: raw.enactment && raw.section ? `${raw.enactment}, s. ${raw.section}` : raw.title,
    date: raw.in_force_from,
    snippet: clean((raw.content ?? []).join(" ")).slice(0, 600),
    url: raw.url,
    authority: "n/a",
    readRef: { kind: "section", id: raw.id },
    india: { enactment: raw.enactment, section: raw.section, replacedBy: raw.replaced_by, provider: "india-code" },
  };
}

/** Web hits arrive as agent citation events, not structured retrieval. */
export function normalizeWebCitation(c: { title: string; url?: string; snippet?: string }, index: number): SearchHit {
  let host = "";
  try { host = c.url ? new URL(c.url).host.replace(/^www\./, "") : ""; } catch { host = ""; }
  return { id: `web:${c.url ?? index}`, source: "web", title: c.title || c.url || "Web page", subtitle: host, url: c.url, snippet: c.snippet, authority: "n/a", readRef: c.url ? { kind: "url", url: c.url } : undefined };
}

/** Dispatch by source over a tool result payload ({ results: [...] , total }). */
export function normalizeToolResult(source: SearchSource, payload: unknown, ctx: NormalizeContext): { hits: SearchHit[]; total: number } {
  const p = (payload ?? {}) as { results?: unknown[]; total?: number; count?: number };
  const rows = Array.isArray(p.results) ? p.results : [];
  let hits: SearchHit[] = [];
  switch (source) {
    case "caselaw": hits = rows.map((r, i) => (isJudgmentRow(r) ? normalizeJudgment(r, ctx) : normalizeCaseLaw(r as RawCaseLaw, ctx, i))); break;
    case "dockets": hits = rows.map((r, i) => normalizeDocket(r as RawDocket, ctx, i)); break;
    case "regulations": hits = rows.map((r, i) => normalizeCfr(r as RawCfr, i)); break;
    case "federal_register": hits = rows.map((r, i) => normalizeFederalRegister(r as RawFr, i)); break;
    case "statutes": hits = rows.map((r, i) => (isIndiaSectionRow(r) ? normalizeIndiaSection(r) : normalizeStatute(r as RawStatute, i))); break;
    case "library": hits = rows.map((r) => normalizeLibrary(r as RawLibrary)); break;
    case "ediscovery": hits = rows.map((r) => normalizeEdoc(r as RawEdoc)); break;
    case "web": hits = []; break;
  }
  const total = typeof p.total === "number" ? p.total : typeof p.count === "number" ? p.count : hits.length;
  return { hits: dedupe(hits), total };
}

function isJudgmentRow(r: unknown): r is RawJudgment {
  return Boolean(r && typeof r === "object" && typeof (r as RawJudgment).source === "string" && (r as RawJudgment).source.startsWith("judgment://"));
}

function isIndiaSectionRow(r: unknown): r is RawIndiaSection {
  return Boolean(r && typeof r === "object" && typeof (r as RawIndiaSection).source === "string" && (r as RawIndiaSection).source.startsWith("statute://"));
}

export function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => { if (seen.has(h.id)) return false; seen.add(h.id); return true; });
}

// ---- Citation formatting ----------------------------------------------------------

/**
 * Full citation for copying into a memo or pleading. LeClaude India: judgments and India Code sections use the Indian
 * style (src/modules/search/india-citations.ts); the US Bluebook branches remain for records without Indian metadata.
 * The name is kept for existing callers; `formatCitation` is the preferred alias.
 */
export function formatBluebook(hit: SearchHit): string {
  if (hit.source === "caselaw" && (hit.india || hit.readRef?.kind === "judgment")) return formatJudgmentCitation(hit);
  if (hit.source === "statutes" && (hit.india || hit.readRef?.kind === "section")) return formatStatuteHit(hit);
  switch (hit.source) {
    case "caselaw": {
      const year = yearOf(hit.date);
      const abbr = courtAbbreviation(hit.courtId, hit.court);
      const isUS = hit.cite ? /\bU\.S\.(\s|$)/.test(hit.cite) : false;
      const paren = isUS || hit.courtId === "scotus" ? year : [abbr, year].filter(Boolean).join(" ");
      const cite = hit.cite ?? (hit.docketNumber ? `No. ${hit.docketNumber}` : "");
      const unpublished = !hit.cite && hit.date ? `slip op. (${[abbr, bluebookDate(hit.date)].filter(Boolean).join(" ")})` : "";
      if (unpublished) return `${hit.title}, ${cite ? cite + ", " : ""}${unpublished}`.replace(/,\s*,/g, ",");
      return `${hit.title}, ${cite}${paren ? ` (${paren})` : ""}`.replace(/\s+/g, " ").trim();
    }
    case "dockets": {
      const abbr = courtAbbreviation(hit.courtId, hit.court);
      return `${hit.title}, No. ${hit.docketNumber ?? "—"} (${[abbr, hit.date ? `filed ${bluebookDate(hit.date)}` : ""].filter(Boolean).join(" ")})`;
    }
    case "regulations": {
      const year = yearOf(hit.cfr?.effective) || String(new Date().getFullYear());
      return `${hit.cite ?? hit.title} (${year})`;
    }
    case "federal_register": {
      const cite = hit.cite ? hit.cite : hit.fr?.documentNumber ? `FR Doc. ${hit.fr.documentNumber}` : "";
      return `${hit.title}, ${cite}${hit.date ? ` (${bluebookDate(hit.date)})` : ""}`;
    }
    case "statutes":
      return hit.cite ? `${hit.cite}${hit.date ? ` (${yearOf(hit.date)})` : ""}` : hit.title;
    case "library":
      return `${hit.title} (firm ${hit.library?.type ?? "library"}${hit.date ? `, ${indianDate(hit.date)}` : ""})`;
    case "ediscovery":
      return `${hit.edoc?.bates ?? hit.cite ?? ""}, ${hit.title}${hit.date ? ` (${indianDate(hit.date)})` : ""}`;
    case "web":
      return `${hit.title}, ${hit.subtitle ?? ""}${hit.url ? `, ${hit.url}` : ""} (accessed ${indianDate(new Date().toISOString())})`;
  }
}

/** Preferred name for the citation formatter. */
export const formatCitation = formatBluebook;

/** Short cite for inline use ("Twombly, 550 U.S. at 555"). */
export function shortCite(hit: SearchHit): string {
  if (hit.source === "caselaw" && hit.india) return shortJudgmentCite(hit);
  if (hit.source === "caselaw") {
    const short = hit.title.split(/\s+v\.\s+/)[0]?.split(",")[0]?.trim() || hit.title;
    return hit.cite ? `${short}, ${hit.cite}` : short;
  }
  return hit.cite ?? hit.title;
}

/** Sort helper honouring Precision (score) vs Recency (date). */
export function sortHits(hits: SearchHit[], order: "score" | "date"): SearchHit[] {
  if (order === "date") return [...hits].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return hits;
}
