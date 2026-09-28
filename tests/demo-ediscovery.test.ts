import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Person, ReviewBatch, SavedSearchRecord } from "@/lib/types/domain";
import { buildIndiaEdiscoveryDemo, INDIA_DEMO_COLLECTIONS, INDIA_DEMO_KV_KEYS } from "@/modules/demo/ediscovery";
import { DEMO_DEPOSITIONS, DEMO_MATTERS, isDemoRecord } from "@/modules/demo/ids";
import { matchesQuery, parseBates, parseQuery } from "@/modules/ediscovery/query";
import { normalizeBatesPrefix } from "@/modules/ediscovery/ingest";
import { toSearchable } from "@/modules/ediscovery/service";
import { findCrossReferences } from "@/modules/ediscovery/analysis/cross-references";
import { batchProgress } from "@/modules/ediscovery/batch-pure";
import { canonicalExhibit, resolveExhibit } from "@/modules/ediscovery/india";
import { detectScript } from "@/lib/india/languages";

/**
 * India demonstration pack — case-record half (Bengaluru commercial suit; Hyderabad writ and bail). The pack is pure
 * and deterministic; these tests hold it to the evidence contract: exact exhibit resolution, exact page:line cites,
 * late qualification preserved, translations labelled, nothing fabricated, nothing real.
 */

const MC = DEMO_MATTERS.commercial;
const demo = buildIndiaEdiscoveryDemo();
const docs = demo.edocs;
const byId = new Map(docs.map((d) => [d.id, d]));
const coll = <T,>(name: string) => (demo.collections.find((c) => c.collection === name)?.docs ?? []) as unknown as T[];
const people = coll<Person>(INDIA_DEMO_COLLECTIONS.people);
const savedSearches = coll<SavedSearchRecord>(INDIA_DEMO_COLLECTIONS.savedSearches);
const batches = coll<ReviewBatch>(INDIA_DEMO_COLLECTIONS.batches);
const meta = (x: object) => (x as { meta?: Record<string, unknown> }).meta;

function allRecords(): { kind: string; rec: { id: string } }[] {
  return [
    ...docs.map((rec) => ({ kind: "edoc", rec })), ...demo.issueCodes.map((rec) => ({ kind: "issue", rec })), ...demo.depositions.map((rec) => ({ kind: "deposition", rec })),
    ...demo.timeline.map((rec) => ({ kind: "timeline", rec })), ...demo.relationships.map((rec) => ({ kind: "relationship", rec })), ...demo.conflicts.map((rec) => ({ kind: "conflict", rec })),
    ...demo.privilegeLog.map((rec) => ({ kind: "privilege", rec })), ...demo.collections.flatMap((c) => c.docs.map((rec) => ({ kind: c.collection, rec }))),
  ];
}

describe("India demo — case records", () => {
  it("builds fast and deterministically", () => {
    const t0 = Date.now();
    const again = buildIndiaEdiscoveryDemo();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(JSON.stringify(again.edocs)).toBe(JSON.stringify(docs));
    expect(JSON.stringify(again.depositions)).toBe(JSON.stringify(demo.depositions));
  });

  it("has 60–120 documents in the Bengaluru suit, with exhibits Ex.P1–P25 and Ex.D1–D18, and Hyderabad records", () => {
    const suit = docs.filter((d) => d.matterId === MC);
    expect(suit.length).toBeGreaterThanOrEqual(60);
    expect(suit.length).toBeLessThanOrEqual(120);
    const marks = suit.map((d) => d.india?.exhibit).filter(Boolean) as string[];
    for (let n = 1; n <= 25; n++) expect(marks).toContain(`Ex.P${n}`);
    for (let n = 1; n <= 18; n++) expect(marks).toContain(`Ex.D${n}`);
    expect(marks).toHaveLength(43);
    expect(new Set(marks).size).toBe(43);
    const classes = new Set(suit.map((d) => d.india?.docClass));
    for (const c of ["pleading", "affidavit", "application", "exhibit", "deposition", "order", "order_sheet", "correspondence", "translation", "document"]) expect(classes.has(c as never), c).toBe(true);
    expect(new Set(suit.map((d) => d.type))).toEqual(expect.objectContaining({ size: expect.any(Number) }));
    for (const t of ["Email", "Chat", "Contract", "Spreadsheet", "Report", "Letter", "Transcript"]) expect(suit.some((d) => d.type === t), t).toBe(true);
    expect(docs.filter((d) => d.matterId === DEMO_MATTERS.writ).length).toBeGreaterThanOrEqual(8);
    expect(docs.filter((d) => d.matterId === DEMO_MATTERS.bail).length).toBeGreaterThanOrEqual(5);
    // Every marked exhibit records the witness it was marked through and the date.
    for (const d of suit.filter((x) => x.india?.exhibit)) expect([d.india!.markedThrough, d.india!.markedOn], d.id).toEqual([expect.stringMatching(/^(PW|DW)-1$/), expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);
  });

  it("has Kannada and Telugu originals with English translations labelled as translations", () => {
    const kn = docs.filter((d) => d.india?.language === "kn");
    const te = docs.filter((d) => d.india?.language === "te");
    expect(kn.length).toBeGreaterThanOrEqual(2);
    expect(te.length).toBeGreaterThanOrEqual(2);
    for (const d of kn) expect(detectScript(d.text), d.id).toBe("Kannada");
    for (const d of te) expect(detectScript(d.text), d.id).toBe("Telugu");
    const translations = docs.filter((d) => d.india?.docClass === "translation");
    expect(translations.length).toBeGreaterThanOrEqual(4);
    for (const t of translations) {
      const original = byId.get(t.india!.translationOf!);
      expect(original, t.id).toBeTruthy();
      expect(original!.matterId).toBe(t.matterId);
      expect(["kn", "te"]).toContain(original!.india?.language);
      expect(t.india!.translationOrigin).not.toBe("original");
      expect(t.text).toMatch(/^TRANSLATION \(filed by the (plaintiff|defendant|petitioner)/);
      expect(t.text).toContain("is the text of record");
    }
  });

  it("assigns document references the review services parse, per source and without gaps", () => {
    const bySource = new Map<string, typeof docs>();
    for (const d of docs) bySource.set(d.custodianId, [...(bySource.get(d.custodianId) ?? []), d]);
    for (const [, list] of bySource) {
      const prefix = parseBates(list[0].bates)!.prefix;
      expect(normalizeBatesPrefix(prefix)).toBe(prefix);
      const ranges = list.map((d) => [parseBates(d.bates)!.number, parseBates(d.batesEnd ?? d.bates)!.number]).sort((a, b) => a[0] - b[0]);
      expect(ranges[0][0]).toBe(1);
      for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1);
    }
    for (const matterId of Object.values(DEMO_MATTERS)) expect(demo.kv[INDIA_DEMO_KV_KEYS.settings(matterId)]).toMatchObject({ batesWidth: 4 });
  });

  it("resolves every exhibit mark to exactly one document of its own matter, and never substitutes", () => {
    const suit = docs.filter((d) => d.matterId === MC);
    for (const d of suit.filter((x) => x.india?.exhibit)) expect(resolveExhibit(d.india!.exhibit!, docs, MC)).toEqual({ status: "resolved", mark: d.india!.exhibit, docId: d.id });
    expect(resolveExhibit("Ex.P26", docs, MC)).toMatchObject({ status: "unresolved", reason: "not_marked_in_matter" });
    expect(resolveExhibit("Ex.P1(a)", docs, MC)).toMatchObject({ status: "unresolved" });
    expect(resolveExhibit("Ex.P14", docs, DEMO_MATTERS.writ)).toMatchObject({ status: "unresolved" });
    // The query language matches exact marks: Ex.P1 is not Ex.P12.
    const q = parseQuery("Ex.P1");
    expect(suit.filter((d) => matchesQuery(toSearchable(d), q.ast)).map((d) => d.india?.exhibit)).toEqual(["Ex.P1"]);
  });

  it("tags every record as synthetic demo data with unique ids", () => {
    const seen = new Set<string>();
    for (const { kind, rec } of allRecords()) {
      expect(meta(rec)?.demo, `${kind} ${rec.id}`).toBe("india-blr-hyd");
      expect(meta(rec)?.synthetic, `${kind} ${rec.id}`).toBe(true);
      expect(isDemoRecord(rec as { id: string; meta?: Record<string, unknown> }), rec.id).toBe(true);
      const key = `${kind}:${rec.id}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    for (const d of docs) expect(d.text).toContain("[Synthetic demonstration record");
  });

  it("names no judge and uses fictional companies and people", () => {
    const judges = people.filter((p) => p.role === "judge");
    expect(judges).toEqual([]);
    for (const p of people) if (p.organization && !/Case record|—|State of Telangana/.test(p.organization)) expect(p.organization, p.name).toMatch(/fictional/);
    const all = JSON.stringify(demo);
    for (const real of ["Infosys", "Wipro", "Reliance", "Tata", "GHMC", "Greater Hyderabad Municipal Corporation", "BBMP", "Justice "]) expect(all.includes(real), real).toBe(false);
  });

  it("keeps an advocate-copied business e-mail out of the privileged set; privileged items carry Indian statutory basis", () => {
    const cc = docs.filter((d) => (d.tags ?? []).includes("privilege-cc"));
    expect(cc.length).toBeGreaterThan(0);
    for (const d of cc) { expect(d.coding.privileged).toBe(false); expect(d.cc).toContain("Kavya Hegde"); }
    expect(demo.privilegeLog.length).toBe(docs.filter((d) => d.coding.privileged === true).length);
    for (const e of demo.privilegeLog) expect(e.description).toMatch(/BSA s\.13[24] \/ IEA s\.12[69]/);
    expect(demo.privilegeLog.some((e) => cc.some((d) => d.id === e.docId))).toBe(false);
  });

  it("parses PW-1 and DW-1 into chief (affidavit paragraphs) and cross segments with exact anchors", () => {
    expect(demo.depositions.map((d) => d.id)).toEqual([DEMO_DEPOSITIONS.pw1, DEMO_DEPOSITIONS.dw1]);
    for (const dep of demo.depositions) {
      const chief = dep.transcript.filter((r) => r.segment === "chief");
      const cross = dep.transcript.filter((r) => r.segment === "cross");
      expect(chief.length).toBeGreaterThanOrEqual(12);
      expect(chief.map((r) => r.para)).toEqual(chief.map((_, i) => i + 1));
      expect(cross.length).toBeGreaterThanOrEqual(20);
      expect(cross.some((r) => r.question && r.answer)).toBe(true);
      expect(cross.some((r) => r.narrative && /^It is (true|false)/.test(r.answer))).toBe(true);
      // Anchors are strictly increasing page:line.
      for (let i = 1; i < dep.transcript.length; i++) {
        const a = dep.transcript[i - 1], b = dep.transcript[i];
        expect(b.page > a.page || (b.page === a.page && b.line > a.line), `${dep.id} ${a.page}:${a.line} → ${b.page}:${b.line}`).toBe(true);
      }
      // Every exhibit of the deposition resolves to a document of the suit by exact mark.
      for (const e of dep.exhibits ?? []) expect(docs.find((d) => d.bates === e.bates && d.matterId === MC)?.india?.exhibit).toBe(canonicalExhibit(e.id));
      // The deposition sheet itself is in the record.
      expect(byId.get(dep.india.sheetDocId)?.india?.docClass).toBe("deposition");
    }
    expect(demo.depositions[0].exhibits!.map((e) => e.id)).toEqual(expect.arrayContaining(["Ex.P1", "Ex.P25", "Ex.D1", "Ex.D2", "Ex.D4"]));
  });

  it("preserves DW-1's early admission and his late qualification, and flags both", () => {
    const dw1 = demo.depositions[1];
    const early = dw1.transcript.find((r) => r.answer.includes("It is true that Ex.P9 UAT sign-off e-mail was sent by me."))!;
    const late = dw1.transcript.find((r) => r.answer.includes("was not a final acceptance"))!;
    expect(early.page).toBeLessThan(late.page);
    expect(early.flags).toContain("admission");
    expect(late.flags).toContain("contradiction");
    const conflict = demo.conflicts.find((c) => c.kind === "position_inconsistency")!;
    expect(conflict.sides.map((s) => s.cite)).toEqual(expect.arrayContaining([`DW-1 ${early.page}:${early.line}`, `DW-1 ${late.page}:${late.line}`]));
  });

  it("cites only documents and testimony that exist (timeline, conflicts, relationships)", () => {
    const deps = new Map(demo.depositions.map((d) => [d.id, d]));
    const checkCite = (depId: string, cite: string) => {
      const m = cite.match(/^(PW|DW)-1 (\d+):(\d+)/);
      expect(m, cite).toBeTruthy();
      const dep = deps.get(depId)!;
      expect(dep.transcript.some((r) => r.page === Number(m![2]) && r.line === Number(m![3])), cite).toBe(true);
    };
    for (const ev of demo.timeline) {
      expect(ev.sources.length, ev.title).toBeGreaterThan(0);
      for (const s of ev.sources) {
        if (s.kind === "document") { const d = byId.get(s.id!); expect(d, ev.title).toBeTruthy(); expect(d!.matterId).toBe(ev.matterId); if (s.excerpt) expect(d!.text).toContain(s.excerpt); }
        if (s.kind === "deposition") checkCite(s.id!, s.cite!);
      }
    }
    for (const c of demo.conflicts) for (const s of c.sides) {
      if (s.sourceKind === "document") { const d = byId.get(s.sourceId)!; expect(d.matterId).toBe(c.matterId); expect(d.text).toContain(s.excerpt); expect([d.bates, d.india?.exhibit]).toContain(s.cite); }
      else { checkCite(s.sourceId, s.cite); const m = s.cite.match(/(\d+):(\d+)/)!; expect(deps.get(s.sourceId)!.transcript.find((r) => r.page === Number(m[1]) && r.line === Number(m[2]))!.answer).toBe(s.excerpt); }
    }
    for (const r of demo.relationships) for (const e of r.evidence ?? []) if (e.docId) expect(byId.get(e.docId)?.matterId, r.id).toBe(r.matterId);
    expect(demo.conflicts.length).toBeGreaterThanOrEqual(6);
    expect(demo.timeline.filter((e) => e.matterId === MC).length).toBeGreaterThanOrEqual(15);
  });

  it("the bail matter's offence date is after 1 July 2024 and its FIR cites BNS sections only", () => {
    const fir = docs.find((d) => d.id === "demo_in_ed_b_fir")!;
    expect(fir.text).toContain("12.08.2026");
    expect(fir.text).toMatch(/Bharatiya Nyaya Sanhita/);
    expect(fir.text).not.toMatch(/Indian Penal Code|IPC/);
  });

  it("finds exhibit references in testimony by exact mark", () => {
    const pw1 = demo.depositions[0];
    const suitDocs = docs.filter((d) => d.matterId === MC).map((d) => ({ id: d.id, bates: d.bates, batesEnd: d.batesEnd, subject: d.subject, date: d.date, type: d.type, exhibit: d.india?.exhibit }));
    const refs = findCrossReferences(pw1, suitDocs).filter((r) => r.kind === "exhibit");
    expect(refs.length).toBeGreaterThan(10);
    for (const r of refs) if (r.docId) expect(suitDocs.find((d) => d.id === r.docId)!.exhibit).toBe(r.match);
  });

  it("ships review workflow records the services accept", () => {
    expect(savedSearches.length).toBeGreaterThanOrEqual(5);
    for (const s of savedSearches) expect(parseQuery(s.q).warnings, s.name).toEqual([]);
    const range = savedSearches.find((s) => s.q.startsWith("exhibit:"))!;
    const q = parseQuery(range.q);
    expect(docs.filter((d) => d.matterId === range.matterId && matchesQuery(toSearchable(d), q.ast))).toHaveLength(25);
    for (const b of batches) {
      for (const id of b.docIds) expect(byId.get(id)?.matterId, b.name).toBe(b.matterId);
      expect(batchProgress(b, (id) => byId.get(id)?.coding).total).toBe(b.docIds.length);
    }
    for (const ic of demo.issueCodes) expect(ic.count, ic.code).toBeGreaterThan(0);
  });

  it("uses no clock or randomness in the pack sources", () => {
    const dir = path.resolve(__dirname, "../src/modules/demo/ediscovery");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(/Date\.now\(\)|new Date\(\)|Math\.random\(/.test(src), f).toBe(false);
    }
  });
});
