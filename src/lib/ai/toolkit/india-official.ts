import "server-only";
import { defineTool, type EvidenceProvenance, type ToolContext } from "../tools";
import { contentHash } from "@/lib/integrity/hash";
import type { EvidenceKind } from "@/lib/evidence/types";
import { normalizeCaseNumber, normalizeDiaryNo } from "@/modules/official/case-numbers";
import { causeListEntries, courtCalendar, readOfficialDocument, searchOfficial } from "@/modules/official/service";
import { isSourceId, parseSourceRef, sourceRef, SOURCE_IDS, type CauseListEntry, type SourceKind, type SourceSearchHit } from "@/modules/official/types";

/**
 * Official-sources tools (court cause lists, orders and judgments as published, tribunal and regulator orders, gazette
 * notifications, circulars, Parliament papers, court calendars). Read-only, public material; every result carries a
 * stable, server-resolvable `src://<documentId>#p<page>` source, the publisher, the official URL and how the text was
 * obtained (OCR text is flagged: quotes from it must be checked against the PDF before filing).
 *
 * The tools consume only the official-sources facade (`@/modules/official/service`). When the corpus is not configured
 * (no Postgres) or not wired on this deployment the facade throws; the tools then return a deterministic
 * `{ available: false }` result, never a guess and never a document from memory.
 */

const OFFICIAL_KINDS: readonly SourceKind[] = ["cause_list", "order", "judgment", "defect_list", "calendar", "regulation", "circular", "notification", "gazette", "minutes", "parliament_question", "parliament_debate", "committee_report", "company_record", "dataset"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOC_ID = /^[A-Za-z0-9_.:-]{6,160}$/;

function emit(ctx: ToolContext, ev: EvidenceProvenance[]) { if (ev.length) ctx.emit({ type: "evidence", evidence: ev }); }

/** Facade errors that mean "this deployment has no official corpus" (matched by code/name: module instances may differ). */
function unavailable(e: unknown): { available: false; status: "not_available"; reason: string; note: string } | null {
  const err = e as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  const name = typeof err?.name === "string" ? err.name : "";
  if (code === "official_not_configured" || name === "OfficialNotConfiguredError") return { available: false, status: "not_available", reason: "official_not_configured", note: "The official-sources corpus is not configured on this deployment. No official document was searched; do not cite cause lists, orders, circulars or notifications from memory — say they could not be checked." };
  if (code === "official_not_implemented" || name === "OfficialNotImplementedError") return { available: false, status: "not_available", reason: "official_not_implemented", note: "The official-sources corpus is not available on this deployment yet. No official document was searched; do not cite official documents from memory — say they could not be checked." };
  return null;
}

/** Evidence kind of an official document (provenance taxonomy). */
export function officialEvidenceKind(kind: SourceKind): EvidenceKind {
  switch (kind) {
    case "order": case "judgment": return "opinion";
    case "cause_list": case "defect_list": return "docket_entry";
    case "regulation": case "circular": return "regulation";
    case "notification": case "gazette": return "register_notice";
    default: return "document";
  }
}

const OCR_NOTE = "OCR text: quotes must be checked against the official PDF before they are filed or relied on.";

function pageLabel(start: number | null, end: number | null): string {
  if (start == null) return "";
  return end != null && end !== start ? `pp. ${start}–${end}` : `p. ${start}`;
}

function hitTitle(h: SourceSearchHit): string {
  const pages = pageLabel(h.pageStart, h.pageEnd);
  return [h.title, h.publisher, h.docDate ? `dated ${h.docDate}` : "", pages].filter(Boolean).join(" · ");
}

/** Bounded split of a chunk's text into citable blocks (citation granularity); never drops text. */
function blocks(text: string, max = 2_000): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const out: string[] = [];
  let cur = "";
  for (const para of t.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + p.length + 2 > max) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

function checkDate(v: string | undefined, name: string): string | undefined {
  if (v == null || v === "") return undefined;
  if (!ISO_DATE.test(v)) throw new Error(`${name} must be an ISO date (YYYY-MM-DD); got "${v}".`);
  return v;
}

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// search_official_sources
// ---------------------------------------------------------------------------

type SearchArgs = { q: string; sources?: string[]; kinds?: string[]; forum?: string; from?: string; to?: string; limit?: number };

export const searchOfficialSourcesTool = defineTool<SearchArgs>({
  name: "search_official_sources",
  description: "Search OFFICIAL publications as published by the court, tribunal, regulator or government: Supreme Court and Delhi High Court cause lists and orders, NCLT / NCLAT / IBBI insolvency orders (incl. SC and HC IBC orders mirrored by IBBI), SEBI enforcement orders (incl. SAT orders mirrored by SEBI), CCI and NGT orders, the e-Gazette, CBIC / CBDT notifications and circulars, GST Council minutes, MCA company records and Parliament questions and reports. Returns focused passages with a stable src:// source, publisher, date, page and the official URL; read the document with read_official_document (same id or src:// ref) before characterising it. Use it for regulator orders, circulars, notifications and tribunal orders that are not in the judgment corpus. Text marked OCR must be checked against the PDF before quoting in a filing.",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "Words, a quoted phrase, a case or notification number, a party or company name" },
      sources: { type: "array", items: { type: "string", enum: [...SOURCE_IDS] }, description: "Limit to these sources (registry ids), e.g. [\"sebi-orders\"], [\"ibbi\", \"nclat\"], [\"cbic\"]" },
      kinds: { type: "array", items: { type: "string", enum: [...OFFICIAL_KINDS] }, description: "Limit to these document kinds, e.g. [\"order\"], [\"circular\", \"notification\"]" },
      forum: { type: "string", description: "Court / tribunal / regulator key, e.g. sci, hc-delhi, nclt, nclat, sebi" },
      from: { type: "string", description: "Earliest document date, YYYY-MM-DD" },
      to: { type: "string", description: "Latest document date, YYYY-MM-DD" },
      limit: { type: "integer", description: "Default 8, max 12" },
    },
    required: ["q"],
  },
  examples: [{ q: "\"interim moratorium\" personal guarantor", sources: ["ibbi", "nclat"], limit: 8 }, { q: "input tax credit blocked credit circular", sources: ["cbic"], kinds: ["circular"], from: "2025-01-01" }],
  timeoutMs: 25_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Searching official sources: ${a.q}`,
  async execute(args, ctx) {
    const q = (args.q ?? "").trim();
    if (!q) throw new Error("q is empty; give the words, number or name to search for.");
    const sources = (args.sources ?? []).filter(isSourceId);
    if (args.sources?.length && !sources.length) throw new Error(`None of the sources ${JSON.stringify(args.sources)} is a registered official source (${SOURCE_IDS.join(", ")}).`);
    const kinds = (args.kinds ?? []).filter((k): k is SourceKind => (OFFICIAL_KINDS as readonly string[]).includes(k));
    const from = checkDate(args.from, "from");
    const to = checkDate(args.to, "to");
    const limit = Math.max(1, Math.min(12, Math.floor(args.limit ?? 8)));
    let r;
    try {
      r = await searchOfficial({ q, sources: sources.length ? sources : undefined, kinds: kinds.length ? kinds : undefined, forum: args.forum?.trim() || undefined, from, to, limit });
    } catch (e) {
      const na = unavailable(e);
      if (na) return { ...na, count: 0, results: [] };
      throw e;
    }
    const hits = r.hits.slice(0, limit);
    const retrievedAt = new Date().toISOString();
    emit(ctx, hits.map((h, i) => ({ source: h.ref, kind: officialEvidenceKind(h.kind), provider: `official:${h.sourceId}`, tool: "search_official_sources", query: q, rank: i + 1, score: h.score, documentId: h.documentId, chunkIndex: h.chunkIndex, page: h.pageStart ?? undefined, url: h.url, hash: contentHash(`${h.documentId}|${h.chunkIndex}|${h.text}`), retrievedAt })));
    return {
      available: true,
      count: hits.length,
      mode: r.mode,
      results: hits.map((h) => ({
        type: "search_result" as const,
        source: h.ref,
        title: hitTitle(h),
        content: [h.text || "(no passage)"],
        id: h.documentId,
        source_id: h.sourceId,
        kind: h.kind,
        publisher: h.publisher,
        date: h.docDate,
        page: h.pageStart,
        url: h.url,
        extraction: h.extraction,
        ...(h.extraction === "ocr_model" ? { ocr: OCR_NOTE } : {}),
        match: h.match,
      })),
      ...(hits.length ? {} : { note: "No official document matched. Rephrase or widen the date range; do not cite an official document that was not found." }),
    };
  },
});

// ---------------------------------------------------------------------------
// read_official_document
// ---------------------------------------------------------------------------

type ReadArgs = { id: string; from_chunk?: number; page?: number; max_chars?: number };

export const readOfficialDocumentTool = defineTool<ReadArgs>({
  name: "read_official_document",
  description: "Read an official document (order, judgment, cause list, circular, notification, gazette, minutes, Parliament paper) exactly as extracted from the publisher's file, with page markers ([p. 4]). `id` is the document id or the src:// reference that search_official_sources returned (src://<id>#p<page> jumps to that page). Use `from_chunk` (next_chunk of the previous call) to continue. Returns the publisher, official URL, SHA-256 of the file read, fetch time and extraction method; OCR pages are flagged and must be checked against the PDF before a quotation is filed. An unknown id is an error, never another document.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Document id or src:// reference from search_official_sources" },
      from_chunk: { type: "integer", description: "Chunk index to start from (next_chunk of a previous call)" },
      page: { type: "integer", description: "Start at the chunk containing this page" },
      max_chars: { type: "integer", description: "Default 20000, max 60000" },
    },
    required: ["id"],
  },
  examples: [{ id: "src://sebi-orders_9f3a1c2b7e#p3" }, { id: "sci-orders_4d2e9a01bc", from_chunk: 4 }],
  timeoutMs: 20_000,
  maxResultChars: 64_000,
  access: "read",
  label: (a) => `Reading official document ${a.id}`,
  async execute(args, ctx) {
    const raw = (args.id ?? "").trim();
    let documentId = raw;
    let page = args.page ?? undefined;
    let fromChunk = args.from_chunk ?? undefined;
    if (raw.startsWith("src://")) {
      const ref = parseSourceRef(raw);
      if (!ref) throw new Error(`"${raw}" is not a valid official source reference (src://<documentId>#p<page>). Use the id or source returned by search_official_sources.`);
      documentId = ref.documentId;
      if (page == null && fromChunk == null) { if (ref.page != null) page = ref.page; else if (ref.chunk != null) fromChunk = ref.chunk; }
    } else if (!DOC_ID.test(raw)) {
      throw new Error(`"${raw}" is not an official document id. Use the id or src:// source returned by search_official_sources.`);
    }
    const maxChars = Math.max(2_000, Math.min(60_000, Math.floor(args.max_chars ?? 20_000)));
    let r;
    try {
      r = await readOfficialDocument(documentId, { fromChunk, page, maxChars });
    } catch (e) {
      const na = unavailable(e);
      if (na) return na;
      throw e;
    }
    if (!r) throw new Error(`No official document with id ${documentId} in the corpus. It is not substituted with another document; search again with search_official_sources.`);
    const d = r.document;
    if (!r.chunks.length) throw new Error(`${d.title} has no extracted text${page != null ? ` at page ${page}` : ""} (status ${d.status}${d.error ? `: ${d.error}` : ""}).`);
    const first = r.chunks[0];
    const ocrPages = new Set(d.ocrPages ?? []);
    const content = r.chunks.flatMap((c) => {
      const label = pageLabel(c.pageStart, c.pageEnd);
      const ocr = c.pageStart != null && (ocrPages.has(c.pageStart) || (c.pageEnd != null && ocrPages.has(c.pageEnd))) ? " (OCR)" : "";
      return blocks(c.text).map((b, i) => (i === 0 && label ? `[${label}${ocr}] ${b}` : b));
    });
    const text = r.chunks.map((c) => c.text).join("\n\n");
    const source = sourceRef(d.id, first.pageStart != null ? { page: first.pageStart } : { chunk: first.index });
    emit(ctx, [{ source, kind: officialEvidenceKind(d.kind), provider: `official:${d.sourceId}`, tool: "read_official_document", rank: 1, documentId: d.id, chunkIndex: first.index, page: first.pageStart ?? undefined, url: d.url, hash: d.sha256 ?? contentHash(text), retrievedAt: new Date().toISOString() }]);
    const ocrUsed = d.extraction === "ocr_model" || ocrPages.size > 0;
    return {
      type: "search_result" as const,
      source,
      title: [d.title, d.docDate ? `dated ${d.docDate}` : "", pageLabel(first.pageStart, r.chunks[r.chunks.length - 1].pageEnd ?? r.chunks[r.chunks.length - 1].pageStart)].filter(Boolean).join(" · "),
      content: content.length ? content : ["(no text)"],
      id: d.id,
      source_id: d.sourceId,
      kind: d.kind,
      date: d.docDate,
      url: d.url,
      file_url: d.fileUrl,
      sha256: d.sha256,
      fetched_at: d.fetchedAt,
      version: d.version,
      pages: d.pages,
      extraction: d.extraction,
      ...(ocrUsed ? { ocr: OCR_NOTE, ocr_pages: d.ocrPages } : {}),
      chunks: `${first.index}–${r.chunks[r.chunks.length - 1].index}`,
      has_more: r.hasMore,
      next_chunk: r.nextChunk,
      attribution: r.attribution,
    };
  },
});

// ---------------------------------------------------------------------------
// causelist_lookup
// ---------------------------------------------------------------------------

type CauseArgs = { forum?: string; date?: string; from?: string; to?: string; case_number?: string; diary_no?: string; advocate?: string; limit?: number };

const CAUSELIST_CAVEAT = "Cause lists are published by the court as information; supplementary lists, deletions and transfers change them. Confirm the item number and court on the court's website before relying on it.";

function entryRow(e: CauseListEntry) {
  return {
    source: sourceRef(e.documentId, e.page != null ? { page: e.page } : undefined),
    document_id: e.documentId,
    forum: e.forum,
    list_date: e.listDate,
    list_type: e.listType,
    court_no: e.courtNo,
    bench: e.bench,
    item_no: e.itemNo,
    case_numbers: e.caseNumbers,
    diary_no: e.diaryNo,
    parties: e.parties,
    advocates: e.advocates,
    page: e.page,
    published_at: e.publishedAt,
    fetched_at: e.fetchedAt,
    parsed: e.parsed,
    raw: e.raw.length > 600 ? `${e.raw.slice(0, 600)}…` : e.raw,
  };
}

export const causelistLookupTool = defineTool<CauseArgs>({
  name: "causelist_lookup",
  description: "Look up a matter in the PUBLISHED cause lists loaded from the courts (Supreme Court, Delhi High Court, NCLT, NCLAT): give a date (or a from/to range of at most 31 days) and a case number (normalised exactly: \"SLP(C) No. 1234/2026\" → SLPC/1234/2026), a Supreme Court diary number, or an advocate's name (exact name match on the listed advocates, never fuzzy). Returns each listed item with court, bench, item number, list type, the page of the list and the src:// source. Only exact matches are returned: no result means no parsed entry matched in the lists loaded for that range — it does not prove the matter is not listed.",
  parameters: {
    type: "object",
    properties: {
      forum: { type: "string", description: "Court / tribunal key, e.g. sci, hc-delhi, nclt-mumbai, nclat" },
      date: { type: "string", description: "List date, YYYY-MM-DD" },
      from: { type: "string", description: "Range start, YYYY-MM-DD (with to; at most 31 days)" },
      to: { type: "string", description: "Range end, YYYY-MM-DD" },
      case_number: { type: "string", description: "Case number as printed, e.g. SLP(C) No. 1234/2026, W.P.(C)-5812/2016, CP(IB)/29(MP)2022" },
      diary_no: { type: "string", description: "Supreme Court diary number, e.g. 54583/2026" },
      advocate: { type: "string", description: "Advocate's name exactly as listed" },
      limit: { type: "integer", description: "Default 25, max 50" },
    },
    required: [],
  },
  examples: [{ forum: "sci", date: "2026-10-05", case_number: "SLP(C) No. 1234/2026" }, { forum: "hc-delhi", from: "2026-10-01", to: "2026-10-09", case_number: "W.P.(C) 5812/2016" }],
  timeoutMs: 20_000,
  maxResultChars: 24_000,
  access: "read",
  label: (a) => `Checking cause lists${a.case_number ? ` for ${a.case_number}` : a.diary_no ? ` for diary ${a.diary_no}` : ""}`,
  async execute(args) {
    const date = checkDate(args.date, "date");
    const from = checkDate(args.from, "from");
    const to = checkDate(args.to, "to");
    if (!date && !(from && to)) throw new Error("Give a list date (date) or a range (from and to, at most 31 days). A lookup over every list is not run.");
    if (!date && from && to) {
      const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;
      if (!(span >= 0)) throw new Error("from must be on or before to.");
      if (span > 31) throw new Error("The range is longer than 31 days; narrow it.");
    }
    const caseInput = args.case_number?.trim();
    const diaryInput = args.diary_no?.trim();
    const advocate = args.advocate?.trim();
    if (!caseInput && !diaryInput && !advocate) throw new Error("Give a case_number, diary_no or advocate to look up; a cause list is not dumped wholesale.");
    const caseKey = caseInput ? normalizeCaseNumber(caseInput) : null;
    const diaryKey = diaryInput ? normalizeDiaryNo(diaryInput) : null;
    const unparsed: string[] = [];
    if (caseInput && !caseKey) unparsed.push(`case number "${caseInput}"`);
    if (diaryInput && !diaryKey) unparsed.push(`diary number "${diaryInput}"`);
    if (unparsed.length && !caseKey && !diaryKey && !advocate) {
      return { status: "unparsed_identifier", count: 0, entries: [], note: `Could not normalise ${unparsed.join(" and ")} into TYPE/NUMBER/YEAR. No lookup was run (identifiers are matched exactly, never guessed). Give it as printed on the case papers, e.g. "SLP(C) No. 1234/2026".` };
    }
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 25)));
    let entries: CauseListEntry[];
    try {
      entries = await causeListEntries({ forum: args.forum?.trim() || undefined, date, from: date ? undefined : from, to: date ? undefined : to, caseKeys: caseKey ? [caseKey.key] : undefined, diaryNos: diaryKey ? [diaryKey] : undefined, advocate: advocate || undefined, limit });
    } catch (e) {
      const na = unavailable(e);
      if (na) return { ...na, count: 0, entries: [] };
      throw e;
    }
    // Exact matches only: an unparsed entry is never reported as a listing of the matter.
    const matched = entries.filter((e) => e.parsed).slice(0, limit);
    return {
      status: matched.length ? "listed" : "no_match_in_loaded_lists",
      count: matched.length,
      matched_on: { case_number: caseKey?.key ?? null, diary_no: diaryKey, advocate: advocate || null },
      ...(unparsed.length ? { unparsed: `Not used (could not be normalised): ${unparsed.join(", ")}` } : {}),
      entries: matched.map(entryRow),
      caveat: CAUSELIST_CAVEAT,
      ...(matched.length ? {} : { note: "No parsed cause-list entry matched in the lists loaded for this date range. This does not prove the matter is not listed: the list may not be loaded yet or the entry may be unparsed. Check the court's website." }),
    };
  },
});

// ---------------------------------------------------------------------------
// court_calendar
// ---------------------------------------------------------------------------

type CalendarArgs = { forum: string; year: number };

const CALENDAR_CAVEAT = "Courts also declare holidays and shift sitting days by separate notification (moon-dependent festivals, ad-hoc closures, substituted working days). This calendar does not include those: check the court's latest notifications before computing or advising on a deadline.";

export const courtCalendarTool = defineTool<CalendarArgs>({
  name: "court_calendar",
  description: "The court's notified annual calendar for a year — holidays, vacations and weekly off-days — built from the official holiday list (Supreme Court, High Courts where an official list is loaded, NCLT, NCLAT). Use it before counting days to a deadline that falls near a holiday or vacation. It never includes ad-hoc closures notified later; the result says so. A forum or year without a loaded calendar returns available: false (no sample calendar is substituted).",
  parameters: { type: "object", properties: { forum: { type: "string", description: "Court key, e.g. sci, hc-delhi, hc-karnataka, nclt, nclat" }, year: { type: "integer", description: "Calendar year, e.g. 2026" } }, required: ["forum", "year"] },
  examples: [{ forum: "sci", year: 2026 }, { forum: "hc-delhi", year: 2027 }],
  timeoutMs: 15_000,
  maxResultChars: 16_000,
  access: "read",
  label: (a) => `Court calendar ${a.forum} ${a.year}`,
  async execute(args) {
    const forum = (args.forum ?? "").trim();
    if (!forum) throw new Error("forum is required, e.g. sci or hc-delhi.");
    const year = Math.floor(Number(args.year));
    if (!Number.isFinite(year) || year < 2000 || year > 2100) throw new Error(`year must be a calendar year such as 2026; got ${String(args.year)}.`);
    let cal;
    try {
      cal = await courtCalendar(forum, [year]);
    } catch (e) {
      const na = unavailable(e);
      if (na) return na;
      throw e;
    }
    if (!cal || !cal.years.includes(year)) return { available: false, status: "no_calendar", forum, year, note: `No official calendar for ${forum} in ${year} is loaded. Do not assume holidays; check the court's website.`, caveat: CALENDAR_CAVEAT };
    if (cal.sample) return { available: false, status: "sample_only", forum, year, note: "Only an illustrative sample calendar exists for this forum; it is not the court's notified calendar and must not be used for a deadline.", caveat: CALENDAR_CAVEAT };
    const inYear = (d: string) => d.startsWith(`${year}-`);
    return {
      available: true,
      forum,
      court_id: cal.courtId,
      year,
      weekly_off: cal.weeklyOff.map((d) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d] ?? String(d)),
      holidays: cal.holidays.filter((h) => inYear(h.date)).map((h) => ({ date: h.date, name: h.name })),
      vacations: cal.vacations.filter((v) => inYear(v.from) || inYear(v.to)).map((v) => ({ from: v.from, to: v.to, name: v.name, registry_open: v.registryOpen ?? null })),
      source: cal.source,
      caveat: CALENDAR_CAVEAT,
    };
  },
});

/** Official-sources tools (offered with the Postgres corpus capability, like the judgment and statutes corpora). */
export const OFFICIAL_TOOLS = [searchOfficialSourcesTool, readOfficialDocumentTool, causelistLookupTool, courtCalendarTool];
export const OFFICIAL_TOOL_NAMES = OFFICIAL_TOOLS.map((t) => t.name);
