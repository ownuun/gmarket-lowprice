import type { Page } from 'playwright';
import { BrowserManager } from './browser.js';
import { GmarketParser } from './parser.js';
import { getTotalPrice, type Product, type SearchResult } from './types.js';

const BLOCKED_SIGNALS = [
  'captcha',
  'robot',
  'blocked',
  'access denied',
  'unusual traffic',
  'cloudflare',
  '봇 확인',
  '사람인지 확인',
  '원활한 서비스 이용',
  '간단한 확인',
  '자동화',
  '자동으로 작동하는 프로그램',
];

const UNCLE_SELLER_NAMES = ['(주)계양전동공구', '주식회사에이치원', '흥원닷컴'];
const CLUSTER_GAP_THRESHOLD = 0.3;
const CLUSTER_REPRESENTED_TOLERANCE = 0.15;
const DEVICE_PRICE_BAND_TOLERANCE = 0.25;
const DEVICE_MIN_PRICE = 30000;
const ANCHOR_PRICE_MIN_THRESHOLD = 10000;

function getEnvInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function randomDelayMs(minMs: number, maxMs: number): number {
  const min = Math.max(0, Math.min(minMs, maxMs));
  const max = Math.max(min, maxMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const MODEL_BAND_MIN_PHASE_DELAY = getEnvInt('MODEL_BAND_MIN_PHASE_DELAY', 8000);
const MODEL_BAND_MAX_PHASE_DELAY = getEnvInt('MODEL_BAND_MAX_PHASE_DELAY', 12000);
const MODEL_BAND_SPARSE_THRESHOLD = 2;
const MODEL_BAND_SPARSE_RETRY_EXTRA_WAIT = 2500;

type SearchStrategyName = 'lowprice' | 'model-band' | 'llm-assisted';

const DEVICE_KEYWORDS = [
  '본체',
  '탁상그라인더',
  '벤치그라인더',
  '그라인더',
  '에어임팩렌치',
  '임팩렌치',
  '렌치',
  '드릴',
  '샌더',
  '절단기',
  '세트',
];

const PART_KEYWORDS = [
  '부품',
  '연마석',
  '가이드바',
  '커버',
  '날',
  '페이퍼',
  '패드',
  '케이스',
  '개스킷',
  '와셔',
  '핀',
  '밸브',
  '브러시',
];

export class GmarketSearcher {
  private browser: BrowserManager;
  private parser: GmarketParser;
  private sessionEstablished = false;

  private static BASE_URL = 'https://www.gmarket.co.kr';
  private static SEARCH_URL = 'https://browse.gmarket.co.kr/search';
  private static FILTER_PARAMS = '&s=1&c=100000076&f=c:100000076';
  private static RECOMMENDED_FILTER_PARAMS = '&c=100000076&f=c:100000076';

  constructor(browser: BrowserManager) {
    this.browser = browser;
    this.parser = new GmarketParser();
    this.sessionEstablished = false;
  }

  resetSession(): void {
    this.sessionEstablished = false;
  }

  private buildDirectSearchUrl(keyword: string): string {
    return `${GmarketSearcher.SEARCH_URL}?keyword=${encodeURIComponent(keyword)}${GmarketSearcher.FILTER_PARAMS}`;
  }

  private buildPriceFilteredSearchUrl(keyword: string, minPrice: number, maxPrice: number): string {
    const url = new URL(GmarketSearcher.SEARCH_URL);
    url.searchParams.set('keyword', keyword);
    url.searchParams.set('s', '1');
    url.searchParams.set('c', '100000076');
    url.searchParams.set('f', `c:100000076,p:${Math.max(0, Math.floor(minPrice))}^${Math.max(0, Math.ceil(maxPrice))}`);
    return url.toString();
  }

  private buildRecommendedSearchUrl(keyword: string): string {
    return `${GmarketSearcher.SEARCH_URL}?keyword=${encodeURIComponent(keyword)}${GmarketSearcher.RECOMMENDED_FILTER_PARAMS}`;
  }

  private buildPageUrl(searchUrl: string, pageNumber: number): string {
    const url = new URL(searchUrl);
    url.searchParams.set('k', '0');
    url.searchParams.set('p', String(pageNumber));
    url.searchParams.set('keep-ssid', 'y');
    return url.toString();
  }

  buildFilteredUrl(baseSearchUrl: string): string {
    if (baseSearchUrl.includes('s=1')) return baseSearchUrl;
    return baseSearchUrl + GmarketSearcher.FILTER_PARAMS;
  }

  async search(modelName: string, takeScreenshot = true): Promise<SearchResult> {
    console.log(`\n[검색] ${modelName}`);

    const page = await this.browser.newPageInContext();

    try {
      if (!this.sessionEstablished) {
        await this.establishSession(page);
      }

      const strategy = this.getSearchStrategyName();
      console.log(`  검색전략: ${strategy}`);

      if (strategy === 'model-band' || strategy === 'llm-assisted') {
        return await this.searchModelBandStrategy(page, modelName, takeScreenshot, strategy);
      }

      return await this.searchLowPriceStrategy(page, modelName, takeScreenshot);

    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.log(`  [오류] ${error}`);
      return {
        modelName,
        products: [],
        error,
      };
    } finally {
      await page.close();
    }
  }

  private getSearchStrategyName(): SearchStrategyName {
    const value = process.env.SEARCH_STRATEGY;
    if (value === 'model-band' || value === 'llm-assisted') return value;
    return 'lowprice';
  }

  private async searchLowPriceStrategy(
    page: Page,
    modelName: string,
    takeScreenshot: boolean,
  ): Promise<SearchResult> {
    const searchUrl = this.buildDirectSearchUrl(modelName);
    console.log(`  검색결과: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500 + Math.random() * 1500);

    const blocked = await this.getBlockedResultIfNeeded(page, modelName, '상품 대기 건너뜀');
    if (blocked) return blocked;

    await this.waitForProducts(page);
    await page.waitForTimeout(500 + Math.random() * 1000);

    const blockedAfterWait = await this.getBlockedResultIfNeeded(page, modelName, 'Context 교체 필요');
    if (blockedAfterWait) return blockedAfterWait;

    let screenshotPath: string | undefined;
    if (takeScreenshot) {
      screenshotPath = await this.browser.takeScreenshot(page, modelName);
      console.log(`  스크린샷: ${screenshotPath}`);
    }

    const products = await this.parser.parseSearchResults(page, modelName);
    console.log(`  파싱 결과: ${products.length}개`);

    let pageProducts = await this.parser.parseSearchResults(page, modelName, { maxItems: 80 });
    let page2Checked = false;

    if (!pageProducts.some((product) => this.isUncleSeller(product.sellerName))) {
      page2Checked = true;
      const page2Url = this.buildPageUrl(searchUrl, 2);
      console.log(`  판매계정 상품 없음 - 2페이지 확인: ${page2Url}`);
      await page.goto(page2Url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500 + Math.random() * 1500);

      if (!(await this.isBlocked(page))) {
        await this.waitForProducts(page);
        await page.waitForTimeout(500 + Math.random() * 1000);
        const seen = new Set(pageProducts.map((product) => product.productNo || product.productName));
        const page2Products = await this.parser.parseSearchResults(page, modelName, {
          maxItems: 80,
          rankOffset: 60,
          skipProductKeys: seen,
        });
        pageProducts = [...pageProducts, ...page2Products];
        console.log(`  2페이지 추가 파싱 결과: ${page2Products.length}개`);
      } else {
        console.log('  [경고] 2페이지 확인 중 차단 감지 - 1페이지 기준만 사용');
      }
    }

    const sellerClusterProducts = this.getMissingSellerClusterProducts(pageProducts, products);

    if (sellerClusterProducts.length > 0) {
      console.log(`  클러스터링 추가 결과: ${sellerClusterProducts.length}개`);
    }

    return {
      modelName,
      products,
      sellerClusterProducts,
      sellerClusterMeta: {
        sellerProductCount: pageProducts.filter((product) => this.isUncleSeller(product.sellerName)).length,
        page2Checked,
        clusterCount: this.clusterByPrice(
          pageProducts.filter((product) => this.isUncleSeller(product.sellerName)),
        ).length,
        addedClusterCount: new Set(sellerClusterProducts.map((product) => product.priceGroupLabel)).size,
        addedProductCount: sellerClusterProducts.length,
      },
      searchUrl,
      screenshotPath,
    };
  }

  private async searchModelBandStrategy(
    page: Page,
    modelName: string,
    takeScreenshot: boolean,
    strategy: SearchStrategyName,
  ): Promise<SearchResult> {
    const recommendedUrl = this.buildRecommendedSearchUrl(modelName);
    console.log(`  추천순 검색결과: ${recommendedUrl}`);
    await page.goto(recommendedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500 + Math.random() * 1500);
    const blocked = await this.getBlockedResultIfNeeded(page, modelName, '추천순 상품 대기 건너뜀');
    if (blocked) return blocked;
    await this.waitForProducts(page);
    await page.waitForTimeout(500 + Math.random() * 1000);
    const blockedAfterWait = await this.getBlockedResultIfNeeded(page, modelName, '추천순 Context 교체 필요');
    if (blockedAfterWait) return blockedAfterWait;

    let screenshotPath: string | undefined;
    if (takeScreenshot) {
      screenshotPath = await this.browser.takeScreenshot(page, `${modelName}_recommended`);
      console.log(`  스크린샷: ${screenshotPath}`);
    }

    const recommendedProducts = await this.parser.parseSearchResults(page, modelName, { maxItems: 80 });
    console.log(`  추천순 파싱 결과: ${recommendedProducts.length}개`);
    const bandDecision = this.inferModelDeviceBand(modelName, recommendedProducts, strategy);
    if (!bandDecision) {
      console.log('  [전략] 모델 가격대 판단 실패 - 기존 최저가 전략 사용');
      return await this.searchLowPriceStrategy(page, modelName, takeScreenshot);
    }

    console.log(
      `  [전략] 모델 가격대 ${bandDecision.min.toLocaleString()}-${bandDecision.max.toLocaleString()}원 ` +
      `(기준 ${bandDecision.anchorPrice.toLocaleString()}원, 후보 ${bandDecision.candidates.length}개)`,
    );

    const phaseDelay = randomDelayMs(MODEL_BAND_MIN_PHASE_DELAY, MODEL_BAND_MAX_PHASE_DELAY);
    if (phaseDelay > 0) {
      console.log(`  [전략] 가격대 검색 전 대기 ${(phaseDelay / 1000).toFixed(1)}초`);
      await page.waitForTimeout(phaseDelay);
    }

    let activeBandDecision = bandDecision;
    const lowPriceUrl = this.buildPriceFilteredSearchUrl(modelName, activeBandDecision.min, activeBandDecision.max);
    console.log(`  가격대 최저가 검색결과: ${lowPriceUrl}`);
    await page.goto(lowPriceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500 + Math.random() * 1500);
    const lowPriceBlocked = await this.getBlockedResultIfNeeded(page, modelName, '가격대 최저가 상품 대기 건너뜀');
    if (lowPriceBlocked) return lowPriceBlocked;
    await this.waitForProducts(page);
    await page.waitForTimeout(500 + Math.random() * 1000);

    let lowPriceProducts = await this.parser.parseSearchResults(page, modelName, { maxItems: 120 });
    const lowestUncleProduct = this.getLowestUncleModelProduct(modelName, lowPriceProducts);
    const lowestUnclePrice = lowestUncleProduct ? this.getItemPrice(lowestUncleProduct) : null;

    if (lowestUnclePrice !== null && lowestUnclePrice < activeBandDecision.anchorPrice) {
      activeBandDecision = {
        ...activeBandDecision,
        min: Math.floor(lowestUnclePrice * (1 - DEVICE_PRICE_BAND_TOLERANCE)),
        max: Math.ceil(lowestUnclePrice * (1 + DEVICE_PRICE_BAND_TOLERANCE)),
        anchorPrice: lowestUnclePrice,
        reasons: [...activeBandDecision.reasons, '최저삼촌판매가기준보정'],
      };
      console.log(
        `  [전략] 더 낮은 삼촌 판매가 발견 - 가격대 재검색 ` +
        `${activeBandDecision.min.toLocaleString()}-${activeBandDecision.max.toLocaleString()}원 ` +
        `(기준 ${activeBandDecision.anchorPrice.toLocaleString()}원)`,
      );
      const refineDelay = randomDelayMs(MODEL_BAND_MIN_PHASE_DELAY, MODEL_BAND_MAX_PHASE_DELAY);
      if (refineDelay > 0) {
        console.log(`  [전략] 보정 검색 전 대기 ${(refineDelay / 1000).toFixed(1)}초`);
        await page.waitForTimeout(refineDelay);
      }
      const refinedUrl = this.buildPriceFilteredSearchUrl(modelName, activeBandDecision.min, activeBandDecision.max);
      console.log(`  보정 가격대 최저가 검색결과: ${refinedUrl}`);
      await page.goto(refinedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500 + Math.random() * 1500);
      const refinedBlocked = await this.getBlockedResultIfNeeded(page, modelName, '보정 가격대 최저가 상품 대기 건너뜀');
      if (refinedBlocked) return refinedBlocked;
      await this.waitForProducts(page);
      await page.waitForTimeout(500 + Math.random() * 1000);
      lowPriceProducts = await this.parser.parseSearchResults(page, modelName, { maxItems: 120 });
    }

    const exactBandFilter = (list: Product[]): Product[] =>
      list
        .filter((product) => this.isExactModelProduct(modelName, product.productName))
        .filter((product) => this.isProductInPriceBand(product, activeBandDecision.min, activeBandDecision.max));

    let exactBandProducts = exactBandFilter(lowPriceProducts);

    if (exactBandProducts.length < MODEL_BAND_SPARSE_THRESHOLD) {
      console.log(`  [전략] 가격대 결과 희박 (${exactBandProducts.length}개) - 가격대 검색 재파싱 시도`);
      const retryDelay = randomDelayMs(MODEL_BAND_MIN_PHASE_DELAY, MODEL_BAND_MAX_PHASE_DELAY);
      if (retryDelay > 0) {
        console.log(`  [전략] 재시도 전 대기 ${(retryDelay / 1000).toFixed(1)}초`);
        await page.waitForTimeout(retryDelay);
      }
      const retryUrl = this.buildPriceFilteredSearchUrl(modelName, activeBandDecision.min, activeBandDecision.max);
      console.log(`  재시도 가격대 최저가 검색결과: ${retryUrl}`);
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500 + Math.random() * 1500);
      const retryBlocked = await this.getBlockedResultIfNeeded(page, modelName, '재시도 가격대 최저가 상품 대기 건너뜀');
      if (retryBlocked) return retryBlocked;
      await this.waitForProducts(page);
      await page.waitForTimeout(MODEL_BAND_SPARSE_RETRY_EXTRA_WAIT + Math.random() * 1000);
      const retryProducts = await this.parser.parseSearchResults(page, modelName, { maxItems: 120 });
      const retryExactBand = exactBandFilter(retryProducts);
      console.log(
        `  [전략] 재파싱 결과: 전체 ${retryProducts.length}개, 정확모델·가격대 ${retryExactBand.length}개`,
      );
      if (retryExactBand.length > exactBandProducts.length) {
        lowPriceProducts = retryProducts;
        exactBandProducts = retryExactBand;
      }
    }

    if (exactBandProducts.length < MODEL_BAND_SPARSE_THRESHOLD) {
      const seenKeys = new Set(exactBandProducts.map((product) => this.getProductKey(product)));
      const recommendedFallback = exactBandFilter(recommendedProducts).filter((product) => {
        const key = this.getProductKey(product);
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
      if (recommendedFallback.length > 0) {
        console.log(`  [전략] 가격대 결과 여전히 희박 - 추천순 후보에서 ${recommendedFallback.length}개 보완`);
        exactBandProducts = [...exactBandProducts, ...recommendedFallback];
      }
    }

    const products = exactBandProducts
      .sort((a, b) => this.getItemPrice(a)! - this.getItemPrice(b)!)
      .slice(0, 10)
      .map((product) => ({
        ...product,
        strategyLabel: '최저가',
        matchReasons: ['정확모델', '가격대필터'],
      }));

    const addedKeys = new Set(products.map((product) => this.getProductKey(product)));
    const sourceProducts = bandDecision.candidates
      .filter((product) => this.isUncleSeller(product.sellerName))
      .filter((product) => this.isProductInPriceBand(product, activeBandDecision.min, activeBandDecision.max))
      .filter((product) => {
        const key = this.getProductKey(product);
        if (addedKeys.has(key)) return false;
        addedKeys.add(key);
        return true;
      })
      .sort((a, b) => this.getItemPrice(a)! - this.getItemPrice(b)!)
      .map((product) => ({
        ...product,
        strategyLabel: '최저가',
        clusterSourceSeller: true,
        matchReasons: ['기준판매자', '정확모델', '가격대필터'],
      }));

    const strategyProducts = [...products, ...sourceProducts];
    console.log(`  [전략] 모델최저가 결과: ${strategyProducts.length}개`);

    return {
      modelName,
      products: strategyProducts,
      strategyProducts,
      strategyMeta: {
        strategy,
        confidence: bandDecision.confidence,
        priceBand: {
          min: activeBandDecision.min,
          max: activeBandDecision.max,
          anchorPrice: activeBandDecision.anchorPrice,
        },
        recommendedProductCount: recommendedProducts.length,
        candidateCount: bandDecision.candidates.length,
        reasons: activeBandDecision.reasons,
      },
      searchUrl: lowPriceUrl,
      screenshotPath,
    };
  }

  private async getBlockedResultIfNeeded(
    page: Page,
    modelName: string,
    message: string,
  ): Promise<SearchResult | null> {
    if (!(await this.isBlocked(page))) return null;
    console.log(`  [경고] 차단 감지 - ${message}`);
    const snippet = await this.getPageSnippet(page);
    const screenshot = await this.browser.takeScreenshot(page, `blocked_${modelName}`);
    return {
      modelName,
      products: [],
      error: 'BLOCKED',
      screenshotPath: screenshot,
      pageSnippet: snippet,
    };
  }

  private inferModelDeviceBand(
    modelName: string,
    products: Product[],
    strategy: SearchStrategyName,
  ): {
    min: number;
    max: number;
    anchorPrice: number;
    candidates: Product[];
    confidence: number;
    reasons: string[];
  } | null {
    const scored = products
      .map((product) => this.scoreModelDeviceCandidate(modelName, product))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    const llmDecision = strategy === 'llm-assisted'
      ? this.tryGetLlmPriceBandDecision(modelName, scored.slice(0, 20))
      : null;
    if (llmDecision) return llmDecision;

    const candidates = scored.map((candidate) => candidate.product);
    if (candidates.length === 0) return null;

    const uncleDeviceCandidates = scored.filter(
      (candidate) => this.isUncleSeller(candidate.product.sellerName) && this.getItemPrice(candidate.product) !== null,
    );
    let primaryCandidate: typeof scored[0] | null = null;
    if (uncleDeviceCandidates.length > 0) {
      // 선호: 만원 초과 삼촌 판매자 후보
      const validUncleAboveThreshold = uncleDeviceCandidates.filter(
        (candidate) => this.getItemPrice(candidate.product)! > ANCHOR_PRICE_MIN_THRESHOLD,
      );
      if (validUncleAboveThreshold.length > 0) {
        primaryCandidate = validUncleAboveThreshold.sort(
          (a, b) => this.getItemPrice(a.product)! - this.getItemPrice(b.product)!,
        )[0];
      } else {
        // 폴백: 만원 이하 삼촌 판매자 (더 나은 대안 없을 때)
        primaryCandidate = uncleDeviceCandidates.sort(
          (a, b) => this.getItemPrice(a.product)! - this.getItemPrice(b.product)!,
        )[0];
      }
    } else {
      primaryCandidate = scored[0];
    }
    const anchorPrice = this.getItemPrice(primaryCandidate.product);
    if (anchorPrice === null) return null;

    const reasons = uncleDeviceCandidates.length > 0
      ? [...primaryCandidate.reasons, '삼촌판매가기준']
      : primaryCandidate.reasons;

    return {
      min: Math.floor(anchorPrice * (1 - DEVICE_PRICE_BAND_TOLERANCE)),
      max: Math.ceil(anchorPrice * (1 + DEVICE_PRICE_BAND_TOLERANCE)),
      anchorPrice,
      candidates,
      confidence: Math.min(primaryCandidate.score / 100, 0.95),
      reasons,
    };
  }

  private scoreModelDeviceCandidate(modelName: string, product: Product): {
    product: Product;
    score: number;
    reasons: string[];
  } {
    const reasons: string[] = [];
    let score = 0;
    const productName = product.productName;
    const price = this.getItemPrice(product);

    if (this.isExactModelProduct(modelName, productName)) {
      score += 50;
      reasons.push('정확모델');
    } else {
      return { product, score: -100, reasons: ['모델불일치'] };
    }

    if (this.hasVariantSuffix(modelName, productName)) {
      score -= 70;
      reasons.push('변형모델감점');
    }

    if (this.isUncleSeller(product.sellerName)) {
      score += 30;
      reasons.push('기준판매자');
    }

    const deviceKeyword = DEVICE_KEYWORDS.find((keyword) => productName.includes(keyword));
    if (deviceKeyword) {
      score += 20;
      reasons.push(`기기키워드:${deviceKeyword}`);
    }

    const partKeyword = PART_KEYWORDS.find((keyword) => productName.includes(keyword));
    if (partKeyword) {
      score -= 25;
      reasons.push(`부품키워드:${partKeyword}`);
    }

    if (price !== null) {
      if (price >= DEVICE_MIN_PRICE) {
        score += 20;
        reasons.push('고가격대');
      } else if (price < 10000) {
        score -= 25;
        reasons.push('저가격대감점');
      }
    }

    score += Math.max(0, 20 - Math.floor(product.rank / 3));
    reasons.push('추천순순위');

    return { product, score, reasons };
  }

  private isExactModelProduct(modelName: string, productName: string): boolean {
    const modelPattern = this.buildModelPattern(modelName);
    return modelPattern.test(productName.toUpperCase()) || this.hasNormalizedModelMatch(modelName, productName);
  }

  private hasNormalizedModelMatch(modelName: string, productName: string): boolean {
    const normalizedModel = this.normalizeModelCode(modelName);
    const normalizedName = this.normalizeModelCode(productName);
    if (!normalizedModel) return false;

    let index = normalizedName.indexOf(normalizedModel);
    while (index !== -1) {
      const prev = normalizedName[index - 1];
      const next = normalizedName[index + normalizedModel.length];
      const hasModelBoundaryBefore = !prev || !/[A-Z0-9]/.test(prev);
      const hasModelBoundaryAfter = !next || !/[A-Z0-9]/.test(next);
      if (hasModelBoundaryBefore && hasModelBoundaryAfter) return true;
      index = normalizedName.indexOf(normalizedModel, index + 1);
    }

    return false;
  }

  private hasVariantSuffix(modelName: string, productName: string): boolean {
    const normalizedModel = this.normalizeModelCode(modelName);
    const normalizedName = this.normalizeModelCode(productName);
    const index = normalizedName.indexOf(normalizedModel);
    if (index === -1) return false;
    const next = normalizedName[index + normalizedModel.length];
    return Boolean(next && /[A-Z0-9]/.test(next));
  }

  private buildModelPattern(modelName: string): RegExp {
    const escapedParts = modelName
      .toUpperCase()
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const body = escapedParts.join('[-_\\s]*');
    return new RegExp(`(^|[^A-Z0-9])${body}(?![A-Z0-9])`);
  }

  private normalizeModelCode(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9가-힣]/g, '');
  }

  private isProductInPriceBand(product: Product, min: number, max: number): boolean {
    const price = this.getItemPrice(product);
    return price !== null && price >= min && price <= max;
  }

  private getLowestUncleModelProduct(modelName: string, products: Product[]): Product | null {
    const candidates = products.filter((product) => (
      this.isUncleSeller(product.sellerName) &&
      this.isExactModelProduct(modelName, product.productName) &&
      this.getItemPrice(product) !== null
    ));
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => this.getItemPrice(a)! - this.getItemPrice(b)!)[0];
  }

  private getItemPrice(product: Product): number | null {
    return product.couponPrice ?? product.regularPrice;
  }

  private tryGetLlmPriceBandDecision(
    modelName: string,
    candidates: Array<{ product: Product; score: number; reasons: string[] }>,
  ): {
    min: number;
    max: number;
    anchorPrice: number;
    candidates: Product[];
    confidence: number;
    reasons: string[];
  } | null {
    if (!process.env.LLM_STRATEGY_ENABLED) return null;
    console.log(`  [LLM] ${modelName} LLM 전략은 아직 판단 스캐폴드만 활성화됨 - 규칙 기반 사용`);
    void candidates;
    return null;
  }

  private async establishSession(page: Page): Promise<void> {
    console.log('  세션 확립 중 (메인 페이지 방문)...');
    await page.goto(GmarketSearcher.BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000 + Math.random() * 2000);
    this.sessionEstablished = true;
  }

  private getMissingSellerClusterProducts(allProducts: Product[], baseProducts: Product[]): Product[] {
    const sellerProducts = allProducts.filter((product) => this.isUncleSeller(product.sellerName));
    const clusters = this.clusterByPrice(sellerProducts);
    const additions: Product[] = [];
    const addedKeys = new Set<string>();
    let clusterNumber = 1;

    for (const cluster of clusters) {
      if (this.isClusterRepresented(cluster, baseProducts)) continue;

      const label = `클러스터링${clusterNumber}`;
      const clusterProducts = this.getProductsAroundClusterPrice(allProducts, cluster)
        .filter((product) => {
          const key = this.getProductKey(product);
          if (addedKeys.has(key)) return false;
          addedKeys.add(key);
          return true;
        })
        .map((product) => ({ ...product, priceGroupLabel: label }));

      if (clusterProducts.length === 0) continue;

      additions.push(...clusterProducts);

      const sourceSellerProducts = cluster
        .filter((product) => {
          const key = this.getProductKey(product);
          if (addedKeys.has(key)) return false;
          addedKeys.add(key);
          return true;
        })
        .sort((a, b) => getTotalPrice(a)! - getTotalPrice(b)!)
        .map((product) => ({
          ...product,
          priceGroupLabel: label,
          clusterSourceSeller: true,
        }));

      additions.push(...sourceSellerProducts);
      clusterNumber++;
    }

    return additions;
  }

  private getProductsAroundClusterPrice(allProducts: Product[], cluster: Product[]): Product[] {
    const prices = cluster
      .map((product) => getTotalPrice(product))
      .filter((price): price is number => price !== null);

    if (prices.length === 0) return [];

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const lowerBound = minPrice * (1 - CLUSTER_GAP_THRESHOLD);
    const upperBound = maxPrice * (1 + CLUSTER_GAP_THRESHOLD);

    return allProducts
      .filter((product) => {
        const price = getTotalPrice(product);
        return price !== null && price >= lowerBound && price <= upperBound;
      })
      .sort((a, b) => getTotalPrice(a)! - getTotalPrice(b)!)
      .slice(0, 10);
  }

  private getProductKey(product: Product): string {
    return product.productNo || product.productUrl || `${product.productName}:${product.sellerName}`;
  }

  private isUncleSeller(sellerName: string): boolean {
    const normalizedSeller = this.normalizeSellerName(sellerName);
    return UNCLE_SELLER_NAMES.some(
      (name) => normalizedSeller.includes(this.normalizeSellerName(name)),
    );
  }

  private normalizeSellerName(value: string): string {
    return value.replace(/\s+/g, '').toLowerCase();
  }

  private clusterByPrice(products: Product[]): Product[][] {
    const sorted = products
      .filter((product) => getTotalPrice(product) !== null)
      .sort((a, b) => getTotalPrice(a)! - getTotalPrice(b)!);

    if (sorted.length === 0) return [];

    const clusters: Product[][] = [];
    let currentCluster: Product[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prevPrice = getTotalPrice(sorted[i - 1])!;
      const currPrice = getTotalPrice(sorted[i])!;
      const gap = (currPrice - prevPrice) / prevPrice;

      if (gap <= CLUSTER_GAP_THRESHOLD) {
        currentCluster.push(sorted[i]);
      } else {
        clusters.push(currentCluster);
        currentCluster = [sorted[i]];
      }
    }

    clusters.push(currentCluster);
    return clusters;
  }

  private isClusterRepresented(cluster: Product[], baseProducts: Product[]): boolean {
    return cluster.some((clusterProduct) => {
      const clusterPrice = getTotalPrice(clusterProduct);
      if (clusterPrice === null) return false;

      return baseProducts.some((baseProduct) => {
        const basePrice = getTotalPrice(baseProduct);
        if (basePrice === null) return false;
        return Math.abs(basePrice - clusterPrice) / clusterPrice <= CLUSTER_REPRESENTED_TOLERANCE;
      });
    });
  }

  private async isBlocked(page: Page): Promise<boolean> {
    try {
      const bodyText = await page.evaluate(() =>
        document.body?.innerText?.toLowerCase().slice(0, 2000) || ''
      );
      return BLOCKED_SIGNALS.some(signal => bodyText.includes(signal));
    } catch {
      return false;
    }
  }

  private async getPageSnippet(page: Page): Promise<string> {
    try {
      return await page.evaluate(() =>
        (document.body?.innerText || '').slice(0, 500)
      );
    } catch {
      return '';
    }
  }

  private async waitForProducts(page: Page): Promise<void> {
    const selectors = [
      'div.box__item-container',
      '[class*="item_list"]',
      '[data-montelena-acode]',
    ];

    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        return;
      } catch { /* try next */ }
    }

    console.log('  [경고] 상품 컨테이너를 찾지 못함');
  }
}
