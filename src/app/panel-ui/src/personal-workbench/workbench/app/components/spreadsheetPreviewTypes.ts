export type SpreadsheetCellValue = string | number | boolean | Date | null

export type SpreadsheetSheet = {
  readonly sheet: string
  readonly data: readonly (readonly SpreadsheetCellValue[])[]
}

export type SpreadsheetWorkerRequest = {
  readonly kind: 'parse'
  readonly requestId: number
  readonly source: Blob
}

export type SpreadsheetWorkerResponse =
  | { readonly kind: 'parsed'; readonly requestId: number; readonly sheets: readonly SpreadsheetSheet[] }
  | { readonly kind: 'failed'; readonly requestId: number; readonly message: string }