/**
 * Statutes landing: a curated list of frequently used Central Acts, grouped by subject (pure, client-safe).
 *
 * Only exact citation titles are listed. Each is resolved at run time against the corpus by exact title
 * (`exactCentralAct`); a title that does not resolve is left out and counted, never replaced by a similar Act.
 * Section counts and status always come from the corpus, never from this list.
 */

export interface KeyAct { title: string; short?: string }
export interface KeyActGroup { key: string; label: string; acts: KeyAct[] }

/** The 2023 criminal laws and the Acts they replaced (Act titles only; the relationship is shown as "replaced"). */
export const NEW_CRIMINAL_LAWS: { title: string; short: string; subject: string; predecessor: { title: string; short: string } }[] = [
  { title: "Bharatiya Nyaya Sanhita, 2023", short: "BNS", subject: "Offences and punishments", predecessor: { title: "Indian Penal Code, 1860", short: "IPC" } },
  { title: "Bharatiya Nagarik Suraksha Sanhita, 2023", short: "BNSS", subject: "Criminal procedure", predecessor: { title: "Code of Criminal Procedure, 1973", short: "CrPC" } },
  { title: "Bharatiya Sakshya Adhiniyam, 2023", short: "BSA", subject: "Evidence", predecessor: { title: "Indian Evidence Act, 1872", short: "Evidence Act" } },
];

export const KEY_ACT_GROUPS: KeyActGroup[] = [
  { key: "criminal", label: "Criminal", acts: [{ title: "Negotiable Instruments Act, 1881", short: "NI Act" }, { title: "Information Technology Act, 2000", short: "IT Act" }, { title: "Prevention of Corruption Act, 1988", short: "PC Act" }] },
  { key: "civil", label: "Civil procedure", acts: [{ title: "Code of Civil Procedure, 1908", short: "CPC" }, { title: "Limitation Act, 1963" }, { title: "Commercial Courts Act, 2015" }] },
  { key: "commercial", label: "Contract and commercial", acts: [{ title: "Indian Contract Act, 1872" }, { title: "Specific Relief Act, 1963" }, { title: "Arbitration and Conciliation Act, 1996", short: "A&C Act" }, { title: "Sale of Goods Act, 1930" }, { title: "Consumer Protection Act, 2019" }] },
  { key: "property", label: "Property", acts: [{ title: "Transfer of Property Act, 1882", short: "TPA" }, { title: "Registration Act, 1908" }, { title: "Real Estate (Regulation and Development) Act, 2016", short: "RERA" }] },
  { key: "corporate", label: "Corporate and insolvency", acts: [{ title: "Companies Act, 2013" }, { title: "Insolvency and Bankruptcy Code, 2016", short: "IBC" }, { title: "Securities and Exchange Board of India Act, 1992", short: "SEBI Act" }] },
  { key: "tax", label: "Tax", acts: [{ title: "Income-tax Act, 1961" }, { title: "Central Goods and Services Tax Act, 2017", short: "CGST Act" }] },
  { key: "labour", label: "Labour", acts: [{ title: "Industrial Disputes Act, 1947" }, { title: "Code on Wages, 2019" }] },
  { key: "family", label: "Family", acts: [{ title: "Hindu Marriage Act, 1955" }, { title: "Hindu Succession Act, 1956" }, { title: "Special Marriage Act, 1954" }] },
  { key: "constitutional", label: "Constitutional and public law", acts: [{ title: "Right to Information Act, 2005", short: "RTI Act" }, { title: "Representation of the People Act, 1951" }] },
];

/** Every title the landing looks up: the new criminal laws, their predecessors, then the subject groups. */
export const KEY_ACT_TITLES: string[] = Array.from(new Set([
  ...NEW_CRIMINAL_LAWS.flatMap((l) => [l.title, l.predecessor.title]),
  ...KEY_ACT_GROUPS.flatMap((g) => g.acts.map((a) => a.title)),
]));

/** Resolved Acts in subject order (groups with nothing resolved are dropped). */
export function groupKeyActs<T>(found: { wanted: string; hit: T }[]): { key: string; label: string; items: { act: KeyAct; hit: T }[] }[] {
  const byTitle = new Map(found.map((f) => [f.wanted, f.hit]));
  return KEY_ACT_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    items: g.acts.flatMap((act) => { const hit = byTitle.get(act.title); return hit ? [{ act, hit }] : []; }),
  })).filter((g) => g.items.length);
}
