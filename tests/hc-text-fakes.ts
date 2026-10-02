import type { CoverageRow, HcTextRepo, HcUnit, JudgmentRecord, Provenance, QueueCounts, StoreTextInput, StoreTextOutcome, UnitPayload } from "@/modules/india/corpus/hc-text/repo";
import type { Slice } from "@/modules/india/corpus/hc-text/schedule";

/**
 * In-memory HcTextRepo with the SQL implementation's semantics (guards, claim order, leases), for control-flow tests.
 * The SQL itself is exercised against a real Postgres in tests/hc-text-pg.test.ts (opt-in).
 */

export interface FakeJudgment { id: string; court_id: string; cnr: string | null; decision_date: string | null; text_status: string; pdf_url: string | null; title: string; case_number: string | null; updated_at: number }
export interface FakeText { id: string; case_key: string; cnr: string | null; decision_date: string | null; chunk_index: number; total_chunks: number; page_start: number | null; page_end: number | null; section_type: string | null; text: string; dataset_version: string }
export interface FakeUnit extends HcUnit { leaseUntil: number | null; runAfter: number | null; result: string | null; prov: Partial<Provenance>; note: string | null; error: string | null; finishedAt: number | null }

const PDF = (v: string) => v.startsWith("aws-hc-pdf");

export class FakeHcRepo implements HcTextRepo {
  judgments = new Map<string, FakeJudgment>();
  texts: FakeText[] = [];
  units = new Map<string, FakeUnit>();
  state = new Map<string, unknown>();
  bytes = 1_000_000;
  clock = Date.now();
  hasJudgmentsTable = true;
  progressSaves = 0;
  log: string[] = [];
  /** Called inside storeText before the guard (simulate a concurrent writer). */
  beforeStore?: (x: StoreTextInput) => void;

  addJudgment(j: Partial<FakeJudgment> & { id: string }) {
    this.judgments.set(j.id, { court_id: "hc-delhi", cnr: "DLHC010000012024", decision_date: "2024-05-01", text_status: "none", pdf_url: "https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com/data/pdf/year=2024/court=7_26/bench=dhcdb/a.pdf", title: "A v. B", case_number: "W.P.(C) 1/2024", updated_at: 0, ...j });
  }

  async ensureSchema() { return { judgments: this.hasJudgmentsTable }; }

  async seedSlice(slice: Slice, limit: number): Promise<number> {
    const cands = [...this.judgments.values()]
      .filter((j) => j.court_id === slice.courtId && j.decision_date?.startsWith(String(slice.year)) && ["none", "metadata"].includes(j.text_status)
        && (j.pdf_url ?? "").startsWith("https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com/") && /^[A-Z]{4}\d{12}$/.test(j.cnr ?? "") && !this.units.has(j.id))
      .sort((a, b) => (b.decision_date ?? "").localeCompare(a.decision_date ?? "") || a.id.localeCompare(b.id))
      .slice(0, limit);
    for (const j of cands) {
      this.units.set(j.id, { judgmentId: j.id, courtId: j.court_id, year: Number(j.decision_date!.slice(0, 4)), decisionDate: j.decision_date, cnr: j.cnr, pdfUrl: j.pdf_url!, priority: slice.index, status: "pending", attempts: 0, payload: null, leaseUntil: null, runAfter: null, result: null, prov: {}, note: null, error: null, finishedAt: null });
    }
    return cands.length;
  }

  async pendingCount() { return [...this.units.values()].filter((u) => u.status === "pending").length; }

  async claim(leaseMinutes: number, maxAttempts: number): Promise<HcUnit | null> {
    const now = this.clock;
    const u = [...this.units.values()]
      .filter((x) => (x.status === "pending" || (x.status === "running" && (x.leaseUntil ?? 0) < now)) && x.attempts < maxAttempts && (x.runAfter == null || x.runAfter <= now))
      .sort((a, b) => a.priority - b.priority || (b.decisionDate ?? "").localeCompare(a.decisionDate ?? "") || a.judgmentId.localeCompare(b.judgmentId))[0];
    if (!u) return null;
    u.status = "running"; u.leaseUntil = now + leaseMinutes * 60_000; u.attempts++;
    this.log.push(`claim ${u.judgmentId}`);
    return { ...u, payload: u.payload ? JSON.parse(JSON.stringify(u.payload)) : null };
  }

  async judgment(id: string): Promise<JudgmentRecord | null> {
    const j = this.judgments.get(id);
    return j ? { id: j.id, courtId: j.court_id, cnr: j.cnr, decisionDate: j.decision_date, textStatus: j.text_status, pdfUrl: j.pdf_url, title: j.title, caseNumber: j.case_number } : null;
  }

  async openIndiaLawText(cnr: string, date: string) { return this.texts.some((t) => t.cnr === cnr && t.decision_date === date && !PDF(t.dataset_version)); }

  async storeText(x: StoreTextInput): Promise<StoreTextOutcome> {
    this.beforeStore?.(x);
    const j = this.judgments.get(x.judgmentId);
    const oil = this.texts.some((t) => t.cnr === x.cnr && t.decision_date === x.decisionDate && !PDF(t.dataset_version));
    const dup = this.texts.some((t) => t.cnr === x.cnr && t.decision_date === x.decisionDate && PDF(t.dataset_version) && t.case_key !== x.judgmentId);
    if (!j) return { stored: false, reason: "record_missing" };
    if (j.text_status === "full") return { stored: false, reason: "record_has_text" };
    if (oil) return { stored: false, reason: "open_india_law" };
    if (dup) return { stored: false, reason: "duplicate" };
    this.texts = this.texts.filter((t) => !(t.case_key === x.judgmentId && PDF(t.dataset_version)));
    for (const c of x.chunks) this.texts.push({ id: `hcpdf:${x.judgmentId}:${c.index}`, case_key: x.judgmentId, cnr: x.cnr, decision_date: x.decisionDate, chunk_index: c.index, total_chunks: x.chunks.length, page_start: c.pageStart, page_end: c.pageEnd, section_type: c.sectionType, text: c.text, dataset_version: x.datasetVersion });
    if (["none", "metadata", "failed", "full_text", "ocr", "partial"].includes(j.text_status)) { j.text_status = x.status; j.updated_at = this.clock; }
    return { stored: true, chunks: x.chunks.length };
  }

  async markJudgmentFailed(id: string) {
    const j = this.judgments.get(id);
    if (j && ["none", "metadata"].includes(j.text_status)) { j.text_status = "failed"; j.updated_at = this.clock; }
  }

  private unit(id: string): FakeUnit {
    const u = this.units.get(id);
    if (!u) throw new Error(`no unit ${id}`);
    return u;
  }

  async finish(id: string, status: "done" | "skipped" | "failed", p: Provenance) {
    const u = this.unit(id);
    Object.assign(u, { status, result: p.result, leaseUntil: null, runAfter: null, payload: null, note: p.note ?? null, error: p.error ?? null, finishedAt: this.clock });
    u.prov = { ...u.prov, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v != null)) };
  }

  async retry(id: string, error: string, backoffMinutes: number) { Object.assign(this.unit(id), { status: "pending", error, leaseUntil: null, runAfter: this.clock + backoffMinutes * 60_000 }); }

  async release(id: string, note: string, payload?: UnitPayload | null) {
    const u = this.unit(id);
    if (u.status !== "running") return;
    Object.assign(u, { status: "pending", leaseUntil: null, attempts: Math.max(0, u.attempts - 1), note });
    if (payload !== undefined) u.payload = payload;
  }

  async defer(id: string, seconds: number, note: string, payload?: UnitPayload | null) {
    const u = this.unit(id);
    Object.assign(u, { status: "pending", leaseUntil: null, attempts: Math.max(0, u.attempts - 1), note, runAfter: this.clock + seconds * 1000 });
    if (payload !== undefined) u.payload = payload;
  }

  async saveProgress(id: string, payload: UnitPayload) { this.progressSaves++; const u = this.unit(id); if (u.status === "running") u.payload = JSON.parse(JSON.stringify(payload)); }
  async extendLease() {}
  async sweepExpired() { return 0; }

  async requeue(results: string[]) {
    let n = 0;
    for (const u of this.units.values()) {
      if (["done", "failed", "skipped"].includes(u.status) && results.includes(u.result ?? "")) {
        Object.assign(u, { status: "pending", attempts: 0, error: null, runAfter: null, finishedAt: null }); n++;
        const j = this.judgments.get(u.judgmentId);
        if (j?.text_status === "failed") j.text_status = "none";
      }
    }
    return n;
  }

  async queueCounts(): Promise<QueueCounts> {
    const out: QueueCounts = { pending: 0, running: 0, done: 0, skipped: 0, failed: 0 };
    for (const u of this.units.values()) out[u.status]++;
    return out;
  }

  async dbBytes() { return this.bytes; }
  async getState<T>(key: string) { return (this.state.get(key) as T) ?? null; }
  async setState(key: string, value: unknown) { this.state.set(key, JSON.parse(JSON.stringify(value))); }
  slot = new Map<string, number>();
  async claimStartSlot(key: string, s: number) {
    const last = this.slot.get(key);
    if (last != null && this.clock - last < s * 1000) return false;
    this.slot.set(key, this.clock);
    return true;
  }

  refreshed: string[] = [];
  async staleCoverageCourts(courts: string[], _age: number, limit: number) { return courts.filter((c) => !this.refreshed.includes(c)).slice(0, limit); }
  async refreshCoverage(courtId: string) { this.refreshed.push(courtId); }

  async coverage(): Promise<CoverageRow[]> {
    const m = new Map<string, CoverageRow>();
    for (const j of this.judgments.values()) {
      const year = j.decision_date ? Number(j.decision_date.slice(0, 4)) : null;
      const k = `${j.court_id}|${year}`;
      const r = m.get(k) ?? { courtId: j.court_id, year, judgments: 0, withText: 0, openIndiaLaw: 0, pdfText: 0, ocr: 0, partial: 0, failed: 0, metadataOnly: 0, lastUpdate: null };
      r.judgments++;
      if (["full", "full_text", "ocr", "partial"].includes(j.text_status)) r.withText++;
      if (j.text_status === "full") r.openIndiaLaw++;
      if (j.text_status === "full_text") r.pdfText++;
      if (j.text_status === "ocr") r.ocr++;
      if (j.text_status === "partial") r.partial++;
      if (j.text_status === "failed") r.failed++;
      if (["none", "metadata"].includes(j.text_status)) r.metadataOnly++;
      m.set(k, r);
    }
    return [...m.values()];
  }
}
