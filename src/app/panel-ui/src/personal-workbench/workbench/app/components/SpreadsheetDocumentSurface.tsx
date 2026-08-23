import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { getCachedSpreadsheetPreview, loadSpreadsheetPreview } from './officePreviewRuntime'
import type { SpreadsheetCellValue, SpreadsheetSheet } from './spreadsheetPreviewTypes'
import './office-document.css'

const INITIAL_ROW_COUNT = 120
const ROW_BATCH_SIZE = 200
const INITIAL_COLUMN_COUNT = 40
const COLUMN_BATCH_SIZE = 40

export function SpreadsheetDocumentSurface({ url, byteLength, sourceVersion }: {
  url: string
  byteLength?: number
  sourceVersion?: string
}) {
  const [sheets, setSheets] = useState<readonly SpreadsheetSheet[] | undefined>(() => (
    getCachedSpreadsheetPreview(url, sourceVersion)
  ))
  const [activeSheet, setActiveSheet] = useState(0)
  const [visibleRows, setVisibleRows] = useState(INITIAL_ROW_COUNT)
  const [visibleColumns, setVisibleColumns] = useState(INITIAL_COLUMN_COUNT)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    setActiveSheet(0)
    setVisibleRows(INITIAL_ROW_COUNT)
    setVisibleColumns(INITIAL_COLUMN_COUNT)
    setError(undefined)
    const cached = getCachedSpreadsheetPreview(url, sourceVersion)
    if (cached !== undefined) {
      setSheets(cached)
      return () => controller.abort()
    }
    setSheets(undefined)
    void loadSpreadsheetPreview({ url, byteLength, sourceVersion, signal: controller.signal }).then((workbook) => {
      if (!controller.signal.aborted) setSheets(workbook)
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取这个 Excel 工作簿。')
    })
    return () => controller.abort()
  }, [byteLength, sourceVersion, url])

  const sheet = sheets?.[activeSheet]
  const totalColumnCount = useMemo(
    () => sheet?.data.reduce((maximum, row) => Math.max(maximum, row.length), 0) ?? 0,
    [sheet],
  )
  const columnCount = Math.min(visibleColumns, totalColumnCount)
  const rows = sheet?.data.slice(0, visibleRows) ?? []

  if (error !== undefined) {
    return <OfficeState error message={error} />
  }
  if (sheets === undefined) {
    return <OfficeState error={false} message="正在读取工作簿..." />
  }
  if (sheets.length === 0 || sheet === undefined) {
    return <OfficeState error message="这个工作簿没有可显示的工作表。" />
  }

  const columnsTruncated = columnCount < totalColumnCount
  const rowsTruncated = rows.length < sheet.data.length
  return (
    <div className="aa-spreadsheet-document">
      <div className="aa-spreadsheet-document__tabs" role="tablist" aria-label="工作表">
        {sheets.map((candidate, index) => (
          <button
            type="button"
            role="tab"
            aria-selected={index === activeSheet}
            key={`${index}:${candidate.sheet}`}
            onClick={() => {
              setActiveSheet(index)
              setVisibleRows(INITIAL_ROW_COUNT)
              setVisibleColumns(INITIAL_COLUMN_COUNT)
            }}
          >
            {candidate.sheet}
          </button>
        ))}
      </div>
      <div className="aa-spreadsheet-document__viewport" data-document-scroll="content">
        <table aria-label={`${sheet.sheet} 工作表`}>
          <thead>
            <tr>
              <th aria-label="行号" />
              {Array.from({ length: columnCount }, (_, index) => <th key={index}>{columnLabel(index)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th scope="row">{rowIndex + 1}</th>
                {Array.from({ length: columnCount }, (_, columnIndex) => {
                  const value = formatCellValue(row[columnIndex] ?? null)
                  return <td key={columnIndex} title={value}>{value}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.data.length === 0 && <div className="aa-spreadsheet-document__empty">这个工作表是空的。</div>}
        {(rowsTruncated || columnsTruncated) && (
          <div className="aa-spreadsheet-document__continuation">
            <span>已显示 {rows.length} / {sheet.data.length} 行{columnsTruncated ? `，前 ${columnCount} 列` : ''}</span>
            {rowsTruncated && <button type="button" onClick={() => setVisibleRows((count) => count + ROW_BATCH_SIZE)}>继续显示行</button>}
            {columnsTruncated && <button type="button" onClick={() => setVisibleColumns((count) => count + COLUMN_BATCH_SIZE)}>继续显示列</button>}
          </div>
        )}
      </div>
    </div>
  )
}

function OfficeState({ error, message }: { error: boolean; message: string }) {
  return (
    <div className="aa-spreadsheet-document aa-spreadsheet-document--state">
      <div className="aa-office-document__state" role={error ? 'alert' : 'status'}>
        {error ? <AlertTriangle size={20} /> : <LoaderCircle size={20} className="aa-office-document__spinner" />}
        <span>{message}</span>
      </div>
    </div>
  )
}

function formatCellValue(value: SpreadsheetCellValue): string {
  if (value === null) return ''
  if (value instanceof Date) return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}