import { withDb } from "@/lib/db/request";
import { edAuth } from "@/modules/ediscovery/route-auth";
import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { audit } from "@/lib/integrity/audit";
import { errorResponse } from "@/modules/ediscovery/api-utils";
import { buildProductionZip, productionLoadFiles } from "@/modules/ediscovery/production-export";

export const runtime = "nodejs";

/** GET ?format=dat|opt|zip — load files or the whole volume (DAT, OPT, redacted text, image-surrogate PDFs, QC report). */
async function GET__handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = req.nextUrl.searchParams.get("format") ?? "zip";
  try {
    if (format === "dat" || format === "opt") {
      const { dat, opt, production } = productionLoadFiles(id);
      audit("export", { kind: "production", id, label: `${production.name} ${format.toUpperCase()}`, matterId: production.matterId }, { format });
      const body = format === "dat" ? dat : opt;
      return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${production.volume}.${format}"` } });
    }
    if (format !== "zip") return jsonError("format must be dat, opt or zip");
    const { bytes, filename, files } = await buildProductionZip(id);
    const { production } = productionLoadFiles(id);
    audit("export", { kind: "production", id, label: `${production.name} volume zip (${files} files)`, matterId: production.matterId }, { format: "zip", files, bytes: bytes.byteLength });
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename}"`, "Content-Length": String(bytes.byteLength) } });
  } catch (e) { return errorResponse(e); }
}

export const GET = withDb(edAuth(GET__handler, { lookup: "production", action: "export" }));
