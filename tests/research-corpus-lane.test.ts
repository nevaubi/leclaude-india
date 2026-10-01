import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/remote", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db/remote")>()), remoteStore: () => ({}) }));
const corpus = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/modules/india/corpus/search", () => ({
  searchCorpus: async (q: unknown) => {
    corpus.calls.push(q);
    const base = { source: "sci-open-data", court_code: null, bench_code: null, year: 2024, cnr: null, reporter_citation: null, disposal: "Dismissed", pdf_url: "https://indian-supreme-court-judgments.s3.amazonaws.com/x.pdf", text_status: "none", issues: null, match: "text" as const };
    return { hits: [
      { ...base, id: "sc_1", title: "Vijay Singh v. State of Bihar", court_id: "sci", court: "Supreme Court of India", decision_date: "2024-10-11", case_number: "Crl.A. 1/2024", neutral_citation: "2024 INSC 735", judges: ["A", "B"], snippet: "Anticipatory bail  under section 438." },
      { ...base, id: "hc_9", match: "partial" as const, title: "SHANTHI BAIL Vs VASANTHA BAI", court_id: "hc-karnataka", court: "High Court of Karnataka", decision_date: "2026-08-12", case_number: "RSA 1/2022", neutral_citation: "2026:KHC:42853", judges: [], snippet: null },
      { ...base, id: "sc_2", title: "Duplicate of an existing hit", court_id: "sci", court: "Supreme Court of India", decision_date: "2023-01-01", case_number: "C.A. 9/2023", neutral_citation: "2023 INSC 1", judges: [], snippet: null },
    ] };
  },
}));

import { corpusCaselawHits } from "@/modules/search/engine/deps";
import type { SearchHit } from "@/modules/search/types";

describe("research case-law lane: Neon judgment corpus", () => {
  it("adds metadata records with a record link, never as read sources, skips partial word matches and records another provider returned", async () => {
    const existing = [{ id: "judgment:x", source: "caselaw", title: "Existing", cite: "2023 INSC 1", citations: ["2023 INSC 1"] } as SearchHit];
    const hits = await corpusCaselawHits("anticipatory bail", { courts: ["sci"], yearFrom: 2020, limit: 8, existing, nctx: { jurisdiction: "sci" as never, courts: [] as never } });
    expect(corpus.calls[0]).toMatchObject({ q: "anticipatory bail", courts: ["sci"], yearFrom: 2020, limit: 8 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "corpus:sc_1", source: "caselaw", cite: "2024 INSC 735", url: "/cases/sc_1", date: "2024-10-11", courtId: "sci", snippet: "Anticipatory bail under section 438." });
    expect(hits[0].readRef).toBeUndefined();
    expect(hits[0].subtitle).toContain("metadata record");
  });
});
