import 'dotenv/config';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

chromium.use(StealthPlugin());

const cookieFile = process.env.WORKER_COOKIES_FILE || 'cookies.json';
const seconds = Number.parseInt(process.env.COOKIE_REFRESH_SECONDS || '180', 10);
const targetUrl = process.env.COOKIE_REFRESH_URL || 'https://www.gmarket.co.kr/';

const proxy = process.env.PROXY_HOST && process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD
  ? {
      server: `http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT || '823'}`,
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    }
  : undefined;

async function loadCookies() {
  try {
    return JSON.parse(await readFile(cookieFile, 'utf-8'));
  } catch {
    return [];
  }
}

async function saveCookies(context) {
  const cookies = await context.cookies([
    'https://www.gmarket.co.kr/',
    'https://browse.gmarket.co.kr/',
  ]);
  await mkdir(path.dirname(path.resolve(cookieFile)), { recursive: true });
  await writeFile(cookieFile, JSON.stringify(cookies, null, 2));
  console.log(`[쿠키저장] ${cookies.length}개 -> ${cookieFile}`);
}

console.log(`[쿠키갱신] 브라우저를 ${seconds}초 동안 유지합니다.`);
console.log('[쿠키갱신] VNC에서 G마켓 화면이 열리면 봇 확인/대기 화면을 직접 통과하세요.');

const browser = await chromium.launch({
  headless: false,
  proxy,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

const context = await browser.newContext({
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  viewport: { width: 1366, height: 768 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

const existingCookies = await loadCookies();
if (Array.isArray(existingCookies) && existingCookies.length > 0) {
  await context.addCookies(existingCookies);
  console.log(`[쿠키로드] ${existingCookies.length}개`);
}

const page = await context.newPage();
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

const interval = setInterval(() => {
  saveCookies(context).catch((error) => console.log(`[쿠키저장실패] ${error.message}`));
}, 15000);

try {
  await page.waitForTimeout(Math.max(30, seconds) * 1000);
  await saveCookies(context);
} finally {
  clearInterval(interval);
  await browser.close();
}
