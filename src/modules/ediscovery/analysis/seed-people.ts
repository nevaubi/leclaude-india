import type { Person } from "@/lib/types/domain";

/** External people referenced in seeded email headers and testimony (stable ids). */
export const EXTRA_PEOPLE_IDS = {
  merrick: "x_vls_pmerrick",
  liu: "x_vls_kliu",
  ferris: "x_vls_dferris",
  whitcomb: "x_vls_dwhitcomb",
  rourke: "x_vls_jrourke",
  ferrante: "x_vls_lferrante",
  duffy: "x_vls_rduffy",
  feld: "x_vls_mfeld",
  nunez: "x_vls_cnunez",
  bello: "x_vls_ybello",
} as const;

const X = EXTRA_PEOPLE_IDS;

export const EXTRA_PEOPLE: Person[] = [
  { id: X.merrick, name: "Pankaj Malhotra", title: "SVP Operations", organization: "Meridian Fine Chemicals Ltd.", role: "witness", tags: ["non-custodian"] },
  { id: X.liu, name: "Kavita Lal", title: "Director of Marketing, Textile Chemicals", organization: "Meridian Fine Chemicals Ltd.", role: "witness", tags: ["non-custodian"] },
  { id: X.ferris, name: "Dinesh Pherwani", title: "Chief Executive Officer (2001)", organization: "Meridian Fine Chemicals Ltd.", role: "witness", tags: ["non-custodian"] },
  { id: X.whitcomb, name: "Col. Devendra Wadhwa", title: "DQA-T qualification program", organization: "Defence qualification authority (DQA-T)", role: "other" },
  { id: X.rourke, name: "Jyoti Rathore", title: "Regional Office (Water)", organization: "Gujarat Pollution Control Board", role: "other" },
  { id: X.ferrante, name: "Lata Fernandes", title: "Director, Water Management Services", organization: "Valsara Textile Park Ltd.", role: "other" },
  { id: X.duffy, name: "Raghav Dutta", title: "Secretary", organization: "Sarangpur Processors' Co-operative", role: "other" },
  { id: X.feld, name: "Mahesh Phadke", title: "Hazardous Substances Management Division", organization: "Central Pollution Control Board", role: "other" },
  { id: X.nunez, name: "Charu Nair", title: "Project hydrogeologist", organization: "Beacon Enviro Services", role: "other" },
  { id: X.bello, name: "Dr. Yusuf Bilgrami", title: "Study pathologist", organization: "Sundaram Laboratories", role: "expert" },
];
