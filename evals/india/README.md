# India evals

Deterministic adversarial cases for the Indian legal engine (`src/lib/india/**`). No database and no model are
needed; every check is graded in code.

```bash
npx tsx evals/india/run.ts            # all cases; exits 1 on any failure
npx vitest run tests/india-citations-evals.test.ts
```

| id | guards against |
|---|---|
| india-wrong-neutral-citation | a malformed/impossible neutral citation bound to the nearest court |
| india-ipc-bns-date-boundary | the wrong code applied at the 1 July 2024 boundary; a split section collapsed to one |
| india-sc-vs-hc-binding | binding effect guessed for a citation whose court is not certain |
| india-same-party-names-across-states | same-name Karnataka and Telangana authorities merged, or a misleading supra/ibid |
