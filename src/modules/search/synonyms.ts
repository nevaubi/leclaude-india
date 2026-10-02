/**
 * Static legal synonym / expansion map and a small spelling dictionary used
 * for precision aids in the query bar. Client-safe.
 */

export const LEGAL_SYNONYMS: Record<string, string[]> = {
  "failure to warn": ["inadequate warning", "duty to warn", "warning defect", "marketing defect"],
  "duty to warn": ["failure to warn", "adequate warning", "learned intermediary"],
  "learned intermediary": ["prescribing physician", "adequate warning to physician", "intermediary doctrine"],
  "consequential damages": ["incidental damages", "lost profits", "special damages", "indirect damages"],
  "consequential damages waiver": ["limitation of liability", "exclusion of consequential damages", "2-719", "damages cap"],
  "limitation of liability": ["exculpatory clause", "damages cap", "consequential damages waiver", "2-719"],
  "indemnity": ["indemnification", "hold harmless", "defend and indemnify", "contractual indemnity"],
  "indemnification": ["indemnity", "hold harmless"],
  "summary judgment": ["Rule 56", "genuine dispute of material fact", "no genuine issue"],
  "motion to dismiss": ["Rule 12(b)(6)", "failure to state a claim", "plausibility", "Twombly", "Iqbal"],
  "liquidated damages": ["section 74", "genuine pre-estimate", "penalty", "reasonable compensation"],
  "polluter pays": ["absolute liability", "precautionary principle", "environmental compensation", "remediation cost"],
  "effluent": ["trade effluent", "discharge", "wastewater", "consent to operate"],
  "groundwater": ["aquifer", "well water", "subsurface water", "contamination plume"],
  "meningioma": ["intracranial meningioma", "brain tumor", "progestogen"],
  "dmpa": ["depot medroxyprogesterone acetate", "Depo-Provera", "medroxyprogesterone"],
  "depo-provera": ["DMPA", "medroxyprogesterone acetate", "progestin injection"],
  "paga": ["Private Attorneys General Act", "Labor Code 2699", "representative action", "aggrieved employee"],
  "manageability": ["unmanageable", "trial plan", "Estrada", "Wesson", "representative claims"],
  "preemption": ["preempt", "impossibility preemption", "conflict preemption", "Supremacy Clause", "clear evidence"],
  "impossibility preemption": ["Wyeth v. Levine", "Albrecht", "clear evidence", "CBE", "changes being effected"],
  "daubert": ["Rule 702", "expert admissibility", "gatekeeping", "reliability", "Kumho Tire"],
  "expert": ["Rule 702", "Daubert", "expert testimony", "specialized knowledge"],
  "tsca": ["Toxic Substances Control Act", "15 U.S.C. 2601", "2607(e)", "substantial risk"],
  "substantial risk": ["8(e)", "2607(e)", "substantial risk notice", "TSCA"],
  "mdl": ["multidistrict litigation", "1407", "transferee court", "bellwether"],
  "bellwether": ["test trial", "MDL", "representative trial"],
  "spoliation": ["destruction of evidence", "Rule 37(e)", "litigation hold", "adverse inference"],
  "class certification": ["Rule 23", "predominance", "commonality", "numerosity", "adequacy"],
  "meal period": ["meal break", "Labor Code 512", "rest period", "premium pay", "Brinker"],
  "rounding": ["time rounding", "neutral rounding", "Camp v. Home Depot", "See's Candy", "timekeeping"],
  "successor liability": ["de facto merger", "mere continuation", "asset purchaser"],
  "personal jurisdiction": ["minimum contacts", "purposeful availment", "specific jurisdiction", "Ford Motor"],
  "statute of limitations": ["limitations period", "discovery rule", "tolling", "accrual"],
  "punitive damages": ["exemplary damages", "State Farm v. Campbell", "reprehensibility", "due process cap"],
  "arbitration": ["Federal Arbitration Act", "FAA", "compel arbitration", "delegation clause"],
  "trade secret": ["DTSA", "misappropriation", "UTSA", "confidential information"],
  "choice of law": ["conflict of laws", "Restatement (Second)", "most significant relationship"],
  "negligence per se": ["statutory violation", "regulatory standard"],
  "economic loss": ["economic loss doctrine", "economic loss rule", "East River", "Moorman"],
  "government contractor defense": ["Boyle", "military specification", "MilSpec", "federal officer removal", "1442"],
  "federal officer removal": ["1442(a)(1)", "acting under", "colorable federal defense", "Boyle"],
  "drinking water": ["maximum contaminant level", "MCL", "Safe Drinking Water Act", "141.61", "public water system"],
  "cercla": ["Superfund", "hazardous substance", "9607", "response costs", "potentially responsible party"],
  "hazardous substance": ["CERCLA", "9601(14)", "listed substance", "302.4"],
  "medical monitoring": ["latent injury", "increased risk", "diagnostic testing", "no present injury"],
  "causation": ["proximate cause", "but-for", "substantial factor", "specific causation", "general causation"],
  "breach of contract": ["material breach", "anticipatory repudiation", "damages", "performance"],
  "material adverse effect": ["MAE", "MAC clause", "Akorn", "durationally significant"],
  "fiduciary duty": ["duty of loyalty", "duty of care", "Revlon", "entire fairness"],
  "privilege": ["attorney-client privilege", "work product", "common interest", "Upjohn"],
  "work product": ["Rule 26(b)(3)", "anticipation of litigation", "opinion work product"],
  "wage and hour": ["FLSA", "overtime", "minimum wage", "Labor Code", "off-the-clock"],
  "hostile work environment": ["harassment", "severe or pervasive", "Title VII", "FEHA"],
  "retaliation": ["protected activity", "adverse action", "causal link", "whistleblower"],
  "insurance coverage": ["duty to defend", "duty to indemnify", "pollution exclusion", "occurrence"],
  "pollution exclusion": ["absolute pollution exclusion", "sudden and accidental", "CGL"],
  "contribution": ["equitable contribution", "joint tortfeasor", "allocation", "CERCLA 113"],
};

/** Terms that shouldn't trigger spelling suggestions or are legal vocabulary. */
export const LEGAL_DICTIONARY: string[] = Array.from(
  new Set(
    [
      ...Object.keys(LEGAL_SYNONYMS).flatMap((k) => k.split(/\s+/)),
      ...Object.values(LEGAL_SYNONYMS).flat().flatMap((v) => v.toLowerCase().split(/\s+/)),
      "plaintiff", "defendant", "appellant", "appellee", "petitioner", "respondent", "certiorari", "remand", "affirmed", "reversed", "vacated", "dismissed", "enjoined",
      "negligence", "strict liability", "warranty", "merchantability", "fitness", "tort", "tortious", "interference", "conversion", "replevin", "estoppel", "laches", "waiver",
      "jurisdiction", "venue", "standing", "mootness", "ripeness", "abstention", "removal", "diversity", "supplemental", "declaratory", "injunction", "injunctive", "mandamus",
      "deposition", "interrogatories", "subpoena", "custodian", "discovery", "sanctions", "protective", "confidentiality", "privileged", "redaction", "production",
      "regulation", "regulatory", "rulemaking", "promulgated", "guidance", "enforcement", "compliance", "notice", "comment", "docket", "agency", "administrative", "chevron", "loper",
      "statute", "statutory", "legislative", "codified", "amendment", "subsection", "paragraph", "chapter", "title",
      "contract", "agreement", "covenant", "condition", "precedent", "subsequent", "consideration", "rescission", "reformation", "unconscionable", "unconscionability", "integration", "merger",
      "damages", "restitution", "disgorgement", "mitigation", "liquidated", "penalty", "interest", "prejudgment", "attorney", "fees",
      "toxicology", "epidemiology", "hydrogeology", "exposure", "dose", "latency", "carcinogen", "endocrine", "bioaccumulation", "contamination", "remediation", "groundwater",
      "pharmaceutical", "label", "labeling", "warning", "adverse", "event", "fda", "epa", "osha", "sec", "ftc", "doj",
      "circuit", "district", "supreme", "appellate", "superior", "chancery",
      "bluebook", "citation", "cite", "headnote", "syllabus", "opinion", "concurrence", "dissent", "holding", "dicta", "dictum",
    ].map((w) => w.toLowerCase().replace(/[^a-z0-9()\-.]/g, "")),
  ),
).filter((w) => w.length > 2);

const DICT_SET = new Set(LEGAL_DICTIONARY);

/** Damerau-Levenshtein distance with early exit. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev[j - 1]);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

export interface SpellingSuggestion { term: string; suggestion: string }

/** Suggest corrections for query tokens that look like misspelled legal vocabulary. */
export function spellingSuggestions(query: string): SpellingSuggestion[] {
  const out: SpellingSuggestion[] = [];
  const seen = new Set<string>();
  const tokens = query.toLowerCase().replace(/["()]/g, " ").split(/\s+/).filter((t) => /^[a-z][a-z\-]{4,}$/.test(t));
  for (const t of tokens) {
    if (seen.has(t) || DICT_SET.has(t) || ["and", "or", "not", "within"].includes(t)) continue;
    seen.add(t);
    let best: { w: string; d: number } | null = null;
    for (const w of LEGAL_DICTIONARY) {
      if (Math.abs(w.length - t.length) > 2 || w[0] !== t[0]) continue;
      const d = editDistance(t, w, 2);
      if (d <= 2 && d > 0 && (!best || d < best.d || (d === best.d && w.length > best.w.length))) best = { w, d };
    }
    if (best) out.push({ term: t, suggestion: best.w });
  }
  return out.slice(0, 4);
}

/** Synonym expansions for phrases/terms present in the query. */
export function synonymSuggestions(query: string): { term: string; synonyms: string[] }[] {
  const q = query.toLowerCase();
  const out: { term: string; synonyms: string[] }[] = [];
  const keys = Object.keys(LEGAL_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(q) && !out.some((o) => o.term.includes(k) || k.includes(o.term))) out.push({ term: k, synonyms: LEGAL_SYNONYMS[k] });
  }
  return out.slice(0, 5);
}
