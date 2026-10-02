import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardExtracted, parseApRoster, parseCardRoster, parseSciRoster, parseTableRoster, rosterDate } from "@/modules/judges/parse";
import { ROSTER_SOURCES } from "@/modules/judges/sources";

const fx = (name: string) => readFileSync(join(__dirname, "fixtures/enrichment", name), "utf8");

describe("roster dates", () => {
  it("reads dd-mm-yyyy variants and refuses anything else", () => {
    expect(rosterDate("24-05-2019")).toBe("2019-05-24");
    expect(rosterDate("09/02/1969")).toBe("1969-02-09");
    expect(rosterDate("31.03.2014")).toBe("2014-03-31");
    expect(rosterDate("NA")).toBeNull();
    expect(rosterDate("31-02-2020")).toBeNull();
    expect(rosterDate("")).toBeNull();
  });
});

describe("Supreme Court roster (sci.gov.in Chief Justice & Judges)", () => {
  const url = "https://www.sci.gov.in/chief-justice-judges/";
  const { entries } = parseSciRoster(fx("sci-chief-justice-judges.md"), url);

  it("reads the Chief Justice and every judge card, and nothing else", () => {
    expect(entries.map((e) => e.name)).toEqual(["Surya Kant", "Vikram Nath", "B.V. Nagarathna", "Satish Chandra Sharma", "V. Mohana"]);
  });

  it("keeps the printed name, dates, profile and photo exactly as published", () => {
    const cji = entries[0];
    expect(cji).toMatchObject({
      printedName: "Justice Surya Kant", designation: "Chief Justice of India", dateOfAppointment: "2019-05-24", retirementDate: "2027-02-09",
      photoUrl: "https://cdnbbsr.s3waas.gov.in/s3ec0490f1f4972d133619a60c30f3559e/uploads/2023/10/2025102910.jpg", profileUrl: null,
    });
    const bvn = entries[2];
    expect(bvn).toMatchObject({ nameNormalized: "B V NAGARATHNA", designation: "Judge", dateOfAppointment: "2021-08-31", retirementDate: "2027-10-29", profileUrl: "https://www.sci.gov.in/judge/justice-b-v-nagarathna/" });
    expect(entries.every((e) => e.termExpires === null)).toBe(true);
  });
});

describe("Telangana roster (tshc.gov.in sitting judges)", () => {
  const { entries } = parseCardRoster(fx("tshc-sitting-judges.md"), "https://tshc.gov.in/processMenuTypes?id=6", { designations: true });
  it("reads the Chief Justice heading and the linked cards", () => {
    expect(entries.map((e) => e.nameNormalized)).toEqual(["APARESH KUMAR SINGH", "P SAM KOSHY", "MOUSHUMI BHATTACHARYA", "K LAKSHMAN", "B R MADHUSUDHAN RAO"]);
    expect(entries[0]).toMatchObject({ designation: "Chief Justice", profileUrl: null, photoUrl: "https://tshc.gov.in/images/admin_2025_08_01T17_06_32converted-image.png" });
    expect(entries[1]).toMatchObject({ designation: "Judge", profileUrl: "https://tshc.gov.in/showJudgeProfile?id=396" });
    expect(entries[4].photoUrl).toBe("https://tshc.gov.in/images/admin_2025_05_22T12_53_31Madhusudhan%20sir.png");
  });
  it("prints no dates the page does not show", () => {
    expect(entries.every((e) => e.dateOfAppointment === null && e.retirementDate === null)).toBe(true);
  });
});

describe("Delhi roster (cards, designations not read)", () => {
  const { entries } = parseCardRoster(fx("delhi-cj-sitting-judges.md"), "https://delhihighcourt.nic.in/web/CJ_Sitting_Judges", { designations: false });
  it("reads the cards with their profile links and leaves designation null", () => {
    expect(entries.map((e) => e.name)).toEqual(["NITIN WASUDEO SAMBRE", "Prathiba M. Singh", "C. Hari Shankar"]);
    expect(entries.every((e) => e.designation === null)).toBe(true);
    expect(entries[1].profileUrl).toBe("https://delhihighcourt.nic.in/web/Judges/justice-prathiba-m-singh");
  });
});

describe("Andhra Pradesh roster (aphc.gov.in profiles)", () => {
  const url = "https://aphc.gov.in/profiles.php";
  const { entries } = parseApRoster(fx("aphc-profiles.md"), url);
  it("reads the Chief Justice, judges and additional judges with their printed dates", () => {
    expect(entries.map((e) => e.name)).toEqual(["Lisa Gill", "Ravi Nath Tilhari", "Y. Lakshmana Rao", "Alapati Giridhar"]);
    expect(entries[0]).toMatchObject({ designation: "Chief Justice", dateOfAppointment: "2014-03-31", retirementDate: "2028-11-16", termExpires: null, profileUrl: url });
    expect(entries[1]).toMatchObject({ designation: "Judge", nameNormalized: "RAVI NATH TILHARI", retirementDate: "2031-02-08" });
    expect(entries[2]).toMatchObject({ retirementDate: null, termExpires: "2027-01-23" });
    expect(entries[3]).toMatchObject({ dateOfAppointment: "2026-07-06", termExpires: "2028-07-05" });
  });
  it("ignores logos and app-store badges", () => {
    expect(entries.some((e) => /logo|google_play|hc\.png/.test(e.photoUrl ?? ""))).toBe(false);
  });
});

describe("Bombay roster (table view)", () => {
  const { entries } = parseTableRoster(fx("bombay-cj-sitting-judges.md"), "https://bombayhighcourt.gov.in/bhc/cj-sitting-judges", { designations: true });
  it("reads both tables once (the card grid above is not duplicated)", () => {
    expect(entries.map((e) => e.nameNormalized)).toEqual(["MAHESH CHANDRA TRIPATHI", "A S GADKARI", "BHARATI DANGRE", "N R BORKAR", "RAJ D WAKODE"]);
  });
  it("maps designations and dates by column header and section", () => {
    expect(entries[0]).toMatchObject({ designation: "Chief Justice", dateOfAppointment: "2026-09-09", retirementDate: "2028-06-20" });
    expect(entries[1]).toMatchObject({ name: "A.S. GADKARI", designation: "Judge" });
    expect(entries[3].photoUrl).toBe("https://bombayhighcourt.gov.in/bhc/storage/judge_images/1743773060!!!!NRB[1].jpg");
    expect(entries[4]).toMatchObject({ designation: "Additional Judge", dateOfAppointment: "2025-09-02", retirementDate: null, termExpires: "2027-09-01" });
  });
});

describe("guarded extraction", () => {
  const md = "## Judges\n\n![p](https://hc.example.gov.in/p/1.jpg)\n\nHon'ble Mr. Justice S G Pandit\n\nDate of Appointment: 14-02-2018\n\n[Profile](https://hc.example.gov.in/j/1)";
  it("keeps only names, URLs and dates printed on the page", () => {
    const { entries, notes } = guardExtracted([
      { name: "Hon'ble Mr. Justice S G Pandit", photo_url: "https://hc.example.gov.in/p/1.jpg", profile_url: "https://hc.example.gov.in/j/1", date_of_appointment: "14-02-2018", date_of_retirement: "01-01-2030", designation: "Judge" },
      { name: "Justice Invented Person", photo_url: "https://hc.example.gov.in/p/2.jpg" },
      { name: "Hon'ble Mr. Justice S G Pandit", photo_url: "https://elsewhere.example/x.jpg" },
    ], md, "https://hc.example.gov.in/judges");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ nameNormalized: "S G PANDIT", photoUrl: "https://hc.example.gov.in/p/1.jpg", profileUrl: "https://hc.example.gov.in/j/1", dateOfAppointment: "2018-02-14", retirementDate: null, designation: null });
    expect(notes.join(" ")).toMatch(/Invented Person.*not printed/);
  });
  it("drops a URL the page does not contain", () => {
    const { entries } = guardExtracted([{ name: "Justice S G Pandit", photo_url: "https://elsewhere.example/x.jpg" }], md, "https://hc.example.gov.in/judges");
    expect(entries[0].photoUrl).toBeNull();
  });
  it("treats apostrophe variants as the same character but still drops names that are not printed", () => {
    const page = "| Hon`ble Mr. Justice Vibhu Bakhru | Chief Justice |\n| Hon’ble Mr. Justice Anu Sivaraman |";
    const { entries } = guardExtracted([{ name: "Hon'ble Mr. Justice Vibhu Bakhru" }, { name: "Hon'ble Mr. Justice Anu Sivaraman" }, { name: "Hon'ble Mr. Justice Someone Else" }], page, "https://hc.example.gov.in/judges");
    expect(entries).toHaveLength(2);
  });
});

describe("source registry", () => {
  it("lists only official https pages, once per court, with how each was verified", () => {
    const ids = ROSTER_SOURCES.map((s) => s.courtId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ROSTER_SOURCES) {
      expect(s.url).toMatch(/^https:\/\/[^/]*(gov\.in|nic\.in)\//);
      expect(["content", "listing", "unreachable"]).toContain(s.verified);
      if (s.verified === "unreachable") expect(s.parser).toBe("extract");
    }
  });
});
