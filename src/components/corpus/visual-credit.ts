/**
 * Credit lines for the visual library (pure, client-safe). Every image shown carries its credit: author, licence and
 * source for photographs; the publisher for logos. Links are only http(s).
 */
import { creditLine, type Visual } from "@/modules/media/visuals-types";

/** "Photo: Jane Doe · CC BY-SA 4.0 · Wikimedia Commons" / "Logo: Reserve Bank of India". */
export function creditLabel(v: Pick<Visual, "kind" | "credit">): string {
  if (v.kind === "regulator_logo") return `Logo: ${v.credit.sourceName || v.credit.license}`;
  const line = creditLine(v);
  return line ? `Photo: ${line}` : "Photo";
}

export function safeLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The dominant colour is used only as a placeholder background; anything but #rrggbb is ignored. */
export function placeholderColor(v: Pick<Visual, "dominant"> | null | undefined): string | undefined {
  return v?.dominant && /^#[0-9a-f]{6}$/i.test(v.dominant) ? v.dominant : undefined;
}
