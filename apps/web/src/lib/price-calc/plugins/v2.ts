import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { normModel, SELLER_KEYANG, SELLER_H1, type GmarketIndex } from '../../price-calculator'
import { type PriceCalcFiles, type PriceCalcPlugin, PriceCalcRequestError } from '../types'
import { loadGmarketIndexFromExcelFile } from './shared'

const V2_INPUT_POLICY = {
  requiresPlayauto: true,
  requiresTemplate: false,
  requiresSlave: true,
  gmarketSource: 'file' as const,
}

const SHOPPING_MALL_PRODUCT_SHEET = '쇼핑몰상품'
const V2_REQUIRED_HEADERS = ['판매가', '모델명', '바코드', '시중가'] as const
const BARCODE_VPS_PREFIX = 'VPS / '
const PRICE_UNDERCUT = 10

// 판매가 변동 셀 음영. 변화율 10% 미만은 초록, 이상은 빨강(엑셀 표준 green/red 음영).
const PRICE_CHANGE_THRESHOLD = 0.1
const FILL_GREEN_ARGB = 'FFC6EFCE'
const FILL_RED_ARGB = 'FFFFC7CE'

// 판매가 오른쪽에 추가하는 "시중가 x 배수" 컬럼들(헤더/배수, 순서 그대로 유지).
const MARKET_PRICE_MULTIPLIERS: { header: string; factor: number }[] = [
  { header: '*1.165', factor: 1.165 },
  { header: '*1.205', factor: 1.205 },
  { header: '*1.23', factor: 1.23 },
  { header: '*1.27', factor: 1.27 },
  { header: '*1.245', factor: 1.245 },
  { header: '*1.285', factor: 1.285 },
  { header: '*1.31', factor: 1.31 },
  { header: '*1.35', factor: 1.35 },
]

// 자사(우리) 판매자. 모델별 최저가 판매자가 자사면 언더컷(-10)하지 않고 최저가 그대로 둔다.
const SELF_SELLERS = new Set<string>([SELLER_KEYANG, SELLER_H1, '흥원닷컴'])

export const v2PriceCalcPlugin: PriceCalcPlugin = {
  version: 'v2',
  label: 'v2',
  description: '플토 판매가를 올윈크롤 최저가-10원으로 세팅하는 단일 엑셀 가격 계산',
  inputPolicy: V2_INPUT_POLICY,
  validate: validateV2Input,
  async calculate(context) {
    const { playautoFile, gmarketFile, slaveFile } = getRequiredV2Files(context.files)

    const { index: gmarketIndex } = await loadGmarketIndexFromExcelFile(gmarketFile)

    return buildV2Result({
      userId: context.userId,
      playautoFile,
      gmarketFile,
      slaveFile,
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

  if (!files.slaveFile) {
    return '슬레이브 양식 엑셀 파일이 필요합니다.'
  }

  return null
}

function getRequiredV2Files(files: PriceCalcFiles): {
  playautoFile: File
  gmarketFile: File
  slaveFile: File
} {
  const error = validateV2Input(files)
  if (error) {
    throw new PriceCalcRequestError(error, 400)
  }

  if (!files.playautoFile || !files.gmarketFile || !files.slaveFile) {
    throw new PriceCalcRequestError('가격 계산에 필요한 파일이 누락되었습니다.', 400)
  }

  return {
    playautoFile: files.playautoFile,
    gmarketFile: files.gmarketFile,
    slaveFile: files.slaveFile,
  }
}

interface V2CalculationInput {
  userId: string
  playautoFile: File
  gmarketFile: File
  slaveFile: File
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
  const marketPriceCol = headers['시중가']
  const sellerCodeCol = headers['판매자관리코드']
  const productNameCol = headers['온라인 상품명']

  let matchedCount = 0
  let unmatchedCount = 0
  let totalDataRows = 0
  let lastRowNumber = 1
  // 시중가 셀의 숫자서식(콤마 등). 배수 컬럼들에 동일하게 적용한다.
  let marketPriceNumFmt: string | undefined
  // 슬레이브 양식 채우기에 쓸 상품별 정보(플토 데이터 행 순서대로).
  const products: SlaveProduct[] = []

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return

    totalDataRows++
    lastRowNumber = rowNumber

    // 바코드 보정은 모든 데이터 행에 적용한다(매칭 여부와 무관).
    prefixBarcodeCell(row.getCell(barcodeCol))

    if (marketPriceNumFmt === undefined) {
      const fmt = row.getCell(marketPriceCol).numFmt
      if (fmt) marketPriceNumFmt = fmt
    }

    // 상품 메타(슬레이브용). 최종 판매가는 아래에서 결정한 뒤 기록한다.
    const sellerCode = sellerCodeCol ? cellText(row.getCell(sellerCodeCol)).trim() : ''
    const productName = productNameCol ? cellText(row.getCell(productNameCol)).trim() : ''
    const recordProduct = (finalPrice: number | null) => {
      products.push({ sellerCode, productName, finalPrice })
    }

    const modelNorm = normModel(cellText(row.getCell(modelCol)))
    if (!modelNorm) {
      unmatchedCount++
      recordProduct(parsePriceNumber(cellText(row.getCell(priceCol))))
      return
    }

    const recs = input.gmarketIndex[modelNorm]
    if (!recs || recs.length === 0) {
      unmatchedCount++
      recordProduct(parsePriceNumber(cellText(row.getCell(priceCol))))
      return
    }

    const lowest = Math.min(...recs.map((rec) => rec.price))

    // 자사 단독 최저 분기: 최저가 record가 "전부" 자사 판매자일 때만 언더컷하지 않고 최저가 그대로 둔다.
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
      recordProduct(parsePriceNumber(cellText(row.getCell(priceCol))))
      return
    }

    const priceCell = row.getCell(priceCol)
    // 덮어쓰기 전에 원래 판매가를 캡처(콤마/₩/공백 제거 후 숫자 파싱).
    const oldPrice = parsePriceNumber(cellText(priceCell))
    priceCell.value = newPrice

    // 변동 셀 색칠: 변동 없으면 색 없음, 변화율<10% 초록, ≥10% 빨강.
    // 색칠 판정은 -10(자사/타사) 로직과 무관하게 oldPrice vs newPrice 차이만으로 한다.
    applyPriceChangeFill(priceCell, oldPrice, newPrice)

    matchedCount++
    recordProduct(newPrice)
  })

  // 시중가x배수 8개 컬럼 삽입은 모든 per-row 처리(판매가 set/색칠/바코드)가 끝난 뒤 마지막에 한다.
  // (컬럼 삽입은 priceCol 이후 인덱스를 +8 밀어버리므로, 시중가 값은 삽입 전 인덱스로 읽는다.)
  insertMarketPriceMultiplierColumns(worksheet, priceCol, marketPriceCol, lastRowNumber, marketPriceNumFmt)

  // 1) 쇼핑몰상품 결과 워크북(배수컬럼/색칠/바코드VPS 포함) 버퍼.
  const shoppingMallBuffer = await workbook.xlsx.writeBuffer()

  // 2) 슬레이브 양식 워크북: 상품마다 계정 블록을 반복 채운다.
  const slaveBuffer = await buildSlaveWorkbook(input.slaveFile, products)

  // 3) 두 파일을 ZIP으로 묶는다(v1과 동일한 jszip).
  const dateStr = input.requestedAt.toISOString().split('T')[0]
  const zip = new JSZip()
  zip.file(`쇼핑몰상품_${dateStr}.xlsx`, shoppingMallBuffer)
  zip.file(`슬레이브양식_${dateStr}.xlsx`, slaveBuffer)
  const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' })

  const metrics = {
    matchedCount,
    unmatchedCount,
    // v2는 행 삭제/필터링을 하지 않는다. kept=쇼핑몰상품 데이터 행 수, removed=0으로 기록한다.
    vpsKeptRows: totalDataRows,
    vpsRemovedRows: 0,
  }

  return {
    version: 'v2' as const,
    bodyBuffer: zipBuffer,
    downloadFileName: `가격계산_v2_${dateStr}.zip`,
    contentType: 'application/zip',
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

interface SlaveProduct {
  sellerCode: string
  productName: string
  finalPrice: number | null
}

const SLAVE_REQUIRED_HEADERS = ['판매자관리코드', '쇼핑몰(계정)', '온라인 상품명', '판매가', '바코드'] as const

// 슬레이브 양식 워크북 생성.
// 업로드된 슬레이브 템플릿(첫 시트)의 "계정 블록"(쇼핑몰(계정)이 채워진 데이터 행들)을
// 플토 상품마다 통째로 복제해 채운다. 출력 행 수 = 상품수 x 계정행수.
async function buildSlaveWorkbook(slaveFile: File, products: SlaveProduct[]): Promise<Buffer> {
  const slaveBuffer = await slaveFile.arrayBuffer()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(slaveBuffer)

  const worksheet = workbook.worksheets[0]
  if (!worksheet) {
    throw new PriceCalcRequestError('슬레이브 양식 엑셀에 시트가 없습니다.', 400)
  }

  const headers = headerMap(worksheet)
  const missing = SLAVE_REQUIRED_HEADERS.filter((header) => !headers[header])
  if (missing.length > 0) {
    throw new PriceCalcRequestError(`슬레이브 양식에 필수 컬럼 누락: ${missing.join(', ')}`, 400)
  }

  const accountCol = headers['쇼핑몰(계정)']
  const sellerCodeCol = headers['판매자관리코드']
  const productNameCol = headers['온라인 상품명']
  const priceCol = headers['판매가']
  const barcodeCol = headers['바코드']

  // 템플릿의 계정 블록: 2행~끝 중 쇼핑몰(계정)이 비어있지 않은 행들을 그대로 보관.
  const accountRows: Record<number, string>[] = []
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const account = cellText(row.getCell(accountCol)).trim()
    if (!account) return

    const values: Record<number, string> = {}
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      values[colNumber] = cellText(cell)
    })
    values[accountCol] = account
    accountRows.push(values)
  })

  if (accountRows.length === 0) {
    throw new PriceCalcRequestError('슬레이브 양식에 계정 행이 없습니다.', 400)
  }

  const columnCount = worksheet.columnCount

  // 기존 데이터 행 제거(헤더만 남김). 뒤에서부터 삭제해 인덱스 안 꼬임.
  for (let rowNumber = worksheet.rowCount; rowNumber >= 2; rowNumber--) {
    worksheet.spliceRows(rowNumber, 1)
  }

  const blockSize = accountRows.length

  // 상품 x 계정 블록 펼치기.
  let dataRowIndex = 0 // 추가된 데이터 행 카운터(1부터)
  for (const product of products) {
    for (const template of accountRows) {
      const rowValues: (string | number | null)[] = []
      for (let colNumber = 1; colNumber <= columnCount; colNumber++) {
        rowValues[colNumber] = template[colNumber] ?? ''
      }
      // 상품별 값 덮어쓰기.
      rowValues[sellerCodeCol] = product.sellerCode
      rowValues[productNameCol] = product.productName
      rowValues[priceCol] = product.finalPrice === null ? '' : product.finalPrice
      rowValues[barcodeCol] = '' // 바코드는 비움
      const addedRow = worksheet.addRow(rowValues.slice(1))
      dataRowIndex++

      // 상품 블록의 마지막 행(다음 상품과의 경계)에 아래쪽 굵은 테두리(상품 구분선).
      if (dataRowIndex % blockSize === 0) {
        for (let colNumber = 1; colNumber <= columnCount; colNumber++) {
          const cell = addedRow.getCell(colNumber)
          cell.border = {
            ...(cell.border ?? {}),
            bottom: { style: 'medium', color: { argb: 'FF000000' } },
          }
        }
      }
    }
  }

  // 온라인 상품명 컬럼은 길어서 너비를 넓힌다.
  worksheet.getColumn(productNameCol).width = 55

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

function prefixBarcodeCell(cell: ExcelJS.Cell): void {
  const value = cellText(cell).trim()

  // 정책: 바코드가 비어 있으면 'VPS / '만 넣지 않고 원래 빈 값을 보존한다.
  if (!value || /^VPS\s*\//i.test(value)) {
    return
  }

  cell.value = BARCODE_VPS_PREFIX + value
}

// 콤마/₩/공백 등을 제거하고 판매가를 숫자로 파싱. 파싱 불가 시 null.
function parsePriceNumber(text: string): number | null {
  const cleaned = text.replace(/[^0-9.-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

// 변동 셀 색칠: 변동 없거나 oldPrice 미상이면 색 없음.
// 변화율 = |new-old|/old. 10% 미만 초록, 이상 빨강.
// old가 0/파싱불가인데 값이 바뀌었으면 % 계산 불가 → 초록.
//
// NOTE(ExcelJS): 동일 스타일을 공유하는 셀에 .fill 을 지정하면 형제 셀로 색이 번지는
// 공유 스타일 버그가 있다. 따라서 "색 없음" 케이스도 셀마다 명시적으로 pattern:none 을
// 지정해 각 셀이 자기 스타일을 소유하도록 한다(번짐 방지).
function applyPriceChangeFill(
  cell: ExcelJS.Cell,
  oldPrice: number | null,
  newPrice: number
): void {
  if (oldPrice === null || oldPrice === 0) {
    // % 계산 불가하지만 값이 바뀐 경우(이 함수는 변경된 셀에서만 호출됨) → 초록.
    setSolidFill(cell, FILL_GREEN_ARGB)
    return
  }

  if (oldPrice === newPrice) {
    clearFill(cell)
    return
  }

  const changeRate = Math.abs(newPrice - oldPrice) / Math.abs(oldPrice)
  setSolidFill(cell, changeRate >= PRICE_CHANGE_THRESHOLD ? FILL_RED_ARGB : FILL_GREEN_ARGB)
}

function setSolidFill(cell: ExcelJS.Cell, argb: string): void {
  detachCellStyle(cell)
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
}

// 공유 스타일 번짐 방지를 위해 색 없음도 명시적으로 지정한다.
function clearFill(cell: ExcelJS.Cell): void {
  detachCellStyle(cell)
  cell.fill = { type: 'pattern', pattern: 'none' }
}

// ExcelJS는 동일 스타일 셀들이 하나의 style 객체를 공유한다. 그 상태로 cell.fill 을
// 바꾸면 형제 셀까지 색이 번진다. fill 변경 전에 해당 셀의 style 을 독립 복제해
// 자기만의 style 객체를 갖게 만든다.
function detachCellStyle(cell: ExcelJS.Cell): void {
  cell.style = JSON.parse(JSON.stringify(cell.style ?? {}))
}

// 판매가(priceCol) 바로 오른쪽에 "시중가 x 배수" 8개 컬럼을 순서대로 삽입한다.
// 각 셀 값 = 해당 행 시중가 x 배수 (정수 반올림). 시중가가 비었거나 숫자 아니면 빈칸.
// 모든 데이터 행 대상(매칭 여부 무관). 시중가 값은 삽입 전 인덱스로 미리 읽어둔다.
function insertMarketPriceMultiplierColumns(
  worksheet: ExcelJS.Worksheet,
  priceCol: number,
  marketPriceCol: number,
  lastRowNumber: number,
  marketPriceNumFmt: string | undefined
): void {
  // 삽입 "전" 인덱스로 행별 시중가를 먼저 읽는다(삽입하면 시중가 컬럼이 +8 밀리므로).
  const marketPrices: (number | null)[] = []
  for (let rowNumber = 2; rowNumber <= lastRowNumber; rowNumber++) {
    marketPrices.push(parsePriceNumber(cellText(worksheet.getRow(rowNumber).getCell(marketPriceCol))))
  }

  // 배수별 컬럼 배열: [헤더, ...행별값]. 순서는 MARKET_PRICE_MULTIPLIERS 그대로.
  const columnArrays = MARKET_PRICE_MULTIPLIERS.map(({ header, factor }) => {
    const columnArray: (string | number | null)[] = [header]
    for (const marketPrice of marketPrices) {
      columnArray.push(marketPrice === null ? null : Math.round(marketPrice * factor))
    }
    return columnArray
  })

  // priceCol 바로 다음 위치에 0개 삭제 + 8개 컬럼을 순서대로 삽입.
  worksheet.spliceColumns(priceCol + 1, 0, ...columnArrays)

  // 삽입된 컬럼들의 숫자서식을 시중가와 동일하게(콤마 등) 적용한다.
  // 단 서식이 텍스트('@')면 숫자를 텍스트로 강제하게 되므로 적용하지 않고 일반 숫자로 둔다.
  const isNumericFmt = !!marketPriceNumFmt && /[#0]/.test(marketPriceNumFmt)
  if (isNumericFmt && marketPriceNumFmt) {
    for (let offset = 0; offset < columnArrays.length; offset++) {
      const newCol = priceCol + 1 + offset
      for (let rowNumber = 2; rowNumber <= lastRowNumber; rowNumber++) {
        const cell = worksheet.getRow(rowNumber).getCell(newCol)
        if (cell.value !== null && cell.value !== undefined && cell.value !== '') {
          cell.numFmt = marketPriceNumFmt
        }
      }
    }
  }
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
