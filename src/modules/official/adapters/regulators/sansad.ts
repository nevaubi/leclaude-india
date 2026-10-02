import "server-only";
import type { AdapterContext, SourceAdapter } from "../../adapter";
import type { DiscoveredDoc, SourceDef } from "../../types";
import {
  GOV_TERMS, clean, getJsonLoose, printedDate, safeUrl, walkStreams,
  type CursorMode, type ListingPage, type ListingStream, type SequenceStream, type StreamSpec,
} from "./common";

/**
 * Digital Sansad: Parliament questions, debates and committee reports. Verified 2026-10-02:
 *
 * Lok Sabha questions (LS 13+): GET https://sansad.in/api_ls/question/qetFilteredQuestionsAns
 *   ?loksabhaNo&sessionNumber&pageNo&pageSize&locale=en  → [{listOfQuestions:[…], totalRecordSize}]
 *   Sessions: GET https://sansad.in/api_ls/business/AllLoksabhaAndSessionDates.
 *
 * eLibrary (DSpace 7.4): GET https://elibrary.sansad.in/server/api/discover/search/objects?scope=<collection>
 *   &sort=dc.date.accessioned,DESC&page&size; files via /server/api/core/items/{uuid}/bundles?embed=bitstreams. The TEXT
 *   bundle (Apache Tika extraction, no page markers) is preferred as the document text (mime text/plain); the ORIGINAL
 *   PDF stays in meta.originalPdfUrl for checking quotes.
 *
 * Rajya Sabha questions: GET https://rsdoc.nic.in/Question/Search_Questions?whereclause=…
 *   SECURITY: this endpoint accepts a raw SQL predicate in `whereclause`. Only the exact equality shape the official
 *   Rajya Sabha UI sends is ever used — ses_no=<integer> and qno='<integer>' and qtype='STARRED'|'UNSTARRED' — built
 *   from validated integers and a closed enum (see `rsWhereClause`). Never compose any other SQL, never pass user text.
 *   Sessions: GET https://sansad.in/api_rs/business/getSessionsList?docType=SQ.
 */

const LS_API = "https://sansad.in/api_ls";
const RS_API = "https://sansad.in/api_rs";
const RSDOC = "https://rsdoc.nic.in";
const ELIB = "https://elibrary.sansad.in";
const FILE_HOSTS = ["sansad.in"];
const LS_PAGE = 50;
const ELIB_PAGE = 20;

/** eLibrary collections (collection UUID resolved from handle 123456789/28102 and /28106 on 2026-10-02). */
export const ELIB_COLLECTIONS = {
  committee: { uuid: "571cd23f-4973-410f-a639-dabb4cbd805b", handle: "123456789/28102", kind: "committee_report" as const, label: "Parliamentary Committee Reports" },
  debates: { uuid: "b2770639-c57b-4ba3-a9f1-57761c60d195", handle: "123456789/28106", kind: "parliament_debate" as const, label: "Lok Sabha Debates (Text)" },
};

export type RsQuestionType = "STARRED" | "UNSTARRED";
const RS_TYPES: RsQuestionType[] = ["STARRED", "UNSTARRED"];

/** The only whereclause ever sent to rsdoc.nic.in (the official UI's exact equality form). Throws on anything else. */
export function rsWhereClause(session: number, qno: number, type: RsQuestionType): string {
  if (!Number.isInteger(session) || session < 1 || session > 9999) throw new Error("invalid Rajya Sabha session");
  if (!Number.isInteger(qno) || qno < 1 || qno > 99999) throw new Error("invalid Rajya Sabha question number");
  if (type !== "STARRED" && type !== "UNSTARRED") throw new Error("invalid Rajya Sabha question type");
  return `ses_no=${session} and qno='${qno}' and qtype='${type}'`;
}

export function rsQuestionUrl(session: number, qno: number, type: RsQuestionType): string {
  return `${RSDOC}/Question/Search_Questions?whereclause=${encodeURIComponent(rsWhereClause(session, qno, type))}`;
}

export function lsQuestionsUrl(ls: number, session: number, page: number): string {
  return `${LS_API}/question/qetFilteredQuestionsAns?loksabhaNo=${ls}&sessionNumber=${session}&pageNo=${page}&pageSize=${LS_PAGE}&locale=en`;
}

export function elibSearchUrl(collectionUuid: string, page: number): string {
  return `${ELIB}/server/api/discover/search/objects?scope=${collectionUuid}&sort=dc.date.accessioned,DESC&page=${page}&size=${ELIB_PAGE}`;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// ---- Lok Sabha ----------------------------------------------------------------------------------------------------

interface LsQuestion {
  quesNo?: number;
  subjects?: string;
  lokNo?: string;
  member?: string[];
  ministry?: string;
  type?: string;
  date?: string;
  questionsFilePath?: string | null;
  questionsFilePathHindi?: string | null;
  questionsDocPath?: string | null;
  sessionNo?: string;
}

export function parseLsQuestions(answer: unknown): { items: DiscoveredDoc[]; total: number } | null {
  const first = Array.isArray(answer) ? (answer[0] as { listOfQuestions?: LsQuestion[]; totalRecordSize?: number } | undefined) : undefined;
  if (!first || !Array.isArray(first.listOfQuestions)) return null;
  const items: DiscoveredDoc[] = [];
  for (const q of first.listOfQuestions) {
    const fileUrl = safeUrl(q.questionsFilePath, "https://sansad.in/", FILE_HOSTS);
    if (!fileUrl || typeof q.quesNo !== "number") continue;
    const type = clean(q.type).toUpperCase() || null;
    const subject = clean(q.subjects);
    items.push({
      sourceId: "sansad",
      kind: "parliament_question",
      url: fileUrl,
      fileUrl,
      title: `Lok Sabha ${type ? `${titleCase(type)} ` : ""}Question No. ${q.quesNo}${subject ? `: ${subject}` : ""}`,
      docDate: printedDate(q.date),
      mime: "application/pdf",
      meta: {
        forum: "parliament",
        house: "lok_sabha",
        lokSabha: Number(q.lokNo) || null,
        session: Number(q.sessionNo) || null,
        questionNo: q.quesNo,
        questionType: type,
        ministry: clean(q.ministry) || null,
        members: Array.isArray(q.member) ? q.member.map(clean).filter(Boolean) : [],
        answerDate: printedDate(q.date),
        fileUrlHindi: safeUrl(q.questionsFilePathHindi, "https://sansad.in/", FILE_HOSTS),
        docUrl: safeUrl(q.questionsDocPath, "https://sansad.in/", FILE_HOSTS),
      },
    });
  }
  return { items, total: Number(first.totalRecordSize) || 0 };
}

interface LsSessions { loksabha?: number; sessions?: { sessionNo?: number }[] }

/** (Lok Sabha, session) pairs newest first, LS 13+ (what the questions API serves). */
export function lsSessionPairs(answer: unknown): { ls: number; session: number }[] {
  const out: { ls: number; session: number }[] = [];
  for (const l of Array.isArray(answer) ? (answer as LsSessions[]) : []) {
    if (!Number.isInteger(l.loksabha) || (l.loksabha as number) < 13) continue;
    for (const s of l.sessions ?? []) if (Number.isInteger(s.sessionNo) && (s.sessionNo as number) > 0) out.push({ ls: l.loksabha as number, session: s.sessionNo as number });
  }
  return out.sort((a, b) => b.ls - a.ls || b.session - a.session);
}

function lsStream(ls: number, session: number): ListingStream {
  return {
    kind: "listing",
    id: `ls:${ls}:${session}`,
    backfill: true,
    firstPage: 1,
    incrementalPages: 4,
    async fetch(page: number, ctx: AdapterContext): Promise<ListingPage> {
      const parsed = parseLsQuestions(await ctx.fetchJson(lsQuestionsUrl(ls, session, page)));
      if (!parsed) return { items: [], last: true, notes: ["answer had no question list"] };
      return { items: parsed.items, last: !parsed.items.length || page * LS_PAGE >= parsed.total };
    },
  };
}

// ---- Rajya Sabha ---------------------------------------------------------------------------------------------------

interface RsQuestion {
  qslno?: number;
  qtitle?: string;
  qtype?: string;
  ans_date?: string;
  qno?: number;
  shri?: string;
  name?: string;
  min_name?: string;
  ses_no?: number;
  status?: string;
  files?: string | null;
  hindifiles?: string | null;
}

/** The answer for exactly (session, qno, type); null when absent (never another question). */
export function parseRsQuestion(answer: unknown, session: number, qno: number, type: RsQuestionType): DiscoveredDoc | null {
  const list = Array.isArray(answer) ? (answer as RsQuestion[]) : [];
  const q = list.find((x) => Number(x.ses_no) === session && Number(x.qno) === qno && clean(x.qtype).toUpperCase() === type);
  if (!q) return null;
  const fileUrl = safeUrl(q.files, "https://sansad.in/", FILE_HOSTS);
  if (!fileUrl) return null;
  const title = clean(q.qtitle);
  const member = clean(`${q.shri ?? ""} ${q.name ?? ""}`) || null;
  return {
    sourceId: "sansad",
    kind: "parliament_question",
    url: fileUrl,
    fileUrl,
    title: `Rajya Sabha ${titleCase(type)} Question No. ${qno}${title ? `: ${title}` : ""}`,
    docDate: printedDate(q.ans_date),
    mime: "application/pdf",
    meta: {
      forum: "parliament",
      house: "rajya_sabha",
      session,
      questionNo: qno,
      questionType: type,
      ministry: clean(q.min_name) || null,
      members: member ? [member] : [],
      answerDate: printedDate(q.ans_date),
      status: clean(q.status) || null,
      rsSerial: q.qslno ?? null,
      fileUrlHindi: safeUrl(q.hindifiles, "https://sansad.in/", FILE_HOSTS),
    },
  };
}

function rsStream(session: number, type: RsQuestionType): SequenceStream {
  return {
    kind: "sequence",
    id: `rs:${session}:${type}`,
    backfill: true,
    start: 1,
    maxMisses: 5,
    incrementalMax: 300,
    async fetch(qno: number, ctx: AdapterContext): Promise<DiscoveredDoc | null> {
      const ans = await getJsonLoose<unknown>(ctx, rsQuestionUrl(session, qno, type));
      return parseRsQuestion(ans, session, qno, type);
    },
  };
}

// ---- eLibrary (DSpace) ---------------------------------------------------------------------------------------------

type MetaValues = Record<string, { value?: string }[] | undefined>;
const mv = (m: MetaValues | undefined, k: string): string | null => clean(m?.[k]?.[0]?.value) || null;

interface DspaceObject { uuid?: string; handle?: string; name?: string; metadata?: MetaValues }

export function parseElibSearch(answer: unknown, collection: keyof typeof ELIB_COLLECTIONS): { items: DiscoveredDoc[]; totalPages: number } | null {
  const a = answer as { _embedded?: { searchResult?: { _embedded?: { objects?: { _embedded?: { indexableObject?: DspaceObject } }[] }; page?: { totalPages?: number } } } } | null;
  const sr = a?._embedded?.searchResult;
  if (!sr || !Array.isArray(sr._embedded?.objects)) return null;
  const col = ELIB_COLLECTIONS[collection];
  const items: DiscoveredDoc[] = [];
  for (const o of sr._embedded!.objects!) {
    const it = o._embedded?.indexableObject;
    if (!it?.uuid || !/^[0-9a-f-]{36}$/i.test(it.uuid)) continue;
    const m = it.metadata;
    const handleUrl = safeUrl(mv(m, "dc.identifier.uri"), ELIB, ["elibrary.sansad.in"]) ?? (it.handle ? `${ELIB}/handle/${it.handle}` : null);
    if (!handleUrl) continue;
    const issued = mv(m, "dc.date.issued");
    items.push({
      sourceId: "sansad",
      kind: col.kind,
      url: handleUrl,
      fileUrl: null,
      title: mv(m, "dc.title") ?? clean(it.name) ?? handleUrl,
      docDate: printedDate(issued),
      meta: {
        forum: "parliament",
        house: "lok_sabha",
        collection: col.label,
        itemUuid: it.uuid,
        handle: it.handle ?? null,
        committee: mv(m, "dc.contributor.committeename"),
        reportNumber: mv(m, "dc.identifier.reportnumber"),
        lokSabha: Number(mv(m, "dc.identifier.loksabhanumber")) || null,
        session: mv(m, "dc.identifier.sessionnumber"),
        category: mv(m, "dc.type"),
        language: mv(m, "dc.language.iso"),
        dateIssuedPrinted: issued,
        via: "elibrary",
      },
    });
  }
  return { items, totalPages: Number(sr.page?.totalPages) || 0 };
}

interface Bitstream { name?: string; sizeBytes?: number; _links?: { content?: { href?: string } } }
interface Bundle { name?: string; _embedded?: { bitstreams?: { _embedded?: { bitstreams?: Bitstream[] } } } }

/** TEXT bundle content URL (preferred) and the ORIGINAL PDF content URL from an item's bundles. */
export function elibFiles(answer: unknown): { textUrl: string | null; pdfUrl: string | null; textBytes: number | null } {
  const bundles = ((answer as { _embedded?: { bundles?: Bundle[] } } | null)?._embedded?.bundles ?? []) as Bundle[];
  const first = (name: string, re: RegExp) => {
    const b = bundles.find((x) => x.name === name)?._embedded?.bitstreams?._embedded?.bitstreams ?? [];
    const bs = b.find((x) => re.test(x.name ?? "")) ?? null;
    return bs ? { url: safeUrl(bs._links?.content?.href, ELIB, ["elibrary.sansad.in"]), size: typeof bs.sizeBytes === "number" ? bs.sizeBytes : null } : null;
  };
  const text = first("TEXT", /\.txt$/i);
  const pdf = first("ORIGINAL", /\.pdf$/i);
  return { textUrl: text?.url ?? null, pdfUrl: pdf?.url ?? null, textBytes: text?.size ?? null };
}

async function resolveElib(d: DiscoveredDoc, ctx: AdapterContext): Promise<DiscoveredDoc | null> {
  if (d.meta?.via !== "elibrary") return d;
  const uuid = String(d.meta.itemUuid);
  const files = elibFiles(await ctx.fetchJson(`${ELIB}/server/api/core/items/${uuid}/bundles?embed=bitstreams`));
  const fileUrl = files.textUrl ?? files.pdfUrl;
  return {
    ...d,
    fileUrl,
    mime: files.textUrl ? "text/plain" : files.pdfUrl ? "application/pdf" : "text/html",
    meta: {
      ...d.meta,
      originalPdfUrl: files.pdfUrl,
      textFrom: files.textUrl ? "dspace-text-bundle (Apache Tika; no page markers)" : null,
      noFile: !fileUrl,
    },
  };
}

function elibStream(collection: keyof typeof ELIB_COLLECTIONS): ListingStream {
  return {
    kind: "listing",
    id: `elib:${collection}`,
    backfill: true,
    firstPage: 0,
    incrementalPages: 3,
    async fetch(page: number, ctx: AdapterContext): Promise<ListingPage> {
      const parsed = parseElibSearch(await ctx.fetchJson(elibSearchUrl(ELIB_COLLECTIONS[collection].uuid, page)), collection);
      if (!parsed) return { items: [], last: true, notes: ["answer was not a DSpace search result"] };
      return { items: parsed.items, last: !parsed.items.length || page + 1 >= parsed.totalPages };
    },
  };
}

// ---- plan ----------------------------------------------------------------------------------------------------------

export function sansadStream(id: string): StreamSpec | null {
  let m = /^ls:(\d{1,2}):(\d{1,3})$/.exec(id);
  if (m) return lsStream(Number(m[1]), Number(m[2]));
  m = /^rs:(\d{1,4}):(STARRED|UNSTARRED)$/.exec(id);
  if (m) return rsStream(Number(m[1]), m[2] as RsQuestionType);
  m = /^elib:(committee|debates)$/.exec(id);
  if (m) return elibStream(m[1] as keyof typeof ELIB_COLLECTIONS);
  return null;
}

/** Streams of a pass: incremental = the two newest sessions of each house + eLibrary; backfill = every session. */
export async function sansadPlan(ctx: AdapterContext, mode: CursorMode, only: string[] | null): Promise<string[]> {
  const ids: string[] = [];
  const recent = mode === "incremental" ? 2 : Infinity;
  try {
    const ls = lsSessionPairs(await ctx.fetchJson(`${LS_API}/business/AllLoksabhaAndSessionDates`));
    ls.slice(0, recent).forEach((p) => ids.push(`ls:${p.ls}:${p.session}`));
  } catch (e) {
    ctx.log("sansad: Lok Sabha session list unavailable", { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    const rs = await ctx.fetchJson<{ session?: number }[]>(`${RS_API}/business/getSessionsList?docType=SQ`);
    const sessions = (Array.isArray(rs) ? rs : []).map((x) => Number(x.session)).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => b - a);
    sessions.slice(0, recent).forEach((s) => RS_TYPES.forEach((t) => ids.push(`rs:${s}:${t}`)));
  } catch (e) {
    ctx.log("sansad: Rajya Sabha session list unavailable", { error: e instanceof Error ? e.message : String(e) });
  }
  ids.push("elib:committee", "elib:debates");
  return only ? ids.filter((id) => only.some((o) => (o.endsWith("*") ? id.startsWith(o.slice(0, -1)) : id === o))) : ids;
}

export const def: SourceDef = {
  id: "sansad",
  name: "Parliament: questions, debates and committee reports",
  publisher: "Lok Sabha Secretariat and Rajya Sabha Secretariat (Digital Sansad)",
  kinds: ["parliament_question", "parliament_debate", "committee_report"],
  forum: "parliament",
  homepage: "https://sansad.in/",
  fetch: "direct",
  cadenceMinutes: 1440,
  attribution: "Parliament of India: Lok Sabha and Rajya Sabha questions (sansad.in), Lok Sabha Digital Library (elibrary.sansad.in).",
  terms: GOV_TERMS,
  enabled: true,
  notes: [
    "rsdoc.nic.in accepts a raw SQL predicate in its whereclause parameter; only the official UI's exact equality form (ses_no=N and qno='Q' and qtype='STARRED'|'UNSTARRED') is ever sent, built from validated numbers.",
    "eLibrary committee reports and debates use DSpace's TEXT bundle (Apache Tika extraction, no page numbers) as text; the original PDF is linked in metadata for checking quotes.",
    "Lok Sabha questions come from the Lok Sabha questions API (13th Lok Sabha onwards).",
  ],
};

export const adapter: SourceAdapter = {
  def,
  discover(ctx) {
    return walkStreams(ctx, { plan: sansadPlan, stream: sansadStream, resolve: resolveElib, key: (d) => d.url });
  },
};

