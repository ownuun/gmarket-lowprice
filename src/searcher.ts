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

export class GmarketSearcher {
  private browser: BrowserManager;
  private parser: GmarketParser;
  private sessionEstablished = false;

  private static BASE_URL = 'https://www.gmarket.co.kr';
  private static SEARCH_URL = 'https://browse.gmarket.co.kr/search';
  private static FILTER_PARAMS = '&s=1&c=100000076&f=c:100000076';

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

      const searchUrl = this.buildDirectSearchUrl(modelName);
      console.log(`  검색결과: ${searchUrl}`);

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500 + Math.random() * 1500);

      if (await this.isBlocked(page)) {
        console.log('  [경고] 차단 감지 - 상품 대기 건너뜀');
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

      await this.waitForProducts(page);
      await page.waitForTimeout(500 + Math.random() * 1000);

      if (await this.isBlocked(page)) {
        console.log('  [경고] 차단 감지 - Context 교체 필요');
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
