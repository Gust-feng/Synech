import { promises as fs } from "node:fs";
import readExcelFile, { type Sheet } from "read-excel-file/node";
import { throwIfAborted } from "./local-workspace-common.js";

export type ParsedTableRow = {
  readonly rowNumber: number;
  readonly cells: readonly string[];
};

export type ParsedSpreadsheetTable = {
  readonly kind: "xlsx";
  readonly sheetName: string;
  readonly sheetIndex: number;
  readonly sheets: readonly string[];
  readonly rows: readonly ParsedTableRow[];
};

export async function readXlsxTable(
  absolutePath: string,
  options: {
    readonly sheetName?: string;
    readonly sheetIndex?: number;
    readonly abortSignal?: AbortSignal;
  },
): Promise<
  | { readonly supported: true; readonly table: ParsedSpreadsheetTable }
  | { readonly supported: false; readonly reason: string }
> {
  throwIfAborted(options.abortSignal);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absolutePath, { signal: options.abortSignal });
  } catch (error) {
    throwIfAborted(options.abortSignal);
    return { supported: false, reason: "spreadsheet_file_unreadable" };
  }
  throwIfAborted(options.abortSignal);
  const sheets = await readExcelFile(buffer);
  throwIfAborted(options.abortSignal);
  if (sheets.length === 0) {
    return { supported: false, reason: "xlsx_no_sheets" };
  }
  const selected = selectSheet(sheets, options);
  if (selected === undefined) {
    return { supported: false, reason: "xlsx_sheet_not_found" };
  }
  return {
    supported: true,
    table: {
      kind: "xlsx",
      sheetName: selected.sheet,
      sheetIndex: sheets.indexOf(selected) + 1,
      sheets: sheets.map((sheet) => sheet.sheet),
      rows: spreadsheetRows(selected.data),
    },
  };
}

export function xlsxReadErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]+$/u.test(message) ? message : "xlsx_parse_failed";
}

function selectSheet(
  sheets: readonly Sheet[],
  options: { readonly sheetName?: string; readonly sheetIndex?: number },
): Sheet | undefined {
  if (options.sheetName !== undefined) {
    const requested = options.sheetName.toLowerCase();
    return sheets.find((sheet) => sheet.sheet.toLowerCase() === requested);
  }
  return sheets[(options.sheetIndex ?? 1) - 1];
}

function spreadsheetRows(data: Sheet["data"]): readonly ParsedTableRow[] {
  return data
    .map((cells, index): ParsedTableRow => ({
      rowNumber: index + 1,
      cells: cells.map(spreadsheetCellText),
    }))
    .filter((row) => row.cells.some((cell) => cell.length > 0));
}

function spreadsheetCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error("xlsx_cell_value_invalid");
}
