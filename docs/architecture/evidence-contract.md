# Evidence contract

Constitution §23 (legal evidence contract), §24 (high-risk fields), §25 (verify after synthesis), §34 (trust UX),
§44 (adversarial tests), §54 (human review). Code: `src/lib/evidence/**`.

## Invariants

1. **Never substitute evidence.** An unresolved Bates stays unresolved; it is never mapped to the first document,
   the current deposition, the closest witness name or a plausible authority. `assertNoSubstitution()` throws
   `EvidenceSubstitutionError` whenever code tries to bind a source to a citation that did not resolve to exactly
   that record.
2. **Exact source identity.** Every `EvidenceRef` carries the application record id (never a model-generated id)
   plus matter, Bates/range, deposition/witness/page/line, exhibit, authority id, URL, content hash and version as
   applicable.
3. **Separate states.** "Source exists", "found", "read", "citation location valid", "quote exists",
   "proposition supported" are separate fields (`SourceStates`); a citation that resolves is not a supported claim.
4. **Answer-version binding.** Citation checks, verifications and human decisions bind to the sha256 of the
   canonical artifact text. A changed artifact rebinds the trust record and stale results stop counting; a stale
   result is refused, never silently applied.
5. **Scope.** Every lookup is confined to a `MatterScope`; an empty scope resolves nothing.

## Modules

| file | scope | purpose |
|---|---|---|
| `types.ts` | client-safe | `EvidenceRef`, `Citation`/`CitationState`, `Claim`, `CitationCheck`, `VerificationVerdict`, `TrustRecord`, `HIGH_RISK_FIELDS` |
| `trust.ts` | client-safe, pure | `deriveTrustState()`, `rebindArtifact()`, `isVerificationCurrent()`, `trustLabel()` |
| `hash.ts` / `hash-server.ts` | client-safe / server-only | `artifactHash()` (Web Crypto, node:crypto fallback), `artifactHashSync()`; both hash `canonicalText()` (NFC, whitespace runs collapsed, trimmed) |
| `cite-parse.ts` | client-safe, pure | `extractCitations()`, `parseCitation()` for Bates, deposition page:line, exhibits, docket entries, reporter citations |
| `resolve.ts` | server-only | `resolveCitation()`, `resolveCitationsIn()`, `checkCitations()`, `retryCitation()` against the record within a scope |
| `verify-pure.ts` | client-safe, pure | `quoteAppears()`, `applyQuoteGuard()`, `tagHighRisk()`, `summarizeClaims()`, `buildVerdict()` |
| `verify.ts` | server-only | `verifyClaims()` — two structured model calls plus the deterministic guard |
| `records.ts` | server-only | trust records in `trust_records`: `ensureTrust`, `recordSources`, `recordCitationCheck`, `recordVerification`, `recordReview`, `touchArtifact` |
| `guard.ts` | client-safe, pure | `assertNoSubstitution()`, `resolvedRefs()` |
| `sensitivity.ts` | client-safe, pure | `sensitivityOf(doc)` — privilege is a coded decision, never inferred from a cc line |

## Citation states

| state | meaning |
|---|---|
| `resolved` | exactly one record exists in scope **and** the cited location is valid in it (Bates inside the document's range; page within the transcript's page count and lines 1–25; exhibit marked in that deposition; docket entry number present; authority in the local record) |
| `unresolved` | no record in scope, or the location is invalid (page beyond the transcript, Bates outside every range); `reason` says which |
| `requires_review` | more than one candidate matches (two documents covering a Bates number, a witness with several volumes that both contain the page, a bare "Ex. 3" marked by several witnesses); the candidates are listed in `reason` and none is picked |
| `excluded` | the token is not a citation (a case-number prefix such as `MDL-3140`, a clock time) |
| `retried` | a second attempt (`retryCitation`) still found nothing |

### Resolution rules

- **Bates** (`MFC-0041877`, `ABC-0001234–0001240`, `DEF_00012`, `MFC-0041877 – MFC-0041880`): the prefix must
  match a document in scope and the number (or the whole range) must lie inside that document's `bates…batesEnd`
  or inside a production set's assigned range for that document; the ref carries the page offset within the
  document. Years and case numbers are not Bates.
- **Deposition page:line** (`Smith Dep. 45:12–46:3`, `Deposition of Hema Vasudevan, 45:12`, `Vasudevan Tr. Vol. 2, 12:4`):
  the surname (or full name) must match a witness in scope; the page must be ≤ the transcript page count (or
  present in the transcript when no page count is recorded); a volume narrows the candidates. A bare `45:12` needs
  explicit context (`defaultDepositionId`, e.g. when checking a digest of one transcript) and is otherwise
  unresolved — the deposition is never guessed.
- **Exhibits** (`Ex. 12`, `Exhibit Vasudevan-3`, `Vasudevan Ex. 3`): matched against the exhibits marked in depositions in
  scope; a bare number marked by several witnesses is `requires_review`.
- **Docket entries** (`ECF No. 2600`, `Dkt. 15`, `D.E. 12`): `intel_documents` of kind `docket_entry` whose
  `meta.entryNumber` matches and whose `matterIds` overlap the scope.
- **Reporter citations** (`550 U.S. 544`, `860 F.3d 249`, `716 F. Supp. 2d 100`): compared on a whitespace-free
  key; looked up in intel opinion records (the canonical authority store), then cached research hits
  (`search_runs.topHits`), then library links/notes that carry the cite. Duplicates within a tier are
  `requires_review`. An authority that is in none of these is `unresolved` with the note to verify it against a
  primary source — it is never assumed to exist.

## Verification

`verifyClaims({ artifactText, artifactHash, sources, scope })`:

1. Sources outside the scope are refused (403) before any model call; with no sources the verdict is
   `unsupported` without a model call.
2. Model call 1 (strict JSON schema): extract atomic claims, tag the high-risk fields each touches, copy attached
   record cites.
3. Model call 2 (strict JSON schema): per claim, `supported | partially_supported | unsupported | contradicted`, a
   source index and a verbatim quote of ≥ 12 characters.
4. **Deterministic guard** (`applyQuoteGuard`): a claim counts as supported, partially supported or contradicted
   only when the quoted passage literally appears in the named source's text (whitespace, quote glyphs and
   dashes canonicalized, case-insensitive). Otherwise it is demoted to `unsupported` with a note. Claims the model
   skipped are `unchecked`.
5. Cites inside claims are resolved within the scope (`Claim.citations`).
6. `buildVerdict`: status `verified` only when every claim is supported; `contradicted` when any claim is;
   `partially_supported` when some are; otherwise `unsupported` (also for zero claims — a fluent non-answer never
   scores as verified). Score = (supported + ½ partially) / total.

### High-risk fields

`HIGH_RISK_FIELDS` (privilege, responsiveness, deadline, limitations, settlement, holding, quote, admission,
causation, damages, procedural posture, adverse authority, dispositive standard, medical/scientific fact) are
tagged by the model **and** by keyword patterns (`tagHighRisk`); either marks `Claim.highRisk`. The verdict notes
how many high-risk claims are not fully supported; those require human review before downstream use.

## Trust records and hash binding

```
generated → source_linked → citation_checked → claim_checked | partially_supported | verified → human_approved | rejected
```

`deriveTrustState` ignores any citation check, verification or review whose `artifactHash` differs from the
record's. `touchArtifact(id, newHash, newVersion)` rebinds the record when the artifact changes; the derived
state drops back to what the remaining evidence supports (typically `source_linked`). `recordCitationCheck`,
`recordVerification` and `recordReview` throw `StaleVerificationError` when handed a result for another hash (or,
for reviews, another version) — the caller must re-run against the current version. `sources.length > 0` is
never trust: with sources but nothing established the state stays `generated`.

## First call sites to fix (follow-up wave)

- `src/modules/ediscovery/analysis/ai.ts:253` — `findContradictions` binds a document-side cite with
  `d.edocs.findOne(bates match)?.id ?? docs[0]?.id` and a testimony-side cite with `findOne(witness surname)?.id ??
  dep.id`. Both are forbidden fallbacks (unresolved Bates → first document; unresolved witness → current
  deposition). Replace with `resolveCitation(c.sourceCite, scope)` and `assertNoSubstitution()`; an unresolved or
  `requires_review` cite must produce a conflict flagged for review with no `sourceId`, not a conflict bound to a
  guessed record.
- The same pattern (`?? docs[0]`, `?? dep.id`, `findOne(...includes(last))`) should be searched for in the
  timeline, fact-matrix and knowledge-map generators in the same module and in `src/lib/ai/verify.ts`
  (`crossCheckCitations` accepts page-only matches; prefer `checkCitations` which validates the witness and volume).
- Research synthesis (`src/modules/search/engine`) should call `checkCitations` on the final answer and store the
  `CitationCheck` and `VerificationVerdict` through `records.ts` so the UI can show the separate states.
