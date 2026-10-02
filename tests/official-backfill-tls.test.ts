import { afterEach, describe, expect, it } from "vitest";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { acceptIntermediate, completeChain, isIncompleteChainError, knownChainAgent, resetChainCacheForTests, resolveChain } from "@/modules/official/tls-chain";
import { diaryKeyOf } from "@/modules/official/causelist/query";
import { BACKFILL_SOURCES, backfillRequest, startBackfills } from "@/modules/official/run";
import { parseCursor } from "@/modules/official/adapters/regulators/common";
import type { SourceDef } from "@/modules/official/types";
import { OfficialFakeStore } from "./official-fakes";
import { LENCR_ROOT_YR_X1_PEM, LENCR_YR2_PEM } from "./fixtures/lencr-chain";

// A public root from Node's store stands in for "an intermediate issued by a root": it is a CA certificate, issued and
// signed by a certificate in the trusted set (itself).
const ROOT_PEM = tls.rootCertificates[0];
const ROOT = new X509Certificate(ROOT_PEM);
const NOW = Date.parse(ROOT.validFrom) + 24 * 3600_000;

afterEach(() => resetChainCacheForTests());

describe("incomplete certificate chains", () => {
  it("recognises the chain errors only", () => {
    expect(isIncompleteChainError(new Error("official:egazette: fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)"))).toBe(true);
    expect(isIncompleteChainError({ message: "fetch failed", cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } })).toBe(true);
    expect(isIncompleteChainError(new Error("CERT_HAS_EXPIRED"))).toBe(false);
    expect(isIncompleteChainError(new Error("self-signed certificate"))).toBe(false);
  });

  it("accepts an issuer certificate only when it is a valid CA, matches the leaf's issuer and chains to a trusted root", () => {
    const der = new Uint8Array(ROOT.raw);
    expect(acceptIntermediate(ROOT.subject, der, { roots: [ROOT_PEM], now: NOW })).toContain("BEGIN CERTIFICATE");
    expect(acceptIntermediate("CN=Someone Else", der, { roots: [ROOT_PEM], now: NOW })).toBeNull();
    expect(acceptIntermediate(ROOT.subject, der, { roots: [tls.rootCertificates.find((p) => new X509Certificate(p).subject !== ROOT.subject)!], now: NOW })).toBeNull();
    expect(acceptIntermediate(ROOT.subject, new TextEncoder().encode("not a certificate"), { roots: [ROOT_PEM], now: NOW })).toBeNull();
    expect(acceptIntermediate(ROOT.subject, der, { roots: [ROOT_PEM], now: Date.parse(ROOT.validTo) + 1 })).toBeNull();
  });

  it("completes a host's chain once from the AIA URL and remembers failures for a while", async () => {
    const fetched: string[] = [];
    const deps = {
      readLeaf: async () => ({ issuer: ROOT.subject, issuerUrls: ["http://ca.example.org/issuer.crt"] }),
      fetchIssuer: async (url: string) => { fetched.push(url); return new Uint8Array(ROOT.raw); },
      roots: [ROOT_PEM],
      now: () => NOW,
    };
    const [a, b] = await Promise.all([completeChain("egazette.gov.in", deps), completeChain("egazette.gov.in", deps)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(fetched).toEqual(["http://ca.example.org/issuer.crt"]);
    expect(knownChainAgent("egazette.gov.in")).toBe(a);

    const bad = await completeChain("cbic.gov.in", { ...deps, fetchIssuer: async () => null });
    expect(bad).toBeNull();
    expect(knownChainAgent("cbic.gov.in")).toBeNull();
    const noLeaf = await completeChain("x.gov.in", { ...deps, readLeaf: async () => null });
    expect(noLeaf).toBeNull();
  });
});

describe("multi-hop chain completion (Let's Encrypt YR2, as served without intermediates by egazette.gov.in)", () => {
  const YR2 = new X509Certificate(LENCR_YR2_PEM);
  const ROOT_YR = new X509Certificate(LENCR_ROOT_YR_X1_PEM);
  const at = Date.parse("2026-10-02T00:00:00Z");
  const served: Record<string, Uint8Array> = { "http://yr2.i.lencr.org/": new Uint8Array(YR2.raw), "http://yr.i.lencr.org/": new Uint8Array(ROOT_YR.raw) };
  const leaf = { issuer: YR2.subject, issuerUrls: ["http://yr2.i.lencr.org/"] };

  it("follows YR2 → Root YR (cross-signed by ISRG Root X1) to a root in Node's store", async () => {
    const urls: string[] = [];
    const pems = await resolveChain(leaf, async (u) => { urls.push(u); return served[u] ?? null; }, { now: at });
    expect(urls).toEqual(["http://yr2.i.lencr.org/", "http://yr.i.lencr.org/"]);
    expect(pems).toHaveLength(2);
  });

  it("refuses a path that does not reach a trusted root, a wrong issuer, or a certificate outside its validity", async () => {
    expect(await resolveChain(leaf, async (u) => (u === "http://yr2.i.lencr.org/" ? served[u] : null), { now: at })).toBeNull();
    expect(await resolveChain({ ...leaf, issuer: "CN=Not YR2" }, async (u) => served[u] ?? null, { now: at })).toBeNull();
    expect(await resolveChain(leaf, async (u) => served[u] ?? null, { now: Date.parse("2026-01-01T00:00:00Z") })).toBeNull(); // Root YR cross-sign starts 2026-05-13
    expect(await resolveChain(leaf, async (u) => served[u] ?? null, { now: at, roots: [ROOT_PEM] })).toBeNull(); // X1 not trusted
  });
});

describe("diary parameter", () => {
  it("takes a bare diary number or exactly one labelled one, never the first N/YYYY of a case number", () => {
    expect(diaryKeyOf("54583/2026")).toBe("54583/2026");
    expect(diaryKeyOf("54583-2026")).toBe("54583/2026");
    expect(diaryKeyOf("Diary No. 54583-2026")).toBe("54583/2026");
    expect(diaryKeyOf("SLP(C) No. 1234/2026 (Diary No. 54583/2026)")).toBe("54583/2026");
    expect(diaryKeyOf("W.P.(C) 12/2026")).toBeNull();
    expect(diaryKeyOf("Diary No. 1/2026 and Diary No. 2/2026")).toBeNull();
    expect(diaryKeyOf("abc")).toBeNull();
  });
});

describe("backfill trigger", () => {
  const def = (id: string): SourceDef => ({ id, name: id, publisher: "x", kinds: ["order"], forum: null, homepage: "https://example.gov.in/", fetch: "direct", cadenceMinutes: 60, attribution: "x", terms: "x", enabled: true }) as SourceDef;

  it("reads OFFICIAL_BACKFILL and its generation", () => {
    expect(backfillRequest({})).toBeNull();
    expect(backfillRequest({ OFFICIAL_BACKFILL: " ibbi, sansad ,," })).toEqual({ generation: "1", sources: ["ibbi", "sansad"] });
    expect(backfillRequest({ OFFICIAL_BACKFILL: "ibbi", OFFICIAL_BACKFILL_GENERATION: "2026-10-02" })).toEqual({ generation: "2026-10-02", sources: ["ibbi"] });
  });

  it("seeds a backfill cursor once per generation, keeps incremental markers, and ignores court sources", async () => {
    const store = new OfficialFakeStore();
    store.state.set("official_cursor:ibbi", JSON.stringify(JSON.stringify({ mode: "incremental", lastSeen: { nclt: "https://ibbi.gov.in/x" } })));
    const defs = [def("ibbi"), def("sansad"), def("nclt")];
    const first = await startBackfills(store, defs, { generation: "1", sources: ["ibbi", "sansad", "nclt"] });
    expect(first.map((d) => d.id)).toEqual(["ibbi", "sansad"]);
    expect(BACKFILL_SOURCES).not.toContain("nclt");
    const ibbiCursor = parseCursor(JSON.parse(store.state.get("official_cursor:ibbi")!));
    expect(ibbiCursor?.mode).toBe("backfill");
    expect(ibbiCursor?.lastSeen).toEqual({ nclt: "https://ibbi.gov.in/x" });
    expect(store.state.has("official_cursor:nclt")).toBe(false);

    expect(await startBackfills(store, defs, { generation: "1", sources: ["ibbi", "sansad"] })).toEqual([]);
    const again = await startBackfills(store, defs, { generation: "2", sources: ["ibbi"] });
    expect(again.map((d) => d.id)).toEqual(["ibbi"]);
  });
});
