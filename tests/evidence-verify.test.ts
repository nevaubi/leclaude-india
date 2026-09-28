import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/evidence-verify-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { db, resetSqlite } from "@/lib/db";
import { MATTERS } from "@/lib/seed/ids";
import { AuthError } from "@/lib/auth/errors";
import { applyQuoteGuard, buildVerdict, quoteAppears, summarizeClaims, tagHighRisk, type GuardedSource, type RawClaim, type RawVerdict } from "@/lib/evidence/verify-pure";
import { canVerifyWithModel, verifyClaims } from "@/lib/evidence/verify";
import type { Claim } from "@/lib/evidence/types";

beforeAll(() => { resetSqlite(); db(); });

const SOURCES: GuardedSource[] = [
  { ref: { kind: "deposition", id: "dep_afff_voss_v1", matterId: MATTERS.afff, witness: "Helen Voss", page: 45 }, text: "Q. Was the study complete? A. Yes, the ninety-day study was complete by March 2001. We reported it internally." },
  { ref: { kind: "document", id: "ed_afff_0001", matterId: MATTERS.afff, bates: "MFC-0041877" }, text: "Final report summary: the 90-day rat study showed liver weight changes at the mid dose. Distribution: Hale, Brooks." },
];

describe("quote guard", () => {
  it("accepts a verbatim quote regardless of whitespace, quote glyphs, dashes and case", () => {
    expect(quoteAppears("the ninety-day study was complete", SOURCES[0].text)).toBe(true);
    expect(quoteAppears("The  ninety–day study  was complete", SOURCES[0].text)).toBe(true);
    expect(quoteAppears("the ninety-day study was incomplete", SOURCES[0].text)).toBe(false);
    expect(quoteAppears("Yes", SOURCES[0].text)).toBe(false);
    expect(quoteAppears("", SOURCES[0].text)).toBe(false);
  });
  it("demotes a supported claim whose quote does not appear in its source, and one with no source", () => {
    const claims: RawClaim[] = [
      { id: "c1", text: "Voss testified the 90-day study was complete by March 2001.", fields: [], citations: ["Voss Dep. 45:12"] },
      { id: "c2", text: "The report was sent to regulators.", fields: [], citations: [] },
      { id: "c3", text: "Liver weight changes appeared at the mid dose.", fields: ["scientific_fact"], citations: ["MFC-0041877"] },
      { id: "c4", text: "The witness recanted.", fields: [], citations: [] },
    ];
    const verdicts: RawVerdict[] = [
      { claimId: "c1", support: "supported", sourceIndex: 0, quote: "the ninety-day study was complete by March 2001", note: "direct" },
      { claimId: "c2", support: "supported", sourceIndex: 1, quote: "the report was sent to the EPA and state regulators", note: "fabricated" },
      { claimId: "c3", support: "supported", sourceIndex: -1, quote: "liver weight changes at the mid dose", note: "no index" },
      { claimId: "c4", support: "contradicted", sourceIndex: 0, quote: "recanted", note: "too short" },
    ];
    const out = applyQuoteGuard(claims, verdicts, SOURCES);
    expect(out.map((c) => c.support)).toEqual(["supported", "unsupported", "unsupported", "unsupported"]);
    expect(out[0].evidence[0]).toMatchObject({ kind: "deposition", id: "dep_afff_voss_v1", citation: "the ninety-day study was complete by March 2001" });
    expect(out[1].notes).toMatch(/demoted from supported: the quoted passage does not appear in document ed_afff_0001/);
    expect(out[2].notes).toMatch(/named no source/);
    expect(out[3].notes).toMatch(/demoted from contradicted/);
    expect(out[2].highRisk).toBe(true);
    expect(out[3].evidence).toEqual([]);
  });
  it("marks claims with no verdict as unchecked and tolerates unknown support labels", () => {
    const out = applyQuoteGuard([{ id: "a", text: "x" }, { id: "b", text: "y" }], [{ claimId: "b", support: "maybe", sourceIndex: 0, quote: "" }], SOURCES);
    expect(out.map((c) => [c.support, c.notes])).toEqual([["unchecked", "no verdict returned for this claim"], ["unchecked", undefined]]);
  });
});

describe("high-risk tagging", () => {
  it("flags deadline, limitations, privilege, holding and admission language deterministically", () => {
    expect(tagHighRisk("The answer must be filed by October 3, 2026; the deadline cannot be extended.")).toContain("deadline");
    expect(tagHighRisk("The claim is time-barred under the two-year statute of limitations.")).toEqual(expect.arrayContaining(["limitations"]));
    expect(tagHighRisk("The memo is protected by attorney-client privilege.")).toContain("privilege");
    expect(tagHighRisk("The court held that the defense fails.")).toContain("holding");
    expect(tagHighRisk("Voss admitted the study was complete.")).toContain("admission");
    expect(tagHighRisk("The weather was mild.")).toEqual([]);
  });
});

describe("verdict arithmetic", () => {
  const claim = (support: Claim["support"], highRisk = false): Claim => ({ id: support, text: support, citations: [], support, evidence: [], highRisk });
  it("computes status and score without overstating", () => {
    expect(summarizeClaims([])).toMatchObject({ status: "unsupported", score: 0 });
    expect(summarizeClaims([claim("supported"), claim("supported")])).toMatchObject({ status: "verified", score: 1 });
    expect(summarizeClaims([claim("supported"), claim("unsupported")])).toMatchObject({ status: "partially_supported", score: 0.5 });
    expect(summarizeClaims([claim("supported"), claim("partially_supported")])).toMatchObject({ status: "partially_supported", score: 0.75 });
    expect(summarizeClaims([claim("supported"), claim("contradicted")])).toMatchObject({ status: "contradicted", score: 0.5 });
    expect(summarizeClaims([claim("unchecked"), claim("unsupported")])).toMatchObject({ status: "unsupported", score: 0, unchecked: 1 });
  });
  it("buildVerdict binds the hash and notes unresolved high-risk claims", () => {
    const v = buildVerdict({ artifactHash: "h", claims: [claim("supported"), claim("unsupported", true)], model: "m" });
    expect(v).toMatchObject({ artifactHash: "h", method: "claims", status: "partially_supported", supported: 1, unsupported: 1, contradicted: 0, model: "m" });
    expect(v.notes).toMatch(/1 high-risk claim\(s\) are not fully supported/);
  });
});

describe("verifyClaims (server)", () => {
  const scope = { tenantId: "default", matterIds: [MATTERS.afff] };
  it("refuses sources outside the scope before any model call", async () => {
    await expect(verifyClaims({ artifactText: "x", artifactHash: "h", scope, sources: [{ kind: "document", id: "ed_ng", matterId: MATTERS.northgate, text: "t" }] })).rejects.toBeInstanceOf(AuthError);
  });
  it("returns an unsupported verdict with no model when there are no sources", async () => {
    const v = await verifyClaims({ artifactText: "The record shows X.", artifactHash: "h", scope, sources: [] });
    expect(v).toMatchObject({ artifactHash: "h", status: "unsupported", claims: [], score: 0 });
    expect(v.notes).toMatch(/no sources/);
  });
  it("needs a configured model provider for claim extraction", async () => {
    expect(canVerifyWithModel()).toBe(false);
    await expect(verifyClaims({ artifactText: "Voss said yes.", artifactHash: "h", scope, sources: [{ ...SOURCES[0].ref, text: SOURCES[0].text }] })).rejects.toThrow(/OPENAI_API_KEY|not configured/i);
  });
});
