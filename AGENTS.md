# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-20
**Branch:** main

## OVERVIEW

G마켓 최저가 검색 웹 서비스. Next.js(Vercel) + Supabase + Playwright 크롤러(Oracle VPS) 구조.

## STRUCTURE

```
gmarket-lowprice/
├── apps/
│   ├── web/           # Next.js 14 웹앱 (Vercel 배포)
│   └── crawler/       # [미사용] 크롤러 패키지 - src/와 중복
├── packages/
│   └── shared/        # 공유 타입 (Product, Job, 가격 클러스터링)
├── src/               # [실제 배포] 크롤러 워커 코드 (VPS용)
├── supabase/          # DB 마이그레이션, RLS 정책
└── docker-compose.yml # 로컬 워커 실행용
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| 웹 UI 수정 | `apps/web/src/app/` | Next.js App Router |
| API 엔드포인트 | `apps/web/src/app/api/` | jobs CRUD |
| 크롤러 로직 | `src/` | ⚠️ `apps/crawler/`가 아님 |
| 상품 파싱 | `src/parser.ts` | G마켓 HTML 파싱 |
| 최저가 선별 | `packages/shared/src/index.ts` | 가격 클러스터링 알고리즘 |
| DB 스키마 | `supabase/migrations/` | jobs, job_items, profiles |
| UI 컴포넌트 | `apps/web/src/components/ui/` | shadcn/ui 기반 |

## CODE MAP

| Symbol | Location | Role |
|--------|----------|------|
| `GmarketSearcher` | `src/searcher.ts` | G마켓 검색 실행, 필터 적용 |
| `GmarketParser` | `src/parser.ts` | 검색결과 HTML 파싱 |
| `BrowserManager` | `src/browser.ts` | Playwright 브라우저 관리 |
| `ExcelExporter` | `src/exporters.ts` | 결과 Excel 생성 |
| `getLowestPriceProduct` | `packages/shared` | 가격 클러스터링으로 최저가 선별 |
| `pollForJobs` | `src/worker.ts` | 5초 간격 작업 폴링 |

## CONVENTIONS

### 코드 스타일
- TypeScript ESM (`"type": "module"`)
- 한국어 로그 메시지 (`console.log('[검색]', ...)`)
- Supabase RLS: 웹앱은 `anon` 키, 워커는 `service_role` 키 사용

### 가격 클러스터링 로직
```typescript
// 30% 이내 가격차 → 동일 클러스터
// 3개 이상 클러스터 → 신뢰 가능한 최저가
if (diff <= 0.3) currentCluster.push(product)
if (cluster.length >= 3) return cluster[0]  // 최저가
```

### G마켓 검색 필터
```typescript
// s=1: 낮은가격순, c=100000076: 공구 카테고리
FILTER_PARAMS = '&s=1&c=100000076&f=c:100000076'
```

## ANTI-PATTERNS (THIS PROJECT)

| 금지 | 이유 |
|------|------|
| `apps/crawler/` 수정 | 실제 배포는 root `src/` 사용 |
| RLS 우회 시도 | 웹앱에서 `service_role` 키 사용 금지 |
| 환경변수 하드코딩 | `.env` 또는 Vercel/VPS 환경변수 사용 |

## COMMANDS

```bash
# 개발
pnpm dev              # 전체
pnpm dev:web          # 웹앱만

# 빌드
pnpm build:worker     # 크롤러 (tsc → dist/)
pnpm build:web        # 웹앱 (next build)

# 실행
pnpm worker           # 로컬 워커 실행

# VPS 배포
ssh -i ~/.ssh/oracle.key ubuntu@158.179.163.193
git pull && pnpm build:worker
sudo systemctl restart gmarket-worker

# 로그 확인
sudo journalctl -u gmarket-worker -f
```

## NOTES

### 배포 구조
- **웹앱**: Vercel (자동 배포)
- **크롤러**: Oracle Cloud VPS, systemd 서비스 (`gmarket-worker`)
- **DB**: Supabase (ap-northeast-2)

### 알려진 이슈
1. `src/` vs `apps/crawler/src/` 코드 중복 → root `src/`가 실제 배포 코드
2. 전역 린터/포매터 미설정
3. 자동화 테스트 없음

### 환경변수
```bash
# 크롤러 필수
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# 웹앱
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```
