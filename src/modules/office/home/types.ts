import { FEATURES } from "@/lib/features";
import type { ID, ISODate, OfficeDocument, OfficeKind, PracticeArea } from "@/lib/types/domain";

export interface OfficeDocSummary extends Omit<OfficeDocument, "content"> {
  versionCount: number;
  commentCount: number;
  matterShortName?: string;
  ownerName?: string;
  libraryItemId?: ID;
  folderName?: string;
}

export interface OfficeTemplateSummary {
  id: string;
  kind: OfficeKind;
  name: string;
  description: string;
  category: string;
  practiceArea?: PracticeArea;
  tags?: string[];
}

export interface OfficeHomeData {
  docs: OfficeDocSummary[];
  templates: OfficeTemplateSummary[];
  matters: { id: ID; shortName: string; name: string }[];
  counts: Record<OfficeKind, number>;
  aiConfigured: boolean;
  generatedAt: ISODate;
}

/** Office kinds offered in this product (src/lib/features.ts): Word only unless the full suite is enabled. */
export const OFFICE_KINDS: OfficeKind[] = FEATURES.officeAll ? ["word", "sheet", "slides", "pdf"] : ["word"];

export const KIND_META: Record<OfficeKind, { label: string; plural: string; lower: string; lowerPlural: string; app: string; ext: string; blurb: string; accept: string }> = {
  word: { label: "Document", plural: "Documents", lower: "document", lowerPlural: "documents", app: "Word", ext: "docx", blurb: "Briefs, memos, letters and agreements with tracked changes and a drafting agent.", accept: ".docx,.doc,.rtf,.md,.txt,.html" },
  sheet: { label: "Workbook", plural: "Workbooks", lower: "workbook", lowerPlural: "workbooks", app: "Excel", ext: "xlsx", blurb: "Damages models, privilege logs and trackers with formulas and an analysis agent.", accept: ".xlsx,.xlsm,.xls,.csv,.tsv" },
  slides: { label: "Deck", plural: "Decks", lower: "deck", lowerPlural: "decks", app: "PowerPoint", ext: "pptx", blurb: "Case themes, pitches and hearing decks with layouts and a storyline agent.", accept: ".pptx" },
  pdf: { label: "PDF", plural: "PDFs", lower: "PDF", lowerPlural: "PDFs", app: "PDF", ext: "pdf", blurb: "Stamp, redact, annotate and split productions with an extraction agent.", accept: ".pdf" },
};
