export interface Product {
  modelName: string;       // 검색한 모델명
  productName: string;     // 상품명
  sellerName: string;      // 판매자
  couponPrice: number | null;   // 쿠폰적용가
  regularPrice: number | null;  // 정가
  shippingFee: number | null;   // 배송비 (null = 무료)
  discountPercent: number | null;
  productUrl: string;
  searchUrl?: string;      // 검색 결과 페이지 URL
  rank: number;
  crawledAt: Date;
  clusterSize?: number;    // 가격 클러스터 크기 (신뢰도 지표)
}

export interface SearchResult {
  modelName: string;
  products: Product[];
  searchUrl?: string;  // 최저가 정렬된 검색 페이지 URL
  error?: string;
  screenshotPath?: string;
}

export interface CrawlerOptions {
  headless: boolean;
  minDelay: number;
  maxDelay: number;
  outputDir: string;
  screenshotsDir: string;
}

export function getTotalPrice(product: Product): number | null {
  // 쿠폰적용가가 있으면 쿠폰적용가 기준, 없으면 정가 기준
  const basePrice = product.couponPrice ?? product.regularPrice;
  if (basePrice === null) return null;
  return basePrice + (product.shippingFee ?? 0);
}

export function getLowestPriceProduct(products: Product[]): Product | null {
  const valid = products.filter(p => getTotalPrice(p) !== null);
  if (valid.length === 0) return null;

  // 단순 최저가 (상품 1개 이하일 때)
  if (valid.length <= 1) {
    const product = valid[0] || null;
    if (product) {
      product.clusterSize = 1;
    }
    return product;
  }

  // 가격 클러스터링: 비슷한 가격대(30% 이내) 그룹에서 최저가 선택
  // 이상치(다른 제품) 필터링 목적
  const sorted = [...valid].sort((a, b) => getTotalPrice(a)! - getTotalPrice(b)!);

  // 가격 클러스터 찾기: 인접한 상품과 30% 이내 차이면 같은 그룹
  const clusters: Product[][] = [];
  let currentCluster: Product[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevPrice = getTotalPrice(sorted[i - 1])!;
    const currPrice = getTotalPrice(sorted[i])!;
    const diff = (currPrice - prevPrice) / prevPrice;

    if (diff <= 0.3) {
      // 30% 이내 차이면 같은 클러스터
      currentCluster.push(sorted[i]);
    } else {
      // 새 클러스터 시작
      clusters.push(currentCluster);
      currentCluster = [sorted[i]];
    }
  }
  clusters.push(currentCluster);

  // 3개 이상인 클러스터 중 가장 큰 것 선택
  const validClusters = clusters.filter(c => c.length >= 3);

  if (validClusters.length > 0) {
    // 가장 큰 클러스터에서 최저가
    const largestCluster = validClusters.reduce((max, c) =>
      c.length > max.length ? c : max
    );
    const product = largestCluster[0]; // 이미 정렬되어 있으므로 첫 번째가 최저가
    product.clusterSize = largestCluster.length;
    return product;
  }

  // 3개 이상 클러스터가 없으면 가장 큰 클러스터에서 선택
  const largestCluster = clusters.reduce((max, c) =>
    c.length > max.length ? c : max
  );
  const product = largestCluster[0];
  product.clusterSize = largestCluster.length;
  return product;
}
