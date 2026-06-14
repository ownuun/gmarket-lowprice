import ExcelJS from 'exceljs'
import { normModel, SELLER_KEYANG, SELLER_H1, type GmarketIndex } from '../../price-calculator'
import { type PriceCalcFiles, type PriceCalcPlugin, PriceCalcRequestError } from '../types'
import { loadGmarketIndexFromExcelFile } from './shared'

const V2_INPUT_POLICY = {
  requiresPlayauto: true,
  requiresTemplate: false,
  gmarketSource: 'file' as const,
}

const SHOPPING_MALL_PRODUCT_SHEET = '쇼핑몰상품'
const V2_REQUIRED_HEADERS = ['판매가', '모델명', '바코드'] as const
const BARCODE_VPS_PREFIX = 'VPS / '
const PRICE_UNDERCUT = 10

// 자사(우리) 판매자. 모델별 최저가 판매자가 자사면 언더컷(-10)하지 않고 최저가 그대로 둔다.
const SELF_SELLERS = new Set<string>([SELLER_KEYANG, SELLER_H1, '흥원닷컴'])

export const v2PriceCalcPlugin: PriceCalcPlugin = {
  version: 'v2',
  label: 'v2',
  description: '플토 판매가를 올윈크롤 최저가-10원으로 세팅하는 단일 엑셀 가격 계산',
  inputPolicy: V2_INPUT_POLICY,
  validate: validateV2Input,
  async calculate(context) {
    const { playautoFile, gmarketFile } = getRequiredV2Files(context.files)

    const { index: gmarketIndex } = await loadGmarketIndexFromExcelFile(gmarketFile)

    return buildV2Result({
      userId: context.userId,
      playautoFile,
      gmarketFile,
      gmarketIndex,
      requestedAt: context.requestedAt,
    })
  },
}

function validateV2Input(files: PriceCalcFiles): string | null {
  if (!files.playautoFile) {
    return '플토 엑셀 파일이 필요합니다.'
  }

  if (!files.gmarketFile) {
    return '올윈크롤 엑셀 파일이 필요합니다.'
  }

  return null
}

function getRequiredV2Files(files: PriceCalcFiles): { playautoFile: File; gmarketFile: File } {
  const error = validateV2Input(files)
  if (error) {
    throw new PriceCalcRequestError(error, 400)
  }

  if (!files.playautoFile || !files.gmarketFile) {
    throw new PriceCalcRequestError('가격 계산에 필요한 파일이 누락되었습니다.', 400)
  }

  return {
    playautoFile: files.playautoFile,
    gmarketFile: files.gmarketFile,
  }
}

interface V2CalculationInput {
  userId: string
  playautoFile: File
  gmarketFile: File
  gmarketIndex: GmarketIndex
  requestedAt: Date
}

async function buildV2Result(input: V2CalculationInput) {
  const playautoBuffer = await input.playautoFile.arrayBuffer()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(playautoBuffer)

  const worksheet = workbook.getWorksheet(SHOPPING_MALL_PRODUCT_SHEET)
  if (!worksheet) {
    throw new PriceCalcRequestError(`플토 엑셀에 '${SHOPPING_MALL_PRODUCT_SHEET}' 시트가 없습니다.`, 400)
  }

  const headers = headerMap(worksheet)
  const missing = V2_REQUIRED_HEADERS.filter((header) => !headers[header])
  if (missing.length > 0) {
    throw new PriceCalcRequestError(`플토 엑셀에 필수 컬럼 누락: ${missing.join(', ')}`, 400)
  }

  const priceCol = headers['판매가']
  const modelCol = headers['모델명']
  const barcodeCol = headers['바코드']

  let matchedCount = 0
  let unmatchedCount = 0
  let totalDataRows = 0

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return

    totalDataRows++

    // 바코드 보정은 모든 데이터 행에 적용한다(매칭 여부와 무관).
    prefixBarcodeCell(row.getCell(barcodeCol))

    const modelNorm = normModel(cellText(row.getCell(modelCol)))
    if (!modelNorm) {
      unmatchedCount++
      return
    }

    const recs = input.gmarketIndex[modelNorm]
    if (!recs || recs.length === 0) {
      unmatchedCount++
      return
    }

    const lowest = Math.min(...recs.map((rec) => rec.price))

    // 자사 단독 최저 분기: 최저가 record가 "전부" 자사 판매자일 때만 언더컷하지 않고 그대로 둔다.
    // 최저가에 경쟁사가 한 명이라도 끼면 -10 한다. (lowestRecs는 recs.length>0 이므로 항상 비어있지 않음.)
    const lowestRecs = recs.filter((rec) => rec.price === lowest)
    const isOursOnly = lowestRecs.every((rec) => SELF_SELLERS.has(rec.seller.trim()))
    const newPrice = isOursOnly ? lowest : lowest - PRICE_UNDERCUT

    // 음수/0 방지: 갱신할 판매가가 0 이하이면 기존 판매가를 보존하고 로그만 남긴다.
    if (newPrice <= 0) {
      console.warn(
        `[price-calc v2] 모델 ${modelNorm}: 갱신가(${newPrice}) <= 0 이므로 판매가를 유지합니다.`
      )
      unmatchedCount++
      return
    }

    row.getCell(priceCol).value = newPrice
    matchedCount++
  })

  const buffer = await workbook.xlsx.writeBuffer()
  const dateStr = input.requestedAt.toISOString().split('T')[0]
  const metrics = {
    matchedCount,
    unmatchedCount,
    // v2는 행 삭제/필터링을 하지 않는다. kept=쇼핑몰상품 데이터 행 수, removed=0으로 기록한다.
    vpsKeptRows: totalDataRows,
    vpsRemovedRows: 0,
  }

  return {
    version: 'v2' as const,
    bodyBuffer: buffer,
    downloadFileName: `가격계산_v2_${dateStr}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    history: {
      user_id: input.userId,
      playauto_filename: input.playautoFile.name,
      template_filename: input.gmarketFile.name || 'v2-crawl',
      gmarket_source: `file:${input.gmarketFile.name || 'unknown'}`,
      matched_count: metrics.matchedCount,
      unmatched_count: metrics.unmatchedCount,
      vps_kept_rows: metrics.vpsKeptRows,
      vps_removed_rows: metrics.vpsRemovedRows,
    },
    ...metrics,
  }
}

function prefixBarcodeCell(cell: ExcelJS.Cell): void {
  const value = cellText(cell).trim()

  // 정책: 바코드가 비어 있으면 'VPS / '만 넣지 않고 원래 빈 값을 보존한다.
  if (!value || /^VPS\s*\//i.test(value)) {
    return
  }

  cell.value = BARCODE_VPS_PREFIX + value
}

function headerMap(worksheet: ExcelJS.Worksheet): Record<string, number> {
  const map: Record<string, number> = {}
  const headerRow = worksheet.getRow(1)
  headerRow.eachCell((cell, colNumber) => {
    const val = cellText(cell).trim()
    if (val && !map[val]) {
      map[val] = colNumber
    }
  })
  return map
}

function cellText(cell: ExcelJS.Cell): string {
  return cellValueToText(cell.value)
}

function cellValueToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()

  if ('text' in value && typeof value.text === 'string') return value.text
  if ('result' in value) return cellValueToText(value.result as ExcelJS.CellValue)
  if ('richText' in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join('')
  }
  return String(value)
}
