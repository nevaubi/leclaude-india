/**
 * Demo library content: a matter folder for each demo matter (same ids the library would create), working subfolders
 * for the commercial suit and the writ, and notes with real text. Items are synthetic work product ("demo" tag).
 */
import type { LibraryItem } from "@/lib/types/domain";
import { LIBRARY_FOLDERS, matterFolderId } from "@/modules/library/ids";
import { DEMO_ID_PREFIX, DEMO_MATTERS, DEMO_TEAM } from "../ids";
import type { DemoBuildContext } from "./context";
import type { DemoMatter } from "./matters";

export const DEMO_FOLDERS = {
  pleadings: `${DEMO_ID_PREFIX}lib_pleadings`,
  evidence: `${DEMO_ID_PREFIX}lib_evidence`,
  arguments: `${DEMO_ID_PREFIX}lib_arguments`,
  writ: `${DEMO_ID_PREFIX}lib_writ_drafts`,
  bail: `${DEMO_ID_PREFIX}lib_bail_drafts`,
} as const;

const FOLDER_DEFS: { id: string; matterId: string; name: string; description: string }[] = [
  { id: DEMO_FOLDERS.pleadings, matterId: DEMO_MATTERS.commercial, name: "Pleadings", description: "Plaint, written statement and counter-claim, written statement to the counter-claim, issues." },
  { id: DEMO_FOLDERS.evidence, matterId: DEMO_MATTERS.commercial, name: "Evidence", description: "Chief affidavits, deposition notes, exhibit index Ex.P1–P25 / Ex.D1–D18." },
  { id: DEMO_FOLDERS.arguments, matterId: DEMO_MATTERS.commercial, name: "Arguments", description: "Written arguments, synopsis and authorities." },
  { id: DEMO_FOLDERS.writ, matterId: DEMO_MATTERS.writ, name: "Drafts", description: "Writ petition, reply affidavit, material papers." },
  { id: DEMO_FOLDERS.bail, matterId: DEMO_MATTERS.bail, name: "Drafts", description: "Bail petition, surety papers, list of dates." },
];

export function buildDemoFolders(ctx: DemoBuildContext, matters: DemoMatter[]): LibraryItem[] {
  const at = ctx.now.toISOString();
  const roots: LibraryItem[] = matters.map((m) => ({ id: matterFolderId(m.id), parentId: LIBRARY_FOLDERS.matters, name: m.shortName, type: "folder", matterId: m.id, description: `${m.name}${m.caption ? ` — ${m.caption}` : ""}`, practiceArea: m.practiceArea, ownerId: ctx.ownerId, sharedWith: ["matter-team"], tags: ["demo"], createdAt: at, updatedAt: at }));
  const subs: LibraryItem[] = FOLDER_DEFS.map((f) => ({ id: f.id, parentId: matterFolderId(f.matterId), name: f.name, type: "folder", matterId: f.matterId, description: f.description, practiceArea: "Litigation", ownerId: ctx.ownerId, sharedWith: ["matter-team"], tags: ["demo"], createdAt: at, updatedAt: at }));
  return [...roots, ...subs];
}

interface ItemSpec { key: string; folder: keyof typeof DEMO_FOLDERS; name: string; content: string; tags: string[]; owner: "owner" | "junior" | "clerk"; daysAgo: number; starred?: boolean }

const ITEMS: ItemSpec[] = [
  { key: "list_of_dates", folder: "arguments", name: "List of dates — Com.O.S. 1187/2023", owner: "junior", daysAgo: 12, starred: true, tags: ["list of dates"], content: "# List of dates (demo)\n\n| Date | Event | Record |\n|---|---|---|\n| 14.02.2022 | MSA and SOW-1 | Ex.P2, Ex.P3 |\n| 26.09.2022 | CR-07: pilot subject to master data by 15.10.2022 | Ex.P5 |\n| 09.11.2022 | Clause 11.4 notice | Ex.P8 |\n| 21.12.2022 | UAT sign-off, subject to 14 Sev-3 defects | Ex.P9 |\n| 12.01.2023 | Complete master data received | Ex.D8 |\n| 06.02.2023 | Pilot live | Ex.P10 |\n| 22.03.2023 | Hubballi outage (75 min per Ex.P12; 3½ h per Ex.D11) | Ex.P12, Ex.P16, Ex.D11 |\n| 31.03.2023 | 46 stores live | Ex.P13 |\n| 05.04.2023 | CFO acknowledges M3, M4 due | Ex.P14 |\n| 12.04.2023 | ₹60 lakh paid | Ex.P20 |\n| 18.05.2023 | Legal notice | Ex.P17 |\n| 14.08.2023 | s.12A non-starter | Ex.P21 |\n| 29.08.2023 | Suit filed | Plaint |\n\n_Synthetic demonstration record._" },
  { key: "issue_notes", folder: "arguments", name: "Issue-wise notes for arguments", owner: "owner", daysAgo: 8, tags: ["arguments"], content: "# Issue-wise notes (demo)\n\n**Issue 1 (amounts due).** Ex.P9 + DW-1's admissions (cross 20.01.2025) and his later qualification (17.02.2025) — cite both; condition in Ex.P9 met (all 14 defects closed). Production use from 31.03.2023 (Ex.P13) is acceptance under clause 9.3.\n\n**Issue 3 (LD).** Clause 11.4: delay caused by the customer's inputs extends the date day for day; master data complete only on 12.01.2023; go-live 25 days later.\n\n**Issues 4–5 (counter-claim).** Clause 12.3 excludes loss of sales; Ex.D10 compares 2022 (with three closed stores) with 2023.\n\nAuthorities to be added after reading — mark each [VERIFY] until read." },
  { key: "writ_points", folder: "writ", name: "Points for reply affidavit — W.P. 18234/2026", owner: "clerk", daysAgo: 4, tags: ["writ"], content: "# Reply affidavit — points (demo)\n\n1. Notice annexes no survey and offers no hearing (Material papers, p. 14–15).\n2. 2019 building permission with Irrigation NOC: plot outside FTL and buffer.\n3. The municipality's survey of 12.08.2026 records the building about 38 m from the FTL (Telugu original; translation filed).\n4. The 'revised 2024 map' in the counter is not annexed — call for it.\n5. Survey conducted without the notice required by the status-quo order of 31.07.2026.\n\nBuffer width: to be taken from the notification after reading it [VERIFY]." },
];

export function buildDemoLibraryItems(ctx: DemoBuildContext): LibraryItem[] {
  const owners = { owner: ctx.ownerId, junior: DEMO_TEAM.junior, clerk: DEMO_TEAM.clerk };
  const matterOf: Record<keyof typeof DEMO_FOLDERS, string> = { pleadings: DEMO_MATTERS.commercial, evidence: DEMO_MATTERS.commercial, arguments: DEMO_MATTERS.commercial, writ: DEMO_MATTERS.writ, bail: DEMO_MATTERS.bail };
  return ITEMS.map((i) => {
    const at = new Date(ctx.now.getTime() - i.daysAgo * 86_400_000).toISOString();
    return { id: `${DEMO_ID_PREFIX}lib_${i.key}`, parentId: DEMO_FOLDERS[i.folder], name: i.name, type: "note", matterId: matterOf[i.folder], content: i.content, size: i.content.length, tags: ["demo", ...i.tags], ownerId: owners[i.owner], sharedWith: ["matter-team"], starred: i.starred, createdAt: at, updatedAt: at, practiceArea: "Litigation", status: "draft" };
  });
}
