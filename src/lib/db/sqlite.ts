import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { remoteUrl } from "./remote";
import { BRAND } from "@/lib/brand";

/**
 * SQLite via Node's built-in `node:sqlite` (Node ≥ 22.13). Loaded through
 * process.getBuiltinModule so bundlers never try to resolve it.
 */
function loadDatabaseSync(): typeof DatabaseSync {
  const mod = (process as unknown as { getBuiltinModule: (n: string) => unknown }).getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  if (!mod?.DatabaseSync) throw new Error(`node:sqlite is unavailable. ${BRAND.name} requires Node.js 22.13 or newer.`);
  return mod.DatabaseSync;
}

let resolvedDataDir: string | null = null;

/**
 * Directory for the SQLite database and uploads. Defaults to ./data; when that
 * location is not writable (serverless hosts such as Vercel mount the bundle
 * read-only) it falls back to a temp directory, which is ephemeral: set
 * LECLAUDE_DATA_DIR to a persistent volume for real deployments.
 */
export function dataDir() {
  if (resolvedDataDir) return resolvedDataDir;
  const candidates = [process.env.LECLAUDE_DATA_DIR?.trim() || path.join(process.cwd(), "data"), path.join(os.tmpdir(), "leclaude-data")];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      if (dir !== candidates[0]) console.warn(`[leclaude] ${candidates[0]} is not writable; using ephemeral data directory ${dir}. Set LECLAUDE_DATA_DIR to a persistent path.`);
      resolvedDataDir = dir;
      return dir;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error("No writable data directory. Set LECLAUDE_DATA_DIR to a writable path.");
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS docs_collection_updated ON docs(collection, updated_at DESC);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vectors (
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,
  meta TEXT,
  model TEXT,
  PRIMARY KEY (collection, doc_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS vectors_collection ON vectors(collection);
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  name TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
`;

type GlobalWithDb = typeof globalThis & { __leclaudeDb?: DatabaseSync; __leclaudeDbPath?: string };

/** Local database file; with a remote store it is only this instance's mirror, kept apart from a development database. */
function dbFile(): string {
  return path.join(dataDir(), remoteUrl() ? "leclaude-mirror.db" : "leclaude.db");
}

export function getSqlite(): DatabaseSync {
  const g = globalThis as GlobalWithDb;
  const file = dbFile();
  if (g.__leclaudeDb && g.__leclaudeDbPath === file) return g.__leclaudeDb;
  const Database = loadDatabaseSync();
  const db = new Database(file);
  db.exec(SCHEMA);
  g.__leclaudeDb = db;
  g.__leclaudeDbPath = file;
  return db;
}

/** Drop everything (used by scripts/reset-db.ts and tests). */
export function resetSqlite() {
  const g = globalThis as GlobalWithDb;
  if (g.__leclaudeDb) {
    try { g.__leclaudeDb.close(); } catch {}
    g.__leclaudeDb = undefined;
  }
  const file = dbFile();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(file + suffix, { force: true }); } catch {}
  }
  cacheRegistry.clear();
}

/** Per-collection in-memory caches, shared with collections.ts. */
export const cacheRegistry = new Map<string, Map<string, unknown>>();
