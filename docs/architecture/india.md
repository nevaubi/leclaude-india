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
