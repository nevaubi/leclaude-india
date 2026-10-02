# Authorization

Sign-in, the session cookie, the request gate (`src/middleware.ts`), the owner bootstrap and the production rollout order are in [auth.md](auth.md).

Constitution §21 (identity), §22 (authorization is a hard invariant), §41 (security), §42 (observability),
§54 (human review). Code: `src/lib/auth/**`.

> Every sensitive read or action satisfies **authenticated principal ∩ tenant ∩ role ∩ matter access ∩ resource
> ∩ action**, enforced at the route, tool and data boundaries. UI matter selection is not authorization; a prompt
> saying "stay in matter X" is not authorization; the model never decides authorization.

## Modules

| file | scope | purpose |
|---|---|---|
| `types.ts` | client-safe | `Principal`, `MatterScope`, `Action`, `ResourceRef`, `PolicyInput/Decision`, `AUTH_MODES` |
| `policy.ts` | client-safe, pure | `authorize()`, `partitionByPolicy()`, `hasMatterAccess()`, `firstAccessibleMatter()`, role tables |
| `errors.ts` | client-safe | `AuthError` (401 unauthenticated / 403 forbidden, with the policy reason) |
| `principal.ts` | server-only | `resolvePrincipal(req)` for dev / header / jwt modes, the cron service principal, `rolesForPerson()` |
| `context.ts` | server-only | `runWithPrincipal()`, `currentPrincipal()`, `requirePrincipal()`, `currentObligations()` (AsyncLocalStorage) |
| `scope.ts` | server-only | `matterScope()`, `scopeFor()`, `narrowScope()`, `requireMatterAccess()` |
| `resources.ts` | server-only | `refs.*` ResourceRef builders (look the record up for its matter and sensitivity), `jsonBody()`, `queryParam()` |
| `audit.ts` | server-only | append-only `audit_events` collection, `auditDecision()`, `recentAudit()` |
| `route.ts` | server-only | `withAuth(handler, { action, resource })` for Next 15 route handlers; re-exports the scope and context helpers |

## Modes (`AUTH_MODE`)

| mode | principal source | notes |
|---|---|---|
| `dev` (default) | `currentUser()` → the seeded person | tenant from `LECLAUDE_TENANT_ID` (default `seeger-weiss`); roles from the person record (`rolesForPerson`), `["associate"]` when there is none; `matterIds: "*"`. Behavior of the demo partner is unchanged; other personas (`LECLAUDE_USER_ID=p_mlopez`) now meet the matrix. |
| `header` | `x-leclaude-user` JSON or base64url JSON `{ id, name, tenantId, roles, matterIds }` | trusted only with `AUTH_TRUST_HEADER=true` behind a proxy that authenticated upstream; unknown roles are dropped, malformed matter ids are dropped, an `expiresAt` in the past is a 401 |
| `jwt` | `Authorization: Bearer <jwt>` | HS256 with `AUTH_JWT_SECRET` or RS256 with `AUTH_JWT_PUBLIC_KEY` (PEM); `alg=none` and any other algorithm are rejected; an RS256 key never acts as an HMAC secret; `exp` required (60 s leeway), `nbf`/`iat` checked, `iss`/`aud` enforced when `AUTH_JWT_ISSUER`/`AUTH_JWT_AUDIENCE` are set. Claims → principal: `sub`, `name`/`preferred_username`/`email`, `tenant`/`tenant_id`/`tid`, `roles`, `matters`/`matter_ids` (array or `"*"`), `sid`/`jti`. `jose` is not installed; verification uses `node:crypto` only. |

An unknown `AUTH_MODE` fails closed (401), never falls back to the demo persona. In every mode a request carrying
`Authorization: Bearer <CRON_SECRET>` (constant-time compare) resolves to the `svc_cron` service principal so
Vercel cron / external schedulers keep driving `/api/intel/jobs/tick` behind real authentication.

Outside a request (jobs, scripts) `currentPrincipal()` returns the dev persona only in dev mode; in header/jwt
modes it returns `null` and `requirePrincipal()` throws 401.

## Roles and the matrix

Roles: `partner`, `associate`, `paralegal`, `litigation_support`, `reviewer`, `admin`, `client_guest`, `service`.
Roles are unioned (a principal with several roles gets the most permissive outcome). Gates run in order and the
first failing gate is the reason: principal validity/expiry → tenant → matter access → sensitivity → action.

| action | allowed roles |
|---|---|
| `read` | every role (client guests only on explicitly shared matters, never firm-wide resources) |
| `write`, `code` | partner, associate, paralegal, litigation_support, reviewer (+ admin on non-matter resources) |
| `produce`, `export`, `download` | partner, associate, admin; litigation_support may `export`/`produce` document sets (productions). Obligation `log-export`. |
| `delete` | partner, associate, admin |
| `approve` | partner, associate, reviewer, admin (never service: approval is a human control boundary) |
| `run` | everyone except client_guest |
| `admin` | admin, partner |
| service principal | everything within its tenant except `approve` |

Matter access: `matterIds: "*"` is tenant-wide; otherwise explicit membership. A `client_guest` needs an explicit
list even if it holds `"*"`.

Sensitivity: `privileged` is fully readable by partner/associate/admin/reviewer; a paralegal may `read` it only
under the `redact-privileged` obligation and may never export or edit it; litigation_support and client guests
are denied. `restricted` is readable by partner/admin only. Privilege is a coded decision
(`coding.privileged === true`, see `src/lib/evidence/sensitivity.ts`), never inferred from a cc line.

Every decision carries a reason. `partitionByPolicy()` applies the matrix to a record set and returns the withheld
records with their reasons, so export and search surfaces can say "n records withheld" instead of silently
widening or narrowing.

## Route wrapper

```ts
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";

async function handleGET(_req: NextRequest, { params }: Params) { /* unchanged */ }
export const GET = withAuth(handleGET, { action: "read", resource: (_req, { id }) => refs.library(id) });
```

`withAuth` resolves the principal, computes the `ResourceRef` (the `refs.*` helpers look the record up so the
policy sees the real matter and sensitivity; a missing record yields a ref without a matter and the handler's own
404 stands), authorizes, audits, runs the handler inside `runWithPrincipal`, and maps failures:

- 401 `{ error, code: "unauthenticated" }` when no principal can be resolved;
- 403 `{ error: "Forbidden", code: "forbidden" }` — one shape, the reason only in dev mode; a denial never
  becomes a 404, so existence never leaks across tenants or matters;
- `AuthError` thrown by services deeper in the stack (`requireMatterAccess`, `requirePrincipal`) maps the same way
  and is audited.

`action` may be a function of the request (`intel/insights/[id]`: publish → `approve`, verify → `run`, else
`write`). Resource functions must not consume the body; `jsonBody()`/`bodyMatterId()` read a clone.

Action mapping applied across the 85 wrapped routes: `read` for GET (and file serving under `/api/blobs/[id]`,
which is inline display, not an export); `write` for POST/PUT/PATCH that persist; `delete` for DELETE; `run` for
`*/run`, `*/start`, `*/tick`, cancel/rerun, AI runs that persist nothing (search run/ask/expand/summarize,
workflow generate) and scheduler ticks; `approve` for review decisions and workflow-run approvals;
`admin` for settings and intel administration (creating/patching/deleting sources, index rebuilds, integrity
scan runs).

## Scope for queries

Services filter by `MatterScope`, never by "the matter the UI selected":

```ts
const principal = requirePrincipal();
const scope = scopeFor(principal, requestedMatterId);   // 403 when not a member; full scope when none requested
const docs = db().edocs.find((d) => scope.matterIds.includes(d.matterId));
```

`matterScope("*")` enumerates the tenant's matters; `narrowScope(principal, ids)` drops foreign ids and never
widens; an empty scope matches nothing (a missing matter filter never becomes "search all matters").

## Audit

`audit_events` (append-only; sequence-numbered) records
`{ id, seq, at, principalId, principalName, source, tenantId, action, resource, decision, reason, via, obligations, ip }`
for every denial, every non-read allow, and every read of privileged/restricted material; plain allowed reads are
recorded when `AUTH_AUDIT_READS=1`. `recentAudit({ principalId, decision, action, matterId, since, limit })` reads
it. Record mutations keep using the hash-chained integrity audit (`audit_log`).

## Environment

`AUTH_MODE`, `AUTH_TRUST_HEADER`, `AUTH_JWT_SECRET`, `AUTH_JWT_PUBLIC_KEY`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`,
`LECLAUDE_TENANT_ID`, `AUTH_AUDIT_READS`, `CRON_SECRET` (see `.env.example`).

## Follow-up wave: routes not yet wrapped

These directories are owned by other workstreams right now. Apply `withAuth` with the mapping below (the same
`refs.*` helpers apply; `refs.edoc()` carries privilege sensitivity, `refs.deposition()` the matter).

### `src/app/api/ediscovery/**`

| route | method | action | resource |
|---|---|---|---|
| `docs` | GET | read | `{ kind: "document", matterId: queryParam(req, "matter", "matterId") }` |
| `docs` | POST (create/import) | write | `{ kind: "document", matterId: await bodyMatterId(req) }` |
| `docs/[id]` | GET | read | `refs.edoc(id)` |
| `docs/[id]` | PATCH/PUT (coding) | write | `refs.edoc(id)` |
| `docs/[id]` | DELETE | delete | `refs.edoc(id)` |
| `docs/[id]/text`, `docs/[id]/family`, `docs/[id]/near-duplicates` | GET | read | `refs.edoc(id)` |
| `docs/bulk-code`, `docs/batch` | POST | write | `{ kind: "document", matterId: await bodyMatterId(req) }` |
| `depositions` | GET | read | `{ kind: "deposition", matterId: queryParam(req, "matter", "matterId") }` |
| `depositions/[id]` | GET | read | `refs.deposition(id)` |
| `depositions/[id]` | PATCH | write | `refs.deposition(id)` |
| `depositions/import` | POST | write | `{ kind: "deposition", matterId: await bodyMatterId(req) }` |
| `analysis/*` (timeline, conflicts, fact-matrix, knowledge-map, digest, outline, cross) | GET | read | `{ kind: <timeline|conflict|knowledge_graph|deposition>, matterId }` |
| `analysis/*` | POST (generate) | run | same kind, `matterId` from body |
| `analysis/*/[id]` | PATCH/DELETE | write/delete | same kind with `id` |
| `review/batches*`, `review/saved-searches*`, `review/layouts*`, `review/redactions*` | GET | read | `{ kind: "review", matterId }` |
| `review/batches*` etc. | POST/PATCH | write | `{ kind: "review", matterId }` |
| `review/batches/[id]/qc` decisions | POST | approve | `{ kind: "review", id, matterId }` |
| `review/productions` | GET | read | `{ kind: "document", matterId }` |
| `review/productions` | POST (create) | write | `{ kind: "document", matterId }` |
| `review/productions/[id]/finalize`, `.../export`, `.../download` | POST/GET | produce / export / download | `{ kind: "document", id, matterId }` (litigation_support allowed for export/produce) |
| `privilege-log*` | GET | read | `{ kind: "document", matterId, sensitivity: "privileged" }` |
| `privilege-log*` | POST/PATCH | write | same |
| `privilege-log/export` | GET/POST | export | same |
| `search`, `term-report` | GET/POST | read | `{ kind: "document", matterId }` |
| `index` (rebuild) | POST | admin | `{ kind: "document", matterId }` |

### `src/app/api/office/**`

| route | method | action | resource |
|---|---|---|---|
| `docs` | GET | read | `{ kind: "office_doc", matterId: queryParam(req, "matter", "matterId") }` |
| `docs` | POST | write | `{ kind: "office_doc", matterId: await bodyMatterId(req) }` |
| `docs/[id]` | GET | read | `refs.officeDoc(id)` |
| `docs/[id]` | PUT/PATCH | write | `refs.officeDoc(id)` |
| `docs/[id]` | DELETE | delete | `refs.officeDoc(id)` |
| `docs/[id]/versions*`, `docs/[id]/comments` GET | GET | read | `refs.officeDoc(id)` |
| `docs/[id]/comments` POST, `docs/[id]/restore`, `docs/[id]/audit-apply`, `docs/[id]/proposals*` | POST | write | `refs.officeDoc(id)` |
| `docs/[id]/agent`, `docs/[id]/chat` (streaming agent) | POST | `write` in draft mode, `read` in ask/review mode (action from `bodyString(req, "mode")`) | `refs.officeDoc(id)` |
| `docs/[id]/export`, `docs/[id]/download`, `export` | GET/POST | export | `refs.officeDoc(id)` |
| `import` | POST | write | `{ kind: "office_doc", matterId: queryParam(req, "matterId") }` (multipart; do not clone) |
| `templates*` | GET | read | `{ kind: "office_doc" }` |

### `src/app/api/ai/**`

| route | method | action | resource |
|---|---|---|---|
| `status` | GET | read | `{ kind: "settings" }` |
| `chat`, `agent`, `run` (generic agent entry points) | POST | run | `{ kind: "research", matterId: await bodyMatterId(req) }` |
| `embed`, `index` | POST | admin | `{ kind: "settings" }` |
| `models`, `providers` (configuration) | GET | read; POST/PUT | admin | `{ kind: "settings" }` |

### `src/app/api/health`, `src/app/api/quick-search`

| route | method | action | resource |
|---|---|---|---|
| `health` | GET | leave unwrapped (liveness probe; returns no data) | — |
| `quick-search` | GET | read | `{ kind: "research", matterId: queryParam(req, "matter", "matterId") }` |

Also in the follow-up wave: internal server-to-server callers of `POST /api/workflows/events` must either call
`dispatchInboundEvent()` directly or send the service token; and `intel/context`, `intel/watches`,
`intel/insights` should take the user id from `requirePrincipal()` instead of `currentUser()`.
