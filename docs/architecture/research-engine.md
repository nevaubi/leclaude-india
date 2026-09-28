# Research engine (LeClaude India)

`src/modules/search/engine/**` runs one research turn: forum + language → plan → parallel lanes → synthesis over
citation-native evidence → claim verification (model + code) → correction and re-verification bound to the new answer
hash → citation cross-check → coverage decision (another round or stop) → persist with an explicit terminal state.
The SSE route is `POST /api/search/run`; the UI is `src/modules/search/components/**`.

## Flow

```text
question + scope (sources, forum, matter, fast/deep, answerLanguage?, offenceDate?)
  → effectiveJurisdiction()           forum: explicit forum, or "Matter's court" resolved from the matter's court text (registry
                                      names, seats, bench cities); nothing matches → All India. Never the model.
  → questionLanguage()/resolveAnswerLanguage()   script → language (detectScript); answer language: request → i18n preference hook → question language
  → deps.translateQuery() [router]    only for a non-Latin question; bounded (translateWaitMs); matter-bound runs pass privacy "internal"
                                      (the router refuses an external endpoint in code); fallback: internal fast role; none → own words only
  → offenceDateFromText()             date of offence from settings or the question → applicableCode() (shared transition rule)
  → planLanes()                       binding (sci + forum HC), persuasive (other HCs), adverse (all courts), statute (India Code),
                                      record (matter only), secondary (library/web) | fast
  → planSubQuestions()                forum-aware; always includes the adverse question in deep mode
  → deps.planQueries()  [fast role]   concurrently with the first retrieval wave; refines sub-questions + queries
  → scheduleLanes()                   bounded concurrency (6), per-lane timeouts, soft deps (adverse waits, bounded, for the binding lane)
      each lane: wave 1 (provider × query, parallel; judgment lanes narrowed by their deterministic courtFilter)
                 wave 2: plan queries + queries targeting the binding lane's judgments (adverse lane)
                 read: fast/no-key → deterministic triage (binding, larger bench, term overlap) + parallel reads; deep → lane agent
      source.read of a judgment → deps.citing() corpus treatment check starts immediately (≤4, deep mode)
  → treatment results (bounded wait) + currentness flags (old criminal codes flagged as replaced) + stable evidence ids
  → numberSources()                   read first, binding first, Supreme Court first, larger bench first
  → no sources? broaden and retry while rounds remain; then the deterministic "The sources reviewed do not establish this." memo
  → buildEvidenceBlocks()             one search_result block per source; judgment titles carry court, bench, date, citations,
                                      BINDING/PERSUASIVE for the forum, treatment ("treatment not checked" unless checked), language
  → deps.synthesize()  [primary role] byte-stable instructions (Indian precedent rules, citation style, quote-language rule);
                                      forum, binding courts, offence rule, search terms, answer language and question in the user turn
  → deps.verify()      [fast role]    claim verdicts over the same focused passages (multilingual rule in the verifier prompt)
  → checkClaimEvidence()  [code]      read-before-characterize; literal quote check on the ORIGINAL text; a quote in another
                                      script than its source is flagged "not in the language of source [n]"
  → correction [fast role] + re-verification against the new hash
  → crossCheckCitations()             Indian neutral/reporter citations parsed by @/lib/india/citations; "remote" = the judgment corpus
  → decideCoverage() → next round or stop; decideOutcome() → terminal + stop state
```

## Forum and precedent (deterministic; Appendix B)

- `src/modules/search/jurisdictions.ts`: forums are `matter-forum` (default), `all-india`, `sci`, the focus High Courts,
  subordinate courts in Karnataka / Telangana / Andhra Pradesh (`ka-subordinate`…), and the other High Courts.
- `classifyAuthority(courtId, forum, _, date)` wraps `bindingEffect` (src/lib/india/courts.ts): Supreme Court binds all
  courts (Art. 141); a High Court binds courts in its State; other High Courts persuade; an unregistered court is `n/a`.
  Judgments of the erstwhile common High Court at Hyderabad (Telangana/AP-indexed, before 2019-01-01) are persuasive in
  both States (design record). A court override narrows retrieval only; it never changes the label.
- Bench strength never flips binding/persuasive here; it orders sources (larger benches first) and is stated in the
  evidence title so the answer can apply the larger-bench / coordinate-bench rules the prompt describes.

## Multilingual

- `engine/india-context.ts`: `questionLanguage`, `resolveAnswerLanguage`, `answerLanguageLine`, `offenceDateFromText`,
  and `setPreferredAnswerLanguageHook` (the lead wires `preferredAnswerLanguage()` from `src/lib/i18n/preferences.ts`).
- The corpus is searched with the English terms AND the question's own words (regional-language judgments).
- Quotations are verbatim in the judgment's language, followed by an unquoted rendering labelled "(translation)"; the code
  quote check runs on the original text; `ResearchMessage` records `queryLanguage`, `answerLanguage`, `searchQuery`.

## Tools

Toolkit (`src/lib/ai/toolkit/india.ts`, default in `researchToolset()`; US tools only with `us: true`):
`search_judgments` (court, bench, year range, judge, case type, statute, language, minimum bench), `read_judgment`
(paragraph windows; `judgment://<courtId>/<id>/para/<n>` sources, printed para numbers, PDF pages from the chunk map),
`citing_references` (corpus judgments whose parsed citations include the target; negative-treatment language flagged),
`search_statutes` / `read_section` (India Code; exact section numbers, absent → error), `map_criminal_section`
(`@/lib/india/criminal-code-map`; split/unmapped/requires_review passed through), and `indian_kanoon_search` /
`indian_kanoon_doc` only when `indiaConnectorStatuses()` reports the Indian Kanoon connector `ready` (fail closed).
All are built on the source layer (`@/modules/india/sources`): `searchIndianAuthorities`, `getJudgment`, `judgmentText`,
`listEnactments`, `getSections`, `getSection`, `createIndianKanoon`, `courtForDocsource`.

Lane tools (`engine/lanes.ts`): provider searches through `deps.retrieve` (`search_judgments`, `search_statutes`,
`search_library`), `read_source`, `read_judgment`/`get_opinion` (engine reader numbering), `read_section`,
`citing_references`, `resolve_citation` (corpus; resolved / ambiguous / unresolved — never picks), `build_citation`
(`formatCaseCitation` from `@/lib/india/citation-style`; statutes through the statute registry), `compare_authorities`,
`map_criminal_section`, `search_matter_documents` / `read_matter_document` (selected matter only), `fetch_url` (official
Indian legal hosts unless Web is in scope; subscription services never), `get_matter_context`, `verify_citations`.

## Evidence contract (§23, §25, §44)

- Stable sources: `judgment://<courtId|unresolved>/<judgmentId>`, `statute://<enactmentId>/s/<n>`,
  `authority://indiankanoon/doc/<tid>`, `matter://…`, `library://…`, `intel://…`, or the canonical URL.
- Read before characterize, code-checked quotes, citation exists ≠ supports, deterministic no-answer memo, treatment as a
  review signal only ("treatment not checked" unless the corpus was checked) — unchanged from the platform engine.

## Output

`buildResearchMemo()` (`src/modules/search/memo.ts`): Indian dates, forum line, answer language, and the table of
authorities from `@/lib/india/citation-style` (`buildTableOfAuthorities`: Supreme Court, High Courts by court, court not
identified, Constitution and statutes) followed by the pinpoints the answer used. Citations are formatted by
`src/modules/search/india-citations.ts` (the adapter over the citation engine); an authority the engine cannot format is
shown as recorded and marked "[citation not verified: …]".

## Speed (fake-latency harness)

Retrieve 150 ms, read 150 ms, lane agent 300 ms, plan 260 ms, synthesis 300 ms, translation 200 ms; 5 deep lanes
(binding, persuasive, adverse, statute, secondary). See the handoff of the India research workstream for the measured
first-token and verified-answer times; `tests/search-research-agent.test.ts` asserts lane overlap and that planning
stays off the critical path.

## Tests and evals

`tests/search-engine.test.ts`, `tests/search.test.ts`, `tests/search-research-agent.test.ts`,
`tests/india-research.test.ts` (tools over the real store, capability gating, multilingual, forum from matter, offence
date), `tests/search-model-policy.test.ts`, and `evals/india-research/**` (run by `tests/india-research-evals.test.ts`):
adverse controlling SC authority, Karnataka vs Telangana forum, IPC/BNS date boundary, Kannada query, no answer in corpus.
Fixtures are fictional judgments (`evals/india-research/fixtures.ts`).
