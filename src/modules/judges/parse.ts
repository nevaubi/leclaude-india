/**
 * Roster parsers (pure). Input is the Markdown rendering of an official "Chief Justice and sitting judges" page (as
 * Firecrawl returns it); output is one entry per judge with only what the page printed. A field the page does not
 * print is null; nothing is inferred (no designation from position, no retirement date from a birth date).
 */
import { cleanJudgeName, normalizeJudgeName } from "./names";
import type { RosterParser } from "./sources";

export interface RosterEntry {
  /** The name exactly as the page printed it (with honorifics). */
  printedName: string;
  /** The printed name without honorifics, titles or "J." (kept in the page's own spelling and case). */
  name: string;
  nameNormalized: string;
  designation: string | null;
  dateOfAppointment: string | null;
  retirementDate: string | null;
  /** Additional judges: date their present term expires (as printed). */
  termExpires: string | null;
  profileUrl: string | null;
  photoUrl: string | null;
}

export interface RosterParseResult {
  entries: RosterEntry[];
  /** Facts about the parse that are not errors (duplicates dropped, images without names). */
  notes: string[];
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** "24-05-2019" / "24/05/2019" / "24.05.2019" → "2019-05-24"; anything else (incl. "NA") → null. */
export function rosterDate(s: string | null | undefined): string | null {
  const m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s ?? "");
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return dt.getUTCDate() === d ? iso : null;
}

function absUrl(u: string | null | undefined, base: string): string | null {
  if (!u) return null;
  try {
    const url = new URL(u.replace(/\\/g, ""), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function stripMd(s: string): string {
  return s.replace(/\\\n/g, " ").replace(/[*_#`]/g, "").replace(/\\/g, "").replace(/\s+/g, " ").trim();
}

function entry(printed: string, fields: Partial<RosterEntry>): RosterEntry | null {
  const printedName = stripMd(printed);
  const name = cleanJudgeName(printedName);
  const nameNormalized = normalizeJudgeName(printedName);
  if (!nameNormalized || nameNormalized.length < 3 || !/[A-Z]{2}/.test(nameNormalized)) return null;
  return {
    printedName, name, nameNormalized,
    designation: fields.designation ?? null, dateOfAppointment: fields.dateOfAppointment ?? null, retirementDate: fields.retirementDate ?? null,
    termExpires: fields.termExpires ?? null, profileUrl: fields.profileUrl ?? null, photoUrl: fields.photoUrl ?? null,
  };
}

/** Split Markdown at every image: [{ alt, src, text-after-image-until-next-image, index }]. */
function imageSegments(md: string): { alt: string; src: string; text: string; index: number }[] {
  const hits = [...md.matchAll(IMAGE_RE)];
  return hits.map((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < hits.length ? hits[i + 1].index! : md.length;
    return { alt: m[1], src: m[2], text: md.slice(start, end), index: m.index! };
  });
}

function dedupe(entries: RosterEntry[], notes: string[]): RosterEntry[] {
  const seen = new Set<string>();
  const out: RosterEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.nameNormalized)) { notes.push(`Duplicate entry for ${e.printedName} ignored`); continue; }
    seen.add(e.nameNormalized);
    out.push(e);
  }
  return out;
}

/** Supreme Court of India: "Hon'ble **Justice X**", "(DoA) dd-mm-yyyy to (DoR) dd-mm-yyyy", "[View Profile](…)". */
export function parseSciRoster(md: string, pageUrl: string): RosterParseResult {
  const notes: string[] = [];
  const out: RosterEntry[] = [];
  for (const seg of imageSegments(md)) {
    const nm = /Hon['’]ble\s+\*\*([^*]+)\*\*/i.exec(seg.text);
    if (!nm) continue;
    const term = /\(DoA\)[\s*]*(\d{1,2}-\d{1,2}-\d{4})[\s*]*to[\s*]*\(DoR\)[\s*]*(\d{1,2}-\d{1,2}-\d{4})/i.exec(seg.text);
    const profile = /\[View Profile\]\((https?:\/\/[^)\s]+)/i.exec(seg.text)?.[1];
    const isCji = /\n\s*Chief Justice of India\s*\n/i.test(seg.text.slice(nm.index));
    const e = entry(nm[1], {
      designation: isCji ? "Chief Justice of India" : "Judge",
      dateOfAppointment: rosterDate(term?.[1]), retirementDate: rosterDate(term?.[2]),
      profileUrl: absUrl(profile, pageUrl), photoUrl: absUrl(seg.src, pageUrl),
    });
    if (e) out.push(e);
  }
  return { entries: dedupe(out, notes), notes };
}

/**
 * Photograph cards (Telangana, Delhi): `[![alt](photo) … **NAME**](profile)` or `[![NAME](photo)](profile)` followed
 * by `[NAME](profile)`. The printed name comes from the card's bold text or heading, else its link text, else the
 * image's alt text. Only cards whose printed name contains "Justice" are judges.
 */
export function parseCardRoster(md: string, pageUrl: string, opts: { designations: boolean }): RosterParseResult {
  const notes: string[] = [];
  const out: RosterEntry[] = [];
  for (const seg of imageSegments(md)) {
    const text = seg.text;
    const bold = /\*\*([^*]+)\*\*/.exec(text)?.[1];
    const heading = /^#{2,6}\s+(.+)$/m.exec(text)?.[1];
    const linkText = /\[([^\]![]{3,})\]\(https?:[^)\s]+\)/.exec(text)?.[1];
    const alt = seg.alt.replace(/^Icon for\s+/i, "");
    const printed = [bold, heading, linkText, alt].map((v) => (v ? stripMd(v) : "")).find((v) => /justice/i.test(v))
      ?? (/^Icon for\s+/i.test(seg.alt) ? alt : null);
    if (!printed) continue;
    // The card's own link closes right after the image (no other link opens before it).
    const own = /^[^[\]]*?\]\((https?:\/\/[^)\s]+)\)/.exec(text)?.[1];
    const profile = own ?? (linkText ? /\[[^\]![]{3,}\]\((https?:[^)\s]+)\)/.exec(text)?.[1] : undefined);
    const designation = !opts.designations ? null : /chief\s+justice/i.test(printed) ? "Chief Justice" : /justice/i.test(printed) ? "Judge" : null;
    const e = entry(printed, { designation, profileUrl: absUrl(profile, pageUrl), photoUrl: absUrl(seg.src, pageUrl) });
    if (e) out.push(e);
  }
  return { entries: dedupe(out, notes), notes };
}

function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

/**
 * Markdown tables (Bombay "List View"): a header row naming Photo / Name / Date of Appointment / Date of Retirement /
 * Date of Expiry of Present Term; the line before the table labels the section ("HON'BLE JUDGES", "ADDITIONAL JUDGES").
 */
export function parseTableRoster(md: string, pageUrl: string, opts: { designations: boolean }): RosterParseResult {
  const notes: string[] = [];
  const out: RosterEntry[] = [];
  const lines = md.split("\n");
  let header: string[] | null = null;
  let section = "";
  let lastText = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      header = null;
      if (line) lastText = line;
      continue;
    }
    const c = cells(line);
    if (!header) {
      if (c.some((x) => /^name$/i.test(x))) { header = c.map((x) => x.toLowerCase()); section = lastText; }
      continue;
    }
    if (c.every((x) => /^:?-{3,}:?$/.test(x))) continue;
    const col = (re: RegExp) => header!.findIndex((h) => re.test(h));
    const nameCell = c[col(/^name$/)] ?? "";
    const link = /\[([^\]]+)\]\((https?:[^)\s]+)\)/.exec(nameCell);
    const printed = link?.[1] ?? nameCell;
    const photoCell = c[col(/photo/)] ?? "";
    const photo = [...photoCell.matchAll(IMAGE_RE)][0]?.[2];
    const appt = col(/date of (initial )?appointment/);
    const ret = col(/date of retirement/);
    const exp = col(/expiry of present term/);
    const additional = /additional/i.test(section);
    const designation = !opts.designations ? null : /chief\s+justice/i.test(nameCell) ? "Chief Justice" : additional ? "Additional Judge" : "Judge";
    const e = entry(printed, {
      designation,
      dateOfAppointment: appt >= 0 ? rosterDate(c[appt]) : null,
      retirementDate: ret >= 0 ? rosterDate(c[ret]) : null,
      termExpires: exp >= 0 ? rosterDate(c[exp]) : null,
      profileUrl: absUrl(link?.[2], pageUrl), photoUrl: absUrl(photo, pageUrl),
    });
    if (e) out.push(e);
  }
  return { entries: dedupe(out, notes), notes };
}

/**
 * Andhra Pradesh: photo, then a small table with `**Sri Justice X**`, "Date of Appointment", "Date of Retirement" or
 * "Date of Expiry of Present Term". Entries before the "Hon'ble Judges" heading are under "Hon'ble The Chief Justice".
 */
export function parseApRoster(md: string, pageUrl: string): RosterParseResult {
  const notes: string[] = [];
  const out: RosterEntry[] = [];
  const cjAt = md.search(/#+\s*Hon['’]ble The Chief Justice/i);
  const judgesAt = md.search(/#+\s*Hon['’]ble Judges/i);
  for (const seg of imageSegments(md)) {
    const nm = /\|\s*\*\*([^*]*Justice[^*]*)\*\*\s*\|/i.exec(seg.text);
    if (!nm) continue;
    const field = (label: RegExp) => {
      const m = new RegExp(`\\|\\s*${label.source}\\s*\\|\\s*:?\\s*\\|?\\s*([^|\\n]*)\\|`, "i").exec(seg.text);
      return m ? rosterDate(m[1]) : null;
    };
    const underCj = cjAt >= 0 && seg.index > cjAt && (judgesAt < 0 || seg.index < judgesAt);
    const e = entry(nm[1], {
      designation: underCj ? "Chief Justice" : judgesAt >= 0 && seg.index > judgesAt ? "Judge" : null,
      dateOfAppointment: field(/Date of Appointment/), retirementDate: field(/Date of Retirement/), termExpires: field(/Date of Expiry of Present Term/),
      profileUrl: pageUrl, photoUrl: absUrl(seg.src, pageUrl),
    });
    if (e) out.push(e);
  }
  return { entries: dedupe(out, notes), notes };
}

/** One judge as returned by structured extraction (untrusted until guarded). */
export interface ExtractedJudge {
  name?: unknown;
  designation?: unknown;
  photo_url?: unknown;
  profile_url?: unknown;
  date_of_appointment?: unknown;
  date_of_retirement?: unknown;
}

export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    judges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The judge's name exactly as printed on the page, including honorifics" },
          designation: { type: "string", description: "Designation exactly as printed (e.g. Chief Justice), or empty" },
          photo_url: { type: "string", description: "The URL of this judge's photograph as it appears in the page, or empty" },
          profile_url: { type: "string", description: "The URL of this judge's profile page as linked on the page, or empty" },
          date_of_appointment: { type: "string", description: "Date of appointment exactly as printed, or empty" },
          date_of_retirement: { type: "string", description: "Date of retirement exactly as printed, or empty" },
        },
        required: ["name"],
      },
    },
  },
  required: ["judges"],
} as const;

/** `needle` appears in `hay` as whole words (not inside a longer word). */
function printedWord(hay: string, needle: string): boolean {
  if (!needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(hay);
}

// Apostrophe variants are one character for matching: rosters print "Hon`ble" and "Hon’ble", extractors return "Hon'ble".
// Markdown escapes ("Hon\\`ble") are unescaped first so the backslash does not split the word.
const squash = (s: string) => s.replace(/\\([`'*_#[\]()])/g, "$1").replace(/[`´‘’ʼ]/g, "'").replace(/[\s\\*_]+/g, " ").trim().toLowerCase();

/**
 * Guard structured extraction against invention: a judge is kept only when the printed name appears verbatim in the
 * page; a photo or profile URL only when that exact URL appears in the page (or its link list); a date only when
 * printed verbatim. Everything else becomes null.
 */
export function guardExtracted(items: ExtractedJudge[], md: string, pageUrl: string, links: string[] = []): RosterParseResult {
  const notes: string[] = [];
  const out: RosterEntry[] = [];
  const page = squash(md);
  const urls = new Set<string>([...md.matchAll(/\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]).concat(links));
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  for (const it of items) {
    const printed = str(it.name);
    if (!printed || printed.length > 160) continue;
    if (!page.includes(squash(printed))) { notes.push(`Extracted name "${printed.slice(0, 80)}" is not printed on the page; dropped`); continue; }
    const photo = str(it.photo_url);
    const profile = str(it.profile_url);
    const date = (v: unknown) => { const s = str(v); return s && md.includes(s) ? rosterDate(s) : null; };
    const designation = str(it.designation);
    const e = entry(printed, {
      designation: designation && printedWord(page, squash(designation)) ? designation : null,
      photoUrl: photo && urls.has(photo) ? absUrl(photo, pageUrl) : null,
      profileUrl: profile && urls.has(profile) ? absUrl(profile, pageUrl) : null,
      dateOfAppointment: date(it.date_of_appointment), retirementDate: date(it.date_of_retirement),
    });
    if (e) out.push(e);
  }
  return { entries: dedupe(out, notes), notes };
}

export function parseRoster(parser: Exclude<RosterParser, "extract">, md: string, pageUrl: string, opts: { designations: boolean }): RosterParseResult {
  switch (parser) {
    case "sci": return parseSciRoster(md, pageUrl);
    case "cards": return parseCardRoster(md, pageUrl, opts);
    case "table": return parseTableRoster(md, pageUrl, opts);
    case "aphc": return parseApRoster(md, pageUrl);
  }
}
