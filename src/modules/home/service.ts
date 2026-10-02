import "server-only";
import type { Principal } from "@/lib/auth/types";
import { currentPrincipal } from "@/lib/auth/context";
import { hasMatterAccess } from "@/lib/auth/policy";
import { listDocSets } from "@/modules/documents/server";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import type { CalendarEvent, LibraryItem, NewsItem, PracticeArea, Task, TeamUpdate } from "@/lib/types/domain";
import { fetchJSON } from "@/lib/ai/toolkit/http";
import { HOME_COLLECTIONS } from "./seed";
import { currentUser, DEFAULT_USER } from "@/lib/current-user";
import { type CalendarEntry, type DailyBrief, type EventInput, type EventPatch, type HomeInitialData, type MatterLite, type MatterOverview, type PersonLite, type TaskInput, type TaskPatch, type TeamUpdateView, type UpdateReply } from "./types";
import { addDays, dateKey, daysBetween, toDate } from "./time";
import { computeFallbackBrief, type BriefContext } from "./brief-fallback";
import { FEATURES } from "@/lib/features";
import type { IndianCaseInfo } from "@/modules/matters/india";

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export function listPeopleLite(): PersonLite[] {
  return db().people.list({ sortBy: "name" }).map((p) => ({ id: p.id, name: p.name, title: p.title, role: p.role, organization: p.organization }));
}

/** The next hearing recorded in a matter's case particulars (date-only, valid ISO), or undefined. */
export function nextHearingOf(india: IndianCaseInfo | undefined): MatterLite["nextHearing"] {
  const date = india?.nextHearing;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const item = india?.causeList?.status === "listed" && india.causeList.listDate === date ? india.causeList.item : undefined;
  return { date, ...(india?.hearingPurpose ? { purpose: india.hearingPurpose } : {}), ...(india?.courtHall ? { courtHall: india.courtHall } : {}), ...(item ? { item } : {}) };
}

/**
 * Open matters the principal may read (with their recorded next hearing). No principal → no matters: the list is
 * never widened to every matter for want of a principal.
 */
export function listMattersLite(principal: Principal | null = currentPrincipal()): MatterLite[] {
  if (!principal) return [];
  return db().matters.list({ where: (m) => m.status !== "closed" && hasMatterAccess(principal, m.id), sortBy: "shortName" }).map((m) => {
    const nextHearing = nextHearingOf((m as typeof m & { india?: IndianCaseInfo }).india);
    return { id: m.id, shortName: m.shortName, name: m.name, caption: m.caption, client: m.client, practiceArea: m.practiceArea, status: m.status, stage: m.stage, teamIds: m.teamIds, leadAttorneyId: m.leadAttorneyId, keyDates: m.keyDates ?? [], ...(nextHearing ? { nextHearing } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskFilter { matterId?: string | null; assigneeId?: string | null; status?: Task["status"] | null; overdue?: boolean; now?: Date; includeDone?: boolean }

const PRIORITY_RANK: Record<Task["priority"], number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const ad = a.dueAt ?? "9999", bd = b.dueAt ?? "9999";
    if (ad !== bd) return ad.localeCompare(bd);
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function listTasks(filter: TaskFilter = {}): Task[] {
  const now = filter.now ?? new Date();
  return sortTasks(db().tasks.find((t) =>
    (!filter.matterId || t.matterId === filter.matterId) &&
    (!filter.assigneeId || t.assigneeId === filter.assigneeId) &&
    (!filter.status || t.status === filter.status) &&
    (filter.includeDone !== false || t.status !== "done") &&
    (!filter.overdue || (t.status !== "done" && !!t.dueAt && daysBetween(now, toDate(t.dueAt)) < 0)),
  ));
}

export function getTask(id: string): Task | null {
  return db().tasks.get(id);
}

/** `opts.id` gives a deterministic id to a caller that must stay idempotent (it checks for the id first). */
export function createTask(input: TaskInput, userId = currentUser().id, opts: { id?: string } = {}): Task {
  const ts = nowIso();
  const task: Task = {
    id: opts.id ?? `t_${nanoid(10)}`,
    title: input.title.trim(),
    description: input.description ?? undefined,
    matterId: input.matterId ?? undefined,
    assigneeId: input.assigneeId ?? userId,
    createdById: input.createdById ?? userId,
    status: input.status ?? "todo",
    priority: input.priority ?? "medium",
    dueAt: input.dueAt ?? undefined,
    createdAt: ts,
    updatedAt: ts,
    tags: input.tags,
    source: input.source ?? "manual",
    links: input.links,
  };
  return db().tasks.put(stripUndefined(task));
}

export function updateTask(id: string, patch: TaskPatch): Task | null {
  const cur = db().tasks.get(id);
  if (!cur) return null;
  const next = applyPatch(cur, patch as Record<string, unknown>);
  return db().tasks.put({ ...next, id, createdAt: cur.createdAt, updatedAt: nowIso() });
}

export function deleteTask(id: string): boolean {
  return db().tasks.delete(id);
}

// ---------------------------------------------------------------------------
// Events + matter key dates
// ---------------------------------------------------------------------------

export interface EventFilter { from?: string; to?: string; matterId?: string | null; includeKeyDates?: boolean }

export function keyDateEntries(): CalendarEntry[] {
  const d = db();
  const out: CalendarEntry[] = [];
  for (const m of d.matters.all()) {
    if (m.status === "closed") continue;
    (m.keyDates ?? []).forEach((k, i) => {
      // Skip key dates already represented by a stored event for the same matter on the same day (deadline, filing, hearing…).
      const dup = d.events.findOne((e) => e.matterId === m.id && dateKey(e.startsAt) === k.date);
      if (dup) return;
      out.push({ id: `kd_${m.id}_${i}`, title: k.label, matterId: m.id, startsAt: k.date, allDay: true, kind: "deadline", attendeeIds: m.leadAttorneyId ? [m.leadAttorneyId] : [], ruleSource: "Matter key date", derived: { source: "matter-key-date", matterId: m.id, label: k.label } });
    });
  }
  return out;
}

export function listEvents(filter: EventFilter = {}): CalendarEntry[] {
  const stored: CalendarEntry[] = db().events.all();
  const all = filter.includeKeyDates === false ? stored : [...stored, ...keyDateEntries()];
  const from = filter.from ? toDate(filter.from).getTime() : null;
  const to = filter.to ? toDate(filter.to).getTime() + 86_399_999 : null;
  return all
    .filter((e) => (!filter.matterId || e.matterId === filter.matterId) && (from == null || toDate(e.endsAt ?? e.startsAt).getTime() >= from) && (to == null || toDate(e.startsAt).getTime() <= to))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.title.localeCompare(b.title));
}

export function getEvent(id: string): CalendarEntry | null {
  return db().events.get(id) ?? keyDateEntries().find((e) => e.id === id) ?? null;
}

export function createEvent(input: EventInput): CalendarEvent {
  const ev: CalendarEvent = {
    id: `ev_${nanoid(10)}`,
    title: input.title.trim(),
    matterId: input.matterId ?? undefined,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? undefined,
    allDay: input.allDay ?? /^\d{4}-\d{2}-\d{2}$/.test(input.startsAt),
    kind: input.kind ?? "meeting",
    location: input.location ?? undefined,
    attendeeIds: input.attendeeIds ?? [],
    notes: input.notes ?? undefined,
    ruleSource: input.ruleSource ?? undefined,
  };
  return db().events.put(stripUndefined(ev));
}

export function updateEvent(id: string, patch: EventPatch): CalendarEvent | null {
  const cur = db().events.get(id);
  if (!cur) return null;
  const next = applyPatch(cur, patch as Record<string, unknown>);
  return db().events.put({ ...next, id });
}

export function deleteEvent(id: string): boolean {
  return db().events.delete(id);
}

// ---------------------------------------------------------------------------
// Team updates
// ---------------------------------------------------------------------------

interface ReactionDoc { id: string; updateId: string; userId: string; emoji: string; createdAt: string }

const repliesCol = () => db().collection<UpdateReply>(HOME_COLLECTIONS.replies);
const reactionsCol = () => db().collection<ReactionDoc>(HOME_COLLECTIONS.reactions);

export function listUpdates(opts: { matterId?: string | null; limit?: number; userId?: string } = {}): TeamUpdateView[] {
  const userId = opts.userId ?? currentUser().id;
  const replies = repliesCol().all();
  const mine = reactionsCol().find((r) => r.userId === userId);
  return db().updates
    .list({ where: (u) => !opts.matterId || u.matterId === opts.matterId, sortBy: "createdAt", direction: "desc", limit: opts.limit ?? 60 })
    .map((u) => ({ ...u, replies: replies.filter((r) => r.updateId === u.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), myReactions: mine.filter((r) => r.updateId === u.id).map((r) => r.emoji) }));
}

export function createUpdate(input: { body: string; kind?: TeamUpdate["kind"]; matterId?: string | null; attachments?: TeamUpdate["attachments"] }, userId = currentUser().id): TeamUpdateView {
  const u: TeamUpdate = { id: `u_${nanoid(10)}`, authorId: userId, body: input.body.trim(), kind: input.kind ?? "update", matterId: input.matterId ?? undefined, createdAt: nowIso(), reactions: {}, attachments: input.attachments };
  db().updates.put(stripUndefined(u));
  return { ...u, replies: [], myReactions: [] };
}

export function toggleReaction(updateId: string, emoji: string, userId = currentUser().id): TeamUpdateView | null {
  const u = db().updates.get(updateId);
  if (!u) return null;
  const id = `${updateId}:${userId}:${emoji}`;
  const reactions = { ...(u.reactions ?? {}) };
  if (reactionsCol().has(id)) {
    reactionsCol().delete(id);
    reactions[emoji] = Math.max(0, (reactions[emoji] ?? 1) - 1);
    if (!reactions[emoji]) delete reactions[emoji];
  } else {
    reactionsCol().put({ id, updateId, userId, emoji, createdAt: nowIso() });
    reactions[emoji] = (reactions[emoji] ?? 0) + 1;
  }
  db().updates.put({ ...u, reactions });
  return listUpdates({ userId }).find((x) => x.id === updateId) ?? null;
}

export function addReply(updateId: string, body: string, userId = currentUser().id): UpdateReply | null {
  if (!db().updates.has(updateId)) return null;
  const r: UpdateReply = { id: `r_${nanoid(10)}`, updateId, authorId: userId, body: body.trim(), createdAt: nowIso() };
  return repliesCol().put(r);
}

export function deleteUpdate(id: string): boolean {
  for (const r of repliesCol().find((x) => x.updateId === id)) repliesCol().delete(r.id);
  for (const r of reactionsCol().find((x) => x.updateId === id)) reactionsCol().delete(r.id);
  return db().updates.delete(id);
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export interface NewsFilter { category?: NewsItem["category"] | null; practiceArea?: PracticeArea | null; matterId?: string | null; sort?: "relevance" | "newest"; limit?: number; query?: string }

export function listNews(filter: NewsFilter = {}): NewsItem[] {
  const q = filter.query?.toLowerCase().trim();
  const items = db().news.find((n) =>
    (!filter.category || n.category === filter.category) &&
    (!filter.practiceArea || (n.practiceAreas ?? []).includes(filter.practiceArea)) &&
    (!filter.matterId || (n.matterIds ?? []).includes(filter.matterId)) &&
    (!q || `${n.title} ${n.summary} ${n.source}`.toLowerCase().includes(q)),
  );
  items.sort(filter.sort === "newest" ? (a, b) => b.publishedAt.localeCompare(a.publishedAt) : (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || b.publishedAt.localeCompare(a.publishedAt));
  return filter.limit ? items.slice(0, filter.limit) : items;
}

interface FRDoc { title: string; type: string; abstract?: string; document_number: string; html_url: string; publication_date: string; agencies?: Array<{ name?: string; raw_name?: string }>; citation?: string }

/** Practice-area → Federal Register query terms. Only areas with active matters are queried. */
const FR_QUERIES: Partial<Record<PracticeArea, { term: string; keywords: string[] }[]>> = {
  "Products Liability": [{ term: "PFAS OR PFOA OR PFOS OR \"aqueous film-forming foam\"", keywords: ["pfas", "pfoa", "pfos", "fluoro", "foam"] }, { term: "medroxyprogesterone OR \"drug labeling\" OR \"prescription drug\"", keywords: ["medroxyprogesterone", "labeling", "contracept", "drug"] }],
  Regulatory: [{ term: "\"Toxic Substances Control Act\"", keywords: ["tsca", "toxic substances"] }],
  "Corporate / M&A": [{ term: "\"premerger notification\" OR \"Hart-Scott-Rodino\"", keywords: ["premerger", "hart-scott", "merger"] }],
  Employment: [{ term: "\"Fair Labor Standards Act\" OR \"wage and hour\" OR \"joint employer\"", keywords: ["wage", "labor standards", "employ"] }],
  Commercial: [{ term: "\"motor carrier\" OR \"freight broker\" OR \"cargo\"", keywords: ["motor carrier", "broker", "cargo", "freight"] }],
};

export interface NewsRefreshResult { ok: boolean; added: number; checked: number; error?: string; fetchedAt: string }

/** Pull the last 7 days of Federal Register documents for the firm's practice areas. Fails silently offline. */
export async function refreshNewsFromFederalRegister(opts: { now?: Date; timeoutMs?: number } = {}): Promise<NewsRefreshResult> {
  const now = opts.now ?? new Date();
  const d = db();
  const matters = d.matters.find((m) => m.status !== "closed");
  const areas = Array.from(new Set(matters.map((m) => m.practiceArea)));
  const queries = areas.flatMap((a) => (FR_QUERIES[a] ?? []).map((q) => ({ ...q, area: a })));
  if (!queries.length) return { ok: true, added: 0, checked: 0, fetchedAt: now.toISOString() };
  const since = dateKey(addDays(now, -7));
  const existingUrls = new Set(d.news.all().map((n) => n.url).filter(Boolean));
  let added = 0, checked = 0;
  const results = await Promise.allSettled(queries.map(async (q) => {
    const params = new URLSearchParams({ "conditions[term]": q.term, "conditions[publication_date][gte]": since, per_page: "10", order: "newest" });
    for (const f of ["title", "type", "abstract", "document_number", "html_url", "publication_date", "agencies", "citation"]) params.append("fields[]", f);
    const data = await fetchJSON<{ results?: FRDoc[] }>(`https://www.federalregister.gov/api/v1/documents.json?${params}`, { timeoutMs: opts.timeoutMs ?? 8000 });
    return { q, docs: data.results ?? [] };
  }));
  const toPut: NewsItem[] = [];
  let anyOk = false;
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    anyOk = true;
    const { q, docs } = r.value;
    for (const doc of docs) {
      checked++;
      if (!doc.html_url || existingUrls.has(doc.html_url)) continue;
      existingUrls.add(doc.html_url);
      const text = `${doc.title} ${doc.abstract ?? ""}`.toLowerCase();
      const hits = q.keywords.filter((k) => text.includes(k)).length;
      const matterIds = matters.filter((m) => m.practiceArea === q.area && (q.keywords.some((k) => `${m.name} ${m.description ?? ""} ${(m.tags ?? []).join(" ")}`.toLowerCase().includes(k)))).map((m) => m.id);
      const agency = doc.agencies?.map((a) => a.name ?? a.raw_name).filter(Boolean).join(", ");
      toPut.push({
        id: `news_fr_${doc.document_number}`,
        title: doc.title,
        summary: (doc.abstract?.trim() || `${doc.type} published by ${agency || "a federal agency"}${doc.citation ? ` (${doc.citation})` : ""}.`).slice(0, 900),
        source: agency ? `Federal Register · ${agency}` : "Federal Register",
        url: doc.html_url,
        publishedAt: doc.publication_date,
        category: "regulatory",
        practiceAreas: [q.area],
        matterIds,
        relevance: Math.min(95, 55 + hits * 10 + (matterIds.length ? 10 : 0)),
      });
      added++;
    }
  }
  if (toPut.length) d.news.putMany(toPut);
  if (!anyOk) {
    const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    return { ok: false, added: 0, checked, error: first?.reason instanceof Error ? first.reason.message : "Federal Register unreachable", fetchedAt: now.toISOString() };
  }
  return { ok: true, added, checked, fetchedAt: now.toISOString() };
}

export const NEWS_CLIPPINGS_FOLDER_ID = "lib_folder_news_clippings";

/** Save a news item to the Library as a link (idempotent). */
export function saveNewsToLibrary(newsId: string, userId = currentUser().id): LibraryItem | null {
  const d = db();
  const n = d.news.get(newsId);
  if (!n) return null;
  const ts = nowIso();
  if (!d.library.has(NEWS_CLIPPINGS_FOLDER_ID)) {
    d.library.put({ id: NEWS_CLIPPINGS_FOLDER_ID, parentId: null, name: "News clippings", type: "folder", description: "Court, regulatory and industry items saved from the Home news feed.", ownerId: userId, sharedWith: ["firm"], createdAt: ts, updatedAt: ts, tags: ["news"] });
  }
  const id = `lib_news_${newsId}`;
  const existing = d.library.get(id);
  if (existing) return existing;
  const item: LibraryItem = {
    id,
    parentId: NEWS_CLIPPINGS_FOLDER_ID,
    name: n.title,
    type: "link",
    matterId: n.matterIds?.[0],
    description: `${n.source} · ${n.publishedAt}\n\n${n.summary}`,
    url: n.url,
    tags: ["news", n.category, ...(n.practiceAreas ?? [])],
    ownerId: userId,
    sharedWith: ["firm"],
    createdAt: ts,
    updatedAt: ts,
    practiceArea: n.practiceAreas?.[0],
    status: "approved",
  };
  return d.library.put(stripUndefined(item));
}

// ---------------------------------------------------------------------------
// Matters overview
// ---------------------------------------------------------------------------

export function matterOverview(now = new Date(), userId = currentUser().id): MatterOverview[] {
  const d = db();
  const todayKey = dateKey(now);
  return d.matters
    .list({ where: (m) => m.status !== "closed", sortBy: "shortName" })
    .map((m) => {
      const tasks = d.tasks.find((t) => t.matterId === m.id && t.status !== "done");
      const keyDates = (m.keyDates ?? []).map((k) => ({ ...k, daysUntil: daysBetween(now, toDate(k.date)) })).sort((a, b) => a.date.localeCompare(b.date));
      const nextKeyDate = keyDates.find((k) => k.daysUntil >= 0);
      const upcoming = d.events.find((e) => e.matterId === m.id && dateKey(e.startsAt) >= todayKey).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const docs = d.edocs.find((e) => e.matterId === m.id);
      return {
        id: m.id,
        shortName: m.shortName,
        name: m.name,
        caption: m.caption,
        client: m.client,
        clientSide: m.clientSide,
        practiceArea: m.practiceArea,
        stage: m.stage,
        status: m.status,
        leadAttorneyId: m.leadAttorneyId,
        teamIds: m.teamIds,
        nextKeyDate,
        keyDates,
        openTasks: tasks.length,
        overdueTasks: tasks.filter((t) => t.dueAt && daysBetween(now, toDate(t.dueAt)) < 0).length,
        myOpenTasks: tasks.filter((t) => t.assigneeId === userId).length,
        hotDocs: docs.filter((e) => e.coding?.hot).length,
        docCount: docs.length,
        upcomingEvents: upcoming.length,
        nextEvent: upcoming[0] ? { id: upcoming[0].id, title: upcoming[0].title, startsAt: upcoming[0].startsAt, kind: upcoming[0].kind } : undefined,
      } satisfies MatterOverview;
    })
    .sort((a, b) => (a.nextKeyDate?.daysUntil ?? 9999) - (b.nextKeyDate?.daysUntil ?? 9999));
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export function briefKey(date: string) {
  return `home:brief:${date}`;
}

/**
 * Display name for the signed-in user: the person record, else the workspace owner recorded at
 * setup. Empty (never the "Workspace owner" placeholder) before setup, so greetings stay neutral.
 */
export function displayUserName(userId = currentUser().id): string {
  const me = db().people.get(userId);
  if (me?.name) return me.name;
  const cur = currentUser();
  if (cur.id === DEFAULT_USER.id && cur.name === DEFAULT_USER.name) return "";
  return cur.id === userId ? cur.name : "";
}

export function buildBriefContext(now = new Date(), userId = currentUser().id, principal: Principal | null = currentPrincipal()): BriefContext {
  const d = db();
  return {
    now,
    userId,
    userName: displayUserName(userId),
    events: listEvents({ from: dateKey(addDays(now, -1)), to: dateKey(addDays(now, 45)) }),
    tasks: d.tasks.all(),
    news: d.news.all(),
    updates: d.updates.all(),
    matters: listMattersLite(principal),
    people: listPeopleLite(),
  };
}

export function getCachedBrief(date: string): DailyBrief | null {
  return db().kv.get<DailyBrief>(briefKey(date));
}

export function cacheBrief(brief: DailyBrief) {
  db().kv.set(briefKey(brief.date), brief);
}

/** Cached brief for today, or a freshly computed (non-AI) one. Computed briefs are cached too so the card is stable across reloads. */
export function getOrComputeBrief(now = new Date(), userId = currentUser().id): DailyBrief {
  const date = dateKey(now);
  const cached = getCachedBrief(date);
  if (cached) return cached;
  const brief = computeFallbackBrief(buildBriefContext(now, userId));
  cacheBrief(brief);
  return brief;
}

// ---------------------------------------------------------------------------
// Initial page payload
// ---------------------------------------------------------------------------

/**
 * Bind the page payload to the principal resolved for the request: the matter list is re-scoped to that principal
 * (pages have no request context, so loadHomeInitialData may not have had one), and first-run "Upload documents"
 * counts files in the document sets the principal can see (documents live outside the mirror).
 */
export async function withDocumentSetFiles(data: HomeInitialData, principal: Principal | null): Promise<HomeInitialData> {
  const scoped = { ...data, matters: listMattersLite(principal) };
  if (!principal) return scoped;
  try {
    const files = (await listDocSets(principal)).reduce((n, s) => n + s.fileCount, 0);
    return files && scoped.setup ? { ...scoped, setup: { ...scoped.setup, documents: scoped.setup.documents + files } } : scoped;
  } catch {
    return scoped;
  }
}

export function loadHomeInitialData(opts: { now?: Date; userId?: string; aiConfigured: boolean; principal?: Principal | null }): HomeInitialData {
  const now = opts.now ?? new Date();
  const principal = opts.principal !== undefined ? opts.principal : currentPrincipal();
  const userId = opts.userId ?? currentUser().id;
  const d = db();
  return {
    now: now.toISOString(),
    aiConfigured: opts.aiConfigured,
    // Intelligence is hidden in the India product: no insight sections (and no links into /intel) on Home.
    intelInsights: FEATURES.intel && hasPublishedInsights(d),
    setup: { matters: d.matters.count(), documents: d.edocs.count(), people: d.people.count() },
    userId,
    userName: displayUserName(userId),
    people: listPeopleLite(),
    matters: listMattersLite(principal),
    tasks: listTasks({ now }),
    events: listEvents({ from: dateKey(addDays(now, -120)), to: dateKey(addDays(now, 240)) }),
    news: listNews({ sort: "relevance" }),
    updates: listUpdates({ userId }),
    matterOverview: matterOverview(now, userId),
    brief: getOrComputeBrief(now, userId),
  };
}

/** Whether the intelligence layer has insights to show on Home (collection is module-private to intel; read-only here). */
function hasPublishedInsights(d: ReturnType<typeof db>): boolean {
  try { return d.collection<{ id: string; status?: string }>("intel_insights").find((i) => i.status === "published" || i.status === "verified").length > 0; } catch { return false; }
}

/** Merge a patch: undefined leaves a field alone, null clears it. */
function applyPatch<T extends object>(cur: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as T;
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
