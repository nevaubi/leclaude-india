/**
 * Complete OOXML package for documents created in the app: document, styles, numbering, settings, fonts,
 * footer (PAGE field), footnotes/endnotes, comments, core/app properties and media — written directly.
 */
import JSZip from "jszip";
import type { PMNode } from "../doc-model";
import type { DocSettings } from "../constants";
import { appAbstractNumXml, appFontTableXml, appFooterXml, appPropsXml, appSettingsXml, appStyleDefs, appStylesXml, commentsPartXml, coreXml, initialsOf, listRefFor, mergeSectionSpec, notesPartXml, numXml, sectPrInnerXml, APP_LIST_REFS, type AppListRef, type CommentOut, type SectionSpec } from "./app-parts";
import { CT_CUSTOM_PROPS, CUSTOM_PROPS_PATH, customPropsXml, REL_CUSTOM_PROPS, type CustomProp } from "./custom-props";
import { CT, REL, serializeContentTypes, serializeRels, type Rel } from "./package";
import { commentSpans, writeBlocks, type CommentAllocator, type ExportImageData, type NoteAllocator, type NumAllocator, type RelAllocator, type StyleResolver, type WriterEnv } from "./writer";
import { WORD_NS_DECLS, XML_DECL } from "./xml";

export interface CommentInput {
  /** Comment mark id in the document (or "anchor:<blockId>" for paragraph-anchored comments). */
  key: string;
  author: string;
  date: string;
  text: string;
  initials?: string;
  resolved?: boolean;
  /** w:id of an imported comment. */
  sourceId?: string;
  /** Block id the comment is anchored to (used when its range mark is missing). */
  anchor?: string;
}

export interface WriteOptions {
  title: string;
  settings: DocSettings;
  author: string;
  changes: "revisions" | "accepted";
  comments: CommentInput[];
  images: Map<string, ExportImageData | null>;
  /** Custom file properties (docProps/custom.xml), e.g. export provenance. Omitted or empty: no custom part. */
  customProps?: CustomProp[];
}

/** Comments whose range mark is not in the document are anchored to their paragraph: wrap its text in a mark. */
export function anchorOrphanComments(doc: PMNode, comments: CommentInput[]): { doc: PMNode; comments: CommentInput[] } {
  const markIds = new Set<string>();
  const walk = (n: PMNode) => { for (const m of n.marks ?? []) if (m.type === "comment") markIds.add(String(m.attrs?.id ?? "")); for (const c of n.content ?? []) walk(c); };
  walk(doc);
  const out: CommentInput[] = [];
  const wrapIds = new Map<string, string>();
  for (const c of comments) {
    if (markIds.has(c.key)) { out.push(c); continue; }
    if (!c.anchor) continue;
    const key = `anchor:${c.anchor}:${c.key}`;
    wrapIds.set(c.anchor, key);
    out.push({ ...c, key });
  }
  if (!wrapIds.size) return { doc, comments: out };
  const byAnchor = new Map<string, string[]>();
  for (const c of out) if (c.key.startsWith("anchor:")) { const a = c.key.split(":")[1]; byAnchor.set(a, [...(byAnchor.get(a) ?? []), c.key]); }
  const wrap = (n: PMNode): PMNode => {
    const keys = byAnchor.get(String(n.attrs?.id ?? ""));
    if (keys && (n.type === "paragraph" || n.type === "heading") && n.content?.some((c) => c.type === "text")) {
      return { ...n, content: n.content.map((c) => (c.type === "text" ? { ...c, marks: [...(c.marks ?? []), ...keys.map((k) => ({ type: "comment", attrs: { id: k } }))] } : c)) };
    }
    return n.content ? { ...n, content: n.content.map(wrap) } : n;
  };
  return { doc: wrap(doc), comments: out };
}

function hasField(doc: PMNode, re: RegExp): boolean {
  let hit = false;
  const walk = (n: PMNode) => { if (hit) return; if (n.type === "docxInline" && n.attrs?.kind === "fieldBegin" && re.test(String(n.attrs.instr ?? ""))) hit = true; for (const c of n.content ?? []) walk(c); };
  walk(doc);
  return hit;
}

export async function exportFresh(doc: PMNode, o: WriteOptions): Promise<Buffer> {
  const settings = o.settings;
  const styleDefs = appStyleDefs(settings);
  const rels: Rel[] = [
    { id: "rId1", type: REL.styles, target: "styles.xml", external: false },
    { id: "rId2", type: REL.settings, target: "settings.xml", external: false },
    { id: "rId3", type: REL.fontTable, target: "fontTable.xml", external: false },
    { id: "rId4", type: REL.numbering, target: "numbering.xml", external: false },
  ];
  let relN = 4;
  const media: { path: string; bytes: Uint8Array; ext: string }[] = [];
  const hyperlinks = new Map<string, string>();
  const relAlloc: RelAllocator = {
    hyperlink(url) { let id = hyperlinks.get(url); if (!id) { id = `rId${++relN}`; hyperlinks.set(url, id); rels.push({ id, type: REL.hyperlink, target: url, external: true }); } return id; },
    image(img) {
      const ext = img.type === "jpg" ? "jpeg" : img.type;
      const path = `media/image${media.length + 1}.${ext}`;
      media.push({ path: `word/${path}`, bytes: img.bytes, ext });
      const id = `rId${++relN}`;
      rels.push({ id, type: REL.image, target: path, external: false });
      return id;
    },
  };
  // Numbering: one abstractNum per list kind used; one w:num per list (restarting) unless it continues the previous.
  // Every app list definition is written (so Word users can keep using them); w:num instances are per list.
  const abstractIds = new Map<AppListRef, number>(APP_LIST_REFS.map((r, i) => [r, i]));
  const nums: { numId: number; abstractId: number; start: { ilvl: number; start: number } | null }[] = [];
  const listNum = new WeakMap<PMNode, string>();
  const lastByRef = new Map<AppListRef, string>();
  const refOfNum = new Map<string, AppListRef>();
  const numAlloc: NumAllocator = {
    forList(list, ilvl, parentNumId) {
      const memo = listNum.get(list);
      if (memo) return memo;
      const ref = listRefFor(list);
      let numId: string;
      const d = (list.attrs?.docx ?? {}) as Record<string, unknown>;
      if (parentNumId && refOfNum.get(parentNumId) === ref) numId = parentNumId;
      else if (d.continue && lastByRef.has(ref)) numId = lastByRef.get(ref)!;
      else {
        if (!abstractIds.has(ref)) abstractIds.set(ref, abstractIds.size);
        const id = nums.length + 1;
        const start = list.type === "orderedList" ? Number(list.attrs?.start ?? 1) || 1 : 1;
        nums.push({ numId: id, abstractId: abstractIds.get(ref)!, start: { ilvl, start } });
        numId = String(id);
      }
      refOfNum.set(numId, ref);
      if (!parentNumId) lastByRef.set(ref, numId);
      listNum.set(list, numId);
      return numId;
    },
  };
  const prepared = anchorOrphanComments(doc, o.comments.filter((c) => !c.resolved));
  const commentIds = new Map<string, number>();
  const commentOut: CommentOut[] = [];
  const spans = commentSpans(prepared.doc);
  for (const c of prepared.comments) {
    if (!spans.has(c.key) || commentIds.has(c.key)) continue;
    const id = commentOut.length;
    commentIds.set(c.key, id);
    commentOut.push({ id, author: c.author, date: c.date.replace(/\.\d{3}Z$/, "Z"), initials: c.initials ?? initialsOf(c.author), text: c.text });
  }
  const commentAlloc: CommentAllocator = { idFor: (k) => commentIds.get(k) ?? null };
  const notes = { footnote: new Map<string, { id: number; text: string }>(), endnote: new Map<string, { id: number; text: string }>() };
  const noteAlloc: NoteAllocator = {
    ref(attrs) {
      const kind = attrs.kind === "endnote" ? "endnote" : "footnote";
      const key = String(attrs.id ?? "");
      let n = notes[kind].get(key);
      if (!n) { n = { id: notes[kind].size + 1, text: String(attrs.text ?? "") }; notes[kind].set(key, n); }
      return { kind, id: n.id };
    },
  };
  const styles: StyleResolver = {
    paragraph(node, role) {
      if (node.type === "heading") return node.attrs?.pStyle === "title" ? "Title" : `Heading${Math.max(1, Math.min(6, Number(node.attrs?.level ?? 1)))}`;
      if (role === "quote") return "Quote";
      if (node.attrs?.pStyle === "caption") return "Caption";
      if (node.attrs?.pStyle === "title") return "Title";
      const sid = node.attrs?.styleId ? String(node.attrs.styleId) : null;
      if (sid && styleDefs[sid] && !/^Heading\d$|^Title$/.test(sid)) return sid;
      return null;
    },
    has: (id) => Boolean(styleDefs[id]),
    character: (kind) => ({ footnoteReference: "FootnoteReference", endnoteReference: "EndnoteReference", hyperlink: "Hyperlink", commentReference: "CommentReference" })[kind],
  };
  let footerRid: string | null = null;
  if (settings.pageNumbers) { footerRid = `rId${++relN}`; rels.push({ id: footerRid, type: REL.footer, target: "footer1.xml", external: false }); }
  let annot = 0;
  let drawing = 0;
  // Sections: the document settings describe the first section; each break's `section` is the setup after it.
  let currentSection: SectionSpec | null = null;
  const env: WriterEnv = {
    mode: "fresh", author: o.author, changes: o.changes, settings, styles, rels: relAlloc, numbering: numAlloc, comments: commentAlloc, notes: noteAlloc, images: o.images,
    nextId: () => ++annot, nextDrawingId: () => ++drawing,
    sectionBreak: (next) => {
      const xml = `<w:sectPr>${sectPrInnerXml(settings, currentSection, footerRid)}</w:sectPr>`;
      currentSection = mergeSectionSpec(currentSection, next as SectionSpec);
      return xml;
    },
    bookmarkIds: new Map(), commentSpan: spans, lineDefault: settings.lineSpacing, warnings: [],
  };
  const body = writeBlocks(prepared.doc.content ?? [], env, { topLevel: true });
  const documentXml = `${XML_DECL}<w:document ${WORD_NS_DECLS}><w:body>${body}<w:sectPr>${sectPrInnerXml(settings, currentSection, footerRid)}</w:sectPr></w:body></w:document>`;

  const zip = new JSZip();
  const ct = { defaults: { rels: CT.rels, xml: "application/xml", png: "image/png", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" } as Record<string, string>, overrides: {
    "word/document.xml": CT.document, "word/styles.xml": CT.styles, "word/settings.xml": CT.settings, "word/fontTable.xml": CT.fontTable, "word/numbering.xml": CT.numbering,
    "docProps/core.xml": CT.core, "docProps/app.xml": CT.app,
  } as Record<string, string> };
  const hasFootnotes = notes.footnote.size > 0, hasEndnotes = notes.endnote.size > 0;
  if (hasFootnotes) { rels.push({ id: `rId${++relN}`, type: REL.footnotes, target: "footnotes.xml", external: false }); ct.overrides["word/footnotes.xml"] = CT.footnotes; zip.file("word/footnotes.xml", notesPartXml("footnote", Array.from(notes.footnote.values()))); }
  if (hasEndnotes) { rels.push({ id: `rId${++relN}`, type: REL.endnotes, target: "endnotes.xml", external: false }); ct.overrides["word/endnotes.xml"] = CT.endnotes; zip.file("word/endnotes.xml", notesPartXml("endnote", Array.from(notes.endnote.values()))); }
  if (commentOut.length) { rels.push({ id: `rId${++relN}`, type: REL.comments, target: "comments.xml", external: false }); ct.overrides["word/comments.xml"] = CT.comments; zip.file("word/comments.xml", commentsPartXml(commentOut)); }
  if (footerRid) { ct.overrides["word/footer1.xml"] = CT.footer; zip.file("word/footer1.xml", appFooterXml()); }
  const abstractXml = APP_LIST_REFS.filter((r) => abstractIds.has(r)).map((r) => appAbstractNumXml(r, abstractIds.get(r)!)).join("");
  // Keep the numbering part valid even with no lists (Word accepts an empty w:numbering).
  const numberingXml = `${XML_DECL}<w:numbering ${WORD_NS_DECLS}>${abstractXml}${nums.map((n) => numXml(n.numId, n.abstractId, n.start)).join("")}</w:numbering>`;
  const pkgRels: Rel[] = [
    { id: "rId1", type: REL.officeDocument, target: "word/document.xml", external: false },
    { id: "rId2", type: REL.coreProps, target: "docProps/core.xml", external: false },
    { id: "rId3", type: REL.extendedProps, target: "docProps/app.xml", external: false },
  ];
  if (o.customProps?.length) {
    pkgRels.push({ id: "rId4", type: REL_CUSTOM_PROPS, target: CUSTOM_PROPS_PATH, external: false });
    ct.overrides[CUSTOM_PROPS_PATH] = CT_CUSTOM_PROPS;
    zip.file(CUSTOM_PROPS_PATH, customPropsXml(o.customProps));
  }
  zip.file("_rels/.rels", serializeRels(pkgRels));
  zip.file("[Content_Types].xml", serializeContentTypes(ct));
  zip.file("word/document.xml", documentXml);
  zip.file("word/_rels/document.xml.rels", serializeRels(rels));
  zip.file("word/styles.xml", appStylesXml(settings));
  zip.file("word/settings.xml", appSettingsXml({ footnotes: hasFootnotes, endnotes: hasEndnotes, updateFields: hasField(prepared.doc, /\b(TOC|REF|PAGEREF|NUMPAGES)\b/) || hasDirtyField(prepared.doc) }));
  zip.file("word/fontTable.xml", appFontTableXml(settings));
  zip.file("word/numbering.xml", numberingXml);
  zip.file("docProps/core.xml", coreXml(o.title, o.author));
  zip.file("docProps/app.xml", appPropsXml());
  for (const m of media) zip.file(m.path, m.bytes);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function hasDirtyField(doc: PMNode): boolean {
  let hit = false;
  const walk = (n: PMNode) => { if (n.type === "docxInline" && n.attrs?.dirty) hit = true; for (const c of n.content ?? []) walk(c); };
  walk(doc);
  return hit;
}
