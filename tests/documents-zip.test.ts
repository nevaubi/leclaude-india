import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { DOCS_LIMITS } from "@/modules/documents/types";
import { isJunkEntry, isZipName, planZip, safeZipPath, unpackZip, ZipOpenError } from "@/modules/documents/components/zip-entries";

describe("safeZipPath", () => {
  it("keeps nested relative paths as folder/sub/name", () => {
    expect(safeZipPath("Pleadings/2021/plaint.pdf")).toBe("Pleadings/2021/plaint.pdf");
    expect(safeZipPath("./a//b/./c.pdf")).toBe("a/b/c.pdf");
    expect(safeZipPath("win\\style\\path.docx")).toBe("win/style/path.docx");
  });
  it("refuses traversal, absolute paths and control characters", () => {
    expect(safeZipPath("../evil.pdf")).toBeNull();
    expect(safeZipPath("a/../../evil.pdf")).toBeNull();
    expect(safeZipPath("a\\..\\..\\evil.pdf")).toBeNull();
    expect(safeZipPath("/etc/passwd.txt")).toBeNull();
    expect(safeZipPath("C:/Windows/x.txt")).toBeNull();
    expect(safeZipPath("\\\\server\\share\\x.txt")).toBeNull();
    expect(safeZipPath("a\u0000b.pdf")).toBeNull();
    expect(safeZipPath("")).toBeNull();
  });
});

describe("planZip", () => {
  it("takes supported files, skips the rest with a reason, ignores junk and folders", () => {
    const plan = planZip([
      { path: "docs/", dir: true, size: 0 },
      { path: "docs/a.pdf", dir: false, size: 1000 },
      { path: "docs/sub/b.docx", dir: false, size: 2000 },
      { path: "docs/photo.jpg", dir: false, size: 10 },
      { path: "docs/inner.zip", dir: false, size: 10 },
      { path: "docs/empty.txt", dir: false, size: 0 },
      { path: "docs/huge.docx", dir: false, size: DOCS_LIMITS.maxServerFileBytes + 1 },
      { path: "__MACOSX/docs/._a.pdf", dir: false, size: 10 },
      { path: "docs/.DS_Store", dir: false, size: 10 },
      { path: "../../etc/x.txt", dir: false, size: 10 },
    ]);
    expect(plan.take.map((t) => t.name)).toEqual(["docs/a.pdf", "docs/sub/b.docx"]);
    expect(plan.totalBytes).toBe(3000);
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.name, s.reason]));
    expect(reasons["docs/photo.jpg"]).toMatch(/not supported/);
    expect(reasons["docs/inner.zip"]).toMatch(/inside an archive/);
    expect(reasons["docs/empty.txt"]).toMatch(/empty/);
    expect(reasons["docs/huge.docx"]).toMatch(/limited to/);
    expect(reasons["../../etc/x.txt"]).toMatch(/Unsafe path/);
    expect(plan.skipped.some((s) => /MACOSX|DS_Store/.test(s.name))).toBe(false);
  });

  it("caps entries and total uncompressed bytes (zip-bomb guard) and says how many were left out", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.txt`, dir: false, size: 100 }));
    const byCount = planZip(many, { maxEntries: 5 });
    expect(byCount.take).toHaveLength(5);
    expect(byCount.skipped.at(-1)).toMatchObject({ name: "7 more files" });
    const byBytes = planZip(many, { maxTotalBytes: 350 });
    expect(byBytes.take).toHaveLength(3);
    expect(byBytes.skipped.at(-1)?.reason).toMatch(/in total/);
  });

  it("treats an unknown declared size as unknown, not empty", () => {
    const plan = planZip([{ path: "a.txt", dir: false, size: null }]);
    expect(plan.take).toHaveLength(1);
  });

  it("detects duplicate paths and junk", () => {
    expect(planZip([{ path: "a.txt", dir: false, size: 5 }, { path: "./a.txt", dir: false, size: 5 }]).skipped[0].reason).toMatch(/twice/);
    expect(isJunkEntry("x/Thumbs.db")).toBe(true);
    expect(isJunkEntry("x/.hidden/y.pdf")).toBe(true);
    expect(isJunkEntry("x/y.pdf")).toBe(false);
    expect(isZipName("Bundle.ZIP")).toBe(true);
  });
});

describe("unpackZip", () => {
  async function makeZip(add: (z: JSZip) => void): Promise<Blob> {
    const z = new JSZip();
    add(z);
    const buf = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return new Blob([buf as BlobPart]);
  }

  it("unpacks supported entries with folder display paths and lists skipped ones", async () => {
    const zip = await makeZip((z) => {
      z.file("Matter/Notices/notice.txt", "Notice of termination dated 3 March 2021");
      z.file("Matter/readme.md", "# Index");
      z.file("Matter/scan.tiff", "binary");
      z.file("Matter/empty.txt", "");
    });
    const progress: number[] = [];
    const r = await unpackZip(zip, { onProgress: (d) => progress.push(d) });
    expect(r.files.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).sort()).toEqual(["Matter/Notices/notice.txt", "Matter/readme.md"]);
    expect(r.files.find((f) => f.name === "notice.txt")?.size).toBe(40);
    expect(await r.files.find((f) => f.name === "notice.txt")!.text()).toContain("Notice of termination");
    expect(r.skipped.map((s) => s.name).sort()).toEqual(["Matter/empty.txt", "Matter/scan.tiff"]);
    expect(progress.at(-1)).toBe(2);
  });

  it("stops an entry that inflates past the total budget instead of reading it all", async () => {
    const zip = await makeZip((z) => { z.file("big.txt", "x".repeat(200_000)); z.file("small.txt", "hello world"); });
    const r = await unpackZip(zip, { limits: { maxTotalBytes: 50_000 } });
    // big.txt declares 200 KB, so the plan already leaves it out; small.txt is taken.
    expect(r.files.map((f) => f.name)).toEqual(["small.txt"]);
    expect(r.skipped.some((s) => /in total/.test(s.reason))).toBe(true);
  });

  it("refuses a file that is not a ZIP archive", async () => {
    await expect(unpackZip(new Blob(["not a zip at all"]))).rejects.toBeInstanceOf(ZipOpenError);
  });

  it("can be cancelled", async () => {
    const zip = await makeZip((z) => { for (let i = 0; i < 5; i++) z.file(`f${i}.txt`, `file ${i}`); });
    const ac = new AbortController();
    ac.abort();
    await expect(unpackZip(zip, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
