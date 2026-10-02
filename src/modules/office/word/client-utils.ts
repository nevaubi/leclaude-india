"use client";
/** Browser-only helpers: mermaid → PNG blob, print-to-PDF window, downloads. */
import { nanoid } from "nanoid";
import { FONT_FAMILIES, MARGIN_PRESETS, PAGE_SIZES, type DocSettings } from "./constants";
import { collectFootnotes, docToMarkdown, docToPlainText, type PMNode } from "./doc-model";

export async function renderMermaidToSvg(source: string): Promise<string> {
  const mod = await import("mermaid");
  const mermaid = mod.default;
  const dark = document.documentElement.classList.contains("dark");
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "loose", fontFamily: "Inter Variable, system-ui, sans-serif" });
  const { svg } = await mermaid.render(`mmd-${nanoid(6)}`, source);
  return svg;
}

/** Render Mermaid → PNG (2× scale) → upload to /api/blobs → url. Falls back to an SVG data URL. */
export async function renderMermaidToImageUrl(source: string): Promise<string> {
  const svg = await renderMermaidToSvg(source);
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("svg load failed")); img.src = svgDataUrl; });
    const w = Math.max(200, img.naturalWidth || 800), h = Math.max(120, img.naturalHeight || 500);
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale; canvas.height = h * scale;
    const cx = canvas.getContext("2d");
    if (!cx) throw new Error("no canvas");
    cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, canvas.width, canvas.height);
    cx.scale(scale, scale);
    cx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("toBlob failed");
    const url = await uploadBlob(blob, `diagram-${Date.now()}.png`);
    return url;
  } catch {
    return svgDataUrl;
  }
}

export async function uploadBlob(blob: Blob, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new File([blob], name, { type: blob.type || "application/octet-stream" }));
  const res = await fetch("/api/blobs", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const j = (await res.json()) as { url: string };
  return j.url;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFilename(title: string) { return (title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "document"); }

export function downloadMarkdown(doc: PMNode, title: string) { downloadBlob(new Blob([docToMarkdown(doc, { title })], { type: "text/markdown;charset=utf-8" }), `${safeFilename(title)}.md`); }
export function downloadText(doc: PMNode, title: string) { downloadBlob(new Blob([docToPlainText(doc)], { type: "text/plain;charset=utf-8" }), `${safeFilename(title)}.txt`); }

/** Export provenance options for POST /api/office/word/export (see that route). */
export interface ExportProvenanceRequest {
  declaration?: { text: string } | null;
  appendix?: boolean;
  acknowledgement?: { acknowledged: boolean; docHash: string; items: number } | null;
}

export async function downloadDocx(body: { docId?: string; content: PMNode; title: string; settings: DocSettings; changes?: "revisions" | "accepted"; provenance?: ExportProvenanceRequest }) {
  const res = await fetch("/api/office/word/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, format: "docx" }) });
  if (!res.ok) { const j = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string }; throw new Error(j.error ?? res.statusText); }
  downloadBlob(await res.blob(), `${safeFilename(body.title)}.docx`);
}

/** Print-to-PDF: open a print window with the rendered HTML and a paged stylesheet. */
export function printDocument(html: string, doc: PMNode, title: string, settings: DocSettings) {
  const size = PAGE_SIZES[settings.pageSize];
  const m = MARGIN_PRESETS[settings.margins];
  const font = FONT_FAMILIES.find((f) => f.id === settings.font) ?? FONT_FAMILIES[0];
  const fns = collectFootnotes(doc);
  const footnotesHtml = fns.length ? `<section class="footnotes"><ol>${fns.map((f) => `<li>${escapeHtml(f.text)}</li>`).join("")}</ol></section>` : "";
  const pageCss = `@page { size: ${settings.orientation === "landscape" ? `${size.height}in ${size.width}in` : `${size.width}in ${size.height}in`}; margin: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in; ${settings.pageNumbers ? "@bottom-center { content: counter(page); font-family: serif; font-size: 10pt; }" : ""} }`;
  const css = `
    ${pageCss}
    html, body { margin: 0; padding: 0; }
    body { font-family: ${font.css}; font-size: ${settings.fontSize}pt; line-height: ${settings.lineSpacing}; color: #111; }
    p { margin: 0 0 0.75em; }
    h1, h2, h3 { line-height: 1.25; margin: 1.3em 0 0.5em; page-break-after: avoid; }
    h1 { font-size: 1.28em; } h2 { font-size: 1.14em; } h3 { font-size: 1.04em; font-style: italic; }
    [data-pstyle="title"] { font-size: 1.6em; text-align: center; }
    [data-pstyle="caption"] { font-size: 0.85em; color: #555; font-style: italic; text-align: center; }
    [data-pstyle="caption_court"] { margin-bottom: 0; }
    blockquote { margin: 0.6em 0 1em; padding-left: 1.2em; border-left: 3px solid #bbb; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1em; page-break-inside: auto; }
    td, th { border: 1px solid #999; padding: 4pt 6pt; vertical-align: top; }
    th { background: #eee; }
    table[data-caption="true"] td { border: 0; }
    table[data-caption="true"] td:first-child { border-right: 1px solid #111; border-bottom: 1px solid #111; }
    ul, ol { padding-left: 1.6em; }
    ol[data-list-style="legal"] { list-style: none; counter-reset: legal; padding-left: 0; }
    ol[data-list-style="legal"] > li { counter-increment: legal; padding-left: 2.6em; position: relative; }
    ol[data-list-style="legal"] > li::before { content: counters(legal, ".") "."; position: absolute; left: 0; font-weight: 600; }
    ol[data-list-style="legal"] ol { list-style: none; counter-reset: legal; padding-left: 0; }
    ol[data-list-style="legal"] ol > li { counter-increment: legal; padding-left: 3.2em; }
    ol[data-list-style="legal"] ol > li::before { content: counters(legal, "."); }
    ol[data-list-style="outline"] { list-style: none; counter-reset: o1; padding-left: 0; }
    ol[data-list-style="outline"] > li { counter-increment: o1; padding-left: 2.4em; position: relative; }
    ol[data-list-style="outline"] > li::before { content: counter(o1) "."; position: absolute; left: 0; }
    ol[data-list-style="outline"] > li > ol { list-style: none; counter-reset: o2; padding-left: 0; }
    ol[data-list-style="outline"] > li > ol > li { counter-increment: o2; padding-left: 2.4em; position: relative; }
    ol[data-list-style="outline"] > li > ol > li::before { content: "(" counter(o2, lower-alpha) ")"; position: absolute; left: 0; }
    img { max-width: 100%; }
    img[data-align="center"] { display: block; margin: 0.5em auto; }
    .page-break { page-break-after: always; height: 0; }
    .page-break span { display: none; }
    del.tc-del { display: none; }
    ins.tc-ins { text-decoration: none; }
    .comment-mark { background: transparent; }
    .pn-gutter, .fn-ref-hidden { display: none; }
    .fn-anchor::after { content: counter(fn); counter-increment: fn; font-size: 0.7em; vertical-align: super; }
    body { counter-reset: fn; }
    .footnotes { border-top: 1px solid #999; margin-top: 2em; padding-top: 0.6em; font-size: 0.82em; }
    a { color: #1f4e9a; }
    [data-indent="1"] { margin-left: 0.5in; } [data-indent="2"] { margin-left: 1in; } [data-indent="3"] { margin-left: 1.5in; } [data-indent="4"] { margin-left: 2in; }
    [style*="text-align: center"], [data-align="center"] { text-align: center; }
  `;
  const w = window.open("", "_blank", "width=900,height=1100");
  if (!w) throw new Error("Pop-up blocked: allow pop-ups to print");
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${html.replace(/<sup class="fn-ref"[^>]*>[^<]*<\/sup>/g, "")}${footnotesHtml}<script>window.addEventListener('load',()=>{setTimeout(()=>{window.focus();window.print();},250);});</script></body></html>`);
  w.document.close();
}

function escapeHtml(s: string) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c); }

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const d = ((...args: Parameters<T>) => { if (timer) clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }) as T & { cancel: () => void };
  d.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return d;
}
