/**
 * Citation-native evidence for synthesis (constitution §25 "citation-native internal RAG", §53.4).
 *
 * Every numbered research source becomes one `search_result` block with a stable, server-resolvable
 * `source` (judgment://<courtId>/<judgmentId>, statute://<enactmentId>/s/<n>, authority://indiankanoon/doc/<tid>,
 * matter://<matter>/document/<id>, library://…, intel://…, or the canonical URL; the US authority:// forms remain) and focused, paragraph-numbered text blocks so citation
 * boundaries stay narrow and "[n ¶k]" pinpoints resolve to the reader's paragraph k. Sources that were
 * not read carry only their search snippet, labelled as such. Array order == source number, so providers
 * that cannot take search_result blocks render the same numbering as text. Pure and client-safe.
 */
import type { SearchResultBlock } from "@/lib/ai/providers/types";
import { languageInfo } from "@/lib/india/languages";
import { benchLabel, hitCourtLabel, indianDate, judgmentCitations } from "../india-citations";
import { formatBluebook } from "../normalize";
import { lawSourceId } from "@/modules/law/shared";
import { focusParagraphs } from "./paragraphs";
import { TREATMENT_LABEL } from "./treatment";
import type { ResearchSource } from "./types";

const enc = (s: string | number) => encodeURIComponent(String(s));

/** Stable evidence identifier for a source. Never taken from the model; resolved server-side against the run's sources. */
export function evidenceSourceId(s: Pick<ResearchSource, "id" | "kind" | "url" | "hit">, ctx: { matterId?: string | null; tenantId?: string } = {}): string {
  const h = s.hit;
  const ref = h.readRef;
  if (s.id.startsWith("intel:")) return `intel://${enc(ctx.tenantId ?? "firm")}/document/${enc(s.id.slice(6))}`;
  if (ref?.kind === "judgment") return `judgment://${enc(h.india?.courtId || "unresolved")}/${enc(ref.id)}`;
  if (ref?.kind === "section") return h.india?.enactment && h.india.section ? `statute://${enc(ref.id.split(/[:#]/)[0])}/s/${enc(h.india.section)}` : `statute://${enc(ref.id)}`;
  if (ref?.kind === "law") return lawSourceId(ref.actId, ref.section, ref.variant);
  if (ref?.kind === "url" && ref.url.startsWith("ik://")) return `authority://indiankanoon/doc/${enc(ref.url.slice(5))}`;
  switch (s.kind) {
    case "caselaw":
      if (ref?.kind === "opinion") return `authority://courtlistener/opinion/${enc(ref.id)}`;
      if (h.opinionId != null) return `authority://courtlistener/opinion/${enc(h.opinionId)}`;
      if (h.clusterId != null) return `authority://courtlistener/cluster/${enc(h.clusterId)}`;
      break;
    case "dockets":
      if (h.docketId != null) return `authority://courtlistener/docket/${enc(h.docketId)}`;
      break;
    case "regulations":
      if (ref?.kind === "cfr") return `authority://ecfr/title-${enc(ref.title)}/section-${enc(ref.section)}`;
      if (h.cfr?.title && h.cfr.section) return `authority://ecfr/title-${enc(h.cfr.title)}/section-${enc(h.cfr.section)}`;
      break;
    case "federal_register":
      if (ref?.kind === "fr") return `authority://federalregister/${enc(ref.id)}`;
      if (h.fr?.documentNumber) return `authority://federalregister/${enc(h.fr.documentNumber)}`;
      break;
    case "statutes":
      if (h.statute?.packageId) return `authority://govinfo/${enc(h.statute.packageId)}${h.statute.granuleId ? `/${enc(h.statute.granuleId)}` : ""}`;
      break;
    case "ediscovery":
      if (ctx.matterId && ref?.kind === "edoc") return `matter://${enc(ctx.matterId)}/document/${enc(ref.id)}`;
      break;
    case "library":
      if (ref?.kind === "library") return `library://${enc(ctx.tenantId ?? "firm")}/item/${enc(ref.id)}`;
      break;
    case "web":
      break;
  }
  return s.url ?? `source://${enc(s.id)}`;
}

export interface EvidenceOptions {
  /** Research terms used to pick focused paragraphs. */
  terms: string[];
  matterId?: string | null;
  tenantId?: string;
  /** Characters of focused text per read source (default 6000). */
  maxCharsPerSource?: number;
  /** Characters across all sources (default 80000). Later sources degrade to their snippet. */
  maxTotalChars?: number;
  /** Characters per content block (citation granularity; default 1400). */
  maxBlockChars?: number;
}

/**
 * Authority facts for an Indian judgment, all deterministic (the model restates them; it never decides them):
 * court, bench strength, date, neutral/reporter citations, binding or persuasive for the forum, treatment and the
 * language of the text of record.
 */
export function judgmentFacts(s: Pick<ResearchSource, "hit" | "authority" | "treatment" | "date">): string[] {
  const h = s.hit;
  const out: string[] = [];
  out.push(`court: ${hitCourtLabel(h) || "not resolved"}`);
  out.push(h.india?.benchStrength ? benchLabel(h.india.benchStrength) : "bench strength unknown");
  if (s.date ?? h.date) out.push(`decided ${indianDate(s.date ?? h.date)}`);
  const cites = judgmentCitations(h);
  out.push(cites.length ? `citation: ${cites.join(" : ")}` : "no neutral or reporter citation recorded");
  out.push(s.authority === "binding" ? "BINDING on the forum" : s.authority === "persuasive" ? "PERSUASIVE for the forum" : "precedential effect not assessed");
  const recorded = h.india?.corpusTreatment?.map((t) => `${t.status}${t.by ? ` by ${t.by}` : ""}`).join("; ");
  out.push(recorded ? `TREATMENT RECORDED IN CORPUS: ${recorded}` : s.treatment?.signal === "possibly_negative" ? TREATMENT_LABEL.possibly_negative.toUpperCase() : s.treatment ? TREATMENT_LABEL[s.treatment.signal] : "treatment not checked");
  const lang = h.india?.language;
  if (lang && lang !== "en") out.push(`text of record in ${languageInfo(lang)?.name ?? lang}`);
  return out;
}

/** Title line of a source's evidence block (the model sees it; the text renderer prefixes "[n]"). */
export function evidenceTitle(s: ResearchSource): string {
  if (s.kind === "caselaw" && s.hit.india) {
    const facts = judgmentFacts(s);
    return `Source ${s.n} — ${s.hit.title} · ${facts.join(" · ")} · ${s.read ? "READ IN FULL" : "NOT READ — SEARCH SNIPPET ONLY"}`;
  }
  const parts = [formatBluebook(s.hit)];
  if (s.authority && s.authority !== "n/a") parts.push(s.authority === "binding" ? "binding on the forum" : "persuasive");
  if (s.scope === "record") parts.push("MATTER RECORD");
  else if (s.scope === "internal") parts.push("FIRM LIBRARY");
  if (s.treatment?.signal === "possibly_negative") parts.push(TREATMENT_LABEL.possibly_negative.toUpperCase());
  if (s.currentness && (s.currentness.flag === "dated" || s.currentness.flag === "proposed")) parts.push(s.currentness.label);
  parts.push(s.read ? "READ IN FULL" : "NOT READ — SEARCH SNIPPET ONLY");
  return `Source ${s.n} — ${parts.join(" · ")}`;
}

/** Build one search_result block per numbered source, in source-number order. */
export function buildEvidenceBlocks(sources: ResearchSource[], textOf: (s: ResearchSource) => string | undefined, opts: EvidenceOptions): SearchResultBlock[] {
  const per = opts.maxCharsPerSource ?? 6_000;
  const maxTotal = opts.maxTotalChars ?? 80_000;
  const maxBlock = opts.maxBlockChars ?? 1_400;
  let total = 0;
  const ordered = [...sources].filter((s) => s.n != null).sort((a, b) => a.n! - b.n!);
  return ordered.map((s) => {
    const source = s.evidenceId ?? evidenceSourceId(s, { matterId: opts.matterId, tenantId: opts.tenantId });
    const title = evidenceTitle(s);
    const text = s.read ? textOf(s) ?? "" : "";
    let content: string[];
    if (s.read && text && total < maxTotal) {
      const paras = focusParagraphs(text, opts.terms, { maxChars: Math.min(per, maxTotal - total) });
      content = groupBlocks(paras.map((p) => `¶${p.n} ${p.text}`), maxBlock);
      total += content.reduce((a, c) => a + c.length, 0);
    } else if (s.read && text) {
      content = [`(read in full; text omitted for length) ${s.snippet ?? ""}`.trim()];
    } else {
      content = [`(not read — search snippet only; do not characterize beyond it) ${s.snippet ?? ""}`.trim()];
    }
    return { type: "search_result", source, title, content: content.length ? content : ["(no text)"], citationsEnabled: true };
  });
}

/** Plain text of an evidence block for the verifier: the same focused paragraphs the synthesis saw. */
export function evidenceText(block: SearchResultBlock): string {
  return block.content.join("\n");
}

function groupBlocks(paras: string[], max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > max) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}
