import { describe, expect, it } from "vitest";
import type { StoredReview } from "@/modules/documents/server/store";
import { headerOnlyQuote, processReviewWindow } from "@/modules/documents/server/review-run";

const EMAIL = "From: Anil Rao <anil.rao@sahyadristeels.in>\nTo: Procurement <procurement@kaveriinfra.in>\nCc: Meera Shah, Advocate <meera@shahlegal.in>\nDate: 3 April 2023\nSubject: Revised delivery schedule\nPlease note the revised delivery schedule for the TMT bars. Payment for invoices 117 to 121 remains outstanding.";
const ADVICE = "Dear Ms. Shah, please advise whether we can invoke arbitration under clause 14 for the unpaid invoices before the limitation period expires.";

const review = {
  id: "r1", setId: "s1", name: "t", playbookId: null, area: "general", version: 1, docTypes: ["Email / correspondence"], questions: [],
  issues: [],
  columns: [
    { id: "mediation_s12a", label: "Pre-institution mediation", prompt: "Was s.12A mediation attempted?", kind: "yes_no" },
    { id: "arbitration_clause", label: "Arbitration clause", prompt: "Does it contain an arbitration clause?", kind: "yes_no" },
  ],
} as unknown as StoredReview;

const win = (text: string) => ({ index: 0, text: `[Page 1]\n${text}`, pages: [1] });
const cover = { read: 100, total: 100, unreadPages: [] };

describe("review guards", () => {
  it("recognises quotes that are only header lines", () => {
    expect(headerOnlyQuote("Cc: Meera Shah, Advocate <meera@shahlegal.in>")).toBe(true);
    expect(headerOnlyQuote("To: Procurement Cc: Meera Shah, Advocate")).toBe(true);
    expect(headerOnlyQuote("please advise whether we can invoke arbitration")).toBe(false);
  });

  it("does not flag privilege because an advocate is copied", () => {
    const r = processReviewWindow(review, win(EMAIL), { docType: "Email / correspondence", summary: "x", importance: 3, issues: [], cells: [],
      privilege: { flag: "possible", basis: "An advocate is copied on a business email.", quote: "Cc: Meera Shah, Advocate <meera@shahlegal.in>", page: 1 } }, new Map([[1, EMAIL]]), cover);
    expect(r.privilege?.flag).toBe("none");
  });

  it("keeps a privilege flag resting on a request for legal advice found in the text", () => {
    const r = processReviewWindow(review, win(ADVICE), { docType: "Email / correspondence", summary: "x", importance: 4, issues: [], cells: [],
      privilege: { flag: "likely", basis: "The client asks its advocate for legal advice on invoking arbitration.", quote: "please advise whether we can invoke arbitration under clause 14", page: 1 } }, new Map([[1, ADVICE]]), cover);
    expect(r.privilege?.flag).toBe("likely");
    expect(r.privilege?.quoteFound).toBe(true);
  });

  it("keeps an unlocated privilege flag for the reviewer, but never above possible", () => {
    const r = processReviewWindow(review, win(EMAIL), { docType: "Email / correspondence", summary: "x", importance: 3, issues: [], cells: [],
      privilege: { flag: "likely", basis: "Legal advice.", quote: "we advise you to settle the claim immediately", page: 1 } }, new Map([[1, EMAIL]]), cover);
    expect(r.privilege).toMatchObject({ flag: "possible", quoteFound: false });
  });

  it("treats an unquoted No on a yes/no column as not stated, but keeps a quoted answer", () => {
    const r = processReviewWindow(review, win(EMAIL), { docType: "Email / correspondence", summary: "x", importance: 3, issues: [], privilege: { flag: "none" },
      cells: [{ column: "mediation_s12a", value: "No", quote: "", page: null }, { column: "arbitration_clause", value: "No", quote: "Payment for invoices 117 to 121 remains outstanding.", page: 1 }] }, new Map([[1, EMAIL]]), cover);
    expect(r.cells.mediation_s12a.status).toBe("not_stated");
    expect(r.cells.arbitration_clause.value).toBe("No");
    expect(r.cells.arbitration_clause.quoteFound).toBe(true);
  });
});
