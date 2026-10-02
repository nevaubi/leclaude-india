/**
 * In-test .pptx fixtures for the slides fidelity and agent suites (not a test file itself):
 *  - handFixture: hand-written OOXML with a master, four layouts (title/obj/twoObj/blank) with placeholders, a
 *    custom theme, sections, an mc:AlternateContent transition, groups with child transforms, a connector, a merged
 *    table with fills/borders, a cropped picture, a chart part, notes and a notes master, and an unknown custom part;
 *  - pptxgenFixture: a pptxgenjs deck with runs, bullets, flips, a merged table, a chart, sections and a hidden slide.
 */
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";

const NSD = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: [string, string, string, boolean?][]) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${ext ? ` TargetMode="External"` : ""}/>`).join("")}</Relationships>`;
const grp = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
const ph = (id: number, name: string, phXml: string, body = "", xfrm = "") => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phXml}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body || `<a:p><a:endParaRPr lang="en-US"/></a:p>`}</p:txBody></p:sp>`;
const xf = (x: number, y: number, cx: number, cy: number, extra = "") => `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const run = (t: string, rPr = `<a:rPr lang="en-US" dirty="0"/>`) => `<a:r>${rPr}<a:t>${t}</a:t></a:r>`;
export const PNG_1x1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGBkAHf4D/wnq1v8AAAAASUVORK5CYII=", "base64"));

const THEME = (name: string) => `${HEAD}<a:theme ${NSD} name="${name}"><a:themeElements><a:clrScheme name="Counsel"><a:dk1><a:srgbClr val="1B1B1B"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3A6B"/></a:dk2><a:lt2><a:srgbClr val="EEF1F6"/></a:lt2><a:accent1><a:srgbClr val="7A1F1F"/></a:accent1><a:accent2><a:srgbClr val="C8A24A"/></a:accent2><a:accent3><a:srgbClr val="5B8DEF"/></a:accent3><a:accent4><a:srgbClr val="9BB0C9"/></a:accent4><a:accent5><a:srgbClr val="C97B7B"/></a:accent5><a:accent6><a:srgbClr val="7BC9A4"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Counsel"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const MASTER = `${HEAD}<p:sldMaster ${NSD}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${grp}${ph(2, "Title Placeholder 1", `<p:ph type="title"/>`, "", xf(838200, 365125, 10515600, 1325563))}${ph(3, "Text Placeholder 2", `<p:ph type="body" idx="1"/>`, "", xf(838200, 1825625, 10515600, 4351338))}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/><p:sldLayoutId id="2147483651" r:id="rId3"/><p:sldLayoutId id="2147483652" r:id="rId4"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8211;"/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl2pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const layout = (type: string, name: string, shapes: string) => `${HEAD}<p:sldLayout ${NSD} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${grp}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const LAYOUTS = [
  layout("title", "Title Slide", ph(2, "Title 1", `<p:ph type="ctrTitle"/>`, "", xf(1524000, 1122363, 9144000, 2387600)) + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xf(1524000, 3602038, 9144000, 1655762)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`),
  layout("obj", "Title and Content", ph(2, "Title 1", `<p:ph type="title"/>`) + ph(3, "Content Placeholder 2", `<p:ph idx="1"/>`)),
  layout("twoObj", "Two Content", ph(2, "Title 1", `<p:ph type="title"/>`) + ph(3, "Content Placeholder 2", `<p:ph sz="half" idx="1"/>`, "", xf(838200, 1825625, 5181600, 4351338)) + ph(4, "Content Placeholder 3", `<p:ph sz="half" idx="2"/>`, "", xf(6172200, 1825625, 5181600, 4351338))),
  layout("blank", "Blank", ""),
];

const sld = (body: string, attrs = "", after = "") => `${HEAD}<p:sld ${NSD}${attrs}><p:cSld><p:spTree>${grp}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${after}</p:sld>`;

const SLIDE1 = sld(
  ph(2, "Title 1", `<p:ph type="ctrTitle"/>`, `<a:p>${run("Meridian v. Halvorsen")}</a:p>`) + ph(3, "Subtitle 2", `<p:ph type="subTitle" idx="1"/>`, `<a:p>${run("Case strategy &#8212; privileged")}</a:p>`),
  "",
  `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition spd="slow" p14:dur="2000"><p14:vortex dir="r"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`,
);
const BODY2 = [
  `<a:p>${run("Meridian ")}${run("knew", `<a:rPr lang="en-US" b="1" dirty="0"/>`)}${run(" in ")}${run("1998", `<a:rPr lang="en-US" i="1" dirty="0"/>`)}</a:p>`,
  `<a:p><a:pPr lvl="1"/>${run("Rat study ")}${run("MFC-0102211", `<a:rPr lang="en-US" u="sng" dirty="0"><a:hlinkClick r:id="rId3"/></a:rPr>`)}</a:p>`,
  `<a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>${run("Plain paragraph")}</a:p>`,
  `<a:p><a:pPr marL="342900" indent="-342900"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>${run("Numbered point", `<a:rPr lang="en-US" sz="2000" dirty="0"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="Consolas"/></a:rPr>`)}<a:br><a:rPr lang="en-US"/></a:br>${run("after break")}</a:p>`,
].join("");
const SLIDE2 = sld(
  ph(2, "Title 1", `<p:ph type="title"/>`, `<a:p>${run("Key facts")}</a:p>`)
  + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit fontScale="92500" lnSpcReduction="10000"/></a:bodyPr><a:lstStyle/>${BODY2}</p:txBody></p:sp>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="4" name="TextBox 3"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xf(9000000, 5600000, 2400000, 600000, ` rot="5400000" flipH="1"`)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/><a:p>${run("Privileged &amp; Confidential", `<a:rPr lang="en-US" sz="1200" dirty="0"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr>`)}</a:p></p:txBody></p:sp>`,
);
const SLIDE3 = sld(
  ph(2, "Title 1", `<p:ph type="title"/>`, `<a:p>${run("Their theory vs ours")}</a:p>`)
  + ph(3, "Content Placeholder 2", `<p:ph sz="half" idx="1"/>`, `<a:p>${run("Plaintiffs: sole source")}</a:p>`)
  + ph(4, "Content Placeholder 3", `<p:ph sz="half" idx="2"/>`, `<a:p>${run("Defense: four suppliers")}</a:p>`)
  + `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Group 4"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${`<a:xfrm><a:off x="1000000" y="6000000"/><a:ext cx="2000000" cy="400000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="200000"/></a:xfrm>`}</p:grpSpPr>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="6" name="Rectangle 5"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(0, 0, 400000, 200000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="1F3A6B"/></a:solidFill></a:ln></p:spPr></p:sp>`
  + `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="Straight Arrow 6"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xf(500000, 100000, 500000, 0, ` flipV="1"`)}<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="19050"><a:solidFill><a:srgbClr val="7A1F1F"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp></p:grpSp>`,
);
const cell = (t: string, attrs = "", tcPr = "<a:tcPr/>") => `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${t ? run(t) : `<a:endParaRPr lang="en-US"/>`}</a:p></a:txBody>${tcPr}</a:tc>`;
const TABLE = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Table 1"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="914400"/><a:ext cx="6096000" cy="1483360"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid><a:gridCol w="2032000"/><a:gridCol w="2032000"/><a:gridCol w="2032000"/></a:tblGrid>`
  + `<a:tr h="370840">${cell("Bates", "", `<a:tcPr><a:lnB w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnB><a:solidFill><a:srgbClr val="1F3A6B"/></a:solidFill></a:tcPr>`)}${cell("Document", ` gridSpan="2"`)}${cell("", ` hMerge="1"`)}</a:tr>`
  + `<a:tr h="370840">${cell("MFC-0102211", ` rowSpan="2"`)}${cell("1998-03-12")}${cell("Rat study")}</a:tr>`
  + `<a:tr h="370840">${cell("", ` vMerge="1"`)}${cell("2001-06-04")}${cell("Draft notice", "", `<a:tcPr><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill></a:tcPr>`)}</a:tr>`
  + `<a:tr h="370840">${cell("MFC-0119377")}${cell("2006-01-01")}${cell("Stewardship")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const PIC = `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 2" descr="Plume map"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000" t="5000" r="20000" b="0"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xf(7315200, 914400, 3657600, 2743200)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
const CHART_FRAME = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="3200400"/><a:ext cx="6096000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId3"/></a:graphicData></a:graphic></p:graphicFrame>`;
const SLIDE4 = `${HEAD}<p:sld ${NSD} show="0"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F3EDE0"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${grp}${TABLE}${PIC}${CHART_FRAME}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
const SLIDE5 = sld(ph(2, "Title 1", `<p:ph type="title"/>`, `<a:p>${run("Next steps")}</a:p>`) + ph(3, "Content Placeholder 2", `<p:ph idx="1"/>`, `<a:p>${run("Serve expert reports")}</a:p><a:p>${run("Open settlement channel")}</a:p>`));
const pt = (i: number, v: string | number) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`;
const CHART = `${HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Exposure ($M)</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>`
  + ["Plaintiffs", "Defense"].map((name, si) => `<c:ser><c:idx val="${si}"/><c:order val="${si}"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/>${pt(0, name)}</c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/>${pt(0, "2024")}${pt(1, "2025")}${pt(2, "2026")}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/>${pt(0, 184 - si * 100)}${pt(1, 120 - si * 60)}${pt(2, 65 - si * 20)}</c:numCache></c:numRef></c:val></c:ser>`).join("")
  + `<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;
const NOTES = (text: string, slide: number) => [`${HEAD}<p:notes ${NSD}><p:cSld><p:spTree>${grp}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>${ph(3, "Notes Placeholder 2", `<p:ph type="body" idx="1"/>`, `<a:p>${run(text)}</a:p>`)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`, rels([["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"], ["rId2", "slide", `../slides/slide${slide}.xml`]])];
const NOTES_MASTER = `${HEAD}<p:notesMaster ${NSD}><p:cSld><p:spTree>${grp}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`;
const CUSTOM_XML = `${HEAD}<root xmlns="urn:leclaude:test"><matter id="m_valsara_arb">Unknown part that must survive byte-for-byte</matter></root>`;

/** Hand-written package: masters, layouts, placeholders, theme, sections, transitions, groups, tables, charts, notes. */
export async function handFixture(): Promise<Uint8Array> {
  const z = new JSZip();
  const ov = (p: string, t: string) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.${t}"/>`;
  z.file("[Content_Types].xml", `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${ov("ppt/presentation.xml", "presentationml.presentation.main+xml")}${ov("ppt/slideMasters/slideMaster1.xml", "presentationml.slideMaster+xml")}${[1, 2, 3, 4].map((i) => ov(`ppt/slideLayouts/slideLayout${i}.xml`, "presentationml.slideLayout+xml")).join("")}${[1, 2, 3, 4, 5].map((i) => ov(`ppt/slides/slide${i}.xml`, "presentationml.slide+xml")).join("")}${[1, 4].map((i) => ov(`ppt/notesSlides/notesSlide${i}.xml`, "presentationml.notesSlide+xml")).join("")}${ov("ppt/notesMasters/notesMaster1.xml", "presentationml.notesMaster+xml")}${ov("ppt/theme/theme1.xml", "theme+xml")}${ov("ppt/theme/theme2.xml", "theme+xml")}${ov("ppt/charts/chart1.xml", "drawingml.chart+xml")}<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  z.file("_rels/.rels", `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="${R}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  z.file("docProps/app.xml", `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Slides>5</Slides><HiddenSlides>1</HiddenSlides></Properties>`);
  z.file("ppt/presentation.xml", `${HEAD}<p:presentation ${NSD} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${[1, 2, 3, 4, 5].map((i) => `<p:sldId id="${255 + i}" r:id="rId${9 + i}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle><p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p14:section name="Opening" id="{0A6E1C5B-0000-4000-8000-000000000001}"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section><p14:section name="Evidence" id="{0A6E1C5B-0000-4000-8000-000000000002}"><p14:sldIdLst><p14:sldId id="258"/><p14:sldId id="259"/><p14:sldId id="260"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>`);
  z.file("ppt/_rels/presentation.xml.rels", rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "notesMaster", "notesMasters/notesMaster1.xml"], ["rId3", "theme", "theme/theme1.xml"], ["rId4", "customXml", "../customXml/item1.xml"], ...[1, 2, 3, 4, 5].map((i) => [`rId${9 + i}`, "slide", `slides/slide${i}.xml`] as [string, string, string])]));
  z.file("customXml/item1.xml", CUSTOM_XML);
  z.file("ppt/slideMasters/slideMaster1.xml", MASTER);
  z.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([...[1, 2, 3, 4].map((i) => [`rId${i}`, "slideLayout", `../slideLayouts/slideLayout${i}.xml`] as [string, string, string]), ["rId5", "theme", "../theme/theme1.xml"]]));
  LAYOUTS.forEach((l, i) => { z.file(`ppt/slideLayouts/slideLayout${i + 1}.xml`, l); z.file(`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])); });
  z.file("ppt/theme/theme1.xml", THEME("Counsel Theme"));
  z.file("ppt/theme/theme2.xml", THEME("Notes Theme"));
  z.file("ppt/notesMasters/notesMaster1.xml", NOTES_MASTER);
  z.file("ppt/notesMasters/_rels/notesMaster1.xml.rels", rels([["rId1", "theme", "../theme/theme2.xml"]]));
  const slides = [SLIDE1, SLIDE2, SLIDE3, SLIDE4, SLIDE5];
  const layoutOf = [1, 2, 3, 4, 2];
  slides.forEach((s, i) => {
    z.file(`ppt/slides/slide${i + 1}.xml`, s);
    const r: [string, string, string, boolean?][] = [["rId1", "slideLayout", `../slideLayouts/slideLayout${layoutOf[i]}.xml`]];
    if (i === 0) r.push(["rId2", "notesSlide", "../notesSlides/notesSlide1.xml"]);
    if (i === 1) r.push(["rId3", "hyperlink", "https://example.com/docs/MFC-0102211", true]);
    if (i === 3) r.push(["rId2", "image", "../media/image1.png"], ["rId3", "chart", "../charts/chart1.xml"], ["rId4", "notesSlide", "../notesSlides/notesSlide4.xml"]);
    z.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels(r));
  });
  const [n1, n1r] = NOTES("Open with the caption.", 1);
  const [n4, n4r] = NOTES("Walk the key documents; read MFC-0102211 aloud.", 4);
  z.file("ppt/notesSlides/notesSlide1.xml", n1); z.file("ppt/notesSlides/_rels/notesSlide1.xml.rels", n1r);
  z.file("ppt/notesSlides/notesSlide4.xml", n4); z.file("ppt/notesSlides/_rels/notesSlide4.xml.rels", n4r);
  z.file("ppt/media/image1.png", PNG_1x1);
  z.file("ppt/charts/chart1.xml", CHART);
  return z.generateAsync({ type: "uint8array" });
}

/** pptxgenjs deck: runs, bullets, shapes with rotation/flip, line, image, merged table, chart, notes, hidden, sections. */
export async function pptxgenFixture(): Promise<Uint8Array> {
  const p = new PptxGenJS();
  p.layout = "LAYOUT_WIDE";
  p.addSection({ title: "Intro" });
  const s1 = p.addSlide({ sectionTitle: "Intro" });
  s1.background = { color: "F7F8FA" };
  s1.addText("Deposition themes", { x: 0.5, y: 0.4, w: 12, h: 1, fontSize: 36, bold: true, color: "14213D", fontFace: "Georgia" });
  s1.addText([
    { text: "Knowledge ", options: { bullet: true } },
    { text: "timeline", options: { bold: true, color: "C8A24A", breakLine: true } },
    { text: "Nested point", options: { bullet: true, indentLevel: 1, italic: true, breakLine: true } },
    { text: "Link to record", options: { hyperlink: { url: "https://example.com/record" }, underline: { style: "sng" } } },
  ], { x: 0.5, y: 1.6, w: 7, h: 3, fontSize: 20, align: "left", valign: "top" });
  s1.addShape(p.ShapeType.rect, { x: 8, y: 2, w: 2, h: 1, fill: { color: "7A1F1F" }, rotate: 30, flipH: true });
  s1.addShape(p.ShapeType.line, { x: 8, y: 4, w: 3, h: 0, line: { color: "1F3A6B", width: 2 } });
  s1.addNotes("Emphasize the timeline.");
  p.addSection({ title: "Record" });
  const s2 = p.addSlide({ sectionTitle: "Record" });
  s2.addImage({ data: `data:image/png;base64,${Buffer.from(PNG_1x1).toString("base64")}`, x: 0.5, y: 0.5, w: 4, h: 2 });
  s2.addTable([
    [{ text: "Bates", options: { bold: true, fill: { color: "1F3A6B" }, color: "FFFFFF" } }, { text: "Summary", options: { colspan: 2 } }],
    [{ text: "MFC-1", options: { rowspan: 2 } }, { text: "a" }, { text: "b" }],
    [{ text: "c" }, { text: "d" }],
  ], { x: 5, y: 0.5, w: 6, colW: [2, 2, 2] });
  s2.addChart(p.ChartType.line, [{ name: "Exposure", labels: ["Q1", "Q2", "Q3"], values: [10, 20, 15] }], { x: 0.5, y: 3, w: 6, h: 3 });
  s2.hidden = true;
  const out = await p.write({ outputType: "uint8array" });
  return out as Uint8Array;
}

