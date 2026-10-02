import type { Conflict } from "@/lib/types/domain";
import { MATTERS } from "@/lib/seed/ids";

const M = MATTERS.valsara;
const VASUDEVAN = "dep_vls_voss_v1";
const HEGDE = "dep_vls_hale_v1";
const PRASAD = "dep_vls_pryce_v1";

type Side = Conflict["sides"][number];
const depo = (label: string, sourceId: string, cite: string, excerpt: string): Side => ({ label, sourceKind: "deposition", sourceId, cite, excerpt });
const doc = (label: string, sourceId: string, cite: string, excerpt: string): Side => ({ label, sourceKind: "document", sourceId, cite, excerpt });

export const VALSARA_CONFLICTS: Conflict[] = [
  {
    id: "cf_vls_001", matterId: M, kind: "testimony_vs_document", severity: "high", status: "open", createdBy: "user",
    title: "Vasudevan: 90-day study was 'preliminary' vs. Sundaram 'FINAL REPORT SUMMARY' and her own 'the Sundaram final' email",
    sides: [
      depo("Vasudevan testimony", VASUDEVAN, "Vasudevan 19:15", "From my perspective, in March 2001 it was a preliminary result. We did not yet have the individual animal data, and I had not completed my own review."),
      doc("Sundaram report summary", "ed_vls_0001", "MFC-0041877", "SUNDARAM LABORATORIES — FINAL REPORT SUMMARY — Study SL-2000-0417. NOAEL 0.1 mg/kg-day; test article persisted in serum after the recovery period."),
      doc("Vasudevan email, 14 Mar 2001", "ed_vls_0002", "MFC-0041880", "The Sundaram final came in this afternoon … the liver effects are real, they are dose-related, and they did not fully reverse in the recovery animals."),
    ],
    analysis: "The witness characterises the March 2001 result as preliminary, but the report is captioned 'final', she used the word 'final' herself on the day it arrived, and she conceded at 24:5 that the dose-related liver effect was her opinion at the time. Her distinction between 'the deliverable' and 'the interpretation' (226:3) is the defence framing; the Claimant will pair 19:15 with Prasad's 4 Apr 2001 email (MFC-0041942) that leans on 'our own toxicologist says is preliminary' to argue the label was adopted to defer reporting. Prepare her for the sequence Vasudevan-1 → Vasudevan-2 → Prasad-3 on redirect.",
  },
  {
    id: "cf_vls_002", matterId: M, kind: "date_inconsistency", severity: "high", status: "open", createdBy: "user",
    title: "Hegde dates receipt of the 41 µg/L MW-7 result to 'late August 2002'; his transmittal email is dated 8 Jul 2002",
    sides: [
      depo("Hegde testimony", HEGDE, "Hegde 46:7", "That would have been late August 2002, when Beacon delivered the Q2 report."),
      doc("Hegde email, 8 Jul 2002", "ed_vls_0057", "MFC-0052210", "Beacon's Q2 results for the Valsara wells are attached. I need decisions this week. MW-7 (downgradient of Lagoon 2): MC-8 41 µg/L."),
      doc("Beacon Q2 2002 report", "ed_vls_0058", "MFC-0052212", "Report date 3 July 2002."),
    ],
    analysis: "The witness corrected himself once shown Exhibit 4 (47:14) and again in his closing correction (208:2), so the error is cured on this record, but the seven-week gap matters: it compresses the interval between receipt and the October 24 letter to the Park from ~60 days to 108 days. Expect the Claimant to use the initial error to suggest the witness is minimising the delay. Vol. II prep: walk the July 3 → July 8 → July 9 → October 24 sequence with dates in hand.",
  },
  {
    id: "cf_vls_003", matterId: M, kind: "document_vs_document", severity: "medium", status: "open", createdBy: "user",
    title: "Hegde EHS memo 'no adverse findings' vs. Vasudevan email 'the liver effects are real' and Hegde's own draft v2",
    sides: [
      doc("Hegde EHS memo (final)", "ed_vls_0011", "MFC-0041912", "On the basis of the daily-dose comparison there are no adverse findings at exposures relevant to occupational use of the product."),
      doc("Vasudevan email, 14 Mar 2001", "ed_vls_0002", "MFC-0041880", "the liver effects are real, they are dose-related, and they did not fully reverse in the recovery animals."),
      doc("Hegde EHS memo (draft v2)", "ed_vls_0034", "MFC-0041965", "Effects observed are consistent with a persistent, bioaccumulative compound and margins for end-users cannot be established on current data."),
    ],
    analysis: "The final memo narrows the draft's end-user conclusion to occupational exposure and drops the persistence sentence. Hegde attributes the edit to his own judgment (25:21) but concedes Prasad told him to 'stick to what EHS knew' (26:18). The two documents are consistent if read as answering different questions (plant exposure vs. hazard), which is the position to hold; the risk is the near-duplicate pairing in the production, which invites a 'sanitised' narrative.",
  },
  {
    id: "cf_vls_004", matterId: M, kind: "testimony_vs_document", severity: "high", status: "open", createdBy: "user",
    title: "Prasad: 'I did not restrict' the Sundaram report vs. 'keep to the four of us … do not forward'",
    sides: [
      depo("Prasad testimony", PRASAD, "Prasad 19:2", "I did not restrict it. I asked that it stay within the working group until we had met on Friday."),
      doc("Prasad email, 15 Mar 2001", "ed_vls_0004", "MFC-0041882", "please keep the report and the summary to the four of us. Do not forward it to the plant, to marketing, or to the defence qualification cell."),
      depo("Vasudevan testimony", VASUDEVAN, "Vasudevan 44:13", "Anil. He had said the same thing in an email the day before."),
    ],
    analysis: "Semantic quarrel the witness cannot win: the email is a distribution restriction on its face and Vasudevan confirms the instruction was repeated at the Friday meeting. The defensible position is the one he gave at 18:10 (avoid a garbled version reaching customers before the working group met). Prep note: drop 'I did not restrict' and own the instruction with its rationale; the defence qualification authority did receive a summary in October 2002 (20:9).",
  },
  {
    id: "cf_vls_005", matterId: M, kind: "testimony_vs_document", severity: "high", status: "open", createdBy: "user",
    title: "Prasad: 'Budget was not a factor in the design' vs. 'Three groups, not four … takes it to about ₹9.2 crore'",
    sides: [
      depo("Prasad testimony", PRASAD, "Prasad 39:17", "Budget was not a factor in the design. The design was Sundaram's recommendation. Cost was a factor in what we did in that fiscal year."),
      doc("Prasad email, 11 Apr 2001", "ed_vls_0027", "MFC-0041948", "I will sign the bioassay. I will not sign ₹16.2 crore. … Bioassay: yes, but the reduced design. Three groups, not four, and drop the 12-month interim sacrifice. Sundaram told Pankaj on the phone that takes it to about ₹9.2 crore."),
      depo("Vasudevan testimony", VASUDEVAN, "Vasudevan 49:8", "Anil Prasad. It was a budget decision."),
    ],
    analysis: "Direct contradiction corroborated by the company's own toxicologist. Sundaram's proposal (MFC-0041945) was four groups with a 12-month interim sacrifice; the reduced design is Prasad's, priced in his own email. The salvageable point is scientific adequacy: the three-group study was capable of detecting carcinogenicity and did (Vasudevan 233:14). Recommend an errata-sheet correction to 39:17 limited to 'cost was a factor in the number of dose groups'.",
  },
  {
    id: "cf_vls_006", matterId: M, kind: "position_inconsistency", severity: "medium", status: "open", createdBy: "user",
    title: "Prasad's account of 'Do not put this in email' (preliminary numbers) vs. the email's stated reason (hold until Legal reviews)",
    sides: [
      depo("Prasad testimony", PRASAD, "Prasad 72:14", "The numbers were preliminary and the recommendations were Girish's personal views."),
      doc("Prasad email, 9 Jul 2002", "ed_vls_0059", "MFC-0052217", "Do not put this in email. Not the recommendations, not the numbers, not the farm. … Nothing goes to the Board or to the Park until Legal has looked at it. That is not a 'no,' it is a 'not yet.'"),
      depo("Hegde testimony", HEGDE, "Hegde 50:16", "I had been told nothing goes to the Board until Legal had looked at it."),
    ],
    analysis: "The Beacon report was a final laboratory report (Hegde 48:3), so 'preliminary numbers' is not sustainable. The email's own rationale (legal review before external notification) is a better position and is consistent with Hegde. The exposure is the phrase 'not the farm' — the Kesar private well — which reads as concealment; the answer is that the well was sampled in 2003 (Hegde 52:14) and the Park was offered sampling in October 2002.",
  },
  {
    id: "cf_vls_007", matterId: M, kind: "testimony_vs_testimony", severity: "medium", status: "open", createdBy: "user",
    title: "Who owned the 2001 MSDS language: Vasudevan says Hegde had no role; Hegde says he 'signed off with Hema'",
    sides: [
      depo("Vasudevan testimony", VASUDEVAN, "Vasudevan 156:20", "Not that I recall. It was Product Stewardship and Anil."),
      depo("Hegde testimony", HEGDE, "Hegde 142:6", "Product Stewardship drafted it; I signed off on the MSDS language with Hema, and Anil approved the final."),
      depo("Prasad testimony", PRASAD, "Prasad 49:8", "Girish was copied. It was my call."),
    ],
    analysis: "Three witnesses, three accounts of Hegde's role. The documents (MFC-0041938, MFC-0041942) show Bose drafting, Vasudevan supplying Section 11 language, and Prasad deciding; Hegde appears only as a cc. Vasudevan and Prasad are consistent with the record; Hegde overstates his involvement. Low stakes on the merits but it will be used to attack Hegde's reliability alongside the MW-7 date error. Address in Hegde Vol. II.",
  },
  {
    id: "cf_vls_008", matterId: M, kind: "testimony_vs_testimony", severity: "medium", status: "open", createdBy: "user",
    title: "Vasudevan says she objected to 'no adverse findings' verbally; Hegde says Vasudevan reviewed the memo without asking for changes",
    sides: [
      depo("Vasudevan testimony", VASUDEVAN, "Vasudevan 39:15", "No. That was Girish's framing. I would not have written 'no adverse findings' about a study that found dose-related liver effects."),
      depo("Vasudevan testimony", VASUDEVAN, "Vasudevan 40:6", "I raised it with Girish verbally. I did not put anything in writing."),
      depo("Hegde testimony", HEGDE, "Hegde 22:19", "Yes. Hema reviewed the final and did not ask for changes to that paragraph."),
    ],
    analysis: "Irreconcilable as stated; no contemporaneous document resolves it (Vasudevan is a cc on MFC-0041912 and there is no reply). The practical answer is that both can be true — she raised it, he did not treat it as a change request. Neither witness should be pushed to call the other wrong. Consider whether Bose (cc on the memo) recalls the exchange; ask in her Vol. II if one is taken.",
  },
  {
    id: "cf_vls_009", matterId: M, kind: "testimony_vs_document", severity: "medium", status: "open", createdBy: "user",
    title: "Vasudevan: 'not a measured' half-life before March 2001 vs. her email reporting Sundaram's ~100-day verbal estimate as the number 'that worries me'",
    sides: [
      depo("Vasudevan testimony", VASUDEVAN, "Vasudevan 28:1", "I recall that Leela gave me a rough number on the phone. I would not have treated it as a determined value."),
      doc("Vasudevan email, 14 Mar 2001", "ed_vls_0002", "MFC-0041880", "Her verbal estimate to me was a half-life in the rat on the order of 100 days. … The number that worries me is not the liver weight. It is the serum concentration in the recovery group."),
      doc("Sponsor QA re-analysis", "ed_vls_0017", "MFC-0041922", "Re-analysis of recovery-group serum: estimated elimination half-life 98–103 days."),
    ],
    analysis: "Not a true contradiction (she is consistent that the March value was an estimate), but the QA re-analysis a week later put a measured number on it (98–103 days), and she conceded at 28:14 that the estimate was 'the number that worried me'. The Claimant's theme: Meridian had a quantified persistence signal by 20 March 2001. Resolve by stipulating to the re-analysis date rather than fighting the estimate.",
  },
  {
    id: "cf_vls_010", matterId: M, kind: "document_vs_document", severity: "medium", status: "resolved", createdBy: "user",
    title: "Defence response says a 90-day summary went to CPCB in June 2001; Sood email shows the June 2001 CPCB inquiry was still unanswered",
    sides: [
      doc("Prasad to DQA-T, 7 Oct 2002", "ed_vls_0069", "MFC-0052238", "Meridian provided a summary of the 90-day study to CPCB in June 2001 and will provide a copy to DQA-T under our standard confidentiality terms."),
      doc("Sood email, 8 Jun 2001", "ed_vls_0040", "MFC-0041976", "Phadke called again this morning … I said I would need to check and get back to him. … My recommendation is option three [voluntary submission with cover letter]."),
      depo("Prasad testimony", PRASAD, "Prasad 88:12", "Manish told me a summary went to CPCB in response to the voluntary data request. I relied on that."),
    ],
    analysis: "Resolved on the documents: the voluntary submission to CPCB went out 27 June 2001 under Sood's cover letter (produced in the Tier 1 set, MFC-0031877, outside this workspace), so the defence qualification authority letter is accurate as to the fact though not the date precision. Prasad did not review the submission (89:3). Keep the Tier 1 cover letter in the Prasad exhibit binder for redirect.",
  },
  {
    id: "cf_vls_011", matterId: M, kind: "date_inconsistency", severity: "low", status: "dismissed", createdBy: "user",
    title: "Hegde: GPCB 'notified' by the October 2002 letter to the Park vs. formal submission to the Board in November 2002",
    sides: [
      depo("Hegde testimony", HEGDE, "Hegde 49:17", "The formal letter did not go until later."),
      depo("Prasad testimony", PRASAD, "Prasad 74:17", "The formal submission was in November, in response to their request."),
      doc("Valsara Textile Park Ltd. letter", "ed_vls_0063", "MFC-0052221", "Letter to Valsara Textile Park Water Works — notification of shallow groundwater monitoring results and offer of wellfield sampling."),
    ],
    analysis: "Dismissed: the witnesses are describing two different recipients (the Park in October, the Board in November) and the testimony is consistent once the recipients are distinguished. No action.",
  },
];
