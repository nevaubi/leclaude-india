import "server-only";

/**
 * pdf.js for server-side text extraction.
 *
 * In Node, pdf.js runs its worker in-process ("fake worker") by dynamically importing pdf.worker.mjs from its own
 * directory. Serverless bundles only contain files the tracer saw, so the worker is preloaded here from a literal
 * specifier (which the file tracer follows) and handed to pdf.js through `globalThis.pdfjsWorker`, the documented
 * hook for an already-loaded worker. next.config.ts also lists the file in outputFileTracingIncludes.
 */
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loading: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= (async () => {
    const g = globalThis as { pdfjsWorker?: unknown };
    if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}
