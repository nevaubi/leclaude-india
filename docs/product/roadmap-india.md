# India roadmap

The ordered plan that turns the product owner's priorities memo into checkable work. The order is P0 → P5. The Evals
track runs alongside from P1 onward and gates the claim "best in class" (which also gates lifting the
[scope freeze](scope-freeze.md)).

Conventions:

- **Current state** says what the repository contains at the time of writing, with paths. "Not found" means a search of
  `src/`, `scripts/` and `evals/` found nothing. Corpus sizes and ingestion progress are deployment state, so the plan
  says *verify current state* and never quotes a number as fact.
- **Acceptance** items are the checks that close the item. An item is done only when every box can be ticked with
  evidence (test, query result or screenshot), not when code merely exists.
- Hard rules for every item: public sources only; never SCC Online, Manupatra or any site whose terms forbid automated
  access; never bypass a CAPTCHA; CC BY attribution visible wherever CC BY material is shown; nothing labelled
  "verified" without corpus-text evidence.

---

## P0 — Security and hygiene

### P0.1 Authentication on every route (`AUTH_MODE=jwt`)

Current state:

- `src/lib/auth/**` implements `AUTH_MODE=dev|header|jwt` (HS256 or RS256, `exp`/`nbf`, optional `iss`/`aud`). An unknown
  mode fails closed (`src/lib/auth/principal.ts`). `dev` is the default.
- Most API routes are wrapped in `withAuth`. A text search at the time of writing found 257 `route.ts` files. Of those,
  67 do not reference `withAuth`. Most are under `src/app/api/ediscovery/**`; the others are `ai/chat`, `ai/status`,
  `quick-search`, `health` and `office/pdf/worker`. Some may authorize by other means, so verify each one.
- The setup guide `docs/architecture/auth.md` is being written in a parallel workstream.

Acceptance:

- [ ] Every route handler under `src/app/api/**` resolves a principal and authorizes at the boundary, or is on a short,
  reviewed allowlist of public routes (`health` only, and it returns no data).
- [ ] A test enumerates all route files and fails if a handler is neither wrapped nor allowlisted.
- [ ] Production and preview set `AUTH_MODE=jwt` (or `header` behind a trusted proxy). With `AUTH_MODE=dev`, startup
  logs a warning on a serverless host, or refuses outright.
- [ ] Unauthenticated requests get 401 and cross-matter requests get 403, with tests for both.

### P0.2 `CRON_SECRET` on cron routes

Current state:

- `vercel.json` schedules `/api/intel/jobs/tick` (hourly) and `/api/official/run` (every 2 minutes).
- `Authorization: Bearer <CRON_SECRET>` resolves to a service principal (`src/lib/auth/principal.ts`).
- Without `CRON_SECRET`, `/api/official/run` accepts an unauthenticated "kick", rate-limited to one start per window
  (`src/app/api/official/run/handler.ts`).

Acceptance:

- [ ] `CRON_SECRET` is set in every deployed environment.
- [ ] With `CRON_SECRET` set, both cron routes reject requests without the bearer (test).
- [ ] Decide whether the no-secret "kick" path stays (it is useful for local development) or is removed when
  `VERCEL` is set.
- [ ] `/api/india/corpus/run` and `/api/india/citator/build` follow the same rule.

### P0.3 Remove real-firm references and unsuitable demo seeds

Current state: a parallel workstream is removing real-firm names and the US mass-tort demo seeds (under
`src/modules/ediscovery/**`, `src/modules/library/**` and related seeds).

Acceptance:

- [ ] A case-insensitive search of `src/`, `docs/`, `evals/`, `tests/` and `public/` for the removed names returns
  nothing.
- [ ] `LECLAUDE_SEED=reference` (the default) seeds no fictional US matters into an India deployment.
- [ ] Existing deployments: the seed version is bumped, or a one-off cleanup removes the old seeded rows (they carry
  `meta.seeded`).

### P0.4 Private repository

Current state: the GitHub remote is `leclaude-india`. Its visibility cannot be checked from the code.

Acceptance:

- [ ] The repository is private, and collaborator access has been reviewed.
- [ ] The git history has been checked for committed secrets (secret scanning). Any exposed credential is rotated.

### P0.5 Rename plan — **done in this change**

- [x] [rename-plan.md](rename-plan.md): reasons, inventory, migration checklist with env-var aliases, and name
  directions. The final name remains the product owner's decision.

### P0.6 India README — **done in this change**

- [x] [README.md](../../README.md) describes the India product as built, with honest corpus coverage, licences and the
  frozen scope.

### P0.7 Freeze US research, e-discovery, depositions and office — **done in this change**

- [x] [scope-freeze.md](scope-freeze.md) defines what is frozen, what frozen allows, and the affected paths.
- [ ] A PR template or review checklist asks about frozen paths.

---

## P1 — Corpus depth

### P1.1 High Court judgment full text from the AWS PDFs, with OCR fallback

Current state:

- High Court metadata for all 25 courts comes from `indian-high-court-judgments`
  (`src/modules/india/corpus/backfill.ts`, `src/modules/india/sources/hc.ts`). `corpus_judgments.pdf_url` is stored and
  shown in the reader.
- Full text comes only from the Open India Law parquet (`scripts/law-corpus/load_hc_judgment_text.py`), linked by CNR
  and decision date. Which courts are loaded is deployment state: verify current state.
- The application does not download HC PDFs to extract text. OCR exists only in the official-sources pipeline
  (`src/modules/official/ocr.ts`, scanned pages only, page-capped). It is not wired to the judgment corpus.

Acceptance:

- [ ] A durable worker (see P5.5) fetches each record's `pdf_url` from the public bucket, hashes the bytes and extracts
  the text layer.
- [ ] Pages that fail a readability gate are OCR'd. OCR text is flagged as OCR in storage, the reader and tool results.
- [ ] Text is linked to the record by identity (the same record's PDF), never by name. `text_status` distinguishes
  `full` (text layer), `ocr` and `none`.
- [ ] The priority order is Delhi, Bombay, Madras, Allahabad, Punjab & Haryana, Karnataka, Calcutta, Gujarat, Kerala.
  Each court is backfilled to 2010 first, then to the dataset's start year.
- [ ] A coverage query per court and year reports records, records with text and OCR share. It is shown on the coverage
  dashboard (P4.4).
- [ ] Where Open India Law text and PDF-extracted text both exist for a record, a documented rule decides which one is
  served. Both keep their source attribution.

### P1.2 Supreme Court Reports (digiscr.sci.gov.in) linked to Supreme Court records

Current state: not found. Supreme Court metadata comes from `indian-supreme-court-judgments` and English text from Open
India Law (`load_sc_judgment_text.py`, linked by exact neutral citation). The memo's "38k SC records" figure is not
verified: verify current state with `GET /api/india/corpus`.

Acceptance:

- [ ] Check the digiscr.sci.gov.in terms of use and robots policy and record the result before building anything. If
  automated access is not permitted, stop and record why.
- [ ] Each SCR citation (volume, part, page) is linked to an existing SC record by an exact identifier: neutral
  citation, case number with date, or diary number. An unmatched SCR entry is stored as unresolved.
- [ ] The SCR citation becomes a parsed reporter citation, so the citator resolves `(YYYY) N SCR P` strings.

### P1.3 India Code at section level with amendment history; IPC↔BNS, CrPC↔BNSS, IEA↔BSA concordance as data

Current state:

- Statutes come from the Open India Law snapshot (section-level parse of India Code, CC BY 4.0), loaded by
  `scripts/law-corpus/load_open_india_law.py`.
- Amendment information is limited to `amendment_count` per instrument and per provision. The dataset has no
  section-level repeal or version history, and the loader never infers it.
- The concordance is a hand-coded table in `src/lib/india/criminal-code-map.ts` covering commonly litigated provisions.
  Its source is noted as the MHA/BPRD correspondence tables, and some rows are marked `confidence: "medium"`. It is not
  a complete, data-loaded concordance.

Acceptance:

- [ ] Section text is versioned: each version has effective-from and effective-to dates and the amending Act or
  notification (Gazette reference). Point-in-time reads work: "s.438 CrPC as on 2023-05-01".
- [ ] The concordance is loaded as data from the official comparison tables, with source document, page and row
  reference for each mapping. It covers all sections of all three pairs. Splits and merges are explicit.
- [ ] The coded table becomes a test fixture. Every row must agree with the loaded data, and a mismatch fails CI.
- [ ] Unmapped sections stay "unmapped", never approximated.

### P1.4 Tribunals and regulators

Current state (`src/modules/official/adapters/**`, verify run status on `/sources` or `GET /api/official`):

| Item | State in code |
|---|---|
| SAT | `sat-orders` disabled because the portal is CAPTCHA-gated. SAT orders arrive through the SEBI "Orders of SAT" mirror (`sebi-orders`). |
| NGT | `ngt-orders` disabled: all listings are CAPTCHA-gated (checked 2026-10-02). |
| MCA | `mca-master` disabled unless the data.gov.in key and resource id are configured. The resource id is unverified. |
| CCI | enabled. The memo reports 404s. The combination listing is marked "endpoint unverified" in code. |
| CBIC | enabled. The memo reports non-JSON answers. The adapter records "answer was not a list" notes. |
| IBBI | enabled. The memo reports documents without text. |
| ITAT, CESTAT, APTEL, NCDRC / e-Jagriti, CIC, RERA appellate tribunals | not found |

Acceptance:

- [ ] SAT, NGT and MCA: each has either a working adapter over an open, permitted listing, or a recorded decision
  (with date and evidence) that no permitted route exists. CAPTCHAs stay unbypassed.
- [ ] CCI 404s, CBIC non-JSON answers and IBBI missing text are each reproduced with a test fixture, fixed, and shown
  clean in the source's run status over 7 days.
- [ ] New adapters for ITAT, CESTAT, APTEL, NCDRC (e-Jagriti), CIC and the RERA appellate tribunals of the priority
  States. Each records its terms check, host allowlist and attribution.

### P1.5 RBI master directions and circulars; CBDT expansion

Current state: `cbdt` is enabled (circulars and notifications as listed on incometaxindia.gov.in). RBI regulations are
present only as far as the Open India Law regulator files include them. No RBI adapter was found.

Acceptance:

- [ ] An RBI adapter covers master directions and master circulars (and notifications), with currentness: a superseded
  master direction is marked as superseded.
- [ ] CBDT coverage is extended (instructions, press releases, and the backfill depth the product owner sets), and
  its coverage is reported per year.

### P1.6 Law Commission reports and Constituent Assembly debates

Current state: Law Commission reports appear in the law corpus as `kind = report` (classified by
`scripts/law-corpus/normalize_law_corpus.sql`, labelled as context, not law). Constituent Assembly debates: not found.

Acceptance:

- [ ] Law Commission reports have report number, date and subject, and are searchable as a separate "context" source,
  never as law.
- [ ] Constituent Assembly debates are loaded from an official or openly licensed source with date, speaker and
  volume/page pinpoints.

---

## P2 — Cross-analysis

### P2.1 Citation graph

Current state: the citator (`src/modules/india/citator/**`) extracts citations from judgments with full text. It
resolves a case citation to a corpus record only by exact normalised neutral or reporter citation (one match:
resolved; several: ambiguous; none: unresolved). It provides cited-by lists (`read.ts`) and section heat
(`src/modules/law/most-cited.ts`).

Acceptance:

- [ ] The parser covers neutral citations (`2024 INSC 735`, HC neutral formats), SCR, SCC, AIR, SCC OnLine and
  Crl LJ strings. A labelled sample of ≥ 500 citation strings measures parse precision and recall.
- [ ] Resolution rate is reported per court and reporter. Unresolved and ambiguous citations stay visible.
- [ ] Cited-by counts are shown with "among judgments scanned so far" wording until the pass is complete.

### P2.2 Paragraph-level treatment classifier

Current state: `src/modules/india/citator/signals.ts` has deterministic sentence-level cues (overruled, per incuriam,
doubted, referred to a larger bench, distinguished, followed). They are labelled as cues, not verified treatment.
`src/modules/search/engine/treatment.ts` reports "no negative signal found", never "good law". There is no
paragraph-level classifier.

Acceptance:

- [ ] A classifier labels the citing paragraph (followed / applied / distinguished / doubted / overruled /
  referred / merely cited) with the paragraph number.
- [ ] Evaluated on a labelled set: precision for negative treatment ≥ the threshold the product owner sets.
- [ ] The output stays a "signal" until a person reviews it. Overruled and per-incuriam signals always show the citing
  paragraph.

### P2.3 Binding-force engine

Current state: `bindingEffect` in `src/lib/india/courts.ts` covers the Supreme Court (binds all courts), a High Court
(binds its territory) and other High Courts (persuasive). `corpus_judgments.bench_strength` is stored.

Acceptance:

- [ ] The rules cover court hierarchy, bench strength (a larger bench binds a smaller one; a coordinate bench binds a
  coordinate bench unless referred), territory (including common High Courts and bench seats) and date (later
  overruling).
- [ ] Each result has an explanation trail ("binding: SC, 3-judge bench, Art. 141").
- [ ] Wrong-binding-force errors are counted on the eval set (see Evals).

### P2.4 Statute ↔ judgment links at section level

Current state: the citator counts statute citations, and the statutes landing shows "most-cited sections" from the
citator's section heat. Links from a section to the judgments citing it exist only as these counts and lists.

Acceptance:

- [ ] Each statutory reference in a judgment resolves to (Act, section, version on the decision date). Unresolvable
  references stay unresolved.
- [ ] The section reader lists the judgments that cite it, with pinpoint paragraphs, filterable by court and binding
  force.

### P2.5 Transition-law awareness

Current state: `applicableCode` in `src/lib/india/criminal-code-map.ts` picks the substantive code by offence date and
the procedure by proceeding date. It notes BNSS s.531(2)(a) for proceedings pending before 1 July 2024. The coded table
maps CrPC s.319 to BNSS s.358. Whether BNS s.358 (the repeal and savings clause) is modelled was not verified.

Acceptance:

- [ ] Offence date decides IPC or BNS. Filing date and the s.531 BNSS savings decide CrPC or BNSS. The BNS s.358 savings
  is modelled explicitly.
- [ ] Research answers and drafting templates state which code applies and why, from these dates. A missing date is
  asked for, never assumed.
- [ ] The existing evals (`evals/india/cases/ipc-bns-date-boundary.json`,
  `evals/india-research/cases/ipc-bns-boundary.json`) are extended with s.531 and s.358 cases.

### P2.6 Split-of-authority map

Current state: not found. The research planner asks whether other High Courts take a different view
(`src/modules/search/engine/planner.ts`), but no structured map exists.

Acceptance:

- [ ] For an issue, list the High Courts on each side with the leading judgment and binding-force notes. Show whether
  the Supreme Court has settled it.
- [ ] Every position cites a corpus paragraph. A position without one is not shown.

---

## P3 — Search and AI

### P3.1 Hybrid retrieval over judgment full text, with an issue-level reranker

Current state: judgment text search is Postgres full text only (`src/modules/india/corpus/text.ts`, bounded tsquery).
Hybrid BM25 + pgvector with reciprocal rank fusion exists for official sources only (`src/modules/official/search.ts`).
No reranker was found.

Acceptance:

- [ ] Judgment text chunks have embeddings (see P5.2 and P5.3 for storage). Retrieval fuses lexical and vector results.
- [ ] An issue-level reranker is used only if it improves recall@10 on the eval set (measured before and after).
- [ ] p95 latency for the research case-law lane stays within the budget the product owner sets.

### P3.2 Filters

Current state: corpus search supports courts, year range, judge, disposal and ordering (`CorpusQuery` in
`src/modules/india/corpus/search.ts`). Bench strength is stored but not a search filter. Section is not a filter.

Acceptance:

- [ ] Filters for court, bench strength, decision date range, statute section (via P2.4), disposal and judge, in the
  UI and in the research tools. URL state is kept.

### P3.3 Benchmark query

The query "anticipatory bail under s.482 BNSS for an offence committed before 1 July 2024" must surface *Chowgule & Co
v State of Goa* (Bom HC 2024) and *Tatheer Jafri v State of UP* (2025:AHC-LKO:18131).

Current state: not found in `evals/` or `tests/`. Whether these judgments are in the corpus depends on which High Court
text is loaded: verify current state.

Acceptance:

- [ ] Both judgments are in the corpus with full text, and their identities are verified against the official copies.
- [ ] The query is an eval case. Both judgments appear in the top 10 of the case-law lane and are cited in the
  research answer with paragraph pinpoints.

### P3.4 Research memo agent

Current state: the research engine (`src/modules/search/engine/**`) checks quotes, citations and paragraph pinpoints
in code (`quotes.ts`, `citecheck.ts`, `paragraphs.ts`). It builds authority comparisons (`authorities.ts`) and binds
verification to the answer hash (`binding.ts`). The contrary-authority sub-question is planned in deep mode only
(`planner.ts`). The memo export is `src/modules/search/memo.ts`.

Acceptance:

- [ ] The memo has paragraph pinpoints for every proposition and corpus-verified citations (each citation resolved to
  a corpus record).
- [ ] It includes an authority status table: binding force, treatment signal, currentness.
- [ ] The contrary-authority search is mandatory in every memo, including fast mode. The memo states when none was
  found.
- [ ] A proposition without corpus evidence is marked unsupported, never "verified".

### P3.5 Drafting in Indian formats

Current state: Word templates in `src/modules/office/word/templates-india.ts` cover regular and anticipatory bail
(BNSS ss.483 and 482), Art. 226 writs (Karnataka, Telangana), plaint, written statement, Order XXXIX I.A., s.138 NI
Act, s.80 CPC notice, vakalatnama, affidavit and memo of appearance. Documents drafting
(`src/modules/documents/drafting.ts`) covers lists of dates, the paperbook, para-wise replies and defect notices. No
quashing petition (s.528 BNSS / s.482 CrPC) or SLP template was found.

Acceptance:

- [ ] Templates for quashing petitions, SLPs (Supreme Court format, with synopsis and list of dates) and writs for the
  P1 priority High Courts.
- [ ] The drafting agent fills facts from the matter and authorities only from corpus-verified research. Court-specific
  details stay `[VERIFY]`.

### P3.6 Cause-list and order alerts

Current state: the matter desk matches parsed cause lists (SC, Delhi HC, NCLT, NCLAT) to tracked identifiers and turns
orders into action items (`src/modules/matters/desk/**`). No push or e-mail alert channel was found.

Acceptance:

- [ ] A user is notified (in-app, plus e-mail or push as configured) when a tracked matter appears in a newly published
  list or gets a new order. The notification links the official document.
- [ ] Alerts are deduplicated per document version, and an alert is never sent for an unparsed entry.

### P3.7 Translation of Hindi and regional judgments

Current state: the corpus stores court-published translations listed by the dataset
(`corpus_judgments.translations`, shown in `src/modules/caselaw/components/case-record.tsx`). The SC text loader loads
English rows only. Documents drafting has labelled working translations.

Acceptance:

- [ ] An official translation is used when one exists and labelled `court_published`.
- [ ] A machine translation is labelled `machine` everywhere, including in citations. The original-language text
  remains the text of record.
- [ ] Confidential matter text is never sent to an external translation service unless policy allows it.

---

## P4 — UI

### P4.1 Judgment reader

Current state: the case record shows the judgment text panel and the PDF link (`src/modules/caselaw/components/**`).
Research evidence uses reader paragraph numbering (`src/modules/search/engine/paragraphs.ts`).

Acceptance:

- [ ] The reader shows paragraph numbers that match the judgment's own numbering where it has one, and research
  pinpoints otherwise. It states which numbering is used.
- [ ] Copy-cite in neutral (INSC or HC neutral) and reporter formats.
- [ ] Opening from a research answer scrolls to and highlights the supporting paragraph.

### P4.2 Source, licence and `text_status` on every result

Current state: attribution and `text_status` are carried in API and tool results (`src/modules/india/corpus/**`,
`src/modules/law/shared.ts`, official adapters).

Acceptance:

- [ ] Every result row in Case law, Statutes, Sources and Research shows the source, the licence or terms, and (for
  judgments) `text_status`. A UI test covers each surface.

### P4.3 Side-by-side IPC | BNS view

Current state: the statutes reader shows the correspondence for the section being read
(`src/modules/law/code-correspondence.ts`), and Tools has an IPC→BNS converter. No side-by-side text view was found.

Acceptance:

- [ ] Old and new section texts are shown side by side, with differences highlighted. Splits show every candidate.
  The concordance source (P1.3) is cited.

### P4.4 Public coverage dashboard

Current state: `src/modules/india/corpus/coverage.ts` computes coverage per court for prompts (cached, read-only).
Ingestion status is visible to administrators. No public page was found.

Acceptance:

- [ ] A page shows, per court and year, records, records with text and OCR share. It also shows statutes and official
  sources by publisher, with "as of" timestamps. It contains no confidential data.

### P4.5 Saved searches with alerts

Current state: saved searches exist only in the frozen e-discovery module. No India research saved search was found.

Acceptance:

- [ ] Users can save a case-law, statutes or sources search and are alerted on new matching documents. Alerts use the
  P3.6 channel.

---

## P5 — Infrastructure and cost

### P5.1 Raw text and PDFs in object storage

Current state: judgment text chunks (`corpus_texts`), statutes and official-document text live in Postgres.
`docs/architecture/storage.md` already sets the target of blobs in S3.

Acceptance:

- [ ] Raw text and PDFs go to object storage (S3 or R2), addressed by content hash. Postgres keeps only search chunks,
  embeddings and metadata.
- [ ] The database size per million judgments is measured before and after the move.

### P5.2 pgvector `halfvec` and quantization

Current state: official-source embeddings are `halfvec(1024)` with an HNSW cosine index, or `vector(1024)` when
`halfvec` is unavailable (`src/modules/official/embed.ts`). Judgment text has no embeddings.

Acceptance:

- [ ] Judgment embeddings use `halfvec` or a quantized form. Recall@10 on the eval set is not worse than float32.

### P5.3 Tiered embedding

Acceptance:

- [ ] Embed priority courts and recent years first. Older or low-traffic material is embedded on demand or with a
  cheaper model, with the policy written down and measured.

### P5.4 Partition judgment tables by court and year

Current state: no partitioned tables were found.

Acceptance:

- [ ] `corpus_judgments` and `corpus_texts` (or their successors) are partitioned by court and year. Search queries
  prune partitions (checked with `EXPLAIN`).

### P5.5 Bulk ingestion on a worker; cron only for light polling

Current state:

- Bulk work runs from Vercel cron ticks. `/api/official/run` runs every 2 minutes. The corpus backfill and citator run
  from the hourly intel tick or their own routes.
- Storage budgets are code defaults that each deployment overrides: `OFFICIAL_MAX_DB_MB` (default 60,000 MB,
  `src/modules/official/units.ts`) and `CORPUS_MAX_DB_MB` (default 450 MB). The memo's "halted at ~31 GB" is out of
  date, and the actual database size and budget must be read from the deployment: verify current state.

Acceptance:

- [ ] Bulk ingestion (P1.1 PDFs, OCR, embeddings, backfills) runs on a worker such as ECS, Fly or AWS Batch, with
  durable queues, leases and dead-letter.
- [ ] Vercel cron only polls light sources every 15–60 minutes.
- [ ] A restart of the worker loses no work (test).

### P5.6 HyperFormula (GPLv3)

Current state: `hyperformula` is a dependency (`package.json`), used by the frozen spreadsheet editor
(`src/modules/office/sheet/engine.ts`).

Acceptance:

- [ ] Before any commercial distribution, either remove the spreadsheet editor from the shipped build, replace
  HyperFormula, or obtain a commercial licence. A licence audit of all dependencies is recorded.

---

## Evals (runs alongside P1 to P5)

Current state:

- `evals/india-research/` has 5 deterministic cases: adverse controlling SC authority, Karnataka vs Telangana forum,
  IPC/BNS boundary, Kannada query, no answer in corpus. They use fictional fixtures and run through
  `tests/india-research-evals.test.ts`.
- `evals/india/` has 4 deterministic engine cases (wrong neutral citation, IPC/BNS date boundary, SC vs HC binding,
  same party names across States).
- No eval runs against the real corpus. No recall@10 or citation-accuracy metric is computed on every PR.

Acceptance:

- [ ] `evals/india-research` holds at least 100 questions, each with known authorities (identified by neutral citation
  or CNR plus date) and the paragraphs that support the answer. Questions are spread over courts, subjects and the
  IPC/BNS transition. A held-out split is kept.
- [ ] Every PR reports recall@10, citation accuracy (cited authority exists, resolves, and the pinpoint paragraph
  supports the proposition) and wrong-binding-force errors. A regression beyond the agreed tolerance fails the check.
- [ ] A scored comparison against SCC Online and Manupatra on the same questions, run manually by licensed users
  inside those services under their terms. Results are entered by hand. Those services are never scraped or called
  by the product.
- [ ] No answer, memo or badge says "verified" unless the claim is tied to corpus text that was read in the run.

---

## Open questions for the product owner

1. The target thresholds for recall@10, citation accuracy and binding-force errors that define "best in class" and
   lift the freeze.
2. Historical depth: is "2010 then dataset start" the same for every priority court, or does the order interleave
   courts?
3. Whether OCR may use an external model provider for public judgments (they are public, but provider policy and cost
   apply).
4. The alert channels (e-mail or push) and who operates the sender.
5. The worker platform for P5.5 (ECS, Fly or Batch), and whether object storage is S3 or R2.
6. Whether a public coverage dashboard (P4.4) may be shown without login.
