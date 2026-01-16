import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

// Stealth 플러그인 적용 (Cloudflare 우회)
chromium.use(StealthPlugin());

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class BrowserManager {
  private browser: Browser | null = null;
  private headless: boolean;
  private screenshotsDir: string;

  constructor(headless = true, screenshotsDir = 'data/screenshots') {
    this.headless = headless;
    this.screenshotsDir = screenshotsDir;
  }

  async start(): Promise<void> {
    await mkdir(this.screenshotsDir, { recursive: true });

    this.browser = await chromium.launch({
      headless: this.headless,
    });
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async newPage(): Promise<{ page: Page; context: BrowserContext }> {
    if (!this.browser) throw new Error('Browser not started');

    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });

    const page = await context.newPage();

    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    return { page, context };
  }

  async takeScreenshot(page: Page, name: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = name.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
    const filename = `${safeName}_${timestamp}.png`;
    const filepath = path.join(this.screenshotsDir, filename);

    await page.screenshot({ path: filepath });
    return filepath;
  }
}
