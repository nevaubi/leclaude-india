import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { isProviderQuotaError, QUOTA_DEFER_SECONDS } from "@/lib/ai/quota";
import type { DiscoverResult, SourceAdapter } from "@/modules/official/adapter";
import type { OfficialHttp } from "@/modules/official/http";
import { documentIdFor } from "@/modules/official/pipeline";
import { allowHostsFor, setOfficialAdaptersForTests } from "@/modules/official/registry";
import { runOfficialIngest } from "@/modules/official/run";
import type { DiscoveredDoc, SourceDef } from "@/modules/official/types";
import { OfficialFakeStore } from "./official-fakes";

const DEF: SourceDef = {
  id: "sci-orders", name: "t", publisher: "Supreme Court of India", kinds: ["order"], forum: "sci",
  homepage: "https://www.sci.gov.in/", fetch: "direct", cadenceMinutes: 60, attribution: "x", terms: "x", enabled: true,
};
const QUOTA = "openai: 429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";

afterEach(() => setOfficialAdaptersForTests(null));

describe("model provider without credit", () => {
  it("recognises quota refusals only", () => {
    expect(isProviderQuotaError(QUOTA)).toBe(true);
    expect(isProviderQuotaError(new Error("insufficient_quota"))).toBe(true);
    expect(isProviderQuotaError(new Error("openai: 429 rate limit reached for requests"))).toBe(false);
    expect(isProviderQuotaError(new Error("timeout"))).toBe(false);
  });

  it("an embedding refused for lack of credit leaves the unit waiting with its attempts, never failed", async () => {
    const url = "https://www.sci.gov.in/orders/q.pdf";
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText("IN THE SUPREME COURT OF INDIA Civil Appeal No. 9 of 2026 The appeal is allowed.", { x: 40, y: 780, size: 10, font });
    const pdf = await doc.save();
    const adapter: SourceAdapter = {
      def: DEF,
      async discover(): Promise<DiscoverResult> { return { items: [{ sourceId: "sci-orders", kind: "order", url, title: "CA 9/2026", docDate: "2026-10-01" } as DiscoveredDoc], nextCursor: null, done: true }; },
      parse(d) { return { records: [{ id: d.id }], unparsed: 0 }; },
      async persist() { return { stored: 1 }; },
    };
    setOfficialAdaptersForTests({ "sci-orders": adapter });
    const http: OfficialHttp = {
      def: DEF, allowHosts: allowHostsFor(DEF), firecrawlAllowed: false,
      async fetchPage() { throw new Error("not used"); },
      async fetchFile(u) { return { url: u, finalUrl: u, status: 200, mime: "application/pdf", bytes: pdf, provenance: { via: "direct" as const, proxy: null, timezone: null, status: 200, finalUrl: u } }; },
      async fetchJson() { throw new Error("not used"); }, async postForm() { throw new Error("not used"); },
      async firecrawlPage() { return null; }, async firecrawlDocument() { return null; },
    };
    const store = new OfficialFakeStore();
    const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1)));
    for (let i = 0; i < 6; i++) {
      await runOfficialIngest({ store, deadlineMs: 60_000, concurrency: 1, sleep: tick, http: () => http, embedModel: "test-embed", embed: async () => { throw new Error(QUOTA); }, log: () => undefined });
      store.clock += (QUOTA_DEFER_SECONDS + 60) * 1000;
    }
    const unit = store.units.get(`index:${documentIdFor("sci-orders", url)}`)!;
    expect(unit).toBeDefined();
    expect(unit.status).toBe("pending");
    expect(unit.attempts).toBe(0);
  });
});
