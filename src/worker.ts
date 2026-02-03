import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { BrowserManager } from './browser.js'
import { GmarketSearcher } from './searcher.js'
import type { Product } from './types.js'

// 환경변수
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const POLL_INTERVAL = 5000 // 5초마다 폴링
const CONCURRENCY = 1 // 동시 처리 개수 (1=순차, 2=병렬)
const MIN_DELAY = 3000 // 최소 딜레이 (3초)
const MAX_DELAY = 8000 // 최대 딜레이 (8초)

// 브라우저 재시작 설정
const BROWSER_RESTART_INTERVAL = 24 * 60 * 60 * 1000 // 24시간
const BROWSER_RESTART_AFTER_JOBS = 50 // 50개 작업 후 재시작
const BROWSER_RESTART_EVERY_N_SEARCHES = 4 // N회 검색마다 브라우저 재시작 (봇 감지 우회)
const MAX_RETRY_ON_BROWSER_ERROR = 2 // 브라우저 에러 시 최대 재시도 횟수

// 브라우저 상태 추적
let lastBrowserRestart = Date.now()
let jobsSinceRestart = 0

// Supabase 클라이언트 (service_role 키 사용 - RLS 우회)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

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

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomDelay(): number {
  return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY
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
    url: product.productUrl,
    searchUrl: searchUrl || product.searchUrl,
    crawledAt: new Date().toISOString(),
  }
}

async function shouldRestartBrowser(): Promise<boolean> {
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
  if (await shouldRestartBrowser()) {
    await browser.restart()
    lastBrowserRestart = Date.now()
    jobsSinceRestart = 0
  }
  return new GmarketSearcher(browser)
}

async function processJobItem(
  browser: BrowserManager,
  searcher: GmarketSearcher,
  item: JobItem
): Promise<GmarketSearcher> {
  console.log(`[처리] ${item.model_name} (${item.sequence})`)

  try {
    await supabase
      .from('job_items')
      .update({ status: 'processing' })
      .eq('id', item.id)

    let result = await searcher.search(item.model_name, false)
    let retryCount = 0

    while (result.error && isBrowserError(result.error) && retryCount < MAX_RETRY_ON_BROWSER_ERROR) {
      retryCount++
      console.log(`[재시도] ${item.model_name} - 브라우저 재시작 후 재시도 (${retryCount}/${MAX_RETRY_ON_BROWSER_ERROR})`)
      await browser.restart()
      lastBrowserRestart = Date.now()
      jobsSinceRestart = 0
      searcher = new GmarketSearcher(browser)
      result = await searcher.search(item.model_name, false)
    }

    if (result.error) {
      await supabase
        .from('job_items')
        .update({
          status: 'failed',
          error_message: result.error,
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      await supabase.rpc('increment_job_failed', { job_id: item.job_id })
    } else {
      const transformedProducts = result.products.map((p) =>
        transformProduct(p, result.searchUrl)
      )

      await supabase
        .from('job_items')
        .update({
          status: 'completed',
          result: { products: transformedProducts },
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      await supabase.rpc('increment_job_completed', { job_id: item.job_id })
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error(`[에러] ${item.model_name}: ${error}`)

    await supabase
      .from('job_items')
      .update({
        status: 'failed',
        error_message: error,
        processed_at: new Date().toISOString(),
      })
      .eq('id', item.id)

    await supabase.rpc('increment_job_failed', { job_id: item.job_id })
  }

  return searcher
}

function isBrowserError(error: string): boolean {
  const browserErrors = [
    '검색창을 찾지 못함',
    'Browser not started',
    'Target closed',
    'Session closed',
    'Connection closed',
    'Protocol error',
  ]
  return browserErrors.some(e => error.includes(e))
}

async function processJob(browser: BrowserManager, searcher: GmarketSearcher, job: Job): Promise<GmarketSearcher> {
  console.log(`\n[작업 시작] Job ${job.id}`)

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
    return searcher
  }

  const itemChunks = chunk(items as JobItem[], CONCURRENCY)
  let currentSearcher = searcher
  let searchCount = 0

  for (const batch of itemChunks) {
    console.log(`[배치] ${batch.map(i => i.model_name).join(', ')} 동시 처리`)

    for (const item of batch) {
      if (searchCount > 0 && searchCount % BROWSER_RESTART_EVERY_N_SEARCHES === 0) {
        console.log(`[브라우저] ${searchCount}회 검색 완료, 선제 재시작`)
        await browser.restart()
        lastBrowserRestart = Date.now()
        jobsSinceRestart = 0
        currentSearcher = new GmarketSearcher(browser)
      }
      currentSearcher = await processJobItem(browser, currentSearcher, item)
      searchCount++
    }

    if (batch !== itemChunks[itemChunks.length - 1]) {
      const delayMs = randomDelay()
      console.log(`[대기] ${(delayMs / 1000).toFixed(1)}초`)
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
    }
  }

  return currentSearcher
}

async function pollForJobs(browser: BrowserManager, searcher: GmarketSearcher): Promise<GmarketSearcher> {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) {
    console.error(`[에러] Jobs 조회 실패: ${error.message}`)
    return searcher
  }

  if (jobs && jobs.length > 0) {
    return await processJob(browser, searcher, jobs[0] as Job)
  }

  return searcher
}

async function main(): Promise<void> {
  console.log('=================================')
  console.log('G마켓 크롤러 워커 시작')
  console.log('=================================')

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[에러] SUPABASE_URL과 SUPABASE_SERVICE_KEY 환경변수가 필요합니다.')
    process.exit(1)
  }

  const browser = new BrowserManager(true)
  await browser.start()
  let searcher = new GmarketSearcher(browser)

  console.log('[준비] 브라우저 시작 완료')
  console.log(`[설정] 동시처리: ${CONCURRENCY}개, 딜레이: ${MIN_DELAY/1000}-${MAX_DELAY/1000}초`)
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
    searcher = await pollForJobs(browser, searcher)
    await delay(POLL_INTERVAL)
  }
}

main().catch((e) => {
  console.error('[치명적 에러]', e)
  process.exit(1)
})
