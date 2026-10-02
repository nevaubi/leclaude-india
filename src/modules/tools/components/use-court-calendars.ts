"use client";
import * as React from "react";
import { calendarYears, COURT_CALENDAR_FORUMS, type OfficialCalendarResponse } from "../lib";

/**
 * Official court calendars for the practice tools, from GET /api/official/calendars?forum=&years= (one request per
 * forum, made once per page session and shared by every panel). A forum whose calendar is not loaded answers
 * `calendar: null`; nothing is substituted for it. When the official-sources corpus is not configured (503), the route
 * is not deployed (404 without a JSON error) or access is denied, the tools fall back to None / Sample.
 */

export type CalendarForumState =
  | { status: "loading" }
  | { status: "loaded"; data: OfficialCalendarResponse }
  | { status: "error"; message: string };

export type CalendarsAvailability = "loading" | "available" | "not_configured" | "not_available" | "denied" | "error";

export interface CourtCalendarsState {
  availability: CalendarsAvailability;
  forums: Record<string, CalendarForumState>;
  /** Loaded responses by forum (only forums that answered). */
  official: Record<string, OfficialCalendarResponse | undefined>;
  message: string | null;
  retry: () => void;
}

type Snapshot = Omit<CourtCalendarsState, "retry">;

const initial: Snapshot = {
  availability: "loading",
  forums: Object.fromEntries(COURT_CALENDAR_FORUMS.map((f) => [f.forum, { status: "loading" } as CalendarForumState])),
  official: {},
  message: null,
};

let snapshot: Snapshot = initial;
let started = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Today's date in India (Asia/Kolkata), YYYY-MM-DD. */
export function indiaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type CalendarFetchOutcome = { kind: "ok"; data: OfficialCalendarResponse } | { kind: "not_configured" | "not_available" | "denied"; message: string } | { kind: "error"; message: string };
type Outcome = CalendarFetchOutcome;

/** One forum's calendar from /api/official/calendars, classified (exported for tests). */
export async function fetchCourtCalendar(forum: string, years: number[]): Promise<CalendarFetchOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/official/calendars?forum=${encodeURIComponent(forum)}&years=${years.join(",")}`, { cache: "no-store", headers: { accept: "application/json" } });
  } catch {
    return { kind: "error", message: "The server could not be reached." };
  }
  const body = (await res.json().catch(() => null)) as (OfficialCalendarResponse & { error?: string; code?: string }) | null;
  if (res.ok && body && "calendar" in body) return { kind: "ok", data: { calendar: body.calendar ?? null, sources: Array.isArray(body.sources) ? body.sources : [], forum: body.forum ?? null, notes: Array.isArray(body.notes) ? body.notes : [] } };
  if (res.status === 503) return { kind: "not_configured", message: body?.error ?? "Official sources are not configured on this workspace." };
  if (res.status === 404 && !body?.code) return { kind: "not_available", message: "Official court calendars are not available yet." };
  if (res.status === 401 || res.status === 403) return { kind: "denied", message: body?.error ?? "You do not have access to official sources." };
  return { kind: "error", message: body?.error ?? `Request failed (${res.status})` };
}

async function load() {
  const years = calendarYears(indiaToday());
  snapshot = { ...initial, forums: { ...initial.forums } };
  emit();
  const outcomes = await Promise.all(COURT_CALENDAR_FORUMS.map(async (f) => [f.forum, await fetchCourtCalendar(f.forum, years)] as const));
  const forums: Record<string, CalendarForumState> = {};
  const official: Record<string, OfficialCalendarResponse | undefined> = {};
  for (const [forum, o] of outcomes) {
    if (o.kind === "ok") { forums[forum] = { status: "loaded", data: o.data }; official[forum] = o.data; }
    else forums[forum] = { status: "error", message: o.message };
  }
  const kinds = outcomes.map(([, o]) => o.kind);
  const first = (k: Outcome["kind"]) => outcomes.find(([, o]) => o.kind === k)?.[1] as { message: string } | undefined;
  const availability: CalendarsAvailability = kinds.includes("ok") ? "available"
    : kinds.includes("not_configured") ? "not_configured"
    : kinds.includes("denied") ? "denied"
    : kinds.every((k) => k === "not_available") ? "not_available"
    : "error";
  const message = availability === "available" ? null : (first(availability === "error" ? "error" : availability)?.message ?? null);
  snapshot = { availability, forums, official, message };
  emit();
}

function start(force = false) {
  if (started && !force) return;
  started = true;
  void load();
}

function subscribe(l: () => void) {
  listeners.add(l);
  start();
  return () => { listeners.delete(l); };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => initial;

export function useCourtCalendars(): CourtCalendarsState {
  const s = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const retry = React.useCallback(() => start(true), []);
  return { ...s, retry };
}
