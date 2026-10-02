import { describe, expect, it } from "vitest";
import { appDisplayName, BRAND } from "@/lib/brand";
import { UI_LOCALES } from "@/lib/india/languages";
import { CATALOGUES } from "@/lib/i18n/catalog";
import { OWN_PREFIX } from "@/modules/office/word/ooxml/custom-props";
import { DEFAULT_DECLARATION } from "@/modules/office/word/provenance";

describe("brand", () => {
  it("names the product Pramana", () => {
    expect(BRAND.name).toBe("Pramana");
  });

  it("uses NEXT_PUBLIC_APP_NAME as a white-label override but ignores a leftover pre-rename value", () => {
    expect(appDisplayName(undefined)).toBe("Pramana");
    expect(appDisplayName("  ")).toBe("Pramana");
    expect(appDisplayName("Chambers Desk")).toBe("Chambers Desk");
    expect(appDisplayName("LeClaude")).toBe("Pramana");
    expect(appDisplayName("LeClaude India")).toBe("Pramana");
    expect(appDisplayName("le claude")).toBe("Pramana");
  });

  it("keeps the brand name in Latin script in every UI locale and never shows the retired name", () => {
    for (const l of UI_LOCALES) {
      const cat = CATALOGUES[l] as Record<string, string>;
      expect(cat["brand.name"], l).toBe(BRAND.name);
      for (const [k, v] of Object.entries(cat)) expect(v, `${l} ${k}`).not.toMatch(/le\s*claude/i);
    }
  });

  it("writes export provenance under the brand", () => {
    expect(OWN_PREFIX).toBe("Pramana.");
    expect(DEFAULT_DECLARATION).toContain("(Pramana)");
  });
});
