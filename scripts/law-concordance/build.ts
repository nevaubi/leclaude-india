/**
 * Regenerate the official concordance data (src/lib/india/concordance/data/*.json) from the publisher's documents.
 *
 *   npx tsx scripts/law-concordance/build.ts
 *
 * Inputs: scripts/law-concordance/sources/<table>.md, the page-by-page markdown of each BPR&D PDF (Firecrawl PDF parse
 * of the URL in SOURCES, retrieved on the date recorded there). The rows are parsed by the pure parser in
 * src/lib/india/concordance/parse.ts; nothing is edited by hand. To refresh: re-extract the PDF to the .md file, bump
 * `retrievedAt`, run this script, review the diff and the flagged rows.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONCORDANCE_PARSER_VERSION, parseConcordanceMarkdown } from "../../src/lib/india/concordance/parse";
import type { ConcordanceSource, ConcordanceTable, ConcordanceTableId, NewCodeId, OldCodeId } from "../../src/lib/india/concordance/types";

const LISTED_AT = "https://bprd.nic.in/page/documents_by_bprd";
const PUBLISHER = "Bureau of Police Research & Development (BPR&D), Ministry of Home Affairs, Government of India";
const PREPARED_BY = "Anil Kishore Yadav, IPS, Director, Central Academy for Police Training (BPR&D), Bhopal";
const EXTRACTION = "Firecrawl PDF parse of the publisher's PDF (machine-read table; not the Gazette text)";

const SOURCES: Record<ConcordanceTableId, { oldCode: OldCodeId; newCode: NewCodeId; title: string; url: string; pages: number; retrievedAt: string }> = {
  "ipc-bns": { oldCode: "IPC", newCode: "BNS", title: "Correspondence Table and Comparison Summary of the Bharatiya Nyaya Sanhita, 2023 (BNS) to the Indian Penal Code, 1860 (IPC)", url: "https://bprd.nic.in/uploads/pdf/COMPARISON%20SUMMARY%20BNS%20to%20IPC%20.pdf", pages: 38, retrievedAt: "2026-10-02" },
  "crpc-bnss": { oldCode: "CrPC", newCode: "BNSS", title: "Correspondence Table and Comparison Summary of the Bharatiya Nagarik Suraksha Sanhita, 2023 (BNSS) and the Code of Criminal Procedure, 1973 (CrPC)", url: "https://bprd.nic.in/uploads/pdf/Comparison%20summary%20BNSS%20to%20CrPC.pdf", pages: 38, retrievedAt: "2026-10-02" },
  "iea-bsa": { oldCode: "IEA", newCode: "BSA", title: "Correspondence Table and Comparison Summary of the Bharatiya Sakshya Adhiniyam, 2023 (BSA) and the Indian Evidence Act, 1872 (IEA)", url: "https://bprd.nic.in/uploads/pdf/Comparison%20Summary%20BSA%20to%20IEA.pdf", pages: 14, retrievedAt: "2026-10-02" },
};

const root = join(__dirname, "..", "..");
for (const id of Object.keys(SOURCES) as ConcordanceTableId[]) {
  const s = SOURCES[id];
  const md = readFileSync(join(root, "scripts", "law-concordance", "sources", `${id}.md`), "utf8");
  const { rows, summaries } = parseConcordanceMarkdown(id, md);
  const source: ConcordanceSource = { title: s.title, publisher: PUBLISHER, url: s.url, listedAt: LISTED_AT, preparedBy: PREPARED_BY, pages: s.pages, retrievedAt: s.retrievedAt, extraction: EXTRACTION, inputSha256: createHash("sha256").update(md).digest("hex") };
  const table: ConcordanceTable = {
    id, oldCode: s.oldCode, newCode: s.newCode, source, parserVersion: CONCORDANCE_PARSER_VERSION, rows,
    counts: {
      rows: rows.length,
      corresponds: rows.filter((r) => r.relation === "corresponds").length,
      new: rows.filter((r) => r.relation === "new").length,
      notStated: rows.filter((r) => r.relation === "not_stated").length,
      unparsed: rows.filter((r) => r.relation === "unparsed").length,
      requiresReview: rows.filter((r) => r.verification === "requires_review").length,
    },
  };
  writeFileSync(join(root, "src", "lib", "india", "concordance", "data", `${id}.json`), `${JSON.stringify(table)}\n`);
  writeFileSync(join(root, "src", "lib", "india", "concordance", "data", `${id}.summaries.json`), `${JSON.stringify(summaries)}\n`);
  console.log(id, table.counts);
}
