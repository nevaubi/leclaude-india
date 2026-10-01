import { describe, expect, it } from "vitest";
import { isLegacyTlsError, legacyTlsAllowed, legacyTlsFetch } from "@/modules/media/legacy-tls";

describe("legacy TLS fallback for government image hosts", () => {
  it("recognises the renegotiation error only", () => {
    expect(isLegacyTlsError(new Error("fetch failed (ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED) (policy media)"))).toBe(true);
    expect(isLegacyTlsError({ cause: { code: "ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED" } })).toBe(true);
    expect(isLegacyTlsError(new Error("certificate has expired"))).toBe(false);
  });
  it("is limited to https gov.in / nic.in hosts", async () => {
    expect(legacyTlsAllowed("https://bombayhighcourt.gov.in/bhc/x.jpg")).toBe(true);
    expect(legacyTlsAllowed("https://delhihighcourt.nic.in/a.png")).toBe(true);
    expect(legacyTlsAllowed("http://bombayhighcourt.gov.in/x.jpg")).toBe(false);
    expect(legacyTlsAllowed("https://example.com/x.jpg")).toBe(false);
    expect(legacyTlsAllowed("https://gov.in.example.com/x.jpg")).toBe(false);
    await expect(legacyTlsFetch("https://example.com/x.jpg")).rejects.toThrow(/government hosts/);
  });
});
