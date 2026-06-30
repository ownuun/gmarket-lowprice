import type { Product, SearchResult } from '../types.js'
import type { MarketplaceId, MarketplaceSearcher } from './types.js'

// coupang_service.py(/search)가 돌려주는 JSON 형태.
interface ServiceProduct {
  productId: string
  url: string
  text: string
  price: number | null
}

interface ServiceResponse {
  ok: boolean
  status: number | null
  title?: string
  count: number
  products: ServiceProduct[]
  error?: string
}

const DEFAULT_BASE = process.env.COUPANG_SERVICE_URL || 'http://127.0.0.1:8917'
const SEARCH_TIMEOUT_MS = Number.parseInt(process.env.COUPANG_SEARCH_TIMEOUT ?? '90000', 10)

// 쿠팡 검색 플러그인.
// 실제 크롤은 CloakBrowser(스텔스 Chromium)를 구동하는 Python 사이드카(coupang-service)가 담당하고,
// 이 클래스는 그 로컬 HTTP 서비스를 호출해 표준 Product/SearchResult로 매핑하는 thin client다.
// → 엔진을 통째로 갈아끼우려면 이 어댑터 + 사이드카만 교체하면 된다.
const RESULT_LIMIT = 10

const ACCESSORY_KEYWORDS = [
  '케이스', '커버', '보호필름', '필름', '거치대', '파우치', '가방', '스티커', '마운트', '호환', '정품인증',
]

function normalizeText(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9가-힣]/g, '')
}

function matchesModel(query: string, productName: string): boolean {
  const name = normalizeText(productName)
  const tokens = query
    .toUpperCase()
    .split(/[\s\-_]+/)
    .map(normalizeText)
    .filter((t) => t.length >= 2)
  if (tokens.length === 0) return true
  return tokens.every((t) => name.includes(t))
}

// salePriceAsc 정렬 시 케이스/필름 같은 싼 액세서리가 최상단을 차지해 최저가로 오인되므로 제외한다.
function isAccessory(productName: string): boolean {
  return ACCESSORY_KEYWORDS.some((k) => productName.includes(k))
}

const OUTLIER_RATIO = 0.3

function rejectOutliers(items: ServiceProduct[]): ServiceProduct[] {
  if (items.length < 4) return items
  const prices = items.map((p) => p.price as number).sort((a, b) => a - b)
  const median = prices[Math.floor(prices.length / 2)]
  return items.filter((p) => (p.price as number) >= median * OUTLIER_RATIO)
}

export class CoupangSearcher implements MarketplaceSearcher {
  readonly id: MarketplaceId = 'coupang'
  readonly label = '쿠팡'
  private readonly baseUrl: string

  constructor(baseUrl: string = DEFAULT_BASE) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async search(modelName: string): Promise<SearchResult> {
    const searchUrl = this.searchUrlFor(modelName)
    const endpoint = `${this.baseUrl}/search?q=${encodeURIComponent(modelName)}`

    let res: Response
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
    try {
      res = await fetch(endpoint, { signal: controller.signal })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { modelName, products: [], error: `쿠팡 서비스 연결 실패: ${msg}`, searchUrl }
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      let detail = ''
      try {
        detail = JSON.stringify(await res.json())
      } catch {
        /* 본문 파싱 실패는 무시 */
      }
      return { modelName, products: [], error: `쿠팡 서비스 오류 ${res.status} ${detail}`, searchUrl }
    }

    const data = (await res.json()) as ServiceResponse

    if (!data.ok) {
      const blocked = (data.title ?? '').includes('Access Denied')
      return {
        modelName,
        products: [],
        error: blocked ? 'BLOCKED' : (data.error ?? '쿠팡 검색 결과 없음'),
        searchUrl,
      }
    }

    const candidates = data.products
      .filter((p) => typeof p.price === 'number' && p.price > 0)
      .filter((p) => matchesModel(modelName, p.text))
      .filter((p) => !isAccessory(p.text))

    const matched = rejectOutliers(candidates)
      .sort((a, b) => (a.price as number) - (b.price as number))
      .slice(0, RESULT_LIMIT)

    const products: Product[] = matched.map((p, index) => ({
      modelName,
      productName: p.text,
      sellerName: '쿠팡',
      couponPrice: p.price,
      regularPrice: p.price,
      shippingFee: null,
      discountPercent: null,
      productNo: p.productId,
      productUrl: p.url,
      searchUrl,
      rank: index + 1,
      crawledAt: new Date(),
    }))

    return { modelName, products, searchUrl }
  }

  private searchUrlFor(modelName: string): string {
    return `https://www.coupang.com/np/search?q=${encodeURIComponent(modelName)}&channel=user`
  }
}
