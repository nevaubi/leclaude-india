import "server-only";
import https from "node:https";
import { constants } from "node:crypto";

/**
 * Some official Indian court servers still require TLS "unsafe legacy renegotiation", which Node refuses by default
 * (ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED). For public images on government hosts only, the media store retries
 * once with a fetch implementation that allows it. Certificates are still verified; everything else (SSRF checks,
 * redirects, size and time limits) stays with safeFetch, which calls this as its `fetchImpl`.
 */

const LEGACY_HOSTS = /(^|\.)(gov\.in|nic\.in)$/i;
const MAX_BYTES = 4 * 1024 * 1024;

export function isLegacyTlsError(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const s = `${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? ""} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  return /UNSAFE_LEGACY_RENEGOTIATION/i.test(s);
}

export function legacyTlsAllowed(url: string): boolean {
  try { const u = new URL(url); return u.protocol === "https:" && LEGACY_HOSTS.test(u.hostname); } catch { return false; }
}

const agent = new https.Agent({ secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT, keepAlive: false });

/** A minimal fetch (GET/HEAD, no automatic redirects) over node:https with legacy renegotiation allowed. */
export const legacyTlsFetch: typeof fetch = (input, init) => new Promise<Response>((resolve, reject) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!legacyTlsAllowed(url)) { reject(new Error("legacy TLS is allowed only for https government hosts")); return; }
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k] = v; });
  const req = https.request(url, { method: init?.method ?? "GET", headers, agent }, (res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BYTES) { req.destroy(new Error("response too large")); return; }
      chunks.push(c);
    });
    res.on("end", () => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const status = res.statusCode ?? 502;
      const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
      resolve(new Response(body, { status, headers: h }));
    });
    res.on("error", reject);
  });
  req.on("error", reject);
  init?.signal?.addEventListener("abort", () => req.destroy(new Error("This operation was aborted")), { once: true });
  req.end();
});
