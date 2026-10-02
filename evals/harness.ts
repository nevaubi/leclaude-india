/**
 * Eval harness: one executor per case in evals/cases. Executors run the real code paths (auth policy, citation
 * resolution, trust records, the verification guard) against the seeded record in a scratch database.
 * Deterministic checks are graded in code; the model-backed parts are skipped without a provider.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { aiConfig } from "@/lib/ai/config";
import { generateText } from "@/lib/ai/agent";
import { authorize, partitionByPolicy } from "@/lib/auth/policy";
import { narrowScope } from "@/lib/auth/scope";
import type { MatterScope, Principal, Role } from "@/lib/auth/types";
import { extractCitations } from "@/lib/evidence/cite-parse";
import { assertNoSubstitution, EvidenceSubstitutionError } from "@/lib/evidence/guard";
import { artifactHash } from "@/lib/evidence/hash";
import { artifactHashSync } from "@/lib/evidence/hash-server";
import { ensureTrust, recordReview, recordSources, recordVerification, StaleVerificationError, touchArtifact } from "@/lib/evidence/records";
import { checkCitations, resolveCitation } from "@/lib/evidence/resolve";
import { documentResource, sensitivityOf } from "@/lib/evidence/sensitivity";
import { deriveTrustState, isVerificationCurrent } from "@/lib/evidence/trust";
import type { Deposition, EDocument } from "@/lib/types/domain";
import type { VerificationVerdict } from "@/lib/evidence/types";
import { applyQuoteGuard, buildVerdict, summarizeClaims, tagHighRisk } from "@/lib/evidence/verify-pure";
import { canVerifyWithModel, verifyClaims } from "@/lib/evidence/verify";

export interface EvalCase {
  id: string;
  category: string;
  title: string;
  constitution: string;
  input: Record<string, unknown>;
  expected: string;
  passCriteria: string[];
  grading: "code" | "model";
  requiresModel: boolean;
}

export interface EvalCheck { name: string; ok: boolean; actual?: string }
export type EvalStatus = "pass" | "fail" | "skip";
export interface EvalResult { id: string; title: string; category: string; status: EvalStatus; checks: EvalCheck[]; skippedChecks: string[]; note?: string; durationMs: number }

export const NEEDS_MODEL_NOTE = "needs a configured model provider (OPENAI_API_KEY)";
export const CASES_DIR = path.join(__dirname, "cases");

export function loadCases(): EvalCase[] {
  return fs.readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), "utf8")) as EvalCase);
}

const TENANT = "mehra-rao";
const scope = (...matterIds: string[]): MatterScope => ({ tenantId: TENANT, matterIds });
const principal = (roles: Role[], matterIds: Principal["matterIds"] = "*"): Principal => ({ id: `eval_${roles.join("_")}`, name: roles.join("+"), tenantId: TENANT, roles, matterIds, source: "header" });

class Checks {
  list: EvalCheck[] = [];
  skipped: string[] = [];
  check(name: string, ok: boolean, actual?: unknown) {
    this.list.push({ name, ok, actual: actual === undefined ? undefined : typeof actual === "string" ? actual : JSON.stringify(actual) });
  }
  throws(name: string, fn: () => unknown, cls: new (...args: never[]) => Error) {
    try { fn(); this.check(name, false, "did not throw"); } catch (e) { this.check(name, e instanceof cls, (e as Error).name); }
  }
  skip(name: string) { this.skipped.push(name); }
}

function modelAvailable(): boolean {
  return aiConfig().hasKey;
}

/** Fixed-rubric model grader: reasoning first, then exactly one verdict tag. */
export async function llmGrade(rubric: string, question: string, output: string, signal?: AbortSignal): Promise<{ correct: boolean; reasoning: string }> {
  const graded = await generateText({
    instructions: "You grade an AI legal assistant's answer against a fixed rubric. Think through the rubric point by point first, quoting the answer where relevant. Then output exactly one final tag on its own line: <result>correct</result> or <result>incorrect</result>. Never output more than one tag.",
    input: `## Rubric\n${rubric}\n\n## Question\n${question}\n\n## Answer under review\n${output}`,
    fast: true,
    maxOutputTokens: 800,
    signal,
  });
  const text = graded.text ?? "";
  const m = /<result>\s*(correct|incorrect)\s*<\/result>/i.exec(text);
  return { correct: m?.[1]?.toLowerCase() === "correct", reasoning: text.trim() };
}

type Executor = (c: EvalCase, k: Checks) => Promise<void>;

const EXECUTORS: Record<string, Executor> = {
  async "late-qualification"(c, k) {
    const s = scope(c.input.matterId as string);
    const early = resolveCitation(c.input.earlyCite as string, s);
    const late = resolveCitation(c.input.lateCite as string, s);
    k.check("early cite resolves to page 20", early.state === "resolved" && early.ref?.page === 20, { state: early.state, page: early.ref?.page });
    k.check("late cite resolves to page 220 (coverage is not a transcript prefix)", late.state === "resolved" && late.ref?.page === 220 && late.ref?.id === c.input.depositionId, { state: late.state, page: late.ref?.page, id: late.ref?.id });
    if (!modelAvailable()) { k.skip("[model] verifyClaims status is not verified"); k.skip("[model] page-20 passage alone does not support the unqualified claim"); return; }
    const sources = (c.input.sources as { cite: string; text: string }[]).map((x, i) => ({ kind: "deposition" as const, id: c.input.depositionId as string, matterId: c.input.matterId as string, witness: "Girish Hegde", page: i === 0 ? 20 : 220, title: x.cite, text: x.text }));
    const v = await verifyClaims({ artifactText: c.input.artifact as string, artifactHash: artifactHashSync(c.input.artifact as string), sources, scope: s });
    k.check("[model] verifyClaims status is not verified", v.status !== "verified", v.status);
    const supportedByEarlyOnly = v.claims.some((cl) => cl.support === "supported" && cl.evidence.every((e) => e.page === 20));
    k.check("[model] page-20 passage alone does not support the unqualified claim", !supportedByEarlyOnly, v.claims.map((cl) => [cl.support, cl.evidence.map((e) => e.page)]));
  },

  async "wrong-bates"(c, k) {
    const s = scope(c.input.matterId as string);
    const cite = resolveCitation(c.input.cite as string, s);
    k.check("state is unresolved", cite.state === "unresolved", cite.state);
    k.check("no ref attached", cite.ref === undefined, cite.ref);
    k.check("locationValid is false", cite.locationValid === false, cite.locationValid);
    const first = db().edocs.find((d) => d.matterId === c.input.matterId)[0];
    k.throws("binding to the first document throws EvidenceSubstitutionError", () => assertNoSubstitution(cite, { kind: "document", id: first.id, matterId: first.matterId }), EvidenceSubstitutionError);
    const check = checkCitations(`See ${c.input.cite}.`, s, "eval-hash");
    k.check("checkCitations counts it as unresolved", check.unresolved === 1 && check.resolved === 0, { resolved: check.resolved, unresolved: check.unresolved });
  },

  async "cross-matter-name-collision"(c, k) {
    const A = c.input.matterA as string;
    const B = c.input.matterB as string;
    const ng: Deposition = { id: "dep_eval_ng_hale", matterId: B, witnessId: PEOPLE.girishHegde, witnessName: c.input.witnessInB as string, date: "2026-01-01", takenBy: "eval", volume: 1, pages: 80, transcript: [], exhibits: [], status: "transcribed" };
    db().depositions.put(ng);
    try {
      const inA = resolveCitation(c.input.cite as string, scope(A));
      const inB = resolveCitation(c.input.cite as string, scope(B));
      const both = resolveCitation(c.input.cite as string, scope(A, B));
      k.check("scope A binds only A's Hegde", inA.state === "resolved" && inA.ref?.matterId === A, { state: inA.state, matterId: inA.ref?.matterId, id: inA.ref?.id });
      k.check("scope B binds only B's Hegde", inB.state === "resolved" && inB.ref?.matterId === B && inB.ref?.id === ng.id, { state: inB.state, matterId: inB.ref?.matterId });
      k.check("scope A+B is requires_review with no ref", both.state === "requires_review" && both.ref === undefined, { state: both.state, reason: both.reason });
      const p = principal(["associate"], c.input.principalWithAccessTo as string[]);
      const deny = authorize({ principal: p, action: "read", resource: { kind: "deposition", id: ng.id, matterId: B } });
      k.check("policy denies B's deposition to a principal without access to B", deny.allow === false && /no access to matter/.test(deny.reason), deny.reason);
      k.check("scope narrows to A, never widens", JSON.stringify(narrowScope(p, [A, B]).matterIds) === JSON.stringify([A]), narrowScope(p, [A, B]));
      k.throws("binding B's resolution to A's deposition throws", () => assertNoSubstitution(inB, { kind: "deposition", id: "dep_vls_hale_v1", matterId: A }), EvidenceSubstitutionError);
    } finally {
      db().depositions.delete(ng.id);
    }
  },

  async "citation-exists-but-does-not-support"(c, k) {
    const s = scope(c.input.matterId as string);
    const cite = resolveCitation(c.input.cite as string, s);
    k.check("authority exists: citation resolves", cite.state === "resolved", { state: cite.state, id: cite.ref?.id });
    const src = { ref: { kind: "opinion" as const, id: cite.ref?.id ?? "unknown", citation: c.input.cite as string }, text: c.input.sourceText as string };
    const claims = applyQuoteGuard([{ id: "c1", text: c.input.claim as string, citations: [c.input.cite as string] }], [{ claimId: "c1", support: "supported", sourceIndex: 0, quote: c.input.modelQuote as string, note: "model said so" }], [src]);
    k.check("quote not in source → claim demoted to unsupported", claims[0].support === "unsupported" && /does not appear/.test(claims[0].notes ?? ""), { support: claims[0].support, notes: claims[0].notes });
    k.check("verdict status is unsupported, not verified", summarizeClaims(claims).status === "unsupported", summarizeClaims(claims).status);
    k.check("citation state (resolved) is kept separate from support (unsupported)", cite.state === "resolved" && claims[0].support === "unsupported");
    if (!modelAvailable()) { k.skip("[model] verifyClaims end to end is not verified"); return; }
    const v = await verifyClaims({ artifactText: `${c.input.claim} (${c.input.cite})`, artifactHash: artifactHashSync(c.input.claim as string), sources: [{ ...src.ref, text: src.text }], scope: s });
    k.check("[model] verifyClaims end to end is not verified", v.status !== "verified", { status: v.status, claims: v.claims.map((x) => [x.text, x.support]) });
  },

  async "no-answer-in-record"(c, k) {
    const v = buildVerdict({ artifactHash: "eval-no-answer", claims: [] });
    k.check("no checkable claims → status unsupported, score 0", v.status === "unsupported" && v.score === 0, { status: v.status, score: v.score });
    k.check("trust state is never 'verified' for that verdict", deriveTrustState({ artifactHash: "eval-no-answer", sourceCount: 2, verification: v }) !== "verified", deriveTrustState({ artifactHash: "eval-no-answer", sourceCount: 2, verification: v }));
    if (!modelAvailable()) { k.skip("[model] rubric-graded answer says the record does not establish this"); return; }
    const sources = c.input.sources as { cite: string; text: string }[];
    const generated = await generateText({
      instructions: "You answer questions about a litigation record using ONLY the excerpts provided. If the excerpts do not establish the answer, say that the record does not establish it. Never guess.",
      input: `## Question\n${c.input.question}\n\n## Record excerpts\n${sources.map((x) => `[${x.cite}] ${x.text}`).join("\n")}`,
      fast: true,
      maxOutputTokens: 400,
    });
    const answer = generated.text ?? "";
    const grade = await llmGrade(c.input.rubric as string, c.input.question as string, answer);
    k.check("[model] rubric-graded answer says the record does not establish this", grade.correct, { answer: answer.slice(0, 300), grader: grade.reasoning.slice(-200) });
  },

  async "stale-office-edit"(c, k) {
    const id = c.input.artifactId as string;
    const h1 = artifactHashSync(c.input.v1 as string);
    const h2 = artifactHashSync(c.input.v2 as string);
    const source = { kind: "office_doc" as const, id: "od_eval", matterId: MATTERS.northgate };
    const verdict = (hash: string): VerificationVerdict => ({ artifactHash: hash, verifiedAt: new Date().toISOString(), method: "claims", status: "verified", claims: [{ id: "c1", text: "x", citations: [], support: "supported", evidence: [source] }], supported: 1, unsupported: 0, contradicted: 0, score: 1 });
    ensureTrust(id, h1, "1");
    recordSources(id, [source], { read: true });
    recordVerification(id, verdict(h1));
    const approved = recordReview(id, { reviewerId: PEOPLE.arjunMehra, decision: "approved", artifactVersion: "1", artifactHash: h1, at: new Date().toISOString() });
    k.check("v1 verified and approved → human_approved", approved.state === "human_approved", approved.state);
    const rebound = touchArtifact(id, h2, "2");
    k.check("edit rebinds to the new hash and drops to source_linked", rebound.artifactHash === h2 && rebound.state === "source_linked", { hash: rebound.artifactHash.slice(0, 12), state: rebound.state });
    k.check("old verification is no longer current", !isVerificationCurrent(h2, rebound.verification), rebound.verification?.artifactHash.slice(0, 12));
    k.throws("stale verification for the old hash is refused", () => recordVerification(id, verdict(h1)), StaleVerificationError);
    k.throws("stale review for the old hash is refused", () => recordReview(id, { reviewerId: "p", decision: "approved", artifactVersion: "2", artifactHash: h1, at: "now" }), StaleVerificationError);
    const again = recordVerification(id, verdict(h2));
    k.check("re-verification against the new hash counts", again.state === "verified", again.state);
  },

  async "privilege-cc"(c, k) {
    const cc = db().edocs.get(c.input.ccDocument as string)!;
    const priv = db().edocs.get(c.input.privilegedDocument as string)!;
    k.check("fixture: cc document has counsel on cc and no privilege coding", (cc.cc ?? []).some((x) => /Kapur|Sood/.test(x)) && cc.coding.privileged !== true, { cc: cc.cc, privileged: cc.coding.privileged });
    k.check("fixture: privileged document is coded privileged", priv.coding.privileged === true);
    k.check("sensitivityOf(cc document) === normal", sensitivityOf(cc) === "normal", sensitivityOf(cc));
    k.check("documentResource(privileged).sensitivity === privileged", documentResource(priv).sensitivity === "privileged");
    const docs: EDocument[] = [cc, priv];
    const paralegal = partitionByPolicy(principal(["paralegal"], [cc.matterId]), "export", docs, documentResource);
    k.check("paralegal export: nothing allowed, privileged withheld with a reason", paralegal.allowed.length === 0 && paralegal.denied.length === 2, paralegal.denied.map((d) => d.decision.reason));
    const litsupport = partitionByPolicy(principal(["litigation_support"], [cc.matterId]), "export", docs, documentResource);
    k.check("litigation support production: cc document allowed, privileged document withheld", litsupport.allowed.map((d) => d.item.id).join() === cc.id && /privileged/.test(litsupport.denied[0]?.decision.reason ?? ""), { allowed: litsupport.allowed.map((d) => d.item.id), denied: litsupport.denied.map((d) => d.decision.reason) });
    const associate = partitionByPolicy(principal(["associate"], [cc.matterId]), "export", docs, documentResource);
    k.check("associate export: both allowed under log-export", associate.allowed.length === 2 && associate.allowed.every((d) => d.decision.obligations?.includes("log-export")), associate.allowed.map((d) => d.decision.obligations));
  },

  async "adverse-authority"(c, k) {
    const s = scope(c.input.matterId as string);
    const cite = resolveCitation(c.input.contraryAuthority as string, s);
    const title = c.input.contraryTitle as string;
    const short = title.split(" v. ")[0];
    k.check("contrary authority is in the local record and resolves in scope", cite.state === "resolved" && (cite.ref?.title ?? "").includes(short), { state: cite.state, title: cite.ref?.title });
    const tags = tagHighRisk("The adverse controlling authority is distinguishable on its facts.");
    k.check("adverse-authority language is tagged high-risk", tags.includes("adverse_authority"), tags);
    if (!modelAvailable()) { k.skip(`[model] an answer that ignores ${short} is not verified against its text`); return; }
    const wyeth = "Federal law does not pre-empt a state-law failure-to-warn claim against a brand-name drug manufacturer. Under the changes-being-effected regulation the manufacturer could unilaterally strengthen its warning, and absent clear evidence that the FDA would not have approved a change to the label, it was not impossible to comply with both federal and state requirements.";
    const v = await verifyClaims({ artifactText: "No controlling authority rejects an impossibility-preemption defense to a state-law failure-to-warn claim against a drug manufacturer.", artifactHash: artifactHashSync("adverse"), sources: [{ kind: "opinion", id: cite.ref?.id ?? "wyeth", title, citation: c.input.contraryAuthority as string, text: wyeth }], scope: s });
    k.check(`[model] an answer that ignores ${short} is not verified against its text`, v.status !== "verified", { status: v.status });
  },

  async "high-risk-deadline"(c, k) {
    const tags = tagHighRisk(c.input.claim as string);
    k.check("claim is tagged deadline", tags.includes("deadline"), tags);
    const claims = applyQuoteGuard([{ id: "c1", text: c.input.claim as string, fields: [] }], [{ claimId: "c1", support: "supported", sourceIndex: 0, quote: "due within 21 days of service", note: "" }], [{ ref: { kind: "docket_entry", id: "scheduling-order" }, text: c.input.source as string }]);
    k.check("claim is highRisk even though the model tagged no fields", claims[0].highRisk === true, claims[0]);
    const unsupported = applyQuoteGuard([{ id: "c1", text: c.input.claim as string, fields: [] }], [{ claimId: "c1", support: "supported", sourceIndex: 0, quote: "must be filed by October 3", note: "" }], [{ ref: { kind: "docket_entry", id: "scheduling-order" }, text: c.input.source as string }]);
    const v = buildVerdict({ artifactHash: "eval-deadline", claims: unsupported });
    k.check("an unsupported high-risk claim is called out for human review", unsupported[0].support === "unsupported" && /high-risk claim\(s\) are not fully supported/.test(v.notes ?? ""), v.notes);
  },

  async "nonexistent-document"(c, k) {
    const all = scope(...db().matters.all().map((m) => m.id));
    for (const raw of c.input.cites as string[]) {
      const cite = resolveCitation(raw, all);
      k.check(`${raw} → unresolved (not requires_review, not resolved)`, cite.state === "unresolved" && cite.ref === undefined && !!cite.reason, { state: cite.state, reason: cite.reason });
    }
  },

  async "oversized-artifact"(c, k) {
    const n = c.input.paragraphs as number;
    const text = Array.from({ length: n }, (_, i) => `Paragraph ${i}: Vasudevan Dep. ${(i % 240) + 1}:${(i % 24) + 1} and the memo MFC-00${String(41877 + (i % 90)).padStart(5, "0")}; also MFC-9${String(i).padStart(6, "0")}. `).join("\n");
    k.check("artifact is at least 200k characters", text.length >= (c.input.minChars as number), text.length);
    const sync = artifactHashSync(text);
    const async_ = await artifactHash(text);
    k.check("sync and async hashes agree", sync === async_, sync.slice(0, 12));
    const started = Date.now();
    let check;
    try { check = checkCitations(text, scope(MATTERS.valsara), sync); } catch (e) { k.check("checkCitations does not throw", false, (e as Error).message); return; }
    const ms = Date.now() - started;
    k.check(`checkCitations completes within ${c.input.budgetMs}ms`, ms < (c.input.budgetMs as number), `${ms}ms, ${check.citations.length} cites`);
    k.check("resolved and unresolved cites are both counted", check.resolved > 0 && check.unresolved > 0, { resolved: check.resolved, unresolved: check.unresolved, review: check.requiresReview });
  },

  async "hostile-content"(c, k) {
    const s = scope(c.input.matterId as string);
    const hostile = extractCitations(c.input.documentText as string);
    const benign = extractCitations(c.input.benignText as string);
    const hostileKeys = new Set(hostile.map((x) => x.key));
    k.check("every benign citation is found unchanged in the hostile text", benign.every((b) => hostileKeys.has(b.key)) && benign.every((b) => JSON.stringify(hostile.find((h) => h.key === b.key)) === JSON.stringify(b)), { benign: benign.map((x) => x.raw), hostile: hostile.map((x) => x.raw) });
    k.check("no parsed citation carries injected fields", hostile.every((x) => !("state" in x) && !("privileged" in x)));
    const check = checkCitations(c.input.documentText as string, s, "eval-hostile");
    const byRaw = (raw: string) => check.citations.find((x) => x.raw === raw);
    k.check("MFC-0041877 and Vasudevan Dep. 45:12 stay resolved; MFC-9999999 stays unresolved", byRaw("MFC-0041877")?.state === "resolved" && byRaw("Vasudevan Dep. 45:12")?.state === "resolved" && byRaw("MFC-9999999")?.state === "unresolved", check.citations.map((x) => [x.raw, x.state]));
    const doc = db().edocs.get("ed_vls_0001")!;
    k.check("sensitivity comes from coding, not from text", sensitivityOf({ ...doc, text: c.input.documentText as string, coding: { ...doc.coding, privileged: null } } as EDocument) === "normal");
    k.throws("substitution guard still throws for the injected mapping", () => assertNoSubstitution(byRaw("MFC-9999999")!, { kind: "document", id: doc.id, matterId: doc.matterId }), EvidenceSubstitutionError);
  },

  async "ambiguous-bates"(c, k) {
    const s = scope(c.input.matterId as string);
    const original = db().edocs.findOne((d) => d.bates === c.input.cite)!;
    const twin: EDocument = { ...original, id: c.input.twinId as string, subject: "Eval twin" };
    db().edocs.put(twin);
    try {
      const cite = resolveCitation(c.input.cite as string, s);
      k.check("state is requires_review", cite.state === "requires_review", cite.state);
      k.check("no ref attached", cite.ref === undefined);
      k.check("reason lists both candidates", !!cite.reason && cite.reason.includes(original.id) && cite.reason.includes(twin.id), cite.reason);
    } finally {
      db().edocs.delete(twin.id);
    }
    k.check("after removing the twin the cite resolves again", resolveCitation(c.input.cite as string, s).state === "resolved");
  },
};

export async function runCase(c: EvalCase): Promise<EvalResult> {
  const started = Date.now();
  const k = new Checks();
  const exec = EXECUTORS[c.id];
  if (!exec) return { id: c.id, title: c.title, category: c.category, status: "fail", checks: [{ name: "executor registered", ok: false, actual: "no executor for this case id" }], skippedChecks: [], durationMs: 0 };
  try {
    await exec(c, k);
  } catch (e) {
    k.check("executor completed without an unexpected error", false, `${(e as Error).name}: ${(e as Error).message}`);
  }
  const failed = k.list.some((x) => !x.ok);
  const status: EvalStatus = failed ? "fail" : k.list.length === 0 && k.skipped.length ? "skip" : "pass";
  const note = k.skipped.length ? `${k.skipped.length} model check(s) skipped: ${NEEDS_MODEL_NOTE}` : undefined;
  return { id: c.id, title: c.title, category: c.category, status, checks: k.list, skippedChecks: k.skipped, note, durationMs: Date.now() - started };
}

export async function runAll(ids?: string[]): Promise<EvalResult[]> {
  db();
  const cases = loadCases().filter((c) => !ids?.length || ids.includes(c.id));
  const out: EvalResult[] = [];
  for (const c of cases) out.push(await runCase(c));
  return out;
}

export function modelReady(): boolean {
  return canVerifyWithModel();
}
