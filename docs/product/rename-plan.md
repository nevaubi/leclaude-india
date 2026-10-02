# Rename plan: moving away from "LeClaude"

Status: **decision recorded, name not chosen.** This document records why the product must be renamed, what the rename
touches in this repository, and how to migrate without breaking running deployments. It does not choose the final name.

## Why

"LeClaude" contains "Claude", a mark of Anthropic used for its AI models and products. The product is a legal research
service that calls several model providers (including Anthropic's). A name built on another company's mark has
three problems:

- it may suggest an affiliation or endorsement that does not exist;
- it may conflict with the mark owner's brand and trademark guidelines;
- it limits our ability to register a domain, company name or trademark of our own.

The product is also being repositioned as an India-first research and litigation workspace (see the
[README](../../README.md)). The rename should happen before any public launch, paid pilot or registration, while it is
still cheap.

This document makes no legal assessment of any candidate name. A trademark clearance search is required before
adoption: Indian Trade Marks Registry in Classes 9, 42 and 45 at least, WIPO Global Brand Database, plus a common-law
and domain search.

## What the name touches (inventory from the code)

| Surface | Current spelling | Where | Migration risk |
|---|---|---|---|
| Display name | "LeClaude", "LeClaude India" | `src/lib/i18n/messages/*.ts` (en, hi, kn, te, ta, mr, bn, ur), `src/app/layout.tsx` metadata, `NEXT_PUBLIC_APP_NAME` | Low: strings only. Every locale must be updated together. |
| Package name | `"name": "leclaude"`, description | `package.json`, `package-lock.json` | Low (private package). |
| Repository | `leclaude-india` | GitHub remote | Medium: CI, deploy hooks and clones follow the URL. GitHub redirects renamed repos, but update the remotes. |
| Vercel project / domain | project name and `*.vercel.app` alias | Vercel dashboard | Medium: preview URLs and any external cron caller (e.g. cron-job.org) use the host. |
| Environment variables | `LECLAUDE_DATA_DIR`, `LECLAUDE_TENANT_ID`, `LECLAUDE_USER_ID`, `LECLAUDE_SEED`, `LECLAUDE_BACKGROUND`, `LECLAUDE_CORPUS_DIRS`, `LECLAUDE_INDIA_OPEN_DATA`, `LECLAUDE_STRICT_SCOPE` | `src/**`, `scripts/**`, `.env.example` | **High**: a deployment that keeps the old names must not silently lose configuration. Needs aliases (below). |
| HTTP header | `x-leclaude-user` (AUTH_MODE=header), `x-leclaude-sheet`, `x-leclaude-workflow-node`, `x-leclaude-library-items` | `src/lib/auth/types.ts` and callers | **High** for `x-leclaude-user`: a reverse proxy asserts identity with it. Accept both names during the transition. |
| Browser storage keys | `leclaude:theme`, `leclaude:shell`, `leclaude:search`, `leclaude:home`, `leclaude:library`, `leclaude:library:views`, `leclaude:clause-values:*`, `leclaude:ediscovery:review`, `leclaude.chat.knowledge` | client components | Low: per-viewer preferences. Read the old key once, write the new one. |
| Cookies | `lc_locale`, `lc_answer_lang` | `src/lib/i18n` | None if the `lc_` prefix is kept as a neutral abbreviation. Otherwise read both. |
| Database file names | `leclaude.db`, `leclaude-mirror.db`, data dir `leclaude-data` | `src/lib/db/sqlite.ts`, `sync.ts` | Medium for local dev: keep the old file if it exists. Mirrors are throwaway. |
| Postgres tables | `lc_docs`, `lc_kv`, `lc_blobs`, `lc_vectors`, `lc_changes` | `src/lib/db/remote.ts` | **Do not rename.** `lc_` is neutral and renaming production tables is pointless risk. |
| KV keys | `seed:version`, `seed:reference-version` and other kv keys | `src/lib/seed/index.ts` | None: they do not contain the name. Do not change them, or seeds re-run. |
| Global singletons | `globalThis.__leclaude*` (≈40 keys) | `src/**` | Low: process-local. Rename mechanically in one commit. |
| Export identifiers | PowerPoint layout name `LECLAUDE_WIDE` | `src/modules/office/slides/export.ts` | Low: internal layout id inside exported decks (frozen module). |
| Brand assets | logo and icon files | `public/brand/**`, `src/app/icon.svg` | Low: replace with the new mark. |
| Docs | `CLAUDE.md`, `docs/**`, `evals/**` | repo | Low. `CLAUDE.md` is the agent-instruction filename the tooling expects and **must keep that name**. Only the product name inside it changes. |

## Migration checklist

Each step is a separate, reviewable commit. Steps 1 to 4 keep backward compatibility, so a deployment configured with
the old names keeps working throughout.

1. **Clearance.** Run trademark and domain searches on the shortlist. The product owner picks the name. Register the
   domain(s) and reserve the GitHub org or repo name and the Vercel project name.
2. **Env var aliases.** Add one helper, e.g. `appEnv("DATA_DIR")`, that reads `<NEW>_DATA_DIR` first and falls back
   to `LECLAUDE_DATA_DIR`. When only the old name is set, it logs a one-time deprecation warning that names the
   variable, never its value. Replace every direct `process.env.LECLAUDE_*` read with the helper. Unit-test both
   spellings and test that the new name wins when both are set. Document both names in `.env.example`.
3. **Header alias.** Accept `x-<new>-user` and `x-leclaude-user` in `AUTH_MODE=header`. If both are present and differ,
   reject the request (401), never pick one. Update the reverse-proxy configuration, then remove the old header in
   step 7.
4. **Client storage migration.** On first load, copy each `leclaude:*` localStorage key to the new key if the new key
   is absent, then delete the old key. Wrap every access in try/catch (storage may be unavailable).
5. **Display strings.** Change the app name in all eight locale files, layout metadata, the PWA/manifest (if any),
   e-mail and export footers, brand assets and `package.json`. Translations of the new name, if
   any, come from the product owner, not from machine translation.
6. **Infrastructure.** Rename the GitHub repo (GitHub keeps a redirect) and update local remotes. Rename the Vercel
   project, or create a new one and move env vars and domains to it. Update external cron callers and any webhook URLs.
   Set the new env var names on every environment, redeploy, and confirm `GET /api/health` and the cron routes
   authenticate.
7. **Remove aliases** after at least one release cycle in which no deprecation warning was logged: drop
   `LECLAUDE_*` fallbacks, the old header and the localStorage migration code.
8. **Not renamed:** Postgres table names (`lc_*`), kv keys, cookie names with the neutral `lc_` prefix, historical
   audit records and trace ids. Stored data that contains the old name is history and is not rewritten.

Acceptance:

- `rg -i "leclaude"` over `src/` returns only the alias layer (until step 7) and the allow-listed storage names.
- All tests pass with only new env names set, and again with only old names set (until step 7).
- No user-visible "LeClaude" or "Claude" in the UI in any locale, except where a model provider is named as a
  provider (e.g. "Anthropic Claude via Bedrock" in Settings → AI).

## Candidate name directions

These are directions, not recommendations. Each needs a clearance search. Do not adopt any of them on the strength of
this list.

1. **Indian legal vocabulary.** Words lawyers already use, such as *nyaya* (justice), *vidhi* (law) or *pramaan*
   (proof/evidence). Clear meaning for Indian users, but common in existing legal-tech and government names, so
   clearance risk is higher.
2. **Precedent and citation.** Names about authority and lineage ("precedent", "ratio", "stare", "cite"). This fits the
   citator, binding-force and authority-table features, but many English-language legal products use similar words.
3. **Record and source.** Names that stress the "official copy" principle ("record", "folio", "gazette", "registry").
   This fits the product's positioning (public sources, verify against the official copy) but must not suggest
   government affiliation.
4. **Workspace and desk.** Names about the advocate's daily desk ("chamber", "brief", "diary", "cause list"). This
   fits the matter desk and drafting features, but is narrower if research becomes the main product.
5. **Coined or abstract mark.** An invented word with no descriptive meaning. Easiest to clear and register and to
   take beyond India, but needs more brand-building to carry meaning.

Constraints for every candidate:

- does not contain or allude to "Claude", "Anthropic", "GPT", any model or provider name, or any court's or
  government body's name or emblem;
- does not suggest an official or government source;
- has a `.in` and a `.com` (or `.ai`) domain available;
- is pronounceable in the eight interface languages and has no unfortunate meaning in them (check with native
  speakers);
- works as an env var prefix and storage-key prefix (short, ASCII, no hyphen needed).

## Open decisions for the product owner

- Final name, and whether "India" stays in the product name or only in marketing.
- Whether to keep the `lc_` table, cookie and abbreviation prefix (recommended: keep).
- Whether the repo and Vercel project are renamed in place or recreated.
