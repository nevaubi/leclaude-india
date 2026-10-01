# LeClaude India — design record

LeClaude India is the LeClaude litigation platform adapted to Indian law. It keeps the platform (runtime, evidence contract,
authorization, Office workspace, workflows) and replaces the US legal layer (CourtListener, eCFR, Federal Register, Bluebook,
FRCP, PACER, Bates-centric e-discovery) with Indian sources, citations, procedure and languages.

## Focus
- Courts: Supreme Court of India; High Court of Karnataka (Bengaluru principal bench, Dharwad, Kalaburagi); High Court for
  the State of Telangana (Hyderabad); High Court of Andhra Pradesh (Amaravati; sat at Hyderabad until 1 Jan 2019).
- Languages: interface in English, Hindi, Kannada, Telugu, Tamil, Marathi, Bengali and Urdu (RTL); content in those plus
  Gujarati, Malayalam, Punjabi, Odia and Assamese. Registry: `src/lib/india/languages.ts`.
- Criminal law transition: IPC → Bharatiya Nyaya Sanhita (BNS), CrPC → Bharatiya Nagarik Suraksha Sanhita (BNSS),
  Indian Evidence Act → Bharatiya Sakshya Adhiniyam (BSA), in force 1 July 2024. Offences committed before that date
  remain governed by the old codes; the section mapping is a coded table, never a model guess.

## Sources (and what each may be used for)
| Source | Access | Use |
|---|---|---|
| Supreme Court judgments, AWS Open Data `indian-supreme-court-judgments` (ap-south-1 / us-east-1) | public S3, no key | bulk and incremental ingest; 1950–present; English plus court-published regional translations |
| High Court judgments, AWS Open Data `indian-high-court-judgments` (ap-south-1) | public S3, no key | per-court ingest; focus courts 29_3 (Karnataka), 36_29 (Telangana), 28_2 (Andhra Pradesh) |
| Indian Kanoon API `api.indiankanoon.org` | paid, firm API token (`INDIAN_KANOON_API_TOKEN`) | live search, full text, citing/cited-by |
| India Code `indiacode.nic.in` | public web | central and state Acts, sections, amendments |
| eCourts services | public web, captcha on some pages | case status and orders by CNR where reachable; never automated past a captcha |
| SCC Online, Manupatra | subscription; no public API; their terms prohibit scraping | only through a firm's licensed access (credentials or exports the firm supplies); disabled by default |

Nothing is scraped from a subscription service. A connector without credentials reports `not_configured`.

## Invariants (in addition to the constitution)
- Court identity comes from the registry (`src/lib/india/courts.ts`). An unknown dataset court code is stored as
  `unresolvedCourt`, never mapped to the closest court.
- Binding vs persuasive is deterministic (`bindingEffect`): Supreme Court binds all courts (Art. 141); a High Court binds
  courts in its territory; other High Courts are persuasive; bench strength decides within a court.
- The original-language text is the text of record. Translations carry an origin (`court_published`, `provider`,
  `machine`) and machine translations are labelled as such in the UI and in citations.
- Citations: neutral citations (`2024 INSC 735`, `2024:KHC-D:7336`) and reporters (SCC, AIR, SCR, SCC OnLine, ILR (Kar),
  KarLJ, ALT, ALD, Crl LJ) are parsed in code; an unparseable citation stays `unknown`, not guessed.
- Confidential matter data never goes to an external translation or router service unless policy allows it.

## Workstreams and ownership
1. Sources and ingestion — `src/modules/india/sources/**`, `src/modules/intel/adapters/{sci-open-data,hc-open-data,indian-kanoon,india-code,licensed}.ts`, adapter registry entries.
2. Citations, statutes and procedure — `src/lib/india/{citations,statutes,procedure,limitation}*.ts`, citation export style replacing Bluebook.
3. Research engine — `src/modules/search/**`, `src/lib/ai/toolkit/**`, `src/lib/ai/prompts.ts`: Indian tools, jurisdiction-aware ranking, multilingual queries and answers.
4. Internationalisation and UI — `src/lib/i18n/**`, `src/components/**`, `src/app/layout.tsx`, fonts, locale switcher, branding.
5. Litigation workspace and demo — `src/modules/{ediscovery,matters,demo,workflows/templates,office/*/templates}/**`: Indian procedure vocabulary (CNR, case types, exhibits Ex.P/Ex.D, witnesses PW/DW, examination-in-chief/cross), Indian drafting templates, Bengaluru/Hyderabad demo matters.

## Judgment corpus (Postgres)
The corpus of judgments lives in Postgres tables (`corpus_units`, `corpus_judgments`, `corpus_rejects`, `corpus_state`;
`src/modules/india/corpus/**`), queried in place — not in the in-memory application mirror.

- Sources: the court-published open datasets on AWS (Supreme Court of India; all 25 High Courts). One unit per source
  archive (a Supreme Court year; a High Court bench-year), discovered from the buckets.
- Order: Supreme Court newest year first; then Karnataka, Telangana, Andhra Pradesh newest first; then the other High Courts.
- Completeness: each archive is checked against the dataset's own index. Every declared record is stored or recorded in
  `corpus_rejects` with the reason; a unit whose counts do not add up keeps an error.
- Mapping: the registry-backed parsers (`sources/sci.ts`, `sources/hc.ts`). All 25 High Court dataset codes were checked
  against the court names in the records. Unknown codes stay unresolved (`court_id` null, raw code kept).
- Durable and resumable: leases, per-archive cursors, idempotent upserts keyed on the dataset record and skipped when the
  record hash is unchanged. Enabled by `CORPUS_BACKFILL=1` (deployment) or an administrator (`POST /api/india/corpus {action:"enable"}`); runs from `POST /api/india/corpus/run` (same permission as the cron tick) and from the hourly tick.
- Storage budget: stops before `CORPUS_MAX_DB_MB` (default 450) and reports `storage_budget`; raise it after upgrading
  the database plan and the backfill continues where it stopped. About 2.7 KB per judgment including indexes.
- Retrieval: `GET /api/india/corpus/search` and the `search_judgment_index` research tool (exact CNR, neutral citation or
  case number first; weighted full-text over citations, title, coram and the published snippet).
- Duplicates: the Supreme Court dataset lists 5,181 judgments under two adjacent years with identical metadata (verified field by field); they are stored once, and a row's `year` is its decision year. Records present in an archive but not declared in its index are stored and noted on the unit (`note`).
- Not yet: full judgment text (PDF extraction) in the corpus. Acts and regulations: see "Law corpus (Postgres)" below.

## Law corpus (Postgres)
Indian statutes and regulations live in Postgres tables created and filled by the loader
(`scripts/law-corpus/schema.sql`, `scripts/law-corpus/load_open_india_law.py`) and queried in place by
`src/modules/india/law/**` (contracts and pure helpers: `src/modules/law/shared.ts`). The application never creates
these tables.

- Tables: `law_datasets` (one row per source file: version, sha256, row counts, load status), `law_instruments` (one row
  per Act or regulation: kind, title, jurisdiction `central | state | regulator`, State and `state_code`, regulator,
  publisher, year, status, amendment count, `source_url` = the publisher's own page, `mirror_url` = the dataset's PDF
  mirror, section/provision counts, dataset file and version, weighted `search` tsvector) and `law_provisions` (one row
  per dataset chunk: act id, statutory `ord`, `section_number` as printed, `variant`, `part`, heading, chapter, flags,
  defined terms, Acts referenced, text, `search` tsvector over heading (A) and text (B)).
- Source and licence: Open India Law (Vaquill), snapshot v2026.08.1, CC BY 4.0 — a third-party section-level parse of
  India Code (Central, State and UT legislation, including repealed Central Acts) and regulator publications (SEBI,
  RBI, MCA, CBIC, IRDAI, TRAI, DGFT, CPCB, …). Every page, API response and tool result carries the attribution
  ("Open India Law (Vaquill), CC BY 4.0 — third-party parse; verify against the official text"), the dataset version,
  the instrument status and the publisher link labelled with the publisher (e.g. "India Code (Legislative Department)",
  "SEBI"). The dataset mirror is labelled as a mirror, never as the official source. The parse is never presented as
  the official text.
- Sections: a section is every provision row with the same `(act_id, section_number, variant)`, concatenated in `ord`
  order. `variant > 0` is a second provision printed with the same number in the dataset; variants are kept separate
  and the reader says when another exists. Rows without a number (preamble, schedules) use the section key `_`.
- Exactness: section lookups match the printed number exactly (case-insensitive, on the loader's
  `(act_id, lower(section_number))` index). An unknown section is "not found" (404 / tool error), never the nearest
  section; an unknown instrument id likewise.
- Bounded queries: provisions are only read with a tsquery or an act id. Full-text search uses
  `websearch_to_tsquery('english')` ranked with `ts_rank_cd`, takes the top 400 matching chunks, groups them to one hit
  per section (best chunk), pages within the first 200 sections, and runs under a statement timeout (8 s, set per
  transaction) — a timeout is reported as "too broad" (504), not as "no results". Instrument listing is offset-paged with
  a probe row; the table of contents is a `GROUP BY (section_number, variant)` with `min(ord)`, paged 300 at a time.
- Not configured / not loaded: no `DATABASE_URL` → 503 `law_corpus_not_configured`; tables absent (`to_regclass` null,
  e.g. before the loader has run) → 503 `law_corpus_not_loaded`. The UI shows these states; nothing is substituted.
- Facets (`GET /api/law/facets`): counts per jurisdiction, State, regulator and status, year span, and the
  `law_datasets` rows (load progress), cached ten minutes per instance with a stale fallback.
- Routes: `GET /api/law` (instruments), `/api/law/search` (sections), `/api/law/<actId>` (instrument + TOC page;
  `?section=&variant=` for one section). Pages: `/law` (directory, Acts / Sections toggle, URL-state filters) and
  `/law/<actId>?s=<section>&v=<variant>` (TOC + reading pane with copy-citation, e.g. "Section 303, Bharatiya Nyaya
  Sanhita, 2023"). All routes: `withDb(withAuth(..., { action: "read", resource: refs.intel() }))`.
- Agents and research: `search_law`, `read_law_section`, `list_law_instruments` (`src/lib/ai/toolkit/india.ts`,
  `LAW_CORPUS_TOOLS`, offered only with a database) return `search_result` rows with sources
  `law://<actId>/s/<section>[~<variant>]`. The research statutes lane adds corpus sections (`law:<actId>:<section>:<variant>`,
  provider `open-india-law`, read reference kind `law`) after the curated India Code store, skipping a section the store
  already returned (same Act title and number).
