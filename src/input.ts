import { readFile } from 'fs/promises';
import path from 'path';
import ExcelJS from 'exceljs';

export class InputReader {
  async read(filePath: string): Promise<string[]> {
    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
      case '.txt':
        return this.readTxt(filePath);
      case '.csv':
        return this.readCsv(filePath);
      case '.xlsx':
      case '.xls':
        return this.readExcel(filePath);
      default:
        throw new Error(`지원하지 않는 파일 형식: ${ext}`);
    }
  }

  private async readTxt(filePath: string): Promise<string[]> {
    const content = await readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  private async readCsv(filePath: string): Promise<string[]> {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const models: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 첫 번째 컬럼만 사용
      const firstCol = trimmed.split(',')[0].trim();
      // 따옴표 제거
      const cleaned = firstCol.replace(/^["']|["']$/g, '');
      if (cleaned) models.push(cleaned);
    }

    return models;
  }

  private async readExcel(filePath: string): Promise<string[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('Excel 파일에 시트가 없습니다');

    const models: string[] = [];

    sheet.eachRow((row, rowNumber) => {
      const cell = row.getCell(1);
      const value = cell.value?.toString().trim();
      if (value) models.push(value);
    });

    return models;
  }
}
