"""Coupang search sidecar.

Drives CloakBrowser (a stealth Chromium whose anti-detection patches are compiled
into the binary at C++ source level) to fetch Coupang search results past Coupang's
Akamai Bot Manager, and exposes a tiny local HTTP API.

The Node worker's CoupangSearcher (src/marketplaces/coupang.ts) calls:
    GET /search?q=<model>   ->  {"ok", "status", "title", "count", "products": [...]}
    GET /health             ->  {"ok": true}

Why a separate Python service instead of driving from Node over CDP:
CloakBrowser's stealth is applied partly by its Python wrapper at the context/page
level, so an externally connected Playwright (Node connectOverCDP) loses it and gets
"Access Denied". The browser must be driven via CloakBrowser's own Python API.

Run:   python coupang_service.py        (listens on 127.0.0.1:8917)
Env:   COUPANG_SERVICE_HOST, COUPANG_SERVICE_PORT, COUPANG_HEADLESS=true|false
"""
import asyncio
import os
import secrets
import urllib.parse

from aiohttp import web
import cloakbrowser

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.177 Safari/537.36"
HOST = os.environ.get("COUPANG_SERVICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("COUPANG_SERVICE_PORT", "8917"))
HEADLESS = os.environ.get("COUPANG_HEADLESS", "true").lower() != "false"
LAUNCH_ARGS = ["--no-sandbox"] if os.environ.get("COUPANG_NO_SANDBOX", "").lower() == "true" else []


def _build_proxy():
    host = os.environ.get("PROXY_HOST", "")
    if not host:
        return None
    port = os.environ.get("PROXY_PORT", "823")
    proxy = {"server": f"http://{host}:{port}"}
    user = os.environ.get("PROXY_USERNAME", "")
    if user:
        sessid = secrets.token_hex(6)
        proxy["username"] = f"{user}__cr.kr;sessid.{sessid}"
        proxy["password"] = os.environ.get("PROXY_PASSWORD", "")
    return proxy


PROXY = _build_proxy()

# Coupang 검색결과의 실제 상품은 /vp/products/<id> 링크에 있다.
# 앵커 텍스트(상품명+가격+배송)에서 가격을 정규식으로 뽑고 productId로 중복 제거한다.
EXTRACT_JS = r"""() => {
  const parsePrice = (t) => {
    const unit = t.match(/1개당\s*([0-9][0-9,]*)\s*원/);
    if (unit) return Number(unit[1].replace(/,/g, ''));
    const disc = t.match(/[0-9]+%\s*([0-9][0-9,]*)\s*원/);
    if (disc) return Number(disc[1].replace(/,/g, ''));
    const first = t.match(/([0-9][0-9,]{2,})\s*원/);
    return first ? Number(first[1].replace(/,/g, '')) : null;
  };
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll("a[href*='/vp/products/']")) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/vp\/products\/(\d+)/);
    if (!m) continue;
    const productId = m[1];
    if (seen.has(productId)) continue;
    seen.add(productId);
    const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
    out.push({
      productId,
      url: 'https://www.coupang.com' + href.split('?')[0],
      text: text.slice(0, 180),
      price: parsePrice(text),
    });
  }
  return out;
}"""


class CoupangBrowser:
    """warm CloakBrowser 컨텍스트를 유지하며 검색을 직렬 처리한다(워커 CONCURRENCY=1과 맞춤)."""

    def __init__(self):
        self._ctx = None
        self._lock = asyncio.Lock()

    async def ensure(self):
        if self._ctx is not None:
            return
        self._ctx = await cloakbrowser.launch_context_async(
            headless=HEADLESS,
            stealth_args=True,
            humanize=True,
            user_agent=UA,
            viewport={"width": 1920, "height": 1080},
            locale="ko-KR",
            timezone="Asia/Seoul",
            args=LAUNCH_ARGS or None,
            proxy=PROXY,
        )
        # 검색 전 메인페이지를 한 번 방문해 Akamai 센서 쿠키를 세팅(워밍업).
        page = await self._ctx.new_page()
        try:
            await page.goto("https://www.coupang.com/", wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(3000)
        finally:
            await page.close()

    async def search(self, q):
        async with self._lock:
            await self.ensure()
            page = await self._ctx.new_page()
            try:
                url = "https://www.coupang.com/np/search?q=" + urllib.parse.quote(q) + "&channel=user&sorter=salePriceAsc"
                r = await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                await page.wait_for_timeout(3500)
                title = await page.title()
                products = await page.evaluate(EXTRACT_JS)
                blocked = "Access Denied" in title
                return {
                    "ok": (not blocked) and len(products) > 0,
                    "status": r.status if r else None,
                    "title": title[:80],
                    "count": len(products),
                    "products": products,
                }
            finally:
                await page.close()


browser = CoupangBrowser()


async def handle_search(request):
    q = (request.query.get("q") or "").strip()
    if not q:
        return web.json_response({"ok": False, "error": "missing q"}, status=400)
    try:
        return web.json_response(await browser.search(q))
    except Exception as e:  # noqa: BLE001 - surface engine errors to the caller
        return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)


async def handle_health(_request):
    return web.json_response({"ok": True})


def main():
    app = web.Application()
    app.router.add_get("/search", handle_search)
    app.router.add_get("/health", handle_health)
    print(f"[coupang-service] listening on {HOST}:{PORT} headless={HEADLESS} proxy={'on' if PROXY else 'off'}", flush=True)
    web.run_app(app, host=HOST, port=PORT, print=None)


if __name__ == "__main__":
    main()
