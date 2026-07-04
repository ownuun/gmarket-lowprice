import type { Product, SearchResult } from '../types.js'
import type { MarketplaceId, MarketplaceSearcher } from './types.js'

// 쿠팡 검색 플러그인.
// 쿠팡은 Akamai Bot Manager로 보호돼 일반/residential 프록시는 IP 평판으로 전부 차단된다(DataImpulse·Bright Data
// residential 모두 403 확인). 그래서 검색은 Akamai 우회 전용 제품인 Bright Data Web Unlocker
// (api.brightdata.com/request)로 최종 HTML을 받아온다.
// 상품 추출은 페이지에 임베드된 schema.org JSON-LD(ItemList)를 우선 사용한다(CSS 클래스 변경에 안 깨지는 구조화 데이터).
// JSON-LD가 없으면 상품 앵커 텍스트로 폴백한다.
// → 우회 엔진을 갈아끼우려면 fetchHtml()만, 파싱을 바꾸려면 parseProducts()만 교체하면 된다.

interface ServiceProduct {
  productId: string
  url: string
  text: string
  price: number | null
}

const WU_ENDPOINT = 'https://api.brightdata.com/request'
const WU_API_KEY = process.env.BRD_API_KEY ?? process.env.COUPANG_WU_API_KEY ?? ''
const WU_ZONE = process.env.BRD_ZONE ?? 'web_unlocker1'
const WU_COUNTRY = process.env.BRD_COUNTRY ?? 'kr'
const SEARCH_TIMEOUT_MS = Number.parseInt(process.env.COUPANG_SEARCH_TIMEOUT ?? '90000', 10)

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

function toProductUrl(href: string): string {
  const path = href.split('?')[0]
  if (path.startsWith('http')) return path
  return `https://www.coupang.com${path.startsWith('/') ? path : `/${path}`}`
}

function parsePrice(raw: unknown): number | null {
  if (raw == null) return null
  const digits = String(raw).replace(/[^0-9]/g, '')
  if (!digits) return null
  const n = Number.parseInt(digits, 10)
  return Number.isFinite(n) ? n : null
}

// "1개당 X원" > "N% X원" > 첫 "X원" 순으로 앵커 텍스트에서 가격을 추출(JSON-LD 폴백용).
function parseAnchorPrice(text: string): number | null {
  const unit = text.match(/1개당\s*([0-9][0-9,]*)\s*원/)
  if (unit) return parsePrice(unit[1])
  const disc = text.match(/[0-9]+%\s*([0-9][0-9,]*)\s*원/)
  if (disc) return parsePrice(disc[1])
  const first = text.match(/([0-9][0-9,]{2,})\s*원/)
  return first ? parsePrice(first[1]) : null
}

// 쿠팡 검색 HTML에서 상품 목록을 추출한다. productId로 중복 제거.
function parseProducts(html: string): ServiceProduct[] {
  const byId = new Map<string, ServiceProduct>()

  // 1) schema.org JSON-LD (ItemList) 우선.
  for (const block of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    let data: unknown
    try {
      data = JSON.parse(block[1])
    } catch {
      continue
    }
    const root = data as Record<string, unknown>
    const list = (root?.mainEntity as Record<string, unknown>)?.itemListElement ?? root?.itemListElement
    if (!Array.isArray(list)) continue
    for (const el of list) {
      const it = (el?.item ?? el) as Record<string, unknown>
      if (!it) continue
      const url = String(it.url ?? '')
      const idMatch = url.match(/\/vp\/products\/(\d+)/)
      if (!idMatch) continue
      const id = idMatch[1]
      if (byId.has(id)) continue
      const offer = Array.isArray(it.offers) ? it.offers[0] : (it.offers as Record<string, unknown> | undefined)
      const price = parsePrice(offer?.price ?? offer?.lowPrice)
      const text = String(it.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 180)
      byId.set(id, { productId: id, url: toProductUrl(url), text, price })
    }
  }
  if (byId.size > 0) return [...byId.values()]

  // 2) 폴백: 상품 앵커 텍스트 (JSON-LD가 없을 때). <a>는 중첩 불가하므로 다음 </a>까지가 안전.
  for (const a of html.matchAll(/<a\b[^>]*href="([^"]*\/vp\/products\/(\d+)[^"]*)"[^>]*>(.*?)<\/a>/gs)) {
    const id = a[2]
    if (byId.has(id)) continue
    const text = a[3]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
    byId.set(id, { productId: id, url: toProductUrl(a[1]), text, price: parseAnchorPrice(text) })
  }
  return [...byId.values()]
}

export class CoupangSearcher implements MarketplaceSearcher {
  readonly id: MarketplaceId = 'coupang'
  readonly label = '쿠팡'

  async search(modelName: string): Promise<SearchResult> {
    const searchUrl = this.searchUrlFor(modelName)

    if (!WU_API_KEY) {
      return { modelName, products: [], error: '쿠팡 Web Unlocker API 키(BRD_API_KEY) 미설정', searchUrl }
    }

    // 실제 크롤은 가격순(salePriceAsc)으로 요청한다. 표시용 searchUrl은 정렬 없는 사용자 링크.
    const fetchUrl = `https://www.coupang.com/np/search?q=${encodeURIComponent(modelName)}&sorter=salePriceAsc&channel=user`

    let html: string
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
    try {
      const res = await fetch(WU_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WU_API_KEY}` },
        body: JSON.stringify({ zone: WU_ZONE, url: fetchUrl, format: 'raw', country: WU_COUNTRY }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        return { modelName, products: [], error: `쿠팡 Web Unlocker 오류 ${res.status} ${detail}`, searchUrl }
      }
      html = await res.text()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { modelName, products: [], error: `쿠팡 Web Unlocker 연결 실패: ${msg}`, searchUrl }
    } finally {
      clearTimeout(timer)
    }

    // Web Unlocker가 우회 실패 시 Akamai 차단 페이지가 그대로 넘어온다.
    if (!html.includes('/vp/products/') && /Access Denied|AkamaiGHost|errors\.edgesuite/.test(html)) {
      return { modelName, products: [], error: 'BLOCKED', searchUrl }
    }

    const candidates = parseProducts(html)
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
