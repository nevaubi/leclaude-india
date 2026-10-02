# LeClaude India (provisional name)

An India-first legal research and litigation workspace for advocates, built only from public sources and from material
the user uploads. It indexes Supreme Court and High Court judgments, Central and State legislation and the official
publications of courts, tribunals and regulators. On top of that index it provides research, a matter desk and drafting.

> **Name.** "LeClaude" is a working name and will be replaced (it uses Anthropic's "Claude" mark). See
> [docs/product/rename-plan.md](docs/product/rename-plan.md). Until the rename, the code, environment variables and
> storage keys keep the `leclaude` / `LECLAUDE_` spelling.
>
> **Scope.** US research, e-discovery, depositions and most of the office suite are frozen. See
> [docs/product/scope-freeze.md](docs/product/scope-freeze.md) and the ordered plan in
> [docs/product/roadmap-india.md](docs/product/roadmap-india.md).

This README describes what the code does today. Corpus sizes and ingestion progress depend on the deployment's
database and change over time. Check them on the running instance (Settings → Data & automation, `GET /api/india/corpus`,
`GET /api/official`) instead of relying on numbers in documents.

---

## What the product does

### Case law: Supreme Court and High Court judgments (`/cases`, `/judges`)

| Layer | Source | What is loaded | Code |
|---|---|---|---|
| Judgment **metadata** (title, court, bench, coram, dates, case number, CNR, neutral citation, disposal, PDF link) | Court-published open datasets on the AWS Open Data Registry: `indian-supreme-court-judgments` and `indian-high-court-judgments` | Supreme Court and all 25 High Courts, one unit per source archive. Each archive is checked against the dataset's own index. Rejects are recorded with a reason. Unknown court codes stay unresolved and are never mapped to the closest court. | `src/modules/india/corpus/backfill.ts`, `src/modules/india/sources/{sci,hc}.ts` |
| Judgment **full text** (page-numbered chunks) | Open India Law (Vaquill) parquet snapshots, CC BY 4.0, text extracted from the courts' published PDFs | **Supreme Court:** English text, linked to metadata records only by exact neutral citation (`load_sc_judgment_text.py`). **High Courts:** the loader accepts any of the 25 courts. Records are linked only when both the CNR and the decision date match (`load_hc_judgment_text.py <court>…`). Which High Courts are actually loaded is deployment state. The design record names Karnataka, Andhra Pradesh and Telangana as the first ones. | `scripts/law-corpus/`, `src/modules/india/corpus/text.ts` |

Most High Court records are **metadata-only** (`text_status = 'none'`). A record is marked `text_status = 'full'` only
after an exact identifier match with Open India Law text. When `HC_TEXT_INGEST=1`, a worker
(`src/modules/india/corpus/hc-text`, cron `/api/india/hc-text/run`) extracts the text of High Court records from their
PDF in the AWS bucket (text layer; OCR of scanned pages, labelled as OCR) into the same `corpus_texts` table, and sets
`text_status` to `full_text`, `ocr`, `partial` or `failed`. Open India Law text is never replaced. Coverage per court
and year is on `/sources/coverage`. See `docs/architecture/hc-judgment-text.md`. In the reader, the official PDF is
always the text of record.

Other case-law features:

- **Citator.** It extracts citations from judgments that have full text. A case citation resolves to a corpus record
  only on an exact normalised neutral or reporter citation. Text cues such as "overruled" or "followed" are labelled as
  cues, not verified treatment. Code: `src/modules/india/citator/**`, `/api/india/citator/build`.
- **Binding effect.** The rule is coded, never inferred by a model: the Supreme Court binds all courts (Art. 141), a
  High Court binds courts in its territory, other High Courts are persuasive, and bench strength decides within one
  court. Code: `bindingEffect` in `src/lib/india/courts.ts`.
- **Judges.** Directory pages built from official rosters, linked to their judgments in the index
  (`src/modules/judges/**`).

### Statutes (`/law`)

- Central, State and UT legislation and regulator regulations, read section by section. The source is the Open India
  Law snapshot (`v2026.08.1` by default), a third-party section-level parse of India Code and regulator publications,
  CC BY 4.0. It is loaded by `scripts/law-corpus/load_open_india_law.py` into `law_datasets`, `law_instruments` and
  `law_provisions`, and queried in place by `src/modules/india/law/**`.
- A section lookup matches the printed number exactly. An unknown section is "not found" and is never replaced by the
  nearest section. The parse is never presented as the official text: every page links to the publisher's own copy.
- **IPC ↔ BNS, CrPC ↔ BNSS, IEA ↔ BSA.** The statutes reader and the Tools page use a coded correspondence table for
  commonly litigated provisions (`src/lib/india/criminal-code-map.ts`, source noted as "MHA/BPRD correspondence table
  (2024); verify against the Gazette text"). The new codes are in force from 1 July 2024. `applicableCode` picks the old
  or new code by date. A split section returns every candidate. A section that is not in the table is reported as
  "unmapped" and never approximated. The table does not yet cover the full codes (roadmap P1).

### Official sources (`/sources`, Diary, research tools)

The pipeline is a durable, resumable job queue in Postgres with leases, per-source cursors, hashing and versioning. It
has these stages: discover → fetch → extract → OCR (only scanned pages, with a page cap) → chunk → embed (pgvector).
Code: `src/modules/official/**`. The cron route is `/api/official/run` (every 2 minutes in `vercel.json`) and runs only
when `OFFICIAL_INGEST=1`. Egress is limited to each source's coded host allowlist (`src/modules/official/registry.ts`).

| Source id | Publisher | Status in code |
|---|---|---|
| `sci-causelist`, `sci-orders`, `sci-calendar` | Supreme Court of India | enabled |
| `dhc-causelist` | High Court of Delhi | enabled |
| `hc-calendars` | High Courts (Delhi, Karnataka and others) | enabled |
| `nclt`, `nclat` | NCLT, NCLAT (cause lists, orders, judgments) | enabled |
| `ibbi` | Insolvency and Bankruptcy Board of India | enabled |
| `sebi-orders` | SEBI enforcement orders, **including SAT orders as mirrored by SEBI ("Orders of SAT")** | enabled |
| `cci-orders` | Competition Commission of India | enabled |
| `egazette` | e-Gazette of India | enabled |
| `cbic` | CBIC notifications and circulars | enabled |
| `gst-council` | GST Council agenda and minutes | enabled |
| `cbdt` | Income-tax circulars and notifications | enabled |
| `sansad` | Parliament questions, debates, committee reports | enabled |
| `ngt-orders` | National Green Tribunal | **disabled**: every judgment or order listing sits behind a CAPTCHA (checked 2026-10-02) and no open listing exists. CAPTCHAs are never bypassed. |
| `sat-orders` | Securities Appellate Tribunal portal | **disabled**: the order search is CAPTCHA-gated. SAT orders come in through the SEBI mirror instead. |
| `mca-master` | MCA company master data (data.gov.in) | **disabled** unless `DATA_GOV_IN_API_KEY` and `DATA_GOV_IN_MCA_RESOURCE` are set. The resource id and API reachability are unverified. |

"Enabled" means an adapter is registered and switched on. It does not mean every run succeeds. Per-source errors (for
example HTTP 404s, non-JSON answers or documents without a text layer) are reported on the status page and in
`GET /api/official`. Search over this corpus is hybrid: Postgres full text and pgvector ANN, fused with reciprocal rank
fusion (`src/modules/official/search.ts`). Every hit carries a stable `src://<documentId>#p<page>` reference, the
publisher and the official URL. OCR text is flagged as OCR.

### Matter desk (`/matters`, `/diary`)

- **Tracking.** A matter tracks case identifiers (case numbers, SC diary numbers, NCLT bench-qualified numbers) and
  advocate names. Identifiers are normalised through `src/modules/official/case-numbers.ts`. An identifier that does not
  normalise is rejected with a reason (`src/modules/matters/desk/tracking.ts`).
- **Cause-list matching.** Parsed cause-list entries (Supreme Court, Delhi High Court, NCLT, NCLAT) are matched on exact
  case keys only, never on party names. Other forums take manually entered hearings.
- **Orders → actions.** The model proposes directions, the next date and compliance tasks, each with a verbatim quote
  and a page. Code checks every quote against the order text. A deadline is computed only when the verified quote states
  the period or the date, using General Clauses Act arithmetic. Anything that cannot be verified is flagged
  (`src/modules/matters/desk/order-actions.ts`, `latest-order.ts`).
- **Hearing briefs.** The deterministic sections (listing, last orders, pending compliance) come from records. A bounded
  research run writes the points and authorities, and every reference is resolved against material read in the same run
  (`src/modules/matters/desk/brief.ts`).

### Documents and drafting (`/documents`, `/office` Word only)

- **Document sets** (`src/modules/documents/**`): upload, extract text with OCR, ask questions with page-cited answers,
  pull facts and build timelines.
- **Litigation drafting from a set** (`src/modules/documents/drafting.ts`):
  - list of dates and synopsis in Supreme Court or High Court format;
  - paperbook index and paperbook PDF with continuous page numbers. "TRUE COPY" appears only on embedded originals whose
    hash matches.
  - para-wise reply. Admissions need a person's approval.
  - working translations, labelled as such;
  - registry defect notices split into numbered tasks.
- **Word editor with a drafting agent** (Draft / Review / Ask). Indian court templates are in
  `src/modules/office/word/templates-india.ts`: plaint, written statement, Order XXXIX I.A., Art. 226 writs (Karnataka,
  Telangana), regular and anticipatory bail (BNSS ss.483 and 482), s.138 NI Act, s.80 CPC notice, vakalatnama, affidavit
  and memo of appearance. Court-specific details are marked `[VERIFY]`.

### Research and chat (`/search`, `/chat`)

- **Research** (`src/modules/search/engine/**`): a planner and parallel lanes for judgments (index and full text),
  statutes, official sources and the firm library. Retrieved material is passed to the model as evidence blocks with
  stable sources. After the answer, code checks quotes, citations and paragraph pinpoints. In deep mode (not fast mode)
  the plan always includes a contrary-authority sub-question. Verification is bound to the answer hash. If the record holds no answer, the engine
  says so instead of padding. Details: [docs/architecture/research-engine.md](docs/architecture/research-engine.md).
- **Chat** handles quick questions over the same tools, plus files and calculations.
- **Tools** (`/tools`) are deterministic calculators: limitation, cheque-dishonour and arbitration timelines, the IPC→BNS
  section converter, court fees and court working days.
- **Courts** (`/courts`) is a directory of courts and tribunals with their official sites, and **News** (`/news`) shows
  headlines from registered Indian legal-news feeds.

Research can also use **Indian Kanoon** (paid API, `INDIAN_KANOON_API_TOKEN`). SCC Online and Manupatra can be used
only through credentials or exports that the firm itself licenses. All three are off unless configured. Subscription
services are never scraped.

---

## Architecture

- **App:** Next.js 15 (App Router), React 19, TypeScript strict, Tailwind v4. `src/app/**` holds thin routes and
  `src/modules/**` holds the feature code.
- **Data:**
  - **Application state** goes through `db()` (`src/lib/db`). Locally it is SQLite (`node:sqlite`). When `DATABASE_URL`
    or `POSTGRES_URL` is set, Postgres (Neon over its HTTP SQL endpoint) is authoritative and each instance keeps a
    local mirror. See [docs/architecture/storage.md](docs/architecture/storage.md).
  - **Corpora** live in Postgres tables that are queried in place: `corpus_*` (judgments and text), `law_*` (statutes),
    `official_*` (official sources), `citator_*`.
  - **Vectors:** official-source chunk embeddings are 1,024-dimensional, stored in `halfvec(1024)` with an HNSW cosine
    index, or `vector(1024)` where `halfvec` is unavailable (`src/modules/official/embed.ts`).
  - Judgment full text is searched with Postgres full text only. It has no embeddings yet.
- **Model runtime:** provider-neutral (Amazon Bedrock, Anthropic Messages API, OpenAI Responses API, and OpenRouter as
  an external router only). A coded capability registry and a central router choose the provider
  (`src/lib/ai/**`). See [docs/architecture/model-runtime.md](docs/architecture/model-runtime.md).
- **Authorization:** principal, matter scope and policy at every route boundary (`src/lib/auth/**`). See
  [docs/architecture/authorization.md](docs/architecture/authorization.md). Sign-in, sessions and the
  production rollout order: [docs/architecture/auth.md](docs/architecture/auth.md).
- **Evidence contract:** exact source identity, separate citation and claim states, and no substitution. See
  [docs/architecture/evidence-contract.md](docs/architecture/evidence-contract.md) and the India design record
  [docs/architecture/india.md](docs/architecture/india.md).
- **Interface languages:** English, Hindi, Kannada, Telugu, Tamil, Marathi, Bengali and Urdu (`src/lib/i18n/**`).

---

## Local development

Requirements: Node.js 22.13 or later (uses the built-in `node:sqlite`). Postgres with the `vector` extension is needed
for the corpora (Neon works). Python 3 with `duckdb` and `psycopg[binary]` is needed only to run the corpus loaders.

```bash
cp .env.example .env.local      # fill in what you need (see below)
npm run dev                     # http://localhost:3000
```

Without a database the app runs on local SQLite under `./data` (or `LECLAUDE_DATA_DIR`). In that mode the case-law,
statutes and official-source surfaces show "not configured" or "not loaded" states instead of results. Seeding:
`LECLAUDE_SEED=reference` (default) or `demo`. Reset local data with `npm run db:reset`.

Load corpora into Postgres (each script documents its own options in its header):

```bash
python3 scripts/law-corpus/load_open_india_law.py          # applies schema.sql itself
python3 scripts/law-corpus/load_sc_judgment_text.py
python3 scripts/law-corpus/load_hc_judgment_text.py karnataka telangana andhra-pradesh
```

Judgment metadata is ingested by the application backfill (`CORPUS_BACKFILL=1`, or an administrator through
`POST /api/india/corpus`). Official sources are ingested by the official runner (`OFFICIAL_INGEST=1`).

### Environment variables (names only; never commit values)

| Group | Variables |
|---|---|
| Database | `DATABASE_URL` (or `POSTGRES_URL`), `LECLAUDE_DATA_DIR` |
| Auth | `AUTH_MODE` (`dev` \| `header` \| `jwt`), `AUTH_JWT_SECRET` or `AUTH_JWT_PUBLIC_KEY`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `AUTH_TRUST_HEADER`, `AUTH_AUDIT_READS`, `LECLAUDE_TENANT_ID`, `LECLAUDE_USER_ID` (dev persona) |
| Scheduled jobs | `CRON_SECRET`, `LECLAUDE_BACKGROUND` |
| Models | `MODEL_PROVIDER`; `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `BEDROCK_MODEL`, `BEDROCK_FAST_MODEL`, `BEDROCK_EMBEDDING_MODEL`; `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_FAST_MODEL`; `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_FAST_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_REASONING_EFFORT`; `OPENROUTER_API_KEY`, `OPENROUTER_ROUTER_MODEL`, `ROUTER_ALLOW_MATTER_DATA` (full list: [model-runtime.md](docs/architecture/model-runtime.md)) |
| Judgment corpus | `CORPUS_BACKFILL`, `CORPUS_MAX_DB_MB`, `LECLAUDE_INDIA_OPEN_DATA`; loaders: `LAW_DATASET_VERSION`, `TEXT_MAX_DB_MB`, `LAW_MAX_DB_MB`; citator: `CITATOR_MAX_DB_MB` |
| High Court PDF text | `HC_TEXT_INGEST`, `HC_TEXT_MAX_DB_MB`, `HC_TEXT_CONCURRENCY`, `HC_TEXT_LIMIT_PER_RUN`, `HC_TEXT_OCR`, `HC_TEXT_OCR_MAX_PAGES`, `HC_TEXT_OCR_MODEL`, `HC_TEXT_MAX_PDF_MB` (all in `docs/architecture/hc-judgment-text.md`) |
| Official sources | `OFFICIAL_INGEST`, `OFFICIAL_INGEST_TOKEN`, `OFFICIAL_MAX_DB_MB`, `OFFICIAL_CONCURRENCY`, `OFFICIAL_OCR_CONCURRENCY`, `OFFICIAL_OCR_MAX_PAGES`, `OFFICIAL_EMBED_MAX_CHUNKS_PER_RUN`, `OFFICIAL_SEMANTIC_MAX_DISTANCE`, `FIRECRAWL_API_KEY`, `DATA_GOV_IN_API_KEY`, `DATA_GOV_IN_MCA_RESOURCE` |
| Licensed / paid research (off by default) | `INDIAN_KANOON_API_TOKEN`, `SCC_ONLINE_API_TOKEN` / `SCC_ONLINE_EXPORT_DIR`, `MANUPATRA_API_TOKEN` / `MANUPATRA_EXPORT_DIR` |
| Product switches | `NEXT_PUBLIC_ENABLE_EDISCOVERY`, `NEXT_PUBLIC_ENABLE_OFFICE_ALL`, `NEXT_PUBLIC_ENABLE_WORKFLOWS`, `NEXT_PUBLIC_ENABLE_INTEL` (all off: frozen surfaces stay hidden), `NEXT_PUBLIC_APP_NAME` |

[`.env.example`](.env.example) documents most of these inline. `AUTH_MODE=dev` (the default) is for local development
only. A deployment must use `jwt` or `header` and must set `CRON_SECRET`, which also authenticates the scheduled routes.

### Verification

```bash
npx tsc --noEmit                 # typecheck
npx eslint <changed files>       # lint
npx vitest run                   # all tests (or: npx vitest run tests/<file>.test.ts)
npx tsx evals/india/run.ts       # deterministic India evals (citations, IPC/BNS boundary, binding effect)
```

The India research evals (`evals/india-research/`) run through `tests/india-research-evals.test.ts`. They use fakes and
need no network or model. Do not run `next build` while other work is in flight on the same checkout.

---

## Data, licences and attribution

Each result carries its source, its licence or terms, and (for judgments) a `text_status`. Attribution is shown in the
UI, in API responses and in tool results:

| Material | Licence / terms as recorded in code | Where recorded |
|---|---|---|
| Judgment text, statutes and regulations from Open India Law (Vaquill) | **CC BY 4.0**, a third-party parse: "verify against the official text"; for judgment text, "the official PDF is the text of record" | `src/modules/india/corpus/text.ts` (`TEXT_ATTRIBUTION`), `src/modules/law/shared.ts` |
| Judgment metadata from the AWS Open Data Registry datasets | The code makes no licence claim of its own and points to the dataset's registry entry | `src/modules/india/corpus/directory.ts`, `src/modules/india/sources/{sci,hc}.ts` |
| Official sources (courts, tribunals, regulators, gazette, Parliament) | "Government publication; verify against the official copy". Cause lists are additionally marked "not authoritative". | `src/modules/official/adapters/**` (`GOV_TERMS`) |
| MCA company master data (data.gov.in) | **Government Open Data License – India (GODL-India)** | `src/modules/official/adapters/regulators/mca.ts` |
| Criminal-code correspondence | "MHA/BPRD correspondence table (2024); verify against the Gazette text" | `src/lib/india/criminal-code-map.ts` |

The repository has no `LICENSE` file. Spreadsheet formulas use HyperFormula under GPLv3 (in the frozen spreadsheet
editor). Replace it or buy a commercial licence before distributing the software (roadmap P5).

---

## Not in scope / frozen

These surfaces stay in the code base but are frozen and hidden by default. See
[docs/product/scope-freeze.md](docs/product/scope-freeze.md) for what "frozen" allows.

- US legal research (CourtListener, eCFR, Federal Register, GovInfo, PACER/RECAP, openFDA) and the US-oriented
  Intelligence explorer.
- E-discovery (review, coding, productions, privilege logs) and deposition intelligence.
- Office suite: Excel, PowerPoint and PDF editors. Word stays, but only as used by India drafting.
- Workflows builder UI (the engine keeps running because other modules use it).

Also out of scope:

- scraping subscription databases (SCC Online, Manupatra) or any site whose terms forbid it;
- bypassing CAPTCHAs;
- legal advice. Output is research support for a qualified advocate, who must check it against the official text.
