import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.VITEST_DATA_DIR || process.env.TMPDIR || "/tmp"}/documents-lane-vitest-${process.pid}`;
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.NEXT_PUBLIC_ENABLE_EDISCOVERY;
});

import { db, resetSqlite } from "@/lib/db";
import { runWithPrincipal } from "@/lib/auth/context";
import type { Principal } from "@/lib/auth/types";
import { setDocStoreForTests } from "@/modules/documents/server/store";
import { createSet, resetStorageCacheForTests } from "@/modules/documents/server/sets";
import { uploadBrowserPdf } from "@/modules/documents/server/ingest";
import { defaultDeps } from "@/modules/search/engine/deps";
import { sanitizeSettings } from "@/modules/search/service";

/** Research's "Matter documents" lane searches the selected matter's document sets (e-discovery is hidden in India). */
const M1 = "m_lane_one";
const M2 = "m_lane_two";
const alice: Principal = { id: "u_alice", name: "Alice", tenantId: "default", roles: ["associate"], matterIds: [M1, M2], source: "dev" };
const bob: Principal = { id: "u_bob", name: "Bob", tenantId: "default", roles: ["associate"], matterIds: [M2], source: "dev" };

beforeAll(async () => {
  resetSqlite();
  db();
  db().matters.put({ id: M1, name: "Sharma v Kapoor", tenantId: "default" } as never);
  db().matters.put({ id: M2, name: "Other matter", tenantId: "default" } as never);
  setDocStoreForTests("sqlite");
  resetStorageCacheForTests();
  const s1 = await createSet(alice, { name: "Lease bundle", matterId: M1 });
  await uploadBrowserPdf(alice, s1.id, { kind: "pdf-text", name: "lease.pdf", size: 1000, sha256: "a".repeat(64), pages: ["Cover page", "The monthly rent of Rs. 45,000 is payable on the fifth day of each month."] });
  const s2 = await createSet(alice, { name: "Other bundle", matterId: M2 });
  await uploadBrowserPdf(alice, s2.id, { kind: "pdf-text", name: "other.pdf", size: 1000, sha256: "b".repeat(64), pages: ["The monthly rent in the other matter is Rs. 99,000."] });
  const personal = await createSet(alice, { name: "Personal" });
  await uploadBrowserPdf(alice, personal.id, { kind: "pdf-text", name: "notes.pdf", size: 1000, sha256: "c".repeat(64), pages: ["Monthly rent notes that belong to no matter."] });
});

describe("research lane over document sets", () => {
  const settings = (matterId: string | null) => sanitizeSettings({ sources: ["ediscovery"], matterId, jurisdiction: "hc-karnataka" });

  it("finds passages only in the selected matter's sets, with page-exact titles, and reads them back", async () => {
    const deps = defaultDeps();
    const res = await runWithPrincipal(alice, () => deps.retrieve("ediscovery", "monthly rent", settings(M1)));
    expect(res.hits.length).toBe(1);
    const hit = res.hits[0];
    expect(hit.title).toBe("lease.pdf, p. 2");
    expect(hit.url).toMatch(/^\/documents\/[^?]+\?tab=files&file=.+&page=2$/);
    expect(hit.readRef).toMatchObject({ kind: "url" });
    const read = await runWithPrincipal(alice, () => deps.read(hit.readRef!, { title: hit.title }));
    expect(read.text).toContain("Rs. 45,000");
    expect(read.title).toBe("lease.pdf, p. 2");
  });

  it("returns nothing without a matter, and nothing for a matter the user cannot see", async () => {
    const deps = defaultDeps();
    expect((await runWithPrincipal(alice, () => deps.retrieve("ediscovery", "monthly rent", settings(null)))).hits).toEqual([]);
    expect((await runWithPrincipal(bob, () => deps.retrieve("ediscovery", "monthly rent", settings(M1)))).hits).toEqual([]);
  });

  it("refuses to read a passage for a user without access to its set", async () => {
    const deps = defaultDeps();
    const hit = (await runWithPrincipal(alice, () => deps.retrieve("ediscovery", "monthly rent", settings(M1)))).hits[0];
    await expect(runWithPrincipal(bob, () => deps.read(hit.readRef!, { title: hit.title }))).rejects.toThrow(/not found or not accessible/);
  });
});
