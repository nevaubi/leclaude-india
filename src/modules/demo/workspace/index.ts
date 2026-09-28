/**
 * Pure builders for the workspace half of the India demo pack: matters, team, tasks, calendar, team updates and
 * library content. Office document content lives in ./office (server-only: it uses the Word template builders). The
 * loader in src/modules/demo/index.ts writes all of it.
 */
import type { CalendarEvent, LibraryItem, Task, TeamUpdate } from "@/lib/types/domain";
import type { DemoBuildContext } from "./context";
import { buildDemoEvents, buildDemoTasks, buildDemoUpdates } from "./home";
import { buildDemoFolders, buildDemoLibraryItems } from "./library";
import { buildDemoMatters, type DemoMatter } from "./matters";
import { buildDemoTeam, type DemoPerson } from "./people";

export * from "./context";
export { DEMO_FOLDERS } from "./library";
export { DEMO_BAIL_NUMBER, DEMO_COMMERCIAL_NUMBER, DEMO_WRIT_NUMBER, type DemoMatter } from "./matters";
export { DEMO_TEAM_PROFILES, type DemoPerson } from "./people";

export interface DemoWorkspace {
  matters: DemoMatter[];
  team: DemoPerson[];
  tasks: Task[];
  events: CalendarEvent[];
  updates: TeamUpdate[];
  folders: LibraryItem[];
  libraryItems: LibraryItem[];
}

export function buildDemoWorkspace(ctx: DemoBuildContext, opts: { takenEmails?: ReadonlySet<string> } = {}): DemoWorkspace {
  const matters = buildDemoMatters(ctx);
  return {
    matters,
    team: buildDemoTeam(ctx, opts.takenEmails),
    tasks: buildDemoTasks(ctx),
    events: buildDemoEvents(ctx),
    updates: buildDemoUpdates(ctx),
    folders: buildDemoFolders(ctx, matters),
    libraryItems: buildDemoLibraryItems(ctx),
  };
}
