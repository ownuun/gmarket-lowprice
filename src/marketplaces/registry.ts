import type { MarketplaceId, MarketplaceSearcher } from './types.js'
import { CoupangSearcher } from './coupang.js'

// 마켓 플러그인 메타데이터.
// - selfContained: true  → createSearcher()로 독립 검색기 생성 (예: 쿠팡 = HTTP 사이드카 호출)
// - selfContained: false → 워커가 BrowserManager 수명주기를 직접 관리 (예: G마켓 인프로세스 Playwright)
export interface MarketplaceDescriptor {
  id: MarketplaceId
  label: string
  selfContained: boolean
  createSearcher?: () => MarketplaceSearcher
}

export const MARKETPLACES: Record<MarketplaceId, MarketplaceDescriptor> = {
  gmarket: {
    id: 'gmarket',
    label: 'G마켓',
    selfContained: false,
  },
  coupang: {
    id: 'coupang',
    label: '쿠팡',
    selfContained: true,
    createSearcher: () => new CoupangSearcher(),
  },
}

export function getMarketplace(id: MarketplaceId): MarketplaceDescriptor {
  return MARKETPLACES[id] ?? MARKETPLACES.gmarket
}
