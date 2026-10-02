/**
 * .xlsx fidelity suite for the direct OOXML reader/writer.
 * - A hand-written OOXML package (built here with JSZip, independent of the writer) exercises every feature.
 * - import → export → re-import keeps the normalized model; untouched parts stay byte-identical; exported XML is
 *   well-formed with consistent style indices, shared-string indices and relationships; the formula engine
 *   reproduces the cached values Excel stored.
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { XMLValidator } from "fast-xml-parser";
import { computeWorkbook } from "@/modules/office/sheet/engine";
import { emptyWorkbook, normalizeWorkbook, styleKey, type CellStyle, type Workbook } from "@/modules/office/sheet/model";
import { applyOp, type SheetOp } from "@/modules/office/sheet/ops";
import { exportXlsx, exportXlsxWithReport } from "@/modules/office/sheet/export";
import { importDocument } from "@/modules/office/sheet/import";
import { readXlsx } from "@/modules/office/sheet/xlsx/reader";
import { entryBytes, readZip } from "@/modules/office/sheet/xlsx/zip";
import { formatNumber } from "@/modules/office/sheet/format";
import { conditionalStyles } from "@/modules/office/sheet/cell-render";

// ------------------------------------------------------------------ fixture

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const FIXTURE: Record<string, string | Uint8Array> = {
  "[Content_Types].xml": `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  "_rels/.rels": `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "docProps/core.xml": `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Paralegal</dc:creator></cp:coreProperties>`,
  "docProps/app.xml": `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>`,
  "customXml/item1.xml": `${DECL}<matter xmlns="urn:leclaude:test"><id>M-17</id></matter>`,
  "xl/workbook.xml": `${DECL}<workbook ${NS}><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="164011"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300" activeTab="0"/></bookViews><sheets><sheet name="Damages" sheetId="1" r:id="rId1"/><sheet name="Lists" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Damages!$A$1:$E$5</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Damages!$A$1:$E$20</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">Damages!$1:$1</definedName><definedName name="LocalTotal" localSheetId="0">Damages!$C$6</definedName><definedName name="Rate">Damages!$B$10</definedName><definedName name="Statutory">0.1</definedName></definedNames><calcPr calcId="191029"/></workbook>`,
  "xl/_rels/workbook.xml.rels": `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/></Relationships>`,
  "xl/theme/theme1.xml": `${DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"/></a:themeElements></a:theme>`,
  "xl/styles.xml": `${DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="mmm d, yyyy"/></numFmts><fonts count="4" x14ac:knownFonts="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color theme="0"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><i/><sz val="11"/><color theme="4" tint="-0.249977111117893"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><u val="double"/><sz val="14"/><color rgb="FFC00000"/><name val="Arial"/><family val="2"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor theme="5" tint="0.79998168889431442"/><bgColor indexed="64"/></patternFill></fill><fill><gradientFill degree="90"><stop position="0"><color theme="0"/></stop><stop position="1"><color theme="4"/></stop></gradientFill></fill></fills><borders count="4"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border><border><left/><right/><top/><bottom style="medium"><color rgb="FFFF0000"/></bottom><diagonal/></border><border><left/><right/><top style="double"><color auto="1"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="44" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" indent="2"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="3" xfId="0" applyBorder="1" applyProtection="1"><protection locked="0"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="2"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf><dxf><font><b/><color rgb="FF006100"/></font></dxf></dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`,
  "xl/sharedStrings.xml": `${DECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="14" uniqueCount="10"><si><t>Item</t></si><si><t>Amount</t></si><si><t>Rate</t></si><si><t>Date</t></si><si><r><rPr><b/><sz val="11"/><rFont val="Calibri"/></rPr><t xml:space="preserve">Past </t></r><r><rPr><sz val="11"/><rFont val="Calibri"/></rPr><t>medicals</t></r></si><si><t>Wage loss</t></si><si><t>Total</t></si><si><t>Open</t></si><si><t>Closed</t></si><si><t>Tab_x0009_sep &amp; &lt;done&gt;</t></si></sst>`,
  "xl/worksheets/sheet1.xml": `${DECL}<worksheet ${NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><sheetPr><tabColor rgb="FFC00000"/><outlinePr summaryBelow="0"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:H12"/><sheetViews><sheetView showGridLines="0" tabSelected="1" zoomScale="120" zoomScaleNormal="120" workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/><selection pane="topRight" activeCell="B1" sqref="B1"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/><selection pane="bottomRight" activeCell="C3" sqref="C3:D4"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols><col min="1" max="1" width="24.7109375" customWidth="1"/><col min="2" max="3" width="14.7109375" style="2" customWidth="1"/><col min="6" max="6" width="9.140625" hidden="1"/></cols><sheetData><row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>2</v></c><c r="D1" s="1" t="s"><v>3</v></c><c r="E1" s="1" t="inlineStr"><is><t>Status</t></is></c><c r="G1" t="inlineStr"><is><t>Key</t></is></c><c r="H1" t="inlineStr"><is><t>Val</t></is></c></row><row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" s="2"><v>12500.5</v></c><c r="C2" s="3"><v>0.1</v></c><c r="D2" s="4"><v>45292</v></c><c r="E2" t="s"><v>7</v></c><c r="G2" t="inlineStr"><is><t>a</t></is></c><c r="H2"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3" s="2"><v>8000</v></c><c r="C3" s="3"><v>0.1</v></c><c r="D3" s="9"><v>45323</v></c><c r="E3" t="s"><v>8</v></c></row><row r="4" hidden="1"><c r="A4" t="b"><v>1</v></c><c r="B4" t="e"><v>#N/A</v></c><c r="C4" t="str"><f>A3&amp;"!"</f><v>Wage loss!</v></c></row><row r="5"><c r="A5" s="6" t="s"><v>6</v></c><c r="B5" s="5"><f>SUM(B2:B3)</f><v>20500.5</v></c><c r="C5"><f t="shared" ref="C5:C7" si="0">B2*C2</f><v>1250.05</v></c></row><row r="6"><c r="C6"><f t="shared" si="0"/><v>800</v></c></row><row r="7"><c r="C7" t="e"><f t="shared" si="0"/><v>#N/A</v></c></row><row r="8"><c r="D8"><f t="array" ref="D8">SUM(B2:B3*C2:C3)</f><v>2050.05</v></c></row><row r="9"><c r="A9" s="7" t="s"><v>9</v></c><c r="B9"><f>_xlfn.XLOOKUP("Wage loss",A2:A3,B2:B3)</f><v>8000</v></c></row><row r="10"><c r="A10" t="s"><v>2</v></c><c r="B10" s="3"><v>0.1</v></c></row><row r="11"><c r="A11" s="8"><v>1</v></c></row><row r="12"><c r="B12"><f>Rate*B5</f><v>2050.05</v></c><c r="C12"><f>LocalTotal+1</f><v>801</v></c></row></sheetData><sheetProtection sheet="1" objects="1" scenarios="1"/><autoFilter ref="A1:E5"><filterColumn colId="4"><filters><filter val="Open"/></filters></filterColumn></autoFilter><mergeCells count="1"><mergeCell ref="A11:B11"/></mergeCells><conditionalFormatting sqref="B2:B3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>10000</formula></cfRule></conditionalFormatting><conditionalFormatting sqref="A2:A3"><cfRule type="expression" dxfId="1" priority="2"><formula>LEN(A2)&gt;9</formula></cfRule></conditionalFormatting><conditionalFormatting sqref="C2:C3"><cfRule type="colorScale" priority="3"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting><conditionalFormatting sqref="B2:B3"><cfRule type="dataBar" priority="4"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting><conditionalFormatting sqref="D2:D3"><cfRule type="iconSet" priority="5"><iconSet iconSet="3Arrows"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule></conditionalFormatting><conditionalFormatting sqref="E2:E3"><cfRule type="containsText" dxfId="0" priority="6" operator="containsText" text="Open"><formula>NOT(ISERROR(SEARCH("Open",E2)))</formula></cfRule></conditionalFormatting><dataValidations count="4"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="E2:E3"><formula1>"Open,Closed"</formula1></dataValidation><dataValidation type="list" allowBlank="1" sqref="A2:A3"><formula1>Lists!$A$1:$A$3</formula1></dataValidation><dataValidation type="decimal" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="Rate" error="Enter a rate between 0 and 1" promptTitle="Rate" prompt="Annual rate" sqref="C2:C3"><formula1>0</formula1><formula2>1</formula2></dataValidation><dataValidation type="custom" sqref="B2:B3"><formula1>ISNUMBER(B2)</formula1></dataValidation></dataValidations><hyperlinks><hyperlink ref="A2" r:id="rId3" tooltip="Source record"/><hyperlink ref="A3" location="'Lists'!A1" display="Lists"/></hyperlinks><printOptions horizontalCentered="1" gridLines="1"/><pageMargins left="0.5" right="0.5" top="1" bottom="1" header="0.3" footer="0.3"/><pageSetup paperSize="5" orientation="landscape" fitToHeight="0" r:id="rId4"/><headerFooter><oddHeader>&amp;CDamages &amp;P</oddHeader><oddFooter>&amp;LConfidential&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter><drawing r:id="rId1"/><legacyDrawing r:id="rId2"/><tableParts count="1"><tablePart r:id="rId5"/></tableParts><extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="0" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"/></ext></extLst></worksheet>`,
  "xl/worksheets/_rels/sheet1.xml.rels": `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/record?id=1&amp;x=2" TargetMode="External"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/></Relationships>`,
  "xl/worksheets/sheet2.xml": `${DECL}<worksheet ${NS}><dimension ref="A1:B3"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Open</t></is></c><c r="B1"><f>SUM(Damages!B2:B3)</f><v>20500.5</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Closed</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Pending</t></is></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
  "xl/drawings/drawing1.xml": `${DECL}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>16</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>16</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor><xdr:twoCellAnchor><xdr:from><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>18</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>21</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="3" name="TextBox 2"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr><xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Draft - privileged</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
  "xl/drawings/_rels/drawing1.xml.rels": `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`,
  "xl/charts/chart1.xml": `${DECL}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Damages by item</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Damages!$B$1</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>Damages!$A$2:$A$3</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Damages!$B$2:$B$3</c:f></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="1"/></c:valAx><c:spPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst></a:gradFill></c:spPr></c:plotArea></c:chart></c:chartSpace>`,
  "xl/comments1.xml": `${DECL}<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Jane Roe</author></authors><commentList><comment ref="B5" authorId="0"><text><r><rPr><b/></rPr><t xml:space="preserve">Jane Roe: </t></r><r><t>Check total against the expert report.</t></r></text></comment></commentList></comments>`,
  "xl/drawings/vmlDrawing1.vml": `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape id="_x0000_s1025" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Row>4</x:Row><x:Column>1</x:Column></x:ClientData></v:shape></xml>`,
  "xl/tables/table1.xml": `${DECL}<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Keys" displayName="Keys" ref="G1:H2" totalsRowShown="0"><autoFilter ref="G1:H2"/><tableColumns count="2"><tableColumn id="1" name="Key"/><tableColumn id="2" name="Val"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`,
  "xl/printerSettings/printerSettings1.bin": new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 42, 42, 42, 42]),
  "xl/calcChain.xml": `${DECL}<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B5" i="1"/><c r="C5"/></calcChain>`,
};

async function fixtureBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(FIXTURE)) zip.file(name, data);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// ------------------------------------------------------------------ helpers

function wbWith(ops: SheetOp[], base: Workbook = emptyWorkbook()): Workbook { return ops.reduce((wb, op) => applyOp(wb, op), base); }

const upperColors = (v: unknown): unknown => {
  if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (Array.isArray(v)) return v.map(upperColors);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, upperColors(x)]));
  return v;
};

/** Normalized, id-free view of a workbook for round-trip equality. */
function canon(wb: Workbook) {
  const style = (id?: string, dateCell = false): CellStyle | undefined => {
    if (!id) return undefined;
    const st = { ...(wb.styles[id] ?? {}) };
    if (dateCell && st.numFmt === "yyyy-mm-dd") delete st.numFmt;
    return styleKey(st) ? (upperColors(st) as CellStyle) : undefined;
  };
  return upperColors({
    activeSheet: wb.activeSheet,
    namedRanges: wb.namedRanges,
    extraNames: wb.extraNames ?? [],
    pageSetup: wb.pageSetup,
    sheets: wb.sheets.map((s) => ({
      name: s.name, hidden: Boolean(s.hidden), veryHidden: Boolean(s.veryHidden), color: s.color, freeze: s.freeze,
      merges: [...s.merges].sort(), colWidths: s.colWidths, rowHeights: s.rowHeights,
      hiddenRows: [...(s.hiddenRows ?? [])].sort((a, b) => a - b), hiddenCols: [...(s.hiddenCols ?? [])].sort(),
      defaultColWidth: s.defaultColWidth, defaultRowHeight: s.defaultRowHeight, selection: s.selection, view: s.view,
      hyperlinks: s.hyperlinks ?? [], notes: s.notes ?? {}, pageSetup: s.pageSetup, localNames: s.localNames ?? {}, filters: s.filters ?? null,
      colStyles: Object.fromEntries(Object.entries(s.colStyles ?? {}).map(([k, v]) => [k, style(v)])),
      rowStyles: Object.fromEntries(Object.entries(s.rowStyles ?? {}).map(([k, v]) => [k, style(v)])),
      cells: Object.fromEntries(Object.entries(s.cells).map(([ref, c]) => [ref, { f: c.f, ar: c.ar, v: c.f ? undefined : c.v, t: c.f ? undefined : c.t, style: style(c.s, c.t === "d") }])),
      cfs: s.conditionalFormats.map(({ id: _id, priority: _p, ...rest }) => { void _id; void _p; return rest; }),
      validations: (s.validations ?? []).map(({ id: _id, ...rest }) => { void _id; return rest; }),
      charts: s.charts.map(({ id: _id, xlsx: _x, position: _p, ...rest }) => { void _id; void _x; void _p; return rest; }),
    })),
  });
}

/** Structural checks on an exported package: well-formed XML, rels resolve, style/shared-string indices in range, content types cover parts. */
function checkPackage(bytes: Uint8Array) {
  const zip = readZip(bytes);
  const text = (n: string) => new TextDecoder().decode(entryBytes(zip.get(n)!));
  for (const name of zip.keys()) {
    if (!/\.(xml|rels|vml)$/.test(name)) continue;
    const v = XMLValidator.validate(text(name));
    expect(v, `${name} is well-formed`).toBe(true);
  }
  // relationships resolve
  for (const name of zip.keys()) {
    if (!name.endsWith(".rels")) continue;
    const owner = name === "_rels/.rels" ? "" : name.replace(/_rels\/([^/]+)\.rels$/, "$1");
    const dir = owner.includes("/") ? owner.slice(0, owner.lastIndexOf("/") + 1) : "";
    for (const m of text(name).matchAll(/<Relationship [^>]*Target="([^"]+)"[^>]*?\/>/g)) {
      if (/TargetMode="External"/.test(m[0])) continue;
      const parts = (m[1].startsWith("/") ? m[1].slice(1) : dir + m[1]).split("/");
      const out: string[] = [];
      for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
      expect(zip.has(out.join("/")), `${name} → ${m[1]}`).toBe(true);
    }
  }
  // styles and shared strings
  const styles = text("xl/styles.xml");
  const xfCount = (/<cellXfs count="(\d+)"/.exec(styles)?.[1] ?? "0");
  const xfActual = (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1].match(/<xf\b/g) ?? []).length;
  expect(Number(xfCount)).toBe(xfActual);
  const sst = zip.has("xl/sharedStrings.xml") ? text("xl/sharedStrings.xml") : "<sst/>";
  const sstCount = (sst.match(/<si>/g) ?? []).length;
  const uniq = /uniqueCount="(\d+)"/.exec(sst)?.[1];
  if (uniq) expect(Number(uniq)).toBe(sstCount);
  const ct = text("[Content_Types].xml");
  for (const name of zip.keys()) {
    if (!name.startsWith("xl/worksheets/sheet")) continue;
    const xml = text(name);
    for (const m of xml.matchAll(/<c r="[A-Z]+\d+"( s="(\d+)")?( t="(\w+)")?[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (m[2]) expect(Number(m[2]), `${name} style index`).toBeLessThan(xfActual);
      if (m[4] === "s") { const v = Number(/<v>(\d+)<\/v>/.exec(m[5] ?? "")?.[1]); expect(v, `${name} sst index`).toBeLessThan(sstCount); }
    }
    expect(ct.includes(`PartName="/${name}"`), `${name} has a content type`).toBe(true);
  }
  return { zip, text };
}

// ------------------------------------------------------------------ tests

describe("xlsx reader — hand-written OOXML fixture", () => {
  it("reads every modeled feature", async () => {
    const wb = readXlsx(await fixtureBytes(), { sha256: "fixture" });
    expect(wb.sheets.map((s) => s.name)).toEqual(["Damages", "Lists"]);
    const [d, lists] = wb.sheets;
    expect(lists.hidden).toBe(true);
    expect(d.color).toBe("#C00000");
    // strings: shared, rich text flattened, inline, _xHHHH_ escape, entities
    expect(d.cells.A1).toMatchObject({ v: "Item", t: "s" });
    expect(d.cells.A2.v).toBe("Past medicals");
    expect(d.cells.E1.v).toBe("Status");
    expect(d.cells.A9.v).toBe("Tab\tsep & <done>");
    // numbers, dates, booleans, errors
    expect(d.cells.B2).toMatchObject({ v: 12500.5, t: "n" });
    expect(d.cells.D2).toMatchObject({ v: "2024-01-01", t: "d" });
    expect(d.cells.D3).toMatchObject({ v: "2024-02-01", t: "d" });
    expect(d.cells.A4).toMatchObject({ v: true, t: "b" });
    expect(d.cells.B4).toMatchObject({ v: "#N/A", t: "e" });
    // formulas: plain, string result, shared (expanded), array, future function prefix stripped, names
    expect(d.cells.B5.f).toBe("=SUM(B2:B3)");
    expect(d.cells.C4).toMatchObject({ f: '=A3&"!"', v: "Wage loss!" });
    expect([d.cells.C5.f, d.cells.C6.f, d.cells.C7.f]).toEqual(["=B2*C2", "=B3*C3", "=B4*C4"]);
    expect(d.cells.D8).toMatchObject({ f: "=SUM(B2:B3*C2:C3)", ar: "D8" });
    expect(d.cells.B9.f).toBe('=XLOOKUP("Wage loss",A2:A3,B2:B3)');
    // number formats and styles
    const st = (ref: string) => wb.styles[d.cells[ref].s!];
    expect(st("B2")).toMatchObject({ numFmt: '"$"#,##0.00', border: "thin" });
    expect(st("C2").numFmt).toBe("0.0%");
    expect(st("D2").numFmt).toBe("mmm d, yyyy");
    expect(st("D3").numFmt).toBe("m/d/yyyy");
    expect(st("A1")).toMatchObject({ bold: true, color: "#FFFFFF", fill: "#1F3A5F", border: "thin", align: "center", valign: "middle", wrap: true });
    expect(st("B5")).toMatchObject({ italic: true, numFmt: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)' });
    expect(st("B5").color).toMatch(/^#[0-9A-F]{6}$/); // theme 4 with tint
    expect(st("B5").fill).toMatch(/^#[0-9A-F]{6}$/);
    expect(st("A5")).toMatchObject({ underline: true, underlineStyle: "double", fontSize: 14, fontFamily: "Arial", color: "#C00000", indent: 2, align: "left", borders: { bottom: { style: "medium", color: "#FF0000" } } });
    expect(st("A9")).toMatchObject({ locked: false, borders: { top: { style: "double" } } });
    expect(formatNumber(20500.5, st("B5").numFmt)).toBe("$20,500.50");
    // sheet structure
    expect(d.colWidths.A).toBe(173);
    expect(d.colWidths.B).toBe(103);
    expect(d.colStyles?.B).toBe(d.cells.B2.s);
    expect(d.hiddenCols).toEqual(["F"]);
    expect(d.rowHeights["1"]).toBe(40);
    expect(d.hiddenRows).toEqual([4]);
    expect(d.defaultRowHeight).toBe(20);
    expect(d.defaultColWidth).toBe(64);
    expect(d.freeze).toEqual({ rows: 1, cols: 1 });
    expect(d.selection).toEqual({ activeCell: "C3", sqref: "C3:D4" });
    expect(d.view).toEqual({ showGridLines: false, zoom: 120 });
    expect(d.merges).toEqual(["A11:B11"]);
    expect(d.filters).toEqual({ range: "A1:E5", criteria: { E: { values: ["Open"] } } });
    // conditional formatting
    const kinds = d.conditionalFormats.map((c) => c.rule.kind);
    expect(kinds).toEqual(["gt", "expression", "colorScale", "dataBar", "raw", "contains"]);
    expect(d.conditionalFormats[0].style).toMatchObject({ fill: "#FFC7CE", color: "#9C0006" });
    expect(d.conditionalFormats[1]).toMatchObject({ rule: { kind: "expression", formula: "LEN(A2)>9" }, style: { bold: true, color: "#006100" } });
    expect(d.conditionalFormats[2].rule).toEqual({ kind: "colorScale", stops: [{ type: "min", color: "#F8696B" }, { type: "max", color: "#63BE7B" }] });
    expect(d.conditionalFormats[4].rule.kind === "raw" && d.conditionalFormats[4].rule.xml).toContain("3Arrows");
    // data validation
    expect(d.validations?.map(({ id: _i, ...v }) => { void _i; return v; })).toEqual([
      { range: "E2:E3", kind: "list", list: ["Open", "Closed"], allowBlank: true },
      { range: "A2:A3", kind: "list", listSource: "Lists!$A$1:$A$3", allowBlank: true },
      { range: "C2:C3", kind: "number", min: 0, max: 1, allowBlank: true, message: "Annual rate", promptTitle: "Rate", error: "Enter a rate between 0 and 1", errorTitle: "Rate" },
      { range: "B2:B3", kind: "custom", formula1: "ISNUMBER(B2)" },
    ]);
    // hyperlinks and notes
    expect(d.hyperlinks).toEqual([{ ref: "A2", target: "https://example.com/record?id=1&x=2", tooltip: "Source record" }, { ref: "A3", location: "'Lists'!A1", display: "Lists" }]);
    expect(d.notes).toEqual({ B5: { author: "Jane Roe", text: "Jane Roe: Check total against the expert report." } });
    // print settings
    expect(wb.pageSetup).toMatchObject({ orientation: "landscape", paper: "legal", gridlines: true, centerHorizontally: true, fitToPage: true, printArea: "A1:E20", repeatHeaderRows: 1, margins: { left: 0.5, right: 0.5, top: 1, bottom: 1 }, header: "Damages &[Page]", footer: "&LConfidential&RPage &P of &N" });
    // names
    expect(wb.namedRanges).toEqual({ Rate: "Damages!B10" });
    expect(d.localNames).toEqual({ LocalTotal: "Damages!C6" });
    expect(wb.extraNames).toEqual([{ name: "Statutory", value: "0.1" }]);
    // chart
    expect(d.charts).toHaveLength(1);
    expect(d.charts[0]).toMatchObject({ type: "bar", horizontal: true, title: "Damages by item", range: "B1:B3", categoryRange: "A2:A3", hasHeader: true, xlsx: { part: "xl/charts/chart1.xml" } });
    // provenance for package-preserving export
    expect(wb.xlsxSource?.sha256).toBe("fixture");
    expect(Object.values(wb.xlsxSource!.sheets).map((s) => s.part)).toEqual(["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
  });

  it("recalculates formulas to the cached values Excel stored", async () => {
    const wb = readXlsx(await fixtureBytes());
    const computed = computeWorkbook(wb);
    const [d, lists] = wb.sheets;
    const check = (sheet: typeof d, ref: string) => {
      const cached = sheet.cells[ref].v;
      const got = computed[sheet.id][ref].v;
      if (typeof cached === "number") expect(got, `${sheet.name}!${ref}`).toBeCloseTo(cached, 6);
      else expect(got, `${sheet.name}!${ref}`).toBe(cached);
    };
    for (const ref of ["B5", "C4", "C5", "C6", "C7", "D8", "B9", "B12", "C12"]) check(d, ref);
    check(lists, "B1");
    // formula-based conditional formats are evaluated by the engine and rendered
    const cf = conditionalStyles(d, computed);
    expect(cf.get("A2")?.bold).toBe(true); // LEN("Past medicals")>9
    expect(cf.get("A3")?.bold).toBeUndefined(); // "Wage loss" is 9 characters
    expect(cf.get("B2")?.fill).toBe("#FFC7CE"); // cellIs > 10000
    expect(cf.get("B3")?.bar?.pct).toBeGreaterThan(0);
    expect(cf.get("C2")?.fill).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("imports through importDocument with the direct reader and falls back to SheetJS for CSV", async () => {
    const r = await importDocument(await fixtureBytes(), "damages.xlsx");
    expect(r.meta).toMatchObject({ reader: "ooxml", sheets: 2 });
    const csv = await importDocument(new TextEncoder().encode("a,b\n1,2\n"), "x.csv");
    expect(csv.meta).toMatchObject({ reader: "sheetjs" });
  });
});

describe("xlsx writer — package-preserving round trip", () => {
  it("keeps every part byte-identical when nothing changed", async () => {
    const original = await fixtureBytes();
    const wb = readXlsx(original, { sha256: "x" });
    const { bytes, report } = exportXlsxWithReport(wb, { original });
    expect(report).toMatchObject({ mode: "preserve", rewritten: [] });
    const a = readZip(original), b = readZip(bytes);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [name, e] of a) {
      expect(Buffer.from(b.get(name)!.compressed).equals(Buffer.from(e.compressed)), `${name} compressed bytes`).toBe(true);
    }
  });

  it("stays byte-identical after the editor normalizes and JSON-round-trips the workbook", async () => {
    const original = await fixtureBytes();
    const stored = JSON.parse(JSON.stringify(normalizeWorkbook(readXlsx(original, { sha256: "x" }))));
    const { bytes, report } = exportXlsxWithReport(normalizeWorkbook(stored), { original });
    expect(report.rewritten).toEqual([]);
    expect(Buffer.from(bytes).equals(Buffer.from(exportXlsxWithReport(readXlsx(original, { sha256: "x" }), { original }).bytes))).toBe(true);
  });

  it("rewrites only the edited sheet; untouched parts stay byte-identical and the model round-trips", async () => {
    const original = await fixtureBytes();
    const wb = readXlsx(original, { sha256: "x" });
    const d = wb.sheets[0];
    const edited = applyOp(wb, { type: "set_cells", sheet: d.id, cells: [{ ref: "B3", value: 9000 }, { ref: "A6", value: "New line item" }] });
    const { bytes, report } = exportXlsxWithReport(edited, { original });
    expect(report.mode).toBe("preserve");
    expect(report.rewritten).toEqual(["xl/worksheets/sheet1.xml"]);
    const { zip, text } = checkPackage(bytes);
    const orig = readZip(original);
    const same = (n: string) => Buffer.from(entryBytes(zip.get(n)!)).equals(Buffer.from(entryBytes(orig.get(n)!)));
    for (const n of ["xl/theme/theme1.xml", "xl/styles.xml", "xl/sharedStrings.xml", "xl/worksheets/sheet2.xml", "xl/drawings/drawing1.xml", "xl/charts/chart1.xml", "xl/comments1.xml", "xl/drawings/vmlDrawing1.vml", "xl/tables/table1.xml", "xl/printerSettings/printerSettings1.bin", "customXml/item1.xml", "docProps/core.xml", "docProps/app.xml", "xl/workbook.xml", "xl/worksheets/_rels/sheet1.xml.rels"]) {
      expect(same(n), `${n} byte-identical`).toBe(true);
    }
    // stale calc chain dropped consistently
    expect(zip.has("xl/calcChain.xml")).toBe(false);
    expect(text("xl/_rels/workbook.xml.rels")).not.toContain("calcChain");
    expect(text("[Content_Types].xml")).not.toContain("calcChain");
    // unmodeled worksheet elements survive in the rewritten sheet, in schema order
    const s1 = text("xl/worksheets/sheet1.xml");
    for (const tag of ["<sheetProtection", "<tableParts", "<extLst", '<drawing r:id="rId1"/>', '<legacyDrawing r:id="rId2"/>', "<outlinePr", 'r:id="rId4"']) expect(s1).toContain(tag);
    const order = ["<sheetPr", "<dimension", "<sheetViews", "<sheetFormatPr", "<cols", "<sheetData", "<sheetProtection", "<autoFilter", "<mergeCells", "<conditionalFormatting", "<dataValidations", "<hyperlinks", "<printOptions", "<pageMargins", "<pageSetup", "<headerFooter", "<drawing", "<legacyDrawing", "<tableParts", "<extLst"].map((t) => s1.indexOf(t));
    expect(order.every((p, i) => p >= 0 && (i === 0 || p > order[i - 1]))).toBe(true);
    // rich text shared string reused, new string written inline
    expect(s1).toMatch(/<c r="A2" t="s"><v>4<\/v><\/c>/);
    expect(s1).toMatch(/<c r="A6" t="inlineStr"><is><t xml:space="preserve">New line item<\/t><\/is><\/c>/);
    // re-import equals the edited model
    const back = readXlsx(bytes);
    expect(canon(back)).toEqual(canon(edited));
    // SheetJS reads the rewritten package too
    const book = XLSX.read(bytes, { type: "array", cellFormula: true });
    expect(book.Sheets.Damages.B3.v).toBe(9000);
    expect(book.Sheets.Damages.B5.v).toBe(21500.5);
  });

  it("appends new styles without disturbing original cellXfs", async () => {
    const original = await fixtureBytes();
    const wb = readXlsx(original);
    const edited = applyOp(wb, { type: "style_range", sheet: wb.sheets[0].id, range: "G2:H2", style: { bold: true, fill: "#FFF2CC", numFmt: "#,##0.000" } });
    const { bytes } = exportXlsxWithReport(edited, { original });
    const { text } = checkPackage(bytes);
    const before = FIXTURE["xl/styles.xml"] as string;
    const after = text("xl/styles.xml");
    const xfs = (x: string) => x.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)![1];
    expect(xfs(after).startsWith(xfs(before))).toBe(true);
    expect(after).toContain('formatCode="#,##0.000"');
    expect(after).toMatch(/<cellXfs count="11">/);
    expect(after).toContain("<gradientFill"); // unmodeled fill kept
    const back = readXlsx(bytes);
    expect(back.styles[back.sheets[0].cells.G2.s!]).toMatchObject({ bold: true, fill: "#FFF2CC", numFmt: "#,##0.000" });
    expect(canon(back)).toEqual(canon(edited));
  });

  it("adds a chart next to the imported one and keeps the drawing's shapes", async () => {
    const original = await fixtureBytes();
    const wb = readXlsx(original);
    const edited = applyOp(wb, { type: "add_chart", sheet: wb.sheets[0].id, chart: { type: "line", title: "Rates", range: "C1:C3", categoryRange: "A2:A3" } });
    const { bytes } = exportXlsxWithReport(edited, { original });
    const { zip, text } = checkPackage(bytes);
    const orig = readZip(original);
    expect(Buffer.from(entryBytes(zip.get("xl/charts/chart1.xml")!)).equals(Buffer.from(entryBytes(orig.get("xl/charts/chart1.xml")!)))).toBe(true);
    expect(zip.has("xl/charts/chart2.xml")).toBe(true);
    const drawing = text("xl/drawings/drawing1.xml");
    expect(drawing).toContain("Draft - privileged");
    expect((drawing.match(/<c:chart /g) ?? []).length).toBe(2);
    const back = readXlsx(bytes);
    expect(back.sheets[0].charts.map((c) => [c.type, c.title, c.range])).toEqual([["bar", "Damages by item", "B1:B3"], ["line", "Rates", "C1:C3"]]);
  });

  it("rewrites the workbook part for sheet and name changes, keeping unmodeled names", async () => {
    const original = await fixtureBytes();
    const wb = readXlsx(original);
    const edited = wbWith([
      { type: "rename_sheet", sheet: wb.sheets[0].id, name: "Damages Model" },
      { type: "add_sheet", name: "Notes", id: "sh_new" },
      { type: "set_cells", sheet: "sh_new", cells: [{ ref: "A1", value: "Memo" }, { ref: "A2", formula: "='Damages Model'!B5*2" }] },
      { type: "add_named_range", name: "Total", ref: "'Damages Model'!B5" },
    ], wb);
    const { bytes, report } = exportXlsxWithReport(edited, { original });
    expect(report.mode).toBe("preserve");
    const { text } = checkPackage(bytes);
    const wbx = text("xl/workbook.xml");
    expect(wbx).toContain('name="Damages Model"');
    expect(wbx).toContain('<definedName name="Statutory">0.1</definedName>');
    expect(wbx).toContain("<fileVersion"); // unmodeled workbook children kept
    expect(wbx).toContain(`<definedName name="Total">'Damages Model'!$B$5</definedName>`);
    const back = readXlsx(bytes);
    expect(back.sheets.map((s) => s.name)).toEqual(["Damages Model", "Lists", "Notes"]);
    expect(computeWorkbook(back)[back.sheets[2].id].A2.v).toBeCloseTo(41001, 6);
    expect(canon(back)).toEqual(canon(edited));
  });

  it("regenerates notes when they change and deletes sheets cleanly", async () => {
    const original = await fixtureBytes();
    const wb = readXlsx(original);
    const d = wb.sheets[0];
    const edited: Workbook = { ...wb, sheets: [{ ...d, notes: { ...d.notes, C2: { author: "LeClaude", text: "Rate per statute" } } }, wb.sheets[1]] };
    const withoutLists = applyOp(edited, { type: "delete_sheet", sheet: wb.sheets[1].id });
    const { bytes } = exportXlsxWithReport(withoutLists, { original });
    const { zip, text } = checkPackage(bytes);
    expect(zip.has("xl/worksheets/sheet2.xml")).toBe(false);
    expect(text("xl/workbook.xml")).not.toContain('name="Lists"');
    const back = readXlsx(bytes);
    expect(back.sheets[0].notes).toEqual({ B5: { author: "Jane Roe", text: "Jane Roe: Check total against the expert report." }, C2: { author: "LeClaude", text: "Rate per statute" } });
    expect(canon(back)).toEqual(canon(withoutLists));
  });

  it("falls back to a fresh package when the original bytes are not a package", async () => {
    const wb = readXlsx(await fixtureBytes());
    const { bytes, report } = exportXlsxWithReport(wb, { original: new Uint8Array([1, 2, 3]) });
    expect(report.mode).toBe("fresh");
    checkPackage(bytes);
    expect(canon(readXlsx(bytes))).toEqual(canon(wb));
  });
});

describe("xlsx writer — new workbooks", () => {
  function featureWorkbook(): Workbook {
    let wb = wbWith([
      { type: "build_table", anchor: "A1", headers: ["Claimant", "Amount", "Settled", "Status"], rows: [["Oberoi", 125000, "2026-07-02", "Open"], ["Alvarez", 350000, "2026-08-14", "Closed"], ["Nguyen", -4200.25, "2026-09-01", "Open"]], total_row: true, number_format: "$#,##0.00" },
      { type: "set_cells", cells: [{ ref: "F1", value: "Rate" }, { ref: "G1", value: 0.075, style: { numFmt: "0.00%" } }, { ref: "F2", value: "Interest" }, { ref: "G2", formula: "=B5*G1" }, { ref: "F3", value: "Flag" }, { ref: "G3", value: true }, { ref: "F4", value: "Line\nbreak & <tag>" }, { ref: "G4", formula: "=XLOOKUP(\"Nguyen\",A2:A4,B2:B4)" }, { ref: "H1", formula: "=SUM(B2:B4*1)" }] },
      { type: "style_range", range: "F1:F4", style: { italic: true, color: "#9F1239", fill: "#FDE2E1", align: "right", valign: "top", wrap: true, fontSize: 13, fontFamily: "Georgia", underline: true, strike: true } },
      { type: "style_range", range: "A7", style: { borders: { top: { style: "dashed", color: "#1F3A5F" }, bottom: { style: "double" } }, indent: 1, locked: false, hideFormula: true, rotation: 45 } },
      { type: "merge_cells", range: "A8:C8" },
      { type: "set_cells", cells: [{ ref: "A8", value: "Merged title" }] },
      { type: "set_column_width", columns: ["A"], width: 180 },
      { type: "set_row_height", rows: [7], height: 32 },
      { type: "freeze_panes", rows: 1, cols: 1 },
      { type: "add_filter", range: "A1:D4" },
      { type: "set_filter_criteria", column: "D", criteria: { values: ["Open"] } },
      { type: "conditional_format", range: "B2:B4", rule: { kind: "gt", value: 200000 }, style: { fill: "#FDE2E1", color: "#9F1239" }, id: "cf1" },
      { type: "conditional_format", range: "C2:C4", rule: { kind: "dueBefore", date: "today", days: 7 }, style: { bold: true }, id: "cf2" },
      { type: "conditional_format", range: "D2:D4", rule: { kind: "contains", text: "Open" }, style: { fill: "#E2F0D9" }, id: "cf3" },
      { type: "conditional_format", range: "B2:B4", rule: { kind: "between", min: 0, max: 200000 }, style: { italic: true }, id: "cf4" },
      { type: "conditional_format", range: "A2:A4", rule: { kind: "duplicate" }, style: { bold: true }, id: "cf5" },
      { type: "conditional_format", range: "B2:B4", rule: { kind: "top", count: 1, bottom: true }, style: { color: "#FF0000" }, id: "cf6" },
      { type: "conditional_format", range: "D2:D4", rule: { kind: "eq", value: "Closed" }, style: { strike: true }, id: "cf7" },
      { type: "conditional_format", range: "A2:A4", rule: { kind: "blank" }, style: { fill: "#EEEEEE" }, id: "cf8" },
      { type: "conditional_format", range: "B2:B4", rule: { kind: "expression", formula: "AND(B2>0,B2<$G$2*100)" }, style: { bold: true }, id: "cf9" },
      { type: "conditional_format", range: "B2:B4", rule: { kind: "colorScale", stops: [{ type: "min", color: "#F8696B" }, { type: "percentile", value: "50", color: "#FFEB84" }, { type: "max", color: "#63BE7B" }] }, style: {}, id: "cf10" },
      { type: "conditional_format", range: "G1:G2", rule: { kind: "dataBar", color: "#638EC6" }, style: {}, id: "cf11" },
      { type: "add_validation", range: "D2:D4", kind: "list", list: ["Open", "Closed"], message: "Pick a status", id: "v1" },
      { type: "add_validation", range: "B2:B4", kind: "number", min: 0, max: 1_000_000, id: "v2" },
      { type: "add_named_range", name: "InterestRate", ref: "G1" },
      { type: "add_sheet", name: "Depo Schedule", id: "sh_2" },
      { type: "set_cells", sheet: "sh_2", cells: [{ ref: "A1", value: "Witness" }, { ref: "B1", formula: "=Sheet1!B5+InterestRate" }, { ref: "A2", value: "2026-10-01" }] },
      { type: "set_sheet_color", sheet: "sh_2", color: "#1F3A5F" },
      { type: "set_active_sheet", sheet: "Sheet1" },
      { type: "set_page_setup", patch: { orientation: "landscape", paper: "a4", fitToPage: true, gridlines: true, printArea: "A1:G8" } },
    ]);
    wb = applyOp(wb, { type: "add_chart", chart: { type: "bar", title: "Amounts", range: "B1:B4", categoryRange: "A2:A4", stacked: true, position: { x: 700, y: 20, w: 420, h: 260 } } });
    wb = applyOp(wb, { type: "add_chart", chart: { type: "pie", title: "Share", range: "B1:B3", categoryRange: "A2:A3" } });
    const s = wb.sheets[0];
    return {
      ...wb,
      sheets: [{
        ...s, hiddenRows: [6], hiddenCols: ["E"], selection: { activeCell: "B2", sqref: "B2:C3" }, view: { showGridLines: false, zoom: 90 },
        hyperlinks: [{ ref: "A2", target: "https://courtlistener.com/?q=okafor", tooltip: "Docket" }, { ref: "A3", location: "'Depo Schedule'!A1" }],
        notes: { B2: { author: "Associate", text: "Confirm against the release" } },
        localNames: { LocalRate: "Sheet1!G1" },
        colStyles: { H: s.cells.G1.s! },
      }, { ...wb.sheets[1], hidden: true, pageSetup: { orientation: "portrait" } }],
    };
  }

  it("writes a complete package that re-imports to the same model", () => {
    const wb = featureWorkbook();
    const bytes = exportXlsx(wb);
    checkPackage(bytes);
    const back = readXlsx(bytes);
    expect(canon(back)).toEqual(canon(wb));
    // charts keep their geometry (within anchor rounding)
    for (const [i, c] of wb.sheets[0].charts.entries()) {
      const b = back.sheets[0].charts[i].position;
      expect(Math.abs(b.x - c.position.x) + Math.abs(b.y - c.position.y) + Math.abs(b.w - c.position.w) + Math.abs(b.h - c.position.h)).toBeLessThanOrEqual(4);
    }
    // cached values come from the engine
    const computed = computeWorkbook(wb);
    expect(back.sheets[0].cells.G2.v).toBeCloseTo(computed[wb.sheets[0].id].G2.v as number, 9);
    expect(back.sheets[0].cells.G4.v).toBe(-4200.25);
  });

  it("is readable by an independent reader (SheetJS) with values, formulas and formats", () => {
    const bytes = exportXlsx(featureWorkbook());
    const book = XLSX.read(bytes, { type: "array", cellFormula: true, cellNF: true, cellStyles: true });
    expect(book.SheetNames).toEqual(["Sheet1", "Depo Schedule"]);
    const s = book.Sheets.Sheet1;
    expect(s.B2.v).toBe(125000);
    expect(s.B2.z).toBe("$#,##0.00");
    expect(s.G2.f).toBe("B5*G1");
    expect(s.G4.f).toBe('XLOOKUP("Nguyen",A2:A4,B2:B4)');
    expect(new TextDecoder().decode(entryBytes(readZip(bytes).get("xl/worksheets/sheet1.xml")!))).toContain("<f>_xlfn.XLOOKUP(");
    expect(s.F4.v).toBe("Line\nbreak & <tag>");
    expect(s["!merges"]?.length).toBe(1);
    expect(book.Workbook?.Names?.some((n) => n.Name === "InterestRate")).toBe(true);
  });

  it("writes dates as serials with a date format and preserves text that looks numeric", () => {
    const wb = wbWith([{ type: "set_cells", cells: [{ ref: "A1", value: "2026-03-15" }, { ref: "A2", value: "00123", type: "s" }, { ref: "A3", value: "#N/A", type: "e" }] }]);
    const bytes = exportXlsx(wb);
    const xml = new TextDecoder().decode(entryBytes(readZip(bytes).get("xl/worksheets/sheet1.xml")!));
    expect(xml).toMatch(/<c r="A1" s="\d+"><v>46096<\/v><\/c>/);
    expect(xml).toMatch(/<c r="A3" t="e"><v>#N\/A<\/v><\/c>/);
    const back = readXlsx(bytes);
    expect(back.sheets[0].cells.A1).toMatchObject({ v: "2026-03-15", t: "d" });
    expect(back.sheets[0].cells.A2).toMatchObject({ v: "00123", t: "s" });
    expect(back.sheets[0].cells.A3).toMatchObject({ v: "#N/A", t: "e" });
  });
});
