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
