# Quality-first corpus: October 3, 2026

## Operator policy and completed removal
The operator explicitly retired parliamentary questions and the standalone Gazette collection. The cleanup ledger records 202,105 document records, 537,922 chunks (388,474 with embeddings), 319,178 work units and 138,823 rejects removed. Subsequent live queries found zero matching documents. The deletion manifest records identifiers and hashes, not retained document text. The manifest SHA-256 is 6452f62c3e1804309207eef95acbdbdbf1d7f120f033c257a879123a836f22a9.

Acts, regulations, judgment collections, 60 parliamentary debates and 60 committee reports were preserved. Gazette references attached to retained laws remain: deleting a collection must not remove evidence of promulgation or amendments from another legal record. Source policy is enforced at discovery and processing, not just hidden in navigation.

## Live quality maintenance
An independent, leased five-minute job gives text reconciliation, citation extraction and embedding their own bounded budgets, rather than allowing the bulk metadata import to consume all execution time. Queries have a 15-second statement and 3-second lock timeout. Paid embedding work is capped at 1,000 chunks per pass by the persisted policy, with a hard 2,000 limit. Provider-credit errors pause this lane for 30 minutes without consuming unrelated reconciliation or citation work.

Text availability is reconciled using court + CNR + decision date + source version, not party-name similarity. Numbered chunk sequences and expected counts are checked. The UI distinguishes parsed text, PDF text, OCR text, partial text and unconfirmed text; none means verified legal correctness. Late-arriving metadata is revisited on later cursor passes. A completed citation pass now admits newly available text; existing scans are not yet universally invalidated when upstream text changes.

India Code resolution validates Central Act type, jurisdiction, normalized title and year. It checks every returned page within a bounded window before treating a match as unique. A capped search is explicitly incomplete. Law Commission dataset metadata is classified as report, not regulation.

## Source register and crawl decisions
The following URLs were inspected on October 3, 2026. A discovered source is not equivalent to completed ingestion.

| Source | Material and handling | Implementation status / limitation |
|---|---|---|
| [India Code](https://www.indiacode.gov.in/) | Central/state instruments and section text. Preserve source identifiers, headings, section URLs, amendment footnotes and fetch timestamps. | Existing client, stronger exact matching implemented. Browser accessibility varies; no claim that all Acts are reconciled. |
| [SEBI updated regulations](https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&smid=0&ssid=3) | Public publisher list with 42 regulation links at inspection. Keep printed issue year separate from the publisher's last-amended edition label. | New dedicated stream; initial 12 publisher PDFs resolved and queued. A year-only cell never becomes an invented exact date. |
| [SEBI master circulars](https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&smid=0&ssid=6) | Public list showed 134 records, 25 on its first page. Resolve each detail page to its publisher PDF; use the site's form pagination and validate the returned range. | New stream; initial 12 PDFs resolved and queued. Parser handles optional closing table-cell tags observed on the actual page. Gazette entries are excluded. |
| [Supreme Court Judges Library](https://www.sci.gov.in/judges-library/) | Identifies SCR, SUPLIS, LEGIS and equivalent-citation resources. Strong leads for matching and legislative history. | Prospect for a future licensed/authorized citation crosswalk. The linked equivalent-citation PDF is not itself a verified bulk crosswalk; none was imported in this pass. |
| [Supreme Court rules](https://www.sci.gov.in/supreme-court-rules/) | Rules and amendments should be explicit, separately dated instrument versions. | Source research only in this pass. Do not resume a general Gazette crawl through amendment links. |
| [NCLAT migration notice](https://nclat.nic.in/flash-news/users-may-access-case-status-judgments-and-daily-orders-through-nclat-e-filing-portal) | Tribunal directs case-status, judgment and daily-order users to its NIC-hosted e-filing portal. | Existing collection is not complete; next adapter audit should target the current publisher endpoint, without bypassing CAPTCHA or access controls. |
| [High Court bulk dataset on AWS](https://registry.opendata.aws/indian-high-court-judgments/) | Dattam Labs mirror, CC BY 4.0; PDFs, JSON and Parquet for 25 High Courts, advertised quarterly updates. | Existing ingestion retained. This is a third-party mirror of court material, not a government-operated API. Preserve mirror provenance and original-court identifiers. |
| [Supreme Court bulk dataset on AWS](https://registry.opendata.aws/indian-supreme-court-judgments/) | Dattam Labs mirror, CC BY 4.0; registry describes 1950–2025 judgments and English/regional-language files. | Existing ingestion retained; listed date coverage is not live court completeness. |
| [Law Commission reports](https://lawcommissionofindia.nic.in/law-commission-reports/) | Official reports indexed by commission. Reference/recommendation material, not enacted provisions. | Existing licensed dataset retained with corrected type. Direct-site adapter remains subject to its reproduction-permission policy. |

SEBI discovery uses allowlisted direct HTML and PDF links before any crawler fallback. Existing pipelines keep extraction method, content hashes, source URLs, page locators and versions; unreadable pages take the OCR lane. OCR is a transcription method, not a legal-verification badge. Authentication walls, bot challenges, parser errors and provider-credit failures must be reported rather than mislabelled as an empty or complete collection.

## Navigation and visual identity
Official Sources starts with four groups: judgments/orders, regulatory materials, court practice, and research/legislative history. Each group links to filtered documents and the related case, statute or court directory. Publisher browsing is collapsible. The Quality & coverage tab reads saved small summaries so navigating does not execute corpus-wide counts or start ingestion.

Displayed metrics distinguish text passages, vectors, citation scans, extracted edges, indexed provisions and reconciled official sections. Missing counts remain unknown, not zero. Document rows expose content version, recorded hash and publisher-edition labels without claiming legal validity.

Court photographs and publisher logos use the existing validated media store with responsive WebP renditions, source attribution and license metadata. A separate bounded job processes at most two missing targets every ten minutes and cools down unsuccessful keys for a day. At the initial quality snapshot 15 court photographs and 6 entity logos were accepted; all-court completion is not claimed. No synthetic official seals are generated, and existing emblem restrictions are preserved.

## Open quality work
Provider credit currently blocks new judgment embeddings. Enabling a schedule is not evidence of semantic readiness; the stored-vector count is authoritative. All legal-effect, in-force and treatment claims still require evidence appropriate to the specific proposition. Future priorities are citation-target normalization, version-triggered re-scans, validating current tribunal endpoints, and broader full-text linkage coverage before adding low-value volume.
