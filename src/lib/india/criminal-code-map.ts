/**
 * IPC → BNS, CrPC → BNSS, Indian Evidence Act → BSA correspondence (client-safe, deterministic).
 *
 * The three new codes came into force on 1 July 2024. Which code governs is decided by dates in code
 * (`applicableCode`), never by a model.
 *
 * Mapping data: the official BPR&D (Ministry of Home Affairs) correspondence tables, loaded as DATA from
 * `./concordance` (parsed from the publisher's PDFs; every row keeps its page, verbatim cells and verification state).
 * The hand-coded rows below (`IPC_TO_BNS`, `CRPC_TO_BNSS`, `IEA_TO_BSA`) predate the data and are kept as a
 * cross-check and as sub-section refinements: a coded row that agrees with the official table at section level is
 * `official_cross_checked`; one the official table does not contain is `coded_unconfirmed` (medium confidence); one
 * that disagrees is reported as a conflict and the official row wins. A section absent from both is "unmapped" —
 * never approximated. Where one old section corresponds to several new provisions every candidate is returned and the
 * result is "split"; the caller must choose on the facts.
 */
import { compareIso, isValidIsoDate, type IsoDate } from "./holidays";
import { baseSection, concordanceCitation, concordanceTable, rowsForNew, rowsForOld, TABLE_FOR_OLD, type ConcordanceRow, type ConcordanceVerification } from "./concordance";

export type OldCode = "IPC" | "CrPC" | "IEA";
export type NewCode = "BNS" | "BNSS" | "BSA";
export type CodeName = OldCode | NewCode;

export const NEW_CODES_IN_FORCE: IsoDate = "2024-07-01";

export const SUCCESSOR: Record<OldCode, NewCode> = { IPC: "BNS", CrPC: "BNSS", IEA: "BSA" };
export const PREDECESSOR: Record<NewCode, OldCode> = { BNS: "IPC", BNSS: "CrPC", BSA: "IEA" };

/** How a mapping row is backed: see the module comment. */
export type MappingVerification = ConcordanceVerification | "coded_unconfirmed" | "conflicts_official";

export interface Correspondence {
  from: { code: OldCode; section: string };
  to: { section: string; note?: string }[];
  subject: string;
  note?: string;
  confidence: "high" | "medium";
  /** Where the row comes from (the coded table) and how the official table backs it. */
  source?: string;
  verification?: MappingVerification;
  /** Official rows that back (or contradict) it. */
  officialRowIds?: string[];
}

const SRC = "MHA/BPRD correspondence tables (2024), loaded as data from the official BPR&D documents; verify against the Gazette text";
export const CORRESPONDENCE_SOURCE = SRC;
const CODED_SRC = "Hand-coded correspondence row (maintainers), cross-checked against the BPR&D tables";

type Row = [section: string, to: (string | [string, string])[], subject: string, note?: string, confidence?: "high" | "medium"];

function rows(code: OldCode, list: Row[]): Correspondence[] {
  return list.map(([section, to, subject, note, confidence]) => {
    const targets = to.map((t) => (Array.isArray(t) ? { section: t[0], note: t[1] } : { section: t }));
    const check = crossCheck(code, section, targets.map((t) => t.section));
    return {
      from: { code, section },
      to: targets,
      subject,
      note,
      confidence: confidence ?? "high",
      source: CODED_SRC,
      verification: check.verification,
      officialRowIds: check.rows.map((r) => r.id),
    };
  });
}

const newBases = (rs: ConcordanceRow[]) => [...new Set(rs.flatMap((r) => r.newSections.map((x) => baseSection(x.section))))].sort();

/** How the official table backs a coded old → new row: same new section(s) at section level, absent, or different. */
function crossCheck(code: OldCode, section: string, targets: string[]): { verification: MappingVerification; rows: ConcordanceRow[] } {
  const l = rowsForOld(code, section);
  // Exact, or the official row printed at section level for a coded sub-section ("156(3)" against "156").
  const usable = l.match === "exact" || l.match === "base" ? l.rows : [];
  if (!usable.length) return { verification: "coded_unconfirmed", rows: [] };
  const a = newBases(usable).join(",");
  const b = [...new Set(targets.map(baseSection))].sort().join(",");
  return { verification: a === b ? "official_cross_checked" : "conflicts_official", rows: usable };
}

export const IPC_TO_BNS: Correspondence[] = rows("IPC", [
  ["34", ["3(5)"], "Acts done by several persons in furtherance of common intention"],
  ["107", ["45"], "Abetment of a thing", undefined, "medium"],
  ["109", ["49"], "Punishment of abetment where act abetted is committed", undefined, "medium"],
  ["120A", ["61(1)"], "Definition of criminal conspiracy"],
  ["120B", ["61(2)"], "Punishment of criminal conspiracy"],
  ["147", ["191(2)"], "Rioting"],
  ["148", ["191(3)"], "Rioting, armed with deadly weapon"],
  ["149", ["190"], "Every member of unlawful assembly guilty of offence committed in prosecution of common object"],
  ["201", ["238"], "Causing disappearance of evidence of offence"],
  ["294", ["296"], "Obscene acts and songs"],
  ["302", ["103(1)"], "Punishment for murder", "BNS 103(2) (murder by a group on specified grounds) has no IPC counterpart."],
  ["304", ["105"], "Culpable homicide not amounting to murder"],
  ["304A", ["106(1)"], "Causing death by negligence"],
  ["304B", ["80"], "Dowry death"],
  ["306", ["108"], "Abetment of suicide"],
  ["307", ["109"], "Attempt to murder"],
  ["323", ["115(2)"], "Voluntarily causing hurt"],
  ["324", ["118(1)"], "Voluntarily causing hurt by dangerous weapons or means"],
  ["325", ["117(2)"], "Voluntarily causing grievous hurt"],
  ["326", ["118(2)"], "Voluntarily causing grievous hurt by dangerous weapons or means"],
  ["341", ["126(2)"], "Wrongful restraint"],
  ["342", ["127(2)"], "Wrongful confinement"],
  ["354", ["74"], "Assault or criminal force to woman with intent to outrage her modesty"],
  ["354A", ["75"], "Sexual harassment"],
  ["354B", ["76"], "Assault or use of criminal force to woman with intent to disrobe"],
  ["354C", ["77"], "Voyeurism"],
  ["354D", ["78"], "Stalking"],
  ["363", ["137(2)"], "Punishment for kidnapping"],
  ["366", ["87"], "Kidnapping, abducting or inducing woman to compel her marriage, etc."],
  ["376", ["64"], "Punishment for rape"],
  ["376D", ["70(1)"], "Gang rape"],
  ["379", ["303(2)"], "Punishment for theft"],
  ["380", ["305"], "Theft in dwelling house, etc.", "Clause of BNS 305 depends on the place of theft.", "medium"],
  ["392", ["309(4)"], "Punishment for robbery"],
  ["395", ["310(2)"], "Punishment for dacoity"],
  ["406", ["316(2)"], "Punishment for criminal breach of trust"],
  ["409", ["316(5)"], "Criminal breach of trust by public servant, banker, merchant or agent"],
  ["415", ["318(1)"], "Cheating (definition)"],
  ["417", ["318(2)"], "Punishment for cheating"],
  ["418", ["318(3)"], "Cheating with knowledge that wrongful loss may ensue to person whose interest offender is bound to protect"],
  ["420", ["318(4)"], "Cheating and dishonestly inducing delivery of property"],
  ["447", ["329(3)"], "Punishment for criminal trespass", undefined, "medium"],
  ["448", ["329(4)"], "Punishment for house-trespass", undefined, "medium"],
  ["463", ["336(1)"], "Forgery (definition)"],
  ["465", ["336(2)"], "Punishment for forgery"],
  ["467", ["338"], "Forgery of valuable security, will, etc."],
  ["468", ["336(3)"], "Forgery for purpose of cheating"],
  ["471", ["340(2)"], "Using as genuine a forged document or electronic record"],
  ["498A", [["85", "punishment"], ["86", "definition of cruelty"]], "Husband or relative of husband of a woman subjecting her to cruelty", "IPC 498A (offence and its Explanation defining cruelty) is split between BNS 85 and 86."],
  ["499", ["356(1)"], "Defamation (definition)"],
  ["500", ["356(2)"], "Punishment for defamation"],
  ["506", [["351(2)", "criminal intimidation"], ["351(3)", "threat to cause death or grievous hurt, etc."]], "Punishment for criminal intimidation", "IPC 506 has two limbs; BNS 351(2) and 351(3) correspond to them respectively."],
  ["509", ["79"], "Word, gesture or act intended to insult the modesty of a woman"],
  ["511", ["62"], "Punishment for attempting to commit offences punishable with imprisonment for life or other imprisonment"],
]);

export const CRPC_TO_BNSS: Correspondence[] = rows("CrPC", [
  ["41", ["35"], "When police may arrest without warrant"],
  ["41A", ["35(3)"], "Notice of appearance before police officer"],
  ["91", ["94"], "Summons to produce document or other thing"],
  ["107", ["126"], "Security for keeping the peace in other cases", undefined, "medium"],
  ["125", ["144"], "Order for maintenance of wives, children and parents"],
  ["144", ["163"], "Power to issue order in urgent cases of nuisance or apprehended danger"],
  ["154", ["173"], "Information in cognizable cases (FIR)", "BNSS 173 adds e-FIR and preliminary enquiry provisions without CrPC counterpart."],
  ["156(3)", ["175(3)"], "Magistrate's power to order investigation"],
  ["161", ["180"], "Examination of witnesses by police"],
  ["164", ["183"], "Recording of confessions and statements"],
  ["167", ["187"], "Procedure when investigation cannot be completed in twenty-four hours"],
  ["173", ["193"], "Report of police officer on completion of investigation"],
  ["190", ["210"], "Cognizance of offences by Magistrates"],
  ["197", ["218"], "Prosecution of Judges and public servants"],
  ["200", ["223"], "Examination of complainant"],
  ["202", ["225"], "Postponement of issue of process"],
  ["204", ["227"], "Issue of process"],
  ["207", ["230"], "Supply to the accused of copy of police report and other documents"],
  ["227", ["250"], "Discharge (sessions trial)"],
  ["228", ["251"], "Framing of charge (sessions trial)"],
  ["239", ["262"], "When accused shall be discharged (warrant case on police report)"],
  ["311", ["348"], "Power to summon material witness, or examine person present"],
  ["313", ["351"], "Power to examine the accused"],
  ["319", ["358"], "Power to proceed against other persons appearing to be guilty of offence"],
  ["320", ["359"], "Compounding of offences"],
  ["357", ["395"], "Order to pay compensation"],
  ["357A", ["396"], "Victim compensation scheme"],
  ["374", ["415"], "Appeals from convictions"],
  ["378", ["419"], "Appeal in case of acquittal"],
  ["397", ["438"], "Calling for records to exercise powers of revision"],
  ["401", ["442"], "High Court's powers of revision"],
  ["406", ["446"], "Power of Supreme Court to transfer cases and appeals"],
  ["407", ["447"], "Power of High Court to transfer cases and appeals"],
  ["436", ["478"], "In what cases bail to be taken"],
  ["436A", ["479"], "Maximum period for which an undertrial prisoner can be detained"],
  ["437", ["480"], "When bail may be taken in case of non-bailable offence"],
  ["438", ["482"], "Direction for grant of bail to person apprehending arrest (anticipatory bail)"],
  ["439", ["483"], "Special powers of High Court or Court of Session regarding bail"],
  ["468", ["514"], "Bar to taking cognizance after lapse of the period of limitation"],
  ["482", ["528"], "Saving of inherent powers of High Court"],
]);

export const IEA_TO_BSA: Correspondence[] = rows("IEA", [
  ["3", ["2"], "Interpretation clause (definitions)"],
  ["8", ["6"], "Motive, preparation and previous or subsequent conduct"],
  ["24", ["22"], "Confession caused by inducement, threat or promise"],
  ["25", ["23(1)"], "Confession to police officer not to be proved"],
  ["26", ["23(2)"], "Confession by accused while in custody of police not to be proved against him"],
  ["27", [["23(2)", "proviso"]], "How much of information received from accused may be proved", "IEA 27 is the proviso to BSA 23(2)."],
  ["30", ["24"], "Consideration of proved confession affecting person making it and others jointly under trial"],
  ["32", ["26"], "Statements by persons who cannot be called as witnesses (incl. dying declaration)"],
  ["45", ["39"], "Opinions of experts"],
  ["65A", ["62"], "Special provisions as to evidence relating to electronic record"],
  ["65B", ["63"], "Admissibility of electronic records", "BSA 63 requires the certificate in the form in the Schedule."],
  ["101", ["104"], "Burden of proof"],
  ["106", ["109"], "Burden of proving fact especially within knowledge"],
  ["113A", ["117"], "Presumption as to abetment of suicide by a married woman"],
  ["113B", ["118"], "Presumption as to dowry death"],
  ["114", ["119"], "Court may presume existence of certain facts"],
  ["114A", ["120"], "Presumption as to absence of consent in certain prosecutions for rape"],
  ["118", ["124"], "Who may testify"],
  ["133", ["138"], "Accomplice"],
  ["137", ["142"], "Examination-in-chief, cross-examination and re-examination"],
  ["145", ["148"], "Cross-examination as to previous statements in writing"],
  ["154", ["157"], "Question by party to his own witness (hostile witness)"],
  ["165", ["168"], "Judge's power to put questions or order production"],
]);

export const CORRESPONDENCE: Correspondence[] = [...IPC_TO_BNS, ...CRPC_TO_BNSS, ...IEA_TO_BSA];

/** "498-A" → "498A", "3 (5)" → "3(5)", "S. 302" → "302". */
export function normalizeCodeSection(s: string): string {
  return s.trim().replace(/^(?:sections?|secs?\.?|ss?\.|u\/s\.?)\s*/i, "").replace(/\s+/g, "").replace(/^(\d+)-([A-Za-z])/, "$1$2").replace(/^(\d+)([a-z]{1,2})(?=$|\()/, (_m, n: string, l: string) => `${n}${l.toUpperCase()}`);
}

const base = (s: string) => s.replace(/\(.*$/, "");

export interface MapCandidate { code: CodeName; section: string; note?: string }

/** One official row behind a mapping (for display and audit). */
export interface OfficialRowRef {
  id: string;
  page: number;
  newRaw: string;
  oldRaw: string;
  subject: string;
  flags: string[];
  verification: ConcordanceVerification;
}

export interface MapResult {
  query: { code: CodeName; section: string };
  direction: "old_to_new" | "new_to_old";
  status: "mapped" | "split" | "unmapped";
  candidates: MapCandidate[];
  subject?: string;
  notes: string[];
  confidence?: "high" | "medium";
  source: string;
  /** How the answer is backed (official table, cross-checked, or the coded table only). */
  verification?: MappingVerification;
  /** True when the official table maps at a different level of detail than asked (section vs sub-section, a part such
   *  as an Explanation or proviso), so the answer covers only part of the provision. */
  partial?: boolean;
  /** The official table marks the queried new provision as new (no counterpart in the old code). */
  newProvision?: boolean;
  /** Official rows consulted, including rows that could not be read reliably (flagged, never used to map). */
  official?: OfficialRowRef[];
  /** The official document, when it was consulted. */
  officialSource?: { title: string; publisher: string; url: string };
}

const rowRef = (r: ConcordanceRow): OfficialRowRef => ({ id: r.id, page: r.page, newRaw: r.newRaw, oldRaw: r.oldRaw, subject: r.subject, flags: r.flags, verification: r.verification });

function blockedNote(code: CodeName, sec: string, rs: ConcordanceRow[]): string | null {
  if (!rs.length) return null;
  const pages = [...new Set(rs.map((r) => r.page))].join(", ");
  return `The official table has a row for ${code} ${sec} (p. ${pages}) that could not be read reliably (${[...new Set(rs.flatMap((r) => r.flags))].join(", ")}); it is not used. Check the PDF.`;
}

function dedupe(c: MapCandidate[]): MapCandidate[] {
  const seen = new Set<string>();
  return c.filter((x) => (seen.has(`${x.code}|${x.section}`) ? false : (seen.add(`${x.code}|${x.section}`), true)));
}

/**
 * Map a section between an old code and its successor (either direction). Returns every candidate; a split is never
 * collapsed to one. A section absent from the data is "unmapped" — callers must consult the Gazette text.
 *
 * Old → new: the official BPR&D rows for the section (exact, then its base section "302(1)" → "302", flagged as
 * partial). When the hand-coded row agrees at section level, its sub-section detail and notes are used
 * (official_cross_checked); when it disagrees, the official row wins and the disagreement is noted; when the official
 * table has no usable row, the coded row is used as coded_unconfirmed (medium confidence).
 * New → old: official rows for the section (exact, else every sub-section of it: "BNS 318" → IPC 415, 417, 418, 420)
 * plus coded rows that the official table cross-checks.
 */
export function mapSection(code: CodeName, section: string): MapResult {
  const sec = normalizeCodeSection(section);
  const isOld = code === "IPC" || code === "CrPC" || code === "IEA";
  const notes: string[] = [];
  const t = concordanceTable(isOld ? TABLE_FOR_OLD[code as OldCode] : TABLE_FOR_OLD[PREDECESSOR[code as NewCode]]);
  const officialSource = { title: t.source.title, publisher: t.source.publisher, url: t.source.url };
  const source = `${SRC}: ${concordanceCitation(t)}`;
  if (isOld) {
    const target = SUCCESSOR[code as OldCode];
    const table = CORRESPONDENCE.filter((r) => r.from.code === code);
    let hit = table.find((r) => r.from.section === sec);
    let hitViaBase = false;
    if (!hit && sec !== base(sec)) { hit = table.find((r) => r.from.section === base(sec)); hitViaBase = Boolean(hit); }
    const off = rowsForOld(code as OldCode, sec);
    const official = [...off.rows, ...off.blocked].map(rowRef);
    const bn = blockedNote(code, sec, off.blocked);
    // The note is the part the table names: on the old side ("4, para 3" → "para 3") or the new ("Proviso to section 23").
    const oldPart = (r: ConcordanceRow) => r.oldSections.find((x) => x.section === sec || x.section === base(sec) || base(x.section) === sec)?.part;
    const offCands = dedupe(off.rows.flatMap((r) => r.newSections.map((x) => { const note = oldPart(r) ?? x.part; return { code: target as CodeName, section: x.section, ...(note ? { note } : {}) }; })));
    if (offCands.length) {
      const agree = hit && hit.verification === "official_cross_checked" && newBases(off.rows).join(",") === [...new Set(hit.to.map((x) => base(x.section)))].sort().join(",");
      let candidates: MapCandidate[];
      let verification: MappingVerification;
      let confidence: "high" | "medium";
      if ((agree && hitViaBase) || (!agree && off.match === "base")) notes.push(`No row for ${code} ${sec}; mapped from ${code} ${base(sec)} — confirm the sub-section.`);
      if (hit && agree) {
        candidates = hit.to.map((x) => ({ code: target, section: x.section, note: x.note }));
        verification = "official_cross_checked";
        confidence = hit.confidence;
        if (hit.note) notes.push(hit.note);
      } else {
        candidates = offCands;
        verification = "official_parsed";
        confidence = "medium";
        notes.push(`Read from the official correspondence table (p. ${[...new Set(off.rows.map((r) => r.page))].join(", ")}); not yet cross-checked by hand.`);
        if (hit) notes.push(`The hand-coded table maps ${code} ${hit.from.section} to ${hit.to.map((x) => `${target} ${x.section}`).join(" and ")}; the official table differs and is used.`);
      }
      if (bn) notes.push(bn);
      const partial = (agree ? hitViaBase : off.match !== "exact") || off.rows.some((r) => r.oldSections.some((x) => x.part) || r.newSections.some((x) => x.part));
      if (partial && off.match === "exact") notes.push("The official table maps only part of the provision (an Explanation, proviso or paragraph); read both texts.");
      return {
        query: { code, section: sec }, direction: "old_to_new",
        status: candidates.length > 1 ? "split" : "mapped",
        candidates, subject: hit?.subject ?? (off.rows.length === 1 ? off.rows[0].subject : undefined),
        notes, confidence, source, verification, partial, official, officialSource,
      };
    }
    if (!hit) {
      return { query: { code, section: sec }, direction: "old_to_new", status: "unmapped", candidates: [], notes: [`${code} ${sec} is not in the official correspondence table or the coded table; consult the ${target} text.`, ...(bn ? [bn] : [])], source, official, officialSource };
    }
    if (hitViaBase) notes.push(`No row for ${code} ${sec}; mapped from ${code} ${base(sec)} — confirm the sub-section.`);
    if (hit.note) notes.push(hit.note);
    notes.push("From the hand-coded table only: the official table has no usable row for this section.");
    if (bn) notes.push(bn);
    return {
      query: { code, section: sec }, direction: "old_to_new",
      status: hit.to.length > 1 ? "split" : "mapped",
      candidates: hit.to.map((x) => ({ code: target, section: x.section, note: x.note })),
      subject: hit.subject, notes, confidence: "medium", source, verification: "coded_unconfirmed", partial: hitViaBase, official, officialSource,
    };
  }
  const old = PREDECESSOR[code as NewCode];
  const table = CORRESPONDENCE.filter((r) => r.from.code === old);
  let hits = table.filter((r) => r.to.some((x) => x.section === sec));
  if (!hits.length) hits = table.filter((r) => r.to.some((x) => base(x.section) === base(sec)));
  const off = rowsForNew(code as NewCode, sec);
  const official = [...off.rows, ...off.blocked].map(rowRef);
  const bn = blockedNote(code, sec, off.blocked);
  if (off.rows.length) {
    if (off.match === "children" || off.match === "base") notes.push(`No row for ${code} ${sec} exactly; showing every ${old} provision mapped into ${code} ${base(sec)}.`);
    const corr = off.rows.filter((r) => r.relation === "corresponds");
    let candidates = dedupe(corr.flatMap((r) => r.oldSections.map((x) => ({ code: old as CodeName, section: x.section, ...(x.part ? { note: x.part } : {}) }))));
    // Coded rows the official table cross-checks add their (finer) pairs: "BSA 23(2)" ← IEA 26 and IEA 27 (proviso).
    // Only coded rows for this very provision (exact) unless the official rows were matched at section level.
    const scoped = off.match === "exact" ? hits.filter((h) => h.to.some((x) => x.section === sec)) : hits;
    const checked = scoped.filter((h) => h.verification === "official_cross_checked");
    for (const h of checked) {
      const note = h.to.find((x) => x.section === sec)?.note;
      if (!candidates.some((c) => c.section === h.from.section)) candidates.push({ code: old, section: h.from.section, ...(note ? { note } : {}) });
      else if (note) candidates = candidates.map((c) => (c.section === h.from.section ? { ...c, note } : c));
    }
    for (const h of scoped.filter((x) => x.verification === "conflicts_official")) notes.push(`The hand-coded table maps ${old} ${h.from.section} here; the official table maps it elsewhere, so it is not listed.`);
    if (bn) notes.push(bn);
    if (!candidates.length) {
      const isNew = off.rows.every((r) => r.relation === "new");
      return {
        query: { code, section: sec }, direction: "new_to_old", status: "unmapped", candidates: [],
        notes: [...notes, isNew ? `The official correspondence table marks ${code} ${sec} as a new provision with no ${old} counterpart (p. ${off.rows[0].page}).` : `The official table names no ${old} provision for ${code} ${sec}.`],
        source, verification: "official_parsed", newProvision: isNew || undefined, official, officialSource,
      };
    }
    const allChecked = candidates.every((c) => checked.some((h) => h.from.section === c.section));
    if (!allChecked) notes.push(`Read from the official correspondence table (p. ${[...new Set(off.rows.map((r) => r.page))].join(", ")}); not every row is cross-checked by hand.`);
    for (const h of checked) if (h.note) notes.push(h.note);
    const partial = off.match !== "exact" || off.rows.some((r) => r.oldSections.some((x) => x.part) || r.newSections.some((x) => x.part));
    return {
      query: { code, section: sec }, direction: "new_to_old",
      status: candidates.length > 1 ? "split" : "mapped",
      candidates,
      subject: off.rows.length === 1 ? off.rows[0].subject : checked.length === 1 && candidates.length === 1 ? checked[0].subject : undefined,
      notes,
      confidence: allChecked && !checked.some((h) => h.confidence === "medium") ? "high" : "medium",
      source, verification: allChecked ? "official_cross_checked" : "official_parsed", partial, official, officialSource,
    };
  }
  if (!hits.length) return { query: { code, section: sec }, direction: "new_to_old", status: "unmapped", candidates: [], notes: [`${code} ${sec} is not in the official correspondence table or the coded table; it may be a new provision.`, ...(bn ? [bn] : [])], source, official, officialSource };
  if (hits.some((h) => !h.to.some((x) => x.section === sec))) notes.push(`No row for ${code} ${sec} exactly; showing every ${old} provision mapped into ${code} ${base(sec)}.`);
  for (const h of hits) if (h.note) notes.push(h.note);
  notes.push("From the hand-coded table only: the official table has no usable row for this section.");
  if (bn) notes.push(bn);
  return {
    query: { code, section: sec }, direction: "new_to_old",
    status: hits.length > 1 ? "split" : "mapped",
    candidates: hits.map((h) => ({ code: old, section: h.from.section, note: h.to.find((x) => x.section === sec)?.note })),
    subject: hits.length === 1 ? hits[0].subject : undefined,
    notes, confidence: "medium", source, verification: "coded_unconfirmed", official, officialSource,
  };
}

export interface ApplicableCode {
  /** Substantive offence law, decided by the date of the offence. */
  substantive: "IPC" | "BNS" | "requires_review";
  /** Procedure, decided by when the proceeding (investigation/inquiry/trial) was initiated, when that date is given. */
  procedure?: "CrPC" | "BNSS" | "requires_review";
  notes: string[];
}

/**
 * Which code applies. Offences committed before 1 July 2024 remain governed by the IPC (Constitution Art. 20(1):
 * no conviction under a law not in force when the act was done); offences on or after that date by the BNS.
 * A continuing offence spanning the boundary, or a missing/invalid date, is "requires_review" — never defaulted.
 *
 * Procedure: BNSS s.531(2)(a) saves proceedings pending immediately before 1 July 2024 under the CrPC. When the
 * proceeding was initiated on or after that date for an earlier offence, the answer is BNSS with a review note,
 * because the application of s.531 to such cases has been litigated.
 */
export function applicableCode(offenceDate: IsoDate | { from: IsoDate; to: IsoDate } | null | undefined, opts: { proceedingInitiated?: IsoDate } = {}): ApplicableCode {
  const notes: string[] = [];
  let substantive: ApplicableCode["substantive"];
  if (!offenceDate) { substantive = "requires_review"; notes.push("Date of offence not given; the governing code cannot be determined."); }
  else if (typeof offenceDate === "string") {
    if (!isValidIsoDate(offenceDate)) { substantive = "requires_review"; notes.push(`Invalid date of offence "${offenceDate}" (expected YYYY-MM-DD).`); }
    else substantive = compareIso(offenceDate, NEW_CODES_IN_FORCE) < 0 ? "IPC" : "BNS";
  } else {
    const { from, to } = offenceDate;
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || compareIso(from, to) > 0) { substantive = "requires_review"; notes.push("Invalid offence date range."); }
    else if (compareIso(to, NEW_CODES_IN_FORCE) < 0) substantive = "IPC";
    else if (compareIso(from, NEW_CODES_IN_FORCE) >= 0) substantive = "BNS";
    else { substantive = "requires_review"; notes.push("The offence period spans 1 July 2024; acts before that date fall under the IPC and acts from that date under the BNS. Review the charge on the facts."); }
  }
  if (substantive === "IPC") notes.push("Offence before 1 July 2024: Indian Penal Code, 1860 applies.");
  if (substantive === "BNS") notes.push("Offence on or after 1 July 2024: Bharatiya Nyaya Sanhita, 2023 applies.");

  let procedure: ApplicableCode["procedure"];
  if (opts.proceedingInitiated !== undefined) {
    const p = opts.proceedingInitiated;
    if (!isValidIsoDate(p)) { procedure = "requires_review"; notes.push(`Invalid proceeding date "${p}".`); }
    else if (compareIso(p, NEW_CODES_IN_FORCE) < 0) { procedure = "CrPC"; notes.push("Proceeding pending before 1 July 2024: continues under the CrPC (BNSS s.531(2)(a))."); }
    else {
      procedure = "BNSS";
      notes.push("Proceeding initiated on or after 1 July 2024: BNSS procedure.");
      if (substantive !== "BNS") notes.push("Offence predates the BNSS while the proceeding postdates it: confirm the procedural code against current authority on BNSS s.531 before filing.");
    }
  }
  return { substantive, procedure, notes };
}

/** Evidence law follows the proceeding: IEA for proceedings pending before 1 July 2024 (BSA s.170 repeal and savings), BSA otherwise. Always flagged for review when it differs from the offence code. */
export function applicableEvidenceCode(proceedingInitiated: IsoDate | null | undefined): { code: "IEA" | "BSA" | "requires_review"; note: string } {
  if (!proceedingInitiated || !isValidIsoDate(proceedingInitiated)) return { code: "requires_review", note: "Date the proceeding was initiated is required." };
  return compareIso(proceedingInitiated, NEW_CODES_IN_FORCE) < 0
    ? { code: "IEA", note: "Proceeding pending before 1 July 2024; confirm under BSA s.170 (repeal and savings)." }
    : { code: "BSA", note: "Proceeding initiated on or after 1 July 2024." };
}
