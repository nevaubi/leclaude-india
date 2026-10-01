/**
 * Court and topic labels for headlines (pure, client-safe).
 *
 * A court label is attached only when a feed category/tag equals (case-insensitively, whitespace-normalised) one of
 * the exact names below for a court in `src/lib/india/courts.ts`, or, for the Supreme Court of India only, when the
 * title literally contains "Supreme Court" (and does not name a foreign one). Nothing is inferred from body text,
 * city names, judges or partial matches: "All High Courts" or "High Courts" is a topic, not a court.
 */
import { COURTS, courtById } from "@/lib/india/courts";
import type { NewsLabel } from "./types";

/**
 * Exact names that refer to a registry court. The registry's formal name is always accepted; the extra names are the
 * forms Indian legal publishers use as category names ("Bombay High Court"). Each is a full name, never a fragment.
 */
const EXTRA_NAMES: Record<string, string[]> = {
  sci: ["Supreme Court", "Supreme Court of India"],
  "hc-karnataka": ["Karnataka High Court"],
  "hc-telangana": ["Telangana High Court", "High Court of Telangana"],
  "hc-andhra": ["Andhra Pradesh High Court"],
  "hc-jk": ["Jammu and Kashmir High Court", "Jammu & Kashmir High Court", "J&K High Court", "Jammu & Kashmir and Ladakh High Court", "Jammu and Kashmir and Ladakh High Court", "J&K and Ladakh High Court"],
  "hc-hp": ["Himachal Pradesh High Court"],
  "hc-ph": ["Punjab and Haryana High Court", "Punjab & Haryana High Court"],
  "hc-uttarakhand": ["Uttarakhand High Court"],
  "hc-delhi": ["Delhi High Court"],
  "hc-rajasthan": ["Rajasthan High Court"],
  "hc-allahabad": ["Allahabad High Court"],
  "hc-patna": ["Patna High Court"],
  "hc-sikkim": ["Sikkim High Court"],
  "hc-manipur": ["Manipur High Court"],
  "hc-tripura": ["Tripura High Court"],
  "hc-meghalaya": ["Meghalaya High Court"],
  "hc-gauhati": ["Gauhati High Court"],
  "hc-calcutta": ["Calcutta High Court"],
  "hc-jharkhand": ["Jharkhand High Court"],
  "hc-orissa": ["Orissa High Court"],
  "hc-chhattisgarh": ["Chhattisgarh High Court"],
  "hc-mp": ["Madhya Pradesh High Court"],
  "hc-gujarat": ["Gujarat High Court"],
  "hc-bombay": ["Bombay High Court"],
  "hc-kerala": ["Kerala High Court"],
  "hc-madras": ["Madras High Court"],
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const COURT_BY_NAME: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const c of COURTS) {
    m.set(norm(c.name), c.id);
    for (const n of EXTRA_NAMES[c.id] ?? []) m.set(norm(n), c.id);
  }
  return m;
})();

/** The registry court an exact category/tag name refers to, or null. */
export function courtIdForExactName(name: string): string | null {
  return COURT_BY_NAME.get(norm(name)) ?? null;
}

/** All exact names accepted for a court (for documentation/tests). */
export function exactCourtNames(courtId: string): string[] {
  const c = courtById(courtId);
  return c ? [c.name, ...(EXTRA_NAMES[courtId] ?? [])] : [];
}

const FOREIGN_SC = /\b(?:US|U\.S\.|United States|American|UK|U\.K\.|Pakistan(?:i|'s)?|Bangladesh(?:i)?|Nepal(?:i|'s)?|Sri Lanka(?:n)?|Canada|Canadian|Australia(?:n)?|Brazil(?:ian)?|Israel(?:i)?|Kenya(?:n)?|Philippine(?:s)?|Mexico|Mexican|Korea(?:n)?|Japan(?:ese)?|Ghana(?:ian)?|Nigeria(?:n)?|Uganda(?:n)?|Florida|Texas|California|New York)\s+Supreme Court\b|\bSupreme Court of (?!India\b)(?:the )?[A-Z]/;

/** True when a title literally names the Supreme Court and not a foreign one. */
export function titleNamesSupremeCourt(title: string): boolean {
  return /\bSupreme Court\b/i.test(title) && !FOREIGN_SC.test(title);
}

export function topicSlug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "topic";
}

/**
 * Labels for one headline. Courts: exact category/tag names, then the title rule for the Supreme Court. Topics: the
 * feed's own categories that are not court names, verbatim. Tags (judges, parties) are not turned into topics.
 */
export function labelsFor(input: { title: string; categories: string[]; tags: string[] }): { labels: NewsLabel[]; courtIds: string[] } {
  const labels: NewsLabel[] = [];
  const courts = new Set<string>();
  const topics = new Set<string>();
  const addCourt = (id: string, matched: string, labelSource: NewsLabel["labelSource"]) => {
    if (courts.has(id)) return;
    courts.add(id);
    labels.push({ kind: "court", id, label: courtById(id)?.name ?? id, labelSource, matched });
  };
  for (const c of input.categories) {
    const id = courtIdForExactName(c);
    if (id) addCourt(id, c, "feed category");
  }
  for (const t of input.tags) {
    const id = courtIdForExactName(t);
    if (id) addCourt(id, t, "feed tag");
  }
  if (!courts.has("sci") && titleNamesSupremeCourt(input.title)) {
    const m = input.title.match(/Supreme Court/i);
    addCourt("sci", m?.[0] ?? "Supreme Court", "title");
  }
  for (const c of input.categories) {
    if (courtIdForExactName(c)) continue;
    const slug = topicSlug(c);
    if (topics.has(slug)) continue;
    topics.add(slug);
    labels.push({ kind: "topic", id: slug, label: c, labelSource: "feed category", matched: c });
  }
  return { labels, courtIds: [...courts] };
}
