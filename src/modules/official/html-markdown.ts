/**
 * Small deterministic HTML → markdown converter for official pages (client-safe, no dependencies).
 *
 * Keeps headings, paragraphs, line breaks, lists, tables (as pipe tables), links (absolute, http/https only), emphasis
 * and preformatted text. Drops scripts, styles, templates, SVG/canvas, iframes, forms' controls, navigation, headers,
 * footers and asides, and comments. The output is the page's text, not an interpretation: nothing is summarised or
 * reordered, and page content is treated as data (it is never executed).
 */

export interface HtmlMarkdown {
  title: string;
  markdown: string;
  /** Absolute http(s) links in document order (deduplicated). */
  links: string[];
}

interface Node {
  tag: string; // "#text" for text nodes
  attrs: Record<string, string>;
  children: Node[];
  text?: string;
  parent?: Node;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is dropped entirely. */
const DROP_ALWAYS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "head", "nav", "aside", "select", "button", "textarea", "map", "audio", "video", "math"]);
/** Site chrome: dropped unless it belongs to an article / main region (an article's own header keeps its title). */
const CHROME = new Set(["header", "footer"]);

function dropped(n: Node): boolean {
  if (DROP_ALWAYS.has(n.tag)) return true;
  if (!CHROME.has(n.tag)) return false;
  for (let p = n.parent; p; p = p.parent) if (p.tag === "article" || p.tag === "main") return false;
  return true;
}
/** Raw-text elements: content is not parsed as HTML. */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "template"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "body", "html", "form", "fieldset", "center", "address", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "blockquote", "pre", "ul", "ol", "li", "table", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "caption", "legend"]);
/** Opening one of these closes an open element of the listed kinds (implicit end tags). */
const AUTO_CLOSE: Record<string, string[]> = {
  p: ["p"],
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  thead: ["tbody", "tfoot", "thead", "tr", "td", "th"],
  tbody: ["thead", "tfoot", "tbody", "tr", "td", "th"],
  tfoot: ["thead", "tbody", "tr", "td", "th"],
  option: ["option"],
};
/** Do not auto-close across these boundaries. */
const SCOPE = new Set(["table", "ul", "ol", "dl", "div", "section", "article", "body", "html", "td", "th", "blockquote"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  copy: "©", reg: "®", trade: "™", sect: "§", para: "¶", deg: "°", times: "×", divide: "÷", bull: "•", middot: "·", rupee: "₹", laquo: "«", raquo: "»", shy: "",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      return String.fromCodePoint(code);
    }
    const v = NAMED[e.toLowerCase()];
    return v ?? m;
  });
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Tolerant tree builder (enough HTML5 recovery for listing pages: implicit </p>, </li>, </td>, </tr>). */
export function parseHtml(html: string): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [] };
  let cur = root;
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => { if (t) cur.children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(t), parent: cur }); };
  while ((m = re.exec(html))) {
    pushText(html.slice(last, m.index));
    last = re.lastIndex;
    const name = m[1]?.toLowerCase();
    if (!name) continue; // comment, doctype, CDATA, processing instruction
    const isEnd = m[0][1] === "/";
    if (isEnd) {
      // Pop to the nearest open element with this name; ignore stray end tags.
      let n: Node | undefined = cur;
      while (n && n.tag !== name && n.tag !== "#root") n = n.parent;
      if (n && n.tag === name) cur = n.parent ?? root;
      continue;
    }
    const closes = AUTO_CLOSE[name];
    if (closes) {
      let n: Node | undefined = cur;
      while (n && n.tag !== "#root" && !SCOPE.has(n.tag) && !closes.includes(n.tag)) n = n.parent;
      if (n && closes.includes(n.tag)) cur = n.parent ?? root;
      // td/th directly in a table cell scope: close the cell before opening a sibling
      else if ((name === "td" || name === "th") && (cur.tag === "td" || cur.tag === "th")) cur = cur.parent ?? root;
    }
    if (BLOCK.has(name) && cur.tag === "p") cur = cur.parent ?? root; // a block element ends an open paragraph
    const node: Node = { tag: name, attrs: parseAttrs(m[2] ?? ""), children: [], parent: cur };
    cur.children.push(node);
    const selfClosing = /\/\s*$/.test(m[2] ?? "");
    if (RAW.has(name)) {
      const endRe = new RegExp(`</${name}\\s*>`, "ig");
      endRe.lastIndex = last;
      const end = endRe.exec(html);
      const content = html.slice(last, end ? end.index : html.length);
      if (name === "title" || name === "textarea") node.children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(content), parent: node });
      last = end ? endRe.lastIndex : html.length;
      re.lastIndex = last;
      continue;
    }
    if (!VOID.has(name) && !selfClosing) cur = node;
  }
  pushText(html.slice(last));
  return root;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Ctx {
  base: string | null;
  links: string[];
  seen: Set<string>;
}

function absUrl(href: string, ctx: Ctx): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(javascript|mailto|tel|data|vbscript):/i.test(h)) return null;
  try {
    const u = ctx.base ? new URL(h, ctx.base) : new URL(h);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch { return null; }
}

function noteLink(url: string, ctx: Ctx) {
  if (!ctx.seen.has(url)) { ctx.seen.add(url); ctx.links.push(url); }
}

const collapse = (s: string) => s.replace(/[ \t\r\n\f\v ]+/g, " ");

/** Inline content of a node (text, links, emphasis, line breaks as "\n"). */
function inline(n: Node, ctx: Ctx): string {
  if (n.tag === "#text") return collapse(n.text ?? "");
  if (dropped(n)) return "";
  if (n.tag === "br") return "\n";
  if (n.tag === "img") { const alt = collapse(n.attrs.alt ?? "").trim(); return alt ? alt : ""; }
  if (n.tag === "input" || n.tag === "option" || n.tag === "title") return "";
  const inner = n.children.map((c) => (BLOCK.has(c.tag) ? ` ${block(c, ctx, 0).trim()} ` : inline(c, ctx))).join("");
  switch (n.tag) {
    case "a": {
      const url = n.attrs.href ? absUrl(n.attrs.href, ctx) : null;
      const text = inner.replace(/\s+/g, " ").trim();
      if (!url) return inner;
      noteLink(url, ctx);
      return `[${(text || url).replace(/([[\]])/g, "\\$1")}](${url.replace(/\)/g, "%29").replace(/ /g, "%20")})`;
    }
    case "strong":
    case "b": { const t = inner.trim(); return t ? `**${t}**` : inner; }
    case "em":
    case "i": { const t = inner.trim(); return t ? `_${t}_` : inner; }
    case "code": { const t = inner.trim(); return t ? `\`${t.replace(/`/g, "'")}\`` : ""; }
    case "sup": return inner.trim() ? `^${inner.trim()}` : "";
    default: return inner;
  }
}

function cleanLines(s: string): string {
  return s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cellText(n: Node, ctx: Ctx): string {
  const t = n.children.map((c) => (BLOCK.has(c.tag) ? ` ${block(c, ctx, 0)} ` : inline(c, ctx))).join("");
  return t.replace(/\s*\n\s*/g, " <br> ").replace(/\s+/g, " ").replace(/^(<br>\s*)+|(\s*<br>)+$/g, "").trim().replace(/\|/g, "\\|");
}

function rowsOf(table: Node): Node[] {
  const rows: Node[] = [];
  const walk = (n: Node) => {
    for (const c of n.children) {
      if (c.tag === "tr") rows.push(c);
      else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") walk(c);
    }
  };
  walk(table);
  return rows;
}

function table(n: Node, ctx: Ctx): string {
  const rows = rowsOf(n).map((r) => r.children.filter((c) => c.tag === "td" || c.tag === "th").map((c) => {
    const span = Math.max(1, Math.min(Number(c.attrs.colspan) || 1, 20));
    return { text: cellText(c, ctx), span, th: c.tag === "th" };
  })).filter((r) => r.length);
  const caption = n.children.find((c) => c.tag === "caption");
  const cap = caption ? cleanLines(inline(caption, ctx)) : "";
  if (!rows.length) return cap;
  const width = Math.max(...rows.map((r) => r.reduce((s, c) => s + c.span, 0)));
  const flat = rows.map((r) => {
    const cells: string[] = [];
    for (const c of r) { cells.push(c.text); for (let i = 1; i < c.span; i++) cells.push(""); }
    while (cells.length < width) cells.push("");
    return cells;
  });
  // A single-column "table" used for layout is rendered as paragraphs.
  if (width === 1) return [cap, ...flat.map((r) => r[0])].filter(Boolean).join("\n\n");
  const line = (cells: string[]) => `| ${cells.map((c) => c || " ").join(" | ")} |`;
  const out = [line(flat[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...flat.slice(1).map(line)];
  return [cap, out.join("\n")].filter(Boolean).join("\n\n");
}

function list(n: Node, ctx: Ctx, depth: number): string {
  const ordered = n.tag === "ol";
  let i = Number(n.attrs.start) || 1;
  const items: string[] = [];
  for (const c of n.children) {
    if (c.tag !== "li") {
      if (c.tag === "ul" || c.tag === "ol") items.push(list(c, ctx, depth + 1));
      else if (c.tag !== "#text" || (c.text ?? "").trim()) { const t = cleanLines(inline(c, ctx)); if (t) items.push(`${"  ".repeat(depth)}- ${t}`); }
      continue;
    }
    const marker = ordered ? `${i++}.` : "-";
    const own: string[] = [];
    const nested: string[] = [];
    for (const k of c.children) {
      if (k.tag === "ul" || k.tag === "ol") nested.push(list(k, ctx, depth + 1));
      else own.push(BLOCK.has(k.tag) ? ` ${block(k, ctx, depth + 1)} ` : inline(k, ctx));
    }
    const text = cleanLines(own.join("")).replace(/\n+/g, " ");
    items.push(`${"  ".repeat(depth)}${marker} ${text}`.trimEnd());
    items.push(...nested.filter(Boolean));
  }
  return items.join("\n");
}

/** Render a node as markdown blocks separated by blank lines. */
function block(n: Node, ctx: Ctx, depth: number): string {
  if (n.tag === "#text") return collapse(n.text ?? "");
  if (dropped(n)) return "";
  const h = /^h([1-6])$/.exec(n.tag);
  if (h) { const t = cleanLines(inline(n, ctx)).replace(/\n+/g, " "); return t ? `\n\n${"#".repeat(Number(h[1]))} ${t}\n\n` : ""; }
  switch (n.tag) {
    case "table": return `\n\n${table(n, ctx)}\n\n`;
    case "ul":
    case "ol": return `\n\n${list(n, ctx, 0)}\n\n`;
    case "hr": return "\n\n---\n\n";
    case "pre": {
      const t = textContent(n).replace(/\n+$/, "");
      return t.trim() ? `\n\n\`\`\`\n${t.replace(/```/g, "'''")}\n\`\`\`\n\n` : "";
    }
    case "blockquote": {
      const inner = cleanLines(children(n, ctx, depth));
      return inner ? `\n\n${inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n` : "";
    }
    default:
      if (BLOCK.has(n.tag) || n.tag === "#root") return `\n\n${children(n, ctx, depth)}\n\n`;
      return inline(n, ctx);
  }
}

/** Children of a block: runs of inline content become one paragraph; block children render on their own. */
function children(n: Node, ctx: Ctx, depth: number): string {
  const parts: string[] = [];
  let run = "";
  const flush = () => { const t = cleanLines(run); if (t) parts.push(t); run = ""; };
  for (const c of n.children) {
    if (BLOCK.has(c.tag) || c.tag === "#root") { flush(); const b = block(c, ctx, depth).trim(); if (b) parts.push(b); }
    else run += inline(c, ctx);
  }
  flush();
  return parts.join("\n\n");
}

function textContent(n: Node): string {
  if (n.tag === "#text") return n.text ?? "";
  if (n.tag === "br") return "\n";
  return n.children.map(textContent).join("");
}

function findTitle(n: Node): string {
  if (n.tag === "title") return collapse(textContent(n)).trim();
  for (const c of n.children) { const t = findTitle(c); if (t) return t; }
  return "";
}

/** Convert an HTML page to markdown (deterministic). `baseUrl` resolves relative links. */
export function htmlToMarkdown(html: string, opts: { baseUrl?: string | null; maxChars?: number } = {}): HtmlMarkdown {
  const root = parseHtml(html);
  const baseTag = (function find(n: Node): string | null {
    if (n.tag === "base" && n.attrs.href) return n.attrs.href;
    for (const c of n.children) { const b = find(c); if (b) return b; }
    return null;
  })(root);
  let base: string | null = opts.baseUrl ?? null;
  if (baseTag) { try { base = new URL(baseTag, base ?? undefined).toString(); } catch { /* keep */ } }
  const ctx: Ctx = { base, links: [], seen: new Set() };
  const title = findTitle(root);
  let md = children(root, ctx, 0).replace(/\n{3,}/g, "\n\n").trim();
  if (opts.maxChars && md.length > opts.maxChars) md = md.slice(0, opts.maxChars);
  return { title, markdown: md, links: ctx.links };
}
