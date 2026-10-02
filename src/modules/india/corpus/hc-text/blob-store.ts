import "server-only";
import { remoteUrl } from "@/lib/db/remote";
import { blobs } from "@/lib/db";

/**
 * Optional raw-copy store for judgment PDFs. Postgres never holds raw PDFs: the source of record is the public,
 * immutable AWS Open Data object (its URL and the sha256 of its bytes are kept in hc_text_units), so by default no raw
 * copy is kept at all.
 *
 *   HC_TEXT_BLOB_STORE unset / "none"  no raw copy (production default)
 *   HC_TEXT_BLOB_STORE=local           development only: the local SQLite blobs table. Refused whenever DATABASE_URL /
 *                                      POSTGRES_URL is set, because the blobs table syncs to Postgres (lc_blobs).
 *
 * Object storage later: implement BlobStore over S3/R2 (an S3 client with KMS, bucket + prefix by content hash) or
 * Vercel Blob (`@vercel/blob`, BLOB_READ_WRITE_TOKEN). Neither package is installed in this repository; see
 * docs/architecture/hc-judgment-text.md.
 */
export interface BlobStore {
  kind: "none" | "local";
  configured: boolean;
  /** Store bytes under a content-addressed key; returns the key, or null when nothing is stored. */
  put(key: string, bytes: Uint8Array, mime: string): Promise<string | null>;
}

export const noBlobStore: BlobStore = { kind: "none", configured: false, put: async () => null };

export function localBlobStore(): BlobStore {
  return {
    kind: "local",
    configured: true,
    async put(key, bytes, mime) {
      if (remoteUrl()) throw new Error("the local blob store would sync raw PDFs into Postgres; it is development-only");
      return blobs.put(bytes, mime, { id: key, name: key }).id;
    },
  };
}

export function blobStoreFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): BlobStore {
  const kind = (env.HC_TEXT_BLOB_STORE ?? "none").trim().toLowerCase();
  if (kind === "local" && !remoteUrl()) return localBlobStore();
  return noBlobStore;
}
