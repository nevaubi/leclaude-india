import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_API } from "@/lib/auth/gatekeeper";

/**
 * Route audit (constitution §22): every HTTP handler exported from src/app/api/**\/route.ts must resolve and
 * authorize the principal through `withAuth` (src/lib/auth/route.ts) or `edAuth` (its e-discovery front,
 * src/modules/ediscovery/route-auth.ts). The only exceptions are listed here with the reason; the middleware's
 * public API allowlist must match this list exactly.
 */
const UNWRAPPED_ALLOWED: Record<string, { methods: string[]; reason: string }> = {
  "auth/login": { methods: ["POST"], reason: "starts a session; rate-limited, generic errors" },
  "auth/logout": { methods: ["POST"], reason: "only clears this browser's cookie" },
  "auth/bootstrap": { methods: ["GET", "POST"], reason: "GET returns booleans; POST needs AUTH_SETUP_TOKEN and closes once any password exists" },
  health: { methods: ["GET"], reason: "liveness; anonymous callers get { ok, time } only when sign-in is enforced" },
};

const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const API_ROOT = path.resolve(__dirname, "../src/app/api");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

interface Row { route: string; method: string; wrapped: boolean; expr: string }

function audit(): Row[] {
  const rows: Row[] = [];
  for (const file of routeFiles(API_ROOT)) {
    const route = path.relative(API_ROOT, path.dirname(file)).split(path.sep).join("/");
    const src = readFileSync(file, "utf8");
    // Function-declaration exports are not wrapped by construction.
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm)) rows.push({ route, method: m[1]!, wrapped: false, expr: "function declaration" });
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1]!.split(",")) {
        const name = part.split(/\s+as\s+/).pop()!.trim();
        if (HTTP.includes(name)) rows.push({ route, method: name, wrapped: false, expr: "re-export" });
      }
    }
    for (const m of src.matchAll(/^export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=\s*([\s\S]*?);\s*$/gm)) {
      const expr = m[2]!.replace(/\s+/g, " ");
      rows.push({ route, method: m[1]!, wrapped: /\b(withAuth|edAuth)\(/.test(expr), expr });
    }
  }
  return rows.sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
}

describe("API route audit", () => {
  const rows = audit();

  it("finds the route handlers", () => {
    expect(rows.length).toBeGreaterThan(300);
  });

  it("wraps every handler in withAuth/edAuth except the documented public ones", () => {
    const unexpected = rows.filter((r) => !r.wrapped && !UNWRAPPED_ALLOWED[r.route]?.methods.includes(r.method)).map((r) => `${r.method} /api/${r.route} = ${r.expr}`);
    expect(unexpected).toEqual([]);
  });

  it("keeps the allowlist tight: every allowlisted handler exists and is really unwrapped", () => {
    for (const [route, { methods }] of Object.entries(UNWRAPPED_ALLOWED)) {
      for (const method of methods) {
        const row = rows.find((r) => r.route === route && r.method === method);
        expect(row, `${method} /api/${route}`).toBeDefined();
        expect(row!.wrapped, `${method} /api/${route} is wrapped; drop it from the allowlist`).toBe(false);
      }
    }
  });

  it("matches the middleware's public API list (cron routes are public there but wrapped here)", () => {
    const cron = ["/api/official/run", "/api/intel/jobs/tick", "/api/india/hc-text/run", "/api/news/run"];
    expect([...PUBLIC_API].sort()).toEqual([...Object.keys(UNWRAPPED_ALLOWED).map((r) => `/api/${r}`), ...cron].sort());
    for (const c of cron) expect(rows.filter((r) => `/api/${r.route}` === c).every((r) => r.wrapped), c).toBe(true);
  });
});
