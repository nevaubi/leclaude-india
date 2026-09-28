import type { EDocument } from "@/lib/types/domain";
import { fakeHash } from "@/modules/ediscovery/seed-helpers";
import { detectNearDuplicates, nearDuplicateMap } from "@/modules/ediscovery/near-dup";
import { formatBates } from "@/modules/ediscovery/query";
import { canonicalExhibit, type IndiaEDocument } from "@/modules/ediscovery/india";
import { DEMO_REF_PREFIX } from "../ids";
import { DEMO_ID, type DocSpec } from "./doc-spec";
import { PLAINTIFF_EXHIBITS } from "./docs-key-a";
import { COMMERCIAL_RECORD, DEFENDANT_EXHIBITS } from "./docs-key-b";
import { PRIVILEGED_AND_OTHER } from "./docs-privileged";
import { buildGeneratedSpecs } from "./docs-generated";
import { BAIL_DOCS, WRIT_DOCS } from "./docs-hyderabad";
import { PW1_SHEET } from "./depo-pw1";
import { DW1_SHEET } from "./depo-dw1";
import { BY_NAME, SOURCES, tagged, type SourceKey } from "./people";

/** Line appended to every document so an exported or printed page can never pass for a real record. */
export const SYNTHETIC_FOOTER = "[Synthetic demonstration record — fictional parties and content]";

/** Width of the document-reference number ("NCW-0007"). */
export const REF_WIDTH = 4;

/** Deposition sheets as case-record documents (the parsed deposition cites back to these). */
export const SHEET_DOCS: DocSpec[] = [
  { id: DEMO_ID("rec_pw1_sheet"), source: "courtCom", date: "2024-07-15", type: "Transcript", subject: "Deposition of PW-1 (Raghavendra S. Bhat) — chief by affidavit, cross-examination 15.07.2024 and 05.08.2024", body: PW1_SHEET, pages: 8, india: { docClass: "deposition", filedBy: "court", title: "Deposition sheet of PW-1" }, coding: { responsive: true, issues: [] }, tags: ["deposition"] },
  { id: DEMO_ID("rec_dw1_sheet"), source: "courtCom", date: "2025-01-20", type: "Transcript", subject: "Deposition of DW-1 (Harish Kumar Patil) — chief by affidavit, cross-examination 20.01.2025 and 17.02.2025", body: DW1_SHEET, pages: 9, india: { docClass: "deposition", filedBy: "court", title: "Deposition sheet of DW-1" }, coding: { responsive: true, issues: [] }, tags: ["deposition"] },
];

export function allSpecs(): DocSpec[] {
  return [...PLAINTIFF_EXHIBITS, ...DEFENDANT_EXHIBITS, ...COMMERCIAL_RECORD, ...SHEET_DOCS, ...PRIVILEGED_AND_OTHER, ...buildGeneratedSpecs(), ...WRIT_DOCS, ...BAIL_DOCS];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function emailDate(date: string, time = "10:00"): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${time}:00 +0530`;
}

function textFor(s: DocSpec): string {
  const body = s.body.trim();
  if (s.type !== "Email") return `${body}\n\n${SYNTHETIC_FOOTER}`;
  const addr = (n: string) => { const p = BY_NAME.get(n); return p?.email ? `${n} <${p.email}>` : n; };
  const header = [`From: ${addr(s.from ?? "")}`, `To: ${(s.to ?? []).map(addr).join("; ")}`, s.cc?.length ? `Cc: ${s.cc.map(addr).join("; ")}` : null, `Date: ${emailDate(s.date, s.time)}`, `Subject: ${s.subject}`].filter(Boolean).join("\n");
  return `${header}\n\n${body}\n\n${SYNTHETIC_FOOTER}`;
}

/** Numbering order within a source: exhibits by mark, then everything else by date. */
function order(specs: DocSpec[]): DocSpec[] {
  const rank = (s: DocSpec) => (s.india.exhibit ? 0 : 1);
  return [...specs].sort((a, b) => rank(a) - rank(b) || (a.india.exhibit && b.india.exhibit ? Number(a.india.exhibit.replace(/\D/g, "")) - Number(b.india.exhibit.replace(/\D/g, "")) : 0) || a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.id.localeCompare(b.id));
}

/** Build every case-record document of the pack (pure and deterministic). */
export function buildCorpus(): IndiaEDocument[] {
  const specs = allSpecs();
  const ids = new Set<string>();
  for (const s of specs) { if (ids.has(s.id)) throw new Error(`demo corpus: duplicate id ${s.id}`); ids.add(s.id); }
  // An exhibit mark is unique within a matter (§23): a mark carried twice would make resolution ambiguous.
  const marks = new Map<string, string>();
  for (const s of specs) {
    if (!s.india.exhibit) continue;
    const c = canonicalExhibit(s.india.exhibit);
    if (!c) throw new Error(`demo corpus: ${s.id} has an unparseable exhibit mark ${s.india.exhibit}`);
    const key = `${SOURCES[s.source].matter}|${c}`;
    if (marks.has(key)) throw new Error(`demo corpus: ${c} marked on ${marks.get(key)} and ${s.id}`);
    marks.set(key, s.id);
  }
  const bySource = new Map<SourceKey, DocSpec[]>();
  for (const s of specs) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);
  const docs: IndiaEDocument[] = [];
  for (const [source, list] of bySource) {
    let n = 1;
    for (const s of order(list)) {
      const pages = Math.max(1, s.pages ?? 1);
      const prefix = DEMO_REF_PREFIX[source];
      const bates = formatBates(prefix, n, REF_WIDTH);
      const batesEnd = pages > 1 ? formatBates(prefix, n + pages - 1, REF_WIDTH) : undefined;
      n += pages;
      const src = SOURCES[source];
      const text = textFor(s);
      const names = Array.from(new Set([s.from, ...(s.to ?? []), ...(s.cc ?? [])].filter((x): x is string => !!x)));
      const orgs = Array.from(new Set(names.map((x) => BY_NAME.get(x)?.org).filter((x): x is string => !!x && x !== "—")));
      const family = s.thread || s.parent || s.attachments?.length ? { ...(s.thread ? { threadId: s.thread } : {}), ...(s.parent ? { parentId: s.parent } : {}), ...(s.attachments?.length ? { attachmentIds: s.attachments } : {}) } : undefined;
      const india = s.india.exhibit ? { ...s.india, exhibit: canonicalExhibit(s.india.exhibit)! } : s.india;
      const doc: IndiaEDocument = {
        id: s.id, matterId: src.matter, bates, ...(batesEnd ? { batesEnd } : {}), date: s.date, custodianId: src.id, custodianName: src.name, type: s.type, subject: s.subject,
        ...(s.from ? { from: s.from } : {}), ...(s.to?.length ? { to: s.to } : {}), ...(s.cc?.length ? { cc: s.cc } : {}),
        text, pages, ...(family ? { family } : {}), hash: fakeHash(`${src.matter}:${text}`),
        ...(s.aiScore != null ? { aiScore: s.aiScore } : {}), ...(s.aiSummary ? { aiSummary: s.aiSummary } : {}),
        entities: s.entities ?? { people: names, orgs, places: [] },
        coding: { responsive: null, privileged: null, issues: [], ...(s.coding ?? {}) },
        source: `${src.name} (synthetic demo)`,
        ...(s.tags?.length ? { tags: s.tags } : {}),
        india,
      };
      docs.push(tagged(doc));
    }
  }
  // Near-duplicates (MinHash, the detector the app runs), within a matter.
  const out: IndiaEDocument[] = [];
  for (const matterId of Array.from(new Set(docs.map((d) => d.matterId)))) {
    const inMatter = docs.filter((d) => d.matterId === matterId);
    const res = detectNearDuplicates(inMatter.map((d) => ({ id: d.id, text: d.text })), { threshold: 0.5 });
    const map = nearDuplicateMap(res.pairs);
    for (const d of inMatter) {
      const found = map.get(d.id);
      if (!found || !Object.keys(found).length) { out.push(d); continue; }
      const idsSorted = Object.keys(found).sort();
      const scores: Record<string, number> = {};
      for (const id of idsSorted) scores[id] = Math.round(found[id] * 1000) / 1000;
      out.push({ ...d, nearDuplicateIds: idsSorted, nearDuplicateScores: scores });
    }
  }
  return out;
}

export type { EDocument };
