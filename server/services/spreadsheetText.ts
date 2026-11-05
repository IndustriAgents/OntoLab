import { read, utils } from "xlsx";
import { HttpError } from "../http.ts";
import { serializeBlocks, type Block, type StructuredText } from "./structuredText.ts";

/** Retain sheet names and displayed cell values as sections and evidence tables. */
export function spreadsheetText(name: string, bytes: Buffer): StructuredText & { warnings: string[] } {
  try {
    // SheetJS also accepts plain text. Require an Excel container so renamed
    // CSV/text files and broken uploads do not silently become workbooks.
    const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const ole = bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    if (/\.xlsx$/i.test(name) ? !zip : !ole) throw new Error("Invalid Excel container");
    const workbook = read(bytes, { type: "buffer", dense: true, cellFormula: true });
    const blocks: Block[] = [];
    const warnings: string[] = [];
    let cells = 0;
    let uncachedFormula = false;
    for (const title of workbook.SheetNames) {
      const sheet = workbook.Sheets[title];
      if (!sheet?.["!ref"]) continue;
      const range = utils.decode_range(sheet["!ref"]);
      const height = range.e.r - range.s.r + 1;
      const width = range.e.c - range.s.c + 1;
      cells += height * width;
      // Bound expansion of sparse or incorrectly declared worksheet ranges.
      if (height > 100_000 || width > 1024 || cells > 1_000_000)
        throw new HttpError(422, `${name}: workbook is too large to extract. Split it into smaller worksheets or files.`);
      for (const row of sheet["!data"] ?? []) {
        if (row?.some((cell) => cell?.f && cell.v == null)) uncachedFormula = true;
      }
      const rows = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
      if (!rows.some((row) => row.some((cell) => cell.trim()))) continue;
      blocks.push({ kind: "heading", text: title, level: 1 }, { kind: "table", text: "", rows });
    }
    if (uncachedFormula)
      warnings.push("Some formulas have no saved result. Recalculate and save the workbook in Excel, then upload it again.");
    return { ...serializeBlocks(blocks), warnings };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, `Could not read ${name}. Upload a valid, unencrypted Excel workbook (.xlsx or .xls).`);
  }
}
