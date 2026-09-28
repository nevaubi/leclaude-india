import "server-only";
import { decodeEntities } from "@/lib/ai/toolkit/http";
import { ProviderError } from "@/modules/intel/providers/base";
import { SourceHttp, type SourceHttpOptions } from "./http";
import type { S3ListPage, S3ObjectInfo } from "./types";

/**
 * Anonymous, read-only client for a public AWS Open Data bucket (virtual-hosted style URL). Only ListObjectsV2 and
 * GetObject are used; there are no credentials and no writes. The host allowlist is exactly the bucket host.
 */
export const SCI_BUCKET_URL = "https://indian-supreme-court-judgments.s3.amazonaws.com";
export const HC_BUCKET_URL = "https://indian-high-court-judgments.s3.ap-south-1.amazonaws.com";

export interface OpenDataBucket {
  name: string;
  baseUrl: string;
  http: SourceHttp;
  list(prefix: string, o?: { startAfter?: string; token?: string; maxKeys?: number; delimiter?: string; signal?: AbortSignal }): Promise<S3ListPage>;
  /** All common prefixes directly under `prefix` (delimiter "/"), following continuation tokens. */
  folders(prefix: string, signal?: AbortSignal): Promise<string[]>;
  getJSON<T>(key: string, signal?: AbortSignal): Promise<T>;
  getBytes(key: string, o?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; contentType: string; etag?: string; truncated: boolean }>;
  /** Public HTTPS URL of an object (for citations and the UI "open original" link). */
  urlFor(key: string): string;
}

export function encodeKey(key: string): string {
  return key.split("/").map((p) => encodeURIComponent(p).replace(/%3D/g, "=")).join("/");
}

/** Parse an S3 ListBucketResult (v2) document. Deterministic, no XML dependency; unknown elements are ignored. */
export function parseListObjectsV2(xml: string): S3ListPage {
  if (!/<ListBucketResult\b/.test(xml)) {
    const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
    throw new ProviderError("s3", "parse", `S3 list response is not a ListBucketResult${code ? ` (${code})` : ""}`, false);
  }
  const tag = (block: string, name: string) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block); return m ? decodeEntities(m[1]) : undefined; };
  const objects: S3ObjectInfo[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = tag(block, "Key");
    if (!key) continue;
    objects.push({ key, lastModified: tag(block, "LastModified") ?? "", etag: (tag(block, "ETag") ?? "").replace(/"/g, ""), size: Number(tag(block, "Size") ?? 0) || 0 });
  }
  const prefixes: string[] = [];
  for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g)) prefixes.push(decodeEntities(m[1]));
  const head = xml.replace(/<Contents>[\s\S]*?<\/Contents>/g, "").replace(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g, "");
  const truncated = tag(head, "IsTruncated") === "true";
  return { objects, prefixes, nextToken: tag(head, "NextContinuationToken"), truncated, keyCount: Number(tag(head, "KeyCount") ?? objects.length) || 0 };
}

export function createOpenDataBucket(name: string, baseUrl: string, opts: Omit<SourceHttpOptions, "name" | "egress"> & { egressHosts?: string[] } = {}): OpenDataBucket {
  const host = new URL(baseUrl).host;
  const http = new SourceHttp({ name, egress: { name, allowHosts: opts.egressHosts ?? [`=${host}`], allowedSchemes: ["https:"] }, rps: opts.rps ?? 10, burst: opts.burst ?? 10, ...opts });
  const bucket: OpenDataBucket = {
    name,
    baseUrl,
    http,
    urlFor: (key) => `${baseUrl}/${encodeKey(key)}`,
    async list(prefix, o = {}) {
      const q = new URLSearchParams({ "list-type": "2", prefix });
      if (o.delimiter) q.set("delimiter", o.delimiter);
      if (o.maxKeys) q.set("max-keys", String(Math.min(1000, Math.max(1, o.maxKeys))));
      if (o.token) q.set("continuation-token", o.token);
      else if (o.startAfter) q.set("start-after", o.startAfter);
      const xml = await http.text(`${baseUrl}/?${q.toString()}`, { signal: o.signal, maxBytes: 4 * 1024 * 1024, headers: { Accept: "application/xml" } });
      return parseListObjectsV2(xml);
    },
    async folders(prefix, signal) {
      const out: string[] = [];
      let token: string | undefined;
      for (let i = 0; i < 50; i++) {
        const page = await bucket.list(prefix, { delimiter: "/", token, signal });
        out.push(...page.prefixes);
        if (!page.truncated || !page.nextToken) break;
        token = page.nextToken;
      }
      return out;
    },
    async getJSON<T>(key: string, signal?: AbortSignal) {
      return http.json<T>(bucket.urlFor(key), { signal, maxBytes: 4 * 1024 * 1024 });
    },
    async getBytes(key, o = {}) {
      const r = await http.request(bucket.urlFor(key), { signal: o.signal, maxBytes: o.maxBytes });
      return { bytes: r.body, contentType: r.contentType, etag: r.headers.get("etag")?.replace(/"/g, "") ?? undefined, truncated: r.truncated };
    },
  };
  return bucket;
}
