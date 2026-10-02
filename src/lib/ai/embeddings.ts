import "server-only";
import { AIConfigError } from "./config";
import { getRegistry } from "./providers/registry";
import { InferenceError, type EmbedOptions } from "./providers/types";
import { routeModel } from "./router";

export interface EmbedTextsOptions {
  model?: string;
  signal?: AbortSignal;
  /** Asymmetric embedding models (Cohere) distinguish indexed documents from search queries. */
  inputType?: EmbedOptions["inputType"];
  /** Output dimensions for models that support shortening (OpenAI text-embedding-3, Titan v2, Cohere v4). */
  dimensions?: number;
}

/** Embed texts with the configured embedding provider (OpenAI or Bedrock Titan/Cohere). Batched by the provider. */
export async function embedTexts(texts: string[], opts: EmbedTextsOptions = {}): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const reg = getRegistry();
  let decision;
  try {
    decision = routeModel({ taskType: "embed", role: "embedding", privacy: "internal", explicitModel: opts.model }, { available: reg.models, preferred: reg.preferred, allowExternalForMatterData: reg.allowExternalForMatterData });
  } catch (e) {
    if (e instanceof InferenceError && (e.code === "not_configured" || e.code === "capability_unavailable")) throw new AIConfigError(`Embeddings are not configured (${e.message})`);
    throw e;
  }
  const provider = reg.providers.get(decision.provider);
  if (!provider?.embed) throw new AIConfigError(`Provider ${decision.provider} cannot embed text.`);
  return provider.embed(texts, { model: decision.model, signal: opts.signal, inputType: opts.inputType ?? "document", ...(opts.dimensions ? { dimensions: opts.dimensions } : {}) });
}

export async function embedText(text: string, opts: EmbedTextsOptions = {}) {
  return (await embedTexts([text], { inputType: "query", ...opts }))[0];
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Sentence-aware chunking with overlap; sizes are in characters (~4 chars per token). */
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): string[] {
  const size = opts.size ?? 1600;
  const overlap = opts.overlap ?? 200;
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const sentences = clean.split(/(?<=[.!?])\s+|\n{2,}/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + " " + s).length > size && cur) {
      chunks.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlap)) + " " + s;
    } else {
      cur += (cur ? " " : "") + s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

export function float32ToBuffer(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function bufferToFloat32(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
