/**
 * Hearing brief, the deterministic half (client-safe, pure): which sources a research run actually touched, how each
 * claim's references resolve, and the brief's markdown. Listing details, orders and pending compliance are written
 * from records, not by the model; only the points, authorities and questions are model-written, and each keeps the
 * references it cites, resolved against what was supplied or returned by a tool in the same run.
 */
import type { BriefClaim, BriefSource, BriefSourceState, CauseListEntry, ManualHearing, MatterCaseIdentifier } from "./types";

const REF_RE = /^[a-z][a-z0-9+.-]{1,20}:\/\/\S{2,400}$/i;

/** Tools whose result is a full read of a source (vs. a search hit list). */
const READ_TOOL = /^(read_|get_|citator_check|citing_references|map_criminal_section)/;

/**
 * Walk tool results and register every reference they returned. A ref returned by a read tool is "read"; one returned
 * by a search tool only is "found" (a snippet, not a reading). A read upgrades an earlier find.
 */
export function collectToolSources(calls: { name: string; result?: unknown }[]): Map<string, BriefSource> {
  const out = new Map<string, BriefSource>();
  const add = (ref: string, title: string, url: string | null, state: BriefSourceState) => {
    const prev = out.get(ref);
    if (!prev || (prev.state === "found" && state === "read")) out.set(ref, { ref, title: title || prev?.title || ref, url: url ?? prev?.url ?? null, state });
  };
  for (const call of calls) {
    const state: BriefSourceState = READ_TOOL.test(call.name) ? "read" : "found";
    const visit = (v: unknown, depth: number) => {
      if (depth > 6 || v == null) return;
      if (Array.isArray(v)) { for (const x of v.slice(0, 200)) visit(x, depth + 1); return; }
      if (typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      const title = [o.title, o.case_name, o.citation, o.name].find((x) => typeof x === "string") as string | undefined;
      const url = [o.url, o.official_source, o.source_url, o.pdf_url].find((x) => typeof x === "string" && /^https?:\/\//.test(x)) as string | undefined;
      for (const k of ["source", "ref", "id", "act_id"]) {
        const r = o[k];
        if (typeof r === "string" && REF_RE.test(r)) add(r, title ?? "", url ?? null, state);
      }
      for (const [k, x] of Object.entries(o)) if (k !== "text" && typeof x === "object") visit(x, depth + 1);
    };
    let result = call.result;
    if (typeof result === "string") { try { result = JSON.parse(result); } catch { result = null; } }
    visit(result, 0);
  }
  return out;
}

export interface RawBriefClaim { text: string; sources: string[] }

/**
 * Map numbered citations ("1", "[2]") to the supplied evidence they number. Providers without native search_result
 * blocks render the evidence as "[n] title / source: ref" in the order sent, so "[n]" names exactly evidence[n - 1];
 * a number outside that list stays as written (and so resolves to nothing).
 */
export function expandNumberedRefs(claims: RawBriefClaim[], evidenceRefs: string[]): RawBriefClaim[] {
  return claims.map((c) => ({
    ...c,
    sources: (c.sources ?? []).map((r) => {
      const m = /^\[?\s*(\d{1,3})\s*\]?$/.exec(String(r).trim());
      const n = m ? Number(m[1]) : NaN;
      return Number.isInteger(n) && n >= 1 && n <= evidenceRefs.length ? evidenceRefs[n - 1] : String(r);
    }),
  }));
}

/** Resolve each claim's refs. Unknown refs are kept as "unresolved" sources (visible), never mapped to a known one. */
export function resolveClaims(raw: { section: BriefClaim["section"]; claims: RawBriefClaim[] }[], registry: Map<string, BriefSource>): { claims: BriefClaim[]; sources: BriefSource[] } {
  const used = new Map<string, BriefSource>();
  const claims: BriefClaim[] = [];
  for (const group of raw) {
    for (const c of group.claims) {
      const text = (c.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const refs = Array.from(new Set((c.sources ?? []).map((s) => String(s).trim()).filter(Boolean))).slice(0, 8);
      let strong = 0, weak = 0;
      for (const r of refs) {
        const s = registry.get(r);
        if (s) {
          used.set(r, s);
          if (s.state === "supplied" || s.state === "read") strong++;
          else weak++;
        } else {
          used.set(r, used.get(r) ?? { ref: r, title: r, url: null, state: "unresolved" });
        }
      }
      const status: BriefClaim["status"] = refs.length && strong === refs.length ? "source_linked" : strong + weak > 0 ? "partial" : "unsupported";
      claims.push({ section: group.section, text, sources: refs, status });
    }
  }
  return { claims, sources: Array.from(used.values()) };
}

export interface BriefListing {
  entry: CauseListEntry;
  matchedOn: MatterCaseIdentifier & { printed?: string };
  sourceUrl: string | null;
}

export interface BriefInput {
  matterName: string;
  caption?: string;
  caseNumber?: string;
  court?: string;
  preparedOn: string;
  version: number;
  listing: BriefListing | null;
  manualHearing: ManualHearing | null;
  orders: { title: string; date: string | null; url: string }[];
  compliance: { title: string; dueAt?: string }[];
  pendingReview: number;
  summary: string | null;
  claims: BriefClaim[];
  sources: BriefSource[];
  notes: string[];
}

const STATE_LABEL: Record<BriefSourceState, string> = { supplied: "order supplied from the record", read: "read", found: "search result only (not read)", unresolved: "unresolved: not returned by any tool or record in this run" };
const CLAIM_MARK: Record<BriefClaim["status"], string> = { source_linked: "", partial: " _(partly source-linked)_", unsupported: " _(not source-linked: verify before use)_" };

/** "2026-10-05" → "05-10-2026" (day first, as Indian courts print dates); anything else unchanged. */
export function inDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (iso ?? "");
}

/** An instant in India time: "04-10-2026 19:20 IST"; an unparseable value unchanged. */
export function istTime(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return iso ?? "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute} IST`;
}

function md(s: string): string {
  return s.replace(/\s+/g, " ").replace(/([[\]])/g, "\\$1").trim();
}

/** The brief as markdown (Word-exportable through markdownToDoc). Deterministic for a given input. */
export function composeBriefMarkdown(b: BriefInput): string {
  const idx = new Map(b.sources.map((s, i) => [s.ref, i + 1]));
  const marks = (refs: string[]) => refs.map((r) => idx.get(r)).filter((n): n is number => n != null).map((n) => `[${n}]`).join("");
  const out: string[] = [];
  out.push(`# Hearing brief: ${md(b.matterName)}`);
  const sub = [b.caption, b.caseNumber, b.court].filter(Boolean).map((x) => md(x!)).join(" · ");
  if (sub) out.push(sub);
  out.push(`Prepared ${inDate(b.preparedOn)} · version ${b.version}. Prepared with AI assistance; check every source before relying on it.`);

  out.push("", "## Listing");
  if (b.listing) {
    const e = b.listing.entry;
    out.push(`- Date: ${inDate(e.listDate)}${e.courtNo ? ` · Court ${md(e.courtNo)}` : ""}${e.itemNo ? ` · Item ${md(e.itemNo)}` : ""} · ${e.listType} list`);
    if (e.bench) out.push(`- Bench: ${md(e.bench)}`);
    if (e.parties) out.push(`- Parties as listed: ${md(e.parties)}`);
    out.push(`- Matched on: ${md(b.listing.matchedOn.printed ?? b.listing.matchedOn.value)} (${b.listing.matchedOn.kind.replace("_", " ")}, ${b.listing.matchedOn.forum})`);
    out.push(`- As published${e.publishedAt ? ` at ${istTime(e.publishedAt)}` : ""}; fetched ${istTime(e.fetchedAt)}${b.listing.sourceUrl ? ` · [cause list](${b.listing.sourceUrl})` : ""}${e.page ? `, p. ${e.page}` : ""}`);
    out.push("", "> Cause lists are published by the courts; the online list is not authoritative. Check the court's list on the day.");
  } else if (b.manualHearing) {
    const h = b.manualHearing;
    out.push(`- Date: ${inDate(h.date)}${h.time ? ` ${h.time}` : ""}${h.courtNo ? ` · Court ${md(h.courtNo)}` : ""}${h.itemNo ? ` · Item ${md(h.itemNo)}` : ""} (entered by hand)`);
    if (h.court) out.push(`- Court: ${md(h.court)}`);
    if (h.purpose) out.push(`- Purpose: ${md(h.purpose)}`);
  } else {
    out.push("No listing or hearing is recorded for the next 30 days.");
  }

  out.push("", "## Last orders");
  if (b.orders.length) b.orders.forEach((o, i) => out.push(`${i + 1}. ${o.date ? inDate(o.date) : "date not printed"}: [${md(o.title)}](${o.url})`));
  else out.push("No orders found for the tracked identifiers.");

  out.push("", "## Pending compliance");
  if (b.compliance.length) for (const c of b.compliance) out.push(`- ${md(c.title)}${c.dueAt ? ` (due ${inDate(c.dueAt)})` : ""}`);
  else out.push("None recorded.");
  if (b.pendingReview) out.push(`- ${b.pendingReview} extracted action item set${b.pendingReview === 1 ? "" : "s"} await review in the Orders tab.`);

  if (b.summary) out.push("", "## Summary", md(b.summary));
  const section = (title: string, key: BriefClaim["section"], ordered: boolean) => {
    const list = b.claims.filter((c) => c.section === key);
    if (!list.length) return;
    out.push("", `## ${title}`);
    list.forEach((c, i) => out.push(`${ordered ? `${i + 1}.` : "-"} ${md(c.text)} ${marks(c.sources)}${CLAIM_MARK[c.status]}`.replace(/\s+$/, "")));
  };
  section("Points for the hearing", "points", true);
  section("Authorities", "authorities", true);
  section("Questions to prepare", "questions", false);

  if (b.notes.length) { out.push("", "## Notes"); for (const n of b.notes) out.push(`- ${md(n)}`); }
  if (b.sources.length) {
    out.push("", "## Sources");
    b.sources.forEach((s, i) => out.push(`${i + 1}. ${s.url ? `[${md(s.title)}](${s.url})` : md(s.title)} — ${s.ref} — ${STATE_LABEL[s.state]}`));
  }
  return out.join("\n") + "\n";
}
