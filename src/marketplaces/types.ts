import type { Product, SearchResult } from '../types.js'

// 지원 마켓 식별자. 새 마켓을 추가하려면 여기에 id를 더하고 registry에 descriptor를 등록한다.
export type MarketplaceId = 'gmarket' | 'coupang'

export const MARKETPLACE_IDS: readonly MarketplaceId[] = ['gmarket', 'coupang'] as const

// 외부 입력(폼/쿼리/DB)을 안전한 MarketplaceId로 좁힌다. 알 수 없으면 기본 'gmarket'.
export function parseMarketplaceId(value: string | null | undefined): MarketplaceId {
  return value === 'coupang' ? 'coupang' : 'gmarket'
}

// 마켓별 검색 플러그인 공통 인터페이스.
// 워커는 job.marketplace로 플러그인을 골라 search()만 호출하므로, 엔진을 자유롭게 갈아끼울 수 있다.
export interface MarketplaceSearcher {
  readonly id: MarketplaceId
  readonly label: string
  // 모델명을 검색해 표준 SearchResult를 반환한다. 봇 차단 시 result.error === 'BLOCKED'.
  search(modelName: string): Promise<SearchResult>
  // 선택: 브라우저/커넥션 정리.
  dispose?(): Promise<void>
}

export type { Product, SearchResult }
