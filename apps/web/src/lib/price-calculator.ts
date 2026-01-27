/**
 * EMPAGSlave 로직 TypeScript 포팅
 *
 * 규칙:
 * - 모델별로 G마켓 측 판매자 구성에 따라 가격 적용
 *   1) (주)계양전동공구 또는 주식회사에이치원 "단독"이면: 전 행 동일 금액(그 판매자 정가)
 *   2) 계양+에이치원 "동시"이면:
 *      - A522/A523: "할인율 9" 판매자 ID행만 9 정가, 나머지 A522/A523 행은 13 정가
 *      - A032 + A113(모두): 13 정가 따라감 (단 A032는 13 정가 - 10)
 */

// 판매자/ID 매핑 (A522/A523 전용)
export const SELLER_KEYANG = '(주)계양전동공구'
export const SELLER_H1 = '주식회사에이치원'

export const SELLER_TO_MALLID: Record<string, Record<string, string>> = {
  [SELLER_KEYANG]: { A522: 'keyang09', A523: 'keyang0909' },
  [SELLER_H1]: { A522: 'h1cokr', A523: 'h1cokr' },
}

export const SPECIAL_SELLERS = new Set([SELLER_KEYANG, SELLER_H1])

// 타입 정의
export interface PlayautoProduct {
  master: string // 업체상품코드 (마스터상품코드)
  modelNorm: string // 정규화된 모델명
  name: string // 상품명
  memo: string // 한줄메모
}

export interface GmarketRecord {
  seller: string
  price: number // 정가
  discount: number | null // 할인율
}

export interface GmarketIndex {
  [modelNorm: string]: GmarketRecord[]
}

export interface TemplateRow {
  mallCode: string // 쇼핑몰코드 (A522, A523, A032, A113)
  mallId: string // 쇼핑몰ID (keyang09, h1cokr 등)
  mallName: string // 쇼핑몰명
}

export interface OutputRow {
  master: string
  mallCode: string
  mallName: string
  mallId: string
  name: string
  memo: string
  price: number
}

// 유틸리티 함수
export function normModel(v: string | null | undefined): string {
  if (!v) return ''
  return v.replace(/\s+/g, '').toUpperCase()
}

export function parsePrice(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Math.round(v)
  const s = String(v).replace(/[^0-9.\-]/g, '')
  if (!s || s === '-' || s === '.') return null
  const n = parseFloat(s)
  return isNaN(n) ? null : Math.round(n)
}

// 가격 선택 로직
export interface PriceResult {
  basePrice: number // 기본금액 (동시존재 시 할인율 9 가격)
  baseDisc: number | null // 기본 할인율
  altPrice: number // 13 가격 (동시존재 시)
  altDisc: number | null // 대체 할인율
  seller9: string | null // base_price 주체 판매자 (동시존재 + 할인율9 있을 때)
  both: boolean // 계양+H1 동시 존재 여부
}

export function choosePricesForModel(recs: GmarketRecord[]): PriceResult {
  const specials = recs.filter((r) => SPECIAL_SELLERS.has(r.seller))
  const sellers = new Set(specials.map((r) => r.seller))

  // 특수 판매자 없음 → 전체 최저가
  if (specials.length === 0) {
    const best = recs.reduce((min, r) => (r.price < min.price ? r : min))
    return { basePrice: best.price, baseDisc: best.discount, altPrice: best.price, altDisc: best.discount, seller9: null, both: false }
  }

  // 계양 또는 H1 단독
  if (!(sellers.has(SELLER_KEYANG) && sellers.has(SELLER_H1))) {
    const best = specials.reduce((min, r) => (r.price < min.price ? r : min))
    return { basePrice: best.price, baseDisc: best.discount, altPrice: best.price, altDisc: best.discount, seller9: null, both: false }
  }

  // 계양 + H1 동시 존재
  const d9 = specials.filter((r) => r.discount === 9)
  let basePrice: number
  let baseDisc: number | null = null
  let seller9: string | null = null

  if (d9.length > 0) {
    const best9 = d9.reduce((min, r) => (r.price < min.price ? r : min))
    basePrice = best9.price
    baseDisc = 9
    seller9 = best9.seller
  } else {
    const best = specials.reduce((min, r) => (r.price < min.price ? r : min))
    basePrice = best.price
    baseDisc = best.discount
  }

  const d13 = specials.filter((r) => r.discount === 13)
  let altPrice: number
  let altDisc: number | null

  if (d13.length > 0) {
    altPrice = Math.min(...d13.map((r) => r.price))
    altDisc = 13
  } else {
    altPrice = basePrice
    altDisc = baseDisc
  }

  return { basePrice, baseDisc, altPrice, altDisc, seller9, both: true }
}

// 단일 상품에 대해 모든 쇼핑몰 행 생성
export function buildOutputRows(
  emp: PlayautoProduct,
  gmarketRecs: GmarketRecord[],
  templateRows: TemplateRow[]
): OutputRow[] {
  const { basePrice, baseDisc, altPrice, altDisc, seller9, both } = choosePricesForModel(gmarketRecs)

  // seller9에 해당하는 쇼핑몰 ID
  let baseA522Id: string | null = null
  let baseA523Id: string | null = null
  if (both && seller9 && SELLER_TO_MALLID[seller9]) {
    baseA522Id = SELLER_TO_MALLID[seller9].A522
    baseA523Id = SELLER_TO_MALLID[seller9].A523
  }

  const rows: OutputRow[] = []

  for (const tpl of templateRows) {
    let priceForRow = basePrice
    let discForRow = baseDisc

    if (both) {
      // 동시존재 시: A032, A113는 13(alt) 따라감
      if (tpl.mallCode === 'A032' || tpl.mallCode === 'A113') {
        priceForRow = altPrice
        discForRow = altDisc
      }
      // 동시존재 시: A522/A523는 9 판매자 ID행만 base, 나머지는 alt
      else if ((tpl.mallCode === 'A522' || tpl.mallCode === 'A523') && seller9) {
        if (tpl.mallCode === 'A522') {
          if (baseA522Id && tpl.mallId === baseA522Id) {
            priceForRow = basePrice
            discForRow = baseDisc
          } else {
            priceForRow = altPrice
            discForRow = altDisc
          }
        } else {
          if (baseA523Id && tpl.mallId === baseA523Id) {
            priceForRow = basePrice
            discForRow = baseDisc
          } else {
            priceForRow = altPrice
            discForRow = altDisc
          }
        }
      }
    }

    // SSG(A032): 적용된 할인율이 13일 때만 -10
    if (tpl.mallCode === 'A032' && discForRow === 13) {
      priceForRow = priceForRow - 10
    }

    rows.push({
      master: emp.master,
      mallCode: tpl.mallCode,
      mallName: tpl.mallName,
      mallId: tpl.mallId,
      name: emp.name,
      memo: emp.memo,
      price: priceForRow,
    })
  }

  return rows
}

// DB job_items 결과를 GmarketIndex로 변환
export function buildGmarketIndexFromJobItems(
  jobItems: Array<{
    model_name: string
    result: {
      products?: Array<{
        seller: string
        originalPrice: number
        discountPercent: number | null
      }>
    } | null
  }>
): GmarketIndex {
  const index: GmarketIndex = {}

  for (const item of jobItems) {
    const modelNorm = normModel(item.model_name)
    if (!modelNorm) continue

    const products = item.result?.products || []
    const recs: GmarketRecord[] = products
      .filter((p) => p.originalPrice != null)
      .map((p) => ({
        seller: p.seller || '',
        price: p.originalPrice,
        discount: p.discountPercent,
      }))

    if (recs.length > 0) {
      index[modelNorm] = recs
    }
  }

  return index
}
