/**
 * Deterministic text helpers shared by the India source parsers (pure; no server imports, safe in tests).
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", shy: "", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", dagger: "†", Dagger: "‡", sect: "§", para: "¶", middot: "·", bull: "•", rupee: "₹" };

export function decodeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML fragment → single-spaced text. Block-level tags become spaces; nothing is inferred. */
export function htmlText(html: string | undefined | null): string {
  if (!html) return "";
  return decodeHtml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** HTML fragment → text keeping paragraph breaks (for statute text). */
export function htmlParagraphs(html: string | undefined | null): string {
  if (!html) return "";
  const s = html.replace(/<(br|hr)\b[^>]*>/gi, "\n").replace(/<\/(p|div|li|tr|h\d|center)>/gi, "\n").replace(/<[^>]+>/g, " ");
  return decodeHtml(s).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** "25-09-2024" / "1-7-2024" / "2024-09-25" → "2024-09-25"; anything else → undefined (never guessed). */
export function isoDate(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (match) { y = +match[1]; m = +match[2]; d = +match[3]; }
  else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) { d = +match[1]; m = +match[2]; y = +match[3]; }
  else return undefined;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1800 || y > 2200) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

/** Split "A versus B" / "A Vs B" / "A v. B" into parties. Returns nothing when the separator is absent or ambiguous. */
export function splitParties(title: string): { petitioner?: string; respondent?: string } {
  const parts = title.split(/\s+(?:versus|vs\.?|v\.)\s+/i);
  if (parts.length !== 2) return {};
  // Trailing separators the portals leave on party names ("M/s X, Vs Y,") are trimmed; nothing else is changed.
  const [a, b] = parts.map((p) => p.replace(/\s+/g, " ").trim().replace(/[,;:]+$/, "").trim());
  return a && b ? { petitioner: a, respondent: b } : {};
}

/** Neutral citation "2024INSC735" / "2024 INSC 735" → "2024 INSC 735"; HC form "2024:KHC-D:7336" is kept as is. */
export function normalizeNeutral(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/\s+/g, " ").trim();
  const sc = /^(\d{4})\s*INSC\s*(\d+)$/i.exec(s);
  if (sc) return `${sc[1]} INSC ${Number(sc[2])}`;
  const hc = /^(\d{4}):([A-Z]+(?:-[A-Z]+)?):(\d+)$/.exec(s);
  if (hc) return `${hc[1]}:${hc[2]}:${Number(hc[3])}`;
  return undefined;
}

/** Find HC neutral citations ("2024:KHC-D:7336") whose court prefix is one of `prefixes` (registry-controlled). */
export function findHcNeutral(text: string, prefixes: string[]): string | undefined {
  if (!prefixes.length) return undefined;
  for (const m of text.matchAll(/\b(\d{4}):([A-Z]+)(-[A-Z]+)?:(\d{1,7})\b/g)) {
    if (prefixes.includes(m[2])) return `${m[1]}:${m[2]}${m[3] ?? ""}:${Number(m[4])}`;
  }
  return undefined;
}

/** Collapse whitespace; empty → undefined. */
export function clean(s: string | undefined | null): string | undefined {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t || undefined;
}
