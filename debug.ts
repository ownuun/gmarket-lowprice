import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { readFileSync, existsSync } from 'fs';

// Stealth 플러그인 적용
chromium.use(StealthPlugin());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1920, height: 1080 },
  });

  // 쿠키 로드
  const cookiePath = 'data/cookies.json';
  if (existsSync(cookiePath)) {
    const cookies = JSON.parse(readFileSync(cookiePath, 'utf-8'));
    await context.addCookies(cookies);
    console.log(`쿠키 ${cookies.length}개 로드됨`);
  }

  const page = await context.newPage();

  const keyword = process.argv[2] || 'CM-417MB';
  console.log(`\n=== 검색어: ${keyword} ===\n`);

  // 1. 지마켓 메인 페이지로 이동
  console.log('1. 메인 페이지 이동...');
  await page.goto('https://www.gmarket.co.kr', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // 2. 검색창에 키워드 타이핑
  console.log('2. 검색창 타이핑...');
  const searchInput = await page.$('input[name="keyword"], input.box__keyword-input, input[placeholder*="검색"]');
  if (searchInput) {
    await searchInput.click();
    await page.waitForTimeout(500);
    await searchInput.fill(keyword);
    await page.waitForTimeout(500);

    // 3. 엔터키로 검색
    console.log('3. 검색 실행...');
    await searchInput.press('Enter');
    await page.waitForTimeout(5000);
  } else {
    console.log('검색창을 찾지 못함, URL 직접 접속...');
    await page.goto(`https://www.gmarket.co.kr/n/search?keyword=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
  }

  // 4. 카테고리 필터 클릭 (공구/안전/산업용품)
  console.log('4. 카테고리 필터 클릭...');
  try {
    // 왼쪽 사이드바에서 "공구/안전/산업용품" 찾기
    const categoryLink = await page.$('a:has-text("공구/안전/산업용품"), a:has-text("공구안전산업용품")');
    if (categoryLink) {
      await categoryLink.click();
      console.log('  공구/안전/산업용품 카테고리 클릭');
      await page.waitForTimeout(3000);
    } else {
      // 카테고리 섹션 열기
      const categorySection = await page.$('text=카테고리');
      if (categorySection) {
        await categorySection.click();
        await page.waitForTimeout(1000);
      }
      // 다시 시도
      const link = await page.$('a:has-text("공구")');
      if (link) {
        await link.click();
        console.log('  공구 카테고리 클릭');
        await page.waitForTimeout(3000);
      }
    }
  } catch (e) {
    console.log('  카테고리 필터 클릭 실패:', e);
  }

  // 5. 낮은가격순 정렬 클릭
  console.log('5. 낮은가격순 정렬 클릭...');
  try {
    // 정렬 드롭다운 찾기 - "G마켓 랭크순" 또는 정렬 버튼
    const sortDropdown = await page.$('button:has-text("랭크순"), button:has-text("정렬"), .box__sort button');
    if (sortDropdown) {
      await sortDropdown.click();
      console.log('  정렬 드롭다운 클릭');
      await page.waitForTimeout(1000);

      // 낮은가격순 옵션 선택
      const lowPriceOption = await page.$('text=낮은가격순');
      if (lowPriceOption) {
        await lowPriceOption.click();
        console.log('  낮은가격순 선택');
        await page.waitForTimeout(3000);
      }
    } else {
      // 직접 낮은가격순 링크/버튼 찾기
      const lowPriceBtn = await page.$('a:has-text("낮은가격순"), button:has-text("낮은가격순")');
      if (lowPriceBtn) {
        await lowPriceBtn.click();
        console.log('  낮은가격순 버튼 직접 클릭');
        await page.waitForTimeout(3000);
      }
    }
  } catch (e) {
    console.log('  정렬 버튼 클릭 실패:', e);
  }

  await page.waitForTimeout(2000);
  const url = page.url();
  console.log(`URL: ${url}`);

  // 검색 결과 스크린샷
  await page.screenshot({ path: `data/debug_search_${keyword}.png` });
  console.log(`검색 결과 스크린샷: data/debug_search_${keyword}.png`);

  // 첫 번째 상품 컨테이너
  const item = await page.$('div.box__item-container');
  if (!item) {
    console.log('상품을 찾지 못했습니다.');
    await browser.close();
    return;
  }

  // 상품명
  const productName = await item.$eval('span.text__item, a.text__item', el => el.textContent?.trim()).catch(() => null);
  console.log(`[검색] 상품명: ${productName}`);

  // 상품 링크
  const productLink = await item.$eval('a[href*="item.gmarket.co.kr"]', el => el.getAttribute('href')).catch(() => null);
  console.log(`[검색] 상품링크: ${productLink?.split('&')[0]}`);

  // data 속성에서 가격 정보 추출
  const link = await item.$('a[data-montelena-acode]');
  let price = null;
  if (link) {
    const utparam = await link.getAttribute('data-params-exp');
    if (utparam) {
      const match = utparam.match(/utLogMap=([^&]+)/);
      if (match) {
        try {
          const logMap = JSON.parse(decodeURIComponent(match[1]));
          price = logMap.coupon_price || logMap.promotion_price || logMap.origin_price;
          console.log(`[검색] 가격: ${price}원`);
        } catch {}
      }
    }
  }

  // 쿠폰가 요소 확인
  console.log(`\n=== 가격 관련 요소 확인 ===`);

  // box__price-coupon 존재 여부
  const couponBox = await item.$('.box__price-coupon');
  console.log(`[쿠폰가 박스] .box__price-coupon 존재: ${!!couponBox}`);
  if (couponBox) {
    const couponHtml = await couponBox.innerHTML();
    console.log(`[쿠폰가 박스] HTML: ${couponHtml}`);
  }

  // box__price-seller 확인
  const sellerPriceBox = await item.$('.box__price-seller');
  console.log(`[판매가 박스] .box__price-seller 존재: ${!!sellerPriceBox}`);
  if (sellerPriceBox) {
    const sellerHtml = await sellerPriceBox.innerHTML();
    console.log(`[판매가 박스] HTML: ${sellerHtml}`);
  }

  // 모든 가격 관련 클래스 찾기
  const allPriceBoxes = await item.$$('[class*="price"]');
  console.log(`\n[가격 관련 요소] 총 ${allPriceBoxes.length}개`);
  for (let i = 0; i < allPriceBoxes.length; i++) {
    const className = await allPriceBoxes[i].getAttribute('class');
    const text = await allPriceBoxes[i].innerText().catch(() => '');
    console.log(`  ${i + 1}. class="${className}" -> "${text.replace(/\n/g, ' ').slice(0, 100)}"`);
  }

  // 쿠폰 관련 텍스트 검색
  const couponText = await page.$$eval('*', els => {
    return els
      .filter(el => el.textContent?.includes('쿠폰적용가'))
      .map(el => ({ tag: el.tagName, class: el.className, text: el.textContent?.slice(0, 100) }))
      .slice(0, 5);
  });
  console.log(`\n[쿠폰적용가 텍스트 검색] ${couponText.length}개 발견`);
  couponText.forEach((c, i) => console.log(`  ${i + 1}. <${c.tag}> class="${c.class}" -> "${c.text}"`));

  // 쿠키 확인
  const cookies = await context.cookies();
  console.log(`\n=== 쿠키 정보 ===`);
  console.log(`총 쿠키 수: ${cookies.length}`);
  const relevantCookies = cookies.filter(c =>
    c.name.toLowerCase().includes('login') ||
    c.name.toLowerCase().includes('user') ||
    c.name.toLowerCase().includes('member') ||
    c.name.toLowerCase().includes('coupon')
  );
  console.log(`관련 쿠키: ${relevantCookies.length}개`);
  relevantCookies.forEach(c => console.log(`  ${c.name}: ${c.value.slice(0, 50)}...`));

  await browser.close();
})();
