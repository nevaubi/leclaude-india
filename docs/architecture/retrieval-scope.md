# Retrieval scope and the tool contract

Constitution references: §22 (authorization invariant — a missing matter filter must never
become "search all matters"), §27 (e-discovery retrieval), §44 (cross-matter name
collision), §45 (typed contracts), §52 (tool design), §53.4 (search/fetch/citation tool
contract). Wave 1, worker W5.

## 1. Scope model

Every row in the `vectors` table carries `tenant_id`, `matter_id` and `corpus`, and every
query narrows to an explicit `RetrievalScope` (`src/lib/ai/vector-store.ts`, client-safe
types):

```ts
type RetrievalCorpus = "authority" | "library" | "intel";

interface MatterRetrievalScope { tenantId: string; matterIds: string[] }             // matter evidence
interface CorpusRetrievalScope { tenantId: string; corpus: RetrievalCorpus; matterIds?: string[] } // tenant-wide corpus
type RetrievalScope = MatterRetrievalScope | CorpusRetrievalScope;
```

Row semantics (`rowInScope`, pure and unit-tested):

| Row                                   | Matter scope `{ matterIds }`          | Corpus scope `{ corpus, matterIds? }`                          |
| ------------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| matter evidence (`corpus = NULL`)     | matches when `matter_id ∈ matterIds`  | never                                                          |
| corpus row, firm-wide (`matter_id = NULL`) | never                            | matches when `corpus` equals                                   |
| corpus row, matter-linked             | matches when `matter_id ∈ matterIds`  | matches when `corpus` equals and (`matterIds` absent or contains `matter_id`) |

`tenant_id` must always equal `scope.tenantId`. An empty `matterIds` matches nothing.
`MatterScope` from `src/lib/auth/types.ts` is structurally a `MatterRetrievalScope`, so
`scopeFor(principal, matterId)` can be passed straight through.

Collections and their corpus:

| Collection             | Rows                                      | Corpus    |
| ---------------------- | ----------------------------------------- | --------- |
| `ediscovery_documents` | matter evidence                           | (none)    |
| `depositions`          | matter evidence (reserved)                | (none)    |
| `library_items`        | firm items and matter work product        | `library` |
| `office_documents`     | editor documents, merged into the library | `library` |
| `intel`                | ingested authority/news/docket records    | `intel`   |

### Index time

`indexDocument(collection, id, text, meta, { scope })` and
`indexDocuments(collection, docs, { scope })` stamp every row from the scope. Each document
may declare `matterId` (or `meta.matterId`). Under a matter scope the declared matter must be
in `scope.matterIds` (a single-matter scope binds undeclared documents to that matter —
the caller declared it; a multi-matter scope requires each document to declare). Under a
corpus scope the declared matter is recorded on the row and, when `scope.matterIds` is
present, must be inside it. Violations throw `ScopeError` before any write.

### Query time

`hybridSearch(collection, query, { scope, k, filter, perDoc })` applies the scope predicate
to both the BM25 and the embedding path before ranking; `filter` remains available as an
additional caller narrowing (never widening). Hits carry `tenantId`, `matterId` and
`corpus`. `indexStats(collection, scope?)` counts rows in scope; counts are not evidence, so
an unscoped stats call is allowed and not reported.

### Migration and backfill

`src/lib/db/sqlite.ts` (not owned by this worker) creates `vectors` without the scope
columns. `vector-store.ts` runs an idempotent migration once per database handle:
`ALTER TABLE vectors ADD COLUMN tenant_id/matter_id/corpus`, an index on
`(collection, tenant_id, matter_id)`, and a backfill of rows whose `tenant_id IS NULL`:
`matter_id` from the row's own `meta.matterId`, `corpus` from the collection table above,
`tenant_id` from the configured tenant (`LECLAUDE_TENANT_ID`, default shared with
`src/lib/auth/principal.ts`; a test keeps the two defaults equal). Legacy rows exist only in
single-tenant development databases, which is why the configured tenant is a safe stamp.
Existing dev databases keep working without a rebuild; `POST /api/library/index` and the
e-discovery reindex rebuild rows with explicit scopes.

## 2. Strict and lenient mode

| `LECLAUDE_STRICT_SCOPE` | Unscoped `hybridSearch` / `indexDocument(s)`                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `true` / `1`            | throws `ScopeError("retrieval without scope (search <collection>)")`                                 |
| unset / `false`         | one structured warning per call site (`{"event":"retrieval.unscoped",…}`), counted in the report, then legacy behaviour: only the caller's own `filter` narrows; nothing is widened by the layer |

Wave 1 ships lenient by default because callers outside this worker's ownership still call
the store without a scope (list below). The scope test suites set the flag themselves
(`vi.stubEnv("LECLAUDE_STRICT_SCOPE", "true")`). The follow-up wave turns strict on for
tests and evals by adding `LECLAUDE_STRICT_SCOPE: "true"` to `test.env` in
`vitest.config.ts` once the callers below are migrated, and then in production.

`unscopedRetrievalReport()` returns `{ strict, total, sites: [{ site, operation, collection,
count, firstAt, lastAt }] }` where `site` is the first stack frame outside the vector
store (`./src/modules/ediscovery/service.ts:320:24` style). `resetUnscopedRetrievalReport()`
clears it. Suggested exposure for the follow-up wave: the integrity scan
(`src/lib/integrity/scans.ts`) or `GET /api/intel/health`.

## 3. Callers still to migrate (exact change)

Files outside this worker's ownership that call the retrieval layer without a scope. In
lenient mode every one of them is recorded by the report; in strict mode each throws.

| File:line | Call | Change |
| --- | --- | --- |
| `src/modules/ediscovery/seed.ts:84` | `indexDocuments(VECTOR_COLLECTIONS.edocs, docs…, { embed: false })` | add `scope: { tenantId: configuredTenantId(), matterIds: [VALSARA, NORTHGATE] }` (docs already carry `meta.matterId`; add `matterId: d.matterId` per doc) |
| `src/modules/ediscovery/service.ts:320` | `hybridSearch(edocs, req.q, { k, perDoc: 1, filter: meta.matterId === req.matterId })` | pass `scope: { tenantId: principal.tenantId, matterIds: [req.matterId] }` from the route's `scopeFor(principal, req.matterId)`; keep the filter or drop it |
| `src/modules/ediscovery/service.ts:689` | `hybridSearch(edocs, q, { …, filter: meta.matterId === doc.matterId })` (similar documents) | `scope: { tenantId, matterIds: [doc.matterId] }` |
| `src/modules/ediscovery/service.ts:732` | `indexDocuments(edocs, docs…, { embed })` (reindex) | `scope: { tenantId, matterIds: unique(docs.map(d => d.matterId)) }`, `matterId: d.matterId` per doc |
| `src/modules/ediscovery/analysis/ai.ts:160` | `hybridSearch(edocs, t, { k: 4, perDoc: 1, filter: meta.matterId === matterId })` | `scope: { tenantId, matterIds: [matterId] }` |
| `src/modules/ediscovery/analysis/service.ts:202` | `hybridSearch(edocs, topic, { k, perDoc: 1, filter: meta.matterId === matterId })` | `scope: { tenantId, matterIds: [matterId] }` |
| `src/modules/intel/seed.ts:148` | `indexDocuments(INTEL_VECTOR_NAMESPACE, vectorDocs, { embed: false, chunkSize: 4000 })` | `scope: { tenantId: configuredTenantId(), corpus: "intel" }` |
| `src/modules/intel/store.ts:237` | `indexDocuments(INTEL_VECTOR_NAMESPACE, rows…, { embed, chunkSize: 4000 })` | `scope: { tenantId, corpus: "intel" }` (`indexIntelDocument` gains `opts.scope`, default from `currentPrincipal()?.tenantId ?? configuredTenantId()`) |
| `src/modules/intel/store.ts:372` | `hybridSearch(INTEL_VECTOR_NAMESPACE, query, { k, filter: searchFilter(q), perDoc: 1 })` | `searchIntel(q)` gains `q.scope?: CorpusRetrievalScope` (default `{ tenantId, corpus: "intel" }` from the principal); pass it through. `get_intel_context` and `search_intel` (`src/lib/ai/agents/registry.ts:27`) then pass the scope they already resolve |
| `src/modules/office/shared/docs-service.ts:168` | `indexDocument(VECTOR_COLLECTIONS_OFFICE, doc.id, text, meta)` | `{ scope: { tenantId, corpus: "library" } }` with `meta.matterId` kept (rows then match both library corpus searches and matter scopes) |
| `src/modules/search/engine/deps.ts:129-143` | `toolCtx(signal)` → `{ emit, signal, state: {} }` then `searchLibraryTool.execute` / `searchEdiscoveryTool.execute` with `matter_id: settings.matterId` | build the context with `principal` and `scope: scopeFor(principal, settings.matterId)`; without a matter the ediscovery lane now returns `{ error: "scope_required" }` unless a principal is present (dev mode supplies the demo principal) |
| `src/modules/search/service.ts:235-239` | `getLibraryItemTool.execute` / `getEdiscoveryDocumentTool.execute` with a bare ctx | same: pass `principal`/`scope`; note `text` is now a window (`window.next_offset`) and `getLibraryItemTool` returns `content` windowed the same way |
| `src/modules/workflows/executors.ts:157-161` | `toolCtx(x)` sets `state.matterId` | already honoured (state fallback); add `principal`/`scope` from the run's principal when the workflow engine carries one |
| `src/lib/ai/agent.ts:245` | `ctx` built from `opts.state`, `traceId`, `runId` | add `principal: opts.principal`, `scope: opts.scope` (see §5) and execute tools through `runTool` |
| `src/lib/integrity/scans.ts:95-97` | `indexStats("ediscovery_documents")` etc. | none required (stats are unscoped by design); optionally report `unscopedRetrievalReport()` here |
| `tests/foundation.test.ts:71-76`, `tests/ediscovery.test.ts:203` | direct unscoped `indexDocument`/`hybridSearch` | pass `{ scope }` before strict mode is turned on in `vitest.config.ts` |

Already migrated by this wave: `src/modules/library/seed.ts` (corpus scope),
`src/modules/library/service.ts` (`reindexItem`, `rebuildIndex`, `searchLibrary` — corpus
scope narrowed to `accessibleMatterIds(currentPrincipal())`), every tool in
`src/lib/ai/toolkit/internal.ts`. `src/modules/intel/context/**` and
`src/modules/intel/analysis/**` do not call the retrieval layer.

## 4. Tool contract (`src/lib/ai/tools.ts`, additive)

`ToolDef` gains `examples?`, `timeoutMs?` (default 30 000), `maxResultChars?` (default
12 000) and `authorize?(args, ctx)` (throw to deny). `ToolContext` gains `principal?`,
`scope?` (`RetrievalScope | MatterScope`), `traceId?`, `runId?`. `AgentEmit` gains
`{ type: "evidence", evidence: EvidenceProvenance[] }` and `{ type: "trace", trace }`.

`runTool(def, args, ctx): Promise<ToolRunResult>` never throws:

1. `ctx.signal` already aborted → `{ error: "cancelled", code: "cancelled" }`.
2. `def.authorize` → a throw becomes `{ code: "unauthorized" }` (an `AuthError` message is
   `forbidden`/`unauthenticated`; the policy reason never reaches the model).
3. timeout: a fresh `AbortSignal` linked to `ctx.signal` and to `def.timeoutMs`; on expiry
   the result is `{ error: "timeout", code: "timeout", retryable: true }` and `timedOut: true`.
4. `execute(args, { ...ctx, signal })`; a returned `{ error, code }` object is treated as a
   failure without being thrown.
5. `boundToolResult` keeps JSON valid by trimming the longest string fields with
   `[truncated: N more chars; ask for the next window]`, then hard-cuts with the same marker.
6. `shapeToolError` maps `ToolExecutionError` → its code, `ScopeError` → `scope_required`,
   `AuthError` → `unauthorized`, `HttpError` → `upstream_error` (+status, retryable on 429/5xx),
   `InferenceError` → `upstream_error`/`tool_error`, anything else → `tool_error` with a
   sanitized first-line message (no markup, no stack frames, ≤ 400 chars).
7. `evidence` events emitted during execution are collected on `result.evidence` (and
   forwarded); `trace` events are emitted at start and end with `traceId`/`runId`.

`toProviderToolSpec(def)` → `ToolSpec { name, description, parameters, strict, examples? }`
with the permissive schema; providers apply their own strict transform and send
`examples` only when their capability profile has `toolUseExamples` (Anthropic
`input_examples` behind `ANTHROPIC_TOOL_EXAMPLES`).

The read tools (`get_ediscovery_document`, `get_library_item`, `get_opinion_text`,
`get_cfr_section`, `get_federal_register_document`) take `offset` and return
`window: { offset, length, total, next_offset }` so "ask for the next window" is actionable.

## 5. How the agent loop should call `runTool`

```ts
const ctx: ToolContext = { emit, signal, state, principal, scope, traceId, runId };
const r = await runTool(def, normalizeArgs(args), ctx);
emit({ type: "tool.result", id, name: def.name, ok: r.ok, result: r.ok ? summarize(r.value) : undefined, error: r.error?.error, durationMs: r.durationMs });
registry.addEvidence(r.evidence);                      // shared evidence/read registry (§14)
return { type: "function_call_output", call_id: id, output: r.output };   // already bounded
```

`r.output` replaces `serializeToolOutput`; the per-tool `maxResultChars` bound is tighter
than the loop's 60 000-character cap. Unknown tool names should produce
`{ error: "Unknown tool: x", code: "unknown_tool" }` for symmetry.

## 6. Scope resolution inside tools (`src/lib/ai/toolkit/internal.ts`)

`resolveMatterScope(ctx, requestedMatterId?)` and `resolveCorpusScope(ctx, corpus,
requestedMatterId?)` resolve, in order:

1. `ctx.scope` — a matter scope, or a corpus scope (its `matterIds` bound matter evidence; a
   corpus-only scope cannot reach matter evidence or another corpus);
2. `ctx.principal ?? currentPrincipal()` — `hasMatterAccess` for a requested matter,
   `accessibleMatterIds` otherwise (dev mode supplies the demo principal, header/jwt modes
   return null outside a request);
3. `ctx.state.matterId` (existing callers) with `ctx.state.tenantId ?? configuredTenantId()`;
4. otherwise `{ error: "scope_required", code: "scope_required" }`.

The requested matter (`args.matter_id ?? state.matterId`) narrows and is checked; a
matter outside the scope yields `{ code: "unauthorized" }`. A Bates number or id that does
not resolve inside the scope is `not_found` — never mapped to another document.

## 7. Source identifier scheme

| Evidence | Identifier | Resolves via |
| --- | --- | --- |
| e-discovery document | `matter://<matterId>/document/<documentId>` + `/page/<page>` when a page map exists, `/chunk/<index>` for a retrieval chunk | `db().edocs.get(id)` + scope check |
| deposition segment | `depo://<matterId>/<depositionId>/p/<page>/l/<start>[-<end>]` (end only when known) | `db().depositions.get(id).transcript` |
| library item | `library://<tenantId>/item/<itemId>` | `db().library.get(id)` + scope check |
| intel record | `intel://<tenantId>/document/<docId>[/chunk/<idx>]` | `intelDocuments().get(id)` |
| CourtListener | `authority://courtlistener/opinion/<id>`, `…/cluster/<id>`, `…/docket/<id>[/entry/<n>]` | CourtListener REST v4 |
| eCFR | `authority://ecfr/title-<t>/section-<s>` (or `part-<p>`) | eCFR versioner |
| Federal Register | `authority://federalregister/<document_number>` | FR API |
| GovInfo | `authority://govinfo/<packageId>[/<granuleId>]` | GovInfo |

Page-level `matter://…/page/<n>` identifiers are emitted only once ingestion stores a page
map (`EDocument.pages` is a count today); chunk identifiers are honest until then.

Every tool result is a focused evidence block (`source`, `title`, passage/text, light
metadata) and the application-side provenance (`EvidenceProvenance`: provider, tool,
query, rank, score, documentId, matterId, tenantId, bates/page/line, chunkIndex,
authorityId, url, hash, retrievedAt) is emitted through `ctx.emit({ type: "evidence" })`
and collected by `runTool`, never serialized into the model-facing text.

## 8. Tests

- `tests/ai-scope-isolation.test.ts` — two matters sharing the surname Vasudevan and a witness
  named Hema Vasudevan; scoped search, corpus scope, index-time validation, legacy backfill,
  `findPeople`/`findDocuments`/`findDepositionPassages`, explicit `ctx.scope`, strict mode
  throws, lenient report and single warning.
- `tests/tools-contract.test.ts` — `runTool` authorize denial, timeout, cancellation,
  truncation marker (valid JSON), deterministic error shapes, evidence collection;
  `toProviderToolSpec` examples; every internal/legal tool declares examples and a timeout.
- `tests/tools-internal-scope.test.ts` — internal tools refuse without scope; state,
  principal and explicit-scope resolution; stable identifiers; windows.
