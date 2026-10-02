/**
 * docProps/custom.xml (OPC custom file properties): machine-readable provenance written into exported .docx files.
 *
 * The app owns the "<brand>." name prefix (src/lib/brand.ts) and the pre-rename "LeClaude." prefix. On export every
 * existing property with either prefix is replaced by the current values (stale provenance never survives a
 * re-export); properties written by Word or other tools are kept byte-for-byte apart from their `pid`, which is
 * renumbered so ids stay unique.
 */
import { BRAND } from "@/lib/brand";
import { escAttr, XML_DECL } from "./xml";

export const CUSTOM_PROPS_PATH = "docProps/custom.xml";
export const REL_CUSTOM_PROPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
export const CT_CUSTOM_PROPS = "application/vnd.openxmlformats-officedocument.custom-properties+xml";
/** FMTID_UserDefinedProperties: the format id Word uses for user-defined properties. */
export const CUSTOM_PROPS_FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
export const OWN_PREFIX = `${BRAND.name}.`;
/** Prefixes written by earlier releases; still owned, so a re-export replaces them instead of keeping stale values. */
export const LEGACY_OWN_PREFIXES: readonly string[] = ["LeClaude."];
const isOwn = (name: string) => name.startsWith(OWN_PREFIX) || LEGACY_OWN_PREFIXES.some((x) => name.startsWith(x));

export type CustomPropValue = string | number | boolean | Date;
export interface CustomProp { name: string; value: CustomPropValue }

const NS = `xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"`;

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Characters XML 1.0 cannot carry are dropped; Word also caps lpwstr values at 255 characters. */
const clean = (s: string, max = 255) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").slice(0, max);

function valueXml(v: CustomPropValue): string {
  if (typeof v === "boolean") return `<vt:bool>${v ? "true" : "false"}</vt:bool>`;
  if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 2_147_483_647) return `<vt:i4>${v}</vt:i4>`;
  if (typeof v === "number") return `<vt:r8>${Number.isFinite(v) ? v : 0}</vt:r8>`;
  if (v instanceof Date) return `<vt:filetime>${Number.isNaN(v.getTime()) ? "1970-01-01T00:00:00Z" : v.toISOString().replace(/\.\d{3}Z$/, "Z")}</vt:filetime>`;
  return `<vt:lpwstr>${escText(clean(String(v)))}</vt:lpwstr>`;
}

/** Valid, unique property names: trimmed, at most 255 characters, first occurrence wins. */
function normalize(props: CustomProp[]): CustomProp[] {
  const seen = new Set<string>();
  const out: CustomProp[] = [];
  for (const p of props) {
    const name = clean(String(p?.name ?? "").trim());
    if (!name || seen.has(name.toLowerCase()) || p.value === undefined || p.value === null) continue;
    seen.add(name.toLowerCase());
    out.push({ name, value: p.value });
  }
  return out;
}

/** `<property>` elements of an existing custom.xml, raw. */
function existingProperties(xml: string): { raw: string; name: string }[] {
  const out: { raw: string; name: string }[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?property\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?property>)/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1] ?? "";
    out.push({ raw: m[0], name: name.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'") });
  }
  return out;
}

/**
 * The custom.xml part with `props` set. With `existing`, foreign properties are kept (pid renumbered) and every
 * app-owned property (and any foreign one with the same name as a new one) is replaced.
 */
export function customPropsXml(props: CustomProp[], existing?: string | null): string {
  const next = normalize(props);
  const names = new Set(next.map((p) => p.name.toLowerCase()));
  const kept = existing ? existingProperties(existing).filter((p) => !isOwn(p.name) && !names.has(p.name.toLowerCase())) : [];
  let pid = 2; // pid 0 and 1 are reserved
  const keptXml = kept.map((p) => (/\bpid="\d+"/.test(p.raw) ? p.raw.replace(/\bpid="\d+"/, `pid="${pid++}"`) : p.raw.replace(/<((?:\w+:)?property)\b/, `<$1 pid="${pid++}"`))).join("");
  const ownXml = next.map((p) => `<property fmtid="${CUSTOM_PROPS_FMTID}" pid="${pid++}" name="${escAttr(p.name)}">${valueXml(p.value)}</property>`).join("");
  return `${XML_DECL}<Properties ${NS}>${keptXml}${ownXml}</Properties>`;
}

/** Read the app-owned (or all) properties back as name → text value (tests, diagnostics). */
export function readCustomProps(xml: string, opts: { ownOnly?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of existingProperties(xml)) {
    if (opts.ownOnly && !isOwn(p.name)) continue;
    const v = /<vt:\w+>([\s\S]*?)<\/vt:\w+>/.exec(p.raw)?.[1] ?? "";
    out[p.name] = v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  return out;
}
