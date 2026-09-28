/**
 * Limitation computations (client-safe, deterministic date math with an explanation trail).
 *
 * Limitation Act, 1963 conventions implemented:
 *   - s.12(1): the day from which the period is reckoned is excluded. A period of N days from D therefore ends on
 *     D + N; a period of N months/years ends on the corresponding date (end-of-month clamped).
 *   - s.12(2)/(3): for appeals, revisions and reviews, the day of the judgment is excluded (as above) and the time
 *     requisite for obtaining a certified copy is excluded when the copy was applied for within the period.
 *   - s.4: when the period expires on a day the court is closed, filing on the day it reopens is in time. This needs
 *     the court's notified calendar; without one the result says the adjustment was not checked.
 *   - s.5: appeals and applications (not suits; not applications under CPC Order XXI) may be admitted after the
 *     period on sufficient cause. Reported as `condonable`, never folded into the date.
 * Special laws apply ss.4–24 of the Limitation Act unless excluded (s.29(2)).
 *
 * Every computed step cites its provision. Anything the maintainers could not confirm is marked in `uncertain` and
 * the result's status becomes "requires_verification". A deadline is decision support: counsel verifies it.
 */
import { addDays, addMonths, addYears, compareIso, daysBetween, isValidIsoDate, nextOpenDay, type CourtCalendar, type IsoDate } from "./holidays";

export type PeriodUnit = "days" | "months" | "years";

export interface LimitationRule {
  id: string;
  title: string;
  /** Article / section that prescribes the period. */
  authority: string;
  period: { n: number; unit: PeriodUnit } | null;
  /** What the period runs from (plain words, from the provision). */
  runsFrom: string;
  proceeding: "suit" | "appeal" | "application" | "revision" | "review" | "complaint" | "petition";
  /** s.5 Limitation Act extension available. */
  condonable: boolean | "special";
  /** s.12(2) certified-copy exclusion applies. */
  copyExclusion: boolean;
  notes?: string[];
  /** Points the maintainers could not confirm; any entry makes results "requires_verification". */
  uncertain?: string[];
}

export const LIMITATION_RULES: LimitationRule[] = [
  { id: "art-113", title: "Suit for which no period is provided elsewhere", authority: "Limitation Act, 1963, Schedule, Art. 113", period: { n: 3, unit: "years" }, runsFrom: "when the right to sue accrues", proceeding: "suit", condonable: false, copyExclusion: false },
  { id: "art-55", title: "Compensation for breach of contract", authority: "Limitation Act, 1963, Schedule, Art. 55", period: { n: 3, unit: "years" }, runsFrom: "when the contract is broken (or, for successive breaches, when the breach in respect of which the suit is instituted occurs; for a continuing breach, when it ceases)", proceeding: "suit", condonable: false, copyExclusion: false },
  { id: "art-54", title: "Specific performance of a contract", authority: "Limitation Act, 1963, Schedule, Art. 54", period: { n: 3, unit: "years" }, runsFrom: "the date fixed for performance or, if no date is fixed, when the plaintiff has notice that performance is refused", proceeding: "suit", condonable: false, copyExclusion: false },
  { id: "art-58", title: "Declaration (any other declaration)", authority: "Limitation Act, 1963, Schedule, Art. 58", period: { n: 3, unit: "years" }, runsFrom: "when the right to sue first accrues", proceeding: "suit", condonable: false, copyExclusion: false },
  { id: "art-59", title: "Cancel or set aside an instrument or decree, or rescind a contract", authority: "Limitation Act, 1963, Schedule, Art. 59", period: { n: 3, unit: "years" }, runsFrom: "when the facts entitling the plaintiff to the relief first become known to him", proceeding: "suit", condonable: false, copyExclusion: false },
  { id: "art-19", title: "Money payable for money lent", authority: "Limitation Act, 1963, Schedule, Art. 19", period: { n: 3, unit: "years" }, runsFrom: "when the loan is made", proceeding: "suit", condonable: false, copyExclusion: false, notes: ["An acknowledgment in writing (s.18) or part-payment (s.19) before expiry starts a fresh period."] },
  { id: "art-64", title: "Possession of immovable property based on previous possession (not title)", authority: "Limitation Act, 1963, Schedule, Art. 64", period: { n: 12, unit: "years" }, runsFrom: "the date of dispossession", proceeding: "suit", condonable: false, copyExclusion: false },
  { id: "art-65", title: "Possession of immovable property based on title", authority: "Limitation Act, 1963, Schedule, Art. 65", period: { n: 12, unit: "years" }, runsFrom: "when the possession of the defendant becomes adverse to the plaintiff", proceeding: "suit", condonable: false, copyExclusion: false },
  { id: "art-116a", title: "Appeal under the CPC to a High Court", authority: "Limitation Act, 1963, Schedule, Art. 116(a)", period: { n: 90, unit: "days" }, runsFrom: "the date of the decree or order", proceeding: "appeal", condonable: true, copyExclusion: true },
  { id: "art-116b", title: "Appeal under the CPC to any other court", authority: "Limitation Act, 1963, Schedule, Art. 116(b)", period: { n: 30, unit: "days" }, runsFrom: "the date of the decree or order", proceeding: "appeal", condonable: true, copyExclusion: true },
  { id: "art-117", title: "Appeal from a decree or order of a High Court to the same court", authority: "Limitation Act, 1963, Schedule, Art. 117", period: { n: 30, unit: "days" }, runsFrom: "the date of the decree or order", proceeding: "appeal", condonable: true, copyExclusion: true, notes: ["Covers intra-court appeals (e.g. writ appeals) where no other period is prescribed; check the High Court's own Act/Rules."] },
  { id: "art-115-death", title: "Criminal appeal from a sentence of death", authority: "Limitation Act, 1963, Schedule, Art. 115(a)", period: { n: 30, unit: "days" }, runsFrom: "the date of the sentence", proceeding: "appeal", condonable: true, copyExclusion: true, uncertain: ["Art. 115 clause structure coded from memory of the Schedule; confirm before relying."] },
  { id: "art-115-hc", title: "Criminal appeal (other than from a death sentence) to a High Court", authority: "Limitation Act, 1963, Schedule, Art. 115(b)(i)", period: { n: 60, unit: "days" }, runsFrom: "the date of the sentence or order appealed from", proceeding: "appeal", condonable: true, copyExclusion: true, uncertain: ["Art. 115 clause structure coded from memory of the Schedule; confirm before relying."] },
  { id: "art-115-other", title: "Criminal appeal (other than from a death sentence) to any other court", authority: "Limitation Act, 1963, Schedule, Art. 115(b)(ii)", period: { n: 30, unit: "days" }, runsFrom: "the date of the sentence or order appealed from", proceeding: "appeal", condonable: true, copyExclusion: true, uncertain: ["Art. 115 clause structure coded from memory of the Schedule; confirm before relying."] },
  { id: "art-131", title: "Revision under the CPC or the CrPC", authority: "Limitation Act, 1963, Schedule, Art. 131", period: { n: 90, unit: "days" }, runsFrom: "the date of the decree, order or sentence sought to be revised", proceeding: "revision", condonable: true, copyExclusion: true },
  { id: "art-124", title: "Review of judgment by a court other than the Supreme Court", authority: "Limitation Act, 1963, Schedule, Art. 124", period: { n: 30, unit: "days" }, runsFrom: "the date of the decree or order", proceeding: "review", condonable: true, copyExclusion: true },
  { id: "art-123", title: "Set aside a decree passed ex parte", authority: "Limitation Act, 1963, Schedule, Art. 123", period: { n: 30, unit: "days" }, runsFrom: "the date of the decree or, where the summons was not duly served, when the applicant had knowledge of the decree", proceeding: "application", condonable: true, copyExclusion: false },
  { id: "art-136", title: "Execution of a decree (other than a decree granting a mandatory injunction)", authority: "Limitation Act, 1963, Schedule, Art. 136", period: { n: 12, unit: "years" }, runsFrom: "when the decree becomes enforceable", proceeding: "application", condonable: false, copyExclusion: false, notes: ["s.5 does not apply to applications under CPC Order XXI."] },
  { id: "art-137", title: "Application for which no period is provided elsewhere", authority: "Limitation Act, 1963, Schedule, Art. 137", period: { n: 3, unit: "years" }, runsFrom: "when the right to apply accrues", proceeding: "application", condonable: true, copyExclusion: false },
  { id: "sc-slp", title: "Special leave petition to the Supreme Court against a High Court judgment", authority: "Supreme Court Rules, 2013 (SLP limitation: 90 days)", period: { n: 90, unit: "days" }, runsFrom: "the date of the judgment or order sought to be appealed", proceeding: "petition", condonable: true, copyExclusion: true, uncertain: ["Order/rule number in the Supreme Court Rules, 2013 not coded; the 60-day period from refusal of a certificate under Art. 134A is not modelled."] },
  { id: "arb-34", title: "Application to set aside an arbitral award", authority: "Arbitration and Conciliation Act, 1996, s.34(3)", period: { n: 3, unit: "months" }, runsFrom: "the date the applicant received the arbitral award (or the disposal of a s.33 request)", proceeding: "application", condonable: "special", copyExclusion: false, notes: ["The court may allow a further 30 days on sufficient cause, \"but not thereafter\" (proviso to s.34(3)); s.5 Limitation Act does not apply."] },
  { id: "cpa-69", title: "Consumer complaint", authority: "Consumer Protection Act, 2019, s.69(1)", period: { n: 2, unit: "years" }, runsFrom: "the date on which the cause of action has arisen", proceeding: "complaint", condonable: "special", copyExclusion: false, notes: ["The Commission may entertain a complaint after the period on sufficient cause recorded in writing (s.69(2))."] },
  { id: "writ-226", title: "Writ petition under Article 226", authority: "Constitution of India, Art. 226", period: null, runsFrom: "no statutory period", proceeding: "petition", condonable: false, copyExclusion: false, notes: ["No period of limitation is prescribed; delay and laches are assessed by the court on the facts. Explain any delay in the petition."] },
];

const ruleById = new Map(LIMITATION_RULES.map((r) => [r.id, r]));
export function limitationRule(id: string): LimitationRule | null { return ruleById.get(id) ?? null; }

export interface LimitationStep { text: string; authority?: string; date?: IsoDate }

export interface LimitationResult {
  ruleId: string;
  title: string;
  status: "computed" | "no_fixed_period" | "requires_verification" | "invalid_input";
  startDate?: IsoDate;
  /** Last day of the prescribed period (after exclusions, before s.4). */
  lastDay?: IsoDate;
  /** Last day after the s.4 court-closed adjustment, when a calendar answered. */
  adjustedLastDay?: IsoDate;
  s4: "applied" | "not_needed" | "not_checked" | "calendar_unknown";
  excludedDays: number;
  condonable: boolean | "special";
  steps: LimitationStep[];
  uncertain: string[];
  notes: string[];
}

export interface LimitationInput {
  ruleId: string;
  /** Date the period runs from (decree, accrual, receipt of award…). */
  from: IsoDate;
  /** s.12(2): date the certified copy was applied for and the date it was ready for delivery. */
  certifiedCopy?: { appliedOn: IsoDate; readyOn: IsoDate };
  /** Court calendar for s.4. Sample calendars make the result "requires_verification". */
  calendar?: CourtCalendar;
}

function endOfPeriod(from: IsoDate, n: number, unit: PeriodUnit): IsoDate {
  return unit === "days" ? addDays(from, n) : unit === "months" ? addMonths(from, n) : addYears(from, n);
}

const unitLabel = (n: number, u: PeriodUnit) => `${n} ${n === 1 ? u.slice(0, -1) : u}`;

function applyS4(res: LimitationResult, cal: CourtCalendar | undefined) {
  if (!res.lastDay) return;
  if (!cal) {
    res.s4 = "not_checked";
    res.steps.push({ text: `If the court is closed on ${res.lastDay}, the filing may be made on the day it reopens. No court calendar supplied; not checked.`, authority: "Limitation Act, 1963, s.4" });
    return;
  }
  const next = nextOpenDay(res.lastDay, cal);
  if (next.date === null) {
    res.s4 = "calendar_unknown";
    res.steps.push({ text: `Court calendar "${cal.id}" cannot confirm whether the court sits on ${res.lastDay} (${next.unknown}).`, authority: "Limitation Act, 1963, s.4" });
    return;
  }
  if (next.date === res.lastDay) {
    res.s4 = "not_needed";
    res.adjustedLastDay = res.lastDay;
    res.steps.push({ text: `Court open on ${res.lastDay} per calendar "${cal.id}"; no s.4 extension.`, authority: "Limitation Act, 1963, s.4" });
  } else {
    res.s4 = "applied";
    res.adjustedLastDay = next.date;
    res.steps.push({ text: `Court closed on ${next.skipped.map((s) => `${s.date} (${s.reason})`).join(", ")}; filing on the reopening day ${next.date} is in time.`, authority: "Limitation Act, 1963, s.4", date: next.date });
  }
  if (cal.sample) res.uncertain.push(`Calendar "${cal.id}" is sample data, not the court's notified calendar.`);
}

/** Compute the last day for filing under a coded rule. */
export function computeLimitation(input: LimitationInput): LimitationResult {
  const rule = ruleById.get(input.ruleId);
  const res: LimitationResult = { ruleId: input.ruleId, title: rule?.title ?? input.ruleId, status: "computed", s4: "not_checked", excludedDays: 0, condonable: rule?.condonable ?? false, steps: [], uncertain: [...(rule?.uncertain ?? [])], notes: [...(rule?.notes ?? [])] };
  if (!rule) return { ...res, status: "invalid_input", notes: [`Unknown limitation rule "${input.ruleId}".`] };
  if (!isValidIsoDate(input.from)) return { ...res, status: "invalid_input", notes: [`Invalid start date "${input.from}" (expected YYYY-MM-DD).`] };
  res.startDate = input.from;
  if (!rule.period) {
    res.status = "no_fixed_period";
    res.s4 = "not_needed";
    res.steps.push({ text: "No fixed period of limitation.", authority: rule.authority });
    return res;
  }
  const { n, unit } = rule.period;
  let last = endOfPeriod(input.from, n, unit);
  res.steps.push({ text: `Period of ${unitLabel(n, unit)} runs from ${rule.runsFrom}: ${input.from}.`, authority: rule.authority, date: input.from });
  res.steps.push({ text: `The day ${input.from} is excluded; the period ends on ${last}.`, authority: "Limitation Act, 1963, s.12(1)", date: last });

  if (input.certifiedCopy) {
    const { appliedOn, readyOn } = input.certifiedCopy;
    if (!rule.copyExclusion) res.notes.push("Certified-copy time is excluded only for appeals, revisions and reviews (s.12(2)); ignored for this rule.");
    else if (!isValidIsoDate(appliedOn) || !isValidIsoDate(readyOn) || compareIso(readyOn, appliedOn) < 0) return { ...res, status: "invalid_input", notes: [...res.notes, "Invalid certified-copy dates."] };
    else if (compareIso(appliedOn, input.from) < 0) res.notes.push("Copy applied for before the order date; no exclusion computed.");
    else if (compareIso(appliedOn, last) > 0) {
      res.steps.push({ text: `Certified copy applied for on ${appliedOn}, after the period expired on ${last}: no exclusion.`, authority: "Limitation Act, 1963, s.12(2)" });
    } else {
      const excluded = daysBetween(appliedOn, readyOn);
      res.excludedDays = excluded;
      last = addDays(last, excluded);
      res.steps.push({ text: `Time requisite for the certified copy excluded: applied ${appliedOn}, ready ${readyOn} = ${excluded} day(s) (counted conservatively as the days between the two dates). Period now ends on ${last}.`, authority: "Limitation Act, 1963, s.12(2)", date: last });
      res.uncertain.push("Whether the day of application and the day of delivery are themselves excluded is not settled in this engine; the conservative (shorter) exclusion is used.");
    }
  }
  res.lastDay = last;
  applyS4(res, input.calendar);

  if (rule.condonable === true) res.steps.push({ text: "After expiry, the court may admit the appeal/application on sufficient cause for the delay.", authority: "Limitation Act, 1963, s.5" });
  else if (rule.condonable === false && rule.proceeding === "suit") res.steps.push({ text: "A suit filed after the period is dismissed even if limitation is not set up as a defence; s.5 does not extend time for suits.", authority: "Limitation Act, 1963, ss.3 and 5" });
  if (res.uncertain.length) res.status = "requires_verification";
  return res;
}

/* ───────────────────────────── s.138 Negotiable Instruments Act ───────────────────────────── */

export interface ChequeDishonourInput {
  /** Date the payee received information of dishonour from the bank. */
  dishonourInformationOn?: IsoDate;
  /** Date the drawer received the demand notice. */
  noticeReceivedOn?: IsoDate;
  calendar?: CourtCalendar;
}

export interface ChequeDishonourResult {
  status: "computed" | "requires_verification" | "invalid_input";
  /** s.138(b): last day to issue the demand notice. */
  noticeDeadline?: IsoDate;
  /** s.138(c): last day of the drawer's 15-day payment window. */
  paymentWindowEnds?: IsoDate;
  /** Earliest day a complaint is maintainable (a complaint before the 15 days expire is premature). */
  earliestComplaint?: IsoDate;
  /** s.142(1)(b): last day to file the complaint (conservative), before s.4. */
  complaintLastDay?: IsoDate;
  adjustedComplaintLastDay?: IsoDate;
  steps: LimitationStep[];
  uncertain: string[];
  notes: string[];
}

/**
 * Cheque dishonour timeline under ss.138 and 142 of the Negotiable Instruments Act, 1881. Days are counted with the
 * first day excluded (General Clauses Act, 1897, s.9; Limitation Act s.12(1) via s.29(2)). The complaint deadline
 * uses the conservative reading: one month reckoned from the last day of the 15-day window.
 */
export function chequeDishonourTimeline(input: ChequeDishonourInput): ChequeDishonourResult {
  const res: ChequeDishonourResult = { status: "computed", steps: [], uncertain: [], notes: ["The cheque must have been presented within its validity (s.138(a): six months or its validity period, whichever is earlier; bank practice limits validity to three months)."] };
  if (input.dishonourInformationOn !== undefined) {
    if (!isValidIsoDate(input.dishonourInformationOn)) return { ...res, status: "invalid_input", notes: ["Invalid dishonour-information date."] };
    res.noticeDeadline = addDays(input.dishonourInformationOn, 30);
    res.steps.push({ text: `Demand notice in writing within 30 days of receiving information of dishonour (${input.dishonourInformationOn}): last day ${res.noticeDeadline}.`, authority: "Negotiable Instruments Act, 1881, s.138 proviso (b)", date: res.noticeDeadline });
  }
  if (input.noticeReceivedOn !== undefined) {
    if (!isValidIsoDate(input.noticeReceivedOn)) return { ...res, status: "invalid_input", notes: ["Invalid notice-received date."] };
    res.paymentWindowEnds = addDays(input.noticeReceivedOn, 15);
    res.earliestComplaint = addDays(res.paymentWindowEnds, 1);
    res.steps.push({ text: `Drawer has 15 days from receipt of notice (${input.noticeReceivedOn}) to pay: window ends ${res.paymentWindowEnds}. Cause of action arises on non-payment within that window; a complaint before ${res.earliestComplaint} is premature.`, authority: "Negotiable Instruments Act, 1881, s.138 proviso (c)", date: res.paymentWindowEnds });
    res.complaintLastDay = addMonths(res.paymentWindowEnds, 1);
    res.steps.push({ text: `Complaint within one month of the date the cause of action arises: reckoned conservatively from ${res.paymentWindowEnds}, excluding that day, the last day is ${res.complaintLastDay}.`, authority: "Negotiable Instruments Act, 1881, s.142(1)(b); General Clauses Act, 1897, s.3(35) (month)", date: res.complaintLastDay });
    res.steps.push({ text: "The court may take cognizance of a later complaint if the complainant satisfies it of sufficient cause for the delay.", authority: "Negotiable Instruments Act, 1881, s.142(1)(b), proviso" });
    res.uncertain.push("Whether the one month runs from the last day of the 15-day window or from the following day is computed conservatively (earlier date).");
    if (input.calendar) {
      const next = nextOpenDay(res.complaintLastDay, input.calendar);
      if (next.date) {
        res.adjustedComplaintLastDay = next.date;
        if (next.date !== res.complaintLastDay) res.steps.push({ text: `Court closed on ${res.complaintLastDay}; complaint on ${next.date} is in time.`, authority: "Limitation Act, 1963, s.4 (applied to special laws by s.29(2))", date: next.date });
      } else res.steps.push({ text: `Court calendar cannot confirm ${res.complaintLastDay} (${next.unknown}).`, authority: "Limitation Act, 1963, s.4" });
      if (input.calendar.sample) res.uncertain.push(`Calendar "${input.calendar.id}" is sample data.`);
    } else res.steps.push({ text: `If the court is closed on ${res.complaintLastDay}, filing on the reopening day is in time. No calendar supplied; not checked.`, authority: "Limitation Act, 1963, s.4" });
  }
  if (!res.steps.length) return { ...res, status: "invalid_input", notes: ["Give dishonourInformationOn and/or noticeReceivedOn."] };
  if (res.uncertain.length) res.status = "requires_verification";
  return res;
}

/** Arbitration s.34(3): three months (s.4 may extend) plus the non-extendable 30-day outer limit. */
export function arbitrationSetAsideTimeline(awardReceivedOn: IsoDate, calendar?: CourtCalendar): LimitationResult & { outerLimit?: IsoDate } {
  const res = computeLimitation({ ruleId: "arb-34", from: awardReceivedOn, calendar });
  if (!res.lastDay) return res;
  const outerLimit = addDays(res.lastDay, 30);
  res.steps.push({ text: `Outer limit with the proviso's further 30 days: ${outerLimit}. No application is maintainable after this date, and the s.4 extension is not applied to the 30-day period.`, authority: "Arbitration and Conciliation Act, 1996, s.34(3) proviso", date: outerLimit });
  return { ...res, outerLimit };
}
