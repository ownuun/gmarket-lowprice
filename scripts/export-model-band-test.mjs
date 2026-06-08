import 'dotenv/config';
import ExcelJS from 'exceljs';
import { mkdir } from 'fs/promises';
import { BrowserManager } from '../dist/browser.js';
import { GmarketSearcher } from '../dist/searcher.js';

const defaultModels = ['AGF-5000', 'ABS1000', 'AGF-3000', 'AGF6000B', 'AGF-6000', 'AGF-8000', 'BS0902', 'ABS-1000'];
const models = process.env.TEST_MODELS
  ? process.env.TEST_MODELS.split(',').map((model) => model.trim()).filter(Boolean)
  : defaultModels;
const outputFile = process.env.TEST_EXCEL_FILE || 'data/test-exports/gmarket_model_band_test_latest.xlsx';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const itemPrice = (product) => product.couponPrice ?? product.regularPrice;
const totalPrice = (product) => (itemPrice(product) ?? 0) + (product.shippingFee ?? 0);
const formatPrice = (price) => price == null ? '-' : `${price.toLocaleString()}원`;
const formatShipping = (fee) => fee == null ? '-' : fee === 0 ? '무료' : `${fee.toLocaleString()}원`;
const formatPercent = (percent) => percent == null ? '-' : `${percent}%`;
const formatDateTime = (value) => {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
};

const categoryNames = {
  '100000076': '공구/안전/산업용품',
  '300021319': '기타 철물용품',
  '300025517': '기타 전동공구',
  '300005952': '렌치/복스/몽키',
  '300027199': '기타수공구',
  '300027200': '에어랜치',
  '300027201': '기타에어/유압공구',
  '300028828': '전동공구 세트',
};

const formatCategoryPart = (name, code) => {
  if (code && categoryNames[code]) return categoryNames[code];
  if (name) return name;
  if (code) return code;
  return null;
};

const formatCategory = (product) => {
  const parts = [
    formatCategoryPart(product.largeCategoryName, product.largeCategoryCode),
    formatCategoryPart(product.mediumCategoryName, product.mediumCategoryCode),
    formatCategoryPart(product.smallCategoryName, product.smallCategoryCode),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' > ') : '-';
};

await mkdir(outputFile.split('/').slice(0, -1).join('/') || '.', { recursive: true });

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('모델밴드 결과');
sheet.columns = [
  { header: '순위', key: 'rank', width: 6 },
  { header: '상품번호', key: 'productNo', width: 14 },
  { header: '모델명', key: 'modelName', width: 14 },
  { header: '구분', key: 'resultType', width: 12 },
  { header: '상품명', key: 'productName', width: 55 },
  { header: '판매자', key: 'seller', width: 16 },
  { header: '카테고리', key: 'category', width: 55 },
  { header: '정가', key: 'regularPrice', width: 12 },
  { header: '할인가', key: 'couponPrice', width: 12 },
  { header: '할인율', key: 'discountPercent', width: 8 },
  { header: '배송비', key: 'shippingFee', width: 10 },
  { header: '총가격', key: 'totalPrice', width: 12 },
  { header: '상품URL', key: 'url', width: 45 },
  { header: '검색URL', key: 'searchUrl', width: 60 },
  { header: '수집시간', key: 'crawledAt', width: 22 },
];

sheet.getRow(1).font = { bold: true };
sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
sheet.columns.forEach((column) => {
  column.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
});
sheet.getColumn('url').alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
sheet.getColumn('searchUrl').alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };

const applyTableStyle = () => {
  sheet.eachRow((row) => {
    row.eachCell((cell, columnNumber) => {
      const columnKey = sheet.getColumn(columnNumber).key;
      const isUrlColumn = columnKey === 'url' || columnKey === 'searchUrl';
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: !isUrlColumn };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: cell.border?.bottom ?? { style: 'thin' },
        right: { style: 'thin' },
      };
    });
  });
};

const browser = new BrowserManager(false, 'data/screenshots-validation');
await browser.start();

const summary = [];

try {
  const searcher = new GmarketSearcher(browser);
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const result = await searcher.search(model, false);
    const rows = result.strategyProducts?.length ? result.strategyProducts : result.products;
    const band = result.strategyMeta?.priceBand;

    summary.push({ model, error: result.error ?? null, rows: rows.length, band });
    console.log('[검증결과]', JSON.stringify(summary.at(-1)));

    for (const product of rows) {
      sheet.addRow({
        rank: product.rank,
        productNo: product.productNo || '-',
        modelName: model,
        resultType: product.strategyLabel || '최저가',
        productName: product.productName,
        seller: product.sellerName,
        category: formatCategory(product),
        regularPrice: formatPrice(product.regularPrice),
        couponPrice: formatPrice(product.couponPrice),
        discountPercent: formatPercent(product.discountPercent),
        shippingFee: formatShipping(product.shippingFee),
        totalPrice: formatPrice(totalPrice(product)),
        url: product.productUrl,
        searchUrl: result.searchUrl || product.searchUrl || '-',
        crawledAt: formatDateTime(product.crawledAt),
      });
    }

    if (sheet.rowCount > 1) {
      sheet.getRow(sheet.rowCount).eachCell((cell) => {
        cell.border = { bottom: { style: 'thick' } };
      });
    }

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

applyTableStyle();
await workbook.xlsx.writeFile(outputFile);
console.log('[엑셀저장]', outputFile);
console.log('[전체요약]', JSON.stringify(summary, null, 2));
