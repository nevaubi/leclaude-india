# Scope freeze

Status: **decision recorded.** It applies to all work in this repository from the date this document is merged.

## Decision

Until Indian legal research is best in class, the following product areas are **frozen**:

1. US legal research
2. E-discovery
3. Deposition intelligence
4. The office suite (Excel, PowerPoint, PDF), and Word except where India drafting uses it

"Best in class" is measured, not declared. The freeze is reviewed when the roadmap's evaluation gates are met
([roadmap-india.md](roadmap-india.md), section "Evals": recall@10, citation accuracy and binding-force errors on the
India research eval set, plus the manual comparison against subscription databases). The product owner lifts or
narrows the freeze in writing by updating this document.

## What "frozen" means

**Allowed**

- Security fixes: authentication and authorization at route boundaries, matter-scope leaks, SSRF and egress, secrets,
  dependency CVEs.
- Dependency and licensing fixes, including removing or replacing a dependency whose licence blocks distribution
  (e.g. HyperFormula, GPLv3, used by the spreadsheet editor).
- Keeping the build green: typecheck, lint and test fixes needed because shared code changed. A frozen module may be
  edited **only as much as is needed** to keep compiling and passing after a change elsewhere.
- Removing data that must not ship: real-firm references and demo seeds unsuitable for an India product.
- Deleting dead code inside a frozen module, when nothing outside the module depends on it and the deletion is its
  own reviewed commit.
- Extracting shared code that an India surface needs out of a frozen module (e.g. a parser or a UI primitive). The
  extracted code is then owned by the India surface. The frozen copy is not extended.

**Forbidden**

- New features, new routes, new UI, new tools or new data sources in a frozen area.
- UX polish, redesign or performance work on frozen surfaces.
- Turning a frozen surface on by default (the `NEXT_PUBLIC_ENABLE_*` switches stay off in every deployed environment).
- New seeds or demo content for frozen areas.
- Model/eval work aimed at a frozen area (US case-law evals, deposition or privilege evals) beyond keeping existing
  tests passing.
- Making an India surface depend on a frozen module in a new way. India code depends on shared libraries, not on
  frozen feature modules.

When it is unclear whether a change is allowed, the default is **no**. Record the exception in the PR description.

## Module paths affected

The product switches in `src/lib/features.ts` already hide most of these surfaces (`NEXT_PUBLIC_ENABLE_EDISCOVERY`,
`NEXT_PUBLIC_ENABLE_OFFICE_ALL`, `NEXT_PUBLIC_ENABLE_INTEL`, `NEXT_PUBLIC_ENABLE_WORKFLOWS`, all off by default). The
freeze covers the code, not only the navigation.

### 1. US legal research

| Path | Contents |
|---|---|
| `src/lib/ai/toolkit/legal.ts` | CourtListener, eCFR, Federal Register, GovInfo tools (`LEGAL_TOOLS`). Offered only with `researchToolset({ us: true })`. |
| `src/modules/intel/providers/{courtlistener,ecfr,federal-register,govinfo,jpml,openfda}.ts` | US provider clients |
| `src/modules/intel/adapters/{courtlistener-dockets,courtlistener-judges,courtlistener-opinions,ecfr,federal-register,govinfo,jpml-mdls,openfda-recalls}.ts` | US ingestion adapters |
| `src/app/intel/**` | Intelligence explorer UI (US dockets and Federal Register; hidden unless `NEXT_PUBLIC_ENABLE_INTEL=1`) |
| `src/modules/search/bluebook.ts` | US Bluebook citation builder (India research uses `src/modules/search/india-citations.ts`) |

**Not frozen** in the same directories:

- the Indian intel adapters (`src/modules/intel/adapters/{sci-open-data,hc-open-data,india-code,indian-kanoon,licensed}.ts`);
- the job runner and its cron route (`src/modules/intel/{jobs,run,schedule,background}.ts`, `src/app/api/intel/jobs/**`);
- the shared HTTP and Firecrawl providers (`src/modules/intel/providers/{base,cache,firecrawl,tavily,web,index}.ts`).

India features depend on these.

### 2. E-discovery

| Path | Contents |
|---|---|
| `src/modules/ediscovery/**` (except `analysis/**`, see 3) | review grid, coding, batches, predictions, near-duplicates, redactions, privilege logs, productions, ingestion, seeds |
| `src/app/ediscovery/**` | page (redirects to Documents unless `NEXT_PUBLIC_ENABLE_EDISCOVERY=1`) |
| `src/app/api/ediscovery/**` (except `analysis/**`) | review, search, productions, privilege-log and related APIs |

### 3. Deposition intelligence

| Path | Contents |
|---|---|
| `src/modules/ediscovery/analysis/**` | transcripts, digests, designations, cross-references, contradictions, chronology, people graph, stories, deposition seeds (including `india-deposition.ts`) |
| `src/app/api/ediscovery/analysis/**` | depositions, contradictions, stories APIs |

### 4. Office suite

| Path | Contents |
|---|---|
| `src/modules/office/{sheet,slides,pdf}/**` | Excel, PowerPoint and PDF editors and agents |
| `src/app/office/{sheet,slides,pdf}/**` | editor pages (hidden unless `NEXT_PUBLIC_ENABLE_OFFICE_ALL=1`) |
| `src/app/api/office/{sheet,slides,pdf}/**` | editor APIs |

**Not frozen:** Word, as used by India drafting:

- `src/modules/office/word/**`, in particular `templates-india.ts`;
- `src/modules/office/shared/**` (the agent protocol Word uses);
- `src/modules/office/home/**`;
- `src/app/office/word/**`, `src/app/office/page.tsx`;
- `src/app/api/office/{word,docs,templates,import}/**`.

New Word work must serve India drafting (Indian formats, templates, filings). Generic word-processor features are
frozen.

### Hidden but not covered by this decision

Workflows (`src/modules/workflows/**`, `src/app/workflows/**`) are hidden from navigation by
`NEXT_PUBLIC_ENABLE_WORKFLOWS`, but the engine runs and other modules use it. They are not frozen by this decision.
New workflow UI should wait for the product owner's call.

## Checks

- PR review: any diff touching a path listed above must say which "allowed" category it falls under.
- The `NEXT_PUBLIC_ENABLE_*` switches stay unset in deployed environments. Check them in the Vercel project
  settings when environments are changed.
