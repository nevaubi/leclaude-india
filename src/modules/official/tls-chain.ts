import "server-only";
import https from "node:https";
import tls from "node:tls";
import { constants, X509Certificate } from "node:crypto";
import { safeFetch } from "@/lib/net/safe-fetch";

/**
 * Incomplete certificate chains (UNABLE_TO_VERIFY_LEAF_SIGNATURE).
 *
 * Some government servers send only their leaf certificate, without the intermediate that links it to a public root.
 * Browsers complete such chains from the certificate's Authority Information Access "CA Issuers" URL; this does the
 * same, once per host:
 * 1. read the leaf certificate (that connection carries no request and is closed at once; nothing from it is trusted);
 * 2. download the issuer certificate from the URL the leaf names (public hosts only, 64 KB, 10 s), and that
 *    certificate's own issuer the same way, at most three hops (e.g. Let's Encrypt YR2 → Root YR cross-signed by X1);
 * 3. accept the path only when every certificate is a currently valid CA, is named as the previous one's issuer and
 *    signed it, and the last one was issued and signed by a root in Node's store;
 * 4. requests then go through an agent whose CA list is Node's roots plus that intermediate: the full chain is still
 *    verified for every request, including the host name.
 */

const ISSUER_MAX_BYTES = 64 * 1024;
const ISSUER_TIMEOUT_MS = 10_000;
const NEGATIVE_TTL_MS = 30 * 60_000;

export function isIncompleteChainError(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const s = `${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? ""} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  return /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/i.test(s);
}

export interface LeafInfo {
  issuer: string;
  issuerUrls: string[];
}

export interface ChainDeps {
  readLeaf?: (host: string) => Promise<LeafInfo | null>;
  fetchIssuer?: (url: string) => Promise<Uint8Array | null>;
  roots?: readonly string[];
  now?: () => number;
}

let rootCache: X509Certificate[] | null = null;

function parsedRoots(pems?: readonly string[]): X509Certificate[] {
  if (pems) return pems.flatMap((p) => { try { return [new X509Certificate(p)]; } catch { return []; } });
  rootCache ??= tls.rootCertificates.flatMap((p) => { try { return [new X509Certificate(p)]; } catch { return []; } });
  return rootCache;
}

const MAX_HOPS = 3;

function issuedBy(child: X509Certificate, parent: X509Certificate): boolean {
  try { return child.checkIssued(parent) && child.verify(parent.publicKey); } catch { return false; }
}

/** A currently valid CA certificate whose subject is `subject`; null otherwise. */
function caCert(bytes: Uint8Array, subject: string, now: number): X509Certificate | null {
  let cert: X509Certificate;
  try { cert = new X509Certificate(Buffer.from(bytes)); } catch { return null; }
  if (!cert.ca || cert.subject !== subject) return null;
  if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) return null;
  return cert;
}

/** Issuer URLs a certificate names in its Authority Information Access extension (http/https only). */
function aiaIssuerUrls(cert: X509Certificate): string[] {
  return (cert.infoAccess ?? "").split("\n").map((l) => /^CA Issuers - URI:(\S+)$/.exec(l.trim())?.[1] ?? "").filter((u) => /^https?:\/\//i.test(u)).slice(0, 3);
}

/** The intermediate as PEM when it may complete the leaf's chain in one hop (see module notes); null otherwise. */
export function acceptIntermediate(leafIssuer: string, bytes: Uint8Array, opts: { roots?: readonly string[]; now?: number } = {}): string | null {
  const cert = caCert(bytes, leafIssuer, opts.now ?? Date.now());
  return cert && parsedRoots(opts.roots).some((r) => issuedBy(cert, r)) ? cert.toString() : null;
}

/**
 * Walk issuer certificates from the leaf's AIA URL (each one's own AIA URL next) until one is issued by a trusted root,
 * at most MAX_HOPS. Every certificate must be a valid CA named as the previous one's issuer and must have signed it.
 * Returns the intermediates as PEM, or null when no trusted path was found.
 */
export async function resolveChain(leaf: LeafInfo, fetchIssuer: (url: string) => Promise<Uint8Array | null>, opts: { roots?: readonly string[]; now?: number } = {}): Promise<string[] | null> {
  const roots = parsedRoots(opts.roots);
  const now = opts.now ?? Date.now();
  const chain: X509Certificate[] = [];
  let subject = leaf.issuer;
  let urls = leaf.issuerUrls.slice(0, 3);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let next: X509Certificate | null = null;
    for (const url of urls) {
      const bytes = await fetchIssuer(url);
      const cert = bytes ? caCert(bytes, subject, now) : null;
      const prev = chain[chain.length - 1];
      if (cert && (!prev || issuedBy(prev, cert))) { next = cert; break; }
    }
    if (!next) return null;
    const found = next;
    chain.push(found);
    if (roots.some((r) => issuedBy(found, r))) return chain.map((c) => c.toString());
    subject = found.issuer;
    urls = aiaIssuerUrls(found);
  }
  return null;
}

function defaultReadLeaf(host: string): Promise<LeafInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: LeafInfo | null) => { if (!settled) { settled = true; resolve(v); } };
    // Verification is off only to read the certificate the server presents; no request is sent on this connection.
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT }, () => {
      try {
        const peer = socket.getPeerCertificate(false);
        const issuer = peer?.raw ? new X509Certificate(peer.raw).issuer : "";
        const urls = (peer?.infoAccess?.["CA Issuers - URI"] ?? []).filter((u) => /^https?:\/\//i.test(u));
        done(issuer ? { issuer, issuerUrls: urls.slice(0, 3) } : null);
      } catch {
        done(null);
      } finally {
        socket.destroy();
      }
    });
    socket.setTimeout(ISSUER_TIMEOUT_MS, () => { socket.destroy(); done(null); });
    socket.on("error", () => done(null));
  });
}

async function defaultFetchIssuer(url: string): Promise<Uint8Array | null> {
  try {
    const r = await safeFetch(url, { method: "GET" }, { name: "official:aia", allowedSchemes: ["http:", "https:"], maxBytes: ISSUER_MAX_BYTES, timeoutMs: ISSUER_TIMEOUT_MS, maxRedirects: 2 });
    return r.ok ? r.body : null;
  } catch {
    return null;
  }
}

const agents = new Map<string, { agent: https.Agent | null; at: number }>();
const pending = new Map<string, Promise<https.Agent | null>>();

/** The agent already known for a host whose chain was completed, if any. */
export function knownChainAgent(host: string): https.Agent | null {
  return agents.get(host)?.agent ?? null;
}

/** Complete the host's chain once (concurrent callers share the attempt); null when it cannot be completed. */
export function completeChain(host: string, deps: ChainDeps = {}): Promise<https.Agent | null> {
  const now = deps.now ?? Date.now;
  const known = agents.get(host);
  if (known && (known.agent || now() - known.at < NEGATIVE_TTL_MS)) return Promise.resolve(known.agent);
  let p = pending.get(host);
  if (!p) {
    p = (async () => {
      const leaf = await (deps.readLeaf ?? defaultReadLeaf)(host);
      const pems = leaf ? await resolveChain(leaf, deps.fetchIssuer ?? defaultFetchIssuer, { roots: deps.roots, now: now() }) : null;
      const agent = pems?.length ? new https.Agent({ ca: [...(deps.roots ?? tls.rootCertificates), ...pems], keepAlive: false, secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT }) : null;
      agents.set(host, { agent, at: now() });
      return agent;
    })().finally(() => pending.delete(host));
    pending.set(host, p);
  }
  return p;
}

export function resetChainCacheForTests(): void {
  agents.clear();
  pending.clear();
}
