import "server-only";
import { defineTool, truncationMarker, type EvidenceProvenance, type ToolContext } from "../tools";
import { fetchJSON, fetchText, htmlToText, stripXml } from "./http";

const CL = "https://www.courtlistener.com/api/rest/v4";

function clHeaders(): Record<string, string> {
  const token = process.env.COURTLISTENER_API_TOKEN?.trim();
  return token ? { Authorization: `Token ${token}` } : {};
}

interface CLSearchResult {
  count?: number;
  results?: Array<{
    caseName?: string; caseNameFull?: string; citation?: string[]; court?: string; court_id?: string; dateFiled?: string; docketNumber?: string; snippet?: string; absolute_url?: string; cluster_id?: number; judge?: string; status?: string; citeCount?: number;
    opinions?: Array<{ id: number; snippet?: string; type?: string; download_url?: string }>;
    docket_id?: number; assignedTo?: string; suitNature?: string; cause?: string; dateTerminated?: string | null; party?: string[]; attorney?: string[];
  }>;
}

/** Common U.S. court identifiers for CourtListener `court` filters. */
export const COURT_GROUPS: Record<string, string> = {
  "scotus": "scotus",
  "federal-appellate": "ca1 ca2 ca3 ca4 ca5 ca6 ca7 ca8 ca9 ca10 ca11 cadc cafc",
  "4th-circuit": "ca4 dsc dnc dmd dvae dvaw dwvn dwvs",
  "7th-circuit": "ca7 ilnd ilcd ilsd innd insd wied wiwd",
  "9th-circuit": "ca9 cacd caed cand casd",
  "11th-circuit": "ca11 flnd flmd flsd gand gamd gasd alnd almd alsd",
  "california-state": "cal calctapp",
  "new-york-state": "ny nyappdiv nysupct",
  "delaware": "del delch delsuperct",
  "texas-state": "tex texapp",
  "illinois-state": "ill illappct",
};

// ---------------------------------------------------------------------------
// Stable authority identifiers (constitution §25, §53.4): authority://<provider>/<kind>/<id>
// ---------------------------------------------------------------------------

export function authoritySource(provider: "courtlistener" | "ecfr" | "federalregister" | "govinfo", ...parts: (string | number)[]): string {
  return `authority://${provider}/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;
}

/** A bounded window of a long text with an explicit marker and the offset of the next window. */
function windowed(text: string, offset: number | undefined, maxChars: number) {
  const start = Math.max(0, Math.min(Math.floor(offset ?? 0), text.length));
  const end = Math.min(text.length, start + Math.max(1, maxChars));
  const remaining = text.length - end;
  return { text: text.slice(start, end) + (remaining > 0 ? truncationMarker(remaining) : ""), window: { offset: start, length: end - start, total: text.length, next_offset: remaining > 0 ? end : null } };
}

function emitEvidence(ctx: ToolContext, evidence: EvidenceProvenance[]) {
  if (evidence.length) ctx.emit({ type: "evidence", evidence });
}

export const searchCaseLawTool = defineTool<{ query: string; jurisdiction?: string; courts?: string; filed_after?: string; filed_before?: string; order_by?: string; limit?: number }>({
  name: "search_case_law",
  description: "Search published and unpublished U.S. court opinions (CourtListener, ~10M opinions across federal and state courts). Supports boolean operators, phrases in quotes, and proximity. Returns case names, citations, courts, dates, snippets, a stable `source` (authority://courtlistener/opinion/<id>) and opinion ids for full-text retrieval via get_opinion_text. A search hit proves the authority exists, not that it supports a proposition — read it before characterizing it.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query, e.g. '\"failure to warn\" AND benzene' or 'consequential damages waiver indemnity'" },
      jurisdiction: { type: "string", description: "Named group: scotus, federal-appellate, 4th-circuit, 7th-circuit, 9th-circuit, 11th-circuit, california-state, new-york-state, delaware, texas-state, illinois-state. Omit for all courts." },
      courts: { type: "string", description: "Space-separated CourtListener court ids (e.g. 'ca4 dsc'), overrides jurisdiction" },
      filed_after: { type: "string", description: "ISO date YYYY-MM-DD" },
      filed_before: { type: "string", description: "ISO date YYYY-MM-DD" },
      order_by: { type: "string", description: "'score desc' (default), 'dateFiled desc', 'dateFiled asc', 'citeCount desc'" },
      limit: { type: "integer", description: "Max results, default 10, max 20" },
    },
    required: ["query"],
  },
  examples: [
    { query: "\"failure to warn\" AND benzene", jurisdiction: "4th-circuit", filed_after: "2020-01-01", order_by: "citeCount desc", limit: 10 },
    { query: "\"government contractor defense\" \"reasonably precise specifications\"", courts: "ca4 dsc", limit: 5 },
  ],
  timeoutMs: 25_000,
  label: (a) => `Searching case law: ${a.query}`,
  async execute(args, ctx) {
    const params = new URLSearchParams({ q: args.query, type: "o", order_by: args.order_by ?? "score desc" });
    const courts = args.courts ?? (args.jurisdiction ? COURT_GROUPS[args.jurisdiction] : undefined);
    if (courts) params.set("court", courts);
    if (args.filed_after) params.set("filed_after", args.filed_after);
    if (args.filed_before) params.set("filed_before", args.filed_before);
    const data = await fetchJSON<CLSearchResult>(`${CL}/search/?${params}`, { headers: clHeaders(), signal: ctx.signal });
    const limit = Math.min(args.limit ?? 10, 20);
    const results = (data.results ?? []).slice(0, limit).map((r) => ({
      source: r.opinions?.[0]?.id != null ? authoritySource("courtlistener", "opinion", r.opinions[0].id) : r.cluster_id != null ? authoritySource("courtlistener", "cluster", r.cluster_id) : undefined,
      case_name: r.caseName,
      citations: r.citation ?? [],
      court: r.court,
      court_id: r.court_id,
      date_filed: r.dateFiled,
      docket_number: r.docketNumber,
      status: r.status,
      cite_count: r.citeCount,
      judge: r.judge,
      snippet: (r.opinions?.[0]?.snippet ?? r.snippet ?? "").replace(/\s+/g, " ").trim(),
      opinion_id: r.opinions?.[0]?.id,
      cluster_id: r.cluster_id,
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : undefined,
    }));
    const retrievedAt = new Date().toISOString();
    emitEvidence(ctx, results.filter((r) => r.source).map((r, i) => ({ source: r.source!, kind: "opinion", provider: "courtlistener", tool: "search_case_law", query: args.query, rank: i + 1, authorityId: String(r.opinion_id ?? r.cluster_id), url: r.url, retrievedAt })));
    for (const r of results.slice(0, 5)) ctx.emit({ type: "citation", citation: { title: `${r.case_name}${r.citations?.[0] ? `, ${r.citations[0]}` : ""}`, url: r.url, cite: r.citations?.[0], source: "case law", snippet: r.snippet } });
    return { total: data.count ?? results.length, results };
  },
});

export const getOpinionTextTool = defineTool<{ opinion_id: number; max_chars?: number; offset?: number }>({
  name: "get_opinion_text",
  description: "Retrieve the full text of a court opinion by CourtListener opinion id (from search_case_law). Use it to verify holdings, quote accurately, and check pin cites. Returns a text window (default 40,000 characters) with `window.next_offset` for the next window.",
  parameters: { type: "object", properties: { opinion_id: { type: "integer" }, max_chars: { type: "integer", description: "Window size, default 40000" }, offset: { type: "integer", description: "Character offset of the window (from window.next_offset)" } }, required: ["opinion_id"] },
  examples: [{ opinion_id: 2812209 }, { opinion_id: 2812209, max_chars: 40000, offset: 40000 }],
  timeoutMs: 30_000,
  maxResultChars: 48_000,
  label: (a) => `Reading opinion #${a.opinion_id}`,
  async execute({ opinion_id, max_chars, offset }, ctx) {
    const data = await fetchJSON<{ plain_text?: string; html_with_citations?: string; html?: string; html_lawbox?: string; html_columbia?: string; xml_harvard?: string; download_url?: string; absolute_url?: string; cluster?: string }>(`${CL}/opinions/${opinion_id}/`, { headers: clHeaders(), signal: ctx.signal });
    const raw = data.plain_text?.trim() || htmlToText(data.html_with_citations ?? data.html ?? data.html_lawbox ?? data.html_columbia ?? "", { maxChars: 2_000_000 }).text || stripXml(data.xml_harvard ?? "");
    const w = windowed(raw, offset, max_chars ?? 40_000);
    const url = data.absolute_url ? `https://www.courtlistener.com${data.absolute_url}` : undefined;
    const source = authoritySource("courtlistener", "opinion", opinion_id);
    emitEvidence(ctx, [{ source, kind: "opinion", provider: "courtlistener", tool: "get_opinion_text", rank: 1, authorityId: String(opinion_id), url, retrievedAt: new Date().toISOString() }]);
    return { source, opinion_id, url, text: w.text, length: raw.length, window: w.window };
  },
});

export const searchDocketsTool = defineTool<{ query: string; courts?: string; filed_after?: string; filed_before?: string; limit?: number }>({
  name: "search_dockets",
  description: "Search federal court dockets (PACER/RECAP via CourtListener): case names, parties, nature of suit, assigned judge and filing dates, each with a stable `source` (authority://courtlistener/docket/<id>). Use for docket monitoring, finding related litigation, or judge/party history.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "e.g. 'Northgate Logistics' or 'Depo-Provera products liability'" },
      courts: { type: "string", description: "Space-separated court ids, e.g. 'dsc ilnd'" },
      filed_after: { type: "string", description: "ISO date YYYY-MM-DD" },
      filed_before: { type: "string", description: "ISO date YYYY-MM-DD" },
      limit: { type: "integer", description: "Default 10, max 20" },
    },
    required: ["query"],
  },
  examples: [{ query: "Northgate Logistics Holdings", filed_after: "2019-01-01", limit: 10 }, { query: "Depo-Provera products liability MDL 3140" }],
  timeoutMs: 25_000,
  label: (a) => `Searching dockets: ${a.query}`,
  async execute(args, ctx) {
    const params = new URLSearchParams({ q: args.query, type: "r", order_by: "dateFiled desc" });
    if (args.courts) params.set("court", args.courts);
    if (args.filed_after) params.set("filed_after", args.filed_after);
    if (args.filed_before) params.set("filed_before", args.filed_before);
    const data = await fetchJSON<CLSearchResult>(`${CL}/search/?${params}`, { headers: clHeaders(), signal: ctx.signal });
    const results = (data.results ?? []).slice(0, Math.min(args.limit ?? 10, 20)).map((r) => ({
      source: r.docket_id != null ? authoritySource("courtlistener", "docket", r.docket_id) : undefined,
      case_name: r.caseName,
      docket_number: r.docketNumber,
      court: r.court,
      court_id: r.court_id,
      date_filed: r.dateFiled,
      date_terminated: r.dateTerminated,
      assigned_to: r.assignedTo,
      nature_of_suit: r.suitNature,
      cause: r.cause,
      parties: r.party?.slice(0, 8),
      attorneys: r.attorney?.slice(0, 6),
      docket_id: r.docket_id,
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : undefined,
    }));
    const retrievedAt = new Date().toISOString();
    emitEvidence(ctx, results.filter((r) => r.source).map((r, i) => ({ source: r.source!, kind: "docket_entry", provider: "courtlistener", tool: "search_dockets", query: args.query, rank: i + 1, authorityId: String(r.docket_id), url: r.url, retrievedAt })));
    return { total: data.count ?? results.length, results };
  },
});

export const getDocketEntriesTool = defineTool<{ docket_id: number; limit?: number }>({
  name: "get_docket_entries",
  description: "List recent docket entries (filings) for a docket id returned by search_dockets, newest first.",
  parameters: { type: "object", properties: { docket_id: { type: "integer" }, limit: { type: "integer", description: "Default 25, max 50" } }, required: ["docket_id"] },
  examples: [{ docket_id: 4381529, limit: 25 }],
  timeoutMs: 25_000,
  maxResultChars: 24_000,
  label: (a) => `Reading docket #${a.docket_id}`,
  async execute({ docket_id, limit }, ctx) {
    const data = await fetchJSON<{ results?: Array<{ entry_number?: number; date_filed?: string; description?: string; recap_documents?: Array<{ description?: string; filepath_local?: string; absolute_url?: string; is_available?: boolean }> }> }>(
      `${CL}/docket-entries/?docket=${docket_id}&order_by=-date_filed&page_size=${Math.min(limit ?? 25, 50)}`,
      { headers: clHeaders(), signal: ctx.signal },
    );
    const source = authoritySource("courtlistener", "docket", docket_id);
    emitEvidence(ctx, [{ source, kind: "docket_entry", provider: "courtlistener", tool: "get_docket_entries", rank: 1, authorityId: String(docket_id), retrievedAt: new Date().toISOString() }]);
    return { source, docket_id, entries: (data.results ?? []).map((e) => ({ source: e.entry_number != null ? authoritySource("courtlistener", "docket", docket_id, "entry", e.entry_number) : undefined, entry: e.entry_number, date: e.date_filed, description: e.description?.slice(0, 600), documents: e.recap_documents?.slice(0, 3).map((d) => ({ description: d.description, available: d.is_available, url: d.absolute_url ? `https://www.courtlistener.com${d.absolute_url}` : undefined })) })) };
  },
});

export const verifyCitationsTool = defineTool<{ text: string }>({
  name: "verify_citations",
  description: "Extract every legal citation from a block of text and resolve each against CourtListener. Returns which citations resolve (with case name and court) and which do not, so hallucinated or mistyped cites can be flagged before filing. Resolution proves the citation exists, not that it supports the proposition it is cited for.",
  parameters: { type: "object", properties: { text: { type: "string", description: "Text containing citations such as '550 U.S. 544' or '123 F.3d 456'" } }, required: ["text"] },
  examples: [{ text: "See Bell Atl. Corp. v. Twombly, 550 U.S. 544, 570 (2007); Ashcroft v. Iqbal, 556 U.S. 662 (2009)." }],
  timeoutMs: 30_000,
  maxResultChars: 24_000,
  label: () => "Verifying citations",
  async execute({ text }, ctx) {
    const body = new URLSearchParams({ text: text.slice(0, 60_000) });
    const data = await fetchJSON<Array<{ citation: string; normalized_citations?: string[]; status: number; error_message?: string; clusters?: Array<{ case_name?: string; absolute_url?: string; date_filed?: string; docket_id?: number; id?: number }> }>>(`${CL}/citation-lookup/`, {
      method: "POST",
      headers: { ...clHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: ctx.signal,
    });
    return {
      citations: data.map((c) => ({
        citation: c.citation,
        resolved: c.status === 200 && (c.clusters?.length ?? 0) > 0,
        status: c.status,
        error: c.error_message,
        matches: c.clusters?.slice(0, 3).map((k) => ({ source: k.id != null ? authoritySource("courtlistener", "cluster", k.id) : undefined, case_name: k.case_name, date_filed: k.date_filed, url: k.absolute_url ? `https://www.courtlistener.com${k.absolute_url}` : undefined })),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Regulations: eCFR + Federal Register
// ---------------------------------------------------------------------------

export const searchRegulationsTool = defineTool<{ query: string; title?: number; agency_slug?: string; limit?: number }>({
  name: "search_cfr",
  description: "Full-text search of the current Code of Federal Regulations (eCFR). Returns matching sections with hierarchy (title/part/section), headings, excerpts and a stable `source` (authority://ecfr/title-<t>/section-<s>). Use get_cfr_section to read a section.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "e.g. 'benzene drinking water MCL' or '\"substantial risk\" 8(e)'" },
      title: { type: "integer", description: "Restrict to a CFR title number, e.g. 40 (Environment), 21 (Food & Drugs), 29 (Labor), 17 (Securities)" },
      agency_slug: { type: "string", description: "eCFR agency slug, e.g. 'environmental-protection-agency'" },
      limit: { type: "integer", description: "Default 10, max 20" },
    },
    required: ["query"],
  },
  examples: [{ query: "benzene maximum contaminant level", title: 40, limit: 10 }, { query: "\"substantial risk\" 8(e)", agency_slug: "environmental-protection-agency" }],
  timeoutMs: 25_000,
  label: (a) => `Searching CFR: ${a.query}`,
  async execute(args, ctx) {
    const params = new URLSearchParams({ query: args.query, per_page: String(Math.min(args.limit ?? 10, 20)), page: "1", order: "relevance" });
    if (args.title) params.append("hierarchy[title]", String(args.title));
    if (args.agency_slug) params.append("agency_slugs[]", args.agency_slug);
    const data = await fetchJSON<{ results?: Array<{ hierarchy?: { title?: string; part?: string; section?: string; subpart?: string }; hierarchy_headings?: Record<string, string>; headings?: Record<string, string>; full_text_excerpt?: string; score?: number; starts_on?: string; type?: string }>; meta?: { total_count?: number } }>(`https://www.ecfr.gov/api/search/v1/results?${params}`, { signal: ctx.signal });
    const results = (data.results ?? []).map((r) => ({
      source: r.hierarchy?.section ? authoritySource("ecfr", `title-${r.hierarchy.title}`, `section-${r.hierarchy.section}`) : authoritySource("ecfr", `title-${r.hierarchy?.title}`, `part-${r.hierarchy?.part}`),
      cite: r.hierarchy?.section ? `${r.hierarchy.title} C.F.R. § ${r.hierarchy.section}` : `${r.hierarchy?.title} C.F.R. Part ${r.hierarchy?.part}`,
      title: r.hierarchy?.title,
      part: r.hierarchy?.part,
      section: r.hierarchy?.section,
      heading: r.headings?.section ?? r.headings?.part,
      part_heading: r.headings?.part,
      excerpt: r.full_text_excerpt?.replace(/<\/?[^>]+>/g, "").replace(/\s+/g, " ").trim(),
      effective: r.starts_on,
      url: r.hierarchy?.section ? `https://www.ecfr.gov/current/title-${r.hierarchy.title}/section-${r.hierarchy.section}` : `https://www.ecfr.gov/current/title-${r.hierarchy?.title}/part-${r.hierarchy?.part}`,
    }));
    const retrievedAt = new Date().toISOString();
    emitEvidence(ctx, results.map((r, i) => ({ source: r.source, kind: "regulation", provider: "ecfr", tool: "search_cfr", query: args.query, rank: i + 1, authorityId: r.cite, url: r.url, retrievedAt })));
    for (const r of results.slice(0, 4)) ctx.emit({ type: "citation", citation: { title: `${r.cite} — ${r.heading ?? ""}`, url: r.url, cite: r.cite, source: "regulation" } });
    return { total: data.meta?.total_count ?? results.length, results };
  },
});

export const getCfrSectionTool = defineTool<{ title: number; section: string; max_chars?: number; offset?: number }>({
  name: "get_cfr_section",
  description: "Read the current text of a CFR section, e.g. title 40 section '141.60'. Returns a text window with `window.next_offset` for the next window.",
  parameters: { type: "object", properties: { title: { type: "integer" }, section: { type: "string", description: "Section number like '141.60' or '720.3'" }, max_chars: { type: "integer", description: "Window size, default 30000" }, offset: { type: "integer", description: "Character offset of the window" } }, required: ["title", "section"] },
  examples: [{ title: 40, section: "141.60" }, { title: 21, section: "314.50", max_chars: 20000, offset: 20000 }],
  timeoutMs: 30_000,
  maxResultChars: 36_000,
  label: (a) => `Reading ${a.title} C.F.R. § ${a.section}`,
  async execute({ title, section, max_chars, offset }, ctx) {
    const d = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
    const part = section.split(".")[0];
    const url = `https://www.ecfr.gov/api/versioner/v1/full/${d}/title-${title}.xml?part=${encodeURIComponent(part)}&section=${encodeURIComponent(section)}`;
    const { text } = await fetchText(url, { signal: ctx.signal });
    const body = stripXml(text);
    const w = windowed(body, offset, max_chars ?? 30_000);
    const source = authoritySource("ecfr", `title-${title}`, `section-${section}`);
    const canonical = `https://www.ecfr.gov/current/title-${title}/section-${section}`;
    emitEvidence(ctx, [{ source, kind: "regulation", provider: "ecfr", tool: "get_cfr_section", rank: 1, authorityId: `${title} C.F.R. § ${section}`, url: canonical, retrievedAt: new Date().toISOString() }]);
    return { source, cite: `${title} C.F.R. § ${section}`, url: canonical, as_of: d, text: w.text, window: w.window };
  },
});

export const searchFederalRegisterTool = defineTool<{ query: string; agency?: string; document_type?: string; published_after?: string; published_before?: string; limit?: number }>({
  name: "search_federal_register",
  description: "Search the Federal Register (proposed rules, final rules, notices, presidential documents). Returns titles, agencies, publication dates, citations, abstracts, links and a stable `source` (authority://federalregister/<document_number>).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      agency: { type: "string", description: "Agency slug e.g. 'environmental-protection-agency', 'food-and-drug-administration', 'securities-and-exchange-commission'" },
      document_type: { type: "string", description: "RULE | PRORULE | NOTICE | PRESDOCU" },
      published_after: { type: "string", description: "ISO date YYYY-MM-DD" },
      published_before: { type: "string", description: "ISO date YYYY-MM-DD" },
      limit: { type: "integer", description: "Default 10, max 20" },
    },
    required: ["query"],
  },
  examples: [{ query: "prescription drug labeling", agency: "food-and-drug-administration", document_type: "RULE", published_after: "2024-01-01", limit: 10 }],
  timeoutMs: 25_000,
  label: (a) => `Searching Federal Register: ${a.query}`,
  async execute(args, ctx) {
    const params = new URLSearchParams({ "conditions[term]": args.query, per_page: String(Math.min(args.limit ?? 10, 20)), order: "relevance" });
    if (args.agency) params.append("conditions[agencies][]", args.agency);
    if (args.document_type) params.append("conditions[type][]", args.document_type);
    if (args.published_after) params.set("conditions[publication_date][gte]", args.published_after);
    if (args.published_before) params.set("conditions[publication_date][lte]", args.published_before);
    for (const f of ["title", "type", "abstract", "document_number", "html_url", "pdf_url", "publication_date", "agencies", "citation", "effective_on", "comments_close_on", "docket_ids"]) params.append("fields[]", f);
    const data = await fetchJSON<{ count?: number; results?: Array<{ title: string; type: string; abstract?: string; document_number: string; html_url: string; pdf_url?: string; publication_date: string; agencies?: Array<{ name?: string; raw_name?: string }>; citation?: string; effective_on?: string; comments_close_on?: string; docket_ids?: string[] }> }>(`https://www.federalregister.gov/api/v1/documents.json?${params}`, { signal: ctx.signal });
    const results = (data.results ?? []).map((r) => ({ source: authoritySource("federalregister", r.document_number), title: r.title, type: r.type, agencies: r.agencies?.map((a) => a.name ?? a.raw_name).filter(Boolean), published: r.publication_date, citation: r.citation, effective_on: r.effective_on, comments_close_on: r.comments_close_on, document_number: r.document_number, docket_ids: r.docket_ids, abstract: r.abstract?.slice(0, 800), url: r.html_url, pdf_url: r.pdf_url }));
    const retrievedAt = new Date().toISOString();
    emitEvidence(ctx, results.map((r, i) => ({ source: r.source, kind: "register_notice", provider: "federalregister", tool: "search_federal_register", query: args.query, rank: i + 1, authorityId: r.document_number, url: r.url, retrievedAt })));
    for (const r of results.slice(0, 4)) ctx.emit({ type: "citation", citation: { title: r.title, url: r.url, cite: r.citation, source: "federal register" } });
    return { total: data.count ?? results.length, results };
  },
});

export const getFederalRegisterDocumentTool = defineTool<{ document_number: string; max_chars?: number; offset?: number }>({
  name: "get_federal_register_document",
  description: "Read the full text of a Federal Register document by document number (e.g. '2024-07773'). Returns a text window with `window.next_offset` for the next window.",
  parameters: { type: "object", properties: { document_number: { type: "string" }, max_chars: { type: "integer", description: "Window size, default 40000" }, offset: { type: "integer", description: "Character offset of the window" } }, required: ["document_number"] },
  examples: [{ document_number: "2024-07773" }, { document_number: "2024-07773", max_chars: 40000, offset: 40000 }],
  timeoutMs: 30_000,
  maxResultChars: 48_000,
  label: (a) => `Reading FR doc ${a.document_number}`,
  async execute({ document_number, max_chars, offset }, ctx) {
    const meta = await fetchJSON<{ title: string; html_url: string; body_html_url?: string; full_text_xml_url?: string; raw_text_url?: string; publication_date?: string; citation?: string }>(`https://www.federalregister.gov/api/v1/documents/${encodeURIComponent(document_number)}.json`, { signal: ctx.signal });
    const src = meta.raw_text_url ?? meta.body_html_url ?? meta.full_text_xml_url;
    let text = "";
    if (src) {
      const r = await fetchText(src, { signal: ctx.signal });
      text = /xml/i.test(r.contentType) ? stripXml(r.text) : /html/i.test(r.contentType) ? htmlToText(r.text, { maxChars: 500_000 }).text : r.text;
    }
    const w = windowed(text, offset, max_chars ?? 40_000);
    const source = authoritySource("federalregister", document_number);
    emitEvidence(ctx, [{ source, kind: "register_notice", provider: "federalregister", tool: "get_federal_register_document", rank: 1, authorityId: document_number, url: meta.html_url, retrievedAt: new Date().toISOString() }]);
    return { source, title: meta.title, citation: meta.citation, published: meta.publication_date, url: meta.html_url, text: w.text, window: w.window };
  },
});

// ---------------------------------------------------------------------------
// Statutes / legislative: GovInfo (U.S. Code, Public Laws, Congressional bills)
// ---------------------------------------------------------------------------

export const searchStatutesTool = defineTool<{ query: string; collection?: string; limit?: number }>({
  name: "search_statutes",
  description: "Search GovInfo for the U.S. Code (USCODE), Public Laws (PLAW), Statutes at Large (STATUTE), Congressional bills (BILLS) and CFR (CFR). Returns titles, package ids, dates, text/PDF links and a stable `source` (authority://govinfo/<packageId>[/<granuleId>]). Best for locating statutory sections such as '15 U.S.C. 2607(e)'.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "e.g. '15 U.S.C. 2607 substantial risk' or 'Toxic Substances Control Act section 8(e)'" },
      collection: { type: "string", description: "USCODE (default) | PLAW | STATUTE | BILLS | CFR | CRPT" },
      limit: { type: "integer", description: "Default 10, max 20" },
    },
    required: ["query"],
  },
  examples: [{ query: "15 U.S.C. 2607 substantial risk", collection: "USCODE", limit: 10 }, { query: "Toxic Substances Control Act section 8(e)" }],
  timeoutMs: 25_000,
  label: (a) => `Searching statutes: ${a.query}`,
  async execute(args, ctx) {
    const key = process.env.GOVINFO_API_KEY?.trim() || "DEMO_KEY";
    const collectionCode = (args.collection ?? "USCODE").toUpperCase();
    const data = await fetchJSON<{ count?: number; results?: Array<{ title?: string; packageId?: string; granuleId?: string; dateIssued?: string; collectionCode?: string; download?: { txtLink?: string; pdfLink?: string; xmlLink?: string }; resultLink?: string; teaser?: string }> }>(`https://api.govinfo.gov/search?api_key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `collection:${collectionCode} ${args.query}`, pageSize: Math.min(args.limit ?? 10, 20), offsetMark: "*", sorts: [{ field: "score", sortOrder: "DESC" }] }),
      signal: ctx.signal,
    });
    const results = (data.results ?? []).map((r) => ({ source: r.packageId ? authoritySource("govinfo", ...(r.granuleId ? [r.packageId, r.granuleId] : [r.packageId])) : undefined, title: r.title, package_id: r.packageId, granule_id: r.granuleId, date: r.dateIssued, collection: r.collectionCode, teaser: r.teaser?.replace(/<[^>]+>/g, ""), text_url: r.download?.txtLink, pdf_url: r.download?.pdfLink, url: r.resultLink }));
    const retrievedAt = new Date().toISOString();
    emitEvidence(ctx, results.filter((r) => r.source).map((r, i) => ({ source: r.source!, kind: "statute", provider: "govinfo", tool: "search_statutes", query: args.query, rank: i + 1, authorityId: r.granule_id ?? r.package_id, url: r.url, retrievedAt })));
    return { total: data.count ?? results.length, results, note: "Use fetch_url on text_url to read the section text." };
  },
});

// ---------------------------------------------------------------------------
// Research-engine additions (additive; LEGAL_TOOLS above is unchanged for existing consumers).
// ---------------------------------------------------------------------------

/** Paragraph split shared with the research reader (src/modules/search/engine/paragraphs.ts): newline runs, trimmed, empties dropped. */
export function splitOpinionParagraphs(text: string): string[] {
  return (text ?? "").split(/\n+/).map((p) => p.trim()).filter(Boolean);
}

async function opinionPlainText(opinionId: number, signal?: AbortSignal): Promise<{ text: string; url?: string }> {
  const data = await fetchJSON<{ plain_text?: string; html_with_citations?: string; html?: string; html_lawbox?: string; html_columbia?: string; xml_harvard?: string; absolute_url?: string }>(`${CL}/opinions/${opinionId}/`, { headers: clHeaders(), signal });
  const text = data.plain_text?.trim() || htmlToText(data.html_with_citations ?? data.html ?? data.html_lawbox ?? data.html_columbia ?? "", { maxChars: 2_000_000 }).text || stripXml(data.xml_harvard ?? "");
  return { text, url: data.absolute_url ? `https://www.courtlistener.com${data.absolute_url}` : undefined };
}

export const getOpinionTool = defineTool<{ opinion_id: number; start_paragraph?: number; count?: number }>({
  name: "get_opinion",
  description: "Read a court opinion by CourtListener opinion id in numbered paragraph windows (¶1, ¶2 …, the same numbering the research reader shows). Use it to quote accurately and give pinpoint cites as [n ¶k]. Returns up to `count` paragraphs starting at `start_paragraph`, with `next_start` for the next window.",
  parameters: { type: "object", properties: { opinion_id: { type: "integer" }, start_paragraph: { type: "integer", description: "1-based paragraph to start at (default 1)" }, count: { type: "integer", description: "Paragraphs to return (default 40, max 120)" } }, required: ["opinion_id"] },
  examples: [{ opinion_id: 112120 }, { opinion_id: 112120, start_paragraph: 41, count: 40 }],
  timeoutMs: 30_000,
  maxResultChars: 48_000,
  label: (a) => `Reading opinion #${a.opinion_id}${a.start_paragraph ? ` from ¶${a.start_paragraph}` : ""}`,
  async execute({ opinion_id, start_paragraph, count }, ctx) {
    const { text, url } = await opinionPlainText(opinion_id, ctx.signal);
    const paras = splitOpinionParagraphs(text);
    const start = Math.max(1, Math.floor(start_paragraph ?? 1));
    const n = Math.min(Math.max(1, Math.floor(count ?? 40)), 120);
    const slice = paras.slice(start - 1, start - 1 + n).map((p, i) => ({ n: start + i, text: p.length > 4000 ? p.slice(0, 4000) + truncationMarker(p.length - 4000) : p }));
    const source = authoritySource("courtlistener", "opinion", opinion_id);
    emitEvidence(ctx, [{ source, kind: "opinion", provider: "courtlistener", tool: "get_opinion", rank: 1, authorityId: String(opinion_id), url, retrievedAt: new Date().toISOString() }]);
    return { source, opinion_id, url, total_paragraphs: paras.length, paragraphs: slice, next_start: start - 1 + n < paras.length ? start + n : null };
  },
});

/** Query that restricts citing opinions to those using negative-treatment language. */
export const NEGATIVE_TREATMENT_QUERY = '(overrul* OR abrogat* OR "declined to follow" OR "decline to follow" OR disapprov* OR "called into doubt" OR "superseded by statute" OR "no longer good law" OR "limited to its facts")';

export interface CitingOpinionRow { source?: string; case_name?: string; citations: string[]; court_id?: string; date_filed?: string; snippet: string; opinion_id?: number; url?: string }

function citingRows(data: CLSearchResult, limit: number): CitingOpinionRow[] {
  return (data.results ?? []).slice(0, limit).map((r) => ({
    source: r.opinions?.[0]?.id != null ? authoritySource("courtlistener", "opinion", r.opinions[0].id) : r.cluster_id != null ? authoritySource("courtlistener", "cluster", r.cluster_id) : undefined,
    case_name: r.caseName,
    citations: r.citation ?? [],
    court_id: r.court_id,
    date_filed: r.dateFiled,
    snippet: (r.opinions?.[0]?.snippet ?? r.snippet ?? "").replace(/<\/?mark>/g, "").replace(/\s+/g, " ").trim().slice(0, 500),
    opinion_id: r.opinions?.[0]?.id,
    url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : undefined,
  }));
}

/** Citing opinions of an opinion plus those that use negative-treatment language. A signal for review, not a citator. */
export async function findCitingOpinions(opinionId: number, opts: { limit?: number; courts?: string; signal?: AbortSignal } = {}): Promise<{ citing_count: number; negative_count: number; citing: CitingOpinionRow[]; negative: CitingOpinionRow[] }> {
  const limit = Math.min(opts.limit ?? 8, 20);
  const base = `cites:(${Math.floor(opinionId)})`;
  const params = (q: string) => { const p = new URLSearchParams({ q, type: "o", order_by: "dateFiled desc" }); if (opts.courts) p.set("court", opts.courts); return p; };
  const [all, neg] = await Promise.all([
    fetchJSON<CLSearchResult>(`${CL}/search/?${params(base)}`, { headers: clHeaders(), signal: opts.signal }),
    fetchJSON<CLSearchResult>(`${CL}/search/?${params(`${base} AND ${NEGATIVE_TREATMENT_QUERY}`)}`, { headers: clHeaders(), signal: opts.signal }),
  ]);
  return { citing_count: all.count ?? (all.results?.length ?? 0), negative_count: neg.count ?? (neg.results?.length ?? 0), citing: citingRows(all, limit), negative: citingRows(neg, limit) };
}

export const findCitingOpinionsTool = defineTool<{ opinion_id: number; courts?: string; limit?: number }>({
  name: "find_citing_opinions",
  description: "Find opinions that cite a given opinion (CourtListener `cites:` search) and, separately, the citing opinions that use negative-treatment language (overruled, abrogated, declined to follow, called into doubt…). Use it to flag authority whose treatment needs review. It is a signal, not a citator: never state that an authority is good law from it.",
  parameters: { type: "object", properties: { opinion_id: { type: "integer", description: "CourtListener opinion id of the cited authority" }, courts: { type: "string", description: "Optional space-separated court ids to limit citing courts" }, limit: { type: "integer", description: "Rows per list, default 8, max 20" } }, required: ["opinion_id"] },
  examples: [{ opinion_id: 112120, limit: 8 }, { opinion_id: 112120, courts: "ca4 dsc" }],
  timeoutMs: 25_000,
  maxResultChars: 20_000,
  label: (a) => `Finding opinions citing #${a.opinion_id}`,
  async execute({ opinion_id, courts, limit }, ctx) {
    const r = await findCitingOpinions(opinion_id, { courts, limit, signal: ctx.signal });
    const note = r.negative_count > 0 ? `Treatment: possibly negative, review — ${r.negative_count} citing opinion(s) use negative-treatment language.` : `No citing opinion among ${r.citing_count} uses negative-treatment language in the search index. Not a citator result.`;
    return { source: authoritySource("courtlistener", "opinion", opinion_id), ...r, treatment_note: note };
  },
});

export type CitationResolution =
  | { citation: string; state: "resolved"; source: string; case_name?: string; date_filed?: string; url?: string; cluster_id: number }
  | { citation: string; state: "ambiguous"; candidates: { source?: string; case_name?: string; date_filed?: string; url?: string }[]; reason: string }
  | { citation: string; state: "unresolved"; reason: string };

type LookupEntry = { citation: string; status: number; error_message?: string; clusters?: Array<{ case_name?: string; absolute_url?: string; date_filed?: string; id?: number }> };

/**
 * Map CourtListener citation-lookup entries to resolutions (constitution §23: never substitute).
 * Exactly one matching cluster → resolved; several → ambiguous (no pick); none/error → unresolved.
 */
export function resolutionFromLookup(entries: LookupEntry[]): CitationResolution[] {
  return entries.map((c): CitationResolution => {
    const clusters = (c.clusters ?? []).filter((k) => k && k.id != null);
    const row = (k: NonNullable<LookupEntry["clusters"]>[number]) => ({ source: k.id != null ? authoritySource("courtlistener", "cluster", k.id) : undefined, case_name: k.case_name, date_filed: k.date_filed, url: k.absolute_url ? `https://www.courtlistener.com${k.absolute_url}` : undefined });
    if (c.status === 200 && clusters.length === 1) { const k = clusters[0]; return { citation: c.citation, state: "resolved", cluster_id: k.id!, ...row(k), source: authoritySource("courtlistener", "cluster", k.id!) }; }
    if (clusters.length > 1) return { citation: c.citation, state: "ambiguous", candidates: clusters.slice(0, 5).map(row), reason: `${clusters.length} reported decisions share this citation; none was chosen` };
    return { citation: c.citation, state: "unresolved", reason: c.error_message || (c.status === 404 ? "no reported decision has this citation" : `lookup status ${c.status}`) };
  });
}

export const resolveCitationTool = defineTool<{ citation: string }>({
  name: "resolve_citation",
  description: "Resolve a reporter citation (e.g. '487 U.S. 500') to the reported decision on CourtListener. Returns state resolved (with a stable source id), ambiguous (several candidates; none chosen) or unresolved. An unresolved citation stays unresolved: never substitute a similar case.",
  parameters: { type: "object", properties: { citation: { type: "string", description: "One reporter citation, e.g. '860 F.3d 249'" } }, required: ["citation"] },
  examples: [{ citation: "487 U.S. 500" }, { citation: "860 F.3d 249" }],
  timeoutMs: 20_000,
  label: (a) => `Resolving ${a.citation}`,
  async execute({ citation }, ctx) {
    const body = new URLSearchParams({ text: citation.slice(0, 400) });
    const data = await fetchJSON<LookupEntry[]>(`${CL}/citation-lookup/`, { method: "POST", headers: { ...clHeaders(), "Content-Type": "application/x-www-form-urlencoded" }, body, signal: ctx.signal });
    const rows = resolutionFromLookup(Array.isArray(data) ? data : []);
    return rows[0] ?? { citation, state: "unresolved", reason: "no citation was recognised in the input" };
  },
});

/** Hosts the research fetch tool may read by default (official legal sources). Open-web fetches require web scope. */
export const LEGAL_FETCH_ALLOWLIST = [
  "courtlistener.com", "ecfr.gov", "federalregister.gov", "govinfo.gov", "uscode.house.gov", "congress.gov", "regulations.gov", "supremecourt.gov", "uscourts.gov",
  "law.cornell.edu", "justice.gov", "epa.gov", "fda.gov", "sec.gov", "ftc.gov", "osha.gov", "dol.gov", "nlrb.gov", "cpsc.gov", "ca.gov", "ny.gov", "illinois.gov", "texas.gov", "delaware.gov", "courts.ca.gov", "nycourts.gov",
];

/** Whether a URL's host is on the legal allowlist (exact host or a subdomain of an allowlisted domain). */
export function isLegalFetchHost(url: string, allow: string[] = LEGAL_FETCH_ALLOWLIST): boolean {
  let host = "";
  try { const u = new URL(url); if (u.protocol !== "https:" && u.protocol !== "http:") return false; host = u.hostname.toLowerCase(); } catch { return false; }
  return allow.some((d) => host === d || host.endsWith(`.${d}`));
}

export const getStatuteSectionTool = defineTool<{ title: number; section: string; max_chars?: number; offset?: number }>({
  name: "get_statute_section",
  description: "Read the current text of a U.S. Code section from GovInfo, e.g. title 15 section '2607'. Returns a text window with a stable source (authority://govinfo/uscode/<title>/<section>) and `window.next_offset`.",
  parameters: { type: "object", properties: { title: { type: "integer" }, section: { type: "string", description: "Section number, e.g. '2607' or '1442'" }, max_chars: { type: "integer", description: "Window size, default 30000" }, offset: { type: "integer" } }, required: ["title", "section"] },
  examples: [{ title: 15, section: "2607" }, { title: 28, section: "1442", max_chars: 20000 }],
  timeoutMs: 30_000,
  maxResultChars: 36_000,
  label: (a) => `Reading ${a.title} U.S.C. § ${a.section}`,
  async execute({ title, section, max_chars, offset }, ctx) {
    const sec = section.replace(/^§+\s*/, "").split("(")[0].trim();
    const url = `https://www.govinfo.gov/link/uscode/${encodeURIComponent(String(title))}/${encodeURIComponent(sec)}?link-type=html`;
    const r = await fetchText(url, { signal: ctx.signal, egress: { name: "tool:get_statute_section", allowHosts: ["govinfo.gov"] } });
    const body = /html/i.test(r.contentType) ? htmlToText(r.text, { maxChars: 1_000_000 }).text : r.text;
    const w = windowed(body, offset, max_chars ?? 30_000);
    const source = authoritySource("govinfo", "uscode", title, sec);
    emitEvidence(ctx, [{ source, kind: "statute", provider: "govinfo", tool: "get_statute_section", rank: 1, authorityId: `${title} U.S.C. § ${sec}`, url: r.finalUrl, retrievedAt: new Date().toISOString() }]);
    return { source, cite: `${title} U.S.C. § ${sec}`, url: r.finalUrl, text: w.text, window: w.window };
  },
});

/** Research-engine tool set: the legal tools plus paragraph reads, citing references, citation resolution and statute sections. */
export const RESEARCH_LEGAL_TOOLS = [searchCaseLawTool, getOpinionTool, findCitingOpinionsTool, resolveCitationTool, searchDocketsTool, getDocketEntriesTool, verifyCitationsTool, searchRegulationsTool, getCfrSectionTool, searchFederalRegisterTool, getFederalRegisterDocumentTool, searchStatutesTool, getStatuteSectionTool];

export const LEGAL_TOOLS = [searchCaseLawTool, getOpinionTextTool, searchDocketsTool, getDocketEntriesTool, verifyCitationsTool, searchRegulationsTool, getCfrSectionTool, searchFederalRegisterTool, getFederalRegisterDocumentTool, searchStatutesTool];
