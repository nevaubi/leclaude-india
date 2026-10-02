import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword, PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { readCookie, safeNextPath } from "@/lib/auth/session-token";

const FAST = { N: 1024, r: 8, p: 1 };

describe("password hashing (scrypt)", () => {
  it("hashes with a random salt and verifies only the right password", async () => {
    const a = await hashPassword("correct horse battery", FAST);
    const b = await hashPassword("correct horse battery", FAST);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toBe(b); // salted
    expect(a).not.toContain("correct");
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  it("uses the default (production) parameters when none are given", async () => {
    const h = await hashPassword("a long enough password");
    expect(h.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword("a long enough password", h)).toBe(true);
  });

  it("never verifies a malformed or tampered stored value", async () => {
    const h = await hashPassword("correct horse battery", FAST);
    const parts = h.split("$");
    expect(await verifyPassword("correct horse battery", "")).toBe(false);
    expect(await verifyPassword("correct horse battery", "plain-text-password")).toBe(false);
    expect(await verifyPassword("correct horse battery", ["bcrypt", ...parts.slice(1)].join("$"))).toBe(false);
    expect(await verifyPassword("correct horse battery", [...parts.slice(0, 1), "1000", ...parts.slice(2)].join("$"))).toBe(false); // N not a power of two
    expect(await verifyPassword("correct horse battery", [...parts.slice(0, 5), Buffer.alloc(64).toString("base64url")].join("$"))).toBe(false);
  });

  it("enforces a minimum and maximum length", async () => {
    expect(passwordProblem(undefined)).toBeTruthy();
    expect(passwordProblem("short")).toMatch(String(PASSWORD_MIN_LENGTH));
    expect(passwordProblem(" ".repeat(20))).toBeTruthy();
    expect(passwordProblem("x".repeat(257))).toBeTruthy();
    expect(passwordProblem("twelve chars")).toBeNull();
    await expect(hashPassword("short", FAST)).rejects.toThrow(RangeError);
  });
});

describe("session-token helpers", () => {
  it("reads one cookie from a Cookie header", () => {
    expect(readCookie("a=1; lc_session=abc.def.ghi; b=2", "lc_session")).toBe("abc.def.ghi");
    expect(readCookie("lc_session_x=1", "lc_session")).toBeUndefined();
    expect(readCookie(null, "lc_session")).toBeUndefined();
  });

  it("only keeps same-origin relative next paths", () => {
    expect(safeNextPath("/matters?x=1#y")).toBe("/matters?x=1#y");
    for (const bad of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "matters", "/login?next=/x", "/api/matters", "/x\u0000y", ""]) {
      expect(safeNextPath(bad), bad).toBe("/");
    }
  });
});
