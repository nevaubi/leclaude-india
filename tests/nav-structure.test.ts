import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { buildGoChord, buildNav, goShortcuts, isHrefActive, isNavItemActive, isTabActive, navDestinations, navGroupChildren, sectionTabsFor, NAV, SECONDARY_NAV, GO_CHORD } from "@/components/shell/nav";
import { paletteSections } from "@/components/shell/palette-groups";
import { FEATURES, hiddenSurfaceRedirect, isHiddenHref, readFeatures, type FeatureFlags } from "@/lib/features";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CATALOGUES, englishMessages } from "@/lib/i18n/catalog";
import type { MessageKey } from "@/lib/i18n/catalog";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); }),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));

const OFF: FeatureFlags = { ediscovery: false, officeAll: false, workflows: false, intel: false };
const ON: FeatureFlags = { ediscovery: true, officeAll: true, workflows: true, intel: true };

const tabsOf = (nav: ReturnType<typeof buildNav>, label: string) => (nav.find((n) => n.label === label)!.tabs ?? []).map((tb) => [tb.label, tb.href, tb.shortcut ?? null]);

describe("India navigation structure", () => {
  it("has six sections in order (seven with Workflows), Settings secondary", () => {
    const nav = buildNav(OFF);
    expect(nav.map((n) => n.label)).toEqual(["Home", "Research", "Matters", "Law", "Drafting"]);
    expect(buildNav({ ...OFF, workflows: true }).map((n) => n.label)).toEqual(["Home", "Research", "Matters", "Law", "Drafting", "Workflows"]);
    expect(nav.find((n) => n.label === "Research")).toMatchObject({ href: "/search", shortcut: "G S", labelKey: "nav.search" });
    expect(nav.find((n) => n.label === "Matters")).toMatchObject({ href: "/matters", shortcut: "G M", labelKey: "nav.matters" });
    expect(nav.find((n) => n.label === "Drafting")).toMatchObject({ href: "/office", shortcut: "G O", labelKey: "nav.drafting" });
    expect(SECONDARY_NAV.map((n) => n.label)).toEqual(["Settings"]);
    // Sections are plain rail entries: their pages are in-page tabs, not rail flyouts.
    for (const n of nav) expect(navGroupChildren(n)).toEqual([]);
  });

  it("puts every former page in a section as a tab, each keeping its own chord", () => {
    const nav = buildNav(OFF);
    expect(tabsOf(nav, "Research")).toEqual([["Research", "/search", null], ["Quick answer", "/chat", "G C"]]);
    expect(tabsOf(nav, "Matters")).toEqual([["Matters", "/matters", null], ["Diary", "/diary", "G Y"], ["Documents", "/documents", "G D"]]);
    expect(tabsOf(nav, "Law")).toEqual([
      ["Case law", "/cases", "G J"],
      ["Statutes", "/law", "G A"],
      ["Official sources", "/sources", "G F"],
      ["Courts & judges", "/courts", null],
      ["Tools", "/tools", "G T"],
      ["News", "/news", "G N"],
    ]);
    expect(tabsOf(nav, "Drafting")).toEqual([["Drafting", "/office", null], ["Library", "/library", "G L"]]);
    const cj = nav.find((n) => n.label === "Law")!.tabs!.find((tb) => tb.href === "/courts")!;
    expect(cj).toMatchObject({ labelKey: "nav.courtsJudges", descriptionKey: "nav.desc.courtsJudges" });
    expect(cj.sub!.map((c) => [c.label, c.href, c.shortcut])).toEqual([["Courts", "/courts", "G K"], ["Judges", "/judges", "G U"]]);
    const law = nav.find((n) => n.label === "Law")!;
    expect(law.shortcut).toBeUndefined();
    expect(law.href).toBe("/cases");
  });

  it("keeps every old G chord pointing at the same route", () => {
    const chord = buildGoChord([...buildNav(OFF), ...SECONDARY_NAV]);
    expect(chord).toEqual({ h: "/", s: "/search", c: "/chat", m: "/matters", y: "/diary", d: "/documents", j: "/cases", a: "/law", f: "/sources", k: "/courts", u: "/judges", t: "/tools", n: "/news", o: "/office", l: "/library", ",": "/settings" });
  });

  it("gives every G chord exactly one destination, with the switches on or off", () => {
    for (const f of [OFF, ON]) {
      const keys = goShortcuts([...buildNav(f), ...SECONDARY_NAV]).map((s) => s.keys.join(" "));
      expect(new Set(keys).size, keys.join(", ")).toBe(keys.length);
      expect(keys.filter((k) => k === "g t")).toHaveLength(1);
    }
  });

  it("marks exactly one section active on each page (segment-aware)", () => {
    const nav = buildNav({ ...OFF, workflows: true });
    const activeOn = (p: string) => nav.filter((n) => isNavItemActive(n, p)).map((n) => n.label);
    const expected: Record<string, string> = {
      "/": "Home", "/search": "Research", "/chat": "Research",
      "/matters": "Matters", "/matters/team-preview": "Matters", "/diary": "Matters", "/documents": "Matters", "/documents/ds_1": "Matters",
      "/cases": "Law", "/cases/abc": "Law", "/law": "Law", "/law/ipc-1860/s-302": "Law", "/sources": "Law", "/sources/coverage": "Law", "/sources/od_1": "Law",
      "/courts": "Law", "/courts/delhi": "Law", "/judges": "Law", "/judges/j_1": "Law", "/tools": "Law", "/news": "Law",
      "/office": "Drafting", "/office/word/d1": "Drafting", "/library": "Drafting", "/workflows": "Workflows", "/workflows/wf_1": "Workflows",
    };
    for (const [p, label] of Object.entries(expected)) expect(activeOn(p), p).toEqual([label]);
    for (const p of ["/lawyers", "/casesx", "/toolsx", "/sourcesx", "/newsx", "/settings"]) expect(activeOn(p), p).toEqual([]);
    expect(isHrefActive("/", "/cases")).toBe(false);
    expect(isHrefActive("/", "/")).toBe(true);
    expect(isHrefActive("/office?kind=word", "/office")).toBe(true);
  });

  it("finds the tab bar and its current tab for a page, and none on Home, Settings or the editor", () => {
    const nav = buildNav({ ...OFF, workflows: true });
    const cur = (p: string) => { const s = sectionTabsFor(nav, p); return s ? [s.section.label, s.active.label] : null; };
    expect(cur("/search")).toEqual(["Research", "Research"]);
    expect(cur("/chat")).toEqual(["Research", "Quick answer"]);
    expect(cur("/diary")).toEqual(["Matters", "Diary"]);
    expect(cur("/documents/ds_1")).toEqual(["Matters", "Documents"]);
    expect(cur("/judges/j_1")).toEqual(["Law", "Courts & judges"]);
    expect(cur("/courts")).toEqual(["Law", "Courts & judges"]);
    expect(cur("/sources/coverage")).toEqual(["Law", "Official sources"]);
    expect(cur("/news")).toEqual(["Law", "News"]);
    expect(cur("/office")).toEqual(["Drafting", "Drafting"]);
    expect(cur("/library")).toEqual(["Drafting", "Library"]);
    for (const p of ["/", "/settings", "/workflows", "/office/word/d1", "/office/word/new", "/lawyers"]) expect(cur(p), p).toBeNull();
    const cj = nav.find((n) => n.label === "Law")!.tabs!.find((tb) => tb.href === "/courts")!;
    expect(isTabActive(cj, "/judges")).toBe(true);
    expect(isTabActive(cj, "/judgesx")).toBe(false);
  });

  it("hides Workflows, Intelligence and E-Discovery entries and chords when switched off", () => {
    const nav = buildNav(OFF);
    const hrefs = nav.flatMap((n) => [n.href, ...(n.children ?? []).map((c) => c.href), ...(n.tabs ?? []).map((c) => c.href)]);
    for (const h of ["/workflows", "/intel", "/ediscovery"]) expect(hrefs).not.toContain(h);
    const chord = buildGoChord([...nav, ...SECONDARY_NAV]);
    for (const k of ["w", "i", "e"]) expect(chord[k]).toBeUndefined();
    const help = goShortcuts([...nav, ...SECONDARY_NAV]).map((s) => s.keys.join(" "));
    for (const k of ["g w", "g i", "g e"]) expect(help).not.toContain(k);
    expect(help).toEqual(expect.arrayContaining(["g j", "g a", "g f", "g k", "g u", "g t", "g y", "g c", "g n", "g d", "g l"]));
  });

  it("brings them back, and names Office as Office, when the switches are on", () => {
    const nav = buildNav(ON);
    expect(nav.map((n) => n.label)).toEqual(["Home", "Research", "Matters", "Intelligence", "Law", "E-Discovery", "Office", "Workflows"]);
    const chord = buildGoChord([...nav, ...SECONDARY_NAV]);
    expect(chord).toMatchObject({ w: "/workflows", i: "/intel", e: "/ediscovery", o: "/office", l: "/library" });
    expect(navGroupChildren(nav.find((n) => n.label === "Office")!)).toHaveLength(4);
  });

  it("the build's NAV and GO_CHORD follow FEATURES", () => {
    expect(NAV.some((n) => n.href === "/workflows")).toBe(FEATURES.workflows);
    expect(NAV.some((n) => n.href === "/intel")).toBe(FEATURES.intel);
    expect(GO_CHORD.w === "/workflows").toBe(FEATURES.workflows);
    expect(GO_CHORD.i === "/intel").toBe(FEATURES.intel);
  });
});

describe("Law hub", () => {
  it("leaves the area tabs to the shell's section tabs (no second tab row)", () => {
    const src = readFileSync(path.resolve("src/components/corpus/law-hub.tsx"), "utf8");
    expect(src).not.toMatch(/<nav aria-label="Law"/);
    const shell = readFileSync(path.resolve("src/components/shell/app-shell.tsx"), "utf8");
    expect(shell).toMatch(/sectionTabsFor\(NAV/);
  });
});

describe("command palette with hidden surfaces", () => {
  it("lists every page (Law pages findable by 'Law') and no hidden destinations or Intelligence command", () => {
    const sections = paletteSections({ query: "", nav: navDestinations([...buildNav(OFF), ...SECONDARY_NAV]), features: OFF });
    const go = sections.find((s) => s.id === "go")!.commands;
    expect(go.map((c) => c.label)).toEqual(["Home", "Research", "Quick answer", "Matters", "Diary", "Documents", "Case law", "Statutes", "Official sources", "Courts", "Judges", "Tools", "News", "Drafting", "Library", "Settings"]);
    expect(go.find((c) => c.label === "Official sources")).toMatchObject({ href: "/sources", shortcut: "G F", keywords: "Law" });
    expect(go.find((c) => c.label === "Quick answer")).toMatchObject({ href: "/chat", shortcut: "G C", keywords: "Research" });
    expect(go.find((c) => c.label === "Diary")).toMatchObject({ href: "/diary", shortcut: "G Y", keywords: "Matters" });
    expect(go.find((c) => c.label === "Tools")).toMatchObject({ href: "/tools", shortcut: "G T", keywords: "Law" });
    expect(go.find((c) => c.label === "Judges")).toMatchObject({ href: "/judges", shortcut: "G U", keywords: "Law" });
    expect(go.find((c) => c.label === "News")).toMatchObject({ href: "/news", shortcut: "G N", keywords: "Law" });
    expect(go.find((c) => c.label === "Library")).toMatchObject({ href: "/library", shortcut: "G L", keywords: "Drafting" });
    const all = sections.flatMap((s) => s.commands);
    expect(all.some((c) => c.href?.startsWith("/workflows") || c.href?.startsWith("/intel"))).toBe(false);
    expect(all.some((c) => c.id === "intel-search")).toBe(false);
    expect(all.some((c) => c.href === "/settings#data")).toBe(true); // Data & automation stays reachable
    // One palette entry per destination.
    const hrefs = go.map((c) => c.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("offers Intelligence again when the switch is on", () => {
    const sections = paletteSections({ query: "Sharma", nav: navDestinations(buildNav(ON)), features: ON });
    const intel = sections.flatMap((s) => s.commands).find((c) => c.id === "intel-search");
    expect(intel?.href).toBe("/intel?q=Sharma");
    expect(sections.find((s) => s.id === "go")!.commands.some((c) => c.href === "/workflows")).toBe(true);
  });
});

describe("feature switches", () => {
  it("reads the NEXT_PUBLIC switches strictly", () => {
    expect(readFeatures({})).toEqual(OFF);
    expect(readFeatures({ NEXT_PUBLIC_ENABLE_WORKFLOWS: "1", NEXT_PUBLIC_ENABLE_INTEL: "1" })).toMatchObject({ workflows: true, intel: true, ediscovery: false });
    expect(readFeatures({ NEXT_PUBLIC_ENABLE_WORKFLOWS: "true" }).workflows).toBe(false);
  });

  it("flags links into hidden surfaces, never external or unrelated ones", () => {
    for (const h of ["/workflows", "/workflows/wf_1", "/workflows/runs/r_1?x=1", "/intel", "/intel?insight=i1", "/intel/documents/d1#p2"]) expect(isHiddenHref(h, OFF)).toBe(true);
    for (const h of ["/", "/workflowsx", "/intelligence", "/settings#data", "/api/workflows/runs", "https://example.com/workflows", null, undefined, ""]) expect(isHiddenHref(h, OFF)).toBe(false);
    expect(isHiddenHref("/workflows/runs/r_1", ON)).toBe(false);
    expect(isHiddenHref("/intel", ON)).toBe(false);
  });
});

describe("hidden routes redirect home", () => {
  it.runIf(!FEATURES.workflows)("/workflows/** redirects to /", async () => {
    const { default: WorkflowsLayout } = await import("@/app/workflows/layout");
    expect(() => WorkflowsLayout({ children: null })).toThrow("NEXT_REDIRECT:/");
  });
  it("sends hidden surfaces home and leaves enabled ones alone", () => {
    expect(hiddenSurfaceRedirect("workflows", OFF)).toBe("/");
    expect(hiddenSurfaceRedirect("intel", OFF)).toBe("/");
    expect(hiddenSurfaceRedirect("workflows", ON)).toBeNull();
    expect(hiddenSurfaceRedirect("intel", ON)).toBeNull();
  });
  it("/intel/** guards in its layout before touching the database", () => {
    // The layout is TSX (not loadable here), so assert the guard statically: it must run first.
    const src = readFileSync(path.resolve("src/app/intel/layout.tsx"), "utf8");
    const body = src.slice(src.indexOf("export default async function IntelLayout"));
    expect(body.indexOf('hiddenSurfaceRedirect("intel")')).toBeGreaterThan(0);
    expect(body.indexOf('hiddenSurfaceRedirect("intel")')).toBeLessThan(body.indexOf("await pageDb()"));
    expect(body).toMatch(/if \(to\) redirect\(to\);/);
  });
  it.runIf(!FEATURES.workflows)("quick search returns no workflow results", async () => {
    const { db } = await import("@/lib/db");
    const { GET } = await import("@/app/api/quick-search/route");
    const wf = db().workflows.all()[0];
    expect(wf).toBeTruthy();
    const res = await GET(new NextRequest(`http://localhost/api/quick-search?q=${encodeURIComponent(wf.name.slice(0, 12))}`));
    const { hits } = (await res.json()) as { hits: { kind: string; href: string }[] };
    expect(hits.some((h) => h.kind === "workflow" || h.href.startsWith("/workflows"))).toBe(false);
  });
});

describe("navigation translations", () => {
  it("translates the section and tab labels (and their descriptions) in every catalogue", () => {
    const keys: MessageKey[] = ["nav.law", "nav.search", "nav.drafting", "nav.tools", "nav.desc.law", "nav.desc.drafting", "nav.desc.tools", "nav.diary", "nav.desc.diary", "nav.sources", "nav.desc.sources", "nav.quickAnswer", "nav.officialSources", "nav.courtsJudges", "nav.desc.courtsJudges"];
    expect(englishMessages["nav.quickAnswer"]).toBe("Quick answer");
    expect(englishMessages["nav.officialSources"]).toBe("Official sources");
    expect(englishMessages["nav.courtsJudges"]).toBe("Courts & judges");
    expect(englishMessages["nav.diary"]).toBe("Diary");
    expect(englishMessages["nav.sources"]).toBe("Sources");
    expect(englishMessages["nav.law"]).toBe("Law");
    expect(englishMessages["nav.search"]).toBe("Research");
    expect(englishMessages["nav.drafting"]).toBe("Drafting");
    for (const [locale, cat] of Object.entries(CATALOGUES)) {
      if (locale === "en" || !cat) continue;
      for (const k of keys) {
        expect(cat[k]?.trim(), `${locale} ${k}`).toBeTruthy();
        expect(cat[k], `${locale} ${k} must not be English`).not.toBe(englishMessages[k]);
      }
      // "Law" must read differently from its own "Statutes" child.
      expect(cat["nav.law"], `${locale} Law vs Statutes`).not.toBe(cat["nav.statutes"]);
    }
  });
});
