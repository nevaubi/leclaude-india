# Authentication: sign-in, sessions and lockdown

Companion to [authorization.md](authorization.md) (policy, matter scope, audit). This page covers who the caller is:
the workspace sign-in, the session cookie, the request gate, the owner bootstrap and the cron routes, and the order in
which a production deployment switches from the open demo mode to enforced sign-in without locking anyone out.

## Modes (`AUTH_MODE`)

| Mode | Who the caller is | Gate (src/middleware.ts) |
|---|---|---|
| `dev` (default, unset) | the workspace owner persona for every request; cookies are ignored | off: every page and API answers anyone |
| `header` | a reverse proxy asserts the user in `x-leclaude-user` (needs `AUTH_TRUST_HEADER=true`) | off: the proxy authenticates |
| `jwt` | `Authorization: Bearer <jwt>` (HS256 `AUTH_JWT_SECRET` or RS256 `AUTH_JWT_PUBLIC_KEY`) **or** the `lc_session` cookie issued by `/login` | on |
| anything else | 401 everywhere (fails closed) | on |

`Authorization: Bearer $CRON_SECRET` resolves to the cron service principal in every mode.

## Accounts and passwords

- An account is a firm team member (Settings › Team: attorney, paralegal or staff, active). Custodians, witnesses and
  clients never sign in. Email is the login name (case-insensitive).
- Passwords: at least 12 and at most 256 characters, hashed with `node:crypto` scrypt (N=2^15, r=8, p=1, 16-byte
  random salt, 64-byte key), stored as `scrypt$N$r$p$salt$hash` and verified in constant time
  (`src/lib/auth/password.ts`). Plaintext is never stored or logged.
- Hashes live in their own collection `auth_credentials`, keyed by person id (`src/lib/auth/accounts.ts`), so no
  people listing, export or search can carry one. It syncs to Postgres like every collection (src/lib/db/sync.ts), so
  it is durable and shared across serverless instances. No API returns a hash; managers see `hasPassword: true|false`.
- Each credential has a `sessionVersion`. Setting a new password bumps it and so signs out every older session.

## Sign-in and the session

`POST /api/auth/login { email, password, next? }`

- Success: 200 and `Set-Cookie: lc_session=<jwt>; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200` plus `Secure` when
  `NODE_ENV=production` (override with `AUTH_COOKIE_SECURE=false` only for a plain-HTTP test host). `next` is honoured
  only as a same-origin relative path (`safeNextPath`); anything else becomes `/`.
- Failure: one message for every wrong email or password (`Email or password is incorrect.`); a missing account spends
  the same scrypt work, so neither the message nor the timing reveals who has an account.
- Rate limit: 5 failures per email+IP and 30 per IP in 15 minutes → 429 with `Retry-After`. The limiter is in memory
  per server instance (`src/lib/auth/rate-limit.ts`): on Vercel each warm instance keeps its own window, so the
  effective ceiling is the limit times the number of warm instances; scrypt bounds the guess rate further. Move it to
  Postgres/Redis if the deployment scales out widely.
- 503 `not_configured` when `AUTH_JWT_SECRET` is missing or shorter than 32 characters.

The token is an HS256 JWT signed with `AUTH_JWT_SECRET` with the claims `verifyJwt` already checks: `sub`, `name`,
`email`, `roles`, `tenant`, `iat`, `nbf`, `exp` (12 h), `iss`/`aud` when `AUTH_JWT_ISSUER`/`AUTH_JWT_AUDIENCE` are set,
plus `typ: "lc_session"`, `sv` (session version) and `sid`.

On every request (`sessionPrincipalFromToken` in principal.ts) the cookie is verified and then checked against the live
account: the person must still be an active team member, `sv` must equal the credential's `sessionVersion`, and the
tenant must match. Roles come from the current person record (not the token), and matter access is tenant-wide (`*`)
for the owner, partners and admins, otherwise the matters where the member is lead attorney or on `teamIds`. A session
token presented as a bearer gets the same checks.

`POST /api/auth/logout` clears the cookie (idempotent). Sessions are stateless tokens: to end every session of an
account, set a new password (or deactivate the member).

`GET /api/auth/session` returns the signed-in principal (id, name, email, roles, source, expiresAt).

## The gate (`src/middleware.ts`, `src/lib/auth/gatekeeper.ts`)

With sign-in enforced (`AUTH_MODE=jwt`, or an unknown mode):

| Request | Result |
|---|---|
| page without a valid session cookie | 307 → `/login?next=<path>` (and an invalid cookie is cleared) |
| `/api/*` without a valid session cookie or a Bearer header | 401 `{ error, code: "unauthenticated" }` |
| state-changing `/api/*` whose `Origin` is another host | 403 (CSRF defence in depth on top of SameSite=Lax; login included) |

Public: `/login`, `/setup`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/bootstrap`, `/api/health`,
`/api/official/run`, `/api/intel/jobs/tick` (the last two authenticate themselves), `/_next/*`, `/brand/*`,
`/vendor/*`, `/icon.svg`, `/favicon.ico`, `/robots.txt`.

The middleware verifies the session cookie on the edge with Web Crypto (HS256) so pages are protected; a Bearer
header on `/api/*` is passed through and verified by the route. The middleware is not the authority: every API handler
is wrapped in `withAuth` / `edAuth` (enforced by `tests/auth-route-audit.test.ts`, which walks `src/app/api/**/route.ts`
and fails on any unwrapped handler outside a four-entry allowlist), and server pages resolve the principal from the
request headers (`pagePrincipal()` in `src/lib/auth/page.ts`). The root layout re-resolves the session with the live
account checks on every page and redirects to `/login` when it no longer resolves (a revoked session passes the edge
signature check but never renders a page); the middleware passes it the pathname in `x-leclaude-pathname`, always
overwriting a client-supplied value. Pages never accept a Bearer header; browsers use the cookie.

`/api/health` answers `{ ok, time }` only to an anonymous caller when sign-in is enforced; counts and model settings
need a principal.

## Owner bootstrap and setup

The production workspace already has an owner (from `/setup`) without a password. The one-time owner password:

- `POST /api/auth/bootstrap { token, password }` (UI: `/login` shows "Set the owner password" while no account has a
  password). Requires `AUTH_SETUP_TOKEN` (compared in constant time after SHA-256; 503 when unset, 403 when wrong,
  5 wrong tokens per IP per 15 minutes → 429) and works only while **no** account has a password (409
  `already_bootstrapped` afterwards). Hashing happens first; the "no password yet" re-check, the workspace creation
  and the hash write then run synchronously, so two concurrent calls on one instance cannot both succeed. Signs the
  owner in.
- A fresh workspace: `/setup` collects the firm, the owner and the owner's password. In dev mode it posts to
  `POST /api/workspace` (the optional `password` field is validated before anything is written). With sign-in
  enforced, `/setup` also asks for the setup token and posts to `/api/auth/bootstrap`, which creates the workspace and
  the owner password in one call.
- `GET /api/auth/bootstrap` returns booleans only: `configured`, `needsOwnerPassword`, `setupTokenConfigured`,
  `signInConfigured`, `enforced`.

## Setting other people's passwords

Settings › Team › key icon (`PUT /api/people/:id/password { password }`). The actor must be signed in with a real
session (in dev mode too: the open demo persona can never set a password, so nobody can pre-set the owner's password
before the switch) and manage the workspace (owner, partner, admin). Only the owner may set the owner's password. The
member's existing sessions end; setting your own password re-issues your cookie. Share the password with the member
directly; there is no email delivery and no self-service reset.

## Cron routes

Vercel sends `Authorization: Bearer $CRON_SECRET` to the paths in `vercel.json`; that bearer is the service principal.

- With `CRON_SECRET` set: `/api/intel/jobs/tick` runs only for that bearer (401 otherwise), and `GET /api/official/run`
  starts a run only for the service principal (403 `service_only` for anyone else; 401 for anonymous callers in jwt mode).
- Production (`VERCEL_ENV=production`) with sign-in enforced and **no** `CRON_SECRET`: both answer 503
  `cron_not_configured` before any work, with a message naming the fix (`src/lib/auth/cron.ts`).
- Dev mode without `CRON_SECRET`: unchanged, including the throttled unauthenticated kick of `/api/official/run`.

## Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `AUTH_MODE` | enforcement | `dev` (default), `header`, `jwt` |
| `AUTH_JWT_SECRET` | sign-in, sessions, HS256 bearers | at least 32 random characters (`openssl rand -base64 48`); rotating it signs everyone out |
| `AUTH_SETUP_TOKEN` | owner bootstrap | one-time; inert once any password exists; remove it after the rollout |
| `CRON_SECRET` | scheduled jobs | required in production once `AUTH_MODE=jwt` |
| `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE` | optional | stamped on sessions and enforced on every token |
| `AUTH_COOKIE_SECURE` | optional | `false` only for a plain-HTTP test host |
| `AUTH_JWT_PUBLIC_KEY` | optional | RS256 bearers from an external identity provider (cookies are always HS256) |

## Production rollout (in this order)

1. **Deploy this change with `AUTH_MODE` still unset (dev).** Nothing changes for users.
2. **Set `AUTH_JWT_SECRET`, `AUTH_SETUP_TOKEN` and `CRON_SECRET`** in the project environment (Production) and redeploy.
   Cron keeps working: the bearer is accepted in dev mode too.
3. **Set the owner password**: open `/login`, enter the setup token and the owner's password. You are signed in.
4. **Check sign-in works** while still in dev mode: sign out, sign in again at `/login` with the owner's email and
   password (a wrong password must say "Email or password is incorrect.").
5. **Review Settings › Team** (deactivate anyone who should not have access; anyone could add members while the app
   was open) and **set a password for every member who needs access** (key icon). Share each password directly.
6. **Set `AUTH_MODE=jwt`** and redeploy.
7. **Verify**: a private window on any page redirects to `/login`; `curl -i https://<host>/api/matters` answers 401;
   signing in loads the matters page; Settings › Team loads; sign-out returns to `/login`; the next cron run in the
   Vercel logs answers 200 (not 401/503).
8. **Remove `AUTH_SETUP_TOKEN`** (optional; it is inert once a password exists).

Rollback: unset `AUTH_MODE` (back to dev) and redeploy; accounts and passwords are kept.

## Known limits

- The rate limiter is per instance (see above).
- Sessions are stateless: sign-out clears this browser's cookie only; use a password reset to end all sessions.
- Server pages other than chat, settings, library and office read the database without a matter filter; with
  enforced sign-in only workspace members reach them, but an associate's page views are not yet narrowed to their
  staffed matters (the APIs are). Partners, admins and the owner are tenant-wide either way.
- `/login`, the owner-password step and the password dialog are English-only for now (the setup page's other labels
  remain translated).
