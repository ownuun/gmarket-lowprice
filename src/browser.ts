import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdir, readFile } from 'fs/promises';
import path from 'path';

type CookieData = Parameters<BrowserContext['addCookies']>[0][number];

async function loadCookiesFromFile(): Promise<CookieData[]> {
  const file = process.env.WORKER_COOKIES_FILE;
  if (!file) return [];
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw) as CookieData[];
  } catch (e) {
    console.log(`[쿠키] 로드 실패 (무시): ${(e as Error).message}`);
    return [];
  }
}

// Stealth 플러그인 적용 (Cloudflare 우회)
chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

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

  private persistentContext: BrowserContext | null = null;
  private contextUserAgent: string = '';

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
    await this.closeContext();
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

  async getOrCreateContext(): Promise<BrowserContext> {
    if (this.persistentContext) return this.persistentContext;

    if (!this.browser) throw new Error('Browser not started');

    this.contextUserAgent = pickRandom(USER_AGENTS);
    const viewport = pickRandom(VIEWPORTS);

    this.persistentContext = await this.browser.newContext({
      viewport,
      userAgent: this.contextUserAgent,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });

    const cookies = await loadCookiesFromFile();
    if (cookies.length > 0) {
      await this.persistentContext.addCookies(cookies);
      console.log(`[쿠키] ${cookies.length}개 inject`);
    }

    console.log(`[브라우저] 새 Context 생성 (UA: ...${this.contextUserAgent.slice(-30)}, ${viewport.width}x${viewport.height})`);
    return this.persistentContext;
  }

  async newPageInContext(): Promise<Page> {
    const context = await this.getOrCreateContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    return page;
  }

  async closeContext(): Promise<void> {
    if (this.persistentContext) {
      try {
        await this.persistentContext.close();
      } catch { /* already closed */ }
      this.persistentContext = null;
    }
  }

  async rotateContext(cooldownMs = 8000): Promise<void> {
    console.log(`[브라우저] Context 교체 (쿨다운 ${(cooldownMs / 1000).toFixed(1)}초)`);
    await this.closeContext();
    await new Promise(resolve => setTimeout(resolve, cooldownMs));
    await this.getOrCreateContext();
  }

  async newPage(): Promise<{ page: Page; context: BrowserContext }> {
    if (!this.browser) throw new Error('Browser not started');

    const context = await this.browser.newContext({
      viewport: pickRandom(VIEWPORTS),
      userAgent: pickRandom(USER_AGENTS),
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
