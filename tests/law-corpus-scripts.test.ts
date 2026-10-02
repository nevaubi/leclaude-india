import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The law-corpus loaders run later on a host with egress (duckdb + psycopg). Here they are compiled and their pure
 * helpers exercised with python3 (no bytecode is written into the repository; duckdb/psycopg are imported lazily).
 */
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "scripts/law-corpus");
const SCRIPTS = ["load_open_india_law.py", "load_sc_judgment_text.py", "load_hc_judgment_text.py"];
const hasPython = spawnSync("python3", ["--version"]).status === 0;

function py(code: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("python3", ["-B", "-c", code], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const LOAD = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
`;

describe.skipIf(!hasPython)("law-corpus loader scripts", () => {
  it("compile", () => {
    const code = `import py_compile, tempfile, os\nd = tempfile.mkdtemp()\n${SCRIPTS.map((f) => `py_compile.compile(${JSON.stringify(path.join(DIR, f))}, cfile=os.path.join(d, ${JSON.stringify(`${f}c`)}), doraise=True)`).join("\n")}\nprint("ok")`;
    const r = py(code);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("ok");
  });

  it("reads checksums from the nested 'files' map (and the flat form), keeping only real sha256 values", () => {
    const sha = "ab".repeat(32);
    const r = py(`${LOAD}
L = load("loi", ${JSON.stringify(path.join(DIR, "load_open_india_law.py"))})
print(json.dumps([
  L.parse_checksums({"version": "v2026.08.1", "supersedes": "v2026.08", "note": "n", "files": {"in_central_legislation.parquet": {"sha256": "${sha.toUpperCase()}", "bytes": 1}, "x.parquet": {"bytes": 2}}}),
  L.parse_checksums({"in_sebi_regulations.parquet": "${sha}", "version": "v1"}),
  L.parse_checksums({"files": {"bad.parquet": {"sha256": "nothex"}}}),
  L.parse_checksums([1, 2]),
]))`);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual([{ "in_central_legislation.parquet": sha }, { "in_sebi_regulations.parquet": sha }, {}, {}]);
  });

  it("records the status mixture, a strict in_force flag and the largest amendment count", () => {
    const r = py(`${LOAD}
L = load("loi", ${JSON.stringify(path.join(DIR, "load_open_india_law.py"))})
print(json.dumps([
  L.instrument_status(["in_force", "in_force", ""]),
  L.instrument_status(["in_force", "repealed"]),
  L.instrument_status(["", None]),
  L.max_amendment_count([None, 2, "5", "x", 3]),
  L.max_amendment_count([None]),
]))`);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual([[{ in_force: 2, not_recorded: 1 }, true], [{ in_force: 1, repealed: 1 }, false], [{ not_recorded: 2 }, null], 5, null]);
  });

  it("prefers text_original over header stripping in both judgment loaders", () => {
    for (const f of ["load_sc_judgment_text.py", "load_hc_judgment_text.py"]) {
      const r = py(`${LOAD}
M = load("m", ${JSON.stringify(path.join(DIR, f))})
print(json.dumps([
  M.chunk_body("Case: A v B\\nSection: Facts\\n\\nBody text", None),
  M.chunk_body("Case: A v B\\nSection: Facts\\nBody", "  As parsed  "),
  M.chunk_body("Case: A v B\\nSection: Facts\\nBody", "   "),
  M.chunk_body("Plain text", None),
]))`);
      expect(r.stderr, f).toBe("");
      expect(JSON.parse(r.stdout), f).toEqual(["Body text", "As parsed", "Body", "Plain text"]);
    }
  });

  it("adds the new columns additively and loads them", () => {
    const schema = readFileSync(path.join(DIR, "schema.sql"), "utf8");
    expect(schema).toMatch(/ALTER TABLE law_instruments ADD COLUMN IF NOT EXISTS status_counts jsonb;/);
    expect(schema).toMatch(/ALTER TABLE law_instruments ADD COLUMN IF NOT EXISTS in_force boolean;/);
    expect(schema).toMatch(/ALTER TABLE law_provisions ADD COLUMN IF NOT EXISTS amendment_count int;/);
    const loader = readFileSync(path.join(DIR, "load_open_india_law.py"), "utf8");
    expect(loader).toMatch(/dataset_version, status_counts, in_force\) FROM STDIN/);
    expect(loader).toMatch(/acts_referenced, text, source_url, amendment_count\) FROM STDIN/);
  });
});
