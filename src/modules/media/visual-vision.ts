/**
 * Vision check for the visual library (court buildings, city landmarks, regulator logos) and for the re-audit of
 * stored court emblems. The model only describes the image; whether it is shown is decided here, deterministically.
 *
 * Policy (see visuals-types.ts): an image that shows the State Emblem of India (Lion Capital of Ashoka) is never shown,
 * whatever else is true of it. Watermarked or poor images are rejected. A building or landmark must be the subject
 * (no interiors, no people as the subject); a logo must be a logo (not a banner or a photograph).
 */
import type { VisionVerdict } from "./store";

/** Bump when the prompt or the facts asked for change, so stored verdicts are re-checked instead of reused. */
export const VISUAL_CHECK_VERSION = "visual-v1";

export type VisualExpect = "building" | "landmark" | "logo" | "emblem_audit";

export const VISUAL_KINDS = ["building", "landmark", "logo", "other"] as const;
export type VisualVisionKind = (typeof VISUAL_KINDS)[number];

/** What the model reports (untrusted shape). */
export interface RawVisualVision {
  kind?: unknown;
  contains_state_emblem?: unknown;
  has_watermark?: unknown;
  quality?: unknown;
  is_interior?: unknown;
  people_are_subject?: unknown;
  subject_match?: unknown;
  reason?: unknown;
  alt?: unknown;
}

export const VISUAL_VISION_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...VISUAL_KINDS], description: "building: a photograph whose subject is a building's exterior; landmark: a monument, bridge, skyline or other city landmark; logo: an organisation's logo, seal or emblem as a graphic; other: anything else (banner, map, diagram, document, portrait, crowd, interior)" },
    contains_state_emblem: { type: "boolean", description: "True if the State Emblem of India appears anywhere in the image: the Lion Capital of Ashoka (three visible lions on an abacus with a wheel/Dharma Chakra, often with 'Satyameva Jayate'), including small, stylised or partial versions inside a logo or seal" },
    has_watermark: { type: "boolean", description: "A visible watermark, stock-photo mark, or overlaid text/credit that is not part of the scene" },
    quality: { type: "integer", description: "From 1 to 5: 1 = unusable (blurred, tiny, badly cropped), 3 = acceptable, 5 = excellent" },
    is_interior: { type: "boolean", description: "The photograph is taken inside a building" },
    people_are_subject: { type: "boolean", description: "People (a person, a group or a crowd) are the main subject rather than the building or place" },
    subject_match: { type: "string", enum: ["yes", "no", "unsure"], description: "Whether the image plausibly shows the expected subject named in the prompt" },
    reason: { type: "string", description: "One short sentence on what the image shows" },
    alt: { type: "string", description: "Neutral alt text describing what is visible (no people's names)" },
  },
  required: ["kind", "contains_state_emblem", "has_watermark", "quality", "is_interior", "people_are_subject", "subject_match", "reason", "alt"],
} as const;

export function visualVisionPrompt(expect: VisualExpect, subject: string): string {
  const emblem = "Look carefully for the State Emblem of India (the Lion Capital of Ashoka: lions on a round abacus with a wheel, often with 'Satyameva Jayate' below), even when it is small or part of a logo or seal.";
  switch (expect) {
    case "building":
      return `This image should be a photograph of the exterior of ${subject}. Describe it: what kind of image it is, whether it is an interior, whether people are the subject, whether it has a watermark, its quality, and whether it plausibly shows ${subject}. ${emblem}`;
    case "landmark":
      return `This image should be a photograph of ${subject}. Describe it: what kind of image it is, whether it is an interior, whether people are the subject, whether it has a watermark, its quality, and whether it plausibly shows ${subject}. ${emblem}`;
    case "logo":
      return `This image was taken from the official website of ${subject} and should be its logo. Describe it: is it a logo/seal graphic, or a banner, photograph, screenshot or something else? Does it have a watermark? Rate its quality as a logo. ${emblem}`;
    case "emblem_audit":
      return `This image is shown as the emblem or logo of ${subject}. Describe it. ${emblem}`;
  }
}

export interface VisualVerdict extends VisionVerdict {
  check: typeof VISUAL_CHECK_VERSION;
  expect: VisualExpect;
  containsStateEmblem: boolean;
  hasWatermark: boolean;
  quality: number;
  /** The model's facts, kept so a stored verdict can be re-decided for another expectation without a new call. */
  facts: {
    kind: VisualVisionKind;
    containsStateEmblem: boolean;
    hasWatermark: boolean;
    quality: number;
    isInterior: boolean;
    peopleAreSubject: boolean;
    subjectMatch: "yes" | "no" | "unsure";
    reason: string;
    alt: string | null;
  };
}

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Normalise untrusted model output into facts. Missing booleans that gate safety default to the unsafe-to-show side. */
export function visualFacts(raw: RawVisualVision | null | undefined): VisualVerdict["facts"] | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = typeof raw.kind === "string" && (VISUAL_KINDS as readonly string[]).includes(raw.kind) ? (raw.kind as VisualVisionKind) : "other";
  const q = typeof raw.quality === "number" && Number.isFinite(raw.quality) ? Math.max(1, Math.min(5, Math.round(raw.quality))) : 1;
  const sm = raw.subject_match === "yes" || raw.subject_match === "no" ? raw.subject_match : "unsure";
  return {
    kind,
    // Fail closed: anything but an explicit `false` counts as "may contain the State Emblem".
    containsStateEmblem: raw.contains_state_emblem !== false,
    hasWatermark: raw.has_watermark === true,
    quality: q,
    isInterior: raw.is_interior === true,
    peopleAreSubject: raw.people_are_subject === true,
    subjectMatch: sm,
    reason: str(raw.reason) || "no description returned",
    alt: str(raw.alt, 200) || null,
  };
}

/** Decide from the facts whether an image may be shown for `expect`. */
export function decideVisual(expect: VisualExpect, facts: VisualVerdict["facts"] | null, model: string | null = null, now = new Date()): VisualVerdict {
  const base = { check: VISUAL_CHECK_VERSION, expect, checkedAt: now.toISOString(), model } as const;
  if (!facts) {
    return { ...base, ok: false, kind: "other", reason: "vision check returned no result", alt: null, containsStateEmblem: true, hasWatermark: false, quality: 1, facts: { kind: "other", containsStateEmblem: true, hasWatermark: false, quality: 1, isInterior: false, peopleAreSubject: false, subjectMatch: "unsure", reason: "no result", alt: null } };
  }
  let ok = false;
  let why = facts.reason;
  if (facts.containsStateEmblem) why = `shows the State Emblem of India, which is never displayed: ${facts.reason}`;
  else if (expect === "emblem_audit") ok = true;
  else if (facts.hasWatermark) why = `watermarked: ${facts.reason}`;
  else if (facts.quality < 3) why = `quality ${facts.quality}/5 is too low: ${facts.reason}`;
  else if (expect === "logo") {
    ok = facts.kind === "logo";
    if (!ok) why = `not a logo (${facts.kind}): ${facts.reason}`;
  } else {
    const kindOk = expect === "building" ? facts.kind === "building" : facts.kind === "building" || facts.kind === "landmark";
    if (!kindOk) why = `not a ${expect} photograph (${facts.kind}): ${facts.reason}`;
    else if (facts.isInterior) why = `interior view: ${facts.reason}`;
    else if (facts.peopleAreSubject) why = `people are the subject: ${facts.reason}`;
    else if (facts.subjectMatch === "no") why = `does not show the expected subject: ${facts.reason}`;
    else ok = true;
  }
  return { ...base, ok, kind: facts.kind, reason: why, alt: facts.alt, containsStateEmblem: facts.containsStateEmblem, hasWatermark: facts.hasWatermark, quality: facts.quality, facts };
}

/** A stored verdict from this check (any expectation), whose facts can be re-decided; null for anything else. */
export function storedVisualFacts(v: unknown): VisualVerdict["facts"] | null {
  const x = v as Partial<VisualVerdict> | null;
  if (!x || typeof x !== "object" || x.check !== VISUAL_CHECK_VERSION || !x.facts || typeof x.facts !== "object") return null;
  return x.facts;
}
