import ExcelJS from 'exceljs';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Product } from './types.js';
import { getTotalPrice } from './types.js';

export class ExcelExporter {
  private outputDir: string;

  constructor(outputDir = 'data/output') {
    this.outputDir = outputDir;
  }

  async export(products: Product[], filename?: string): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = filename || `gmarket_prices_${timestamp}`;
    const filepath = path.join(this.outputDir, `${name}.xlsx`);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('가격비교');

    // 헤더
    sheet.columns = [
      { header: '모델명', key: 'modelName', width: 15 },
      { header: '상품명', key: 'productName', width: 50 },
      { header: '판매자', key: 'sellerName', width: 15 },
      { header: '쿠폰적용가', key: 'couponPrice', width: 12 },
      { header: '배송비', key: 'shippingFee', width: 10 },
      { header: '총가격', key: 'totalPrice', width: 12 },
      { header: '할인율', key: 'discountPercent', width: 8 },
      { header: '신뢰도', key: 'clusterSize', width: 8 },
      { header: '상품URL', key: 'productUrl', width: 40 },
      { header: '검색URL', key: 'searchUrl', width: 60 },
      { header: '수집시간', key: 'crawledAt', width: 20 },
    ];

    // 헤더 스타일
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // 데이터
    for (const p of products) {
      const row = sheet.addRow({
        modelName: p.modelName,
        productName: p.productName,
        sellerName: p.sellerName,
        couponPrice: p.couponPrice ? `${p.couponPrice.toLocaleString()}원` : '-',
        shippingFee: p.shippingFee === 0 ? '무료' : p.shippingFee ? `${p.shippingFee.toLocaleString()}원` : '-',
        totalPrice: getTotalPrice(p) ? `${getTotalPrice(p)!.toLocaleString()}원` : '-',
        discountPercent: p.discountPercent ? `${p.discountPercent}%` : '-',
        clusterSize: p.clusterSize ? `${p.clusterSize}/5` : '-',
        productUrl: p.productUrl,
        searchUrl: p.searchUrl || '-',
        crawledAt: p.crawledAt.toISOString().slice(0, 19).replace('T', ' '),
      });

      // 클러스터 크기에 따른 행 색상
      if (p.clusterSize && p.clusterSize >= 4) {
        // 4-5개: 녹색 (높은 신뢰도)
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' },  // 연한 녹색
        };
      } else if (p.clusterSize && p.clusterSize >= 2) {
        // 2-3개: 주황색 (중간 신뢰도)
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFEB9C' },  // 연한 주황색
        };
      }
      // 1개: 기본 색상 (낮은 신뢰도)
    }

    await workbook.xlsx.writeFile(filepath);
    return filepath;
  }
}

export class MarkdownExporter {
  private outputDir: string;

  constructor(outputDir = 'data/output') {
    this.outputDir = outputDir;
  }

  async export(products: Product[], filename?: string): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = filename || `gmarket_prices_${timestamp}`;
    const filepath = path.join(this.outputDir, `${name}.md`);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const lines = [
      '# Gmarket 가격 비교 결과',
      '',
      `생성일시: ${now}`,
      '',
      `## 검색 결과 (${products.length}개)`,
      '',
    ];

    for (const p of products) {
      const name = p.productName.length > 50
        ? p.productName.slice(0, 47) + '...'
        : p.productName;

      const coupon = p.couponPrice ? `${p.couponPrice.toLocaleString()}원` : '-';
      const shipping = p.shippingFee === 0 ? '무료' : p.shippingFee ? `${p.shippingFee.toLocaleString()}원` : '-';
      const total = getTotalPrice(p) ? `${getTotalPrice(p)!.toLocaleString()}원` : '-';

      lines.push(`### ${p.modelName}`);
      if (p.searchUrl) {
        lines.push(`- 검색결과: [바로가기](${p.searchUrl})`);
      }
      lines.push(`- 상품명: ${p.productUrl ? `[${name}](${p.productUrl})` : name}`);
      lines.push(`- 판매자: ${p.sellerName}`);
      lines.push(`- 쿠폰적용가: ${coupon}`);
      lines.push(`- 배송비: ${shipping}`);
      lines.push(`- 총가격: ${total}`);
      lines.push(`- 신뢰도: ${p.clusterSize}/5 ${p.clusterSize && p.clusterSize >= 4 ? '🟢' : p.clusterSize && p.clusterSize >= 2 ? '🟡' : '🔴'}`);
      lines.push('');
    }

    await writeFile(filepath, lines.join('\n'), 'utf-8');
    return filepath;
  }
}

export class CsvExporter {
  private outputDir: string;

  constructor(outputDir = 'data/output') {
    this.outputDir = outputDir;
  }

  async export(products: Product[], filename?: string): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = filename || `gmarket_prices_${timestamp}`;
    const filepath = path.join(this.outputDir, `${name}.csv`);

    const headers = ['모델명', '상품명', '판매자', '쿠폰적용가', '배송비', '총가격', '할인율', '신뢰도', '상품URL', '검색URL', '수집시간'];
    const lines = [headers.join(',')];

    for (const p of products) {
      const row = [
        this.escape(p.modelName),
        this.escape(p.productName),
        this.escape(p.sellerName),
        p.couponPrice ?? '',
        p.shippingFee ?? 0,
        getTotalPrice(p) ?? '',
        p.discountPercent ?? '',
        p.clusterSize ?? '',
        this.escape(p.productUrl),
        this.escape(p.searchUrl || ''),
        p.crawledAt.toISOString().slice(0, 19).replace('T', ' '),
      ];
      lines.push(row.join(','));
    }

    // BOM 추가 (Excel 한글 호환)
    const bom = '\uFEFF';
    await writeFile(filepath, bom + lines.join('\n'), 'utf-8');
    return filepath;
  }

  private escape(str: string): string {
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
}

export class JsonExporter {
  private outputDir: string;

  constructor(outputDir = 'data/output') {
    this.outputDir = outputDir;
  }

  async export(products: Product[], filename?: string): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = filename || `gmarket_prices_${timestamp}`;
    const filepath = path.join(this.outputDir, `${name}.json`);

    const data = {
      generatedAt: new Date().toISOString(),
      totalProducts: products.length,
      products: products.map(p => ({
        modelName: p.modelName,
        productName: p.productName,
        sellerName: p.sellerName,
        couponPrice: p.couponPrice,
        shippingFee: p.shippingFee,
        totalPrice: getTotalPrice(p),
        discountPercent: p.discountPercent,
        clusterSize: p.clusterSize,
        productUrl: p.productUrl,
        searchUrl: p.searchUrl,
        crawledAt: p.crawledAt.toISOString(),
      })),
    };

    await writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
    return filepath;
  }
}
