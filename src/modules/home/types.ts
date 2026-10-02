/** Client-safe types shared by the home module's server services, API routes and UI. */
import type { CalendarEvent, Matter, NewsItem, Person, PracticeArea, Task, TeamUpdate } from "@/lib/types/domain";
import { CURRENT_USER } from "@/lib/current-user";

/** Static id of the demo persona; services resolve the live identity with `currentUser()` (honours LECLAUDE_USER_ID). */
/** The signed-in user id, resolved per call. */
export function currentUserId(): string { return CURRENT_USER.id; }

export type BriefItemKind = "deadline" | "hearing" | "task" | "news" | "update" | "matter" | "note";

export interface BriefItem {
  kind: BriefItemKind;
  text: string;
  matterId?: string | null;
  href?: string | null;
}

export interface DailyBrief {
  date: string; // YYYY-MM-DD
  generatedAt: string;
  source: "ai" | "computed";
  model?: string;
  headline: string;
  items: BriefItem[];
  stats: { eventsToday: number; eventsThisWeek: number; overdueTasks: number; dueSoonTasks: number; hotNews: number; recentUpdates: number };
}

/** A calendar entry: a stored event or a matter key date projected as a read-only deadline. */
export interface CalendarEntry extends CalendarEvent {
  /** Present for matter key-date pseudo-events (not editable). */
  derived?: { source: "matter-key-date"; matterId: string; label: string };
}

export interface UpdateReply {
  id: string;
  updateId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface TeamUpdateView extends TeamUpdate {
  replies: UpdateReply[];
  /** Emoji the current user has reacted with. */
  myReactions: string[];
}

export interface MatterOverview {
  id: string;
  shortName: string;
  name: string;
  caption?: string;
  client: string;
  clientSide: Matter["clientSide"];
  practiceArea: PracticeArea;
  stage?: string;
  status: Matter["status"];
  leadAttorneyId?: string;
  teamIds: string[];
  nextKeyDate?: { label: string; date: string; daysUntil: number };
  keyDates: { label: string; date: string; daysUntil: number }[];
  openTasks: number;
  overdueTasks: number;
  myOpenTasks: number;
  hotDocs: number;
  docCount: number;
  upcomingEvents: number;
  nextEvent?: { id: string; title: string; startsAt: string; kind: CalendarEvent["kind"] };
}

export interface PersonLite { id: string; name: string; title?: string; role: Person["role"]; organization?: string }
export interface MatterLite {
  id: string; shortName: string; name: string; caption?: string; client: string; practiceArea: PracticeArea; status: Matter["status"]; stage?: string; teamIds: string[]; leadAttorneyId?: string; keyDates: { label: string; date: string }[];
  /** Next hearing as recorded in the matter's case particulars (`matter.india`), entered by hand; absent when not recorded. */
  nextHearing?: { date: string; purpose?: string; courtHall?: string; item?: number };
}

export interface HomeInitialData {
  now: string; // ISO timestamp used for the first render (hydration-safe)
  aiConfigured: boolean;
  /** True once the intelligence layer holds published insights; the "For you" slot fetches only then. */
  intelInsights?: boolean;
  /** Workspace counts behind the first-run checklist (matters, e-discovery documents, people). */
  setup?: { matters: number; documents: number; people: number };
  userId: string;
  userName: string;
  people: PersonLite[];
  matters: MatterLite[];
  tasks: Task[];
  events: CalendarEntry[];
  news: NewsItem[];
  updates: TeamUpdateView[];
  matterOverview: MatterOverview[];
  brief: DailyBrief;
}

/** Optional fields that may be sent as `null` to clear them. */
type Clearable<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] | null };
type TaskClearable = "matterId" | "assigneeId" | "dueAt" | "description";
type EventClearable = "matterId" | "endsAt" | "location" | "notes" | "ruleSource";
export type TaskInput = Clearable<Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>, TaskClearable> & { title: string };
export type TaskPatch = Clearable<Partial<Omit<Task, "id" | "createdAt">>, TaskClearable>;
export type EventInput = Clearable<Partial<Omit<CalendarEvent, "id">>, EventClearable> & { title: string; startsAt: string };
export type EventPatch = Clearable<Partial<Omit<CalendarEvent, "id">>, EventClearable>;

export const NEWS_CATEGORIES: NewsItem["category"][] = ["court", "regulatory", "legislative", "industry", "firm", "client"];
export const PRACTICE_AREAS: PracticeArea[] = ["Litigation", "Products Liability", "Commercial", "Corporate / M&A", "Employment", "Regulatory", "IP", "Real Estate"];
export const EVENT_KINDS: CalendarEvent["kind"][] = ["deadline", "hearing", "deposition", "meeting", "filing", "internal", "cle", "other"];
export const TASK_STATUSES: Task["status"][] = ["todo", "in_progress", "review", "done"];
export const TASK_PRIORITIES: Task["priority"][] = ["low", "medium", "high", "urgent"];
export const UPDATE_KINDS: TeamUpdate["kind"][] = ["update", "win", "announcement", "question"];
export const REACTIONS = ["👍", "🎉", "👀"] as const;

export const TASK_STATUS_LABEL: Record<Task["status"], string> = { todo: "To do", in_progress: "In progress", review: "Review", done: "Done" };
export const EVENT_KIND_LABEL: Record<CalendarEvent["kind"], string> = { deadline: "Deadline", hearing: "Hearing", deposition: "Deposition", meeting: "Meeting", filing: "Filing", internal: "Internal", cle: "CLE", other: "Other" };
