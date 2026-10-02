/**
 * .docx fixtures for the Word fidelity suite: one built with the `docx` package (styles, fonts, run formatting,
 * multi-level numbering with restarts, merged-cell tables with header rows and shading, two sections with
 * different page setup/columns, default/first/even headers & footers, PAGE/NUMPAGES/TOC/REF fields, footnotes,
 * endnotes, comments, tracked changes, hyperlinks, bookmarks, images, spacing/indents/tabs/keep-with-next and
 * page breaks) and one hand-written package for what `docx` cannot emit (custom XML and unknown parts, a
 * comment marked resolved in commentsExtended, a complex field spanning paragraphs, a body-level content
 * control, moveFrom/moveTo, formatting revisions, a vMerge table and a non-standard namespace prefix).
 */
import JSZip from "jszip";
import {
  AlignmentType, Bookmark, BorderStyle, CommentRangeEnd, CommentRangeStart, CommentReference, DeletedTextRun, Document, EndnoteReferenceRun, ExternalHyperlink, Footer, FootnoteReferenceRun, Header,
  HeadingLevel, ImageRun, InsertedTextRun, InternalHyperlink, LevelFormat, LineRuleType, Packer, PageBreak, PageNumber, PageOrientation, Paragraph, SectionType, ShadingType, SimpleField, TabStopType,
  Table, TableCell, TableOfContents, TableRow, TextRun, UnderlineType, VerticalMergeType, WidthType,
} from "docx";
import { deflateSync } from "node:zlib";

/** A valid 4×3 RGBA PNG (CRC-correct) for image fixtures. */
export function tinyPng(w = 4, h = 3): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Uint8Array) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; for (let x = 0; x < w; x++) { const o = y * (1 + w * 4) + 1 + x * 4; raw[o] = 200; raw[o + 1] = 30 * x; raw[o + 2] = 60; raw[o + 3] = 255; } }
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const len = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function richDocxFixture(): Promise<Uint8Array> {
  const date = "2026-03-02T10:00:00Z";
  const cell = (text: string, opts: Partial<ConstructorParameters<typeof TableCell>[0]> = {}) => new TableCell({ children: [new Paragraph(text)], ...opts });
  const doc = new Document({
    creator: "Fixture", title: "Fidelity Fixture",
    evenAndOddHeaderAndFooters: true,
    features: { updateFields: true },
    styles: {
      paragraphStyles: [
        { id: "LegalBody", name: "Legal Body", basedOn: "Normal", next: "LegalBody", quickFormat: true, run: { font: "Garamond", size: 24 }, paragraph: { spacing: { after: 120, line: 360 } } },
      ],
      characterStyles: [
        { id: "DefinedTerm", name: "Defined Term", basedOn: "DefaultParagraphFont", run: { bold: true, smallCaps: true } },
      ],
    },
    numbering: { config: [
      { reference: "outline", levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        { level: 1, format: LevelFormat.LOWER_LETTER, text: "(%2)", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
        { level: 2, format: LevelFormat.LOWER_ROMAN, text: "(%3)", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 2160, hanging: 360 } } } },
      ] },
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ] },
    comments: { children: [
      { id: 0, author: "Jane Partner", initials: "JP", date: new Date(date), children: [new Paragraph("Confirm this date against the docket.")] },
      { id: 1, author: "Sam Associate", initials: "SA", date: new Date(date), children: [new Paragraph("Defined term used before definition.")] },
    ] },
    footnotes: {
      1: { children: [new Paragraph("See Celotex Corp. v. Catrett, 477 U.S. 317, 322 (1986).")] },
      2: { children: [new Paragraph("Fed. R. Civ. P. 56(a).")] },
    },
    endnotes: { 1: { children: [new Paragraph("Endnote: record citations are to the joint appendix.")] } },
    sections: [
      {
        properties: { titlePage: true, page: { size: { width: 12240, height: 15840, orientation: PageOrientation.PORTRAIT }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1800 } } },
        headers: { default: new Header({ children: [new Paragraph("Default header — Privileged & Confidential")] }), first: new Header({ children: [new Paragraph("First page header")] }), even: new Header({ children: [new Paragraph("Even page header")] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES] })] })] }) },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Motion for Summary Judgment")] }),
          new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new Bookmark({ id: "introduction", children: [new TextRun("Introduction")] })] }),
          new Paragraph({ style: "LegalBody", children: [
            new TextRun("Defendant "), new TextRun({ text: "Acme Corp.", style: "DefinedTerm" }), new TextRun(" moves for summary judgment"), new FootnoteReferenceRun(1), new TextRun(". The motion is "),
            new TextRun({ text: "bold", bold: true }), new TextRun(", "), new TextRun({ text: "italic", italics: true }), new TextRun(", "), new TextRun({ text: "double underlined", underline: { type: UnderlineType.DOUBLE } }), new TextRun(", "),
            new TextRun({ text: "struck", strike: true }), new TextRun(", "), new TextRun({ text: "red", color: "C00000" }), new TextRun(", "), new TextRun({ text: "highlighted", highlight: "yellow" }), new TextRun(", "),
            new TextRun({ text: "all caps", allCaps: true }), new TextRun(", "), new TextRun({ text: "small caps", smallCaps: true }), new TextRun(", "), new TextRun({ text: "Arial 14", font: "Arial", size: 28 }), new TextRun(" and E=mc"), new TextRun({ text: "2", superScript: true }), new TextRun("."),
          ] }),
          new Paragraph({ spacing: { before: 240, after: 240, line: 480, lineRule: LineRuleType.AUTO }, indent: { left: 720, hanging: 360 }, keepNext: true, keepLines: true, tabStops: [{ type: TabStopType.RIGHT, position: 9000 }], children: [new TextRun("Spacing, hanging indent and tab\tright"), new CommentRangeStart(0), new TextRun(" on March 2, 2026"), new CommentRangeEnd(0), new TextRun({ children: [new CommentReference(0)] })] }),
          new Paragraph({ children: [new TextRun("The Court should grant the motion "), new InsertedTextRun({ text: "without a hearing", id: 11, author: "Jane Partner", date }), new TextRun(" "), new DeletedTextRun({ text: "promptly", id: 12, author: "Sam Associate", date }), new TextRun("."), new EndnoteReferenceRun(1)] }),
          new Paragraph({ children: [new TextRun("See "), new ExternalHyperlink({ link: "https://www.courtlistener.com/opinion/111722/celotex-corp-v-catrett/", children: [new TextRun({ text: "Celotex", style: "Hyperlink" })] }), new TextRun(" and the "), new InternalHyperlink({ anchor: "introduction", children: [new TextRun({ text: "Introduction", style: "Hyperlink" })] }), new TextRun(". Cross-reference: "), new SimpleField("REF introduction \\h", "Introduction"), new TextRun(".")] }),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Undisputed facts")] }),
          new Paragraph({ numbering: { reference: "outline", level: 0 }, children: [new TextRun("First fact")] }),
          new Paragraph({ numbering: { reference: "outline", level: 1 }, children: [new TextRun("Sub-fact a")] }),
          new Paragraph({ numbering: { reference: "outline", level: 2 }, children: [new TextRun("Sub-sub-fact i")] }),
          new Paragraph({ numbering: { reference: "outline", level: 1 }, children: [new TextRun("Sub-fact b")] }),
          new Paragraph({ numbering: { reference: "outline", level: 0 }, children: [new TextRun("Second fact"), new FootnoteReferenceRun(2)] }),
          new Paragraph({ children: [new TextRun("Between lists.")] }),
          new Paragraph({ numbering: { reference: "outline", level: 0, instance: 2 }, children: [new TextRun("Restarted list item one")] }),
          new Paragraph({ numbering: { reference: "outline", level: 0, instance: 2 }, children: [new TextRun("Restarted list item two")] }),
          new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Bullet one")] }),
          new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Bullet two")] }),
          new Table({
            columnWidths: [2400, 3600, 3360], width: { size: 9360, type: WidthType.DXA },
            rows: [
              new TableRow({ tableHeader: true, children: [cell("Date", { shading: { type: ShadingType.CLEAR, fill: "D9E2F3", color: "auto" } }), cell("Event"), cell("Record")] }),
              new TableRow({ children: [cell("2024-01-05"), cell("Complaint filed", { columnSpan: 2 })] }),
              new TableRow({ children: [cell("2024-03-10", { rowSpan: 2, verticalMerge: VerticalMergeType.RESTART }), cell("Answer"), cell("ECF 12", { borders: { top: { style: BorderStyle.DOUBLE, size: 6, color: "000000" }, bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000" }, left: { style: BorderStyle.SINGLE, size: 4, color: "000000" }, right: { style: BorderStyle.SINGLE, size: 4, color: "000000" } } })] }),
              new TableRow({ children: [cell("Motion to dismiss"), cell("ECF 15")] }),
            ],
          }),
          new Paragraph({ children: [new ImageRun({ type: "png", data: tinyPng(), transformation: { width: 120, height: 90 }, altText: { name: "Exhibit A", description: "Exhibit A", title: "Exhibit A" } })] }),
          new Paragraph({ pageBreakBefore: true, children: [new TextRun("Starts on a new page.")] }),
          new Paragraph({ children: [new TextRun("Before manual break"), new PageBreak(), new TextRun("after manual break")] }),
        ],
      },
      {
        properties: { type: SectionType.NEXT_PAGE, column: { count: 2, space: 720 }, page: { size: { width: 15840, height: 12240, orientation: PageOrientation.LANDSCAPE }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Exhibit schedule (landscape)")] }),
          new Paragraph({ children: [new CommentRangeStart(1), new TextRun("The Products"), new CommentRangeEnd(1), new TextRun({ children: [new CommentReference(1)] }), new TextRun(" means the MF-3 finish concentrates.")] }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** Hand-written package: features the docx package cannot emit, plus parts the exporter must never touch. */
export async function handDocxFixture(): Promise<Uint8Array> {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/><Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/><Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/><Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/></Relationships>`);
  zip.file("customXml/item1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="no"?><matter xmlns="urn:leclaude:test"><id>M-1424</id><bates>MFC-0001</bates></matter>`);
  zip.file("customXml/itemProps1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="{6D3E3F0A-1111-2222-3333-444455556666}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>`);
  zip.file("customXml/_rels/item1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/></Relationships>`);
  zip.file("docProps/custom.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="MatterNumber"><vt:lpwstr>M-1424</vt:lpwstr></property></Properties>`);
  zip.file("word/people.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Jane Partner"><w15:presenceInfo w15:providerId="None" w15:userId="Jane Partner"/></w15:person></w15:people>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Century Schoolbook" w:hAnsi="Century Schoolbook"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:numPr><w:numId w:val="2"/></w:numPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`);
  zip.file("word/numbering.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/></w:lvlOverride></w:num></w:numbering>`);
  zip.file("word/comments.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:comment w:id="5" w:author="Jane Partner" w:date="2026-02-01T09:00:00Z" w:initials="JP"><w:p w14:paraId="1A2B3C4D"><w:r><w:annotationRef/></w:r><w:r><w:t>Resolved already.</w:t></w:r></w:p></w:comment><w:comment w:id="6" w:author="Sam Associate" w:date="2026-02-02T09:00:00Z" w:initials="SA"><w:p w14:paraId="2B3C4D5E"><w:r><w:annotationRef/></w:r><w:r><w:t>Still open.</w:t></w:r></w:p></w:comment></w:comments>`);
  zip.file("word/commentsExtended.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="1A2B3C4D" w15:done="1"/><w15:commentEx w15:paraId="2B3C4D5E" w15:done="0"/></w15:commentsEx>`);
  // document.xml binds WordprocessingML to the "x" prefix to exercise namespace canonicalization.
  const X = (s: string) => s.replace(/<(\/?)w:/g, "<$1x:").replace(/ w:/g, " x:");
  const body = X(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Statement of the case</w:t></w:r></w:p>
<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>
<w:p><w:pPr><w:pStyle w:val="TOC1"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Statement of the case</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>Argument</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
</w:sdtContent></w:sdt>
<w:bookmarkStart w:id="90" w:name="_BodyLevel"/><w:bookmarkEnd w:id="90"/>
<w:p><w:pPr><w:pStyle w:val="ListNumber"/></w:pPr><w:r><w:t>Style-numbered item A</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="ListNumber"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested item A.1</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Override starts at D</w:t></w:r></w:p>
<w:p><w:pPr><w:spacing w:before="120" w:after="120" w:line="276" w:lineRule="exact"/><w:ind w:firstLine="720"/><w:jc w:val="both"/></w:pPr><w:commentRangeStart w:id="5"/><w:r><w:rPr><w:b/><w:rPrChange w:id="31" w:author="Jane Partner" w:date="2026-02-01T09:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>Formatting revision.</w:t></w:r><w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r><w:moveFrom w:id="32" w:author="Sam Associate" w:date="2026-02-02T09:00:00Z"><w:r><w:t xml:space="preserve"> Moved away.</w:t></w:r></w:moveFrom><w:r><w:t xml:space="preserve"> Plain tail.</w:t></w:r></w:p>
<w:p><w:commentRangeStart w:id="6"/><w:r><w:t>Open comment range</w:t></w:r><w:commentRangeEnd w:id="6"/><w:r><w:commentReference w:id="6"/></w:r><w:moveTo w:id="33" w:author="Sam Associate" w:date="2026-02-02T09:00:00Z"><w:r><w:t xml:space="preserve"> Moved here.</w:t></w:r></w:moveTo><w:r><w:t xml:space="preserve"> See </w:t></w:r><w:fldSimple w:instr=" PAGEREF _BodyLevel \\h "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge w:val="restart"/><w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"/></w:tcPr><w:p><w:r><w:t>Merged down</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Spans two</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge/><w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>b2</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>c2</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/></w:sectPr></w:pPr><w:r><w:t>End of section one.</w:t></w:r></w:p>
<w:p><w:r><w:t>Second section text.</w:t></w:r></w:p>
<w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="12240" w:h="20160"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:num="2" w:space="360"/></w:sectPr>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:document xmlns:x="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><x:body>
${body}
</x:body></x:document>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}
