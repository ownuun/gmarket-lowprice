import 'dotenv/config';
import { writeFile } from 'fs/promises';
import { BrowserManager } from '../dist/browser.js';
import { GmarketSearcher } from '../dist/searcher.js';

const defaultModels = ['AGF-5000', 'ABS1000', 'AGF-3000', 'AGF6000B', 'AGF-6000', 'AGF-8000', 'BS0902', 'ABS-1000'];
const models = process.env.TEST_MODELS
  ? process.env.TEST_MODELS.split(',').map((model) => model.trim()).filter(Boolean)
  : defaultModels;
const summaryFile = process.env.TEST_SUMMARY_FILE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const itemPrice = (product) => product.couponPrice ?? product.regularPrice;

const browser = new BrowserManager(false, 'data/screenshots-validation');
await browser.start();

const summary = [];

try {
  const searcher = new GmarketSearcher(browser);

  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const result = await searcher.search(model, false);
    const rows = result.strategyProducts?.length ? result.strategyProducts : result.products;
    const entry = {
      model,
      error: result.error ?? null,
      strategyRows: result.strategyProducts?.length ?? 0,
      lowpriceRows: result.products.length,
      band: result.strategyMeta?.priceBand ?? null,
      firstRows: rows.slice(0, 3).map((product) => ({
        rank: product.rank,
        productNo: product.productNo,
        seller: product.sellerName,
        price: itemPrice(product),
        shippingFee: product.shippingFee,
        totalPrice: (itemPrice(product) ?? 0) + (product.shippingFee ?? 0),
        name: product.productName.slice(0, 80),
      })),
    };
    summary.push(entry);
    console.log('[검증결과]', JSON.stringify(entry));

    if (result.error === 'BLOCKED') break;
    if (index < models.length - 1) {
      const delay = 8000 + Math.floor(Math.random() * 4001);
      console.log(`[모델간대기] ${(delay / 1000).toFixed(1)}초`);
      await sleep(delay);
    }
  }
} finally {
  await browser.stop();
}

console.log('[전체요약]', JSON.stringify(summary, null, 2));
if (summaryFile) {
  await writeFile(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`[요약저장] ${summaryFile}`);
}
