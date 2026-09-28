import type { EDocument, Person, PrivilegeLogEntry } from "@/lib/types/domain";
import type { PrivilegeLogRow, ProductionSummary } from "./types";
import { parseBates } from "./query";
import { matterPeople } from "./analysis/service";
import { INDIA_COUNSEL_TITLE_RE, INDIA_PRIVILEGE_LABELS, INDIA_PRIVILEGE_LEGEND, type IndiaEDocument } from "./india";

/**
 * Server-side helpers shared by the seed, the service and tests: privilege-log templating, CSV/markdown export,
 * production load file.
 *
 * Who counts as counsel is data, not code: the roster is built from the matter's own people (attorneys, and anyone
 * whose title names them as counsel), so a new matter never inherits another matter's lawyers.
 */

/** Counsel in a matter: display name → role label ("Associate General Counsel", "counsel, Firm LLP"). */
export type CounselRoster = ReadonlyMap<string, string>;

const COUNSEL_TITLE_RE = /\b(counsel|attorney|lawyer|solicitor|barrister|esq)\b/i;

export function counselRosterFromPeople(people: Person[]): CounselRoster {
  const out = new Map<string, string>();
  for (const p of people) {
    if (p.title && (COUNSEL_TITLE_RE.test(p.title) || INDIA_COUNSEL_TITLE_RE.test(p.title))) out.set(p.name, p.title);
    else if (p.role === "attorney") out.set(p.name, p.organization ? `counsel, ${p.organization}` : "counsel");
  }
  return out;
}

/** The roster for one matter, from its own people. */
export function counselRoster(matterId: string): CounselRoster {
  return counselRosterFromPeople(matterPeople(matterId));
}

function typeNoun(t: EDocument["type"]) {
  switch (t) {
    case "Email": return "Email";
    case "Memo": return "Memorandum";
    case "Report": return "Report";
    case "Presentation": return "Presentation";
    case "Letter": return "Letter";
    case "Note": return "Handwritten/typed note";
    case "Chat": return "Instant-message log";
    case "Spreadsheet": return "Spreadsheet";
    case "Contract": return "Draft agreement";
    default: return "Document";
  }
}

function withRole(name: string, roster: CounselRoster) {
  const role = roster.get(name);
  return role ? `${name} (${role})` : name;
}

/** Topic phrase derived from issue codes, kept deliberately generic so the description does not reveal content. */
function topicFor(doc: EDocument) {
  const issues = new Set(doc.coding.issues ?? []);
  const parts: string[] = [];
  if (issues.has("REG-01") || issues.has("REG-02")) parts.push("regulatory reporting obligations");
  if (issues.has("TOX-01") || issues.has("TOX-02")) parts.push("product safety testing");
  if (issues.has("ENV-01") || issues.has("ENV-02")) parts.push("environmental compliance");
  if (issues.has("MKT-01")) parts.push("product literature");
  if (issues.has("GOV-01")) parts.push("government contract requirements");
  if (issues.has("K-01") || issues.has("K-02") || issues.has("IND-01")) parts.push("contractual rights and obligations");
  if (issues.has("DMG-01") || issues.has("LOSS-01")) parts.push("claims arising from cargo losses");
  if (!parts.length) parts.push("legal matters");
  return parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join(" and ");
}

/**
 * Privilege-safe description in the form required by most ESI protocols:
 * who, to whom, what kind of document, for what legal purpose — without
 * revealing the advice itself. Used when no OpenAI key is configured and as
 * the seed for reviewed entries.
 */
export function templatePrivilegeDescription(doc: EDocument, roster: CounselRoster = counselRoster(doc.matterId)): string {
  const basis = doc.coding.privilegeBasis ?? "attorney-client";
  const author = withRole(doc.from ?? doc.custodianName, roster);
  const authorIsCounsel = roster.has(doc.from ?? doc.custodianName);
  const recipients = (doc.to ?? []).map((r) => withRole(r, roster));
  const recipientCounsel = (doc.to ?? []).some((r) => roster.has(r)) || (doc.cc ?? []).some((r) => roster.has(r));
  const noun = typeNoun(doc.type);
  const topic = topicFor(doc);
  const to = recipients.length ? ` to ${recipients.join(", ")}` : "";
  if (basis === "work-product") {
    return `${noun} prepared by ${author}${authorIsCounsel ? "" : " at the direction of counsel"} in anticipation of litigation, analysing ${topic} and reflecting the mental impressions and legal theories of counsel.`;
  }
  if (basis === "common-interest" || basis === "joint-defense") {
    return `${noun} from ${author}${to} exchanged between parties sharing a common legal interest, conveying legal advice regarding ${topic}.`;
  }
  if (authorIsCounsel) {
    return `${noun} from ${author}${to} providing legal advice regarding ${topic}${doc.type === "Email" && recipients.length > 1 ? ", sent to client representatives for the purpose of rendering legal advice" : ""}.`;
  }
  if (recipientCounsel) {
    return `${noun} from ${author}${to} requesting legal advice from counsel regarding ${topic} and providing information to counsel for that purpose.`;
  }
  return `${noun} from ${author}${to} reflecting legal advice of counsel regarding ${topic}, prepared for the purpose of obtaining or implementing that advice.`;
}

export function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function privilegeLogCsv(rows: PrivilegeLogRow[]): string {
  const header = ["Log No.", "Beg Bates", "End Bates", "Date", "Document Type", "Author", "Recipients", "Privilege Basis", "Description", "Status"];
  const lines = rows.map((r, i) => {
    const [beg, end] = r.bates.split(/\s*–\s*/);
    return [i + 1, beg, end ?? beg, r.date, r.docType, r.author, r.recipients.join("; "), r.basis, r.description, r.status === "final" ? "Withheld" : "Draft"].map(csvEscape).join(",");
  });
  return [header.join(","), ...lines].join("\r\n");
}

export function privilegeLogMarkdown(rows: PrivilegeLogRow[], matterName: string, caption?: string, roster?: CounselRoster): string {
  const head = `# Privilege Log\n\n**${matterName}**${caption ? ` · ${caption}` : ""}\n\nDocuments withheld from disclosure / inspection on the ground of privilege (Bharatiya Sakshya Adhiniyam, 2023, ss.132–134; Indian Evidence Act, 1872, ss.126–129). ${rows.length} entr${rows.length === 1 ? "y" : "ies"}. Generated ${new Date().toISOString().slice(0, 10)}.\n\n`;
  const table = ["| No. | Bates | Date | Type | Author | Recipients | Basis | Description |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  rows.forEach((r, i) => table.push(`| ${i + 1} | ${r.bates} | ${r.date} | ${r.docType} | ${r.author} | ${r.recipients.join("; ") || "—"} | ${r.basis} | ${r.description.replace(/\|/g, "/")} |`));
  const legend = `\n\n## Legend\n\n${INDIA_PRIVILEGE_LEGEND.map((l) => `- ${l}`).join("\n")}${counselLegend(rows, roster)}`;
  return head + table.join("\n") + legend;
}

/** Documents that go out the door: responsive, not privileged, not exact duplicates. */
/** "Persons identified as counsel" bullet: roster members who appear as an author or recipient in the log. */
function counselLegend(rows: PrivilegeLogRow[], roster?: CounselRoster): string {
  if (!roster?.size) return "";
  const named = new Set<string>();
  for (const r of rows) for (const n of [r.author, ...r.recipients.map((x) => x.replace(/\s*\(cc\)$/, ""))]) if (roster.has(n)) named.add(n);
  if (!named.size) return "";
  return `\n- Persons identified as counsel: ${[...named].sort().map((n) => `${n} (${roster.get(n)})`).join("; ")}.`;
}

export function isProducible(d: EDocument) {
  return d.coding.responsive === true && d.coding.privileged !== true && !d.isDuplicateOf;
}

export function productionLoadFileCsv(docs: EDocument[]): string {
  const header = ["BegBates", "EndBates", "BegAttach", "EndAttach", "Custodian", "DocDate", "DocType", "Subject", "From", "To", "CC", "Confidentiality", "Issues", "Hot", "MD5Hash", "PageCount", "NativeFile"];
  const byId = new Map(docs.map((d) => [d.id, d]));
  const lines = docs.map((d) => {
    const parent = d.family?.parentId ? byId.get(d.family.parentId) : undefined;
    const familyRoot = parent ?? d;
    const attachments = (familyRoot.family?.attachmentIds ?? []).map((id) => byId.get(id)).filter(Boolean) as EDocument[];
    const familyDocs = [familyRoot, ...attachments].filter((x) => isProducible(x));
    const begAttach = familyDocs.length > 1 ? familyDocs.map((x) => x.bates).sort()[0] : "";
    const endAttach = familyDocs.length > 1 ? familyDocs.map((x) => x.batesEnd ?? x.bates).sort().slice(-1)[0] : "";
    return [d.bates, d.batesEnd ?? d.bates, begAttach, endAttach, d.custodianName, d.date, d.type, d.subject, d.from ?? "", (d.to ?? []).join("; "), (d.cc ?? []).join("; "), d.coding.confidentiality ?? "", (d.coding.issues ?? []).join("; "), d.coding.hot ? "Y" : "", d.hash ?? "", d.pages ?? 1, `NATIVES\\${d.bates}.${d.type === "Email" ? "msg" : d.type === "Spreadsheet" ? "xlsx" : d.type === "Presentation" ? "pptx" : "pdf"}`].map(csvEscape).join(",");
  });
  return [header.join(","), ...lines].join("\r\n");
}

/** Collapse a sorted list of Bates numbers into contiguous ranges (per prefix). */
export function batesRanges(docs: EDocument[]): ProductionSummary["batesRanges"] {
  const items = docs
    .map((d) => ({ start: parseBates(d.bates), end: parseBates(d.batesEnd ?? d.bates) }))
    .filter((x): x is { start: NonNullable<ReturnType<typeof parseBates>>; end: NonNullable<ReturnType<typeof parseBates>> } => !!x.start && !!x.end)
    .sort((a, b) => a.start.prefix.localeCompare(b.start.prefix) || a.start.number - b.start.number);
  const out: ProductionSummary["batesRanges"] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    const fmt = (n: number) => `${it.start.prefix}-${String(n).padStart(it.start.width, "0")}`;
    if (last && last.start.startsWith(it.start.prefix) && parseBates(last.end)!.number + 1 >= it.start.number) {
      last.end = fmt(Math.max(parseBates(last.end)!.number, it.end.number));
      last.count += 1;
    } else out.push({ start: fmt(it.start.number), end: fmt(it.end.number), count: 1 });
  }
  return out;
}

export function productionSummary(matterId: string, docs: EDocument[]): ProductionSummary {
  const responsive = docs.filter((d) => d.coding.responsive === true);
  const withheld = responsive.filter((d) => d.coding.privileged === true);
  const produced = docs.filter(isProducible);
  const count = <K extends string>(list: EDocument[], key: (d: EDocument) => K) => {
    const m = new Map<K, number>();
    for (const d of list) m.set(key(d), (m.get(key(d)) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };
  return {
    matterId,
    responsive: responsive.length,
    privilegedWithheld: withheld.length,
    produced: produced.length,
    batesRanges: batesRanges(produced),
    byCustodian: count(produced, (d) => d.custodianName).map(([custodian, n]) => ({ custodian, count: n })),
    byType: count(produced, (d) => d.type).map(([type, n]) => ({ type, count: n })),
  };
}

/** Text that goes into the keyword/vector index for a document. */
export function indexTextFor(d: EDocument) {
  // Exhibit mark and document number (Indian record metadata) are indexed with the production number so "Ex.P7" finds the document.
  const india = (d as IndiaEDocument).india;
  const refs = [d.bates, india?.exhibit, india?.docNumber].filter(Boolean).join(" · ");
  return `${refs}\n${d.subject}\n${d.custodianName}\n${d.from ?? ""}\n${(d.to ?? []).join("; ")}\n\n${d.text}`;
}

/** Privilege basis label with Indian statutory wording (stored ids are unchanged). */
export function privilegeBasisLabel(basis: keyof typeof INDIA_PRIVILEGE_LABELS | undefined | null): string {
  return INDIA_PRIVILEGE_LABELS[basis ?? "attorney-client"] ?? String(basis);
}

export function toPrivilegeLogRow(e: PrivilegeLogEntry, doc: EDocument | null): PrivilegeLogRow {
  return { ...e, subject: doc?.subject ?? "", custodianName: doc?.custodianName ?? "" };
}
