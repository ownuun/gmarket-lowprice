import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

// Stealth 플러그인 적용 (Cloudflare 우회)
chromium.use(StealthPlugin());

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 프록시 설정 (DataImpulse Residential Proxy)
const PROXY_HOST = process.env.PROXY_HOST || '';
const PROXY_PORT = process.env.PROXY_PORT || '823';
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

function getProxyConfig() {
  if (!PROXY_HOST || !PROXY_USERNAME || !PROXY_PASSWORD) {
    return undefined;
  }
  return {
    server: `http://${PROXY_HOST}:${PROXY_PORT}`,
    username: PROXY_USERNAME,
    password: PROXY_PASSWORD,
  };
}

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

    const proxy = getProxyConfig();
    if (proxy) {
      console.log(`[브라우저] 프록시 사용: ${PROXY_HOST}:${PROXY_PORT} (${PROXY_USERNAME.includes('country') ? PROXY_USERNAME.split('_').pop() : 'default'})`);
    } else {
      console.log('[브라우저] 프록시 없이 직접 연결');
    }

    this.browser = await chromium.launch({
      headless: this.headless,
      ...(proxy ? { proxy } : {}),
    });
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async restart(): Promise<void> {
    console.log('[브라우저] 재시작 중...');
    await this.stop();
    await this.start();
    console.log('[브라우저] 재시작 완료');
  }

  isRunning(): boolean {
    return this.browser !== null;
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
