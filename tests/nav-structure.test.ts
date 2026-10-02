import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { buildGoChord, buildNav, goShortcuts, isHrefActive, isNavItemActive, navDestinations, navGroupChildren, NAV, SECONDARY_NAV, GO_CHORD } from "@/components/shell/nav";
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

describe("India navigation structure", () => {
  it("has nine focused primary entries in order, Settings secondary", () => {
    const nav = buildNav(OFF);
    expect(nav.map((n) => n.label)).toEqual(["Home", "Chat", "Matters", "Research", "Law", "News", "Documents", "Drafting", "Library"]);
    expect(nav.find((n) => n.label === "Research")).toMatchObject({ href: "/search", shortcut: "G S", labelKey: "nav.search" });
    expect(nav.find((n) => n.label === "Drafting")).toMatchObject({ href: "/office", shortcut: "G O", labelKey: "nav.drafting" });
    expect(SECONDARY_NAV.map((n) => n.label)).toEqual(["Settings"]);
  });

  it("groups the law corpus and practice tools under Law with each page keeping its own chord and Law having none", () => {
    const law = buildNav(OFF).find((n) => n.label === "Law")!;
    expect(law.shortcut).toBeUndefined();
    expect(law.labelKey).toBe("nav.law");
    expect(navGroupChildren(law).map((c) => [c.label, c.href, c.shortcut])).toEqual([
      ["Case law", "/cases", "G J"],
      ["Statutes", "/law", "G A"],
      ["Courts", "/courts", "G K"],
      ["Judges", "/judges", "G U"],
      ["Tools", "/tools", "G T"],
    ]);
    expect(navGroupChildren(law).find((c) => c.href === "/tools")).toMatchObject({ labelKey: "nav.tools", descriptionKey: "nav.desc.tools" });
    const chord = buildGoChord([...buildNav(OFF), ...SECONDARY_NAV]);
    expect(chord).toMatchObject({ j: "/cases", a: "/law", k: "/courts", u: "/judges", t: "/tools", s: "/search", o: "/office", ",": "/settings" });
  });

  it("gives every G chord exactly one destination, with the switches on or off", () => {
    for (const f of [OFF, ON]) {
      const keys = goShortcuts([...buildNav(f), ...SECONDARY_NAV]).map((s) => s.keys.join(" "));
      expect(new Set(keys).size, keys.join(", ")).toBe(keys.length);
      expect(keys.filter((k) => k === "g t")).toHaveLength(1);
    }
  });

  it("marks Law active on its four routes (segment-aware) and nowhere else", () => {
    const law = buildNav(OFF).find((n) => n.label === "Law")!;
    for (const p of ["/cases", "/cases/abc", "/law", "/law/ipc-1860/s-302", "/courts", "/courts/delhi", "/judges", "/judges/j_1", "/tools"]) expect(isNavItemActive(law, p)).toBe(true);
    for (const p of ["/", "/lawyers", "/search", "/news", "/casesx", "/documents", "/toolsx"]) expect(isNavItemActive(law, p)).toBe(false);
    expect(isHrefActive("/", "/cases")).toBe(false);
    expect(isHrefActive("/", "/")).toBe(true);
    expect(isHrefActive("/office?kind=word", "/office")).toBe(true);
    // Exactly one primary entry is active on a law page.
    expect(buildNav(OFF).filter((n) => isNavItemActive(n, "/judges/j_1")).map((n) => n.label)).toEqual(["Law"]);
  });

  it("hides Workflows, Intelligence and E-Discovery entries and chords when switched off", () => {
    const nav = buildNav(OFF);
    const hrefs = nav.flatMap((n) => [n.href, ...(n.children ?? []).map((c) => c.href)]);
    for (const h of ["/workflows", "/intel", "/ediscovery"]) expect(hrefs).not.toContain(h);
    const chord = buildGoChord([...nav, ...SECONDARY_NAV]);
    for (const k of ["w", "i", "e"]) expect(chord[k]).toBeUndefined();
    const help = goShortcuts([...nav, ...SECONDARY_NAV]).map((s) => s.keys.join(" "));
    for (const k of ["g w", "g i", "g e"]) expect(help).not.toContain(k);
    expect(help).toEqual(expect.arrayContaining(["g j", "g a", "g k", "g u", "g t"]));
  });

  it("brings them back, and names Office as Office, when the switches are on", () => {
    const nav = buildNav(ON);
    expect(nav.map((n) => n.label)).toEqual(["Home", "Chat", "Matters", "Research", "Intelligence", "Law", "News", "Documents", "E-Discovery", "Workflows", "Office", "Library"]);
    const chord = buildGoChord([...nav, ...SECONDARY_NAV]);
    expect(chord).toMatchObject({ w: "/workflows", i: "/intel", e: "/ediscovery", o: "/office" });
    expect(navGroupChildren(nav.find((n) => n.label === "Office")!)).toHaveLength(4);
  });

  it("the build's NAV and GO_CHORD follow FEATURES", () => {
    expect(NAV.some((n) => n.href === "/workflows")).toBe(FEATURES.workflows);
    expect(NAV.some((n) => n.href === "/intel")).toBe(FEATURES.intel);
    expect(GO_CHORD.w === "/workflows").toBe(FEATURES.workflows);
    expect(GO_CHORD.i === "/intel").toBe(FEATURES.intel);
  });
});

describe("command palette with hidden surfaces", () => {
  it("lists the Law pages (findable by 'Law') and no hidden destinations or Intelligence command", () => {
    const sections = paletteSections({ query: "", nav: navDestinations([...buildNav(OFF), ...SECONDARY_NAV]), features: OFF });
    const go = sections.find((s) => s.id === "go")!.commands;
    expect(go.map((c) => c.label)).toEqual(["Home", "Chat", "Matters", "Research", "Case law", "Statutes", "Courts", "Judges", "Tools", "News", "Documents", "Drafting", "Library", "Settings"]);
    expect(go.find((c) => c.label === "Tools")).toMatchObject({ href: "/tools", shortcut: "G T", keywords: "Law" });
    expect(go.find((c) => c.label === "Judges")).toMatchObject({ href: "/judges", shortcut: "G U", keywords: "Law" });
    const all = sections.flatMap((s) => s.commands);
    expect(all.some((c) => c.href?.startsWith("/workflows") || c.href?.startsWith("/intel"))).toBe(false);
    expect(all.some((c) => c.id === "intel-search")).toBe(false);
    expect(all.some((c) => c.href === "/settings#data")).toBe(true); // Data & automation stays reachable
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
  it("translates Law, Research, Drafting and Tools (and their descriptions) in every catalogue", () => {
    const keys: MessageKey[] = ["nav.law", "nav.search", "nav.drafting", "nav.tools", "nav.desc.law", "nav.desc.drafting", "nav.desc.tools"];
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
