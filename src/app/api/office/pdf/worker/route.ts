import { withDb } from "@/lib/db/request";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";

export const runtime = "nodejs";

/**
 * Serves the pdf.js worker bundle for the browser viewer. Bundling the worker
 * through `new URL(..., import.meta.url)` is blocked by the project's ESM
 * externals configuration, so the file is read from node_modules at request
 * time (pdfjs-dist is a server-external package and stays on disk). For
 * static hosting, run `node src/modules/office/pdf/scripts/copy-worker.mjs`
 * and set NEXT_PUBLIC_PDFJS_WORKER_URL=/vendor/pdf.worker.min.mjs.
 */
let cached: { body: Buffer; version: string } | null = null;

async function GET__handler() {
  try {
    if (!cached) {
      const root = path.join(process.cwd(), "node_modules", "pdfjs-dist");
      const [body, pkg] = await Promise.all([readFile(path.join(root, "legacy", "build", "pdf.worker.min.mjs")), readFile(path.join(root, "package.json"), "utf8")]);
      cached = { body, version: (JSON.parse(pkg) as { version: string }).version };
    }
    return new Response(cached.body as unknown as BodyInit, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400", ETag: `"pdfjs-${cached.version}"`, "X-PDFJS-Version": cached.version } });
  } catch (e) {
    return new Response(`// pdf.js worker unavailable: ${(e as Error).message}`, { status: 500, headers: { "Content-Type": "text/javascript; charset=utf-8" } });
  }
}

// Same-origin worker fetches carry the session cookie, so the viewer keeps working with sign-in enforced.
export const GET = withDb(withAuth(GET__handler, { action: "read", resource: () => refs.settings() }));
