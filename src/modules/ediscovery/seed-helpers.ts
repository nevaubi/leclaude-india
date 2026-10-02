import type { CodingDecision, DocType, EDocument } from "@/lib/types/domain";
import { MATTERS, PEOPLE } from "@/lib/seed/ids";

/** Deterministic 40-hex pseudo hash (FNV-1a variants) so duplicates share a value. */
export function fakeHash(input: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995, h3 = 0xdeadbeef, h4 = 0x9e3779b9, h5 = 0x7f4a7c15;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (c * 31), 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 + c, 0x27d4eb2f) >>> 0;
    h5 = Math.imul(h5 ^ (c << (i % 8)), 0x165667b1) >>> 0;
  }
  return [h1, h2, h3, h4, h5].map((x) => x.toString(16).padStart(8, "0")).join("");
}

export const CUSTODIANS = {
  hegde: { id: PEOPLE.girishHegde, name: "Girish Hegde", email: "g.hegde@meridianfinechem.example", title: "Director, Environmental Health & Safety" },
  vasudevan: { id: PEOPLE.hemaVasudevan, name: "Hema Vasudevan", email: "h.vasudevan@meridianfinechem.example", title: "Senior Toxicologist" },
  bose: { id: PEOPLE.nandiniBose, name: "Nandini Bose", email: "n.bose@meridianfinechem.example", title: "Product Stewardship Manager" },
  prasad: { id: PEOPLE.anilPrasad, name: "Anil Prasad", email: "a.prasad@meridianfinechem.example", title: "VP, Textile Chemicals" },
  kapur: { id: PEOPLE.rohitKapur, name: "Rohit Kapur", email: "r.kapur@meridianfinechem.example", title: "Associate General Counsel" },
  sood: { id: PEOPLE.manishSood, name: "Manish Sood", email: "m.sood@meridianfinechem.example", title: "Regulatory Affairs Counsel" },
} as const;
export type CustodianKey = keyof typeof CUSTODIANS;

/** Non-custodian correspondents referenced across the corpus. */
export const PEOPLE_DIR: Record<string, string> = {
  "Girish Hegde": "g.hegde@meridianfinechem.example",
  "Hema Vasudevan": "h.vasudevan@meridianfinechem.example",
  "Nandini Bose": "n.bose@meridianfinechem.example",
  "Anil Prasad": "a.prasad@meridianfinechem.example",
  "Rohit Kapur": "r.kapur@meridianfinechem.example",
  "Manish Sood": "m.sood@meridianfinechem.example",
  "Pankaj Malhotra": "p.malhotra@meridianfinechem.example",
  "Deepa Krishnan": "d.krishnan@meridianfinechem.example",
  "Farhan Qureshi": "f.qureshi@meridianfinechem.example",
  "Kavita Lal": "k.lal@meridianfinechem.example",
  "Sanjay Hooda": "s.hooda@meridianfinechem.example",
  "Priya Natarajan": "p.natarajan@meridianfinechem.example",
  "Vikram Bhandari": "v.bhandari@meridianfinechem.example",
  "Dr. Leela Sundaram": "lsundaram@sundaramlabs.example",
  "Dr. Yusuf Bilgrami": "ybilgrami@sundaramlabs.example",
  "Charu Nair": "cnair@beaconenviro.example",
  "Tarun Ahuja": "tahuja@ahujabakshi.example",
  "Mahesh Phadke": "mahesh.phadke@cpcb.example",
  "Jyoti Rathore": "jyoti.rathore@gpcb.example",
  "Raghav Dutta": "rdutta@sarangpurcoop.example",
  "Lata Fernandes": "lfernandes@valsarapark.example",
  "Col. Devendra Wadhwa": "d.wadhwa@dqa-textiles.example",
  "Omkar Tamhane": "otamhane@konkanweaves.example",
  "Gauri Menon": "gmenon@saurashtrafabrics.example",
  // Northgate v. Apex
  "Melissa Grant": "mgrant@northgatelogistics.com",
  "Victor Salazar": "vsalazar@northgatelogistics.com",
  "Dana Whitmore": "dwhitmore@northgatelogistics.com",
  "Kevin Brandau": "kbrandau@apexfreight.com",
  "Rhonda Feely": "rfeely@apexfreight.com",
  "Curtis Lange": "clange@apexfreight.com",
  "Ana Pereira": "apereira@marlowinsurance.com",
  "Dhruv Oberoi": "doberoi@mehrarao.example",
};

const fmtAddr = (name: string) => (PEOPLE_DIR[name] ? `${name} <${PEOPLE_DIR[name]}>` : name);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function emailDate(date: string, time = "09:14", tz = "-0600") {
  const d = new Date(date + "T00:00:00Z");
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${time}:00 ${tz}`;
}

export interface DocSpec {
  id: string;
  pages?: number;
  /** Explicit Bates start (resets the running counter). */
  batesAt?: number;
  date: string;
  time?: string;
  custodian: CustodianKey | { id: string; name: string };
  type: DocType;
  subject: string;
  from?: string;
  to?: string[];
  cc?: string[];
  body: string;
  /** Email header block is generated for type Email unless raw is set. */
  raw?: boolean;
  threadId?: string;
  parentId?: string;
  attachmentIds?: string[];
  duplicateOf?: string;
  nearDuplicateIds?: string[];
  hashOf?: string; // share hash with another doc id
  aiScore?: number;
  aiSummary?: string;
  aiIssues?: string[];
  entities?: EDocument["entities"];
  coding?: Partial<CodingDecision>;
  source?: string;
  tags?: string[];
}

export interface BuildOptions {
  matterId: string;
  prefix: string;
  start: number;
  width?: number;
  /** UTC offset written into generated email headers (default -0600). */
  tz?: string;
  custodianDir?: Record<string, { id: string; name: string }>;
}

export function buildDocs(specs: DocSpec[], opts: BuildOptions): EDocument[] {
  let n = opts.start;
  const width = opts.width ?? 7;
  const fmt = (x: number) => `${opts.prefix}-${String(x).padStart(width, "0")}`;
  const out: EDocument[] = [];
  const hashSeed = new Map<string, string>();
  for (const s of specs) {
    if (s.batesAt != null) n = s.batesAt;
    const pages = s.pages ?? 1;
    const bates = fmt(n);
    const batesEnd = pages > 1 ? fmt(n + pages - 1) : undefined;
    n += pages;
    const cust = typeof s.custodian === "string" ? CUSTODIANS[s.custodian] : s.custodian;
    let text = s.body.trim();
    if (s.type === "Email" && !s.raw) {
      const header = [
        `From: ${fmtAddr(s.from ?? cust.name)}`,
        `To: ${(s.to ?? []).map(fmtAddr).join("; ")}`,
        s.cc?.length ? `Cc: ${s.cc.map(fmtAddr).join("; ")}` : null,
        `Date: ${emailDate(s.date, s.time, opts.tz)}`,
        `Subject: ${s.subject}`,
      ].filter(Boolean).join("\n");
      text = `${header}\n\n${text}`;
    }
    const hashKey = s.hashOf ?? s.duplicateOf ?? s.id;
    const hash = hashSeed.get(hashKey) ?? fakeHash(`${opts.matterId}:${hashKey}`);
    hashSeed.set(hashKey, hash);
    const family = s.threadId || s.parentId || s.attachmentIds?.length ? { threadId: s.threadId, parentId: s.parentId, attachmentIds: s.attachmentIds } : undefined;
    out.push({
      id: s.id,
      matterId: opts.matterId,
      bates,
      batesEnd,
      date: s.date,
      custodianId: cust.id,
      custodianName: cust.name,
      type: s.type,
      subject: s.subject,
      from: s.from ?? (s.type === "Email" ? cust.name : undefined),
      to: s.to,
      cc: s.cc,
      text,
      pages,
      family,
      hash,
      aiScore: s.aiScore,
      aiSummary: s.aiSummary,
      aiIssues: s.aiIssues,
      entities: s.entities,
      coding: { responsive: null, privileged: null, issues: [], ...(s.coding ?? {}) },
      isDuplicateOf: s.duplicateOf,
      nearDuplicateIds: s.nearDuplicateIds,
      source: s.source ?? `${cust.name} custodial collection`,
      tags: s.tags,
    });
  }
  return out;
}

export const REVIEWERS = { marsh: PEOPLE.eshaMathur, lopez: PEOPLE.meeraLobo, bradley: PEOPLE.tanmayBhatt, mehra: PEOPLE.arjunMehra, raman: PEOPLE.priyaRaman };
export const VALSARA = MATTERS.valsara;
export const NORTHGATE = MATTERS.northgate;
