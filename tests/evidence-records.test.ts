import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/evidence-records-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  process.env.OPENAI_API_KEY = "";
});

import { db, resetSqlite } from "@/lib/db";
import { MATTERS } from "@/lib/seed/ids";
import { artifactHash, canonicalText, sha256Hex, shortHash } from "@/lib/evidence/hash";
import { artifactHashSync } from "@/lib/evidence/hash-server";
import { assertNoSubstitution, EvidenceSubstitutionError } from "@/lib/evidence/guard";
import { ensureTrust, getTrust, listTrust, recordCitationCheck, recordReview, recordSources, recordVerification, StaleVerificationError, touchArtifact } from "@/lib/evidence/records";
import { deriveTrustState, isVerificationCurrent, rebindArtifact, trustLabel } from "@/lib/evidence/trust";
import type { Citation, CitationCheck, EvidenceRef, VerificationVerdict } from "@/lib/evidence/types";
import { documentResource, sensitivityOf } from "@/lib/evidence/sensitivity";

beforeAll(() => { resetSqlite(); db(); });

describe("artifact hashing", () => {
  it("canonicalizes whitespace so re-serialization does not change the hash, but any wording change does", async () => {
    const a = await artifactHash("The  witness\r\n  admitted   it.\n");
    const b = await artifactHash("The witness admitted it.");
    const c = await artifactHash("The witness admitted it!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(artifactHashSync("The witness admitted it.")).toBe(a);
    expect(canonicalText("  a \t b\n\nc ")).toBe("a b c");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(shortHash(a)).toHaveLength(12);
  });
  it("hashes a 200k-character artifact", async () => {
    const big = "x ".repeat(120_000);
    expect(big.length).toBeGreaterThan(200_000);
    expect(await artifactHash(big)).toBe(artifactHashSync(big));
  });
});

const SOURCE: EvidenceRef = { kind: "document", id: "ed_vls_0001", matterId: MATTERS.valsara, bates: "MFC-0041877" };
const verdict = (hash: string, status: VerificationVerdict["status"]): VerificationVerdict => ({ artifactHash: hash, verifiedAt: new Date().toISOString(), method: "claims", status, claims: [{ id: "c1", text: "x", citations: [], support: status === "verified" ? "supported" : "unsupported", evidence: status === "verified" ? [SOURCE] : [] }], supported: status === "verified" ? 1 : 0, unsupported: status === "verified" ? 0 : 1, contradicted: 0, score: status === "verified" ? 1 : 0 });
const check = (hash: string, unresolved = 0): CitationCheck => ({ artifactHash: hash, checkedAt: new Date().toISOString(), citations: [], resolved: 1, unresolved, excluded: 0, requiresReview: 0 });

describe("trust records", () => {
  it("walks generated → source_linked → citation_checked → verified → human_approved, keyed by hash", () => {
    const h1 = artifactHashSync("answer v1");
    expect(ensureTrust("art_1", h1, "1").state).toBe("generated");
    expect(recordSources("art_1", [SOURCE], { read: true }).state).toBe("source_linked");
    expect(recordCitationCheck("art_1", check(h1)).state).toBe("citation_checked");
    expect(recordVerification("art_1", verdict(h1, "verified")).state).toBe("verified");
    expect(recordReview("art_1", { reviewerId: "p_jwhitfield", decision: "approved", artifactVersion: "1", artifactHash: h1, at: new Date().toISOString() }).state).toBe("human_approved");
    expect(getTrust("art_1")?.sourceStates).toMatchObject({ exists: true, found: true, read: true, citationLocationValid: true, quoteExists: true, propositionSupported: true });
    expect(listTrust({ state: "human_approved" }).map((r) => r.artifactId)).toContain("art_1");
  });
  it("a changed artifact invalidates verification and review; stale results are refused until re-run", () => {
    const h1 = getTrust("art_1")!.artifactHash;
    const h2 = artifactHashSync("answer v2 (edited after approval)");
    const rebound = touchArtifact("art_1", h2, "2");
    expect(rebound.artifactHash).toBe(h2);
    expect(rebound.state).toBe("source_linked");
    expect(isVerificationCurrent(h2, rebound.verification)).toBe(false);
    expect(rebound.verification?.artifactHash).toBe(h1);
    expect(() => recordVerification("art_1", verdict(h1, "verified"))).toThrow(StaleVerificationError);
    expect(() => recordCitationCheck("art_1", check(h1))).toThrow(/computed against hash/);
    expect(() => recordReview("art_1", { reviewerId: "p", decision: "approved", artifactVersion: "2", artifactHash: h1, at: "now" })).toThrow(StaleVerificationError);
    expect(() => recordReview("art_1", { reviewerId: "p", decision: "approved", artifactVersion: "1", artifactHash: h2, at: "now" })).toThrow(/version 1/);
    expect(recordVerification("art_1", verdict(h2, "partially_supported")).state).toBe("partially_supported");
    expect(touchArtifact("art_1", h2, "2").state).toBe("partially_supported");
    expect(ensureTrust("art_1", artifactHashSync("v3"), "3").state).toBe("source_linked");
  });
  it("derives states without overstating: unsupported or contradicted verification is only claim_checked; rejection is terminal", () => {
    const h = "h";
    expect(deriveTrustState({ artifactHash: h, sourceCount: 0 })).toBe("generated");
    expect(deriveTrustState({ artifactHash: h, sourceCount: 2 })).toBe("generated");
    expect(deriveTrustState({ artifactHash: h, sourceCount: 2, sourceStates: { found: true } })).toBe("source_linked");
    expect(deriveTrustState({ artifactHash: h, sourceCount: 2, verification: verdict(h, "unsupported") })).toBe("claim_checked");
    expect(deriveTrustState({ artifactHash: h, sourceCount: 2, verification: verdict(h, "contradicted") })).toBe("claim_checked");
    expect(deriveTrustState({ artifactHash: h, sourceCount: 2, verification: verdict("other", "verified"), sourceStates: { read: true } })).toBe("source_linked");
    expect(deriveTrustState({ artifactHash: h, sourceCount: 2, review: { reviewerId: "p", decision: "rejected", artifactVersion: "1", artifactHash: h, at: "t" } })).toBe("rejected");
    expect(trustLabel("human_approved")).toBe("Reviewed");
    const rec = { id: "x", artifactId: "x", artifactHash: h, artifactVersion: "1", state: "verified" as const, sources: [SOURCE], sourceStates: { exists: true, found: true, read: true }, verification: verdict(h, "verified"), updatedAt: "t" };
    expect(rebindArtifact(rec, h, "1")).toBe(rec);
    expect(rebindArtifact(rec, "h2", "2").state).toBe("source_linked");
  });
});

describe("substitution guard", () => {
  const resolved: Citation = { raw: "MFC-0041877", state: "resolved", ref: SOURCE };
  it("returns the resolved ref only for the exact record the citation resolved to", () => {
    expect(assertNoSubstitution(resolved, { kind: "document", id: "ed_vls_0001", matterId: MATTERS.valsara })).toBe(SOURCE);
    expect(() => assertNoSubstitution(resolved, { kind: "document", id: "ed_vls_0002" })).toThrow(/not document ed_vls_0002/);
    expect(() => assertNoSubstitution(resolved, { kind: "deposition", id: "ed_vls_0001" })).toThrow(EvidenceSubstitutionError);
    expect(() => assertNoSubstitution(resolved, { kind: "document", id: "ed_vls_0001", matterId: MATTERS.northgate })).toThrow(/resolved in matter/);
  });
  it("refuses unresolved, review-pending, excluded and retried citations", () => {
    for (const state of ["unresolved", "requires_review", "excluded", "retried"] as const) {
      const c: Citation = { raw: "MFC-9999999", state, reason: "test" };
      expect(() => assertNoSubstitution(c, { kind: "document", id: "ed_vls_0001" })).toThrow(EvidenceSubstitutionError);
      try { assertNoSubstitution(c, { kind: "document", id: "ed_vls_0001" }); } catch (e) { expect((e as EvidenceSubstitutionError).attempted).toEqual({ kind: "document", id: "ed_vls_0001", matterId: undefined }); }
    }
  });
});

describe("sensitivity", () => {
  it("is a coded decision: an attorney on cc does not make a document privileged", () => {
    const cc = { id: "ed_x", matterId: MATTERS.valsara, cc: ["Rohit Kapur <r.kapur@meridianfinechem.example>"], coding: { privileged: null } };
    expect(sensitivityOf(cc)).toBe("normal");
    expect(sensitivityOf({ ...cc, coding: { privileged: true, privilegeBasis: "attorney-client" } })).toBe("privileged");
    expect(documentResource(cc)).toEqual({ kind: "document", id: "ed_x", matterId: MATTERS.valsara, sensitivity: "normal" });
  });
});
