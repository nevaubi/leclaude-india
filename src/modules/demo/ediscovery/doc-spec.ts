import type { CodingDecision, DocType, EDocument } from "@/lib/types/domain";
import type { IndiaDocMeta } from "@/modules/ediscovery/india";
import type { SourceKey } from "./people";

/**
 * Authoring shape for one demo case-record document; `buildCorpus` turns specs into stored documents with a document
 * reference (production-style number per source), headers, hashes and the Indian record metadata (`india`).
 */
export interface DocSpec {
  id: string;
  source: SourceKey;
  date: string;
  time?: string;
  type: DocType;
  subject: string;
  from?: string;
  to?: string[];
  cc?: string[];
  body: string;
  pages?: number;
  thread?: string;
  parent?: string;
  attachments?: string[];
  dupOf?: string;
  aiScore?: number;
  aiSummary?: string;
  entities?: EDocument["entities"];
  coding?: Partial<CodingDecision>;
  tags?: string[];
  /** Indian record metadata; `docClass` is required, the exhibit mark is set once the document is marked. */
  india: IndiaDocMeta;
}

export const DEMO_ID = (slug: string) => `demo_in_ed_${slug}`;
