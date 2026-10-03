# Voyage public-corpus embeddings and practice references

## Model decision (research checked 2026-10-03)

Use voyage-context-4, released 2026-06-29, at 1024 float dimensions. Voyage reports its strongest retrieval performance, including leading law results; these are vendor benchmarks, not an evaluation on this corpus. Listed price: USD 0.12 per million input tokens.

Primary references:
- https://blog.voyageai.com/2026/06/29/voyage-context-4/
- https://docs.voyageai.com/docs/contextualized-chunk-embeddings
- https://docs.voyageai.com/docs/pricing
- https://github.com/pgvector/pgvector

## Configuration and boundaries

Set VOYAGE_API_KEY on the production server. VOYAGE_EMBEDDING_MODEL is optional and defaults to voyage-context-4. No credential is included in source control. Operator credential persistence was blocked; production activation needs the environment setting and redeployment.

Only the public legal-corpus embedding facade changes. Private matter-document embeddings, chat/research generation, authentication and Skylar remain unchanged.

## Representation and migration

The contextual endpoint is used in its single-embedding mode: each existing independently addressable passage is a singleton inner list. This does NOT claim whole-judgment contextualization. Existing text, page markers, document IDs and content hashes remain stable. Requests are bounded by UTF-8 bytes, reject rather than silently truncate oversized inputs, validate response ordering/model/dimensions/finite values, and respect timeouts.

Document and query embeddings use the same model with their respective document/query input types. Retrieval filters by model; equal vector dimensions do not make old OpenAI vectors compatible. Official-document work requeues old-model vectors and rewrites them incrementally without deleting source text. Keyword search remains available. ANN iterative scans reduce under-returning when filtering the mixed-model index; deployment database pgvector version observed: 0.8.6.

The existing quality cron retains its 1000-passage embedding budget per run. An old OpenAI quota pause does not block a newly configured Voyage model. Rate limiting is distinguished from depleted credit; queued work preserves its attempts.

## Live operator verification

Two bounded live runs stored 128 and 1000 judgment vectors with zero failures. The second completed in 78.03 seconds, not a sustained throughput benchmark. Independent SQL confirmed 1128 vectors across 92 text keys, 1024 dimensions, corresponding halfvec values, and zero source-hash mismatches. Some keys can have only partial embedding coverage. A direct same-model query-vector search returned five stored passages with neutral citations and page locators. Full application-level semantic quality and relevance thresholds still need corpus-specific evaluation.

## Supreme Court practice source

Source sci-library discovers the handbook PDF actually linked by https://www.sci.gov.in/judges-library/ . The downloaded handbook has 278 pages and identifies a 2017 edition updated as of 06.10.2025. Classified as reference_report / practice_handbook, not a judgment. Edition-as-of is not a commencement or publication date. Website policy: https://www.sci.gov.in/website-policies/ .

The first live pass fetched and parsed the file; pages 1,54,58,104,108,182,211,278 await OCR. The existing completeness gate leaves the document ocr_needed and not fully indexed. Voyage embeddings do not replace the separate OCR model. The reference-kind search allowlist and generic UI label now support non-Law-Commission references correctly.

The linked equivalent-citation PDF was a one-page navigation sheet, not a bulk citation crosswalk. No such crosswalk was fabricated or imported. Gazette and parliamentary-question exclusions remain in place.
