"use client";
import * as React from "react";
import { toast } from "sonner";
import type { DocReviewRow, ReviewFacets, RowQuery } from "../../review-types";
import { docsApi, errorKind, errorMessage, type ApiErrorKind } from "../api";
import { reviewUrl, rowQueryString } from "./review-helpers";

export const ROW_PAGE = 150;
/** On a refresh (run progress, coding) the rows already loaded are re-read, up to this many in one call. */
const REFRESH_MAX = 500; // the server caps limit at 500

export type RowsLoad =
  | { status: "loading" }
  | { status: "ready"; rows: DocReviewRow[]; total: number; facets: ReviewFacets | null; more: boolean; refreshing: boolean }
  | { status: "error"; message: string; kind: ApiErrorKind };

/**
 * Rows of a review for a filter, paged with offset/limit (sets hold up to 5000 files). `refresh()` re-reads the rows
 * already loaded in place (used while a run progresses), `reload()` starts again from the first page.
 */
export function useReviewRows(setId: string, reviewId: string | null, query: Omit<RowQuery, "offset" | "limit">) {
  const [load, setLoad] = React.useState<RowsLoad>({ status: "loading" });
  const [reloadKey, setReloadKey] = React.useState(0);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const busyMore = React.useRef(false);
  const qs = rowQueryString(query);
  const qsRef = React.useRef(qs);
  qsRef.current = qs;

  const url = React.useCallback((offset: number, limit: number) => {
    if (!reviewId) return "";
    const base = qsRef.current;
    return reviewUrl(setId, reviewId, `/rows?${base ? `${base}&` : ""}offset=${offset}&limit=${limit}`);
  }, [reviewId, setId]);

  React.useEffect(() => {
    if (!reviewId) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      setLoad((l) => (l.status === "ready" ? { ...l, refreshing: true } : { status: "loading" }));
      docsApi<{ rows: DocReviewRow[]; total: number; facets: ReviewFacets }>(url(0, ROW_PAGE), { signal: ac.signal })
        .then((r) => setLoad({ status: "ready", rows: r.rows ?? [], total: r.total ?? 0, facets: r.facets ?? null, more: (r.rows?.length ?? 0) < (r.total ?? 0), refreshing: false }))
        .catch((e) => { if (!ac.signal.aborted) setLoad({ status: "error", message: errorMessage(e), kind: errorKind(e) }); });
    }, /\bq=/.test(qs) ? 250 : 0);
    return () => { clearTimeout(t); ac.abort(); };
  }, [qs, reviewId, reloadKey, url]);

  const loadMore = React.useCallback(() => {
    const l = loadRef.current;
    if (l.status !== "ready" || !l.more || busyMore.current) return;
    busyMore.current = true;
    const forQs = qsRef.current;
    docsApi<{ rows: DocReviewRow[]; total: number; facets: ReviewFacets }>(url(l.rows.length, ROW_PAGE))
      .then((r) => {
        if (qsRef.current !== forQs) return;
        setLoad((cur) => {
          if (cur.status !== "ready") return cur;
          const seen = new Set(cur.rows.map((x) => x.fileId));
          const rows = [...cur.rows, ...(r.rows ?? []).filter((x) => !seen.has(x.fileId))];
          return { ...cur, rows, total: r.total, facets: r.facets ?? cur.facets, more: rows.length < r.total && (r.rows?.length ?? 0) > 0 };
        });
      })
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => { busyMore.current = false; });
  }, [url]);

  /** Re-read the loaded window in place (keeps scroll position and selection). */
  const refresh = React.useCallback(() => {
    const l = loadRef.current;
    if (l.status !== "ready") { setReloadKey((n) => n + 1); return; }
    const forQs = qsRef.current;
    const limit = Math.min(REFRESH_MAX, Math.max(ROW_PAGE, l.rows.length));
    docsApi<{ rows: DocReviewRow[]; total: number; facets: ReviewFacets }>(url(0, limit))
      .then((r) => {
        if (qsRef.current !== forQs) return;
        setLoad((cur) => (cur.status === "ready" || cur.status === "loading"
          ? { status: "ready", rows: r.rows ?? [], total: r.total ?? 0, facets: r.facets ?? null, more: (r.rows?.length ?? 0) < (r.total ?? 0), refreshing: false }
          : cur));
      })
      .catch(() => { /* a failed background refresh keeps the rows shown; the next one retries */ });
  }, [url]);

  const replaceRow = React.useCallback((row: DocReviewRow) => {
    setLoad((l) => (l.status === "ready" ? { ...l, rows: l.rows.map((x) => (x.fileId === row.fileId ? row : x)) } : l));
  }, []);

  return { load, loadMore, refresh, reload: () => setReloadKey((n) => n + 1), replaceRow };
}
