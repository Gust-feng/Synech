import { stringOrUndefined } from "../../../kernel/values/index.js";
import type { OrdinaryRunContextReference } from "../../../domain/ordinary/index.js";
import type { ToolExecutor } from "../../../domain/tools/index.js";
import {
  asRecord,
  MAX_LOCAL_WORKSPACE_FILE_BYTES,
  positiveInteger,
  safeRefToken,
  throwIfAborted,
  truncateText,
} from "./local-workspace-common.js";
import { fileHasNulByte } from "./context-attachment-files.js";
import { readAttachmentTextFile } from "./context-attachment-text.js";
import {
  assertAttachmentAuthorized,
  attachmentTitle,
  isSupportedSpreadsheetTarget,
  requireAttachmentEntry,
  resolveAttachmentTarget,
  statAttachmentTarget,
  tableTargetExtension,
  tableTargetFormat,
  type AttachmentEntry,
  type AttachmentTarget,
  type ContextAttachmentToolOptions,
} from "./context-attachment-access.js";
import {
  readXlsxTable,
  xlsxReadErrorReason,
  type ParsedSpreadsheetTable,
  type ParsedTableRow,
} from "./context-attachment-xlsx.js";

const MAX_TABLE_SAMPLE_ROWS = 20;
const DEFAULT_TABLE_SAMPLE_ROWS = 5;
const MAX_TABLE_READ_ROWS = 200;
const DEFAULT_TABLE_READ_ROWS = 50;
const MAX_TABLE_CELL_CHARS = 500;
const MAX_SPREADSHEET_BYTES = 8 * 1024 * 1024;

type TableDelimiter = {
  readonly kind: "comma" | "tab" | "semicolon";
  readonly char: "," | "\t" | ";";
};

type ParsedDelimitedTable = {
  readonly kind: "delimited";
  readonly delimiter: TableDelimiter;
  readonly rows: readonly ParsedTableRow[];
};

type ParsedAttachmentTable = ParsedDelimitedTable | ParsedSpreadsheetTable;
export function createInspectContextAttachmentTableTool(options: ContextAttachmentToolOptions = {}): ToolExecutor {
  return {
    definition: {
      name: "AttachmentInspectTable",
      description: "Inspect a CSV, TSV, or XLSX context attachment and return sheet, column, row-count, and sample-row facts.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          attachmentId: { type: "string", description: "Attachment id from the current run context, preferred over ref." },
          ref: { type: "string", description: "Exact non-local context ref when attachmentId is unavailable." },
          path: { type: "string", description: "Relative table path inside a project attachment." },
          sheetName: { type: "string", description: "XLSX sheet name to inspect. Defaults to the first sheet." },
          sheetIndex: { type: "number", description: "1-based XLSX sheet index to inspect when sheetName is not provided." },
          sampleRows: { type: "number", description: "Number of sample data rows to return. Defaults to 5 and is capped." },
          headerRow: { type: "boolean", description: "Whether the first row should be treated as column headers. Defaults to true." },
        },
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const entry = requireAttachmentEntry(options.runContext, record);
      assertAttachmentAuthorized(entry);
      const target = await resolveAttachmentTarget({
        entry,
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
        requestedPath: stringOrUndefined(record.path),
        requireFile: true,
        projectPathRequired: true,
        resolveManagedAttachmentPath: options.resolveManagedAttachmentPath,
        readAuthorization: options.readAuthorization,
      });
      const table = await loadTableTarget(entry, target, {
        sheetName: stringOrUndefined(record.sheetName),
        sheetIndex: positiveInteger(record.sheetIndex),
        abortSignal: context.abortSignal,
      });
      if (!table.supported) {
        return unsupportedTableResult({
          entry,
          target,
          reason: table.reason,
          bytes: table.bytes,
        });
      }
      const headerRow = booleanOrDefault(record.headerRow, true);
      const sampleRows = Math.min(MAX_TABLE_SAMPLE_ROWS, positiveInteger(record.sampleRows) ?? DEFAULT_TABLE_SAMPLE_ROWS);
      const tableFacts = tableFactsFromRows(table.parsed.rows, { headerRow });
      const samples = tableRowsForModel({
        rows: table.parsed.rows,
        columns: tableFacts.columns,
        startRow: tableFacts.dataStartRow,
        rowCount: sampleRows,
        includeRecord: headerRow,
      });
      return {
        refId: `context-attachment:${entry.attachmentId}:table:${safeRefToken(target.targetPath)}`,
        attachmentId: entry.attachmentId,
        kind: entry.ref.kind,
        title: attachmentTitle(entry),
        path: target.targetPath,
        mimeType: entry.ref.metadata?.mimeType,
        bytes: table.bytes,
        table: true,
        format: table.parsed.kind,
        delimiter: table.parsed.kind === "delimited" ? table.parsed.delimiter.kind : undefined,
        sheetName: table.parsed.kind === "xlsx" ? table.parsed.sheetName : undefined,
        sheetIndex: table.parsed.kind === "xlsx" ? table.parsed.sheetIndex : undefined,
        sheets: table.parsed.kind === "xlsx" ? table.parsed.sheets : undefined,
        headerRow,
        totalRows: tableFacts.totalRows,
        dataRows: tableFacts.dataRows,
        columnCount: tableFacts.columnCount,
        columns: tableFacts.columns,
        sampleRows: samples,
      };
    },
  };
}

export function createReadContextAttachmentTableTool(options: ContextAttachmentToolOptions = {}): ToolExecutor {
  return {
    definition: {
      name: "AttachmentReadTable",
      description: "Read a bounded row window from a CSV, TSV, or XLSX context attachment as structured table rows.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          attachmentId: { type: "string", description: "Attachment id from the current run context, preferred over ref." },
          ref: { type: "string", description: "Exact non-local context ref when attachmentId is unavailable." },
          path: { type: "string", description: "Relative table path inside a project attachment." },
          sheetName: { type: "string", description: "XLSX sheet name to read. Defaults to the first sheet." },
          sheetIndex: { type: "number", description: "1-based XLSX sheet index to read when sheetName is not provided." },
          startRow: { type: "number", description: "1-based physical row number to start from. Defaults to 2 when headerRow=true, otherwise 1." },
          rowCount: { type: "number", description: "Number of rows to return. Defaults to 50 and is capped." },
          headerRow: { type: "boolean", description: "Whether the first row should be treated as column headers. Defaults to true." },
        },
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const entry = requireAttachmentEntry(options.runContext, record);
      assertAttachmentAuthorized(entry);
      const target = await resolveAttachmentTarget({
        entry,
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
        requestedPath: stringOrUndefined(record.path),
        requireFile: true,
        projectPathRequired: true,
        resolveManagedAttachmentPath: options.resolveManagedAttachmentPath,
        readAuthorization: options.readAuthorization,
      });
      const table = await loadTableTarget(entry, target, {
        sheetName: stringOrUndefined(record.sheetName),
        sheetIndex: positiveInteger(record.sheetIndex),
        abortSignal: context.abortSignal,
      });
      if (!table.supported) {
        return unsupportedTableResult({
          entry,
          target,
          reason: table.reason,
          bytes: table.bytes,
        });
      }
      const headerRow = booleanOrDefault(record.headerRow, true);
      const rowCount = Math.min(MAX_TABLE_READ_ROWS, positiveInteger(record.rowCount) ?? DEFAULT_TABLE_READ_ROWS);
      const startRow = positiveInteger(record.startRow) ?? (headerRow ? 2 : 1);
      const tableFacts = tableFactsFromRows(table.parsed.rows, { headerRow });
      const rows = tableRowsForModel({
        rows: table.parsed.rows,
        columns: tableFacts.columns,
        startRow,
        rowCount,
        includeRecord: headerRow,
      });
      const actualEndRow = rows.length === 0 ? startRow : rows[rows.length - 1]!.rowNumber;
      const hasMoreAfter = table.parsed.rows.some((row) => row.rowNumber > actualEndRow);
      const nextStartRow = hasMoreAfter ? actualEndRow + 1 : undefined;
      const continuation = nextStartRow === undefined
        ? undefined
        : {
            nextInput: compactRecord({
              attachmentId: entry.attachmentId,
              path: target.targetPath,
              sheetName: table.parsed.kind === "xlsx" ? table.parsed.sheetName : undefined,
              sheetIndex: table.parsed.kind === "xlsx" ? table.parsed.sheetIndex : undefined,
              startRow: nextStartRow,
              rowCount,
              headerRow,
            }),
            note: "Continue attachment_read_table with the same attachment/path/sheet/header settings and startRow.",
          };
      const facts = {
        attachmentId: entry.attachmentId,
        kind: entry.ref.kind,
        title: attachmentTitle(entry),
        path: target.targetPath,
        mimeType: entry.ref.metadata?.mimeType,
        bytes: table.bytes,
        table: true,
        format: table.parsed.kind,
        delimiter: table.parsed.kind === "delimited" ? table.parsed.delimiter.kind : undefined,
        sheetName: table.parsed.kind === "xlsx" ? table.parsed.sheetName : undefined,
        sheetIndex: table.parsed.kind === "xlsx" ? table.parsed.sheetIndex : undefined,
        sheets: table.parsed.kind === "xlsx" ? table.parsed.sheets : undefined,
        headerRow,
        totalRows: tableFacts.totalRows,
        dataRows: tableFacts.dataRows,
        columnCount: tableFacts.columnCount,
        columns: tableFacts.columns,
        startRow,
        requestedRowCount: rowCount,
        rowCount,
        rows,
        rowsReturned: rows.length,
        hasMoreBefore: startRow > 1,
        hasMoreAfter,
      };
      return {
        refId: `context-attachment:${entry.attachmentId}:table:${safeRefToken(target.targetPath)}:${startRow}`,
        ...facts,
        continuation,
        truncated: hasMoreAfter,
      };
    },
  };
}

async function loadTableTarget(
  entry: AttachmentEntry,
  target: AttachmentTarget,
  options: {
    readonly sheetName?: string;
    readonly sheetIndex?: number;
    readonly abortSignal?: AbortSignal;
  }
): Promise<
  | { readonly supported: true; readonly parsed: ParsedAttachmentTable; readonly bytes: number }
  | { readonly supported: false; readonly reason: string; readonly bytes?: number }
> {
  const stat = await statAttachmentTarget(target.targetAbsolutePath, "Attachment table target could not be read.");
  if (!stat.isFile()) {
    return { supported: false, reason: "not_a_file", bytes: stat.size };
  }
  const format = tableTargetFormat(entry.ref, target.targetPath);
  if (format === "pdf") {
    return { supported: false, reason: "unsupported_pdf", bytes: stat.size };
  }
  if (format === "image") {
    return { supported: false, reason: "unsupported_image", bytes: stat.size };
  }
  if (format === "spreadsheet") {
    if (!isSupportedSpreadsheetTarget(entry.ref, target.targetPath)) {
      return { supported: false, reason: "unsupported_spreadsheet", bytes: stat.size };
    }
    if (stat.size > MAX_SPREADSHEET_BYTES) {
      return { supported: false, reason: "spreadsheet_file_too_large", bytes: stat.size };
    }
    const parsed = await readXlsxTable(target.targetAbsolutePath, options).catch((error: unknown) => {
      throwIfAborted(options.abortSignal);
      return { supported: false as const, reason: xlsxReadErrorReason(error) };
    });
    throwIfAborted(options.abortSignal);
    return parsed.supported
      ? { supported: true, parsed: parsed.table, bytes: stat.size }
      : { supported: false, reason: parsed.reason, bytes: stat.size };
  }
  if (format === "archive") {
    return { supported: false, reason: "unsupported_archive", bytes: stat.size };
  }
  if (stat.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
    return { supported: false, reason: "table_file_too_large", bytes: stat.size };
  }
  if (await fileHasNulByte(target.targetAbsolutePath, stat.size)) {
    return { supported: false, reason: "binary_or_unsupported_text_format", bytes: stat.size };
  }
  const raw = await readAttachmentTextFile(target.targetAbsolutePath);
  const delimiter = delimiterForTableTarget(entry.ref, target.targetPath, raw);
  if (delimiter === undefined) {
    return { supported: false, reason: "unsupported_non_table_text", bytes: stat.size };
  }
  return {
    supported: true,
    parsed: {
      kind: "delimited",
      delimiter,
      rows: parseDelimitedRows(raw, delimiter.char),
    },
    bytes: stat.size,
  };
}

function unsupportedTableResult(input: {
  readonly entry: AttachmentEntry;
  readonly target: AttachmentTarget;
  readonly reason: string;
  readonly bytes?: number;
}): Readonly<Record<string, unknown>> {
  return {
    refId: `context-attachment:${input.entry.attachmentId}:table:${safeRefToken(input.target.targetPath)}`,
    attachmentId: input.entry.attachmentId,
    kind: input.entry.ref.kind,
    title: attachmentTitle(input.entry),
    path: input.target.targetPath,
    mimeType: input.entry.ref.metadata?.mimeType,
    bytes: input.bytes,
    table: false,
    format: tableTargetFormat(input.entry.ref, input.target.targetPath),
    readable: false,
    reason: input.reason,
  };
}

function tableFactsFromRows(
  rows: readonly ParsedTableRow[],
  options: { readonly headerRow: boolean }
): {
  readonly totalRows: number;
  readonly dataRows: number;
  readonly dataStartRow: number;
  readonly columnCount: number;
  readonly columns: readonly string[];
} {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const header = options.headerRow ? rows[0]?.cells : undefined;
  const columns = header === undefined
    ? generatedColumns(columnCount)
    : normalizedColumns(header, columnCount);
  return {
    totalRows: rows.length,
    dataRows: options.headerRow ? Math.max(0, rows.length - 1) : rows.length,
    dataStartRow: options.headerRow ? (rows[0]?.rowNumber ?? 1) + 1 : (rows[0]?.rowNumber ?? 1),
    columnCount,
    columns,
  };
}

function tableRowsForModel(input: {
  readonly rows: readonly ParsedTableRow[];
  readonly columns: readonly string[];
  readonly startRow: number;
  readonly rowCount: number;
  readonly includeRecord: boolean;
}): readonly {
  readonly rowNumber: number;
  readonly values: readonly string[];
  readonly record?: Readonly<Record<string, string>>;
}[] {
  return input.rows.filter((row) => row.rowNumber >= input.startRow).slice(0, input.rowCount).map((row) => {
    const values = normalizedRowValues(row.cells, Math.max(input.columns.length, row.cells.length));
    return {
      rowNumber: row.rowNumber,
      values,
      record: input.includeRecord ? rowRecord(input.columns, values) : undefined,
    };
  });
}

function normalizedRowValues(row: readonly string[], columnCount: number): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    values.push(truncateText(row[index] ?? "", MAX_TABLE_CELL_CHARS));
  }
  return values;
}

function rowRecord(columns: readonly string[], values: readonly string[]): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  for (let index = 0; index < Math.max(columns.length, values.length); index += 1) {
    record[columns[index] ?? `column_${index + 1}`] = values[index] ?? "";
  }
  return record;
}

function normalizedColumns(header: readonly string[], columnCount: number): readonly string[] {
  const result: string[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < columnCount; index += 1) {
    const raw = truncateText((header[index] ?? "").trim(), 120);
    const base = safeColumnName(raw.length === 0 ? `column_${index + 1}` : raw);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.push(count === 0 ? base : `${base}_${count + 1}`);
  }
  return result;
}

function generatedColumns(columnCount: number): readonly string[] {
  return Array.from({ length: columnCount }, (_value, index) => `column_${index + 1}`);
}

function safeColumnName(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim() || "column";
}

function parseDelimitedRows(raw: string, delimiter: "," | "\t" | ";"): readonly ParsedTableRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "\"") {
      if (inQuotes && raw[index + 1] === "\"") {
        field += "\"";
        index += 2;
        continue;
      }
      inQuotes = !inQuotes;
      index += 1;
      continue;
    }
    if (!inQuotes && char === delimiter) {
      row.push(stripBomIfFirstCell(field, rows.length, row.length));
      field = "";
      index += 1;
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      row.push(stripBomIfFirstCell(field, rows.length, row.length));
      rows.push(row);
      row = [];
      field = "";
      if (char === "\r" && raw[index + 1] === "\n") {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    field += char;
    index += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(stripBomIfFirstCell(field, rows.length, row.length));
    rows.push(row);
  }
  return rows
    .map((cells, index): ParsedTableRow => ({ rowNumber: index + 1, cells }))
    .filter((item) => item.cells.some((cell) => cell.length > 0));
}

function stripBomIfFirstCell(value: string, rowIndex: number, cellIndex: number): string {
  return rowIndex === 0 && cellIndex === 0 ? value.replace(/^\uFEFF/u, "") : value;
}

function delimiterForTableTarget(
  ref: OrdinaryRunContextReference,
  targetPath: string,
  raw: string
): TableDelimiter | undefined {
  const extension = tableTargetExtension(ref, targetPath);
  if (extension === ".tsv") {
    return { kind: "tab", char: "\t" };
  }
  if (extension === ".csv") {
    return { kind: "comma", char: "," };
  }
  const mimeType = ref.metadata?.mimeType?.toLowerCase();
  if (mimeType === "text/tab-separated-values") {
    return { kind: "tab", char: "\t" };
  }
  if (mimeType === "text/csv" || mimeType === "application/csv") {
    return { kind: "comma", char: "," };
  }
  return sniffDelimiter(raw);
}

function sniffDelimiter(raw: string): TableDelimiter | undefined {
  const sample = raw.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 8);
  if (sample.length === 0) {
    return undefined;
  }
  const candidates: readonly TableDelimiter[] = [
    { kind: "comma", char: "," },
    { kind: "tab", char: "\t" },
    { kind: "semicolon", char: ";" },
  ];
  const scored = candidates.map((candidate) => {
    const counts = sample.map((line) => countDelimiterOutsideQuotes(line, candidate.char));
    const positive = counts.filter((count) => count > 0);
    const consistent = positive.length >= Math.min(2, sample.length) && new Set(positive).size <= 2;
    return {
      candidate,
      score: positive.reduce((sum, count) => sum + count, 0) + (consistent ? 10 : 0),
    };
  }).sort((left, right) => right.score - left.score);
  return scored[0] !== undefined && scored[0].score > 0 ? scored[0].candidate : undefined;
}

function countDelimiterOutsideQuotes(value: string, delimiter: "," | "\t" | ";"): number {
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\"") {
      if (inQuotes && value[index + 1] === "\"") {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

function compactRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}


function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
