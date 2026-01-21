import ExcelJS from 'exceljs'
import {
  type PlayautoProduct,
  type TemplateRow,
  type OutputRow,
  normModel,
} from './price-calculator'

function headerMap(worksheet: ExcelJS.Worksheet): Record<string, number> {
  const map: Record<string, number> = {}
  const headerRow = worksheet.getRow(1)
  headerRow.eachCell((cell, colNumber) => {
    const val = cell.value?.toString().trim()
    if (val && !map[val]) {
      map[val] = colNumber
    }
  })
  return map
}

export async function parsePlayautoExcel(
  buffer: ArrayBuffer
): Promise<PlayautoProduct[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const ws = workbook.worksheets[0]
  const hm = headerMap(ws)

  const required = ['업체상품코드', '모델명', '상품명', '한줄메모']
  const missing = required.filter((k) => !hm[k])
  if (missing.length > 0) {
    throw new Error(`플레이오토 엑셀에 필수 컬럼 누락: ${missing.join(', ')}`)
  }

  const products: PlayautoProduct[] = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const master = row.getCell(hm['업체상품코드']).value?.toString().trim() || ''
    const modelRaw = row.getCell(hm['모델명']).value?.toString() || ''
    const name = row.getCell(hm['상품명']).value?.toString().trim() || ''
    const memo = row.getCell(hm['한줄메모']).value?.toString().trim() || ''

    if (master && modelRaw) {
      products.push({
        master,
        modelNorm: normModel(modelRaw),
        name,
        memo,
      })
    }
  })

  return products
}

export async function parseTemplateExcel(
  buffer: ArrayBuffer
): Promise<{ rows: TemplateRow[]; workbook: ExcelJS.Workbook; headerMap: Record<string, number> }> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const ws = workbook.worksheets[0]
  const hm = headerMap(ws)

  const required = ['마스터상품코드', '쇼핑몰코드', '쇼핑몰ID', '상품명', '한줄메모', '판매가']
  const missing = required.filter((k) => !hm[k])
  if (missing.length > 0) {
    throw new Error(`템플릿 엑셀에 필수 컬럼 누락: ${missing.join(', ')}`)
  }

  const rows: TemplateRow[] = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const mallCode = row.getCell(hm['쇼핑몰코드']).value?.toString().trim() || ''
    const mallId = row.getCell(hm['쇼핑몰ID']).value?.toString().trim() || ''
    const mallName = row.getCell(hm['쇼핑몰명'] || 0).value?.toString().trim() || ''

    if (mallCode) {
      rows.push({ mallCode, mallId, mallName })
    }
  })

  return { rows, workbook, headerMap: hm }
}

export async function generateOutputExcel(
  templateBuffer: ArrayBuffer,
  outputRows: OutputRow[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(templateBuffer)
  const ws = workbook.worksheets[0]
  const hm = headerMap(ws)

  const srcRows: number[] = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const mallCode = row.getCell(hm['쇼핑몰코드']).value?.toString().trim()
    if (mallCode) {
      srcRows.push(rowNumber)
    }
  })

  if (srcRows.length === 0) {
    throw new Error('템플릿에서 쇼핑몰코드가 있는 데이터행을 찾지 못했습니다.')
  }

  const templateRowData = srcRows.map((r) => {
    const row = ws.getRow(r)
    const cells: Record<number, { value: ExcelJS.CellValue; style: Partial<ExcelJS.Style> }> = {}
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber] = {
        value: cell.value,
        style: {
          font: cell.font ? { ...cell.font } : undefined,
          fill: cell.fill ? { ...cell.fill } : undefined,
          border: cell.border ? { ...cell.border } : undefined,
          alignment: cell.alignment ? { ...cell.alignment } : undefined,
          numFmt: cell.numFmt,
        },
      }
    })
    return { height: row.height, cells }
  })

  ws.spliceRows(2, ws.rowCount - 1)

  let currentRow = 2
  const templateRowCount = templateRowData.length

  for (let i = 0; i < outputRows.length; i++) {
    const out = outputRows[i]
    const tplIdx = i % templateRowCount
    const tpl = templateRowData[tplIdx]

    const row = ws.getRow(currentRow)
    if (tpl.height) row.height = tpl.height

    for (const [colNum, cellData] of Object.entries(tpl.cells)) {
      const col = parseInt(colNum, 10)
      const cell = row.getCell(col)
      cell.value = cellData.value
      if (cellData.style.font) cell.font = cellData.style.font
      if (cellData.style.fill) cell.fill = cellData.style.fill as ExcelJS.Fill
      if (cellData.style.border) cell.border = cellData.style.border
      if (cellData.style.alignment) cell.alignment = cellData.style.alignment
      if (cellData.style.numFmt) cell.numFmt = cellData.style.numFmt
    }

    row.getCell(hm['마스터상품코드']).value = out.master
    row.getCell(hm['상품명']).value = out.name
    row.getCell(hm['한줄메모']).value = out.memo
    row.getCell(hm['판매가']).value = out.price

    row.commit()
    currentRow++
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

const VPS_MEMO_PREFIX = 'VPS / '
const VPS_DROP_HEADERS = ['시중가', '원가', '표준공급가', '판매가', '배송방법', '배송비']

export async function generateEmpMatchedVps(
  playautoBuffer: ArrayBuffer,
  matchedMasterCodes: Set<string>
): Promise<{ buffer: Buffer; keptRows: number; removedRows: number }> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(playautoBuffer)
  const ws = workbook.worksheets[0]
  const hm = headerMap(ws)

  if (!hm['업체상품코드']) {
    throw new Error('EMP 엑셀에 업체상품코드 컬럼이 없습니다.')
  }

  const cMaster = hm['업체상품코드']
  const cMemo = hm['한줄메모']

  // 뒤에서부터 삭제해야 인덱스 안 꼬임
  const rowsToDelete: number[] = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const masterVal = row.getCell(cMaster).value
    const master = normMasterCode(masterVal)
    if (!master || !matchedMasterCodes.has(master)) {
      rowsToDelete.push(rowNumber)
    }
  })

  for (const rowNum of rowsToDelete.reverse()) {
    ws.spliceRows(rowNum, 1)
  }

  if (cMemo) {
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return
      const cell = row.getCell(cMemo)
      const val = cell.value?.toString() || ''
      if (/^\s*VPS\s*\//i.test(val)) return
      cell.value = val ? VPS_MEMO_PREFIX + val : VPS_MEMO_PREFIX
    })
  }

  // 컬럼 삭제 전 인덱스 재매핑 필요
  const hm2 = headerMap(ws)
  const colsToDelete = VPS_DROP_HEADERS
    .map((h) => hm2[h])
    .filter((idx): idx is number => idx !== undefined)
    .sort((a, b) => b - a)

  for (const colIdx of colsToDelete) {
    ws.spliceColumns(colIdx, 1)
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const keptRows = Math.max(ws.rowCount - 1, 0)
  const removedRows = rowsToDelete.length

  return {
    buffer: Buffer.from(buffer),
    keptRows,
    removedRows,
  }
}

function normMasterCode(val: ExcelJS.CellValue): string {
  if (val === null || val === undefined) return ''
  if (typeof val === 'number') {
    return Number.isInteger(val) ? String(val) : String(val)
  }
  if (typeof val === 'boolean') return ''
  const s = String(val).trim()
  // 엑셀에서 "123.0" 형태로 들어온 경우 "123"으로 정규화
  try {
    const f = parseFloat(s)
    if (!isNaN(f) && Number.isInteger(f)) {
      return String(Math.round(f))
    }
  } catch {
    /* parse 실패 시 원본 반환 */
  }
  return s
}
