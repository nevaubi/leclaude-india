import "server-only";
import type { Database } from "@/lib/db";
import type { LibraryItem, PracticeArea } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { configuredTenantId, indexDocuments, VECTOR_COLLECTIONS } from "@/lib/ai/vector-store";
import { LIBRARY_FOLDERS, matterFolderId } from "./ids";
import type { ActivityEntry, ClauseMeta } from "./types";
import { SEED_CLAUSES } from "./seed-clauses";
import { KNOWLEDGE_SUBFOLDERS, SEED_NOTES } from "./seed-knowledge";
import { LIBRARY_COLLECTIONS, indexTextFor } from "./data";

const P = PEOPLE;
const M = MATTERS;

type Item = LibraryItem;

function folder(id: string, parentId: string | null, name: string, extra: Partial<Item> = {}): Item {
  return { id, parentId, name, type: "folder", ownerId: P.aishaKhan, sharedWith: ["firm"], createdAt: "2024-01-08T09:00:00Z", updatedAt: "2026-09-01T09:00:00Z", ...extra };
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------
export const MATTER_SUBFOLDERS: Record<string, string[]> = {
  [M.valsara]: ["Pleadings & orders", "Discovery", "Depositions", "Experts", "Correspondence", "Research"],
  [M.depo]: ["Pleadings", "Science & literature", "Correspondence"],
  [M.northgate]: ["Pleadings", "Briefing", "Discovery", "Contract"],
  [M.harbor]: ["Data room", "Diligence memos", "Transaction documents"],
  [M.sterling]: ["PAGA notice", "Payroll analysis", "Correspondence"],
};

export function matterSubfolderId(matterId: string, name: string) {
  return `${matterFolderId(matterId)}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "")}`;
}

function buildFolders(db: Database): Item[] {
  const out: Item[] = [
    folder(LIBRARY_FOLDERS.firm, null, "Firm", { description: "Firm-wide policies, forms, precedents and administration." }),
    folder(LIBRARY_FOLDERS.matters, null, "Matters", { description: "One folder per active matter, shared with the matter team." }),
    folder(LIBRARY_FOLDERS.templates, null, "Templates", { description: "Document, workbook, deck and PDF templates for the Office suite." }),
    folder(LIBRARY_FOLDERS.clauses, null, "Clause bank", { description: "Approved clauses with fillable variables and drafting notes.", tags: ["clauses"] }),
    folder(LIBRARY_FOLDERS.knowledge, null, "Knowledge", { description: "Practice notes, cheat sheets and research guides maintained by KM." }),
    folder(LIBRARY_FOLDERS.myFiles, null, "My files", { ownerId: P.arjunMehra, sharedWith: ["private"], description: "Your personal working folder." }),
    folder("lib_folder_firm_policies", LIBRARY_FOLDERS.firm, "Policies & administration"),
    folder("lib_folder_firm_forms", LIBRARY_FOLDERS.firm, "Forms & precedents"),
    folder("lib_folder_firm_cle", LIBRARY_FOLDERS.firm, "CLE materials"),
    folder("lib_folder_firm_marketing", LIBRARY_FOLDERS.firm, "Pitches & marketing"),
    folder(KNOWLEDGE_SUBFOLDERS.litigation, LIBRARY_FOLDERS.knowledge, "Litigation practice"),
    folder(KNOWLEDGE_SUBFOLDERS.transactional, LIBRARY_FOLDERS.knowledge, "Transactional"),
    folder(KNOWLEDGE_SUBFOLDERS.research, LIBRARY_FOLDERS.knowledge, "Research guides"),
    folder(KNOWLEDGE_SUBFOLDERS.style, LIBRARY_FOLDERS.knowledge, "Firm style"),
  ];
  for (const m of db.matters.all()) {
    out.push(folder(matterFolderId(m.id), LIBRARY_FOLDERS.matters, m.shortName, { matterId: m.id, ownerId: m.leadAttorneyId ?? P.arjunMehra, sharedWith: ["matter-team"], description: `${m.name}${m.caption ? ` — ${m.caption}` : ""}`, practiceArea: m.practiceArea, createdAt: `${m.openedAt}T09:00:00Z` }));
    for (const name of MATTER_SUBFOLDERS[m.id] ?? []) out.push(folder(matterSubfolderId(m.id, name), matterFolderId(m.id), name, { matterId: m.id, ownerId: m.leadAttorneyId ?? P.arjunMehra, sharedWith: ["matter-team"], createdAt: `${m.openedAt}T09:05:00Z` }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Templates (metadata only; the editors seed real documents)
// ---------------------------------------------------------------------------
interface TemplateSeed { id: string; name: string; kind: "word" | "sheet" | "slides" | "pdf"; templateId?: string; description: string; category: string; practiceArea?: PracticeArea; tags: string[] }

const TEMPLATES: TemplateSeed[] = [
  { id: "lib_tpl_word_motion_brief", name: "Motion and supporting brief (D.S.C.)", kind: "word", templateId: "word-motion-brief", category: "Litigation", practiceArea: "Litigation", description: "Caption, introduction, factual background, legal standard, argument, conclusion, signature block and certificate of service.", tags: ["motion", "brief", "D.S.C."] },
  { id: "lib_tpl_word_research_memo", name: "Research memorandum", kind: "word", templateId: "word-research-memo", category: "Internal", description: "Question presented, brief answer, facts, discussion, recommendation and authorities consulted.", tags: ["memo", "research"] },
  { id: "lib_tpl_word_client_update", name: "Client update letter", kind: "word", templateId: "word-client-update", category: "Client", description: "Status letter with summary, developments, deadline table, strategy and budget.", tags: ["letter", "client"] },
  { id: "lib_tpl_word_engagement", name: "Engagement letter", kind: "word", templateId: "word-engagement-letter", category: "Client", description: "Scope, staffing, fees, costs, conflicts, confidentiality, retention and termination terms.", tags: ["engagement", "letter"] },
  { id: "lib_tpl_word_nda", name: "Mutual NDA", kind: "word", templateId: "word-mutual-nda", category: "Transactional", practiceArea: "Corporate / M&A", description: "Two-way confidentiality agreement with standard exclusions, compelled disclosure, term and remedies.", tags: ["NDA", "confidentiality"] },
  { id: "lib_tpl_word_msa", name: "Master services agreement", kind: "word", templateId: "word-msa", category: "Transactional", practiceArea: "Commercial", description: "SOWs, fees, IP, confidentiality, data security, warranties, indemnities, limitation of liability, term.", tags: ["MSA", "contract"] },
  { id: "lib_tpl_word_demand", name: "Demand letter (Rule 408)", kind: "word", templateId: "word-demand-letter", category: "Litigation", practiceArea: "Commercial", description: "Background, breach, damages, preservation notice and reservation of rights.", tags: ["demand", "pre-suit"] },
  { id: "lib_tpl_word_depo_notice", name: "Deposition notice", kind: "word", templateId: "word-deposition-notice", category: "Litigation", practiceArea: "Litigation", description: "Rule 30 notice with logistics table, optional 30(b)(6) topics and document schedule.", tags: ["deposition", "discovery"] },
  { id: "lib_tpl_word_rogs_rfp", name: "First set of interrogatories and RFPs", kind: "word", templateId: "word-interrogatories-rfp", category: "Litigation", practiceArea: "Litigation", description: "Definitions, instructions, interrogatories, requests for production, ESI schedule.", tags: ["interrogatories", "RFP"] },
  { id: "lib_tpl_word_priv_log_letter", name: "Privilege log cover letter", kind: "word", templateId: "word-privilege-log-letter", category: "Litigation", practiceArea: "Litigation", description: "Transmittal for a Rule 26(b)(5) log with format conventions and 502(d) reservation.", tags: ["privilege", "letter"] },
  { id: "lib_tpl_word_settlement", name: "Settlement agreement", kind: "word", templateId: "word-settlement-agreement", category: "Litigation", description: "Confidential settlement and mutual release with payment, dismissal, unknown-claims waiver.", tags: ["settlement", "release"] },
  { id: "lib_tpl_word_board_minutes", name: "Board minutes", kind: "word", templateId: "word-board-minutes", category: "Transactional", practiceArea: "Corporate / M&A", description: "Minutes with attendance, approvals, resolutions and adjournment.", tags: ["minutes", "corporate"] },
  { id: "lib_tpl_word_declaration", name: "Declaration (28 U.S.C. § 1746)", kind: "word", templateId: "word-declaration", category: "Litigation", practiceArea: "Litigation", description: "Captioned declaration with numbered facts, verification and notary block.", tags: ["declaration"] },
  { id: "lib_tpl_sheet_damages_model", name: "Damages model workbook", kind: "sheet", category: "Finance", practiceArea: "Commercial", description: "Blank workbook for damages scenarios: inputs, assumptions, prejudgment interest and sensitivity tabs.", tags: ["damages", "model", "workbook"] },
  { id: "lib_tpl_sheet_privilege_log", name: "Privilege log workbook", kind: "sheet", category: "Litigation", practiceArea: "Litigation", description: "Rule 26(b)(5) log columns: Bates, date, author, recipients, type, basis, description, status.", tags: ["privilege log", "workbook"] },
  { id: "lib_tpl_slides_case_themes", name: "Case themes deck", kind: "slides", category: "Litigation", practiceArea: "Litigation", description: "Opening themes, timeline, key documents, witness matrix and damages summary.", tags: ["deck", "trial", "themes"] },
  { id: "lib_tpl_slides_client_pitch", name: "Client pitch deck", kind: "slides", category: "Marketing", description: "Firm overview, team, relevant experience, approach and fee proposal.", tags: ["deck", "pitch"] },
  { id: "lib_tpl_pdf_production", name: "Bates-stamped production set", kind: "pdf", category: "Litigation", practiceArea: "Litigation", description: "PDF workspace for stamping, redacting and slip-sheeting a production volume.", tags: ["pdf", "production", "Bates"] },
];

function templateItems(): Item[] {
  return TEMPLATES.map((t) => ({
    id: t.id,
    parentId: LIBRARY_FOLDERS.templates,
    name: t.name,
    type: "template",
    description: t.description,
    url: t.templateId ? `/office/${t.kind}/new?template=${t.templateId}` : `/office/${t.kind}/new`,
    tags: Array.from(new Set([t.kind, t.category, ...t.tags])),
    practiceArea: t.practiceArea,
    ownerId: P.aishaKhan,
    sharedWith: ["firm"],
    status: "approved",
    version: 3,
    createdAt: "2024-02-12T10:00:00Z",
    updatedAt: "2026-08-30T10:00:00Z",
  }));
}

// ---------------------------------------------------------------------------
// Clauses
// ---------------------------------------------------------------------------
function clauseItems(): { items: Item[]; meta: ClauseMeta[] } {
  const items: Item[] = [];
  const meta: ClauseMeta[] = [];
  for (const c of SEED_CLAUSES) {
    items.push({
      id: c.id,
      parentId: LIBRARY_FOLDERS.clauses,
      name: c.name,
      type: "clause",
      description: c.description,
      content: c.text,
      tags: Array.from(new Set([c.category, ...c.tags])),
      practiceArea: c.practiceArea,
      ownerId: P.aishaKhan,
      sharedWith: ["firm"],
      status: c.status,
      version: 2,
      size: c.text.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      starred: c.id === "lib_clause_lol_cap" || c.id === "lib_clause_depo_stipulations",
    });
    meta.push({ id: c.id, category: c.category, variables: c.variables, stance: c.stance, governingLaw: c.governingLaw, notes: c.notes, standardId: c.standardId, lastReviewedAt: c.lastReviewedAt, reviewedBy: c.reviewedBy, useCount: c.useCount });
  }
  return { items, meta };
}

// ---------------------------------------------------------------------------
// Knowledge notes, links, uploads and matter working files
// ---------------------------------------------------------------------------
function noteItems(): Item[] {
  return SEED_NOTES.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    type: "note",
    description: n.description,
    content: n.content,
    tags: n.tags,
    practiceArea: n.practiceArea,
    matterId: n.matterId,
    ownerId: n.ownerId,
    sharedWith: ["firm"],
    status: n.status ?? "approved",
    version: n.version,
    size: n.content.length,
    starred: n.starred,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  }));
}

interface LinkSeed { id: string; parentId: string; name: string; url: string; description: string; tags: string[]; matterId?: string; practiceArea?: PracticeArea; ownerId?: string; starred?: boolean }

const LINKS: LinkSeed[] = [
  { id: "lib_link_courtlistener", parentId: KNOWLEDGE_SUBFOLDERS.research, name: "CourtListener — opinions, RECAP dockets, citation lookup", url: "https://www.courtlistener.com/", description: "Free Law Project's search over ~10M opinions and the RECAP archive of PACER filings. The Search agent queries the v4 API directly.", tags: ["case law", "dockets", "free"], starred: true },
  { id: "lib_link_ecfr", parentId: KNOWLEDGE_SUBFOLDERS.research, name: "eCFR — Electronic Code of Federal Regulations", url: "https://www.ecfr.gov/", description: "Point-in-time CFR with the Versioner API; use for 40 C.F.R. (EPA) and 29 C.F.R. (DOL) research.", tags: ["regulations", "CFR"] },
  { id: "lib_link_pacer", parentId: KNOWLEDGE_SUBFOLDERS.research, name: "PACER — Public Access to Court Electronic Records", url: "https://pacer.uscourts.gov/", description: "Federal docket access. Firm account: billing code required for every download; check RECAP first.", tags: ["dockets", "federal"] },
  { id: "lib_link_jpml", parentId: KNOWLEDGE_SUBFOLDERS.research, name: "JPML — Judicial Panel on Multidistrict Litigation", url: "https://www.jpml.uscourts.gov/", description: "Pending MDL dockets, transfer orders and hearing sessions. MDL 3140 (Depo-Provera) status.", tags: ["MDL", "JPML"] },
  { id: "lib_link_federal_register", parentId: KNOWLEDGE_SUBFOLDERS.research, name: "Federal Register", url: "https://www.federalregister.gov/", description: "Daily journal of proposed and final rules; FMCSA motor-carrier rulemakings and HSR threshold notices.", tags: ["regulatory", "rulemaking"] },
  { id: "lib_link_dsc_local_rules", parentId: KNOWLEDGE_SUBFOLDERS.litigation, name: "D.S.C. Local Civil Rules", url: "https://www.scd.uscourts.gov/rules", description: "Current Local Civil Rules for the District of South Carolina, including Rule 7.04–7.08 briefing rules.", tags: ["D.S.C.", "local rules"] },
  { id: "lib_link_ndil_local_rules", parentId: KNOWLEDGE_SUBFOLDERS.litigation, name: "N.D. Ill. Local Rules and Judge Ellis standing orders", url: "https://www.ilnd.uscourts.gov/LocalRules.aspx", description: "Local Rules 5.2, 7.1 and 56.1 (statement of facts) and standing orders for summary judgment practice before Judge Ellis.", tags: ["N.D. Ill.", "local rules", "Rule 56.1"], matterId: M.northgate },
  { id: "lib_link_lwda_paga", parentId: KNOWLEDGE_SUBFOLDERS.litigation, name: "LWDA — PAGA filing portal and cure procedures", url: "https://www.dir.ca.gov/Private-Attorneys-General-Act/Private-Attorneys-General-Act.html", description: "California Labor & Workforce Development Agency PAGA notice search, cure submissions and the post-2024 early evaluation process.", tags: ["PAGA", "California", "LWDA"], matterId: M.sterling, practiceArea: "Employment" },
  { id: "lib_link_vls_arbitration_act", parentId: matterSubfolderId(M.valsara, "Pleadings & orders"), name: "Arbitration and Conciliation Act, 1996 (India Code)", url: "https://www.indiacode.nic.in/", description: "Official text of the Act governing the Valsara arbitration (Arb. Ref. 14/2024); check amendments before citing.", tags: ["arbitration", "statute"], matterId: M.valsara, practiceArea: "Commercial", ownerId: P.meeraLobo },
  { id: "lib_link_bluewater_dataroom", parentId: matterSubfolderId(M.harbor, "Data room"), name: "Bluewater Analytics virtual data room (Datasite)", url: "https://app.datasite.com/", description: "Project Harbor VDR. Folder 4.2 Material Contracts; 6.1 IP assignments; 8.3 Employee matters. Access managed by Dhruv Oberoi.", tags: ["data room", "diligence"], matterId: M.harbor, practiceArea: "Corporate / M&A", ownerId: P.dhruvOberoi },
];

function linkItems(): Item[] {
  return LINKS.map((l) => ({
    id: l.id,
    parentId: l.parentId,
    name: l.name,
    type: "link",
    url: l.url,
    description: l.description,
    tags: l.tags,
    matterId: l.matterId,
    practiceArea: l.practiceArea,
    ownerId: l.ownerId ?? P.aishaKhan,
    sharedWith: l.matterId ? ["matter-team"] : ["firm"],
    status: "approved",
    starred: l.starred,
    createdAt: "2024-04-01T09:00:00Z",
    updatedAt: "2026-06-12T09:00:00Z",
  }));
}

interface UploadSeed { id: string; parentId: string; name: string; description: string; content: string; tags: string[]; matterId?: string; practiceArea?: PracticeArea; ownerId: string; size: number; createdAt: string }

const UPLOADS: UploadSeed[] = [
  {
    id: "lib_upload_hale_vol2_rough", parentId: matterSubfolderId(M.valsara, "Depositions"), name: "Hegde Vol. II — rough ASCII transcript (2026-09-22).txt", ownerId: P.meeraLobo, matterId: M.valsara, practiceArea: "Products Liability", size: 412_884, createdAt: "2026-09-22T19:40:00Z",
    description: "Uploaded rough transcript from the transcription agency. Not certified; do not cite page:line until the final is delivered (expected 2026-10-01).",
    tags: ["upload", "transcript", "rough", "Hegde"],
    content: `# Upload: Hegde Vol. II rough ASCII

**Source:** Transcription agency rough draft, received 2026-09-22 18:55 IST. **Certified transcript expected:** 2026-10-01.

## Reviewer notes (M. Lobo)

- 214 pages. Examination by R. Kale (Claimant's counsel) 9:12 a.m.–4:48 p.m.; defended by A. Mehra.
- Exhibits marked Hegde 14–29. Hegde 22 is MFC-0041912 (Aug. 2016 EHS memo) — the "no adverse findings" passage is at rough pp. 131–139.
- Rough pp. 88–94: Hegde places the 2011 bioassay summary on Vasudevan's desk "sometime that fall"; compare Vasudevan Vol. I 76:3–15 (Vasudevan says she "never received" a written summary). Flagged for the conflicts register.
- Rough pp. 172–178: instruction not to answer (privilege) on the Kapur/Sood Clause 9.4 discussion — record preserved; expect an application to the Tribunal from the Claimant.

The rough text is retained in the e-discovery workspace under deposition "Hegde Vol. II (rough)"; this note is the library placeholder.`,
  },
  {
    id: "lib_upload_mfc_vol014_loadfile", parentId: matterSubfolderId(M.valsara, "Discovery"), name: "MFC production volume 014 — load file QC notes.xlsx", ownerId: P.tanmayBhatt, matterId: M.valsara, practiceArea: "Products Liability", size: 1_284_112, createdAt: "2026-09-18T15:10:00Z",
    description: "QC checklist for production volume MFC-VOL014 (MFC-0102001 – MFC-0118440): field validation, privilege screen hits, family integrity, slip-sheet counts.",
    tags: ["upload", "production", "QC", "load file"],
    content: `# Upload: MFC-VOL014 load file QC

| Check | Result |
| --- | --- |
| Bates range | MFC-0102001 – MFC-0118440 (16,440 pages; 4,812 documents) |
| Family integrity | Pass (0 orphaned attachments) |
| Privilege screen (attorney names + terms) | 37 hits reviewed; 9 withheld; 3 redacted; log entries drafted |
| Metadata fields (25-field spec) | Pass |
| Natives | 212 spreadsheets, 41 presentations produced natively with slip sheets |
| Confidentiality stamps | 4,290 Confidential; 522 AEO (formulation records) |
| Text extraction | 14 documents OCR'd (scanned lab notebooks) |
| Delivered | 2026-09-18 via SFTP to the Claimant's vendor; hash manifest attached |

Open item: three AEO-designated batch records (MFC-0117702–0117709) were requested by the Claimant for its toxicology expert; disclosure under Procedural Order No. 2 ¶ 5(d) pending.`,
  },
  {
    id: "lib_upload_roland_2024_bmj", parentId: matterSubfolderId(M.depo, "Science & literature"), name: "Roland et al. (2024) BMJ — progestogens and meningioma (PDF) — key excerpts", ownerId: P.sameerChawla, matterId: M.depo, practiceArea: "Products Liability", size: 2_106_330, createdAt: "2026-08-14T11:20:00Z",
    description: "Uploaded PDF of the French national case-control study relied on by plaintiffs' epidemiologist; excerpts and reviewer notes for Science Day preparation.",
    tags: ["upload", "epidemiology", "meningioma", "Depo-Provera"],
    content: `# Upload: Roland et al., BMJ 2024;384:e078078 — reviewer excerpts

**Design:** Nationwide French case-control study (SNDS data), 18,061 women who underwent intracranial meningioma surgery (2009–2018) matched 1:5 to controls.

**Reported association for medroxyprogesterone acetate (injectable):** odds ratio 5.55 (95% CI 2.27 to 13.56) for prolonged use; based on a small number of exposed cases.

## Points for cross-examination / rebuttal

1. Exposed-case count for injectable MPA is small; the confidence interval is wide.
2. Exposure ascertained from reimbursement records — no dose or indication data; no information on duration before 2006.
3. Surgery as the case definition selects for symptomatic, larger tumors; incidental meningiomas excluded.
4. Confounding by indication (endometriosis, contraception vs. oncology use) addressed only partially.
5. The authors themselves characterize the MPA finding as requiring confirmation.

Full PDF stored in the matter workspace; this placeholder holds the excerpts for search.`,
  },
  {
    id: "lib_upload_bluewater_dr_index", parentId: matterSubfolderId(M.harbor, "Data room"), name: "Bluewater data room index export (2026-09-19).xlsx", ownerId: P.dhruvOberoi, matterId: M.harbor, practiceArea: "Corporate / M&A", size: 388_220, createdAt: "2026-09-19T17:05:00Z",
    description: "Datasite index export: 1,842 documents across 11 top-level folders; used by the diligence tracker workflow to flag missing exhibits and unsigned amendments.",
    tags: ["upload", "data room", "diligence", "index"],
    content: `# Upload: Bluewater VDR index (2026-09-19)

| Folder | Documents | Flags |
| --- | --- | --- |
| 1. Corporate | 96 | — |
| 2. Financial | 214 | Q2 2026 management accounts not yet uploaded |
| 3. Tax | 58 | — |
| 4. Material contracts | 402 | 4.2.17 Aurora Health MSA missing Exhibit B; 4.2.31 Snowfield reseller agreement auto-renews 2026-10-31; 4.2.44 AWS enterprise agreement amendment unsigned |
| 5. Customers | 311 | 3 of top-20 contracts contain change-of-control consent rights |
| 6. Intellectual property | 187 | 6.1 assignment chain for Core ML Models: 2 of 7 developers' assignments unsigned |
| 7. Employment | 244 | — |
| 8. Litigation | 12 | — |
| 9. Real estate | 27 | — |
| 10. Insurance | 41 | R&W binder draft received 2026-09-17 |
| 11. Regulatory / privacy | 250 | — |`,
  },
  {
    id: "lib_upload_sterling_payroll_summary", parentId: matterSubfolderId(M.sterling, "Payroll analysis"), name: "Sterling Medical — Kronos payroll export summary (14 clinics).csv", ownerId: P.sameerChawla, matterId: M.sterling, practiceArea: "Employment", size: 5_412_990, createdAt: "2026-09-12T13:30:00Z",
    description: "Summary statistics from the Kronos export (2025-08-11 to 2026-08-10): punch rounding incidence, meal-period compliance rate and premium payments by clinic. Underlying CSV in the matter workspace.",
    tags: ["upload", "payroll", "PAGA", "analysis"],
    content: `# Upload: Kronos export summary — Sterling Medical

**Period:** 2025-08-11 – 2026-08-10 (one-year PAGA lookback). **Employees:** 641 non-exempt across 14 clinics. **Pay periods:** 26 (bi-weekly).

| Clinic | Employees | Meal periods > 5 hrs without 30-min break | Premiums paid | Rounding in effect |
| --- | --- | --- | --- | --- |
| Glendale | 58 | 6.4% | 41% of violations | No (punch-to-punch since 2023-03) |
| Burbank | 44 | 9.1% | 22% | No |
| Pasadena | 51 | 3.8% | 88% | No |
| Long Beach | 62 | 11.7% | 12% | Yes (7-minute, until 2026-02) |
| Torrance | 39 | 4.2% | 79% | No |
| Other 9 clinics (aggregate) | 387 | 5.9% | 47% | Mixed |

Preliminary exposure (before caps): approx. $1.9M in penalties; with 30% cap for reasonable steps within 60 days, approx. $570K. Model in the damages workbook.`,
  },
];

function uploadItems(): Item[] {
  return UPLOADS.map((u) => ({
    id: u.id,
    parentId: u.parentId,
    name: u.name,
    type: "note",
    description: u.description,
    content: u.content,
    tags: u.tags,
    matterId: u.matterId,
    practiceArea: u.practiceArea,
    ownerId: u.ownerId,
    sharedWith: ["matter-team"],
    status: "draft",
    version: 1,
    size: u.size,
    createdAt: u.createdAt,
    updatedAt: u.createdAt,
  }));
}

const MATTER_NOTES: { id: string; parentId: string; name: string; description: string; content: string; tags: string[]; matterId: string; practiceArea: PracticeArea; ownerId: string; createdAt: string; updatedAt: string; starred?: boolean }[] = [
  {
    id: "lib_note_vls_voss_admissions", parentId: matterSubfolderId(M.valsara, "Depositions"), name: "Vasudevan Vol. I — key admissions and follow-ups", ownerId: P.eshaMathur, matterId: M.valsara, practiceArea: "Products Liability", createdAt: "2026-06-12T20:00:00Z", updatedAt: "2026-09-15T16:30:00Z", starred: true,
    description: "Working notes from the Vasudevan (Senior Toxicologist) deposition: admissions, themes and follow-ups for Vol. II and for the Sundaram rebuttal report.",
    tags: ["Vasudevan", "deposition", "admissions", "toxicology"],
    content: `# Vasudevan Vol. I (2026-06-11) — working notes

## Helpful testimony

- 41:8–42:3 — Confirms the 2011 bioassay used a dose range "well above any realistic human exposure" and that the study design was reviewed by an external CRO.
- 76:3–15 — "I never received a written summary of the bioassay from Girish [Hegde]. We discussed it in the stewardship meeting." (Conflicts with Hegde Vol. II rough pp. 88–94 — see conflicts register C-09.)
- 118:22–119:14 — Agrees that CPCB's 2009 provisional guidance value was "public knowledge in the industry" by the time of the 2011 study; supports the corroborative-information position on Clause 9.4.
- 143:1–20 — Cannot identify any MF-3 sold directly to the Park's member units after 2006; refers to Bose for sales records.

## Harmful testimony

- 97:5–98:11 — Concedes she "would have wanted to know" the lower-dose results before signing the 2016 product stewardship statement. Expect the Claimant to pair with MFC-0041912.
- 160:14–161:2 — "Repellent-finish chemistry was our whole business" — undercuts the sophisticated-purchaser theme if used out of context.

## Follow-ups for Vol. II

1. Establish the internal peer-review path for the 2011 results (who saw the CRO report, when).
2. Walk through the 2016 EHS memo paragraph by paragraph; get Vasudevan to place "no adverse findings" in the regulatory-submission context.
3. Confirm she had no role in Aqua-Guard formulation or sales.

## For the Sundaram rebuttal report

Vasudevan's dose-range testimony (41:8–42:3) should be quoted in the rebuttal to the Claimant's extrapolation from the rodent data.`,
  },
  {
    id: "lib_note_northgate_msj_themes", parentId: matterSubfolderId(M.northgate, "Briefing"), name: "MSJ opposition — themes and record cites", ownerId: P.dhruvOberoi, matterId: M.northgate, practiceArea: "Commercial", createdAt: "2026-09-02T14:00:00Z", updatedAt: "2026-09-21T18:20:00Z",
    description: "Outline of the opposition to Apex's motion for summary judgment (due 2026-10-09): three themes with record cites and the Rule 56.1 response plan.",
    tags: ["Northgate", "summary judgment", "opposition", "outline"],
    content: `# Opposition to Apex MSJ — outline (due 2026-10-09)

## Theme 1 — The cargo carve-out is unambiguous

MTSA § 14.2 excludes from the consequential-damages waiver "Carrier's liability for loss of or damage to cargo ... determined in accordance with Section 8.4." The Joliet cross-dock losses ($2.1M, NG-000112–NG-000198 inventory reconciliation) are cargo losses. Apex's brief never quotes § 8.4.

- Record: MTSA § 8.4 (Ex. A at 14); inventory reconciliation (Ex. D); Apex claims adjuster email conceding "shortage in Apex custody" (NG-000276).

## Theme 2 — Whether the Aurora Foods losses are direct damages is a fact question

Schedule B priced the Aurora lane separately (Ex. A, Sched. B, line 7). Under Illinois law, lost profits on the contract itself are direct damages; profits on collateral transactions are consequential (Westlake). The Aurora lane was the contract.

- Record: Schedule B; Aurora termination letter citing "repeated service failures at Joliet" (NG-000402); Northgate CFO declaration on lane-level margin.

## Theme 3 — Willful misconduct takes the loss outside the waiver

The 2026-01-08 dispatch chain ("run it anyway, we'll sort the seals later," NG-000341–347) and the seal-log gaps (Ex. F) support willful and wanton conduct; Illinois will not enforce an exculpatory clause for it. At minimum a jury question.

## Rule 56.1 plan

- Respond to each of Apex's 48 statements; dispute 14 with record cites; add 31 additional facts (keep under the 40-fact limit in Judge Ellis's standing order).
- Exhibits A–K; declaration of Northgate CFO (M. Sandoval); declaration of ops director (K. Reyes).

## Open

- Whether to cross-move on liability for the cargo count (recommend no — keep the opposition focused).
- Confirm Judge Ellis's page limit for the opposition (15 pages under LR 7.1 unless leave granted) — motion for leave to file 25 pages to be filed by 2026-09-30.`,
  },
  {
    id: "lib_note_harbor_ip_chain", parentId: matterSubfolderId(M.harbor, "Diligence memos"), name: "Core ML Models — IP assignment chain memo", ownerId: P.sameerChawla, matterId: M.harbor, practiceArea: "Corporate / M&A", createdAt: "2026-09-10T10:00:00Z", updatedAt: "2026-09-19T15:00:00Z",
    description: "Diligence memo on the chain of title for Bluewater's seven core ML models: developers, assignment status, open-source dependencies and recommended SPA protections.",
    tags: ["IP", "assignment", "diligence", "Project Harbor"],
    content: `# Core ML Models — chain of title

## Summary

Bluewater identifies seven models as its core IP (Schedule 1.1(c)). Five have complete written assignments from every contributor. Two (the "Harbor-Risk" scoring model and the "Tidewater" anomaly detector) were developed in part by two contractors (2021–2022) whose services agreements contain a **license**, not an assignment, and no present-tense "hereby assigns" language.

## Findings

| Model | Contributors | Assignment status | Risk |
| --- | --- | --- | --- |
| Harbor-Risk | 4 employees, 1 contractor (L. Ferreira) | Contractor: license only | High |
| Tidewater | 3 employees, 1 contractor (Ossining Labs LLC) | Contractor: no IP clause | High |
| Other five | Employees only | PIIAs signed at hire; assignments confirmed | Low |

Open-source: the Tidewater model's training pipeline uses two AGPL-licensed components; the deployed inference service does not, but the pipeline is delivered to two enterprise customers under on-premise licenses. Needs a remediation plan.

## Recommendations

1. Closing condition: executed confirmatory IP assignments from Ferreira and Ossining Labs (drafts prepared, Transaction documents folder).
2. Special indemnity in the SPA for losses arising from any defect in the chain of title to the Core ML Models, not subject to the basket or the general cap; escrow $6M for 24 months.
3. MAE carve-back (ii) in the firm's MAE definition covers a determination that the models are not owned; keep it or convert to a stand-alone condition (see Clause bank → MAE definition).
4. R&W insurance: expect the underwriter to exclude the two flagged models unless assignments are obtained pre-signing.`,
  },
];

function matterNoteItems(): Item[] {
  return MATTER_NOTES.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    type: "note",
    description: n.description,
    content: n.content,
    tags: n.tags,
    matterId: n.matterId,
    practiceArea: n.practiceArea,
    ownerId: n.ownerId,
    sharedWith: ["matter-team"],
    status: "draft",
    version: 2,
    size: n.content.length,
    starred: n.starred,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  }));
}

const FIRM_NOTES: Item[] = [
  {
    id: "lib_note_firm_conflicts_policy", parentId: "lib_folder_firm_policies", name: "Conflicts check and new-matter intake policy", type: "note", ownerId: P.aishaKhan, sharedWith: ["firm"], status: "approved", version: 3, createdAt: "2023-03-01T09:00:00Z", updatedAt: "2026-01-15T09:00:00Z", tags: ["policy", "conflicts", "intake"],
    description: "Firm policy: conflicts search scope, waiver letters, lateral screening, and the new-matter form.",
    content: `# Conflicts check and new-matter intake

1. **Before any substantive work**, run the conflicts search on all parties, affiliates, adverse parties, opposing counsel and key witnesses. Search results are attached to the new-matter form.
2. Direct adversity to a current client requires informed written consent from both clients (Rule 1.7). Material-limitation conflicts require the partner in charge to document the analysis.
3. Lateral hires are screened on arrival; the screen memo lists matters and the lateral's prior clients. Screened matters are flagged in the library and e-discovery workspaces.
4. Engagement letters go out within five business days of intake using the Engagement letter template; scope limitations must be explicit.
5. Matter folders are created by KM from the intake form; the lead attorney sets the sharing level (matter team by default).`,
  },
  {
    id: "lib_note_firm_ai_use_policy", parentId: "lib_folder_firm_policies", name: "Generative AI use policy (v3)", type: "note", ownerId: P.aishaKhan, sharedWith: ["firm"], status: "approved", version: 3, createdAt: "2024-06-01T09:00:00Z", updatedAt: "2026-07-01T09:00:00Z", tags: ["policy", "AI", "ethics"], starred: true,
    description: "How lawyers and staff may use the platform's AI assistants: verification duties, confidentiality, court disclosure rules, and billing.",
    content: `# Generative AI use policy (v3)

## Permitted

- Drafting, summarizing, reviewing and researching with the platform's Office agents, Search agent and workflows. All calls run through the firm's OpenAI enterprise account with zero data retention.
- Uploading client documents to the platform (they stay in the firm's environment).

## Required

1. **Verify every citation, quotation and record cite.** The [VERIFY] marker must be cleared by a human using the citation checker or the source before any filing or client delivery.
2. Review agent-proposed edits before accepting them; tracked changes are the record of what the agent did.
3. Comply with any court's AI disclosure or certification requirement (check the judge's standing order; several N.D. Ill. judges require certification).
4. Bill only for time actually spent; the agent's activity log is not billable time.

## Prohibited

- Using consumer AI tools (personal ChatGPT accounts, browser extensions) with any client information.
- Filing or sending an AI-drafted document without attorney review.
- Entering privileged material into the web-search-enabled mode unless the research toggle is necessary and the content is not confidential.

Questions: Aisha Khan (KM) or the General Counsel.`,
  },
  {
    id: "lib_note_firm_prod_specs", parentId: "lib_folder_firm_forms", name: "Standard production specifications (25-field load file)", type: "note", ownerId: P.tanmayBhatt, sharedWith: ["firm"], status: "approved", version: 5, createdAt: "2023-08-15T09:00:00Z", updatedAt: "2026-05-05T09:00:00Z", tags: ["e-discovery", "production", "load file", "form"],
    description: "The firm's default production format and metadata field list for ESI protocols.",
    content: `# Standard production specifications

**Images:** single-page Group IV TIFF, 300 dpi, black and white; color JPEG where color is necessary to understand the document. **Text:** document-level extracted text (OCR for images and redacted documents). **Load files:** Opticon (.opt) image load file and Concordance (.dat) metadata load file with standard delimiters. **Natives:** spreadsheets, presentations, audio/video and any file that cannot be reasonably imaged, with a slip sheet.

## Metadata fields

BegBates · EndBates · BegAttach · EndAttach · Custodian · AllCustodians · From · To · CC · BCC · Subject · DateSent · TimeSent · DateReceived · FileName · FileExt · FileSize · DateCreated · DateLastModified · Author · MD5Hash · NativeLink · TextLink · Confidentiality · RedactionFlag

Time zone: UTC, stated in the protocol. Families produced together; parent-child relationships preserved through BegAttach/EndAttach.`,
  },
];

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------
const ACTIVITY: ActivityEntry[] = [
  { id: "lact_001", itemId: "lib_note_vls_po3", itemName: "Arb. Ref. 14/2024 — Procedural Order No. 3 summary", actorId: P.arjunMehra, actorName: "Arjun Mehra", action: "updated", detail: "Added open issue 3 (Vasudevan Vol. II timing).", at: "2026-09-16T18:45:00Z" },
  { id: "lact_002", itemId: "lib_clause_vls_definitions", itemName: "MC-8 / Aqua-Guard definitions for document requests (Redfern schedule)", actorId: P.priyaRaman, actorName: "Priya Raman", action: "updated", detail: "Added MC-7 to definition 1.", at: "2026-09-18T18:00:00Z" },
  { id: "lact_003", itemId: "lib_upload_mfc_vol014_loadfile", itemName: "MFC production volume 014 — load file QC notes.xlsx", actorId: P.tanmayBhatt, actorName: "Tanmay Bhatt", action: "uploaded", detail: "1.2 MB", at: "2026-09-18T15:10:00Z" },
  { id: "lact_004", itemId: "lib_upload_bluewater_dr_index", itemName: "Bluewater data room index export (2026-09-19).xlsx", actorId: P.dhruvOberoi, actorName: "Dhruv Oberoi", action: "uploaded", detail: "388 KB", at: "2026-09-19T17:05:00Z" },
  { id: "lact_005", itemId: "lib_note_depo_objections", itemName: "Deposition objection quick reference", actorId: P.arjunMehra, actorName: "Arjun Mehra", action: "updated", detail: "Errata section: added sham-correction note.", at: "2026-09-19T08:00:00Z" },
  { id: "lact_006", itemId: "lib_clause_depo_stipulations", itemName: "Standard deposition stipulations (on the record)", actorId: P.arjunMehra, actorName: "Arjun Mehra", action: "inserted", detail: "Inserted into Vasudevan Vol. II outline", at: "2026-09-19T08:10:00Z" },
  { id: "lact_007", itemId: "lib_note_harbor_ip_chain", itemName: "Core ML Models — IP assignment chain memo", actorId: P.sameerChawla, actorName: "Sameer Chawla", action: "updated", detail: "Added open-source finding.", at: "2026-09-19T15:00:00Z" },
  { id: "lact_008", itemId: "lib_note_hsr_basics", itemName: "HSR filing basics for Project Harbor", actorId: P.dhruvOberoi, actorName: "Dhruv Oberoi", action: "updated", detail: "Filing fee tier and gun-jumping section.", at: "2026-09-20T11:00:00Z" },
  { id: "lact_009", itemId: "lib_note_northgate_msj_themes", itemName: "MSJ opposition — themes and record cites", actorId: P.dhruvOberoi, actorName: "Dhruv Oberoi", action: "updated", detail: "Rule 56.1 plan and page-limit motion.", at: "2026-09-21T18:20:00Z" },
  { id: "lact_010", itemId: "lib_upload_hale_vol2_rough", itemName: "Hegde Vol. II — rough ASCII transcript (2026-09-22).txt", actorId: P.meeraLobo, actorName: "Meera Lobo", action: "uploaded", detail: "412 KB · rough transcript", at: "2026-09-22T19:40:00Z" },
  { id: "lact_011", itemId: "lib_clause_mae_definition", itemName: "Material Adverse Effect definition (buyer-favorable)", actorId: P.dhruvOberoi, actorName: "Dhruv Oberoi", action: "created", detail: "Draft for Project Harbor SPA", at: "2026-08-04T14:00:00Z" },
  { id: "lact_012", itemId: "lib_note_vls_voss_admissions", itemName: "Vasudevan Vol. I — key admissions and follow-ups", actorId: P.eshaMathur, actorName: "Esha Mathur", action: "starred", at: "2026-09-15T16:31:00Z" },
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function seedLibrary(db: Database) {
  const clauses = clauseItems();
  const items: Item[] = [...buildFolders(db), ...templateItems(), ...clauses.items, ...noteItems(), ...linkItems(), ...uploadItems(), ...matterNoteItems(), ...FIRM_NOTES];
  db.library.putMany(items);
  db.collection<ClauseMeta>(LIBRARY_COLLECTIONS.clauseMeta).putMany(clauses.meta);
  db.collection<ActivityEntry>(LIBRARY_COLLECTIONS.activity).putMany(ACTIVITY);
  // Keyword index for every textual item (embeddings are added by POST /api/library/index when a key exists).
  // The library is a tenant-wide corpus; matter work product keeps its matterId on the row (constitution §22).
  void indexDocuments(VECTOR_COLLECTIONS.library, items.filter((i) => i.type !== "folder").map((i) => ({ id: i.id, text: indexTextFor(i), matterId: i.matterId ?? null, meta: { type: i.type, matterId: i.matterId, practiceArea: i.practiceArea, parentId: i.parentId } })), { embed: false, scope: { tenantId: configuredTenantId(), corpus: "library" } }).catch((e) => console.error("[seed:library] index", e));
}

export const LIBRARY_SEED_IDS = {
  folders: LIBRARY_FOLDERS,
  templates: TEMPLATES.map((t) => t.id),
  clauses: SEED_CLAUSES.map((c) => c.id),
  notes: SEED_NOTES.map((n) => n.id),
  links: LINKS.map((l) => l.id),
  uploads: UPLOADS.map((u) => u.id),
  matterNotes: MATTER_NOTES.map((n) => n.id),
  firmNotes: FIRM_NOTES.map((n) => n.id),
};
