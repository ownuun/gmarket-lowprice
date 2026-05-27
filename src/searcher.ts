import type { Page } from 'playwright';
import { BrowserManager } from './browser.js';
import { GmarketParser } from './parser.js';
import type { SearchResult } from './types.js';

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
      await page.close();
    }
  }

  private async establishSession(page: Page): Promise<void> {
    console.log('  세션 확립 중 (메인 페이지 방문)...');
    await page.goto(GmarketSearcher.BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000 + Math.random() * 2000);
    this.sessionEstablished = true;
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
