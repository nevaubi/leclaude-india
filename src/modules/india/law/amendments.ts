/**
 * India Code section footnotes → amendment history (pure, deterministic; no I/O).
 *
 * India Code (DSpace) publishes each section's editorial footnotes in `dc.identifier.section_footnote` as
 *   <sup>1</sup>. Subs. by Act 28 of 2018, s. 3 for sub-section <i>(1)</i> (w.e.f. 3-5-2018).<br/><hr/>
 *   <sup>2</sup>. Subs. by s. 6, <i>ibid</i>., for the proviso (w.e.f. 3-5-2018).
 * (verified on the Commercial Courts Act, 2015, 2026-10-02). Every footnote is kept verbatim (`text`); the fields read
 * from it (action, amending Act, section, w.e.f. date) are filled only when printed. "ibid" takes the amending Act of
 * the previous footnote, and says so (`actFromIbid`). Nothing else is inferred.
 */
import { htmlParagraphs } from "@/modules/india/sources/parse-util";

export type AmendmentAction = "substituted" | "inserted" | "omitted" | "repealed" | "renumbered" | "added" | "amended" | "other";

export interface SectionAmendment {
  /** Footnote number as printed (matches the <sup>n</sup> marker in the section text). */
  marker: number;
  action: AmendmentAction;
  /** "Act 28 of 2018" / "Ord. 1 of 2024" as printed (or carried from the previous footnote for "ibid"). */
  amendingAct: string | null;
  amendingActNumber: number | null;
  amendingActYear: number | null;
  /** True when the amending Act came from the previous footnote ("ibid"). */
  actFromIbid: boolean;
  /** Provision of the amending Act ("s. 3", "s. 95 and the fifth Schedule"). */
  amendingProvision: string | null;
  /** w.e.f. date (ISO) when printed and valid. */
  withEffectFrom: string | null;
  /** The footnote, as plain text, verbatim. */
  text: string;
}

const ACTION: [RegExp, AmendmentAction][] = [
  [/^subs(?:tituted)?\b\.?/i, "substituted"],
  [/^ins(?:erted)?\b\.?/i, "inserted"],
  [/^rep(?:ealed)?\b\.?/i, "repealed"],
  [/^added\b|^\badd\.\s/i, "added"],
  [/^omitted\b|\bomitted by\b/i, "omitted"],
  [/\bre-?numbered\b/i, "renumbered"],
  [/^amended\b|\bamended by\b/i, "amended"],
];

/** "3-5-2018" / "31- 10-2019" → ISO, or null. */
export function wefDate(text: string): string | null {
  const m = /w\.\s*e\.\s*f\.?\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{4})/i.exec(text);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Split the footnote HTML at its <sup>n</sup> markers and read each one. */
export function parseSectionFootnotes(html: string | null | undefined): SectionAmendment[] {
  if (!html) return [];
  const parts = html.split(/<sup>\s*(\d{1,3})\s*<\/sup>\s*\.?/i);
  const out: SectionAmendment[] = [];
  let prevAct: { text: string; n: number | null; y: number | null } | null = null;
  for (let i = 1; i < parts.length; i += 2) {
    const marker = Number(parts[i]);
    const text = htmlParagraphs(parts[i + 1] ?? "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const action = ACTION.find(([re]) => re.test(text))?.[1] ?? "other";
    const am = /\b((?:Act|Ord(?:inance)?\.?|Regulation)\s+(\d{1,4})\s+of\s+(\d{4}))/i.exec(text);
    let amendingAct: string | null = null, n: number | null = null, y: number | null = null, actFromIbid = false;
    if (am) { amendingAct = am[1].replace(/\s+/g, " "); n = Number(am[2]); y = Number(am[3]); }
    else if (/\bibid\b/i.test(text) && prevAct) { amendingAct = prevAct.text; n = prevAct.n; y = prevAct.y; actFromIbid = true; }
    if (amendingAct && !actFromIbid) prevAct = { text: amendingAct, n, y };
    const prov = /\b(ss?\.\s*[\dA-Z]+(?:\s*(?:,|and|to)\s*[\dA-Z]+)*(?:\s+and\s+the\s+[a-z]+\s+Schedule)?)/.exec(text);
    out.push({ marker, action, amendingAct, amendingActNumber: n, amendingActYear: y, actFromIbid, amendingProvision: prov ? prov[1].replace(/\s+/g, " ") : null, withEffectFrom: wefDate(text), text });
  }
  return out;
}

/** One-line label: "Substituted by Act 28 of 2018, s. 3 (w.e.f. 3 May 2018)". */
export function amendmentLabel(a: SectionAmendment): string {
  const verb = { substituted: "Substituted", inserted: "Inserted", omitted: "Omitted", repealed: "Repealed", renumbered: "Renumbered", added: "Added", amended: "Amended", other: "Amended" }[a.action];
  const by = a.amendingAct ? ` by ${a.amendingAct}${a.amendingProvision ? `, ${a.amendingProvision}` : ""}` : "";
  const wef = a.withEffectFrom ? ` (w.e.f. ${new Date(`${a.withEffectFrom}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })})` : "";
  return `${verb}${by}${wef}`;
}
