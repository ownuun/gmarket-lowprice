import { mkdir, writeFile, readFile } from 'fs/promises';
import path from 'path';

const INCIDENTS_DIR = 'data/incidents';
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

interface FailureRecord {
  model: string;
  error: string;
  at: string;
}

interface IncidentLog {
  timestamp: string;
  verdict: 'BLOCKED_CONFIRMED' | 'FALSE_ALARM';
  session: {
    totalSearches: number;
    searchesSinceContextRotation: number;
    contextRotationCount: number;
    browserRestartCount: number;
    uptimeMinutes: number;
  };
  settings: {
    delayRange: [number, number];
    contextRotationEvery: number;
    contextCooldownMs: number;
    proxy: string;
    userAgent: string;
    viewport: string;
  };
  failedSearches: FailureRecord[];
  lastSuccessfulSearch: { model: string; at: string; productsFound: number } | null;
  screenshotPath: string;
  pageSnippet: string;
}

export interface IncidentSettings {
  delayRange: [number, number];
  contextRotationEvery: number;
  contextCooldownMs: number;
  proxy: string;
  userAgent: string;
  viewport: string;
}

export type IncidentVerdict = 'CONTINUE' | 'BLOCKED_CONFIRMED';

export class IncidentTracker {
  private consecutiveFailures: FailureRecord[] = [];
  private lastSuccess: { model: string; at: string; productsFound: number } | null = null;
  private totalSearches = 0;
  private contextRotationCount = 0;
  private browserRestartCount = 0;
  private startTime = Date.now();
  private settings: IncidentSettings;
  private searchesSinceContextRotation = 0;

  constructor(settings: IncidentSettings) {
    this.settings = settings;
  }

  recordSuccess(model: string, productsFound: number): void {
    this.totalSearches++;
    this.searchesSinceContextRotation++;
    this.consecutiveFailures = [];
    this.lastSuccess = {
      model,
      at: new Date().toISOString(),
      productsFound,
    };
  }

  async recordFailure(
    model: string,
    error: string,
    screenshotPath?: string,
    pageSnippet?: string,
  ): Promise<IncidentVerdict> {
    this.totalSearches++;
    this.searchesSinceContextRotation++;

    this.consecutiveFailures.push({
      model,
      error,
      at: new Date().toISOString(),
    });

    if (this.consecutiveFailures.length < CONSECUTIVE_FAILURES_THRESHOLD) {
      return 'CONTINUE';
    }

    console.log(`[인시던트] 연속 ${CONSECUTIVE_FAILURES_THRESHOLD}회 실패 감지`);

    const snippet = pageSnippet || '';
    const isBlocked = this.analyzeBlockedPage(snippet);

    const verdict: 'BLOCKED_CONFIRMED' | 'FALSE_ALARM' = isBlocked
      ? 'BLOCKED_CONFIRMED'
      : 'FALSE_ALARM';

    await this.saveIncidentLog(verdict, screenshotPath || '', snippet);

    if (isBlocked) {
      console.log(`[인시던트] 봇 탐지 확인 - 워커 중지 필요`);
      return 'BLOCKED_CONFIRMED';
    }

    console.log(`[인시던트] 봇 탐지 아님 (FALSE_ALARM) - 계속 진행`);
    this.consecutiveFailures = [];
    return 'CONTINUE';
  }

  recordContextRotation(): void {
    this.contextRotationCount++;
    this.searchesSinceContextRotation = 0;
  }

  recordBrowserRestart(): void {
    this.browserRestartCount++;
  }

  updateSettings(partial: Partial<IncidentSettings>): void {
    this.settings = { ...this.settings, ...partial };
  }

  getStats() {
    return {
      totalSearches: this.totalSearches,
      consecutiveFailures: this.consecutiveFailures.length,
      contextRotationCount: this.contextRotationCount,
      browserRestartCount: this.browserRestartCount,
      uptimeMinutes: Math.floor((Date.now() - this.startTime) / 60000),
    };
  }

  private analyzeBlockedPage(pageSnippet: string): boolean {
    const lower = pageSnippet.toLowerCase();
    const blockedSignals = [
      'captcha',
      'robot',
      '자동화',
      'blocked',
      'access denied',
      'unusual traffic',
      '비정상',
      '보안문자',
      'verify',
      'challenge',
    ];
    return blockedSignals.some(signal => lower.includes(signal));
  }

  private async saveIncidentLog(
    verdict: 'BLOCKED_CONFIRMED' | 'FALSE_ALARM',
    screenshotPath: string,
    pageSnippet: string,
  ): Promise<void> {
    await mkdir(INCIDENTS_DIR, { recursive: true });

    const log: IncidentLog = {
      timestamp: new Date().toISOString(),
      verdict,
      session: {
        totalSearches: this.totalSearches,
        searchesSinceContextRotation: this.searchesSinceContextRotation,
        contextRotationCount: this.contextRotationCount,
        browserRestartCount: this.browserRestartCount,
        uptimeMinutes: Math.floor((Date.now() - this.startTime) / 60000),
      },
      settings: { ...this.settings },
      failedSearches: [...this.consecutiveFailures],
      lastSuccessfulSearch: this.lastSuccess,
      screenshotPath,
      pageSnippet: pageSnippet.slice(0, 200),
    };

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logPath = path.join(INCIDENTS_DIR, `${ts}.json`);
    await writeFile(logPath, JSON.stringify(log, null, 2), 'utf-8');
    console.log(`[인시던트] 로그 저장: ${logPath}`);

    await this.updateSummary(log);
  }

  private async updateSummary(log: IncidentLog): Promise<void> {
    const summaryPath = path.join(INCIDENTS_DIR, 'summary.md');

    let existing = '';
    try {
      existing = await readFile(summaryPath, 'utf-8');
    } catch {
      existing = '| 날짜 | 검색수 | 결과 | 딜레이 | Context교체 | 프록시 | UA | 페이지 |\n'
        + '|------|--------|------|--------|-------------|--------|----|--------|\n';
    }

    const date = log.timestamp.slice(0, 10);
    const row = `| ${date} | ${log.session.totalSearches} | ${log.verdict} | ${log.settings.delayRange[0]/1000}-${log.settings.delayRange[1]/1000}s | ${log.settings.contextRotationEvery}회/${log.session.contextRotationCount}번 | ${log.settings.proxy} | ...${log.settings.userAgent.slice(-20)} | ${log.pageSnippet.slice(0, 30)}... |`;

    await writeFile(summaryPath, existing + row + '\n', 'utf-8');
  }
}
