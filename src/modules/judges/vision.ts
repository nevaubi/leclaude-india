/**
 * Vision check for fetched images. The model only describes the image (kind, single person, placeholder); whether we
 * keep it is decided here, deterministically (`acceptVerdict`). A judge photograph must be a single-person portrait
 * that is not a placeholder; a court identity image must be an emblem, seal or logo.
 */
import type { VisionVerdict } from "@/modules/media/store";

export type VisionExpect = "portrait" | "emblem";

export const VISION_KINDS = ["portrait", "group_photo", "emblem", "logo", "building", "placeholder", "text_or_banner", "other"] as const;
export type VisionKind = (typeof VISION_KINDS)[number];

/** What the model reports (untrusted shape). */
export interface RawVision {
  kind?: unknown;
  single_person?: unknown;
  placeholder?: unknown;
  reason?: unknown;
  alt?: unknown;
}

export const VISION_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...VISION_KINDS] },
    single_person: { type: "boolean", description: "Exactly one person's face is the subject" },
    placeholder: { type: "boolean", description: "A generic silhouette, default avatar, blank or 'photo not available' image" },
    reason: { type: "string", description: "One short sentence on what the image shows" },
    alt: { type: "string", description: "Neutral alt text (no names), e.g. 'Portrait photograph of a judge in a black robe'" },
  },
  required: ["kind", "single_person", "placeholder", "reason", "alt"],
} as const;

export function visionPrompt(expect: VisionExpect): string {
  return expect === "portrait"
    ? "This image was published on an official court website next to a judge's name. Classify it: is it a photograph whose subject is exactly one person (a portrait), or a group photo, logo, emblem, building, placeholder silhouette, text/banner, or something else? Do not identify the person."
    : "This image was taken from the header of an official court website. Classify it: is it a court or State emblem/seal, a logo (emblem with the court's name), a building photograph, a portrait, text/banner, a placeholder, or something else?";
}

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Decide whether to keep an image from the model's description. Unknown or malformed output is rejected. */
export function acceptVerdict(expect: VisionExpect, raw: RawVision | null | undefined, model: string | null = null, now = new Date()): VisionVerdict {
  const kind = typeof raw?.kind === "string" && (VISION_KINDS as readonly string[]).includes(raw.kind) ? (raw.kind as VisionKind) : "other";
  const reason = str(raw?.reason) || "no description returned";
  const alt = str(raw?.alt, 200) || null;
  let ok = false;
  let why = reason;
  if (!raw || typeof raw !== "object") { why = "vision check returned no result"; }
  else if (expect === "portrait") {
    ok = kind === "portrait" && raw.single_person === true && raw.placeholder !== true;
    if (!ok) why = raw.placeholder === true ? `placeholder image: ${reason}` : raw.single_person !== true ? `not a single-person photograph: ${reason}` : `not a portrait (${kind}): ${reason}`;
  } else {
    ok = (kind === "emblem" || kind === "logo") && raw.placeholder !== true;
    if (!ok) why = `not an emblem or logo (${kind}): ${reason}`;
  }
  return { ok, kind, reason: why, alt, checkedAt: now.toISOString(), model };
}

/** Verdict recorded when no check could run (no model configured, provider error). The image is not used. */
export function uncheckedVerdict(reason: string, now = new Date()): VisionVerdict {
  return { ok: false, kind: "unchecked", reason, alt: null, checkedAt: now.toISOString(), model: null };
}
