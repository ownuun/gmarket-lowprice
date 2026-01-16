import type { Page } from 'playwright';
import type { Product } from './types.js';

export class GmarketParser {
  private maxItems = 5; // 상위 5개 상품 파싱

  async parseSearchResults(page: Page, modelName: string): Promise<Product[]> {
    const selectors = ['div.box__item-container', '.box__component-itemcard'];

    let items: any[] = [];
    for (const sel of selectors) {
      items = await page.$$(sel);
      if (items.length > 0) break;
    }

    if (items.length === 0) {
      return [];
    }

    // 상위 N개만 파싱
    const products: Product[] = [];
    const itemsToProcess = items.slice(0, this.maxItems);

    for (let i = 0; i < itemsToProcess.length; i++) {
      try {
        const product = await this.parseItem(itemsToProcess[i], modelName, i + 1);
        if (product) {
          products.push(product);
        }
      } catch (e) {
        console.log(`  [경고] 상품 ${i + 1} 파싱 실패`);
      }
    }

    return products;
  }

  private async parseItem(item: any, modelName: string, rank: number): Promise<Product | null> {
    // 상품명
    const productName = await this.extractText(item, [
      'span.text__item',
      'a.text__item',
      '[class*="text__item"]',
    ]);
    if (!productName) return null;

    // 가격 추출 (data-params-exp 속성에서 추출 - 가장 정확)
    const priceInfo = await this.extractPricesFromDataAttr(item);

    let regularPrice: number | null = null;
    let couponPrice: number | null = null;

    if (priceInfo) {
      // origin_price를 정가로 설정
      regularPrice = priceInfo.originPrice;

      // 할인가 우선순위: coupon_price > promotion_price (정가보다 낮을 때만)
      if (priceInfo.couponPrice && regularPrice && priceInfo.couponPrice < regularPrice) {
        // 쿠폰 할인가
        couponPrice = priceInfo.couponPrice;
      } else if (priceInfo.promotionPrice && regularPrice && priceInfo.promotionPrice < regularPrice) {
        // 프로모션 할인가 (쿠폰이 없을 때)
        couponPrice = priceInfo.promotionPrice;
      }

      // 정가가 없으면 promotion_price를 정가로 사용
      if (!regularPrice) {
        regularPrice = priceInfo.promotionPrice;
      }
    }

    // HTML 요소에서 추출 (fallback)
    if (!regularPrice) {
      // 정가 우선 추출
      regularPrice = await this.extractPrice(item, [
        '.box__price-original .text__value',
        '[class*="original"] .text__value',
      ]);

      // 정가가 없으면 판매가를 정가로
      if (!regularPrice) {
        regularPrice = await this.extractPrice(item, [
          '.box__price-seller strong.text__value',
          '.box__price-seller > strong.text__value',
        ]);
      }

      // 쿠폰가 추출 (정가보다 낮을 때만)
      const htmlCouponPrice = await this.extractPrice(item, [
        '.box__price-coupon strong.text__value',
      ]);
      if (htmlCouponPrice && regularPrice && htmlCouponPrice < regularPrice) {
        couponPrice = htmlCouponPrice;
      }
    }

    // 배송비 (태그에서 추출: "배송비 2,500원")
    const shippingFee = await this.extractShippingFee(item);

    // 판매자 (text__seller 클래스에서)
    const sellerName = await this.extractText(item, [
      'span.text__seller',
      '.text__seller',
      '.link__shop .text__seller',
    ]) || 'Unknown';

    // 상품 URL
    let productUrl = await this.extractHref(item, [
      'a[href*="item.gmarket.co.kr"]',
      'a[href*="goodscode"]',
      'a.link__item',
    ]);
    if (productUrl && !productUrl.startsWith('http')) {
      productUrl = `https://www.gmarket.co.kr${productUrl}`;
    }

    // 할인율 (쿠폰적용가가 있을 때만 계산)
    let discountPercent: number | null = null;
    if (regularPrice && couponPrice) {
      discountPercent = Math.round((1 - couponPrice / regularPrice) * 100);
    }

    return {
      modelName,
      productName,
      sellerName,
      couponPrice,
      regularPrice,
      shippingFee,
      discountPercent,
      productUrl: productUrl || '',
      rank,
      crawledAt: new Date(),
    };
  }

  private async extractText(element: any, selectors: string[]): Promise<string | null> {
    for (const selector of selectors) {
      try {
        const el = await element.$(selector);
        if (el) {
          const text = await el.innerText();
          if (text?.trim()) return text.trim();
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  private async extractHref(element: any, selectors: string[]): Promise<string | null> {
    for (const selector of selectors) {
      try {
        const el = await element.$(selector);
        if (el) {
          const href = await el.getAttribute('href');
          if (href) return href;
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  private async extractPrice(element: any, selectors: string[]): Promise<number | null> {
    const text = await this.extractText(element, selectors);
    return this.parsePrice(text);
  }

  private async extractPricesFromDataAttr(element: any): Promise<{
    originPrice: number | null;
    promotionPrice: number | null;
    couponPrice: number | null;
  } | null> {
    try {
      // data-params-exp 속성에서 가격 추출
      const link = await element.$('a[data-montelena-acode]');
      if (!link) return null;

      const dataParams = await link.getAttribute('data-params-exp');
      if (!dataParams) return null;

      const match = dataParams.match(/utLogMap=([^&]+)/);
      if (!match) return null;

      const logMap = JSON.parse(decodeURIComponent(match[1]));

      const parsePrice = (val: any): number | null => {
        if (!val || val === '') return null;
        const num = parseInt(String(val), 10);
        return isNaN(num) ? null : num;
      };

      return {
        originPrice: parsePrice(logMap.origin_price),
        promotionPrice: parsePrice(logMap.promotion_price),
        couponPrice: parsePrice(logMap.coupon_price),
      };
    } catch {
      return null;
    }
  }

  private async extractShippingFee(element: any): Promise<number | null> {
    // 전체 상품 카드 텍스트에서 배송비 패턴 검색
    // "오늘출발 오후 1시 전 주문시 · 배송비 3,000원" 같은 복합 텍스트에서도 추출 가능
    return await element.evaluate((el: Element) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);

      while (walker.nextNode()) {
        const text = walker.currentNode.textContent || '';

        // 무료배송 체크
        if (/무료배송/.test(text)) {
          return 0;
        }

        // "배송비 3,000원" 패턴 추출
        const match = text.match(/배송비\s*([\d,]+)/);
        if (match) {
          return parseInt(match[1].replace(/,/g, ''), 10);
        }
      }

      return null;
    });
  }

  private parsePrice(text: string | null): number | null {
    if (!text) return null;
    const cleaned = text.replace(/[^\d]/g, '');
    if (cleaned) return parseInt(cleaned, 10);
    return null;
  }
}
