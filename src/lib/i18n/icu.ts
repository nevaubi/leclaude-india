/**
 * ICU-lite message formatting (client-safe, dependency-free).
 *
 * Supported syntax, a strict subset of ICU MessageFormat:
 *   {name}                                   interpolation
 *   {count, plural, =0 {none} one {# item} other {# items}}
 *   {kind, select, hearing {a hearing} other {an event}}
 *
 * `#` inside a plural branch is the formatted number (Indian grouping, Latin digits). Plural categories come from
 * Intl.PluralRules for the locale, so languages whose rules differ from English choose the right branch. A variable
 * that is missing renders as its placeholder (`{name}`) so a missing value is visible in review, never silently empty.
 */

export type MessageVars = Record<string, string | number | null | undefined>;

/** Latin digits and Indian (lakh/crore) grouping regardless of the UI language, as Indian court papers use. */
const numberFormat = new Intl.NumberFormat("en-IN-u-nu-latn", { maximumFractionDigits: 2 });

const pluralRulesCache = new Map<string, Intl.PluralRules>();
function pluralRules(locale: string): Intl.PluralRules {
  let r = pluralRulesCache.get(locale);
  if (!r) {
    try { r = new Intl.PluralRules(locale); } catch { r = new Intl.PluralRules("en"); }
    pluralRulesCache.set(locale, r);
  }
  return r;
}

/** Index of the brace that closes the one opened at `open` (template[open] === "{"); -1 when unbalanced. */
function matchBrace(template: string, open: number): number {
  let depth = 0;
  for (let i = open; i < template.length; i++) {
    const c = template[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Parse `=0 {..} one {..} other {..}` into a map of selector → branch text. */
function parseBranches(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    let j = i;
    while (j < body.length && body[j] !== "{" && !/\s/.test(body[j])) j++;
    const key = body.slice(i, j);
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] !== "{") break;
    const end = matchBrace(body, j);
    if (end < 0) break;
    out.set(key, body.slice(j + 1, end));
    i = end + 1;
  }
  return out;
}

function formatValue(v: string | number): string {
  return typeof v === "number" ? numberFormat.format(v) : v;
}

/** Format one message template with variables for a BCP-47 locale (used for plural rules). */
export function formatMessage(template: string, vars: MessageVars = {}, locale = "en"): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c !== "{") { out += c; i++; continue; }
    const end = matchBrace(template, i);
    if (end < 0) { out += template.slice(i); break; }
    const inner = template.slice(i + 1, end);
    const comma = inner.indexOf(",");
    if (comma < 0) {
      const name = inner.trim();
      const v = vars[name];
      out += v == null ? `{${name}}` : formatValue(v);
    } else {
      const name = inner.slice(0, comma).trim();
      const rest = inner.slice(comma + 1);
      const comma2 = rest.indexOf(",");
      const kind = (comma2 < 0 ? rest : rest.slice(0, comma2)).trim();
      const body = comma2 < 0 ? "" : rest.slice(comma2 + 1);
      const branches = parseBranches(body);
      const v = vars[name];
      if (kind === "plural") {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) { out += `{${name}}`; }
        else {
          const branch = branches.get(`=${n}`) ?? branches.get(pluralRules(locale).select(n)) ?? branches.get("other") ?? "";
          // `#` is the count; nested placeholders in the branch are formatted recursively.
          out += formatMessage(branch.replace(/#/g, numberFormat.format(n)), vars, locale);
        }
      } else if (kind === "select") {
        const branch = branches.get(String(v ?? "")) ?? branches.get("other") ?? "";
        out += formatMessage(branch, vars, locale);
      } else {
        out += v == null ? `{${name}}` : formatValue(v);
      }
    }
    i = end + 1;
  }
  return out;
}

/** Argument names a template uses, including those inside plural/select branches (for catalogue tests). */
export function placeholders(template: string): string[] {
  const names = new Set<string>();
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      if (text[i] !== "{") { i++; continue; }
      const end = matchBrace(text, i);
      if (end < 0) return;
      const inner = text.slice(i + 1, end);
      const comma = inner.indexOf(",");
      if (comma < 0) names.add(inner.trim());
      else {
        names.add(inner.slice(0, comma).trim());
        const rest = inner.slice(comma + 1);
        const comma2 = rest.indexOf(",");
        if (comma2 >= 0) for (const branch of parseBranches(rest.slice(comma2 + 1)).values()) walk(branch);
      }
      i = end + 1;
    }
  };
  walk(template);
  return [...names].sort();
}
