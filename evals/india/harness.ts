/**
 * India eval harness: deterministic executors for evals/india/cases (no database, no model). Each executor runs the
 * real engine code (src/lib/india/**) and grades in code. Cases are graded to fail on the forbidden behaviour
 * (a citation bound to the nearest court, a split section collapsed to one, a same-name authority merged).
 */
import fs from "node:fs";
import path from "node:path";
import { citationBindingEffect, parseCitation } from "@/lib/india/citations";
import { authorityKey, buildTableOfAuthorities, CitationTracker, type CaseAuthority } from "@/lib/india/citation-style";
import { applicableCode, mapSection, type CodeName } from "@/lib/india/criminal-code-map";
import { courtById, type Court } from "@/lib/india/courts";

export interface IndiaEvalCase { id: string; category: string; title: string; constitution: string; input: Record<string, unknown>; expected: string; passCriteria: string[]; grading: "code"; requiresModel: false }
export interface IndiaEvalCheck { name: string; ok: boolean; actual?: string }
export interface IndiaEvalResult { id: string; title: string; status: "pass" | "fail"; checks: IndiaEvalCheck[] }

export const INDIA_CASES_DIR = path.join(__dirname, "cases");

export function loadIndiaCases(): IndiaEvalCase[] {
  return fs.readdirSync(INDIA_CASES_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(INDIA_CASES_DIR, f), "utf8")) as IndiaEvalCase);
}

type Exec = (c: IndiaEvalCase, check: (name: string, ok: boolean, actual?: unknown) => void) => void;

const EXECUTORS: Record<string, Exec> = {
  "india-wrong-neutral-citation"(c, check) {
    const { now, citations } = c.input as { now: string; citations: { raw: string }[] };
    const parsed = citations.map((x) => parseCitation(x.raw, { now: new Date(`${now}T00:00:00Z`) }));
    for (const p of parsed) {
      check(`${p.raw}: no courtId`, p.courtId === undefined, p.courtId);
      check(`${p.raw}: unknown or invalid`, p.kind === "unknown" || p.valid === false, { kind: p.kind, valid: p.valid });
    }
    check("2024:KXC:7336 keeps unresolvedCourt", parsed.find((p) => p.raw === "2024:KXC:7336")?.unresolvedCourt === "KXC", parsed.find((p) => p.raw === "2024:KXC:7336")?.unresolvedCourt);
    check("2024 INSC is unknown", parsed.find((p) => p.raw === "2024 INSC")?.kind === "unknown");
  },
  "india-ipc-bns-date-boundary"(c, check) {
    const { offences, mappings } = c.input as { offences: { date: string | { from: string; to: string } | null; expected: string }[]; mappings: { code: CodeName; section: string; expected: string[]; status: string }[] };
    for (const o of offences) {
      const r = applicableCode(o.date);
      check(`offence ${JSON.stringify(o.date)} → ${o.expected}`, r.substantive === o.expected, r.substantive);
    }
    for (const m of mappings) {
      const r = mapSection(m.code, m.section);
      const got = r.candidates.map((x) => x.section);
      check(`${m.code} ${m.section} → ${m.expected.join(", ") || "(none)"} [${m.status}]`, r.status === m.status && got.length === m.expected.length && got.every((g, i) => g === m.expected[i]), { status: r.status, got });
    }
  },
  "india-sc-vs-hc-binding"(c, check) {
    const { forum, authorities, districtForum } = c.input as { forum: string; authorities: { raw: string; expected: string }[]; districtForum: { territory: string[]; cases: { raw: string; expected: string }[] } };
    const f = courtById(forum)!;
    for (const a of authorities) {
      const got = citationBindingEffect(parseCitation(a.raw), f);
      check(`${a.raw} in ${forum} → ${a.expected}`, got === a.expected, got);
    }
    const district = { id: "district-test", name: "District court (test)", shortName: "DC", level: "district", territory: districtForum.territory, seat: "", benches: [], languages: [] } as unknown as Court;
    for (const a of districtForum.cases) {
      const got = citationBindingEffect(parseCitation(a.raw), district);
      check(`${a.raw} in a ${districtForum.territory.join("/")} district court → ${a.expected}`, got === a.expected, got);
    }
  },
  "india-same-party-names-across-states"(c, check) {
    const [ka, ts] = (c.input as { authorities: CaseAuthority[] }).authorities;
    check("authority keys differ", authorityKey(ka) !== authorityKey(ts), [authorityKey(ka), authorityKey(ts)]);
    const toa = buildTableOfAuthorities([ka, ts, ka]);
    const hc = toa.groups.find((g) => g.heading === "High Courts")?.cases ?? [];
    check("two High Court entries", hc.length === 2 && new Set(hc.map((x) => x.courtId)).size === 2, hc.map((x) => `${x.courtId}:${x.citation}`));
    const t = new CitationTracker([ka, ts]);
    t.cite(ka); t.cite(ts);
    const again = t.cite(ka).text;
    check("supra names the citation", again === "Ramesh v. State (supra, 2024:KHC:100)", again);
    const t2 = new CitationTracker([ka, ts]);
    t2.cite(ka);
    const next = t2.cite(ts);
    check("different authority right after is not Ibid.", next.form === "full" && !String(next.text).startsWith("Ibid"), next.text);
  },
};

export function runIndiaCase(c: IndiaEvalCase): IndiaEvalResult {
  const checks: IndiaEvalCheck[] = [];
  const exec = EXECUTORS[c.id];
  if (!exec) return { id: c.id, title: c.title, status: "fail", checks: [{ name: "executor exists", ok: false }] };
  exec(c, (name, ok, actual) => checks.push({ name, ok, actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual) }));
  return { id: c.id, title: c.title, status: checks.length && checks.every((x) => x.ok) ? "pass" : "fail", checks };
}

export function runIndiaEvals(ids?: string[]): IndiaEvalResult[] {
  return loadIndiaCases().filter((c) => !ids?.length || ids.includes(c.id)).map(runIndiaCase);
}
