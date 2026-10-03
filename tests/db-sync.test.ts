import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { setRemoteStoreForTests, neonEndpoint, fromBytea, type RemoteStore, type Row, type SqlQuery } from "@/lib/db/remote";
import { flushDb, pendingWrites, resetSyncStateForTests, syncDb } from "@/lib/db/sync";
import { db, resetSqlite } from "@/lib/db";
import { getWorkspace } from "@/lib/workspace";
import * as workspaceRoute from "@/app/api/workspace/route";

/**
 * A stand-in for Neon: a separate SQLite database that executes the same SQL the sync layer sends,
 * with the Postgres-only syntax translated. Values come back as text (bytea as \x-hex), like Neon's
 * raw text output, so the decoding paths are exercised too.
 */
class FakeNeon implements RemoteStore {
  db: DatabaseSync;
  queries = 0;
  constructor() {
    const mod = (process as unknown as { getBuiltinModule: (n: string) => unknown }).getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    this.db = new mod.DatabaseSync(":memory:");
  }
  private sql(q: string) {
    return q
      .replace(/::text/g, "")
      .replace(/bigserial PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
      .replace(/timestamptz NOT NULL DEFAULT now\(\)/g, "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP")
      .replace(/\bbytea\b/g, "BLOB")
      .replace(/\$\d+/g, "?");
  }
  private text(rows: Record<string, unknown>[]): Row[] {
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : v instanceof Uint8Array ? "\\x" + Buffer.from(v).toString("hex") : String(v)])));
  }
  private run(q: SqlQuery): Row[] {
    this.queries++;
    const stmt = this.db.prepare(this.sql(q.query));
    const params = (q.params ?? []).map((p) => (typeof p === "boolean" ? Number(p) : p)) as (string | number | null | Uint8Array)[];
    if (/^\s*select/i.test(q.query)) return this.text(stmt.all(...params) as Record<string, unknown>[]);
    stmt.run(...params);
    return [];
  }
  async query(q: SqlQuery) { return this.run(q); }
  async transaction(qs: SqlQuery[]) {
    this.db.exec("BEGIN");
    try { const out = qs.map((q) => this.run(q)); this.db.exec("COMMIT"); return out; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

/** Simulate a brand-new serverless instance: empty local mirror, no sync state. */
function coldInstance() {
  resetSqlite();
  resetSyncStateForTests();
}

let remote: FakeNeon;
const prevSeed = process.env.LECLAUDE_SEED;
const prevDir = process.env.LECLAUDE_DATA_DIR;

beforeAll(() => {
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lc-sync-"));
  remote = new FakeNeon();
  setRemoteStoreForTests(remote);
  coldInstance();
});

afterAll(() => {
  setRemoteStoreForTests(undefined);
  resetSyncStateForTests();
  resetSqlite();
  if (prevSeed === undefined) delete process.env.LECLAUDE_SEED; else process.env.LECLAUDE_SEED = prevSeed;
  if (prevDir === undefined) delete process.env.LECLAUDE_DATA_DIR; else process.env.LECLAUDE_DATA_DIR = prevDir;
});

describe("serverless shared store (sync.ts)", () => {
  it("derives the Neon HTTP endpoint and decodes bytea", () => {
    expect(neonEndpoint("postgresql://u:p@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require")).toBe("https://api.us-east-2.aws.neon.tech/sql");
    expect(Array.from(fromBytea("\\x00ff10")!)).toEqual([0, 255, 16]);
  });

  it("the setup bug: a workspace created on one instance is visible on a fresh instance", async () => {
    await syncDb(); // instance A cold start (hydrates the empty remote, seeds reference data)
    expect(getWorkspace().configured).toBe(false);
    const res = await workspaceRoute.POST(new NextRequest("http://localhost/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firmName: "Hale & Ortiz LLP", name: "Dana Reyes", email: "dana@haleortiz.com", role: "Admin", owner: { name: "Dana Reyes", email: "dana@haleortiz.com", role: "Admin" } }),
    }));
    expect(res.status).toBeLessThan(300);
    expect(pendingWrites()).toBe(0); // withDb flushed before responding

    coldInstance(); // instance B: a different serverless instance with an empty /tmp
    expect(getWorkspace().configured).toBe(false); // nothing local before sync…
    await syncDb();
    const ws = getWorkspace();
    expect(ws.configured).toBe(true); // …and the shared store brings the workspace back
    expect(ws.firmName).toBe("Hale & Ortiz LLP");
    expect(ws.owner?.name).toBe("Dana Reyes");
    expect(db().people.all().some((p) => p.name === "Dana Reyes")).toBe(true);
    expect(db().workflows.count()).toBeGreaterThan(0); // reference templates were shared, not reseeded per instance
  });

  it("persists documents, kv and blobs across instances and pulls later changes", async () => {
    const c = db().collection<{ id: string; title: string }>("sync_probe");
    c.put({ id: "a", title: "first" });
    db().kv.set("probe:counter", 7);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    db().blobs.put(bytes, "application/octet-stream", { id: "blob_probe", name: "probe.bin" });
    await flushDb();

    coldInstance();
    await syncDb();
    expect(db().collection<{ id: string; title: string }>("sync_probe").get("a")?.title).toBe("first");
    expect(db().kv.get<number>("probe:counter")).toBe(7);
    expect(Array.from(db().blobs.get("blob_probe")!.bytes)).toEqual([1, 2, 3, 250]);

    // Another instance updates the record and deletes the kv key.
    await remote.transaction([
      { query: "UPDATE lc_docs SET json = $1, updated_at = $2 WHERE collection = $3 AND id = $4", params: [JSON.stringify({ id: "a", title: "second" }), new Date().toISOString(), "sync_probe", "a"] },
      { query: "INSERT INTO lc_changes (tbl, k1, k2) VALUES ($1, $2, $3)", params: ["docs", "sync_probe", "a"] },
      { query: "DELETE FROM lc_kv WHERE key = $1", params: ["probe:counter"] },
      { query: "INSERT INTO lc_changes (tbl, k1, k2) VALUES ($1, $2, $3)", params: ["kv", "probe:counter", ""] },
    ]);
    await syncDb(); // warm instance: pull only the changes
    expect(db().collection<{ id: string; title: string }>("sync_probe").get("a")?.title).toBe("second");
    expect(db().kv.get("probe:counter")).toBeNull();
  });

  it("never lets a pull overwrite an unflushed local write, and deletes propagate", async () => {
    const c = db().collection<{ id: string; title: string }>("sync_probe");
    c.put({ id: "a", title: "local edit" }); // not flushed yet
    await remote.transaction([
      { query: "UPDATE lc_docs SET json = $1 WHERE collection = $2 AND id = $3", params: [JSON.stringify({ id: "a", title: "remote edit" }), "sync_probe", "a"] },
      { query: "INSERT INTO lc_changes (tbl, k1, k2) VALUES ($1, $2, $3)", params: ["docs", "sync_probe", "a"] },
    ]);
    await syncDb();
    expect(c.get("a")?.title).toBe("local edit");
    await flushDb();
    c.delete("a");
    await flushDb();
    coldInstance();
    await syncDb();
    expect(db().collection("sync_probe").get("a")).toBeNull();
  });

  it("restores unflushed writes when the database rejects a flush", async () => {
    const failing: RemoteStore = { query: (q) => remote.query(q), transaction: async () => { throw new Error("database unavailable"); } };
    setRemoteStoreForTests(failing);
    db().kv.set("probe:retry", 1);
    await expect(flushDb()).rejects.toThrow("database unavailable");
    expect(pendingWrites()).toBeGreaterThan(0);
    setRemoteStoreForTests(remote);
    await flushDb();
    expect(pendingWrites()).toBe(0);
    coldInstance();
    await syncDb();
    expect(db().kv.get<number>("probe:retry")).toBe(1);
  });
});


describe("bounded database recovery", () => {
  it("hydrates oversized datasets without a giant response and retains every vector chunk", async () => {
    await flushDb();
    const now = new Date().toISOString();
    const doc = remote.db.prepare("INSERT INTO lc_docs VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < 520; i++) doc.run("bulk_recovery", String(i).padStart(4, "0"), JSON.stringify({ id: String(i).padStart(4, "0"), text: "x".repeat(4096) }), now, now);
    const vec = remote.db.prepare("INSERT INTO lc_vectors VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < 513; i++) vec.run("bulk_recovery", "many-chunks", i, JSON.stringify({ collection: "bulk_recovery", doc_id: "many-chunks", chunk_index: i, text: "chunk " + i }), new Uint8Array([1, 2, 3, 4]));
    const blob = remote.db.prepare("INSERT INTO lc_blobs VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < 65; i++) blob.run("recovery_blob_" + i, "test.bin", "application/octet-stream", 8192, new Uint8Array(8192).fill(i), null, now);
    const cap = <T,>(rows: T): T => { if (Buffer.byteLength(JSON.stringify(rows)) > 512000) throw Object.assign(new Error("response is too large (max is 512000 bytes)"), { status: 507 }); return rows; };
    const bounded: RemoteStore = { query: async (q) => cap(await remote.query(q)), transaction: async (qs) => cap(await remote.transaction(qs)) };
    setRemoteStoreForTests(bounded);
    coldInstance();
    try {
      await syncDb();
      expect(db().collection("bulk_recovery").count()).toBe(520);
      expect(db().blobs.get("recovery_blob_64")?.bytes.length).toBe(8192);
      const { getSqlite } = await import("@/lib/db/sqlite");
      expect((getSqlite().prepare("SELECT COUNT(*) AS n FROM vectors WHERE collection = ?").get("bulk_recovery") as { n: number }).n).toBe(513);
    } finally { setRemoteStoreForTests(remote); }
  });
});
