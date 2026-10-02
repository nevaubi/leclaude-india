/**
 * Deterministic entity-name stubs. Adapters call these to fill
 * `IntelDocument.meta.entities` with cleaned names (judges, attorneys, firms,
 * parties, products, agencies, courts); the analysis layer resolves them to
 * `intel_entities` records. Client-safe, no I/O.
 */
import type { IntelEntityMention, IntelEntityType } from "./types";

const HONORIFICS = /^(?:the\s+)?(?:hon\.?|honorable|judge|justice|chief\s+judge|magistrate\s+judge|senior\s+judge|u\.s\.\s+district\s+judge|district\s+judge|mr\.?|ms\.?|mrs\.?|dr\.?)\s+/i;
const SUFFIX = /,?\s+(?:jr\.?|sr\.?|ii|iii|iv|esq\.?|p\.?c\.?|llp|llc|pllc|l\.?l\.?p\.?)\s*$/i;

export function cleanPersonName(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(HONORIFICS, "");
  s = s.replace(/\s*\((?:presiding|assigned|referral|magistrate)[^)]*\)\s*$/i, "");
  s = s.replace(/\s*,\s*(?:U\.?S\.?D\.?J\.?|USMJ|U\.?S\.?M\.?J\.?)\s*$/i, "");
  s = s.replace(SUFFIX, (m) => (/(?:jr|sr|ii|iii|iv)/i.test(m) ? m.replace(/^,?\s+/, " ").replace(/\.$/, "") : ""));
  return s.trim();
}

export function cleanFirmName(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/^(?:law\s+offices?\s+of\s+)/i, "").trim();
}

/** Normalized alias key: lowercase, punctuation-free, single spaces. */
export function canonicalKey(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function mention(type: IntelEntityType, name: string, extra: Partial<Omit<IntelEntityMention, "type" | "name">> = {}): IntelEntityMention | null {
  const cleaned = type === "judge" || type === "attorney" || type === "expert" ? cleanPersonName(name) : type === "firm" ? cleanFirmName(name) : name.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 160) return null;
  return { type, name: cleaned, ...extra };
}

/** De-duplicate mentions by (type, canonical name). */
export function dedupeMentions(list: (IntelEntityMention | null | undefined)[]): IntelEntityMention[] {
  const seen = new Set<string>();
  const out: IntelEntityMention[] = [];
  for (const m of list) {
    if (!m) continue;
    const k = `${m.type}|${canonicalKey(m.name)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out.slice(0, 60);
}

/** "Baron & Budd, P.C. (Scott Summy)" → firm + attorney; "Michael A. London, Douglas & London" → attorney + firm. */
export function mentionsFromCounselString(s: string): IntelEntityMention[] {
  const out: (IntelEntityMention | null)[] = [];
  const paren = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    out.push(mention("firm", paren[1]));
    for (const n of paren[2].split(/,|;|&(?=\s+[A-Z])/)) out.push(mention("attorney", n));
    return dedupeMentions(out);
  }
  const parts = s.split(/,\s*(?=[A-Z])/);
  if (parts.length >= 2 && /(?:LLP|LLC|PLLC|P\.C\.|PC|Law|Associates|& )/i.test(parts.slice(1).join(","))) {
    out.push(mention("attorney", parts[0]));
    out.push(mention("firm", parts.slice(1).join(", ")));
  } else out.push(mention(/(?:LLP|LLC|PLLC|P\.C\.|Law\b|Associates|Group)/i.test(s) ? "firm" : "attorney", s));
  return dedupeMentions(out);
}

/** Split a CourtListener "judge" field ("Rodgers; Margaret Catharine Rodgers") into judge mentions. */
export function mentionsFromJudgeField(field: string | undefined | null): IntelEntityMention[] {
  if (!field) return [];
  return dedupeMentions(field.split(/;|,\s+and\s+|\s+and\s+|\//).map((n) => mention("judge", n)));
}

/** Parties from a caption: "Smith v. Acme Corp." → two party mentions. */
export function mentionsFromCaption(caseName: string | undefined | null): IntelEntityMention[] {
  if (!caseName) return [];
  const cleaned = caseName.replace(/^in re:?\s*/i, "").replace(/\s+/g, " ").trim();
  const sides = cleaned.split(/\s+v(?:s)?\.\s+/i);
  const out: (IntelEntityMention | null)[] = [];
  sides.slice(0, 2).forEach((side, i) => {
    const first = side.split(/,\s*|;\s*|\s+et al\.?/)[0];
    if (first) out.push(mention("party", first, { role: sides.length > 1 ? (i === 0 ? "plaintiff" : "defendant") : "subject" }));
  });
  return dedupeMentions(out);
}

/** Court name → mention with a stable external id when we know the CourtListener id. */
export function courtMention(name: string | undefined, courtId?: string): IntelEntityMention | null {
  if (!name && !courtId) return null;
  return mention("court", name ?? courtId!, courtId ? { externalId: `cl:court:${courtId}` } : {});
}

/** CourtListener court ids for the districts our matters live in and their long names. */
export const COURT_NAMES: Record<string, string> = {
  dsc: "U.S. District Court for the District of South Carolina",
  flnd: "U.S. District Court for the Northern District of Florida",
  cand: "U.S. District Court for the Northern District of California",
  nysd: "U.S. District Court for the Southern District of New York",
  ilnd: "U.S. District Court for the Northern District of Illinois",
  ohnd: "U.S. District Court for the Northern District of Ohio",
  ca4: "U.S. Court of Appeals for the Fourth Circuit",
  ca11: "U.S. Court of Appeals for the Eleventh Circuit",
  ca9: "U.S. Court of Appeals for the Ninth Circuit",
  scotus: "Supreme Court of the United States",
  jpml: "Judicial Panel on Multidistrict Litigation",
};

/** Map a long court name (as on a Matter) to a CourtListener id, when known. */
export function courtIdFromName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  const table: [RegExp, string][] = [
    [/district of south carolina/, "dsc"],
    [/northern district of florida/, "flnd"],
    [/middle district of florida/, "flmd"],
    [/southern district of florida/, "flsd"],
    [/northern district of california/, "cand"],
    [/central district of california/, "cacd"],
    [/southern district of new york/, "nysd"],
    [/eastern district of new york/, "nyed"],
    [/northern district of illinois/, "ilnd"],
    [/southern district of illinois/, "ilsd"],
    [/northern district of ohio/, "ohnd"],
    [/southern district of ohio/, "ohsd"],
    [/district of new jersey/, "njd"],
    [/district of delaware/, "ded"],
    [/eastern district of pennsylvania/, "paed"],
    [/district of arizona/, "azd"],
    [/western district of missouri/, "mowd"],
    [/northern district of texas/, "txnd"],
    [/western district of north carolina/, "ncwd"],
    [/fourth circuit/, "ca4"],
    [/eleventh circuit/, "ca11"],
    [/ninth circuit/, "ca9"],
    [/supreme court of the united states/, "scotus"],
    [/judicial panel on multidistrict/, "jpml"],
  ];
  for (const [re, id] of table) if (re.test(n)) return id;
  return undefined;
}

/** Jurisdiction label from a court id ("Federal · 4th Cir." style used across the platform). */
export function jurisdictionForCourt(courtId: string | undefined): string | undefined {
  if (!courtId) return undefined;
  const circuits: Record<string, string> = { dsc: "4th Cir.", dnc: "4th Cir.", dmd: "4th Cir.", vaed: "4th Cir.", ca4: "4th Cir.", flnd: "11th Cir.", flmd: "11th Cir.", flsd: "11th Cir.", gand: "11th Cir.", alnd: "11th Cir.", ca11: "11th Cir.", cand: "9th Cir.", cacd: "9th Cir.", casd: "9th Cir.", caed: "9th Cir.", azd: "9th Cir.", ca9: "9th Cir.", nysd: "2d Cir.", nyed: "2d Cir.", ca2: "2d Cir.", ilnd: "7th Cir.", ilsd: "7th Cir.", ca7: "7th Cir.", ohnd: "6th Cir.", ohsd: "6th Cir.", ca6: "6th Cir.", njd: "3d Cir.", ded: "3d Cir.", paed: "3d Cir.", ca3: "3d Cir.", mowd: "8th Cir.", ca8: "8th Cir.", txnd: "5th Cir.", ca5: "5th Cir.", ncwd: "4th Cir.", scotus: "U.S.", jpml: "U.S." };
  const c = circuits[courtId];
  return c ? `Federal · ${c}` : "Federal";
}
