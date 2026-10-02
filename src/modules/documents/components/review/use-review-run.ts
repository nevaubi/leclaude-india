"use client";
import * as React from "react";
import type { ReviewProgress } from "../../review-types";
import { docsApi, errorKind, errorMessage, isAbort, UNCONFIGURED_MESSAGE, type ApiErrorKind } from "../api";
import { reviewUrl } from "./review-helpers";

export interface ReviewRun {
  running: boolean;
  /** Calls made in this run. */
  calls: number;
  processed: number;
  failed: number;
  remaining: number;
  errors: ReviewProgress["errors"];
  stopped?: "cancelled" | "stalled" | "error";
  message?: string;
  kind?: ApiErrorKind;
}

/**
 * Drives POST /reviews/:rid/run until `remaining` is 0 (each call reviews a batch of files for up to ~200 s), with
 * cancel (AbortController) and a guard against a server that makes no progress.
 */
export function useReviewRun(setId: string, reviewId: string | null, onProgress: () => void) {
  const [run, setRun] = React.useState<ReviewRun | null>(null);
  const ctrlRef = React.useRef<AbortController | null>(null);
  const onProgressRef = React.useRef(onProgress);
  onProgressRef.current = onProgress;

  // A different review starts with no run state (a run in flight for the previous one is cancelled).
  React.useEffect(() => { setRun(null); return () => { ctrlRef.current?.abort(); ctrlRef.current = null; }; }, [reviewId]);

  const start = React.useCallback(async () => {
    if (ctrlRef.current || !reviewId) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const acc: ReviewRun = { running: true, calls: 0, processed: 0, failed: 0, remaining: 0, errors: [] };
    setRun({ ...acc });
    let lastRemaining = Infinity;
    let stalls = 0;
    try {
      for (;;) {
        const r = await docsApi<ReviewProgress>(reviewUrl(setId, reviewId, "/run"), { json: {}, signal: ctrl.signal });
        acc.calls++;
        acc.processed += r.processed; acc.failed += r.failed; acc.remaining = r.remaining;
        acc.errors = [...acc.errors, ...r.errors].slice(-200);
        setRun({ ...acc });
        onProgressRef.current();
        if (r.remaining <= 0) break;
        if (r.processed === 0 && r.failed === 0 && r.remaining >= lastRemaining) {
          if (++stalls >= 2) { acc.stopped = "stalled"; acc.message = `${r.remaining.toLocaleString("en-IN")} file${r.remaining === 1 ? "" : "s"} could not be reviewed now. Try again later.`; break; }
        } else stalls = 0;
        lastRemaining = r.remaining;
      }
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) acc.stopped = "cancelled";
      else { acc.stopped = "error"; acc.kind = errorKind(e); acc.message = acc.kind === "unconfigured" ? UNCONFIGURED_MESSAGE : errorMessage(e); }
    } finally {
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
      setRun({ ...acc, running: false });
      onProgressRef.current();
    }
  }, [reviewId, setId]);

  const cancel = React.useCallback(() => ctrlRef.current?.abort(), []);
  return { run, start, cancel, dismiss: () => setRun(null) };
}

export type ReviewRunner = ReturnType<typeof useReviewRun>;
