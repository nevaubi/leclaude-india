import "server-only";
import { nanoid } from "nanoid";
import type { ResponseInput, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import { runAgent, type AgentEvent } from "@/lib/ai/agent";
import { AIConfigError } from "@/lib/ai/config";
import { jsonError, sseResponse } from "@/lib/ai/sse";
import { researchToolset } from "@/lib/ai/toolkit";
import type { ToolDef } from "@/lib/ai/tools";
import { db } from "@/lib/db";
import type { Matter, OfficeKind } from "@/lib/types/domain";
import { LEGAL_STYLE_RULES, FIRM_NAME, todayLine } from "@/lib/ai/prompts";
import { aiBudget, aiConfig } from "@/lib/ai/config";
import { applyCiteCheck, crossCheckCitations } from "@/lib/ai/verify";
import { audit } from "@/lib/integrity/audit";
import { gateReview, makeProvenance } from "@/lib/integrity/provenance";
import { putProvenance } from "@/lib/integrity/store";
import { currentPrincipal } from "@/lib/auth/context";
import type { Principal } from "@/lib/auth/types";
import type { Provenance, ProvenanceSource } from "@/lib/integrity/types";
import type { EditProposal, OfficeAgentMode, OfficeAgentRequestBody, OfficeScope, ReviewFinding } from "./types";

/** Proposals and findings carry the provenance of the agent turn that produced them (TrustBadge reads `provenance`). */
export type ProvenancedProposal = EditProposal & { provenance?: Provenance };
export type ProvenancedFinding = ReviewFinding & { provenance?: Provenance };

function sourceKindOf(c: { url?: string; cite?: string; source?: string }): ProvenanceSource["kind"] {
  if (c.source === "web") return "web";
  if (c.source === "case-law" || /courtlistener/i.test(c.url ?? "")) return "case-law";
  if (c.source === "regulation" || /ecfr|federalregister/i.test(c.url ?? "")) return "regulation";
  if (c.cite && /^[A-Z]{2,}[-_]\d{4,}/.test(c.cite)) return "document";
  return c.url ? "web" : "internal";
}

export interface OfficeAgentContext<S> {
  mode: OfficeAgentMode;
  /** The authenticated principal of this request (set by withAuth); tools use it for matter checks on anything they read. */
  principal?: Principal | null;
  scope: OfficeScope | null;
  research: boolean;
  snapshot: S;
  matter: Matter | null;
  docTitle: string;
  docId?: string;
  context: Record<string, unknown>;
  /** Register an edit proposal; it is streamed to the client and returned for chaining. */
  propose: (p: Omit<EditProposal, "id" | "status">) => EditProposal;
  /** Register a review finding (review mode). */
  finding: (f: Omit<ReviewFinding, "id">) => ReviewFinding;
  proposals: EditProposal[];
  findings: ReviewFinding[];
  emit: (e: AgentEvent) => void;
}

export interface OfficeAgentConfig<S> {
  kind: OfficeKind;
  /** Validate/normalize the raw snapshot sent by the editor. Throw on invalid. */
  parseSnapshot: (raw: unknown) => S;
  /** Editor-specific instructions: describe the document model, the tool vocabulary and mode behaviour. */
  instructions: (ctx: OfficeAgentContext<S>) => string;
  /** Document read/edit tools bound to the snapshot. */
  tools: (ctx: OfficeAgentContext<S>) => ToolDef<never, unknown>[];
  /**
   * True when `tools(ctx)` already returns only the tools allowed in `ctx.mode` (Ask: read tools only; Review: read
   * and comment tools). The shared name-pattern filter is then skipped, so a module owns its mode policy in code.
   */
  modeScopedTools?: boolean;
  /** Per-editor replacement for the shared mode guidance (e.g. a review mode that only comments). */
  modeGuidance?: Partial<Record<OfficeAgentMode, string>>;
  /** Compact serialization of the snapshot for the prompt (keep it under ~30k chars). */
  renderSnapshot: (snapshot: S, scope: OfficeScope | null) => string;
  maxSteps?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Per-request routing decided in code from the request (never by a model): the fast model role and a lower effort for
   * short single-intent turns, the primary model and more effort for analysis. Overrides `reasoningEffort`/`maxSteps`.
   */
  route?: (ctx: OfficeAgentContext<S>, message: string) => { fast?: boolean; reasoningEffort?: OfficeAgentConfig<S>["reasoningEffort"]; maxSteps?: number; reason?: string };
}

const MODE_GUIDANCE: Record<OfficeAgentMode, string> = {
  draft: `MODE: DRAFT. The user wants changes made. Use the editing tools to make every change they asked for (and the obvious consequential ones, e.g. cross-references, numbering, defined terms). Each tool call becomes a previewed edit the user can apply. Do not describe edits you could have made with a tool — make them. After editing, reply with a brief summary (2–6 bullet points) of what you changed and anything that needs the user's judgment. Never paste the full document into chat.`,
  review: `MODE: REVIEW. Do not change the document. Read it carefully (use the read tools to see every part in scope) and record each issue with the report_finding tool: citations that need verification, undefined or inconsistent defined terms, broken cross-references, numbering/formatting defects, missing standard provisions, factual or logical gaps, risk allocation problems, tone/style issues, formula or data errors. Where a fix is mechanical and safe, also propose it with an editing tool so the user can apply it in one click. Finish with a short prioritized summary.`,
  ask: `MODE: ASK. Answer questions about the document (and, if research is enabled, the law and facts around it). Quote the document precisely with paragraph/cell/slide references. Do not modify the document; do not call editing tools.`,
};

/** Build a POST handler that streams the office agent's events for one editor kind. */
export function createOfficeAgentHandler<S>(config: OfficeAgentConfig<S>) {
  return async function POST(req: Request): Promise<Response> {
    let body: OfficeAgentRequestBody;
    try { body = (await req.json()) as OfficeAgentRequestBody; } catch { return jsonError("Invalid JSON body"); }
    if (!body || typeof body.message !== "string") return jsonError("`message` is required");
    const mode: OfficeAgentMode = (["draft", "review", "ask"] as const).includes(body.mode) ? body.mode : "draft";
    let snapshot: S;
    try { snapshot = config.parseSnapshot(body.snapshot); } catch (e) { return jsonError(`Invalid snapshot: ${(e as Error).message}`); }
    const matter = body.matterId ? db().matters.get(body.matterId) : null;

    return sseResponse(async (send, signal) => {
      const proposals: ProvenancedProposal[] = [];
      const findings: ProvenancedFinding[] = [];
      const citations: ProvenanceSource[] = [];
      const model = aiConfig().model;
      const surface = `office.${config.kind}`;
      const startedAt = Date.now();
      let usage: Provenance["usage"] | undefined;
      /** True when the runtime refused to start (no OPENAI_API_KEY): nothing was generated, so nothing is audited or given provenance. */
      let noKey = false;
      const turnProvenance = () => makeProvenance({ surface, sources: citations, model, instructions: `${config.kind}:${mode}`, input: body.message });
      const ctx: OfficeAgentContext<S> = {
        mode,
        principal: currentPrincipal(),
        scope: body.scope ?? null,
        research: Boolean(body.research),
        snapshot,
        matter,
        docTitle: body.docTitle ?? "Untitled",
        docId: body.docId,
        context: body.context ?? {},
        proposals,
        findings,
        emit: (e) => send(e),
        propose: (p) => {
          const full: ProvenancedProposal = { id: nanoid(8), status: "pending", ...p, provenance: turnProvenance() };
          proposals.push(full);
          send({ type: "proposal", proposal: full });
          return full;
        },
        finding: (f) => {
          const full: ProvenancedFinding = { id: nanoid(8), ...f, provenance: turnProvenance() };
          findings.push(full);
          send({ type: "artifact", artifact: { kind: "review-finding", title: full.title, data: full } });
          return full;
        },
      };

      const docTools = mode === "ask" && !config.modeScopedTools ? config.tools(ctx).filter((t) => !isEditingTool(t)) : config.tools(ctx);
      const tools: ToolDef<never, unknown>[] = [...docTools];
      let builtinTools: Tool[] = [];
      if (mode === "review") tools.push(reportFindingTool(ctx));
      if (ctx.research) {
        const r = researchToolset({ web: true, legal: true, internal: true, webContextSize: "medium" });
        tools.push(...r.tools);
        builtinTools = r.builtinTools;
      } else {
        // Internal knowledge is always available; only external research is gated by the toggle.
        tools.push(...researchToolset({ web: false, legal: false, internal: true }).tools);
      }

      // Prompt layout for caching: the instructions and tools are stable for a document and mode, so every turn and
      // every tool round reuses the cached prefix. The volatile parts (scope and the current snapshot) travel with the
      // user's message at the end of the input, after the cache breakpoint.
      const instructions = [
        `You are the ${FIRM_NAME} ${KIND_NAME[config.kind]} drafting assistant embedded in the firm's ${KIND_NAME[config.kind]} editor. ${todayLine()}`,
        `You work on the open document "${ctx.docTitle}"${matter ? ` for the matter ${matter.name} (${matter.caption ?? matter.shortName}; client ${matter.client}, ${matter.clientSide}; ${matter.court ?? "no court"}; stage: ${matter.stage ?? "n/a"})` : ""}.`,
        config.modeGuidance?.[mode] ?? MODE_GUIDANCE[mode],
        ctx.research ? "RESEARCH: enabled. You may use web search, case law, statutes/regulations, dockets and the firm library. Read primary sources before relying on them and cite them." : "RESEARCH: external research is OFF. You may still search the firm library, matter documents and matter context. If the task needs outside authority, say so and mark placeholders [VERIFY].",
        LEGAL_STYLE_RULES,
        config.instructions(ctx),
        "The user's latest message begins with the SCOPE of the request and the CURRENT DOCUMENT SNAPSHOT. The snapshot is the authoritative state of the document at the time of that message; reads through tools return the same content with ids.",
      ].join("\n\n");
      const volatile = [
        ctx.scope && ctx.scope.kind !== "document" ? `SCOPE: The user scoped this request to ${ctx.scope.label} (${ctx.scope.id}). Focus your reads and edits there unless the request clearly needs the whole document.${ctx.scope.text ? `\nScoped text:\n"""\n${ctx.scope.text.slice(0, 8000)}\n"""` : ""}` : "SCOPE: whole document.",
        `CURRENT DOCUMENT SNAPSHOT:\n${config.renderSnapshot(snapshot, ctx.scope)}`,
      ].join("\n\n");

      const routing = config.route?.(ctx, body.message) ?? {};
      // History replay follows the office_agent budget of the model the turn runs on (never below 12 turns × 12,000 chars).
      const budget = aiBudget("office_agent", { fast: Boolean(routing.fast) });
      const input: ResponseInput = [];
      for (const h of (body.history ?? []).slice(-Math.max(12, budget.historyTurns))) input.push({ role: h.role, content: h.content.slice(0, Math.max(12_000, budget.historyChars)) } as ResponseInputItem);
      const userContent: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" | "low" | "auto" }> = [
        { type: "input_text", text: volatile },
        { type: "input_text", text: `REQUEST:\n${body.message}` },
      ];
      for (const a of body.attachments ?? []) if (a?.dataUrl?.startsWith("data:image/")) userContent.push({ type: "input_image", image_url: a.dataUrl, detail: "high" });
      input.push({ role: "user", content: userContent } as ResponseInputItem);

      try {
        await runAgent({
          instructions,
          input,
          tools,
          builtinTools,
          fast: routing.fast,
          maxSteps: routing.maxSteps ?? config.maxSteps ?? 16,
          reasoningEffort: routing.reasoningEffort ?? config.reasoningEffort,
          matterId: matter?.id,
          budget: "office_agent",
          cacheStablePrefix: true,
          verbosity: "low",
          signal,
          state: { snapshot, mode },
          metadata: { app: "leclaude", surface: `office-${config.kind}`, mode, ...(routing.reason ? { route: routing.reason } : {}) },
          onEvent: (e) => {
            if (e.type === "citation") citations.push({ kind: sourceKindOf(e.citation), cite: e.citation.cite, url: e.citation.url, title: e.citation.title });
            if (e.type === "done" && e.usage) usage = e.usage;
            send(e);
          },
        });
      } catch (e) {
        if (e instanceof AIConfigError) { noKey = true; send({ type: "error", message: e.message, code: "no_api_key" }); return; }
        throw e;
      } finally {
        if (noKey) {
          // Explicit degraded state for the client; no audit event and no provenance record for a turn that never ran.
          send({ type: "artifact", artifact: { kind: "office-summary", title: "summary", data: { proposals: 0, findings: 0, sources: 0, verification: null, error: "no_api_key" } } });
        } else {
        // Final provenance for the turn: every proposal/finding gets the full source list, and record cites in the
        // proposal text are cross-checked against the matter's Bates numbers (unresolved ones get [VERIFY] in the summary).
        const known = matter ? db().edocs.find((x) => x.matterId === matter.id).flatMap((x) => [x.bates, ...(x.batesEnd ? [x.batesEnd] : [])]) : [];
        const finalize = (p: Provenance, text: string): Provenance => {
          let out: Provenance = { ...p, sources: citations.slice(), usage };
          if (known.length) { const check = crossCheckCitations(text, { bates: known }); if (check.cites.length) out = applyCiteCheck(out, check); }
          return gateReview(out);
        };
        for (const p of proposals) { p.provenance = finalize(p.provenance ?? turnProvenance(), `${p.title} ${p.summary ?? ""} ${JSON.stringify(p.payload).slice(0, 20_000)}`); if (p.provenance.verification?.unresolvedCites?.length && p.summary) p.summary = crossCheckCitations(p.summary, { bates: known }).text; }
        for (const f of findings) f.provenance = finalize(f.provenance ?? turnProvenance(), `${f.title} ${f.detail} ${f.suggestion ?? ""}`);
        const run = finalize(turnProvenance(), "");
        if (body.docId) putProvenance({ kind: "office.proposal", recordId: `${body.docId}:${nanoid(6)}`, matterId: matter?.id, title: `${ctx.docTitle} — ${mode}: ${body.message.slice(0, 80)}`, href: `/office/${config.kind}/${body.docId}`, provenance: run });
        audit("ai.generate", { kind: "officeDoc", id: body.docId, label: ctx.docTitle, matterId: matter?.id ?? undefined }, { surface, mode, research: ctx.research, model, tokens: usage?.total, proposals: proposals.length, findings: findings.length, sources: citations.slice(0, 10).map((c) => c.cite ?? c.url ?? c.title), durationMs: Date.now() - startedAt, message: body.message.slice(0, 200) });
        send({ type: "artifact", artifact: { kind: "office-provenance", title: "provenance", data: { run, proposals: proposals.map((p) => ({ id: p.id, provenance: p.provenance })), findings: findings.map((f) => ({ id: f.id, provenance: f.provenance })) } } });
        send({ type: "artifact", artifact: { kind: "office-summary", title: "summary", data: { proposals: proposals.length, findings: findings.length, sources: citations.length, verification: run.verification?.status ?? null } } });
        }
      }
    });
  };
}

const KIND_NAME: Record<OfficeKind, string> = { word: "Word", sheet: "Excel", slides: "PowerPoint", pdf: "PDF" };

/** Ask-mode filter for modules that do not scope tools themselves: the declared access wins; names are a fallback. */
export function isEditingTool(t: ToolDef<never, unknown>) {
  if (t.access) return t.access !== "read";
  return /^(accept|reject|resolve|edit|redline|numbering|legal|signature|write|hide|unhide|insert|rewrite|insert|delete|replace|format|set|add|remove|move|apply|style|sort|fill|merge|split|redact|annotate|rotate|reorder|resize|update|clear|append|prepend|convert|create|polish|fix|renumber|generate|build|transcribe|bates|duplicate|condense|restyle|freeze|rename|conditional|autofit|unmerge|hide|show|protect|group)_/i.test(t.name) || t.name === "find_replace";
}

function reportFindingTool<S>(ctx: OfficeAgentContext<S>): ToolDef<never, unknown> {
  return {
    name: "report_finding",
    description: "Record a review finding for the user. Call once per distinct issue. Include a concrete suggestion. Use target ids from the document snapshot so the finding can be located.",
    parameters: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] },
        category: { type: "string", description: "citation | defined-term | cross-reference | numbering | formatting | missing-provision | risk | logic | style | formula | data | consistency | privilege | other" },
        title: { type: "string" },
        detail: { type: "string", description: "What is wrong and why it matters, 1–3 sentences" },
        target: { type: "string", description: "Paragraph id / cell ref / slide id / page number" },
        target_label: { type: "string", description: "Human label like ¶12, B4, Slide 3, p. 2" },
        suggestion: { type: "string", description: "Concrete fix" },
      },
      required: ["severity", "category", "title", "detail"],
    },
    execute: (args: { severity: ReviewFinding["severity"]; category: string; title: string; detail: string; target?: string; target_label?: string; suggestion?: string }) => {
      const f = ctx.finding({ severity: args.severity, category: args.category, title: args.title, detail: args.detail, target: args.target, targetLabel: args.target_label, suggestion: args.suggestion });
      return { recorded: f.id };
    },
  } as ToolDef<never, unknown>;
}
