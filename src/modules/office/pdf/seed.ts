import "server-only";
import type { Database } from "@/lib/db";
import type { LibraryItem, OfficeComment, OfficeDocument, OfficeVersion } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";
import { matterFolderId } from "@/modules/library/ids";
import { emptyModel, type PdfAnnotation, type PdfModel } from "./model";

/**
 * Seed PDF documents. Records (documents, versions, comments, library items)
 * are written synchronously with stable ids; the PDF bytes themselves are
 * generated with pdf-lib and text-extracted by `materialize()` — kicked off
 * here in the background and otherwise triggered on first open. Annotations
 * are seeded with the quoted text they attach to; their rectangles are
 * resolved against the extraction when the document is materialized.
 */

const USER = { id: PEOPLE.arjunMehra, name: "Arjun Mehra" };
const AGENT = "Drafting assistant";

interface SeedPdfDoc {
  id: string;
  blobId: string;
  title: string;
  specId: string;
  matterId: string;
  createdAt: string;
  tags: string[];
  annotations: PdfAnnotation[];
  bates?: PdfModel["bates"];
  bookmarks?: PdfModel["bookmarks"];
  versions: { id: string; label?: string; summary: string; author?: string; createdAt: string }[];
  comments: OfficeComment[];
  libraryId: string;
  size: number;
}

const ann = (id: string, page: number, type: PdfAnnotation["type"], quote: string, extra: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id, page, type, rects: [], quote, color: extra.color ?? ({ highlight: "#FACC15", note: "#FACC15", stamp: "#B91C1C", redaction: "#111111", underline: "#EF4444", strikeout: "#EF4444", text: "#111111", rect: "#EF4444", ellipse: "#2563EB", freehand: "#2563EB", link: "#2563EB", signature: "#111111" } as Record<string, string>)[type] ?? "#FACC15", opacity: extra.opacity ?? (type === "highlight" ? 0.4 : type === "stamp" ? 0.9 : 1), author: extra.author ?? USER.name, createdAt: extra.createdAt ?? "2026-09-18T14:12:00.000Z", ...extra,
});

const DOCS: SeedPdfDoc[] = [
  {
    id: "odoc_pdf_cmo26",
    blobId: "blob_pdf_cmo26",
    title: "Procedural Order No. 5 — Tier 2 custodial production",
    specId: "cmo-excerpt",
    matterId: MATTERS.valsara,
    createdAt: "2026-09-22T19:40:00.000Z",
    tags: ["procedural order", "disclosure", "deadlines"],
    size: 92_000,
    annotations: [
      ann("an_cmo_h1", 1, "highlight", "no later than October 14, 2026", { text: "Search-term conference — calendar with Tanmay", createdAt: "2026-09-22T20:02:00.000Z" }),
      ann("an_cmo_h2", 1, "highlight", "substantial completion by December 18, 2026", { color: "#4ADE80", text: "Substantial completion — same day as expert admissibility objections", createdAt: "2026-09-22T20:03:00.000Z" }),
      ann("an_cmo_h3", 1, "highlight", "recall estimate below 75%", { color: "#F472B6", text: "TAR validation threshold; discuss with vendor", author: "Esha Mathur", createdAt: "2026-09-23T08:15:00.000Z" }),
      ann("an_cmo_n1", 1, "note", "MFC-0060000", { text: "Confirm with Tanmay Bhatt that the production numbering resumes at MFC-0060000 and that the Tier 1 range ended at MFC-0059814.", createdAt: "2026-09-22T20:05:00.000Z" }),
      ann("an_cmo_s1", 1, "stamp", "Procedural Order No. 5", { text: "FILED", createdAt: "2026-09-22T19:45:00.000Z" }),
      ann("an_cmo_u1", 2, "underline", "Any dispute arising under this Order shall first be raised with the Tribunal Secretary", { text: "Tribunal Secretary route — five-page letter limit", author: "Esha Mathur", createdAt: "2026-09-23T08:20:00.000Z" }),
    ],
    bookmarks: [{ id: "bm_cmo_1", page: 1, title: "Tier 2 custodians" }, { id: "bm_cmo_2", page: 1, title: "Production schedule (table)" }, { id: "bm_cmo_3", page: 2, title: "Appendix A search terms" }],
    versions: [
      { id: "over_pdf_cmo26_2", summary: "Agent edit: highlighted every deadline and added a note on the Bates start number", author: AGENT, createdAt: "2026-09-22T20:05:30.000Z" },
      { id: "over_pdf_cmo26_3", label: "Reviewed by EM", summary: "Checkpoint before circulating to the team", createdAt: "2026-09-23T08:22:00.000Z" },
    ],
    comments: [
      { id: "ocm_pdf_cmo26_1", docId: "odoc_pdf_cmo26", anchor: "page:1", quote: "first production of no fewer than 40,000 documents by October 14, 2026", body: "Forty thousand documents by 10/14 is aggressive given the Vasudevan .pst volume. Tanmay — can the vendor confirm review throughput this week?", authorId: USER.id, authorName: USER.name, createdAt: "2026-09-22T20:10:00.000Z", source: "user", replies: [{ id: "r1", body: "Vendor says 2,400 docs/day/reviewer with TAR prioritization. With eight reviewers we clear 40k by 10/9 with margin.", authorName: "Tanmay Bhatt", createdAt: "2026-09-23T13:02:00.000Z" }] },
      { id: "ocm_pdf_cmo26_2", docId: "odoc_pdf_cmo26", anchor: "page:2", body: "Term A-7 (MW-7) will pull the entire Hegde environmental file. Suggest limiting to 2004–2008 or adding a proximity to MC-7/MC-8.", authorId: PEOPLE.eshaMathur, authorName: "Esha Mathur", createdAt: "2026-09-23T08:25:00.000Z", source: "user", replies: [] },
      { id: "ocm_pdf_cmo26_3", docId: "odoc_pdf_cmo26", anchor: "page:1", body: "Deadlines extracted to the matter calendar: Oct 14 (meet-and-confer + first production), Oct 21 (hit reports), Nov 4 (privilege log), Dec 18 (substantial completion), Jan 8 (TAR validation).", authorName: AGENT, createdAt: "2026-09-22T20:06:00.000Z", source: "agent", resolved: true, replies: [] },
    ],
    libraryId: "lib_pdf_cmo26",
  },
  {
    id: "odoc_pdf_protective_order",
    blobId: "blob_pdf_protective_order",
    title: "Meridian — Protective Order (two-tier)",
    specId: "protective-order",
    matterId: MATTERS.valsara,
    createdAt: "2026-09-10T15:05:00.000Z",
    tags: ["protective order", "confidentiality", "AEO"],
    size: 118_000,
    annotations: [
      ann("an_po_h1", 1, "highlight", "each party may designate up to two (2) in-house attorneys", { text: "Kapur + Sood are the two designees — confirm Exhibit A executed", createdAt: "2026-09-10T15:30:00.000Z" }),
      ann("an_po_h2", 2, "highlight", "shall not be uploaded to any generative AI service that retains or trains on inputs", { color: "#60A5FA", text: "Applies to the review platform vendor too — get written confirmation", author: "Priya Raman", createdAt: "2026-09-11T09:41:00.000Z" }),
      ann("an_po_n1", 2, "note", "Pursuant to Fed. R. Evid. 502(d)", { text: "502(d) order in place — clawback runs from written notice, 5 business days to return/destroy.", author: "Priya Raman", createdAt: "2026-09-11T09:44:00.000Z" }),
      ann("an_po_s1", 1, "stamp", "Stipulated Protective Order Governing", { text: "SUBJECT TO PROTECTIVE ORDER", createdAt: "2026-09-10T15:10:00.000Z" }),
    ],
    bookmarks: [{ id: "bm_po_1", page: 1, title: "Tier 1 — Confidential" }, { id: "bm_po_2", page: 2, title: "Tier 2 — AEO" }, { id: "bm_po_3", page: 3, title: "Exhibit A acknowledgment" }],
    versions: [
      { id: "over_pdf_po_2", summary: "Agent edit: bookmarked the two tiers and Exhibit A; highlighted the in-house designee limit", author: AGENT, createdAt: "2026-09-10T15:32:00.000Z" },
    ],
    comments: [
      { id: "ocm_pdf_po_1", docId: "odoc_pdf_protective_order", anchor: "page:2", quote: "AEO Material may not be disclosed to a party", body: "Reminder for the deposition team: Vasudevan cannot be shown AEO documents from other defendants' productions. Check the tier flag before loading exhibits.", authorId: PEOPLE.priyaRaman, authorName: "Priya Raman", createdAt: "2026-09-11T09:50:00.000Z", source: "user", replies: [] },
      { id: "ocm_pdf_po_2", docId: "odoc_pdf_protective_order", anchor: "page:3", body: "Exhibit A forms for Dr. Sundaram and Dr. Patel are signed and filed in the expert folder.", authorId: PEOPLE.meeraLobo, authorName: "Meera Lobo", createdAt: "2026-09-15T16:20:00.000Z", source: "user", resolved: true, replies: [] },
    ],
    libraryId: "lib_pdf_protective_order",
  },
  {
    id: "odoc_pdf_voss_depo_notice",
    blobId: "blob_pdf_voss_depo_notice",
    title: "Vasudevan deposition notice",
    specId: "deposition-notice",
    matterId: MATTERS.valsara,
    createdAt: "2026-09-19T21:12:00.000Z",
    tags: ["deposition", "Vasudevan", "notice"],
    size: 74_000,
    annotations: [
      ann("an_vn_h1", 1, "highlight", "Thursday, October 22, 2026, at 9:30 a.m. Eastern", { text: "Confirmed with Kale's office 9/19", createdAt: "2026-09-19T21:20:00.000Z" }),
      ann("an_vn_h2", 1, "highlight", "MFC-0119377", { color: "#F472B6", text: "The Clause 9.4 draft — prep Hema on this document first", createdAt: "2026-09-19T21:22:00.000Z" }),
      ann("an_vn_n1", 2, "note", "Schedule A", { text: "Items 1–3 were produced in Tier 1 (MFC-0102211, -0077102, -0119377). Item 5 calendars still outstanding — ask Meera to pull from the archive.", createdAt: "2026-09-19T21:25:00.000Z" }),
      ann("an_vn_s1", 1, "stamp", "Notice of Videotaped Deposition of", { text: "DRAFT", createdAt: "2026-09-19T21:13:00.000Z" }),
    ],
    versions: [
      { id: "over_pdf_vn_2", label: "Sent to opposing counsel", summary: "Checkpoint before service", createdAt: "2026-09-20T13:00:00.000Z" },
    ],
    comments: [
      { id: "ocm_pdf_vn_1", docId: "odoc_pdf_voss_depo_notice", anchor: "page:1", body: "Kale asked to push to 10/23 — I said no, we already moved once. Holding 10/22.", authorId: USER.id, authorName: USER.name, createdAt: "2026-09-20T13:05:00.000Z", source: "user", replies: [] },
    ],
    libraryId: "lib_pdf_voss_depo_notice",
  },
  {
    id: "odoc_pdf_northgate_msa",
    blobId: "blob_pdf_northgate_msa",
    title: "Northgate MSA excerpt (Arts. 7, 9, 12)",
    specId: "northgate-msa-excerpt",
    matterId: MATTERS.northgate,
    createdAt: "2026-09-08T17:48:00.000Z",
    tags: ["MSA", "limitation of liability", "termination"],
    size: 88_000,
    annotations: [
      ann("an_ng_h1", 1, "highlight", "Service Credits are Northgate's sole and exclusive monetary remedy", { text: "Apex will lead with this — but 7.4 and Art. 12 carve-outs control", author: "Dhruv Oberoi", createdAt: "2026-09-08T18:02:00.000Z" }),
      ann("an_ng_h2", 1, "highlight", "shall constitute a \"Chronic Failure\" entitling Northgate to terminate this Agreement for cause under Section 9.2 without the cure period", { color: "#4ADE80", text: "Three months below 97% in Q1–Q2 2025 — chronic failure triggered", author: "Dhruv Oberoi", createdAt: "2026-09-08T18:04:00.000Z" }),
      ann("an_ng_u1", 2, "underline", "EXCEPT FOR THE MATTERS EXCLUDED IN SECTION 12.1(a) THROUGH (d)", { text: "Cap carve-outs: gross negligence and cargo loss are outside the 12-month cap", author: "Dhruv Oberoi", createdAt: "2026-09-08T18:06:00.000Z" }),
      ann("an_ng_n1", 2, "note", "Termination for Cause", { text: "Notice defect argument: Apex says our 4/2 letter went to the wrong address under 15.3. Chronic Failure route needs no cure period but still needs notice.", author: "Dhruv Oberoi", createdAt: "2026-09-08T18:10:00.000Z" }),
    ],
    bookmarks: [{ id: "bm_ng_1", page: 1, title: "Art. 7 — Service levels" }, { id: "bm_ng_2", page: 1, title: "Art. 9 — Termination" }, { id: "bm_ng_3", page: 2, title: "Art. 12 — Limitation of liability" }],
    versions: [
      { id: "over_pdf_ng_2", summary: "Agent edit: bookmarked Articles 7, 9 and 12", author: AGENT, createdAt: "2026-09-08T17:55:00.000Z" },
    ],
    comments: [
      { id: "ocm_pdf_ng_1", docId: "odoc_pdf_northgate_msa", anchor: "page:2", quote: "SHALL NOT EXCEED THE FEES PAID OR PAYABLE", body: "Twelve-month trailing fees are roughly $6.1M per the finance model. Lost-profit claim only survives if we plead gross negligence — see 12.1(c).", authorId: PEOPLE.dhruvOberoi, authorName: "Dhruv Oberoi", createdAt: "2026-09-08T18:15:00.000Z", source: "user", replies: [{ id: "r1", body: "Agreed. The dispatcher logs from APEX-0003310 onward support a gross negligence theory on the Q2 misroutes.", authorName: USER.name, createdAt: "2026-09-09T11:30:00.000Z" }] },
    ],
    libraryId: "lib_pdf_northgate_msa",
  },
  {
    id: "odoc_pdf_hale_production",
    blobId: "blob_pdf_hale_production",
    title: "MFC-0060000 — Hegde custodial excerpt (MW-7 thread)",
    specId: "custodial-excerpt",
    matterId: MATTERS.valsara,
    createdAt: "2026-09-23T14:30:00.000Z",
    tags: ["production", "redaction", "PII", "privilege"],
    size: 64_000,
    annotations: [
      ann("an_hp_r1", 1, "redaction", "412-55-8367", { reason: "SSN", createdAt: "2026-09-23T14:40:00.000Z" }),
      ann("an_hp_r2", 1, "redaction", "account no. 4471029835", { reason: "Financial account", createdAt: "2026-09-23T14:41:00.000Z" }),
      ann("an_hp_h1", 1, "highlight", "privileged and confidential — prepared at the direction of counsel", { color: "#F472B6", text: "Privilege call needed before production — Kapur is on the thread", createdAt: "2026-09-23T14:42:00.000Z" }),
      ann("an_hp_h2", 1, "highlight", "MW-7", { text: "MW-7 exceedance — third consecutive quarter", createdAt: "2026-09-23T14:43:00.000Z" }),
      ann("an_hp_n1", 1, "note", "DOB 03/14/1971", { text: "Also redact DOB, cell and personal e-mail of the contractor under Procedural Order No. 5 ¶ 6 (REDACTED – PII).", author: "Meera Lobo", createdAt: "2026-09-23T15:05:00.000Z" }),
      ann("an_hp_s1", 1, "stamp", "MW-7 quarterly results", { text: "CONFIDENTIAL", createdAt: "2026-09-23T14:35:00.000Z" }),
    ],
    versions: [
      { id: "over_pdf_hp_2", summary: "Agent edit: proposed redactions for the SSN and bank account number; highlighted the privilege marker", author: AGENT, createdAt: "2026-09-23T14:44:00.000Z" },
    ],
    comments: [
      { id: "ocm_pdf_hp_1", docId: "odoc_pdf_hale_production", anchor: "page:1", quote: "Please treat this thread as privileged and confidential", body: "Kapur is cc'd but the substance is a business decision about the GPCB letter. Likely not privileged in full — consider producing with the legal-advice sentence redacted rather than withholding.", authorId: USER.id, authorName: USER.name, createdAt: "2026-09-23T15:10:00.000Z", source: "user", replies: [] },
      { id: "ocm_pdf_hp_2", docId: "odoc_pdf_hale_production", anchor: "page:3", body: "Lab table is responsive and non-privileged; produce in full. Bates MFC-0060002.", authorId: PEOPLE.tanmayBhatt, authorName: "Tanmay Bhatt", createdAt: "2026-09-23T16:00:00.000Z", source: "user", replies: [] },
    ],
    libraryId: "lib_pdf_hale_production",
  },
];

export const SEEDED_PDF_DOC_IDS = DOCS.map((d) => d.id);

/** Seed sample PDF documents (stable ids, idempotent). */
export function seedPdf(db: Database) {
  const docs: OfficeDocument[] = [];
  const versions: OfficeVersion[] = [];
  const comments: OfficeComment[] = [];
  const items: LibraryItem[] = [];
  for (const d of DOCS) {
    const existing = db.officeDocs.get(d.id);
    const existingModel = existing?.content as PdfModel | undefined;
    // Keep an already-materialized document (bytes + extraction) intact; only refresh metadata.
    const model: PdfModel = existingModel && !existingModel.meta?.pending && existingModel.sourceBlobId && db.blobs.meta(existingModel.sourceBlobId)
      ? existingModel
      : { ...emptyModel(), annotations: d.annotations, bates: d.bates, bookmarks: d.bookmarks, meta: { pending: true, specId: d.specId, blobId: d.blobId, title: d.title, seeded: true } };
    const updatedAt = d.versions.at(-1)?.createdAt ?? d.createdAt;
    docs.push({ id: d.id, kind: "pdf", title: d.title, matterId: d.matterId, folderId: matterFolderId(d.matterId), content: model, contentVersion: d.versions.length + 1, createdAt: d.createdAt, updatedAt: existing?.updatedAt && existing.updatedAt > updatedAt ? existing.updatedAt : updatedAt, createdById: USER.id, updatedById: USER.id, tags: d.tags, meta: { seeded: true, originalName: `${d.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-")}.pdf` }, size: d.size });
    versions.push({ id: `over_pdf_${d.id.replace(/^odoc_pdf_/, "")}_1`, docId: d.id, version: 1, label: "Created", summary: "Imported PDF", authorId: USER.id, authorName: USER.name, createdAt: d.createdAt, content: { ...model, annotations: [], bookmarks: undefined } });
    d.versions.forEach((v, i) => versions.push({ id: v.id, docId: d.id, version: i + 2, label: v.label, summary: v.summary, authorId: v.author ? undefined : USER.id, authorName: v.author ?? USER.name, createdAt: v.createdAt, content: model, changedFields: d.annotations.length }));
    comments.push(...d.comments);
    items.push({ id: d.libraryId, parentId: matterFolderId(d.matterId), name: d.title, type: "pdf", matterId: d.matterId, officeDocId: d.id, size: d.size, tags: d.tags, ownerId: USER.id, sharedWith: ["firm"], createdAt: d.createdAt, updatedAt, description: `${d.annotations.length} annotations · ${d.comments.length} comments` });
  }
  db.officeDocs.putMany(docs);
  db.officeVersions.putMany(versions);
  db.officeComments.putMany(comments);
  db.library.putMany(items);
  // Generate the PDFs in the background so the documents open instantly; materialize() is idempotent and also runs on first open.
  scheduleMaterialization();
}

let scheduled = false;
function scheduleMaterialization() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    void (async () => {
      const { materialize } = await import("./service");
      for (const d of DOCS) {
        try { await materialize(d.id); } catch (e) { console.warn(`[seed:pdf] could not generate ${d.id}:`, (e as Error).message); }
      }
    })();
  }, 50);
}
