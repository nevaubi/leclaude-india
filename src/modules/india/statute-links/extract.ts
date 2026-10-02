/**
 * Section references in judgment METADATA (pure, deterministic).
 *
 * Judgments without full text can be linked to a statute section only from their metadata. The Supreme Court Reports
 * card's headnote puts the Act first ("Penal Code, 1860 – s.302 – Murder …", "Constitution of India – Art.21 – …",
 * "Code of Criminal Procedure, 1973 – ss.161, 162 – …"), which the running-text parser (`extractStatutes`, "s. 302 IPC")
 * does not read, so both forms are read here. The Act is resolved only through the coded Act table (`resolveAct`):
 * "Code of Criminal Procedure" and "Penal Code" are different Acts, an ambiguous alias without a year stays unresolved,
 * and an unresolved Act yields no link.
 */
import { ACTS, extractStatutes, resolveAct } from "@/lib/india/statutes";

export const META_EXTRACTOR_VERSION = 1;

export interface MetaSectionRef {
  actId: string;
  /** Section or Article as printed, normalised ("302", "498A", "19(1)(g)"). */
  section: string;
  raw: string;
  form: "act_first" | "running_text";
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALIASES = [...new Set(ACTS.flatMap((a) => a.aliases))].sort((a, b) => b.length - a.length);
const ALIAS_RE = ALIASES.map((a) => esc(a).replace(/\\\./g, "\\.?\\s*").replace(/\s+/g, "\\s*")).join("|");
const SEC = String.raw`\d{1,4}[A-Z]{0,2}(?:\s?\(\s?[0-9A-Za-z]{1,4}\s?\))*`;
const LIST = `${SEC}(?:\\s*(?:,|and|&|/)\\s*${SEC})*`;
// "Penal Code, 1860 – s.302", "Constitution of India – Arts.14, 21", "Constitution of India : Articles 129 and 142",
// "Evidence Act, 1872 - ss. 24 and 27".
const ACT_FIRST = new RegExp(`(?<![A-Za-z])(${ALIAS_RE})\\s*(?:,?\\s*((?:18|19|20)\\d{2}))?\\s*(?:[–—-]+|:)\\s*((?:ss?|[Ss]ections?|Arts?|Articles?)\\.?)\\s*(${LIST})`, "g");

const normSec = (s: string) => s.replace(/\s+/g, "").replace(/^(\d+)-([A-Z])/, "$1$2");

/** Every resolvable section reference in a metadata field (headnote / catchwords). Deduplicated by act + section. */
export function extractMetaSectionRefs(text: string | null | undefined): MetaSectionRef[] {
  const t = (text ?? "").replace(/\s+/g, " ");
  if (!t.trim()) return [];
  const out = new Map<string, MetaSectionRef>();
  const put = (r: MetaSectionRef) => { const k = `${r.actId}|${r.section}`; if (!out.has(k)) out.set(k, r); };
  for (const m of t.matchAll(ACT_FIRST)) {
    const year = m[2] ? Number(m[2]) : undefined;
    const isArticle = /^art/i.test(m[3]);
    const r = resolveAct(m[1], year);
    if (!r.actId) continue;
    const act = ACTS.find((a) => a.id === r.actId)!;
    if (isArticle !== (act.unit === "article")) continue; // "Constitution – s.21" or "IPC – Art.302" is not a reference
    for (const s of m[4].split(/\s*(?:,|and|&|\/)\s*/)) if (s.trim()) put({ actId: act.id, section: normSec(s), raw: m[0].trim(), form: "act_first" });
  }
  for (const ref of extractStatutes(t)) {
    if (!ref.actId || ref.kind === "order_rule") continue;
    for (const s of ref.sections) put({ actId: ref.actId, section: normSec(s), raw: ref.raw.trim(), form: "running_text" });
  }
  return [...out.values()];
}
