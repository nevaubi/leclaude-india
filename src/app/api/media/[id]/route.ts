import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/ai/sse";
import { withAuth } from "@/lib/auth/route";
import { refs } from "@/lib/auth/resources";
import { withDb } from "@/lib/db/request";
import { getMedia, isMediaId, MediaNotConfiguredError } from "@/modules/media";

import { mediaWidth } from "@/modules/media/display";
import { mediaVariant } from "@/modules/media/variants";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/media/<sha256> → the stored image bytes. The id is the content hash, so the response never changes:
 * strong ETag, long immutable (private: the route is authorized) caching. Attribution travels in headers.
 */
async function handleGET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isMediaId(id)) return jsonError("Not a media id", 400, { code: "bad_id" });
  const width = mediaWidth(new URL(req.url).searchParams.get("w"));
  const etag = `"${id}${width ? ":webp-v1:" + width : ""}"`;
  // Content-addressed: a client holding this ETag already has these exact bytes (authorization still ran above).
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" } });
  }
  try {
    const m = await getMedia(id);
    if (!m) return jsonError("No media with this id", 404, { code: "not_found" });
    const image = width ? await mediaVariant(m, width) : m;
    const headers: Record<string, string> = {
      "Content-Type": image.mime,
      ETag: etag,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    };
    if (m.sourceUrl) headers["X-Media-Source"] = encodeURI(m.sourceUrl);
    if (m.publisher) headers["X-Media-Publisher"] = encodeURIComponent(m.publisher);
    return new Response(image.bytes as unknown as BodyInit, { headers: { ...headers, "Content-Length": String(image.bytes.byteLength) } });
  } catch (e) {
    if (e instanceof MediaNotConfiguredError) return jsonError(e.message, 503, { code: e.code });
    console.error(JSON.stringify({ level: "error", event: "media.read_failed", error: (e as Error).message }));
    return jsonError("The image could not be loaded.", 502, { code: "media_unavailable" });
  }
}

export const GET = withDb(withAuth(handleGET, { action: "read", resource: () => refs.intel() }));
