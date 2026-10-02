import { describe, expect, it } from "vitest";
import type { SqlValue } from "@/lib/db/remote";
import { corpusFilters } from "@/modules/india/corpus/search";

describe("corpus court filter", () => {
  it("selects registry courts, unmapped codes and records with no court", () => {
    const params: SqlValue[] = [];
    const sql = corpusFilters({ courts: ["sci", "code:XYZ", "code:unknown"] }, params);
    expect(sql).toBe(" AND (court_id = ANY($1::text[]) OR (court_id IS NULL AND court_code = ANY($2::text[])) OR (court_id IS NULL AND court_code IS NULL))");
    expect(params).toEqual([`{"sci"}`, `{"XYZ"}`]);
  });

  it("selects only records with no court for code:unknown alone", () => {
    const params: SqlValue[] = [];
    expect(corpusFilters({ courts: ["code:unknown"] }, params)).toBe(" AND (court_id IS NULL AND court_code IS NULL)");
    expect(params).toEqual([]);
  });
});
