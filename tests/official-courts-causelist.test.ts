import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCauseList, causeListEntryId, type CauseListDoc } from "@/modules/official/causelist/parse";
import { classifyHeader, groupLines, type TextItem } from "@/modules/official/causelist/table";
import { commaAdvocates, hasContact, scAdvocates, scParties, scrubContact, tribunalAdvocates, normalizeParties, printedDate } from "@/modules/official/causelist/text";
import { scrubPersonalData } from "@/modules/official/chunk";

/**
 * Fixtures in tests/fixtures/official/courts are verbatim captures (Firecrawl, 2026-10-02) of published lists, except that
 * advocates' e-mail addresses and phone numbers in the Delhi HC list were replaced by placeholders of the same shape
 * (ADVOCATE.ONE@EXAMPLE.COM, 9000000001) so no personal contact data is committed. The positional (x/y) layouts below are
 * built from the verbatim Supreme Court daily-list text (M_J_2 / M_C_1, scout capture) placed in the printed column bands.
 */

const FIX = path.resolve(__dirname, "fixtures/official/courts");
const read = (f: string) => readFileSync(path.join(FIX, f), "utf8");

function mdDoc(file: string, id = "doc_md"): CauseListDoc {
  const md = read(file);
  return { id, markdown: md, pages: [{ page: 1, text: md }], fetchedAt: "2026-10-02T10:00:00.000Z" };
}

describe("text helpers", () => {
  it("scrubs contact data and detects it", () => {
    const s = "SIDDHARTH PANDA(ADVOCATE.ONE@EXAMPLE.COM)(9000000001)(RESPONDENT) https://dhcvirtualcourt.webex.com/meet/x +91 9876543210";
    expect(hasContact(s)).toBe(true);
    const c = scrubContact(s);
    expect(c).not.toMatch(/@|9000000001|webex|9876543210/);
    expect(hasContact(c)).toBe(false);
    // Case and diary numbers are not phone numbers.
    expect(scrubContact("IA No. 209282/2026 Diary No. 54583-2026 W.P.(C)-10678/2022")).toBe("IA No. 209282/2026 Diary No. 54583-2026 W.P.(C)-10678/2022");
  });

  it("reads Supreme Court parties and advocates with AOR codes", () => {
    expect(scParties(["HARDIK CHAWDA", "*Versus*", "STATE OF HIMACHAL PRADESH", "{Mention Memo}", "IA No. 209282/2026 - EXEMPTION FROM FILING"])).toBe("HARDIK CHAWDA Versus STATE OF HIMACHAL PRADESH");
    expect(scParties(["SUDHIR KUMAR SHARMA Versus THE STATE OF UTTAR PRADESH AND ORS. {Mention Memo} IA No. 241886/2024"])).toBe("SUDHIR KUMAR SHARMA Versus THE STATE OF UTTAR PRADESH AND ORS.");
    expect(scParties(["IN RE: SOMETHING"])).toBe("IN RE: SOMETHING");
    expect(scAdvocates("AJAY MARWAH- 2312 BIMLESH KUMAR SINGH- 1652 [R-1]")).toEqual(["AJAY MARWAH (AOR 2312)", "BIMLESH KUMAR SINGH (AOR 1652)"]);
    expect(scAdvocates("VIVEK GUPTA VISHWA PAL SINGH[R-1], AKANSHA[R-2]")).toEqual(["VIVEK GUPTA VISHWA PAL SINGH", "AKANSHA"]);
  });

  it("splits tribunal counsel cells and drops role notes", () => {
    expect(tribunalAdvocates("Faguni Jain, Adv Rishabh Gupta, Adv")).toEqual(["Faguni Jain", "Rishabh Gupta"]);
    expect(tribunalAdvocates("Ankit More, Adv Vikram Malviya, Adv (R-3 & 4) Rajat Lohia, Adv (R-2, 5, 6, 7 & 8)")).toEqual(["Ankit More", "Vikram Malviya", "Rajat Lohia"]);
    expect(tribunalAdvocates("Pankaj AgarwalShashwat Srivastava-R1Raunak DhillonMdhavi Khanna-R2")).toEqual(["Pankaj Agarwal", "Shashwat Srivastava", "Raunak Dhillon", "Mdhavi Khanna"]);
    expect(tribunalAdvocates("Velusamy Karuppannan- In- Person")).toEqual(["Velusamy Karuppannan"]);
  });

  it("repairs glued party separators without changing names", () => {
    expect(normalizeParties("HEM SINGH BHARANAV/s BANK OF INDIA")).toBe("HEM SINGH BHARANA V/s BANK OF INDIA");
    expect(normalizeParties("Ravi GoelVs. Amit Agarwal & Anr.")).toBe("Ravi Goel Vs. Amit Agarwal & Anr.");
  });

  it("reads printed dates strictly", () => {
    expect(printedDate("05-10-2026")).toBe("2026-10-05");
    expect(printedDate("05.10.2026")).toBe("2026-10-05");
    expect(printedDate("05/10/2026")).toBe("2026-10-05");
    expect(printedDate("01-Oct-2026")).toBe("2026-10-01");
    expect(printedDate("5th October, 2026")).toBe("2026-10-05");
    expect(printedDate("31-02-2026")).toBeNull();
    expect(printedDate("October 2026")).toBeNull();
  });

  it("classifies header labels by name", () => {
    expect(classifyHeader("SNo.")).toBe("item");
    expect(classifyHeader("SNo. Case No.")).toBe("item");
    expect(classifyHeader("Petitioner / Respondent")).toBe("parties");
    expect(classifyHeader("Petitioner/Respondent Advocate")).toBe("advocates");
    expect(classifyHeader("Name of Counsel for Petitioner/ Applicant")).toBe("advPet");
    expect(classifyHeader("Name of Counsel for Respondent")).toBe("advRes");
    expect(classifyHeader("Name of (1) IRP/(2) RP/(3) Liquidator")).toBe("irp");
    expect(classifyHeader("CA/IA No.")).toBe("caseAlt");
    expect(classifyHeader("CP. No.")).toBe("case");
    expect(classifyHeader("ITEM NUMBER")).toBe("item");
    expect(classifyHeader("OTHER INFORMATION")).toBe("remarks");
  });

  it("entry ids are stable per document position", () => {
    expect(causeListEntryId("d1", 0)).toBe(causeListEntryId("d1", 0));
    expect(causeListEntryId("d1", 0)).not.toBe(causeListEntryId("d1", 1));
    expect(causeListEntryId("d1", 0)).toMatch(/^cle_[0-9a-f]{24}$/);
  });
});

describe("Delhi High Court list (markdown)", () => {
  const r = parseCauseList(mdDoc("dhc-causelist-03.10.2026.md"), { layout: "dhc", forum: "hc-delhi", listType: "main", listDate: "2026-10-05" });

  it("reads courts, benches, items and every case number in a cell", () => {
    expect(r.records.map((e) => [e.courtNo, e.itemNo])).toEqual([["33", "1"], ["33", "2"], ["3", "1"], ["3", "2"], ["3", "3"]]);
    const first = r.records[0];
    expect(first.bench).toBe("HON'BLE MS.JUSTICE PRATHIBA M. SINGH; HON'BLE MR.JUSTICE DINESH BHATT");
    expect(first.caseNumbers).toEqual([{ printed: "W.P.(C)-5812/2016", normalized: "WPC/5812/2016" }]);
    expect(first.parties).toBe("DEVINDER & ORS V/s GOVT. OF NCT OF DELHI & ORS");
    expect(first.advocates).toEqual(["L.K. RAWAL", "SHANTANU SAGAR", "SIDDHARTH PANDA"]);
    expect(first.listDate).toBe("2026-10-05");
    expect(first.parsed).toBe(true);
    const glued = r.records[4];
    expect(glued.caseNumbers.map((c) => c.normalized)).toEqual(["WPC/10678/2022", "CMAPPL/30984/2022", "CMAPPL/67136/2024", "WPC/2240/2024"]);
    expect(glued.parties).toBe("HEM SINGH BHARANA V/s BANK OF INDIA");
    expect(r.records[2].bench).toBe("HON'BLE MR. JUSTICE AJAY DIGPAUL");
  });

  it("drops 'OTHER DETAILS OF ADVOCATES' rows: no e-mail or phone number anywhere", () => {
    const all = JSON.stringify(r.records);
    expect(all).not.toMatch(/OTHER DETAILS|@|9000000|1100000003|webex/i);
    expect(r.records).toHaveLength(5);
  });
});

describe("NCLT list (markdown, Indore bench)", () => {
  const r = parseCauseList(mdDoc("nclt-indore-05.10.2026.md"), { layout: "tribunal", forum: "nclt-indore", listType: "daily", listDate: "2026-10-05", expectedEntries: 36 });

  it("reads items, CP and CA/IA columns, coram and counsel", () => {
    const e201 = r.records.find((e) => e.itemNo === "201")!;
    expect(e201.courtNo).toBe("1");
    expect(e201.bench).toBe("HON'BLE Shri. BRAJENDRA MANI TRIPATHI, MEMBER JUDICIAL; HON'BLE Shri. MAN MOHAN GUPTA, MEMBER TECHNICAL");
    expect(e201.caseNumbers).toEqual([{ printed: "CP(IB)/29(MP)2022", normalized: "CPIB/29/2022" }]);
    expect(e201.advocates).toEqual(["Madhav Lahoti", "Faguni Jain", "Rishabh Gupta"]);
    const e202 = r.records.find((e) => e.itemNo === "202")!;
    expect(e202.caseNumbers.map((c) => c.normalized)).toEqual(["IA/259/2026", "CPIB/18/2021"]);
  });

  it("keeps rows printed without a serial number as their own entries (never merged into a neighbour)", () => {
    const itemless = r.records.filter((e) => e.itemNo == null);
    expect(itemless.map((e) => e.caseNumbers[0].printed)).toEqual(["CP/9(MP)2021", "CP/11(MP)2025"]);
    const e3 = r.records.find((e) => e.itemNo === "3")!;
    expect(e3.caseNumbers.map((c) => c.printed)).toEqual(["Co. Appeal/11(MP)2026"]);
  });

  it("rows without a serial number are reference rows, never listings: parsed false, as from positional text", () => {
    // "CP/11(MP)2025 | Main Matter | Main Matter Listed on 26-11-2026": not a hearing on 2026-10-05.
    const itemless = r.records.filter((e) => e.itemNo == null);
    expect(itemless.map((e) => [e.caseNumbers[0].printed, e.parsed])).toEqual([["CP/9(MP)2021", false], ["CP/11(MP)2025", false]]);
    expect(itemless.find((e) => e.caseNumbers[0].printed === "CP/11(MP)2025")!.raw).toContain("Main Matter Listed on 26-11-2026");
    // Numbered items are unaffected.
    expect(r.records.filter((e) => e.itemNo != null).every((e) => e.parsed)).toBe(true);
  });

  it("reports the publisher's entry count against parsed items", () => {
    expect(r.notes.some((n) => /36 entries; 6 numbered items parsed/.test(n))).toBe(true);
  });
});

describe("NCLAT list (markdown, Court II)", () => {
  const r = parseCauseList(mdDoc("nclat-causelist-II-05.10.2026.md"), { layout: "tribunal", forum: "nclat-delhi", listType: "main", listDate: "2026-10-05" });

  it("reads appeal numbers, IAs, bench changes and glued names", () => {
    expect(r.records.map((e) => e.itemNo)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(r.records[0].courtNo).toBe("II");
    expect(r.records[0].bench).toBe("Hon'ble Mr. Justice Sharad Kumar Sharma, Member (Judicial) and Hon'ble Mr. Arun Baroka, Member (Technical)");
    expect(r.records[1].bench).toMatch(/Indevar Pandey, Member \(Technical\)$/);
    expect(r.records[0].caseNumbers.map((c) => c.normalized)).toEqual(["COMPAPPATINS/2133/2024", "IA/3940/2026"]);
    expect(r.records[0].parties).toBe("Ravi Goel Vs. Amit Agarwal & Anr.");
    expect(r.records[4].caseNumbers).toEqual([
      { printed: "Competition App. (AT) No. 01 of 2026", normalized: "COMPETITIONAPPAT/1/2026" },
      { printed: "I.A. No. 2884, 5790 of 2026", normalized: null },
    ]);
    expect(r.records[4].advocates).toEqual(["Velusamy Karuppannan", "Manu Sanan Aksha Jha"]);
    expect(r.records.every((e) => e.parsed)).toBe(true);
  });
});

describe("Supreme Court advance and weekly tables (markdown)", () => {
  it("advance list: continuation rows join the record above", () => {
    const r = parseCauseList(mdDoc("sci-advance-07.10.2026.md"), { layout: "sci-table", forum: "sci", listType: "advance", listDate: "2026-10-07" });
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ itemNo: "1", courtNo: null, bench: null, parties: "SUDHIR KUMAR SHARMA Versus THE STATE OF UTTAR PRADESH AND ORS.", parsed: true });
    expect(r.records[0].caseNumbers).toEqual([{ printed: "SLP(Crl) No. 630/2024", normalized: "SLPCRL/630/2024" }]);
    expect(r.records[0].raw).toContain("{Mention Memo} IA No. 241886/2024");
    expect(r.records[1].advocates).toEqual(["E. C. AGRAWALA (AOR 177)"]);
  });

  it("weekly list: rows repeating SNo + Case No form one record; 'Connected' rows bind to their printed serial number", () => {
    // Fragment of the verbatim weekly-list rows quoted by the scout (WEEKLY LIST No. 25 OF 2026), with the table header.
    const md = [
      "WEEKLY LIST No. 25 OF 2026 FROM : 06-10-2026 To 08-10-2026 CHIEF JUSTICE'S COURT HON'BLE THE CHIEF JUSTICE",
      "| SNo. | Case No. | Petitioner / Respondent | Petitioner/Respondent Advocate |",
      "| --- | --- | --- | --- |",
      "| 1 | C.A. No. 3309-3310/1997 XII-B | Versus | SANCHIT GARGA- 2748[R-1] |",
      "| 1 | C.A. No. 3309-3310/1997 XII-B | THE STATE OF X | |",
      "|  | Connected C.A. No. 3305/1997 XII-B | A Versus B | |",
      "| 2 | SLP(C) No. 1/2026 | C Versus D | |",
    ].join("\n");
    const r = parseCauseList({ id: "wk", markdown: md, pages: [{ page: 1, text: md }], fetchedAt: "2026-10-02T10:00:00Z" }, { layout: "sci-table", forum: "sci", listType: "weekly", listDate: "2026-10-06" });
    expect(r.records.map((e) => [e.itemNo, e.caseNumbers.map((c) => c.printed)])).toEqual([
      ["1", ["C.A. No. 3309-3310/1997"]],
      ["1", ["C.A. No. 3305/1997"]],
      ["2", ["SLP(C) No. 1/2026"]],
    ]);
    expect(r.records[0].caseNumbers[0].normalized).toBeNull(); // a range is not one number; keys are expanded at persist time
    expect(r.records[0].courtNo).toBe("CHIEF JUSTICE'S COURT");
    expect(r.records[1].raw).toMatch(/Connected C\.A\. No\. 3305\/1997/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Positional text (PDF text layer)
// ---------------------------------------------------------------------------------------------------------------------

type Cell = [x: number, str: string];
/** Build items for one page: rows of [y, cells]; y in PDF user space (larger = higher on the page) unless flipped. */
function page(pageNo: number, rows: [number, Cell[]][], opts: { flip?: boolean } = {}): TextItem[] {
  return rows.flatMap(([y, cells]) => cells.map(([x, str]) => ({ page: pageNo, str, x, y: opts.flip ? 842 - y : y, w: str.length * 4.8, h: 9 })));
}

const SC_HEADER: [number, Cell[]] = [730, [[30, "SNo."], [60, "Case No."], [230, "Petitioner / Respondent"], [440, "Petitioner/Respondent Advocate"]]];

function scPage1(flip = false): TextItem[] {
  return page(1, [
    [800, [[150, "DAILY CAUSE LIST FOR DATED : 05-10-2026"]]],
    [785, [[250, "COURT NO. : 5"]]],
    [770, [[200, "HON'BLE MR. JUSTICE ALOK ARADHE"]]],
    [750, [[230, "MISCELLANEOUS HEARING"]]],
    SC_HEADER,
    [715, [[200, "[FRESH (FOR ADMISSION) - CRIMINAL CASES]"]]],
    [700, [[30, "54"], [60, "SLP(Crl) No."], [180, "HARDIK CHAWDA"], [420, "AJAY MARWAH- 2312"]]],
    [688, [[60, "13176/2026"]]],
    [676, [[60, "II-C"], [180, "Versus"]]],
    [664, [[180, "STATE OF HIMACHAL PRADESH"], [420, "BIMLESH KUMAR SINGH-"]]],
    [652, [[180, "{Mention Memo}"], [420, "1652 [R-1]"]]],
    [640, [[180, "IA No. 209282/2026 - EXEMPTION FROM FILING"]]],
    [628, [[180, "C/C OF THE IMPUGNED JUDGMENT"]]],
    [610, [[30, "55"], [60, "Diary No. 54583-2026"], [180, "SURENDRA KUMAR SHUKLA"], [420, "DINESH MALIK- 3703"]]],
    [598, [[60, "II"], [180, "Versus"]]],
    [586, [[180, "RAM KUMAR SHUKLA AND ANR."]]],
    [574, [[180, "[TO BE TAKEN UP ALONG WITH ITEM NO.5 I.E."]]],
    [562, [[180, "Diary No. 55248/2026].... FOR ADMISSION"]]],
    [544, [[30, "56.1"], [60, "Connected"]]],
    [532, [[60, "Diary No. 54623-2026"]]],
    [514, [[30, "1701"], [60, "Diary No. 40463-2026"], [180, "VIVEK CHAUDHRY"], [420, "SURBHI MEHTA- 2177"]]],
    [502, [[60, "III-B"], [180, "Versus"]]],
    [490, [[180, "H.P. STATE ELECTRICITY BOARD LIMITED AND ANR."]]],
    [478, [[180, "IN D No. - 54612/2025,"]]],
    [466, [[180, "IA No. 231382/2026 - RESTORATION"]]],
  ], { flip });
}

function scDoc(items: TextItem[]): CauseListDoc {
  return { id: "sc_daily", markdown: "", pages: [], items, fetchedAt: "2026-10-02T10:00:00Z" };
}
const SC_OPTS = { layout: "sci-daily" as const, forum: "sci", listType: "supplementary" as const, listDate: "2026-10-05" };

describe("Supreme Court daily list (positional items)", () => {
  it("groups items into lines by y", () => {
    const lines = groupLines(scPage1());
    expect(lines.find((l) => l.text.startsWith("54 "))?.text).toBe("54 SLP(Crl) No. HARDIK CHAWDA AJAY MARWAH- 2312");
  });

  it("binds every column to its item, with court, bench, diary numbers and AOR codes", () => {
    const r = parseCauseList(scDoc(scPage1()), SC_OPTS);
    expect(r.records.map((e) => e.itemNo)).toEqual(["54", "55", "56.1", "1701"]);
    const [e54, e55, e56, e1701] = r.records;
    expect(e54).toMatchObject({
      courtNo: "5",
      bench: "HON'BLE MR. JUSTICE ALOK ARADHE",
      caseNumbers: [{ printed: "SLP(Crl) No. 13176/2026", normalized: "SLPCRL/13176/2026" }],
      diaryNo: null,
      parties: "HARDIK CHAWDA Versus STATE OF HIMACHAL PRADESH",
      advocates: ["AJAY MARWAH (AOR 2312)", "BIMLESH KUMAR SINGH (AOR 1652)"],
      page: 1,
      parsed: true,
    });
    expect(e54.raw).toContain("IA No. 209282/2026 - EXEMPTION FROM FILING");
    // The diary number inside the "[TO BE TAKEN UP ALONG WITH ITEM NO.5 ...]" note is NOT item 55's diary number.
    expect(e55).toMatchObject({ diaryNo: "54583/2026", caseNumbers: [], parties: "SURENDRA KUMAR SHUKLA Versus RAM KUMAR SHUKLA AND ANR.", advocates: ["DINESH MALIK (AOR 3703)"], parsed: true });
    expect(e56).toMatchObject({ diaryNo: "54623/2026", parties: null, parsed: true });
    expect(e1701).toMatchObject({ diaryNo: "40463/2026", parties: "VIVEK CHAUDHRY Versus H.P. STATE ELECTRICITY BOARD LIMITED AND ANR.", parsed: true });
    expect(r.notes).toEqual([]);
  });

  it("reads top-down coordinates the same way", () => {
    const a = parseCauseList(scDoc(scPage1()), SC_OPTS).records.map((e) => [e.itemNo, e.diaryNo, e.parties]);
    const b = parseCauseList(scDoc(scPage1(true)), SC_OPTS).records.map((e) => [e.itemNo, e.diaryNo, e.parties]);
    expect(b).toEqual(a);
  });

  it("text above the first item of the next page makes the previous record ambiguous (parsed: false)", () => {
    const p2 = page(2, [
      SC_HEADER,
      [700, [[180, "AND OTHERS"]]], // continuation of item 1701's parties? cannot be known: never bound
      [680, [[30, "1702"], [60, "SLP(C) No. 5/2026"], [180, "A"], [420, "X- 1"]]],
      [668, [[180, "Versus"]]],
      [656, [[180, "B"]]],
    ]);
    const r = parseCauseList(scDoc([...scPage1(), ...p2]), SC_OPTS);
    const e1701 = r.records.find((e) => e.itemNo === "1701")!;
    expect(e1701.parsed).toBe(false);
    expect(r.records.find((e) => e.itemNo === "1702")).toMatchObject({ parsed: true, parties: "A Versus B", caseNumbers: [{ printed: "SLP(C) No. 5/2026", normalized: "SLPC/5/2026" }] });
    expect(r.unparsed).toBeGreaterThanOrEqual(2);
  });

  it("an item spanning several column bands cannot be bound: the record is unparsed", () => {
    const items = page(1, [
      SC_HEADER,
      [700, [[30, "7"], [60, "SLP(C) No. 9/2026"]]],
      [688, [[180, "A VERY LONG LINE THAT RUNS FROM THE PARTIES COLUMN ACROSS THE ADVOCATES COLUMN AND BEYOND"]]],
    ]);
    const r = parseCauseList(scDoc(items), SC_OPTS);
    expect(r.records[0]).toMatchObject({ itemNo: "7", parsed: false });
  });

  it("never parses a daily list without positional text (markdown interleaves the columns)", () => {
    const r = parseCauseList({ id: "x", markdown: "54 SLP(Crl) No.\n13176/2026\nHARDIK CHAWDA", pages: [{ page: 1, text: "54 SLP(Crl) No." }], fetchedAt: "2026-10-02T10:00:00Z" }, SC_OPTS);
    expect(r.records).toEqual([]);
    expect(r.notes[0]).toMatch(/positional text is required/);
  });

  it("a document without a recognisable header yields nothing", () => {
    const r = parseCauseList(scDoc(page(1, [[700, [[30, "54"], [60, "SLP(Crl) No. 1/2026"]]]])), SC_OPTS);
    expect(r.records).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/no table header/);
  });
});

describe("Delhi HC and NCLT lists (positional items)", () => {
  it("Delhi HC: contact-data rows are dropped with their continuation lines", () => {
    const items = page(1, [
      [800, [[40, "COURT NO. 33"]]],
      [788, [[40, "HON'BLE MS.JUSTICE PRATHIBA M. SINGH"]]],
      [760, [[30, "ITEM NUMBER"], [90, "CASE NUMBER"], [200, "PARTY NAME"], [360, "ADVOCATE NAME"], [480, "OTHER INFORMATION"]]],
      [745, [[30, "AFTER NOTICE MISC. MATTERS"]]],
      [730, [[30, "1"], [90, "W.P.(C)-5812/2016"], [200, "DEVINDER & ORS V/s GOVT."], [360, "L.K. RAWAL, SHANTANU"]]],
      [718, [[200, "OF NCT OF DELHI & ORS"], [360, "SAGAR"]]],
      [700, [[30, "1"], [200, "OTHER DETAILS OF ADVOCATES: SIDDHARTH PANDA(ADVOCATE.ONE@EXAMPLE.COM)"]]],
      [688, [[200, "(9000000001)(RESPONDENT)"]]],
      [670, [[30, "2"], [90, "W.P.(C)-8765/2022"], [200, "RAGHUBIR SINGH V/s UNION OF INDIA"], [360, "NIRMAL SINGH CHECHI"]]],
    ]);
    const r = parseCauseList({ id: "dhcpos", markdown: "", pages: [], items, fetchedAt: "2026-10-02T10:00:00Z" }, { layout: "dhc", forum: "hc-delhi", listType: "main", listDate: "2026-10-05" });
    expect(r.records.map((e) => [e.itemNo, e.caseNumbers.map((c) => c.normalized), e.parties])).toEqual([
      ["1", ["WPC/5812/2016"], "DEVINDER & ORS V/s GOVT. OF NCT OF DELHI & ORS"],
      ["2", ["WPC/8765/2022"], "RAGHUBIR SINGH V/s UNION OF INDIA"],
    ]);
    expect(r.records[0].advocates).toEqual(["L.K. RAWAL", "SHANTANU SAGAR"]);
    expect(r.records[0]).toMatchObject({ courtNo: "33", bench: "HON'BLE MS.JUSTICE PRATHIBA M. SINGH" });
    expect(JSON.stringify(r.records)).not.toMatch(/@|9000000001|OTHER DETAILS/);
  });

  it("NCLT: a printed row without a serial number becomes its own unparsed record", () => {
    const items = page(1, [
      [800, [[40, "NATIONAL COMPANY LAW TRIBUNAL INDORE BENCH COURT ROOM NO. 1"]]],
      // Column lefts: Sr 20, CP. No. 50, CA/IA No. 160, Purpose 330, Parties 440, counsel 680 / 900 (labels sit inside their columns).
      [760, [[20, "Sr."], [70, "CP. No."], [190, "CA/IA No."], [340, "Purpose"], [470, "Name of the Parties"], [690, "Name of Counsel for Petitioner/"], [910, "Name of Counsel for Respondent"]]],
      [750, [[690, "Applicant"]]],
      [740, [[20, "3"], [50, "Co. Appeal/11(MP)2026"], [160, "Main Matter"], [330, "New Application"], [440, "Shiv Kumar Tiwari V/s RoC Gwalior MP"], [680, "PCS Pratik Tripathi"]]],
      [720, [[50, "CP/9(MP)2021"], [160, "Main Matter"], [330, "Allowed 03-02-2025"], [440, "Rajesh Agrawal & Ors V/s Makhija Construction"], [680, "PCS Pratik Tripathi"]]],
      [700, [[20, "4"], [160, "IA/37(MP)2026 in CP/9(MP)2021"], [330, "New Application"], [440, "Cemacon Infrastructure Pvt Ltd V/s Makhija"], [680, "PCS Pratik Tripathi"]]],
    ]);
    const r = parseCauseList({ id: "ncltpos", markdown: "", pages: [], items, fetchedAt: "2026-10-02T10:00:00Z" }, { layout: "tribunal", forum: "nclt-indore", listType: "daily", listDate: "2026-10-05" });
    expect(r.records.map((e) => [e.itemNo, e.parsed, e.caseNumbers.map((c) => c.printed)])).toEqual([
      ["3", true, ["Co. Appeal/11(MP)2026"]],
      [null, false, ["CP/9(MP)2021"]],
      ["4", true, ["IA/37(MP)2026", "CP/9(MP)2021"]],
    ]);
    expect(r.records[0].courtNo).toBe("1");
  });
});

describe("binding never crosses a court header", () => {
  it("markdown: a continuation row after a new court header is not attached to the previous court's item", () => {
    const md = [
      "| SNo. | Case No. | Petitioner / Respondent | Petitioner/Respondent Advocate |",
      "| --- | --- | --- | --- |",
      "| 1 | SLP(C) No. 1/2026 | A Versus B | X- 1 |",
      "COURT NO. : 6",
      "|  |  | {Mention Memo} IA No. 5/2026 | |",
      "| 2 | SLP(C) No. 2/2026 | C Versus D | Y- 2 |",
    ].join("\n");
    const r = parseCauseList({ id: "x", markdown: md, pages: [{ page: 1, text: md }], fetchedAt: "2026-10-02T10:00:00Z" }, { layout: "sci-table", forum: "sci", listType: "advance", listDate: "2026-10-07" });
    expect(r.records.map((e) => [e.itemNo, e.courtNo])).toEqual([["1", null], ["2", "6"]]);
    expect(r.records[0].raw).not.toContain("IA No. 5/2026");
    expect(r.unparsed).toBe(1);
  });

  it("markdown: a note line ends the open record without binding anything after it", () => {
    const md = [
      "| SNo. | Case No. | Petitioner / Respondent | Petitioner/Respondent Advocate |",
      "| --- | --- | --- | --- |",
      "| 1 | SLP(C) No. 1/2026 | A Versus B | X- 1 |",
      "**NOTE: Item 1 will be taken up after lunch.**",
      "|  |  | {Mention Memo} IA No. 5/2026 | |",
      "| 2 | SLP(C) No. 2/2026 | C Versus D | Y- 2 |",
    ].join("\n");
    const r = parseCauseList({ id: "x", markdown: md, pages: [{ page: 1, text: md }], fetchedAt: "2026-10-02T10:00:00Z" }, { layout: "sci-table", forum: "sci", listType: "advance", listDate: "2026-10-07" });
    expect(r.records.map((e) => [e.itemNo, e.parsed])).toEqual([["1", true], ["2", true]]);
    expect(r.records[0].raw).not.toContain("IA No. 5/2026");
    expect(r.unparsed).toBe(1);
  });

  it("positional: record-like lines after a mid-page court header mark the record before it unparsed", () => {
    const items = page(1, [
      SC_HEADER,
      [700, [[30, "10"], [60, "SLP(C) No. 10/2026"], [180, "A"], [420, "X- 1"]]],
      [688, [[180, "Versus"]]],
      [676, [[250, "COURT NO. : 6"]]],
      [664, [[180, "B"], [420, "Y- 2"]]],
      [640, [[30, "11"], [60, "SLP(C) No. 11/2026"], [180, "C"]]],
    ]);
    const r = parseCauseList(scDoc(items), SC_OPTS);
    expect(r.records.map((e) => [e.itemNo, e.parsed, e.courtNo])).toEqual([["10", false, null], ["11", true, "6"]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Page boundaries (markdown): records never continue across a page break
// ---------------------------------------------------------------------------------------------------------------------

describe("markdown page boundaries", () => {
  const DHC_HEAD = "| ITEM NUMBER | CASE NUMBER | PARTY NAME | ADVOCATE NAME |\n| --- | --- | --- | --- |";
  const dhc = (pages: string[]) =>
    parseCauseList({ id: "pb", markdown: "", pages: pages.map((text, i) => ({ page: i + 1, text })), fetchedAt: "2026-10-02T10:00:00Z" }, { layout: "dhc", forum: "hc-delhi", listType: "main", listDate: "2026-10-05" });

  it("a continuation row at the top of the next page is never bound to the previous page's item, which becomes unparsed", () => {
    const r = dhc([
      `${DHC_HEAD}\n| 1 | W.P.(C) 123/2026 | A V/s B | X Y |`,
      "| | CM APPL. 999/2026 | C V/s D | Z Q |\n| 2 | W.P.(C) 5/2026 | E V/s F | G |",
    ]);
    expect(r.records.map((e) => [e.itemNo, e.page, e.parsed, e.caseNumbers.map((c) => c.printed), e.parties])).toEqual([
      ["1", 1, false, ["W.P.(C) 123/2026"], "A V/s B"],
      ["2", 2, true, ["W.P.(C) 5/2026"], "E V/s F"],
    ]);
    expect(JSON.stringify(r.records)).not.toContain("CM APPL. 999/2026");
    expect(r.unparsed).toBe(2); // the orphan row + item 1 (unparsed)
  });

  it("a page that starts with a numbered item leaves the previous page's record intact; the URL-paged form reads the same", () => {
    const pages = [`${DHC_HEAD}\n| 1 | W.P.(C) 123/2026 | A V/s B | X Y |\n| | | AND ORS | |`, "| 2 | W.P.(C) 5/2026 | E V/s F | G |"];
    const r = dhc(pages);
    expect(r.records.map((e) => [e.itemNo, e.page, e.parsed, e.parties])).toEqual([["1", 1, true, "A V/s B AND ORS"], ["2", 2, true, "E V/s F"]]);
    // Page-marked markdown without per-page text splits the same way.
    const md = pages.map((p, i) => `<!-- page ${i + 1} -->\n\n${p}`).join("\n\n");
    const m = parseCauseList({ id: "pb", markdown: md, pages: [], fetchedAt: "2026-10-02T10:00:00Z" }, { layout: "dhc", forum: "hc-delhi", listType: "main", listDate: "2026-10-05" });
    expect(m.records.map((e) => [e.itemNo, e.page, e.parsed])).toEqual([["1", 1, true], ["2", 2, true]]);
  });

  it("stray text inside an open record (a cell spilled out of the table) makes that record unparsed", () => {
    const r = dhc([`${DHC_HEAD}\n| 1 | W.P.(C) 123/2026 | A V/s B | X Y |\nShubham Mittal, Adv\n| 2 | W.P.(C) 5/2026 | E V/s F | G |`]);
    expect(r.records.map((e) => [e.itemNo, e.parsed])).toEqual([["1", false], ["2", true]]);
    expect(r.records[0].raw).not.toContain("Shubham");
    // Page furniture is not record text: a page number or a line left with only a removal marker changes nothing.
    const f = dhc([`${DHC_HEAD}\n| 1 | W.P.(C) 123/2026 | A V/s B | X Y |\nPage 3 of 40\n**<[link removed]>**`, "| 2 | W.P.(C) 5/2026 | E V/s F | G |"]);
    expect(f.records.map((e) => [e.itemNo, e.parsed])).toEqual([["1", true], ["2", true]]);
  });

  it("Supreme Court tables: a row repeating the previous page's SNo and Case No continues that record, as printed", () => {
    const head = "| SNo. | Case No. | Petitioner / Respondent | Petitioner/Respondent Advocate |\n| --- | --- | --- | --- |";
    const r = parseCauseList(
      {
        id: "adv",
        markdown: "",
        pages: [
          { page: 1, text: `${head}\n| 1 | SLP(C) No. 1/2026 | A Versus | X- 1 |` },
          { page: 2, text: `${head}\n| 1 | SLP(C) No. 1/2026 | B | |\n| 2 | SLP(C) No. 2/2026 | C Versus D | Y- 2 |` },
        ],
        fetchedAt: "2026-10-02T10:00:00Z",
      },
      { layout: "sci-table", forum: "sci", listType: "advance", listDate: "2026-10-07" },
    );
    expect(r.records.map((e) => [e.itemNo, e.page, e.parsed, e.parties])).toEqual([["1", 1, true, "A Versus B"], ["2", 2, true, "C Versus D"]]);
    // A different case number under the same SNo is not the same record: a new one.
    const other = parseCauseList(
      { id: "adv2", markdown: "", pages: [{ page: 1, text: `${head}\n| 1 | SLP(C) No. 1/2026 | A Versus B | X- 1 |` }, { page: 2, text: `${head}\n| 1 | SLP(C) No. 9/2026 | E Versus F | |` }], fetchedAt: "2026-10-02T10:00:00Z" },
      { layout: "sci-table", forum: "sci", listType: "advance", listDate: "2026-10-07" },
    );
    expect(other.records.map((e) => [e.itemNo, e.page, e.caseNumbers.map((c) => c.printed)])).toEqual([["1", 1, ["SLP(C) No. 1/2026"]], ["1", 2, ["SLP(C) No. 9/2026"]]]);
  });

  it("NCLT: an itemless row at the top of a page is its own unparsed record and the previous page's record becomes unparsed", () => {
    const head = "| Sr. | CP. No. | CA/IA No. | Purpose | Name of the Parties | Name of Counsel for Petitioner/ Applicant |\n| --- | --- | --- | --- | --- | --- |";
    const r = parseCauseList(
      {
        id: "nc",
        markdown: "",
        pages: [
          { page: 1, text: `${head}\n| 7 | CP(IB)/40(MP)2026 | Main Matter | Admission | P V/s Q | A, Adv |` },
          { page: 2, text: `| | IA/12(MP)2026 | | | R V/s S | |\n| 8 | CP(IB)/41(MP)2026 | Main Matter | Admission | T V/s U | B, Adv |` },
        ],
        fetchedAt: "2026-10-02T10:00:00Z",
      },
      { layout: "tribunal", forum: "nclt-indore", listType: "daily", listDate: "2026-10-05" },
    );
    expect(r.records.map((e) => [e.itemNo, e.page, e.parsed])).toEqual([["7", 1, false], [null, 2, false], ["8", 2, true]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Contact data: Indian phone formats, positional items, the pipeline's page scrub
// ---------------------------------------------------------------------------------------------------------------------

describe("contact data is never stored", () => {
  const PHONES = [
    "9810012345",
    "+91-98100-12345",
    "+91 98100 12345",
    "+919810012345",
    "098100-12345",
    "98100 12345",
    "98100-12345",
    "98100.12345",
    "987-654-3210",
    "011-23456789",
    "(011) 2345 6789",
    "0731-2345678",
    "0731 2345678",
    "0731.2345678",
    "+91-731-2345678",
    "9810012345/9810054321",
    "9810012345 / 0731-2345678",
  ];

  it("scrubs common Indian phone formats (including slash-joined lists) and detects them", () => {
    for (const p of PHONES) {
      const s = `RAHUL SHARMA (${p}) (PETITIONER)`;
      expect(hasContact(s), p).toBe(true);
      const c = scrubContact(s);
      expect(c, p).toBe("RAHUL SHARMA ([phone removed]) (PETITIONER)");
      expect(hasContact(c), p).toBe(false);
      expect(scrubContact(c), p).toBe(c); // idempotent
    }
    expect(scrubContact("Mob: 98100 12345, Ph. No. 2338 8922, e-mail adv[at]nic[dot]in")).toBe("Mob: [phone removed], Ph. No. [phone removed], e-mail [e-mail removed]");
    expect(scrubContact("Tel 0731 2345678 adv.x@gmail.com https://zoom.us/j/1")).toBe("Tel [phone removed] [e-mail removed] [link removed]");
  });

  it("leaves case numbers, diary numbers, ranges, dates, citations and amounts alone", () => {
    const keep = [
      "IA No. 209282/2026 Diary No. 54583-2026 W.P.(C)-10678/2022",
      "W.P.(C) Nos. 61234-61235/2026",
      "C.A. No. 3309-3310/1997",
      "CP(IB)/29(MP)2022 IA/259(MP)2026 in C.P.(IB)/18(MP)2021",
      "Comp. App. (AT) (Ins) No. 2133 of 2024",
      "Listed on 26-11-2026 DATE : 05.10.2026 at 10:30 AM",
      "Section 230-232, 241-242 r.w. Rule 11",
      "Rs. 1500000000 INR 25000000000",
      "CNR DLHC010012342026 (2026) 5 SCC 123 2026:DHC:1234",
      "Meeting No. 1669 92 0249",
    ];
    for (const k of keep) {
      expect(scrubContact(k), k).toBe(k);
      expect(hasContact(k), k).toBe(false);
    }
  });

  it("removes at least everything the pipeline's page scrub removes (chunk.ts scrubPersonalData)", () => {
    const corpus = [
      ...PHONES.map((p) => `A. SHARMA ${p} (R-1)`),
      "A. SHARMA (Mob. 98100 12345, adv@x.in) https://dhcvirtualcourt.webex.com/meet/x Ph: 011-23388922",
      "Contact 98765 43210 / 98765 43211; WhatsApp: 9876543210",
      "registrar[at]nclt[dot]gov[dot]in, x (at) y (dot) in",
      "Cisco Webex Video Conference ID : 25174224672",
    ];
    for (const s of corpus) {
      const after = scrubPersonalData(scrubContact(s), { allLinks: true });
      expect(after.counts, s).toEqual({ phones: 0, emails: 0, links: 0 });
    }
  });

  it("advocate names never hold a phone number, a removal marker or a bare contact label", () => {
    expect(tribunalAdvocates("Rahul Sharma, Adv Mob: 98100 12345")).toEqual(["Rahul Sharma"]);
    expect(tribunalAdvocates("Rahul Sharma, Adv 9810012345, 9810054321")).toEqual(["Rahul Sharma"]);
    expect(tribunalAdvocates("Rahul Sharma, Adv (9810012345/9810054321) Priya Rao, Adv Ph. 0731-2345678")).toEqual(["Rahul Sharma", "Priya Rao"]);
    expect(commaAdvocates("RAHUL SHARMA, 9810012345, PRIYA RAO (adv@x.in), [phone removed]")).toEqual(["RAHUL SHARMA", "PRIYA RAO"]);
    expect(scAdvocates("AJAY MARWAH- 2312 Mob. 98100 12345 [R-1], BIMLESH KUMAR SINGH, [e-mail removed]")).toEqual(["AJAY MARWAH (AOR 2312)", "BIMLESH KUMAR SINGH"]);
  });

  it("entries read from positional PDF items (not scrubbed upstream) store no phone number or e-mail in raw, parties, advocates or bench", () => {
    const items = page(1, [
      [800, [[40, "NATIONAL COMPANY LAW TRIBUNAL INDORE BENCH COURT ROOM NO. 1"]]],
      [780, [[40, "CORAM: HON'BLE Shri. X Y, MEMBER JUDICIAL (Ph. 0731-2345678)"]]],
      [760, [[20, "Sr."], [70, "CP. No."], [190, "CA/IA No."], [340, "Purpose"], [470, "Name of the Parties"], [690, "Name of Counsel for Petitioner/"], [910, "Name of Counsel for Respondent"]]],
      [740, [[20, "5"], [50, "CP(IB)/40(MP)2026"], [160, "Main Matter"], [330, "Admission"], [440, "P Ltd (98100 12345) V/s Q Ltd"], [680, "Rahul Sharma, Adv"], [900, "Priya Rao, Adv"]]],
      [728, [[680, "Mob: +91-98100-12345"], [900, "priya.rao@example.com"]]],
      [716, [[680, "9810012345/9810054321"], [900, "Ph. 011-23456789"]]],
    ]);
    const r = parseCauseList({ id: "pos_contact", markdown: "", pages: [], items, fetchedAt: "2026-10-02T10:00:00Z" }, { layout: "tribunal", forum: "nclt-indore", listType: "daily", listDate: "2026-10-05" });
    expect(r.records).toHaveLength(1);
    const e = r.records[0];
    expect(e).toMatchObject({ itemNo: "5", parsed: true, advocates: ["Rahul Sharma", "Priya Rao"] });
    expect(e.caseNumbers.map((c) => c.printed)).toEqual(["CP(IB)/40(MP)2026"]);
    const stored = JSON.stringify({ raw: e.raw, parties: e.parties, advocates: e.advocates, bench: e.bench });
    expect(stored).not.toMatch(/@|98100|12345|9810054321|2345678|23456789/);
    expect(e.raw).toContain("[phone removed]");
    expect(e.bench).toContain("[phone removed]");
    for (const v of [e.raw, e.parties ?? "", e.bench ?? "", ...e.advocates]) expect(hasContact(v)).toBe(false);
  });
});
