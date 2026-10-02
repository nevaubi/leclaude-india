/**
 * Package-preserving export for imported .docx files.
 *
 * The original package is re-read (deterministically) to recover the pristine document and the raw source of
 * every block. Blocks the user did not change are re-emitted byte-for-byte; changed blocks are regenerated with
 * their original properties merged in. Only document.xml and the parts that actually need new content
 * (comments, notes, numbering, styles, relationships, content types, new media) are rewritten — styles, theme,
 * settings, headers/footers, custom XML and unknown parts are copied byte-identical.
 */
import JSZip from "jszip";
import type { PMNode } from "../doc-model";
import type { DocSettings } from "../constants";
import { MARGIN_PRESETS, PAGE_SIZES } from "../constants";
import { appAbstractNumXml, appStyleDefs, commentXml, initialsOf, listRefFor, mergeSectionSpec, noteXml, numXml, patchSectPr, sectPrInnerXml, type AppListRef, type SectionSpec } from "./app-parts";
import { canonKey, hasTrackedMarks } from "./canon";
import { anchorOrphanComments, type CommentInput } from "./fresh";
import { CT_CUSTOM_PROPS, CUSTOM_PROPS_PATH, customPropsXml, REL_CUSTOM_PROPS, type CustomProp } from "./custom-props";
import { CT, IMAGE_MIME, nextRelId, parseRels, REL, relatedPart, relsPathFor, resolveTarget, serializeContentTypes, serializeRels, type Rel } from "./package";
import { readDocx, type ReadResult } from "./reader";
import { commentSpans, writeBlocks, type CommentAllocator, type ExportImageData, type NoteAllocator, type NumAllocator, type PristineIndex, type RelAllocator, type StyleResolver, type WriterEnv } from "./writer";
import { attr, kids, parseXml, XML_DECL, NS, type XEl } from "./xml";
import { notePlainText } from "./reader";

export interface PreserveOptions {
  settings: DocSettings;
  author: string;
  changes: "revisions" | "accepted";
  comments: CommentInput[];
  images: Map<string, ExportImageData | null>;
  /** Must match the importer's image src mapping so image nodes compare equal. */
  imageSrc: (bytes: Uint8Array, mime: string, name: string, sha256: string) => string;
  /** Custom file properties to set (LeClaude-owned ones are replaced; the package's other custom properties are kept). */
  customProps?: CustomProp[];
}

export interface PreserveResult { bytes: Buffer; changedParts: string[]; regeneratedBlocks: number; preservedBlocks: number; warnings: string[] }

function indexNodes(doc: PMNode): Map<string, PMNode> {
  const out = new Map<string, PMNode>();
  const walk = (n: PMNode) => { const id = n.attrs?.id; if (typeof id === "string" && id) out.set(id, n); for (const c of n.content ?? []) walk(c); };
  walk(doc);
  return out;
}

function styleOutline(styles: Map<string, { basedOn?: string; outline?: number; type: string; name: string }>, id: string): number | undefined {
  const seen = new Set<string>();
  let cur = styles.get(id);
  while (cur && !seen.has(id)) {
    if (cur.outline !== undefined) return cur.outline;
    seen.add(id);
    if (!cur.basedOn) break;
    id = cur.basedOn;
    cur = styles.get(id);
  }
  return undefined;
}

/** Replace pgSz/pgMar values in a section when the document-level page setup changed after import. */
function patchSections(xml: string, before: DocSettings, after: DocSettings): string {
  const sizeChanged = before.pageSize !== after.pageSize, orientChanged = before.orientation !== after.orientation, marginsChanged = before.margins !== after.margins;
  if (!sizeChanged && !orientChanged && !marginsChanged) return xml;
  const size = PAGE_SIZES[after.pageSize] ?? PAGE_SIZES.letter;
  const m = MARGIN_PRESETS[after.margins] ?? MARGIN_PRESETS.normal;
  return xml.replace(/<w:pgSz\b[^>]*\/>/g, (tag) => {
    const w = Number(/w:w="(\d+)"/.exec(tag)?.[1] ?? 12240), h = Number(/w:h="(\d+)"/.exec(tag)?.[1] ?? 15840);
    let land = /w:orient="landscape"/.test(tag) || w > h;
    if (orientChanged) land = after.orientation === "landscape";
    let W = Math.min(w, h), H = Math.max(w, h);
    if (sizeChanged) { W = Math.round(size.width * 1440); H = Math.round(size.height * 1440); }
    const [nw, nh] = land ? [H, W] : [W, H];
    return `<w:pgSz w:w="${nw}" w:h="${nh}"${land ? ` w:orient="landscape"` : ""}/>`;
  }).replace(/<w:pgMar\b[^>]*\/>/g, (tag) => {
    if (!marginsChanged) return tag;
    const set = (t: string, k: string, v: number) => (new RegExp(`w:${k}="-?\\d+"`).test(t) ? t.replace(new RegExp(`w:${k}="-?\\d+"`), `w:${k}="${v}"`) : t.replace(/\/>$/, ` w:${k}="${v}"/>`));
    let t = tag;
    t = set(t, "top", Math.round(m.top * 1440)); t = set(t, "right", Math.round(m.right * 1440)); t = set(t, "bottom", Math.round(m.bottom * 1440)); t = set(t, "left", Math.round(m.left * 1440));
    return t;
  });
}

function settingsEqual(a: Record<string, unknown>, b: DocSettings) { return a.pageSize === b.pageSize && a.orientation === b.orientation && a.margins === b.margins; }

/** Insert XML before the closing tag of a part's root element. */
function appendToRoot(xml: string, rootName: string, insert: string): string {
  const close = `</${rootName}>`;
  const i = xml.lastIndexOf(close);
  if (i >= 0) return xml.slice(0, i) + insert + xml.slice(i);
  // self-closing empty root
  return xml.replace(new RegExp(`<${rootName}([^>]*)/>`), `<${rootName}$1>${insert}${close}`);
}

export async function exportPreserving(doc: PMNode, base: Uint8Array, o: PreserveOptions): Promise<PreserveResult> {
  const read: ReadResult = await readDocx(base, { storeImage: o.imageSrc });
  const { pkg } = read;
  const main = pkg.mainPart;
  const warnings: string[] = [];
  const pristineNodes = indexNodes(read.doc);
  const canonCache = new Map<string, string>();
  const pristineCanon = (id: string) => { let k = canonCache.get(id); if (k === undefined) { const n = pristineNodes.get(id); k = n ? canonKey(n) : ""; canonCache.set(id, k); } return k; };
  let preserved = 0, regenerated = 0;
  const pristine: PristineIndex = {
    raw(node, listContext) {
      const id = String(node.attrs?.id ?? "");
      const src = read.raw.blocks.get(id);
      if (!src) { if (["paragraph", "heading", "table", "image"].includes(node.type)) regenerated++; return null; }
      if (o.changes === "accepted" && hasTrackedMarks(node)) { regenerated++; return null; }
      if (canonKey(node) !== pristineCanon(id)) { regenerated++; return null; }
      const expected = read.raw.listContext.get(id) ?? null;
      const cur = listContext ?? null;
      if ((expected?.numId ?? null) !== (cur?.numId ?? null) || (expected?.ilvl ?? null) !== (cur?.ilvl ?? null)) { regenerated++; return null; }
      preserved++;
      return src;
    },
    sdtStart: (id) => read.raw.sdt.get(id) ?? null,
    lead: (id) => read.raw.lead.get(id) ?? null,
    imageSrc: (id) => { const n = pristineNodes.get(id); return n?.type === "image" ? String(n.attrs?.src ?? "") : null; },
  };

  // ---- relationships -------------------------------------------------------------------------------------
  const rels: Rel[] = pkg.rels(main).map((r) => ({ ...r }));
  let relsChanged = false;
  const newFiles = new Map<string, Uint8Array | string>();
  const ct = { defaults: { ...pkg.contentTypes.defaults }, overrides: { ...pkg.contentTypes.overrides } };
  let ctChanged = false;
  const relAlloc: RelAllocator = {
    hyperlink(url) {
      const hit = rels.find((r) => r.type === REL.hyperlink && r.external && r.target === url);
      if (hit) return hit.id;
      const id = nextRelId(rels); rels.push({ id, type: REL.hyperlink, target: url, external: true }); relsChanged = true; return id;
    },
    image(img) {
      const ext = img.type === "jpg" ? "jpeg" : img.type;
      let n = 1; while (pkg.files.has(`word/media/lc_image${n}.${ext}`) || newFiles.has(`word/media/lc_image${n}.${ext}`)) n++;
      const path = `word/media/lc_image${n}.${ext}`;
      newFiles.set(path, img.bytes);
      if (!ct.defaults[ext]) { ct.defaults[ext] = IMAGE_MIME[ext] ?? "application/octet-stream"; ctChanged = true; }
      const id = nextRelId(rels);
      const mainDir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
      rels.push({ id, type: REL.image, target: path.startsWith(mainDir) ? path.slice(mainDir.length) : `/${path}`, external: false });
      relsChanged = true;
      return id;
    },
  };
  const ensurePart = (type: string, defaultPath: string, contentType: string, emptyXml: string): { path: string; xml: string; created: boolean } => {
    const existing = relatedPart(pkg, main, type);
    if (existing && pkg.files.has(existing)) return { path: existing, xml: pkg.text(existing)!, created: false };
    const id = nextRelId(rels);
    rels.push({ id, type, target: defaultPath.replace(/^word\//, ""), external: false });
    relsChanged = true;
    ct.overrides[defaultPath] = contentType; ctChanged = true;
    return { path: defaultPath, xml: emptyXml, created: true };
  };

  // ---- styles ------------------------------------------------------------------------------------------------
  const stylesById = new Map(read.meta.styles.map((s) => [s.id, { basedOn: s.basedOn, outline: s.outlineLevel, type: s.type, name: s.name }]));
  const appDefs = appStyleDefs(o.settings);
  const injectStyles = new Set<string>();
  const need = (id: string) => { if (!stylesById.has(id) && appDefs[id]) injectStyles.add(id); return id; };
  const findByName = (name: string) => read.meta.styles.find((s) => s.name.toLowerCase() === name)?.id ?? null;
  const styles: StyleResolver = {
    paragraph(node, role) {
      const sid = node.attrs?.styleId ? String(node.attrs.styleId) : null;
      if (node.type === "heading") {
        const level = Math.max(1, Math.min(9, Number(node.attrs?.level ?? 1)));
        if (node.attrs?.pStyle === "title") return sid && stylesById.has(sid) ? sid : (stylesById.has("Title") ? "Title" : need("Title"));
        if (sid && stylesById.has(sid) && styleOutline(stylesById, sid) === level - 1) return sid;
        const byId = `Heading${level}`;
        if (stylesById.has(byId)) return byId;
        return findByName(`heading ${level}`) ?? need(byId);
      }
      if (sid && stylesById.has(sid)) { const ol = styleOutline(stylesById, sid); if (ol === undefined || ol > 5) return sid; }
      if (role === "quote") return stylesById.has("Quote") ? "Quote" : (findByName("quote") ?? need("Quote"));
      if (node.attrs?.pStyle === "caption") return stylesById.has("Caption") ? "Caption" : (findByName("caption") ?? need("Caption"));
      if (node.attrs?.pStyle === "title") return stylesById.has("Title") ? "Title" : need("Title");
      return null;
    },
    has: (id) => stylesById.has(id),
    character(kind) {
      const id = { footnoteReference: "FootnoteReference", endnoteReference: "EndnoteReference", hyperlink: "Hyperlink", commentReference: "CommentReference" }[kind];
      if (stylesById.has(id)) return id;
      return findByName({ footnoteReference: "footnote reference", endnoteReference: "endnote reference", hyperlink: "hyperlink", commentReference: "annotation reference" }[kind]);
    },
  };

  // ---- numbering ----------------------------------------------------------------------------------------------
  const numInfo = new Map(read.meta.numbering.map((n) => [n.numId, n]));
  let maxNumId = Math.max(0, ...read.meta.numbering.map((n) => Number(n.numId) || 0));
  let maxAbstract = Math.max(-1, ...read.meta.numbering.map((n) => Number(n.abstractId) || 0));
  const numberingPart = relatedPart(pkg, main, REL.numbering);
  if (numberingPart && pkg.text(numberingPart)) {
    const { root } = parseXml(pkg.text(numberingPart)!);
    for (const a of kids(root, "w:abstractNum")) maxAbstract = Math.max(maxAbstract, Number(attr(a, "w:abstractNumId")) || 0);
    for (const n of kids(root, "w:num")) maxNumId = Math.max(maxNumId, Number(attr(n, "w:numId")) || 0);
  }
  const newAbstracts: string[] = [];
  const newNums: string[] = [];
  const appAbstract = new Map<AppListRef, number>();
  const listMemo = new WeakMap<PMNode, string>();
  const lastByRef = new Map<AppListRef, string>();
  const appNumKinds = new Map<string, AppListRef>();
  const fmtAt = (numId: string, ilvl: number) => numInfo.get(numId)?.levels.find((l) => l.ilvl === ilvl)?.format ?? (appNumKinds.get(numId) === "bullets" ? "bullet" : appNumKinds.has(numId) ? "decimal" : undefined);
  const newNum = (abstractId: string | number, start: { ilvl: number; start: number } | null) => { const id = String(++maxNumId); newNums.push(numXml(id, abstractId, start)); return id; };
  const numAlloc: NumAllocator = {
    forList(list, ilvl, parentNumId) {
      const memo = listMemo.get(list);
      if (memo) return memo;
      const d = (list.attrs?.docx ?? {}) as Record<string, unknown>;
      const wantBullet = list.type !== "orderedList";
      const kindOk = (numId: string) => { const f = fmtAt(numId, ilvl); return f === undefined ? true : (f === "bullet") === wantBullet; };
      const start = list.type === "orderedList" ? Number(list.attrs?.start ?? 1) || 1 : 1;
      let numId: string;
      const docxNum = d.numId ? String(d.numId) : null;
      if (docxNum && numInfo.has(docxNum) && kindOk(docxNum)) {
        const startChanged = list.type === "orderedList" && d.importStart != null && start !== Number(d.importStart);
        numId = startChanged || d.restart ? newNum(numInfo.get(docxNum)!.abstractId, { ilvl, start }) : docxNum;
      } else if (parentNumId && kindOk(parentNumId)) numId = parentNumId;
      else {
        const ref = listRefFor(list);
        if (d.continue && lastByRef.has(ref)) numId = lastByRef.get(ref)!;
        else {
          if (!appAbstract.has(ref)) { const aid = ++maxAbstract; appAbstract.set(ref, aid); newAbstracts.push(appAbstractNumXml(ref, aid)); }
          numId = newNum(appAbstract.get(ref)!, { ilvl, start });
          appNumKinds.set(numId, ref);
        }
        lastByRef.set(ref, numId);
      }
      listMemo.set(list, numId);
      return numId;
    },
  };

  // ---- comments ------------------------------------------------------------------------------------------------
  const commentsPath = relatedPart(pkg, main, REL.comments);
  const commentsXml = commentsPath ? pkg.text(commentsPath) : null;
  const origComments = new Map<string, { el: XEl; text: string; src: string; paraId?: string }>();
  let maxCommentId = -1;
  if (commentsXml) {
    const { root, src } = parseXml(commentsXml);
    for (const c of kids(root, "w:comment")) {
      const id = attr(c, "w:id") ?? "";
      maxCommentId = Math.max(maxCommentId, Number(id) || 0);
      const paras = kids(c).filter((x) => x.name === "w:p");
      origComments.set(id, { el: c, text: notePlainText(c), src, paraId: paras.length ? attr(paras[paras.length - 1], "w14:paraId") : undefined });
    }
  }
  const prepared = anchorOrphanComments(doc, o.comments.filter((c) => c.sourceId || !c.resolved));
  const spans = commentSpans(prepared.doc);
  const commentIds = new Map<string, number>();
  const commentEdits = new Map<string, string>(); // sourceId → replacement xml
  const commentAdds: string[] = [];
  const resolvedPatch = new Map<string, boolean>(); // paraId → done
  let nextComment = Math.max(maxCommentId, read.raw.maxAnnotationId) + 1;
  for (const c of prepared.comments) {
    if (commentIds.has(c.key)) continue;
    if (c.sourceId && origComments.has(c.sourceId)) {
      const orig = origComments.get(c.sourceId)!;
      commentIds.set(c.key, Number(c.sourceId));
      const w14 = commentsXml ? /xmlns:w14="/.test(commentsXml.slice(0, 2000)) : false;
      if (orig.text !== c.text.trim()) commentEdits.set(c.sourceId, commentXml({ id: Number(c.sourceId), author: c.author, date: c.date, initials: c.initials ?? initialsOf(c.author), text: c.text, paraId: w14 ? orig.paraId : undefined }, stylesById.has("CommentText")));
      if (orig.paraId) resolvedPatch.set(orig.paraId, Boolean(c.resolved));
      continue;
    }
    if (!spans.has(c.key) || c.resolved) continue;
    const id = nextComment++;
    commentIds.set(c.key, id);
    commentAdds.push(commentXml({ id, author: c.author, date: c.date.replace(/\.\d{3}Z$/, "Z"), initials: c.initials ?? initialsOf(c.author), text: c.text }, stylesById.has("CommentText")));
  }
  const commentAlloc: CommentAllocator = { idFor: (k) => commentIds.get(k) ?? null };
  const extPath = relatedPart(pkg, main, REL.commentsExtended);
  const origDone = new Map<string, boolean>();
  if (extPath && pkg.text(extPath)) for (const m of pkg.text(extPath)!.matchAll(/<w15:commentEx\b[^>]*\/>/g)) { const pid = /w15:paraId="([^"]+)"/.exec(m[0])?.[1]; if (pid) origDone.set(pid, /w15:done="1"/.test(m[0])); }
  for (const [pid, want] of Array.from(resolvedPatch)) if ((origDone.get(pid) ?? false) === want) resolvedPatch.delete(pid);

  // Nothing changed since import (and no properties to stamp): the original package is the exact answer.
  if (o.changes === "revisions" && !o.customProps?.length && !commentEdits.size && !commentAdds.length && !resolvedPatch.size && settingsEqual(read.meta.importedSettings, o.settings) && canonKey(prepared.doc) === canonKey(read.doc)) {
    return { bytes: Buffer.from(base), changedParts: [], regeneratedBlocks: 0, preservedBlocks: pristineNodes.size, warnings };
  }

  // ---- notes -----------------------------------------------------------------------------------------------------
  const noteState = (["footnote", "endnote"] as const).map((kind) => {
    const path = relatedPart(pkg, main, kind === "footnote" ? REL.footnotes : REL.endnotes);
    const xml = path ? pkg.text(path) : null;
    const orig = new Map<string, { text: string; el: XEl; src: string }>();
    let max = 0;
    if (xml) {
      const { root, src } = parseXml(xml);
      for (const n of kids(root)) {
        const id = attr(n, "w:id") ?? "";
        max = Math.max(max, Number(id) || 0);
        const t = attr(n, "w:type");
        if (!t || t === "normal") orig.set(id, { text: notePlainText(n), el: n, src });
      }
    }
    return { kind, path, xml, orig, max, byKey: new Map<string, number>(), edits: new Map<string, string>(), adds: [] as string[] };
  });
  const noteAlloc: NoteAllocator = {
    ref(attrs) {
      const kind = attrs.kind === "endnote" ? "endnote" : "footnote";
      const s = noteState[kind === "footnote" ? 0 : 1];
      const key = String(attrs.id ?? "");
      const hit = s.byKey.get(key);
      if (hit != null) return { kind, id: hit };
      const text = String(attrs.text ?? "");
      const sid = attrs.sourceId != null ? String(attrs.sourceId) : null;
      if (sid && s.orig.has(sid) && (attrs.kind ?? "footnote") === kind) {
        s.byKey.set(key, Number(sid));
        if (s.orig.get(sid)!.text !== text.trim()) s.edits.set(sid, noteXml(kind, Number(sid), text, stylesById.has(kind === "footnote" ? "FootnoteText" : "EndnoteText")));
        return { kind, id: Number(sid) };
      }
      const id = ++s.max;
      s.byKey.set(key, id);
      s.adds.push(noteXml(kind, id, text, stylesById.has(kind === "footnote" ? "FootnoteText" : "EndnoteText")));
      return { kind, id };
    },
  };

  // ---- sections ------------------------------------------------------------------------------------------------
  // Original section ends in body order (paragraph sectPrs, then the final body sectPr). A section break added in the
  // app copies the setup of the original section it falls in (headers/footers included) for the part before it; its
  // `section` (the setup after the break) is applied to that original section's end.
  const finalSect = read.raw.finalSectPr;
  const finalCanon = read.raw.finalSectPrCanon ?? finalSect;
  const originalEnds: string[] = [];
  const collectEnds = (n: PMNode) => {
    const pPr = (n.attrs?.docx as { pPr?: unknown } | undefined)?.pPr;
    if ((n.type === "paragraph" || n.type === "heading") && typeof pPr === "string") { const m = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(pPr); if (m) originalEnds.push(m[0]); }
    for (const c of n.content ?? []) collectEnds(c);
  };
  collectEnds(prepared.doc);
  let endIndex = 0;
  let pending: SectionSpec | null = null;
  const containing = () => (originalEnds[endIndex] ?? finalCanon ?? `<w:sectPr>${sectPrInnerXml(o.settings, null, null)}</w:sectPr>`).replace(/<w:sectPrChange\b[\s\S]*?<\/w:sectPrChange>/g, "");
  let annot = read.raw.maxAnnotationId + 1000;
  let drawing = 100000;
  const env: WriterEnv = {
    mode: "preserve", author: o.author, changes: o.changes, settings: o.settings, styles, rels: relAlloc, numbering: numAlloc, comments: commentAlloc, notes: noteAlloc, images: o.images,
    nextId: () => ++annot, nextDrawingId: () => ++drawing,
    sectionBreak: (next) => {
      const base = containing();
      const xml = pending ? patchSectPr(base, pending) : base;
      pending = mergeSectionSpec(pending, next as SectionSpec);
      return xml;
    },
    sectionEnd: (paragraphXml) => {
      endIndex++;
      if (!pending) return paragraphXml;
      const spec = pending;
      pending = null;
      return paragraphXml.replace(/<(\w+:)?sectPr\b[\s\S]*?<\/(\w+:)?sectPr>/, (m) => patchSectPr(m, spec));
    },
    bookmarkIds: new Map(), commentSpan: spans, lineDefault: null, warnings,
    pristine,
  };
  let body = writeBlocks(prepared.doc.content ?? [], env, { topLevel: true });
  body += read.raw.tail;
  // Page setup edited in the app applies to the final section (earlier sections keep their own setup); a section break
  // added in the app before it contributes its "after the break" setup.
  let finalXml = finalSect ?? `<w:sectPr>${sectPrInnerXml(o.settings, null, null)}</w:sectPr>`;
  if (finalSect && !settingsEqual(read.meta.importedSettings, o.settings)) finalXml = patchSections(finalXml, read.settings, o.settings);
  if (pending) finalXml = patchSectPr(finalXml, pending);
  body += finalXml;
  // Generated markup uses the standard prefixes: make sure the root declares them.
  let open = read.raw.docOpen;
  const decls: string[] = [];
  for (const p of ["w", "r", "wp", "a", "pic", "w14"] as const) if (!new RegExp(`xmlns:${p}="`).test(open)) decls.push(`xmlns:${p}="${NS[p]}"`);
  if (decls.length) open = open.replace(/<(\w+:)?document\b/, (m) => `${m} ${decls.join(" ")}`);
  const documentXml = open + body + read.raw.docClose;

  const changed = new Map<string, string | Uint8Array>();
  changed.set(main, documentXml);
  // comments part
  if (commentEdits.size || commentAdds.length) {
    const part = ensurePart(REL.comments, "word/comments.xml", CT.comments, `${XML_DECL}<w:comments xmlns:w="${NS.w}" xmlns:w14="${NS.w14}"></w:comments>`);
    let xml = part.xml;
    if (commentEdits.size && commentsXml) {
      const { root, src } = parseXml(commentsXml);
      const els = kids(root, "w:comment").filter((c) => commentEdits.has(attr(c, "w:id") ?? "")).sort((a, b) => b.start - a.start);
      xml = src;
      for (const e of els) xml = xml.slice(0, e.start) + commentEdits.get(attr(e, "w:id") ?? "")! + xml.slice(e.end);
    }
    if (commentAdds.length) xml = appendToRoot(xml, "w:comments", commentAdds.join(""));
    changed.set(part.path, xml);
  }
  // resolution state of imported comments (commentsExtended)
  if (extPath && pkg.text(extPath) && resolvedPatch.size) {
    const src = pkg.text(extPath)!;
    let touched = false;
    const out = src.replace(/<w15:commentEx\b[^>]*\/>/g, (tag) => {
      const pid = /w15:paraId="([^"]+)"/.exec(tag)?.[1];
      if (!pid || !resolvedPatch.has(pid)) return tag;
      const want = resolvedPatch.get(pid)!;
      const is = /w15:done="1"/.test(tag);
      if (want === is) return tag;
      touched = true;
      return /w15:done="[01]"/.test(tag) ? tag.replace(/w15:done="[01]"/, `w15:done="${want ? 1 : 0}"`) : tag.replace(/\/>$/, ` w15:done="${want ? 1 : 0}"/>`);
    });
    if (touched) changed.set(extPath, out);
  }
  // notes parts
  for (const s of noteState) {
    if (!s.edits.size && !s.adds.length) continue;
    const root = s.kind === "footnote" ? "w:footnotes" : "w:endnotes";
    const sep = `<w:${s.kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${s.kind}><w:${s.kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${s.kind}>`;
    const part = ensurePart(s.kind === "footnote" ? REL.footnotes : REL.endnotes, `word/${s.kind}s.xml`, s.kind === "footnote" ? CT.footnotes : CT.endnotes, `${XML_DECL}<${root} xmlns:w="${NS.w}" xmlns:r="${NS.r}">${sep}</${root}>`);
    let xml = part.xml;
    if (s.edits.size && s.xml) {
      const { root: r, src } = parseXml(s.xml);
      const els = kids(r).filter((n) => s.edits.has(attr(n, "w:id") ?? "")).sort((a, b) => b.start - a.start);
      xml = src;
      for (const e of els) xml = xml.slice(0, e.start) + s.edits.get(attr(e, "w:id") ?? "")! + xml.slice(e.end);
    }
    if (s.adds.length) xml = appendToRoot(xml, root, s.adds.join(""));
    changed.set(part.path, xml);
  }
  // numbering part
  if (newAbstracts.length || newNums.length) {
    const part = ensurePart(REL.numbering, "word/numbering.xml", CT.numbering, `${XML_DECL}<w:numbering xmlns:w="${NS.w}"></w:numbering>`);
    let xml = part.xml;
    if (newAbstracts.length) {
      const firstNum = xml.search(/<w:num\b/);
      xml = firstNum >= 0 ? xml.slice(0, firstNum) + newAbstracts.join("") + xml.slice(firstNum) : appendToRoot(xml, "w:numbering", newAbstracts.join(""));
    }
    if (newNums.length) xml = appendToRoot(xml, "w:numbering", newNums.join(""));
    changed.set(part.path, xml);
  }
  // styles the writer referenced but the package does not define
  if (injectStyles.size) {
    const part = ensurePart(REL.styles, "word/styles.xml", CT.styles, `${XML_DECL}<w:styles xmlns:w="${NS.w}"></w:styles>`);
    const deps = new Set<string>(injectStyles);
    for (const id of injectStyles) { const m = /<w:basedOn w:val="([^"]+)"/.exec(appDefs[id]); if (m && !stylesById.has(m[1]) && appDefs[m[1]]) deps.add(m[1]); }
    changed.set(part.path, appendToRoot(part.xml, "w:styles", Array.from(deps).map((id) => appDefs[id]).join("")));
  }
  // custom file properties (package-level part): merged into the existing part, or a new part related from _rels/.rels
  if (o.customProps?.length) {
    const pkgRels = parseRels(pkg.text("_rels/.rels"));
    const rel = pkgRels.find((r) => r.type === REL_CUSTOM_PROPS && !r.external);
    const path = rel ? resolveTarget("", rel.target) : CUSTOM_PROPS_PATH;
    changed.set(path, customPropsXml(o.customProps, pkg.files.has(path) ? pkg.text(path) : null));
    if (!rel) {
      pkgRels.push({ id: nextRelId(pkgRels), type: REL_CUSTOM_PROPS, target: CUSTOM_PROPS_PATH, external: false });
      changed.set("_rels/.rels", serializeRels(pkgRels));
    }
    if (ct.overrides[path] !== CT_CUSTOM_PROPS) { ct.overrides[path] = CT_CUSTOM_PROPS; ctChanged = true; }
  }
  if (relsChanged) changed.set(relsPathFor(main), serializeRels(rels));
  if (ctChanged) changed.set("[Content_Types].xml", serializeContentTypes(ct));
  for (const [p, b] of newFiles) changed.set(p, b);

  const zip = new JSZip();
  for (const [path, bytes] of pkg.files) zip.file(path, changed.has(path) ? changed.get(path)! : bytes);
  for (const [path, v] of changed) if (!pkg.files.has(path)) zip.file(path, v);
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { bytes: out, changedParts: Array.from(changed.keys()), regeneratedBlocks: regenerated, preservedBlocks: preserved, warnings };
}
