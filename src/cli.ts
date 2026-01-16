#!/usr/bin/env node

import { program } from 'commander';
import { BrowserManager } from './browser.js';
import { GmarketSearcher } from './searcher.js';
import { ExcelExporter, MarkdownExporter, CsvExporter, JsonExporter } from './exporters.js';
import { InputReader } from './input.js';
import type { Product, SearchResult } from './types.js';
import { getLowestPriceProduct, getTotalPrice } from './types.js';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCrawler(
  models: string[],
  options: {
    headless: boolean;
    minDelay: number;
    maxDelay: number;
  }
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const total = models.length;

  const browser = new BrowserManager(options.headless);
  await browser.start();

  try {
    const searcher = new GmarketSearcher(browser);

    for (let i = 0; i < models.length; i++) {
      // 진행률 표시
      const progress = `[${i + 1}/${total}]`;

      // 딜레이 (첫 번째 제외)
      if (i > 0) {
        const delay = options.minDelay + Math.random() * (options.maxDelay - options.minDelay);
        console.log(`\n${progress} 대기 ${delay.toFixed(1)}초...`);
        await sleep(delay * 1000);
      }

      console.log(`\n${progress} 검색: ${models[i]}`);
      const result = await searcher.search(models[i], false);
      results.push(result);

      // 디버그: 상위 5개 파싱 결과
      if (result.products.length > 0) {
        console.log(`  [파싱] 상위 ${result.products.length}개:`);
        for (const p of result.products) {
          const total = getTotalPrice(p);
          console.log(`    ${p.rank}. ${total?.toLocaleString()}원 - ${p.productName.slice(0, 40)}...`);
        }
      }

      // 최저가 출력 (클러스터링 적용)
      const lowest = getLowestPriceProduct(result.products);
      if (lowest) {
        console.log(`  [선택] #${lowest.rank} ${lowest.couponPrice?.toLocaleString()}원 (배송비: ${lowest.shippingFee ?? 0}원) [신뢰도: ${lowest.clusterSize}/5]`);
        console.log(`  판매자: ${lowest.sellerName}`);
      } else if (result.error) {
        console.log(`  오류: ${result.error}`);
      } else {
        console.log(`  상품 없음`);
      }
    }
  } finally {
    await browser.stop();
  }

  return results;
}

type OutputFormat = 'excel' | 'markdown' | 'csv' | 'json' | 'all';

async function exportResults(
  products: Product[],
  formats: OutputFormat[],
  outputDir: string
): Promise<void> {
  const exportAll = formats.includes('all');

  if (exportAll || formats.includes('excel')) {
    const exporter = new ExcelExporter(outputDir);
    const path = await exporter.export(products);
    console.log(`  Excel: ${path}`);
  }

  if (exportAll || formats.includes('markdown')) {
    const exporter = new MarkdownExporter(outputDir);
    const path = await exporter.export(products);
    console.log(`  Markdown: ${path}`);
  }

  if (exportAll || formats.includes('csv')) {
    const exporter = new CsvExporter(outputDir);
    const path = await exporter.export(products);
    console.log(`  CSV: ${path}`);
  }

  if (exportAll || formats.includes('json')) {
    const exporter = new JsonExporter(outputDir);
    const path = await exporter.export(products);
    console.log(`  JSON: ${path}`);
  }
}

program
  .name('gmarket-crawler')
  .description('Gmarket 가격 크롤러 - 지마켓 최저가 검색')
  .option('-m, --model <models...>', '검색할 모델명 (여러 개 가능)')
  .option('-i, --input <file>', '모델명 파일 (txt, csv, xlsx)')
  .option('-f, --format <formats...>', '출력 형식 (excel, markdown, csv, json, all)', ['excel'])
  .option('--no-headless', '브라우저 표시 모드')
  .option('--min-delay <seconds>', '최소 딜레이 (초)', '2')
  .option('--max-delay <seconds>', '최대 딜레이 (초)', '5')
  .option('-o, --output-dir <dir>', '출력 디렉토리', 'data/output')
  .action(async (opts) => {
    let models: string[] = opts.model || [];

    // 파일에서 모델명 읽기
    if (opts.input) {
      const reader = new InputReader();
      const fileModels = await reader.read(opts.input);
      models = [...models, ...fileModels];
      console.log(`파일에서 ${fileModels.length}개 모델명 로드: ${opts.input}`);
    }

    // 중복 제거
    models = [...new Set(models)];

    if (models.length === 0) {
      console.log('오류: 모델명을 지정하세요');
      console.log("  -m 옵션: gmarket-crawler -m 'CM-417MB' -m 'IS-617M'");
      console.log("  -i 옵션: gmarket-crawler -i models.txt");
      process.exit(1);
    }

    console.log('\n' + '='.repeat(50));
    console.log('Gmarket 가격 크롤러');
    console.log('='.repeat(50));
    console.log(`검색 모델: ${models.length}개`);
    if (models.length <= 10) {
      models.forEach(m => console.log(`  - ${m}`));
    } else {
      models.slice(0, 5).forEach(m => console.log(`  - ${m}`));
      console.log(`  ... 외 ${models.length - 5}개`);
    }
    console.log('='.repeat(50));

    // 크롤링 실행
    const results = await runCrawler(models, {
      headless: opts.headless,
      minDelay: parseFloat(opts.minDelay),
      maxDelay: parseFloat(opts.maxDelay),
    });

    // 모든 상품 수집 (searchUrl 포함, 검색 실패도 포함)
    const allProducts: Product[] = [];
    for (const result of results) {
      if (result.products.length > 0) {
        for (const product of result.products) {
          product.searchUrl = result.searchUrl;
          allProducts.push(product);
        }
      } else {
        // 검색 결과 없는 경우 placeholder 추가
        allProducts.push({
          modelName: result.modelName,
          productName: '검색결과 없음',
          sellerName: '-',
          couponPrice: null,
          regularPrice: null,
          shippingFee: null,
          discountPercent: null,
          productUrl: '',
          searchUrl: result.searchUrl,
          rank: 0,
          crawledAt: new Date(),
        });
      }
    }

    if (allProducts.length === 0) {
      console.log('\n상품을 찾지 못했습니다.');
      process.exit(0);
    }

    // 결과 출력
    console.log('\n' + '='.repeat(50));
    console.log('결과 저장');
    console.log('='.repeat(50));

    const formats = opts.format as OutputFormat[];
    await exportResults(allProducts, formats, opts.outputDir);

    // 요약
    console.log('\n' + '='.repeat(50));
    console.log('요약');
    console.log('='.repeat(50));
    const successCount = results.filter(r => r.products.length > 0).length;
    const failedCount = results.length - successCount;
    console.log(`검색 성공: ${successCount}/${results.length}`);
    if (failedCount > 0) {
      console.log(`검색 실패: ${failedCount}개`);
      const failed = results.filter(r => r.products.length === 0);
      failed.slice(0, 5).forEach(r => console.log(`  - ${r.modelName}: ${r.error || '상품 없음'}`));
      if (failed.length > 5) console.log(`  ... 외 ${failed.length - 5}개`);
    }
    console.log(`수집 상품: ${allProducts.length}개`);

    // 상세 출력 (10개 이하일 때만)
    if (allProducts.length <= 10) {
      for (const p of allProducts) {
        // 해당 모델의 검색 결과 찾기
        const searchResult = results.find(r => r.modelName === p.modelName);

        console.log(`\n[${p.modelName}] #${p.rank}`);
        if (searchResult?.searchUrl) {
          console.log(`  검색결과: ${searchResult.searchUrl}`);
        }
        console.log(`  상품명: ${p.productName.slice(0, 50)}${p.productName.length > 50 ? '...' : ''}`);
        console.log(`  판매자: ${p.sellerName}`);
        console.log(`  쿠폰적용가: ${p.couponPrice?.toLocaleString()}원`);
        console.log(`  배송비: ${p.shippingFee ? `${p.shippingFee.toLocaleString()}원` : '무료'}`);
        console.log(`  총가격: ${getTotalPrice(p)?.toLocaleString()}원`);
      }
    }
  });

program.parse();
