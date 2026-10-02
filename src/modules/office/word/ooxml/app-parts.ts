/**
 * The app's own OOXML parts for documents created in the app (and for definitions an imported package lacks):
 * styles, list definitions, settings, fonts, footer with a PAGE field, notes, comments and document properties.
 */
import { MARGIN_PRESETS, PAGE_SIZES, type DocSettings, type MarginPresetId, type PageSizeId } from "../constants";
import type { PMNode } from "../doc-model";
import { BRAND } from "@/lib/brand";
import { escAttr, escText, stripInvalidXmlChars, WORD_NS_DECLS, XML_DECL } from "./xml";

const T = (s: string) => escText(stripInvalidXmlChars(s));

export const APP_LIST_REFS = ["decimal", "legal", "outline", "alpha", "roman", "bullets"] as const;
export type AppListRef = typeof APP_LIST_REFS[number];

export function listRefFor(list: PMNode): AppListRef {
  if (list.type === "bulletList" || list.type === "taskList") return "bullets";
  const s = String(list.attrs?.listStyle ?? "decimal");
  return (APP_LIST_REFS as readonly string[]).includes(s) ? (s as AppListRef) : "decimal";
}

function lvl(ilvl: number, fmt: string, text: string, opts: { legal?: boolean; hanging?: number; start?: number; font?: string } = {}) {
  const left = 720 * (ilvl + 1);
  return `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${opts.start ?? 1}"/><w:numFmt w:val="${fmt}"/>${opts.legal ? "<w:isLgl/>" : ""}<w:lvlText w:val="${escAttr(text)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="${opts.hanging ?? 360}"/></w:pPr>${opts.font ? `<w:rPr><w:rFonts w:ascii="${opts.font}" w:hAnsi="${opts.font}" w:hint="default"/></w:rPr>` : ""}</w:lvl>`;
}

/** An app list definition as a w:abstractNum with the given id. */
export function appAbstractNumXml(ref: AppListRef, abstractId: number): string {
  const levels = Array.from({ length: 9 }, (_, i) => {
    switch (ref) {
      case "decimal": return lvl(i, "decimal", `%${i + 1}.`);
      case "legal": return lvl(i, "decimal", Array.from({ length: i + 1 }, (_, k) => `%${k + 1}`).join(".") + (i === 0 ? "." : ""), { legal: true, hanging: 480 });
      case "outline": return lvl(i, ["decimal", "lowerLetter", "lowerRoman"][i % 3], i === 0 ? "%1." : `(%${i + 1})`);
      case "alpha": return lvl(i, i % 2 === 0 ? "lowerLetter" : "lowerRoman", `(%${i + 1})`);
      case "roman": return lvl(i, i % 2 === 0 ? "upperRoman" : "upperLetter", `%${i + 1}.`);
      case "bullets": return lvl(i, "bullet", ["\uF0B7", "o", "\uF0A7"][i % 3], { font: ["Symbol", "Courier New", "Wingdings"][i % 3] });
    }
  }).join("");
  return `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="${ref === "bullets" || ref === "decimal" ? "hybridMultilevel" : "multilevel"}"/>${levels}</w:abstractNum>`;
}

export function numXml(numId: number | string, abstractId: number | string, startOverride?: { ilvl: number; start: number } | null): string {
  return `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/>${startOverride ? `<w:lvlOverride w:ilvl="${startOverride.ilvl}"><w:startOverride w:val="${startOverride.start}"/></w:lvlOverride>` : ""}</w:num>`;
}

export function bodyFont(settings: DocSettings) { return settings.font === "sans" ? "Calibri" : "Times New Roman"; }

/** Style definitions the app writes; also injected into imported packages that lack a style the writer needs. */
export function appStyleDefs(settings: DocSettings): Record<string, string> {
  const font = bodyFont(settings);
  const sz = Math.round(settings.fontSize * 2);
  const heading = (n: number, size: number, extra = "") => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${n === 1 ? 320 : 240}" w:after="${n === 1 ? 160 : 120}"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/><w:b/><w:bCs/>${extra}<w:color w:val="000000"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return {
    Normal: `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`,
    DefaultParagraphFont: `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`,
    TableNormal: `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`,
    NoList: `<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`,
    Title: `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>`,
    Heading1: heading(1, sz + 4),
    Heading2: heading(2, sz + 2),
    Heading3: heading(3, sz, "<w:i/><w:iCs/>"),
    Heading4: heading(4, sz),
    Heading5: heading(5, sz, "<w:i/><w:iCs/>"),
    Heading6: heading(6, sz),
    Caption: `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="60" w:after="200"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="555555"/><w:sz w:val="${sz - 4}"/><w:szCs w:val="${sz - 4}"/></w:rPr></w:style>`,
    Quote: `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="160"/><w:ind w:left="720" w:right="720"/><w:jc w:val="both"/></w:pPr></w:style>`,
    ListParagraph: `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>`,
    TOCHeading: `<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>`,
    TOC1: `<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs><w:spacing w:after="100"/></w:pPr></w:style>`,
    TOC2: `<w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs><w:spacing w:after="100"/><w:ind w:left="240"/></w:pPr></w:style>`,
    TOC3: `<w:style w:type="paragraph" w:styleId="TOC3"><w:name w:val="toc 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs><w:spacing w:after="100"/><w:ind w:left="480"/></w:pPr></w:style>`,
    Hyperlink: `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="1F4E9A"/><w:u w:val="single"/></w:rPr></w:style>`,
    FootnoteText: `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>`,
    FootnoteReference: `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>`,
    EndnoteText: `<w:style w:type="paragraph" w:styleId="EndnoteText"><w:name w:val="endnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>`,
    EndnoteReference: `<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>`,
    CommentText: `<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>`,
    CommentReference: `<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>`,
    Footer: `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/></w:tabs><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>`,
    TableGrid: `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="444444"/><w:left w:val="single" w:sz="4" w:space="0" w:color="444444"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="444444"/><w:right w:val="single" w:sz="4" w:space="0" w:color="444444"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="444444"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="444444"/></w:tblBorders></w:tblPr></w:style>`,
  };
}

export function appStylesXml(settings: DocSettings): string {
  const font = bodyFont(settings);
  const sz = Math.round(settings.fontSize * 2);
  const line = Math.round(240 * settings.lineSpacing);
  const defs = appStyleDefs(settings);
  return `${XML_DECL}<w:styles ${WORD_NS_DECLS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}" w:cs="${font}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="${escAttr(settings.language || "en-US")}" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${Object.values(defs).join("")}</w:styles>`;
}

export function appSettingsXml(opts: { footnotes: boolean; endnotes: boolean; updateFields: boolean; trackRevisions?: boolean }): string {
  return `${XML_DECL}<w:settings ${WORD_NS_DECLS}><w:zoom w:percent="100"/>${opts.trackRevisions ? "<w:trackRevisions/>" : ""}${opts.updateFields ? `<w:updateFields w:val="true"/>` : ""}<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>${opts.footnotes ? `<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>` : ""}${opts.endnotes ? `<w:endnotePr><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>` : ""}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
}

export function appFontTableXml(settings: DocSettings): string {
  const fonts = Array.from(new Set([bodyFont(settings), "Times New Roman", "Calibri", "Consolas", "Symbol", "Courier New", "Wingdings"]));
  return `${XML_DECL}<w:fonts ${WORD_NS_DECLS}>${fonts.map((f) => `<w:font w:name="${escAttr(f)}"/>`).join("")}</w:fonts>`;
}

export function appFooterXml(): string {
  return `${XML_DECL}<w:ftr ${WORD_NS_DECLS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>1</w:t></w:r><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
}

/** One w:footnote / w:endnote element (text split into paragraphs on newlines). */
export function noteXml(kind: "footnote" | "endnote", id: number, text: string, styled = true): string {
  const ref = kind === "footnote" ? "footnoteRef" : "endnoteRef";
  const rs = kind === "footnote" ? "FootnoteReference" : "EndnoteReference";
  const ps = kind === "footnote" ? "FootnoteText" : "EndnoteText";
  const paras = (text || " ").split("\n");
  return `<w:${kind} w:id="${id}">${paras.map((p, i) => `<w:p><w:pPr>${styled ? `<w:pStyle w:val="${ps}"/>` : ""}</w:pPr>${i === 0 ? `<w:r><w:rPr>${styled ? `<w:rStyle w:val="${rs}"/>` : `<w:vertAlign w:val="superscript"/>`}</w:rPr><w:${ref}/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>` : ""}<w:r><w:t xml:space="preserve">${T(p)}</w:t></w:r></w:p>`).join("")}</w:${kind}>`;
}

export function notesPartXml(kind: "footnote" | "endnote", notes: { id: number; text: string }[]): string {
  const root = kind === "footnote" ? "footnotes" : "endnotes";
  const sep = `<w:${kind} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`;
  return `${XML_DECL}<w:${root} ${WORD_NS_DECLS}>${sep}${notes.map((n) => noteXml(kind, n.id, n.text)).join("")}</w:${root}>`;
}

export interface CommentOut { id: number; author: string; date: string; initials: string; text: string; /** w14:paraId for the last paragraph (keeps commentsExtended threading/resolution linked). */ paraId?: string }

export function commentXml(c: CommentOut, styled = true): string {
  const paras = (c.text || " ").split("\n");
  return `<w:comment w:id="${c.id}" w:author="${escAttr(c.author)}" w:date="${escAttr(c.date)}" w:initials="${escAttr(c.initials)}">${paras.map((p, i) => `<w:p${c.paraId && i === paras.length - 1 ? ` w14:paraId="${escAttr(c.paraId)}"` : ""}><w:pPr>${styled ? `<w:pStyle w:val="CommentText"/>` : ""}</w:pPr>${i === 0 ? `<w:r><w:rPr>${styled ? `<w:rStyle w:val="CommentReference"/>` : ""}</w:rPr><w:annotationRef/></w:r>` : ""}<w:r><w:t xml:space="preserve">${T(p)}</w:t></w:r></w:p>`).join("")}</w:comment>`;
}

export function commentsPartXml(comments: CommentOut[]): string {
  return `${XML_DECL}<w:comments ${WORD_NS_DECLS}>${comments.map((c) => commentXml(c)).join("")}</w:comments>`;
}

export function initialsOf(name: string) { return name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 3).toUpperCase() || "A"; }

export interface SectionSpec { pageSize?: PageSizeId; orientation?: "portrait" | "landscape"; margins?: MarginPresetId; marginsIn?: { top: number; right: number; bottom: number; left: number }; type?: string; columns?: number }

/** Children of w:sectPr for a page setup. */
export function sectPrInnerXml(settings: DocSettings, section: SectionSpec | null | undefined, footerRid: string | null): string {
  const pageSize = section?.pageSize ?? settings.pageSize;
  const orientation = section?.orientation ?? settings.orientation;
  const size = PAGE_SIZES[pageSize] ?? PAGE_SIZES.letter;
  const m = section?.marginsIn ?? MARGIN_PRESETS[section?.margins ?? settings.margins] ?? MARGIN_PRESETS.normal;
  const land = orientation === "landscape";
  const w = Math.round((land ? size.height : size.width) * 1440), h = Math.round((land ? size.width : size.height) * 1440);
  const type = section?.type && section.type !== "nextPage" ? `<w:type w:val="${escAttr(section.type)}"/>` : "";
  const cols = section?.columns && section.columns > 1 ? `<w:cols w:num="${section.columns}" w:space="720"/>` : `<w:cols w:space="720"/>`;
  return `${footerRid ? `<w:footerReference w:type="default" r:id="${footerRid}"/>` : ""}${type}<w:pgSz w:w="${w}" w:h="${h}"${land ? ` w:orient="landscape"` : ""}/><w:pgMar w:top="${Math.round(m.top * 1440)}" w:right="${Math.round(m.right * 1440)}" w:bottom="${Math.round(m.bottom * 1440)}" w:left="${Math.round(m.left * 1440)}" w:header="720" w:footer="720" w:gutter="0"/>${cols}<w:docGrid w:linePitch="360"/>`;
}

const PG_SZ_RE = /<w:pgSz\b[^>]*\/>/;
const PG_MAR_RE = /<w:pgMar\b[^>]*\/>/;
const COLS_RE = /<w:cols\b[^>]*?(?:\/>|>[\s\S]*?<\/w:cols>)/;

/** Apply a page-setup spec (orientation, size, margins, columns) to an existing w:sectPr, keeping everything else. */
export function patchSectPr(sectPr: string, spec: SectionSpec): string {
  let x = sectPr;
  if (spec.orientation || spec.pageSize) {
    const size = spec.pageSize ? PAGE_SIZES[spec.pageSize] : null;
    const replace = (tag: string) => {
      const w = Number(/w:w="(\d+)"/.exec(tag)?.[1] ?? 12240), h = Number(/w:h="(\d+)"/.exec(tag)?.[1] ?? 15840);
      let land = /w:orient="landscape"/.test(tag) || w > h;
      if (spec.orientation) land = spec.orientation === "landscape";
      let W = Math.min(w, h), H = Math.max(w, h);
      if (size) { W = Math.round(size.width * 1440); H = Math.round(size.height * 1440); }
      const [nw, nh] = land ? [H, W] : [W, H];
      return `<w:pgSz w:w="${nw}" w:h="${nh}"${land ? ` w:orient="landscape"` : ""}/>`;
    };
    x = PG_SZ_RE.test(x) ? x.replace(PG_SZ_RE, replace) : x.replace(/(<w:pgMar\b|<w:cols\b|<\/w:sectPr>)/, (m) => `${replace("<w:pgSz/>")}${m}`);
  }
  const m = spec.marginsIn ?? (spec.margins ? MARGIN_PRESETS[spec.margins] : null);
  if (m) {
    const set = (t: string, k: string, v: number) => { const re = new RegExp(`w:${k}="-?\\d+"`); return re.test(t) ? t.replace(re, `w:${k}="${v}"`) : t.replace(/\/>$/, ` w:${k}="${v}"/>`); };
    const patch = (tag: string) => { let t = tag; t = set(t, "top", Math.round(m.top * 1440)); t = set(t, "right", Math.round(m.right * 1440)); t = set(t, "bottom", Math.round(m.bottom * 1440)); t = set(t, "left", Math.round(m.left * 1440)); return t; };
    x = PG_MAR_RE.test(x) ? x.replace(PG_MAR_RE, patch) : x.replace(/(<w:cols\b|<\/w:sectPr>)/, (mm) => `${patch(`<w:pgMar w:header="720" w:footer="720" w:gutter="0"/>`)}${mm}`);
  }
  if (spec.columns && spec.columns > 0) {
    const cols = spec.columns > 1 ? `<w:cols w:num="${spec.columns}" w:space="720"/>` : `<w:cols w:space="720"/>`;
    x = COLS_RE.test(x) ? x.replace(COLS_RE, cols) : x.replace(/<\/w:sectPr>/, `${cols}</w:sectPr>`);
  }
  return x;
}

export function mergeSectionSpec(a: SectionSpec | null, b: SectionSpec | null | undefined): SectionSpec {
  const out: SectionSpec = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  return out;
}

export function coreXml(title: string, author: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${T(title)}</dc:title><dc:creator>${T(author)}</dc:creator><cp:lastModifiedBy>${T(author)}</cp:lastModifiedBy><dc:description>Exported from ${BRAND.name}</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

export function appPropsXml(): string {
  return `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${BRAND.name}</Application><DocSecurity>0</DocSecurity></Properties>`;
}
