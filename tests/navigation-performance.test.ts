import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { displayImageUrl, displayImageSrcSet, mediaWidth } from "@/modules/media/display";
const source = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
describe("navigation performance guardrails", () => {
  it("sizes only content-addressed media; external images are never proxied", () => {
    const url = "/api/media/" + "a".repeat(64);
    expect(displayImageUrl(url, 128)).toBe(url + "?w=128");
    expect(displayImageUrl("https://publisher.test/pic.jpg", 128)).toBe("https://publisher.test/pic.jpg");
    expect(displayImageUrl("/api/files/private", 128)).toBe("/api/files/private");
    expect(displayImageSrcSet(url)).toContain("?w=640 640w");
    expect(displayImageSrcSet("https://publisher.test/pic.jpg")).toBeUndefined();
    expect(mediaWidth("128")).toBe(128);
    expect(mediaWidth("12345")).toBeNull();
    expect(mediaWidth(null)).toBeNull();
  });
  it("deduplicates DB work per render, never using a shared auth response cache", () => {
    expect(source("src/lib/db/request.ts")).toContain("export const pageDb = cache(");
    expect(source("src/app/api/media/[id]/route.ts")).toContain("withDb(withAuth(");
    expect(source("src/app/api/media/[id]/route.ts")).toContain("private, max-age=31536000, immutable");
  });
  it("gives the main destinations immediate loading boundaries", () => {
    for (const section of ["cases", "law", "courts", "judges", "news", "documents", "matters", "office", "chat", "search", "library", "diary", "sources", "settings"])
      expect(existsSync(resolve(process.cwd(), "src/app", section, "loading.tsx")), section).toBe(true);
  });
  it("uses intent prefetch, not unconditional prefetch of every page", () => {
    const link = source("src/components/shell/navigation-link.tsx");
    expect(link).toContain("useLinkStatus");
    expect(link).toContain("intent ? true : null");
    expect(link).toContain("onMouseEnter");
    expect(link).not.toContain("prefetch={true}");
  });
  it("does not re-render the whole news page for already client-fetched filters", () => {
    expect(source("src/modules/news/components/news-page.tsx")).toContain("window.history.replaceState");
    expect(source("src/modules/news/components/news-page.tsx")).not.toContain("router.replace(");
  });
});
