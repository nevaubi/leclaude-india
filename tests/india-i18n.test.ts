import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LECLAUDE_DATA_DIR = `${process.env.TMPDIR || "/tmp"}/india-i18n-vitest-${process.pid}`;
  process.env.LECLAUDE_SEED = "reference";
  process.env.LECLAUDE_BACKGROUND = "off";
  process.env.WORKFLOW_SCHEDULER_DISABLED = "1";
  process.env.INTEL_OFFLINE = "1";
  delete process.env.AUTH_MODE;
  delete process.env.LECLAUDE_USER_ID;
});

import { NextRequest } from "next/server";
import { UI_LOCALES } from "@/lib/india/languages";
import { db, resetSqlite } from "@/lib/db";
import { CATALOGUES, MESSAGE_KEYS, messagesFor, missingKeys, englishMessages, type MessageKey } from "@/lib/i18n/catalog";
import { formatMessage, placeholders } from "@/lib/i18n/icu";
import { createTranslator } from "@/lib/i18n/translator";
import { formatCurrency, formatDate, formatNumber, formatTime } from "@/lib/i18n/format";
import { isUiLocale, localeDir, matchAcceptLanguage, parseAcceptLanguage, resolveLocale, LOCALE_COOKIE } from "@/lib/i18n/locale";
import { resolveAnswerLanguage, answerLanguageLabel } from "@/lib/i18n/answer-language";
import { relativeDue } from "@/lib/i18n/relative";
import { effectiveLanguagePreferences, getUserLanguage, preferredAnswerLanguage, setUserLanguage, setWorkspaceLanguage } from "@/lib/i18n/preferences";
import { devPrincipal } from "@/lib/auth/principal";
import * as i18nRoute from "@/app/api/i18n/route";

describe("catalogues", () => {
  it("ships a catalogue for every UI locale", () => {
    expect([...UI_LOCALES].sort()).toEqual(["bn", "en", "hi", "kn", "mr", "ta", "te", "ur"]);
    for (const l of UI_LOCALES) expect(CATALOGUES[l], l).toBeDefined();
  });

  it("every locale has every key, non-empty", () => {
    for (const l of UI_LOCALES) expect(missingKeys(l), `missing in ${l}`).toEqual([]);
  });

  it("no locale carries keys English does not know", () => {
    for (const l of UI_LOCALES) {
      const extra = Object.keys(CATALOGUES[l]!).filter((k) => !(k in englishMessages));
      expect(extra, `unknown keys in ${l}`).toEqual([]);
    }
  });

  it("every translation uses the same placeholders as English", () => {
    for (const l of UI_LOCALES) {
      const cat = CATALOGUES[l]!;
      for (const k of MESSAGE_KEYS) expect(placeholders(cat[k]), `${l} ${k}`).toEqual(placeholders(englishMessages[k]));
    }
  });

  it("translations are really translated (not English copies) outside proper nouns and codes", () => {
    const sameAllowed = new Set<MessageKey>(["brand.name", "settings.group.ai", "nav.office.pdfs", "matters.f.cnr", "matters.contextCount", "palette.research"]);
    for (const l of UI_LOCALES.filter((x) => x !== "en")) {
      const cat = CATALOGUES[l]!;
      const copies = MESSAGE_KEYS.filter((k) => !sameAllowed.has(k) && cat[k] === englishMessages[k] && /[a-z]{3,}/.test(englishMessages[k]));
      expect(copies, `${l} copies English`).toEqual([]);
    }
  });

  it("uses standard Indian legal terms", () => {
    expect(CATALOGUES.hi!["matters.col.court"]).toBe("न्यायालय");
    expect(CATALOGUES.kn!["matters.col.court"]).toBe("ನ್ಯಾಯಾಲಯ");
    expect(CATALOGUES.te!["matters.col.court"]).toBe("న్యాయస్థానం");
    expect(CATALOGUES.hi!["research.example.3"]).toContain("याचिका");
    expect(CATALOGUES.kn!["research.example.1"]).toContain("ಅರ್ಜಿ");
    expect(CATALOGUES.te!["research.example.1"]).toContain("పిటిషన్");
  });

  it("falls back to English for a locale without a catalogue and for a gap", () => {
    expect(messagesFor("gu")["nav.home"]).toBe("Home");
    const t = createTranslator("hi", { ...messagesFor("hi"), "nav.home": "" });
    expect(t.t("nav.home")).toBe("");
    const merged = messagesFor("hi");
    expect(merged["nav.home"]).toBe("मुखपृष्ठ");
    expect(Object.keys(merged)).toHaveLength(MESSAGE_KEYS.length);
  });
});

describe("ICU-lite", () => {
  it("interpolates and keeps a missing variable visible", () => {
    expect(formatMessage("Hello, {name}.", { name: "Asha" })).toBe("Hello, Asha.");
    expect(formatMessage("Hello, {name}.")).toBe("Hello, {name}.");
  });
  it("selects plural branches with exact matches and # as an Indian-grouped count", () => {
    const m = englishMessages["home.summary.eventsToday"];
    expect(formatMessage(m, { count: 0 }, "en-IN")).toBe("no events today");
    expect(formatMessage(m, { count: 1 }, "en-IN")).toBe("1 event today");
    expect(formatMessage(m, { count: 3 }, "en-IN")).toBe("3 events today");
    expect(formatMessage(englishMessages["noun.matter"], { count: 100000 }, "en-IN")).toBe("1,00,000 matters");
  });
  it("uses the locale's plural rules", () => {
    const kn = createTranslator("kn", messagesFor("kn"));
    expect(kn.t("noun.matter", { count: 1 })).toBe("1 ಪ್ರಕರಣ");
    expect(kn.t("noun.matter", { count: 4 })).toBe("4 ಪ್ರಕರಣಗಳು");
    const ur = createTranslator("ur", messagesFor("ur"));
    expect(ur.t("noun.matter", { count: 2 })).toBe("2 مقدمات");
  });
  it("supports select", () => {
    expect(formatMessage("{kind, select, hearing {a hearing} other {an event}}", { kind: "hearing" })).toBe("a hearing");
    expect(formatMessage("{kind, select, hearing {a hearing} other {an event}}", { kind: "x" })).toBe("an event");
  });
  it("translates dynamic keys only when they exist", () => {
    const t = createTranslator("te", messagesFor("te"));
    expect(t.tx("noun.matter", "x", { count: 2 })).toBe("2 కేసులు");
    expect(t.tx("noun.production", "5 productions", { count: 5 })).toBe("5 productions");
  });
});

describe("locale resolution", () => {
  it("prefers cookie, then user, then workspace, then Accept-Language, then English", () => {
    expect(resolveLocale({ cookie: "kn", userPreference: "hi", workspaceDefault: "te", acceptLanguage: "ta" })).toBe("kn");
    expect(resolveLocale({ cookie: "xx", userPreference: "hi", workspaceDefault: "te" })).toBe("hi");
    expect(resolveLocale({ workspaceDefault: "te", acceptLanguage: "ta" })).toBe("te");
    expect(resolveLocale({ acceptLanguage: "fr-FR,kn-IN;q=0.9,en;q=0.8" })).toBe("kn");
    expect(resolveLocale({ acceptLanguage: "gu-IN,fr" })).toBe("en");
    expect(resolveLocale({})).toBe("en");
  });
  it("parses Accept-Language by weight and ignores q=0", () => {
    expect(parseAcceptLanguage("en;q=0.5, hi-IN, te;q=0.8, ur;q=0")).toEqual(["hi-in", "te", "en"]);
    expect(matchAcceptLanguage("ur-IN")).toBe("ur");
  });
  it("marks Urdu right-to-left and only catalogue languages as UI locales", () => {
    expect(localeDir("ur")).toBe("rtl");
    expect(localeDir("kn")).toBe("ltr");
    expect(isUiLocale("gu")).toBe(false);
    expect(isUiLocale("te")).toBe(true);
    expect(LOCALE_COOKIE).toBe("lc_locale");
  });
});

describe("Indian formats", () => {
  it("writes dates day-first: 31-05-2024 and 31 May 2024", () => {
    expect(formatDate("2024-05-31", "en", "numeric")).toBe("31-05-2024");
    expect(formatDate("2024-05-31", "en", "medium")).toBe("31 May 2024");
    expect(formatDate("2024-05-31", "en", "full")).toBe("Friday, 31 May 2024");
    expect(formatDate("2024-05-31", "hi", "medium")).toBe("31 मई 2024");
    expect(formatDate("2024-05-31", "kn", "medium")).toMatch(/^31 \S+ 2024$/);
    expect(formatDate("2024-05-31", "ur", "numeric")).toBe("31-05-2024");
  });
  it("uses Asia/Kolkata for instants and never shifts date-only values", () => {
    expect(formatDate("2024-05-31T20:00:00Z", "en", "numeric")).toBe("01-06-2024");
    expect(formatDate("2024-05-31", "en", "numeric", { timeZone: "America/New_York" })).toBe("31-05-2024");
    expect(formatTime("2024-05-31T05:00:00Z", "en")).toMatch(/^10:30\s?am$/i);
    expect(formatDate("not a date")).toBe("");
  });
  it("groups numbers in lakh/crore with Latin digits in every language", () => {
    expect(formatNumber(12345678)).toBe("1,23,45,678");
    expect(createTranslator("kn", messagesFor("kn")).number(1250000)).toBe("12,50,000");
    expect(createTranslator("mr", messagesFor("mr")).number(100000)).toBe("1,00,000");
    expect(formatCurrency(1250000)).toBe("₹12,50,000");
    expect(formatCurrency(1250000.5)).toBe("₹12,50,000.50");
  });
  it("renders relative due text per locale", () => {
    const hi = createTranslator("hi", messagesFor("hi")).t;
    expect(relativeDue(-3, hi)).toEqual({ text: "3 दिन विलंबित", overdue: true });
    expect(relativeDue(1, hi).text).toBe("कल");
    const en = createTranslator("en").t;
    expect(relativeDue(20, en).text).toBe("in 3 weeks");
  });
});

describe("answer language", () => {
  it("follows the question's script when set to auto", () => {
    expect(resolveAnswerLanguage("auto", "ಜಾಮೀನು ಅರ್ಜಿ ಸಮರ್ಥನೀಯವೇ?")).toBe("kn");
    expect(resolveAnswerLanguage("auto", "బెయిల్ పిటిషన్")).toBe("te");
    expect(resolveAnswerLanguage("auto", "کیا درخواست قابلِ سماعت ہے؟")).toBe("ur");
    expect(resolveAnswerLanguage("auto", "Is the petition maintainable?")).toBe("en");
    expect(resolveAnswerLanguage("hi", "Is the petition maintainable?")).toBe("hi");
    expect(resolveAnswerLanguage(null, "")).toBe("en");
    expect(answerLanguageLabel("kn")).toBe("Kannada (ಕನ್ನಡ)");
  });
});

describe("preferences and /api/i18n", () => {
  beforeAll(() => { resetSqlite(); db(); });

  it("stores per-user choices over workspace defaults and exposes preferredAnswerLanguage()", () => {
    expect(preferredAnswerLanguage("u_pref_test")).toBe("auto");
    setWorkspaceLanguage({ defaultLocale: "kn", answerLanguage: "en" });
    expect(effectiveLanguagePreferences("u_pref_test").locale).toBe("kn");
    expect(preferredAnswerLanguage("u_pref_test")).toBe("en");
    setUserLanguage("u_pref_test", { locale: "te", answerLanguage: "te" });
    expect(effectiveLanguagePreferences("u_pref_test")).toMatchObject({ locale: "te", answerLanguage: "te", userLocale: "te" });
    expect(preferredAnswerLanguage("u_pref_test")).toBe("te");
    setUserLanguage("u_pref_test", { locale: null, answerLanguage: null });
    expect(getUserLanguage("u_pref_test")).toMatchObject({ locale: undefined, answerLanguage: undefined });
    expect(() => setUserLanguage("u_pref_test", { locale: "gu" })).toThrow(/locale/);
    setWorkspaceLanguage({ defaultLocale: "en", answerLanguage: "auto" });
  });

  it("PUT saves the caller's own locale, sets the cookie and rejects unsupported values", async () => {
    const put = (body: unknown) => (i18nRoute.PUT as unknown as (r: NextRequest) => Promise<Response>)(new NextRequest("http://localhost/api/i18n", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    const ok = await put({ locale: "ur", answerLanguage: "auto" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("lc_locale=ur");
    const me = devPrincipal().id;
    expect(getUserLanguage(me).locale).toBe("ur");
    const bad = await put({ locale: "fr" });
    expect(bad.status).toBe(400);
    const notObject = await put(["kn"]);
    expect(notObject.status).toBe(400);
    const get = await (i18nRoute.GET as unknown as (r: NextRequest) => Promise<Response>)(new NextRequest("http://localhost/api/i18n"));
    const body = (await get.json()) as { locale: string; uiLocales: string[] };
    expect(body.locale).toBe("ur");
    expect(body.uiLocales).toContain("kn");
  });
});
