import type { Page } from 'playwright';
import { BrowserManager } from './browser.js';
import { GmarketParser } from './parser.js';
import type { SearchResult } from './types.js';

export class GmarketSearcher {
  private browser: BrowserManager;
  private parser: GmarketParser;

  private static BASE_URL = 'https://www.gmarket.co.kr';
  // s=1 = 낮은가격순, c=100000076 + f=c:100000076 = 공구 카테고리 필터
  private static FILTER_PARAMS = '&s=1&c=100000076&f=c:100000076';

  constructor(browser: BrowserManager) {
    this.browser = browser;
    this.parser = new GmarketParser();
  }

  buildFilteredUrl(baseSearchUrl: string): string {
    // 이미 파라미터가 있으면 추가하지 않음
    if (baseSearchUrl.includes('s=1')) return baseSearchUrl;
    return baseSearchUrl + GmarketSearcher.FILTER_PARAMS;
  }

  async search(modelName: string, takeScreenshot = true): Promise<SearchResult> {
    console.log(`\n[검색] ${modelName}`);

    const { page, context } = await this.browser.newPage();

    try {
      const searchUrl = `${GmarketSearcher.BASE_URL}/n/search?keyword=${encodeURIComponent(modelName)}${GmarketSearcher.FILTER_PARAMS}`;
      console.log(`  URL: ${searchUrl}`);

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      await this.waitForProducts(page);
      await page.waitForTimeout(1000);

      let screenshotPath: string | undefined;
      if (takeScreenshot) {
        screenshotPath = await this.browser.takeScreenshot(page, modelName);
        console.log(`  스크린샷: ${screenshotPath}`);
      }

      const products = await this.parser.parseSearchResults(page, modelName);
      console.log(`  파싱 결과: ${products.length}개`);

      return {
        modelName,
        products,
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
      await context.close();
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
