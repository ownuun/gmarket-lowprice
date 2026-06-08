import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { BrowserManager } from './browser.js'
import { GmarketSearcher } from './searcher.js'
import { IncidentTracker, type IncidentSettings } from './incident.js'
import type { Product } from './types.js'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const POLL_INTERVAL = 3000
const CONCURRENCY = 1
const MIN_DELAY = parseInt(process.env.WORKER_MIN_DELAY ?? '2000', 10)
const MAX_DELAY = parseInt(process.env.WORKER_MAX_DELAY ?? '5000', 10)

const CONTEXT_ROTATION_EVERY = parseInt(process.env.WORKER_CONTEXT_ROTATION_EVERY ?? '30', 10)
const CONTEXT_COOLDOWN_MS = parseInt(process.env.WORKER_CONTEXT_COOLDOWN_MS ?? '8000', 10)
const BROWSER_RESTART_INTERVAL = 24 * 60 * 60 * 1000
const BROWSER_RESTART_AFTER_JOBS = 300
const MAX_RETRY_ON_BROWSER_ERROR = 2
const MAX_RETRY_ON_BLOCKED = parseInt(process.env.WORKER_MAX_RETRY_ON_BLOCKED ?? '1', 10)
const BLOCKED_RETRY_MIN_DELAY = parseInt(process.env.WORKER_BLOCKED_RETRY_MIN_DELAY ?? '900000', 10)
const BLOCKED_RETRY_MAX_DELAY = parseInt(process.env.WORKER_BLOCKED_RETRY_MAX_DELAY ?? '1800000', 10)

let lastBrowserRestart = Date.now()
let jobsSinceRestart = 0
let searchesSinceContextRotation = 0
let workerLogsAvailable = true

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const PROXY_HOST = process.env.PROXY_HOST || ''
const PROXY_USERNAME = process.env.PROXY_USERNAME || ''

function buildIncidentSettings(): IncidentSettings {
  const proxy = PROXY_HOST
    ? `${PROXY_HOST} (${PROXY_USERNAME.includes('country') ? PROXY_USERNAME.split('_').pop() : 'default'})`
    : 'direct'
  return {
    delayRange: [MIN_DELAY, MAX_DELAY],
    contextRotationEvery: CONTEXT_ROTATION_EVERY,
    contextCooldownMs: CONTEXT_COOLDOWN_MS,
    proxy,
    userAgent: 'rotating',
    viewport: 'rotating',
  }
}

interface JobItem {
  id: string
  job_id: string
  model_name: string
  status: string
  result: {
    products: Array<{
      name: string
      originalPrice: number | null
      discountPrice: number | null
      shippingFee: number | null
      totalPrice: number | null
      seller: string
      url: string
    }>
  } | null
  error_message: string | null
  sequence: number
  processed_at: string | null
}

interface Job {
  id: string
  user_id: string
  status: string
  total_models: number
  completed_models: number
  failed_models: number
}

type WorkerLogLevel = 'info' | 'success' | 'warn' | 'error'

async function addWorkerLog(params: {
  jobId: string
  jobItemId?: string
  modelName?: string
  level: WorkerLogLevel
  message: string
}): Promise<void> {
  if (!workerLogsAvailable) return

  const { error } = await supabase.from('worker_logs').insert({
    job_id: params.jobId,
    job_item_id: params.jobItemId,
    model_name: params.modelName,
    level: params.level,
    message: params.message,
  })

  if (error) {
    if (error.code === 'PGRST205' || error.message.includes('worker_logs')) {
      workerLogsAvailable = false
      console.error('[로그 저장 비활성화] worker_logs 테이블을 찾지 못함 - migration 적용 후 worker 재시작 필요')
      return
    }
    console.error(`[로그 저장 실패] ${error.message}`)
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomDelay(): number {
  return randomBetween(MIN_DELAY, MAX_DELAY)
}

function randomBetween(minMs: number, maxMs: number): number {
  const min = Math.max(0, Math.min(minMs, maxMs))
  const max = Math.max(min, maxMs)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// 배열을 chunk로 분할
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

function transformProduct(product: Product, searchUrl?: string) {
  return {
    rank: product.rank,
    name: product.productName,
    originalPrice: product.regularPrice,
    discountPrice: product.couponPrice,
    discountPercent: product.discountPercent,
    shippingFee: product.shippingFee,
    totalPrice:
      (product.couponPrice ?? product.regularPrice ?? 0) +
      (product.shippingFee ?? 0),
    seller: product.sellerName,
    productNo: product.productNo,
    priceGroupLabel: product.priceGroupLabel,
    clusterSourceSeller: product.clusterSourceSeller,
    strategyLabel: product.strategyLabel,
    matchScore: product.matchScore,
    matchReasons: product.matchReasons,
    url: product.productUrl,
    searchUrl: searchUrl || product.searchUrl,
    largeCategoryCode: product.largeCategoryCode,
    mediumCategoryCode: product.mediumCategoryCode,
    smallCategoryCode: product.smallCategoryCode,
    largeCategoryName: product.largeCategoryName,
    mediumCategoryName: product.mediumCategoryName,
    smallCategoryName: product.smallCategoryName,
    crawledAt: new Date().toISOString(),
  }
}

function shouldRestartBrowser(): boolean {
  const timeSinceRestart = Date.now() - lastBrowserRestart
  if (timeSinceRestart >= BROWSER_RESTART_INTERVAL) {
    console.log(`[브라우저] ${Math.floor(timeSinceRestart / 1000 / 60 / 60)}시간 경과, 재시작 필요`)
    return true
  }
  if (jobsSinceRestart >= BROWSER_RESTART_AFTER_JOBS) {
    console.log(`[브라우저] ${jobsSinceRestart}개 작업 처리, 재시작 필요`)
    return true
  }
  return false
}

async function restartBrowserIfNeeded(browser: BrowserManager): Promise<GmarketSearcher> {
  if (shouldRestartBrowser()) {
    await browser.restart()
    lastBrowserRestart = Date.now()
    jobsSinceRestart = 0
    searchesSinceContextRotation = 0
  }
  return new GmarketSearcher(browser)
}

async function rotateContextIfNeeded(browser: BrowserManager, searcher: GmarketSearcher, tracker?: IncidentTracker): Promise<GmarketSearcher> {
  if (searchesSinceContextRotation >= CONTEXT_ROTATION_EVERY) {
    console.log(`[Context] ${searchesSinceContextRotation}회 검색 완료, Context 교체`)
    const cooldown = CONTEXT_COOLDOWN_MS + Math.random() * 4000
    await browser.rotateContext(cooldown)
    searchesSinceContextRotation = 0
    tracker?.recordContextRotation()
    const newSearcher = new GmarketSearcher(browser)
    return newSearcher
  }
  return searcher
}

interface ProcessResult {
  searcher: GmarketSearcher;
  blocked: boolean;
}

async function processJobItem(
  browser: BrowserManager,
  searcher: GmarketSearcher,
  item: JobItem,
  tracker: IncidentTracker,
): Promise<ProcessResult> {
  console.log(`[처리] ${item.model_name} (${item.sequence})`)
  await addWorkerLog({
    jobId: item.job_id,
    jobItemId: item.id,
    modelName: item.model_name,
    level: 'info',
    message: `[처리] ${item.model_name} (${item.sequence})`,
  })

  try {
    await supabase
      .from('job_items')
      .update({ status: 'processing' })
      .eq('id', item.id)

    await addWorkerLog({
      jobId: item.job_id,
      jobItemId: item.id,
      modelName: item.model_name,
      level: 'info',
      message: `[검색] ${item.model_name}`,
    })
    let result = await searcher.search(item.model_name, false)
    let retryCount = 0

    while (result.error === 'BLOCKED' && retryCount < MAX_RETRY_ON_BLOCKED) {
      retryCount++
      const cooldown = randomBetween(BLOCKED_RETRY_MIN_DELAY, BLOCKED_RETRY_MAX_DELAY)
      console.log(`[차단 쿨다운] ${item.model_name} - ${(cooldown / 1000 / 60).toFixed(1)}분 대기 후 브라우저 재시작 (${retryCount}/${MAX_RETRY_ON_BLOCKED})`)
      await addWorkerLog({
        jobId: item.job_id,
        jobItemId: item.id,
        modelName: item.model_name,
        level: 'warn',
        message: `[차단 쿨다운] ${(cooldown / 1000 / 60).toFixed(1)}분 대기 후 브라우저 재시작 (${retryCount}/${MAX_RETRY_ON_BLOCKED})`,
      })
      await delay(cooldown)
      await browser.restart()
      lastBrowserRestart = Date.now()
      jobsSinceRestart = 0
      searchesSinceContextRotation = 0
      tracker.recordBrowserRestart()
      searcher = new GmarketSearcher(browser)
      await addWorkerLog({
        jobId: item.job_id,
        jobItemId: item.id,
        modelName: item.model_name,
        level: 'info',
        message: `[검색] ${item.model_name} (재시도 ${retryCount})`,
      })
      result = await searcher.search(item.model_name, false)
    }

    retryCount = 0
    while (result.error && result.error !== 'BLOCKED' && isBrowserError(result.error) && retryCount < MAX_RETRY_ON_BROWSER_ERROR) {
      retryCount++
      console.log(`[재시도] ${item.model_name} - 브라우저 재시작 후 재시도 (${retryCount}/${MAX_RETRY_ON_BROWSER_ERROR})`)
      await addWorkerLog({
        jobId: item.job_id,
        jobItemId: item.id,
        modelName: item.model_name,
        level: 'warn',
        message: `[재시도] 브라우저 재시작 후 재시도 (${retryCount}/${MAX_RETRY_ON_BROWSER_ERROR})`,
      })
      await browser.restart()
      lastBrowserRestart = Date.now()
      jobsSinceRestart = 0
      searchesSinceContextRotation = 0
      tracker.recordBrowserRestart()
      searcher = new GmarketSearcher(browser)
      await addWorkerLog({
        jobId: item.job_id,
        jobItemId: item.id,
        modelName: item.model_name,
        level: 'info',
        message: `[검색] ${item.model_name} (브라우저 재시작 후)`,
      })
      result = await searcher.search(item.model_name, false)
    }

    searchesSinceContextRotation++

    if (result.error) {
      const verdict = await tracker.recordFailure(
        item.model_name,
        result.error,
        result.screenshotPath,
        result.pageSnippet,
      )

      await supabase
        .from('job_items')
        .update({
          status: 'failed',
          error_message: result.error,
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      await supabase.rpc('increment_job_failed', { job_id: item.job_id })
      await addWorkerLog({
        jobId: item.job_id,
        jobItemId: item.id,
        modelName: item.model_name,
        level: result.error === 'BLOCKED' ? 'warn' : 'error',
        message: `[실패] ${result.error}`,
      })

      if (verdict === 'BLOCKED_CONFIRMED') {
        return { searcher, blocked: true }
      }
    } else {
      tracker.recordSuccess(item.model_name, result.products.length)

      const transformedProducts = result.products.map((p) =>
        transformProduct(p, result.searchUrl)
      )
      const transformedSellerClusterProducts = result.sellerClusterProducts?.map((p) =>
        transformProduct(p, result.searchUrl)
      ) ?? []
      const transformedStrategyProducts = result.strategyProducts?.map((p) =>
        transformProduct(p, result.searchUrl)
      ) ?? []

      await supabase
        .from('job_items')
        .update({
          status: 'completed',
          result: {
            products: transformedProducts,
            sellerClusterProducts: transformedSellerClusterProducts,
            strategyProducts: transformedStrategyProducts,
            strategyMeta: result.strategyMeta,
          },
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      await supabase.rpc('increment_job_completed', { job_id: item.job_id })
      await addWorkerLog({
        jobId: item.job_id,
        jobItemId: item.id,
        modelName: item.model_name,
        level: 'success',
        message: `[완료] 파싱 결과: ${transformedProducts.length}개`,
      })
      if (result.sellerClusterMeta && result.sellerClusterMeta.addedProductCount > 0) {
        await addWorkerLog({
          jobId: item.job_id,
          jobItemId: item.id,
          modelName: item.model_name,
          level: 'info',
          message: `[클러스터링] 판매계정 상품 ${result.sellerClusterMeta.sellerProductCount}개${result.sellerClusterMeta.page2Checked ? ' (2페이지 확인)' : ''}, 가격군 ${result.sellerClusterMeta.clusterCount}개 중 ${result.sellerClusterMeta.addedClusterCount}개 추가 (${result.sellerClusterMeta.addedProductCount}개)`,
        })
      }
      if (result.strategyMeta && transformedStrategyProducts.length > 0) {
        await addWorkerLog({
          jobId: item.job_id,
          jobItemId: item.id,
          modelName: item.model_name,
          level: 'info',
          message: `[전략] ${result.strategyMeta.strategy} 모델최저가 ${transformedStrategyProducts.length}개${result.strategyMeta.priceBand ? ` (${result.strategyMeta.priceBand.min.toLocaleString()}-${result.strategyMeta.priceBand.max.toLocaleString()}원)` : ''}`,
        })
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error(`[에러] ${item.model_name}: ${error}`)

    await tracker.recordFailure(item.model_name, error)

    await supabase
      .from('job_items')
      .update({
        status: 'failed',
        error_message: error,
        processed_at: new Date().toISOString(),
      })
      .eq('id', item.id)

    await supabase.rpc('increment_job_failed', { job_id: item.job_id })
    await addWorkerLog({
      jobId: item.job_id,
      jobItemId: item.id,
      modelName: item.model_name,
      level: 'error',
      message: `[에러] ${error}`,
    })
  }

  return { searcher, blocked: false }
}

function isBrowserError(error: string): boolean {
  const browserErrors = [
    '검색창을 찾지 못함',
    'Browser not started',
    'Target closed',
    'Session closed',
    'Connection closed',
    'Protocol error',
    'net::ERR_TIMED_OUT',
    'Timeout',
    'Navigation timeout',
  ]
  return browserErrors.some(e => error.includes(e))
}

interface JobResult {
  searcher: GmarketSearcher;
  blocked: boolean;
}

async function processJob(
  browser: BrowserManager,
  searcher: GmarketSearcher,
  job: Job,
  tracker: IncidentTracker,
): Promise<JobResult> {
  console.log(`\n[작업 시작] Job ${job.id}`)
  await addWorkerLog({
    jobId: job.id,
    level: 'info',
    message: `[작업 시작] Job ${job.id}`,
  })

  await supabase
    .from('jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id)

  const { data: items, error } = await supabase
    .from('job_items')
    .select('*')
    .eq('job_id', job.id)
    .eq('status', 'pending')
    .order('sequence', { ascending: true })

  if (error || !items) {
    console.error(`[에러] Job items 조회 실패: ${error?.message}`)
    await addWorkerLog({
      jobId: job.id,
      level: 'error',
      message: `[에러] Job items 조회 실패: ${error?.message}`,
    })
    return { searcher, blocked: false }
  }

  const itemChunks = chunk(items as JobItem[], CONCURRENCY)
  let currentSearcher = searcher

  for (const batch of itemChunks) {
    console.log(`[배치] ${batch.map(i => i.model_name).join(', ')} 처리`)
    await addWorkerLog({
      jobId: job.id,
      level: 'info',
      message: `[배치] ${batch.map(i => i.model_name).join(', ')} 처리`,
    })

    for (const item of batch) {
      currentSearcher = await rotateContextIfNeeded(browser, currentSearcher, tracker)
      const result = await processJobItem(browser, currentSearcher, item, tracker)
      currentSearcher = result.searcher

      if (result.blocked) {
        console.log(`[인시던트] Job ${job.id} 일시 중지 (봇 탐지)`)
        await addWorkerLog({
          jobId: job.id,
          level: 'error',
          message: '[인시던트] 봇 탐지로 작업 일시 중지',
        })
        await supabase
          .from('jobs')
          .update({ status: 'paused', error_message: 'Bot detection confirmed' })
          .eq('id', job.id)
        return { searcher: currentSearcher, blocked: true }
      }
    }

    if (batch !== itemChunks[itemChunks.length - 1]) {
      const delayMs = randomDelay()
      console.log(`[대기] ${(delayMs / 1000).toFixed(1)}초`)
      await addWorkerLog({
        jobId: job.id,
        level: 'info',
        message: `[대기] ${(delayMs / 1000).toFixed(1)}초`,
      })
      await delay(delayMs)
    }
  }

  jobsSinceRestart++

  const { data: jobStatus } = await supabase
    .from('jobs')
    .select('total_models, completed_models, failed_models')
    .eq('id', job.id)
    .single()

  if (jobStatus) {
    const allProcessed =
      jobStatus.completed_models + jobStatus.failed_models >=
      jobStatus.total_models

    if (allProcessed) {
      await supabase
        .from('jobs')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', job.id)

      console.log(`[완료] Job ${job.id}`)
      await addWorkerLog({
        jobId: job.id,
        level: 'success',
        message: `[완료] Job ${job.id}`,
      })
    }
  }

  return { searcher: currentSearcher, blocked: false }
}

async function pollForJobs(
  browser: BrowserManager,
  searcher: GmarketSearcher,
  tracker: IncidentTracker,
): Promise<JobResult> {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) {
    console.error(`[에러] Jobs 조회 실패: ${error.message}`)
    return { searcher, blocked: false }
  }

  if (jobs && jobs.length > 0) {
    return await processJob(browser, searcher, jobs[0] as Job, tracker)
  }

  return { searcher, blocked: false }
}

async function main(): Promise<void> {
  console.log('=================================')
  console.log('G마켓 크롤러 워커 시작')
  console.log('=================================')

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[에러] SUPABASE_URL과 SUPABASE_SERVICE_KEY 환경변수가 필요합니다.')
    process.exit(1)
  }

  const headless = process.env.WORKER_HEADLESS !== 'false'
  const browser = new BrowserManager(headless)
  await browser.start()
  let searcher = new GmarketSearcher(browser)
  const tracker = new IncidentTracker(buildIncidentSettings())

  console.log('[준비] 브라우저 시작 완료')
  console.log(`[설정] 딜레이: ${MIN_DELAY/1000}-${MAX_DELAY/1000}초, Context 교체: ${CONTEXT_ROTATION_EVERY}회마다 (${CONTEXT_COOLDOWN_MS/1000}초 쿨다운)`)
  console.log(`[설정] 차단 재시도: 최대 ${MAX_RETRY_ON_BLOCKED}회, 쿨다운 ${BLOCKED_RETRY_MIN_DELAY/1000/60}-${BLOCKED_RETRY_MAX_DELAY/1000/60}분`)
  console.log(`[설정] 브라우저 재시작: ${BROWSER_RESTART_INTERVAL/1000/60/60}시간 또는 ${BROWSER_RESTART_AFTER_JOBS}개 작업마다`)
  console.log(`[대기] ${POLL_INTERVAL / 1000}초마다 작업 확인 중...\n`)

  let running = true
  process.on('SIGINT', async () => {
    console.log('\n[종료] 워커 종료 중...')
    running = false
    await browser.stop()
    process.exit(0)
  })

  while (running) {
    searcher = await restartBrowserIfNeeded(browser)
    searcher = await rotateContextIfNeeded(browser, searcher, tracker)
    const result = await pollForJobs(browser, searcher, tracker)
    searcher = result.searcher

    if (result.blocked) {
      console.log('\n[인시던트] 봇 탐지로 워커 중지. data/incidents/ 확인 필요.')
      const stats = tracker.getStats()
      console.log(`[인시던트] 총 검색: ${stats.totalSearches}, Context 교체: ${stats.contextRotationCount}회, 가동: ${stats.uptimeMinutes}분`)
      await browser.stop()
      process.exit(1)
    }

    await delay(POLL_INTERVAL)
  }
}

main().catch((e) => {
  console.error('[치명적 에러]', e)
  process.exit(1)
})
