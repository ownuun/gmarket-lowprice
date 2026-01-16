import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { BrowserManager } from './browser.js'
import { GmarketSearcher } from './searcher.js'
import type { Product } from './types.js'

// 환경변수
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const POLL_INTERVAL = 5000 // 5초마다 폴링
const CONCURRENCY = 2 // 동시 처리 개수
const MIN_DELAY = 3000 // 최소 딜레이 (3초)
const MAX_DELAY = 8000 // 최대 딜레이 (8초)

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

async function processJobItem(
  searcher: GmarketSearcher,
  item: JobItem
): Promise<void> {
  console.log(`[처리] ${item.model_name} (${item.sequence})`)

  try {
    // 상태를 processing으로 변경
    await supabase
      .from('job_items')
      .update({ status: 'processing' })
      .eq('id', item.id)

    // 크롤링 실행
    const result = await searcher.search(item.model_name, false)

    if (result.error) {
      // 에러 발생시 failed 처리
      await supabase
        .from('job_items')
        .update({
          status: 'failed',
          error_message: result.error,
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      // Job의 failed_models 증가
      await supabase.rpc('increment_job_failed', { job_id: item.job_id })
    } else {
      // 성공시 결과 저장
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

      // Job의 completed_models 증가
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
}

async function processJob(searcher: GmarketSearcher, job: Job): Promise<void> {
  console.log(`\n[작업 시작] Job ${job.id}`)

  // Job 상태를 running으로 변경
  await supabase
    .from('jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', job.id)

  // pending 상태의 job_items 가져오기
  const { data: items, error } = await supabase
    .from('job_items')
    .select('*')
    .eq('job_id', job.id)
    .eq('status', 'pending')
    .order('sequence', { ascending: true })

  if (error || !items) {
    console.error(`[에러] Job items 조회 실패: ${error?.message}`)
    return
  }

  // 병렬 처리 (CONCURRENCY 개씩)
  const itemChunks = chunk(items as JobItem[], CONCURRENCY)

  for (const batch of itemChunks) {
    console.log(`[배치] ${batch.map(i => i.model_name).join(', ')} 동시 처리`)

    // 배치 내 아이템 병렬 처리
    await Promise.all(batch.map(item => processJobItem(searcher, item)))

    // 다음 배치 전 랜덤 딜레이
    if (batch !== itemChunks[itemChunks.length - 1]) {
      const delayMs = randomDelay()
      console.log(`[대기] ${(delayMs / 1000).toFixed(1)}초`)
      await delay(delayMs)
    }
  }

  // Job 완료 확인
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
}

async function pollForJobs(searcher: GmarketSearcher): Promise<void> {
  // pending 상태의 작업 찾기
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) {
    console.error(`[에러] Jobs 조회 실패: ${error.message}`)
    return
  }

  if (jobs && jobs.length > 0) {
    await processJob(searcher, jobs[0] as Job)
  }
}

async function main(): Promise<void> {
  console.log('=================================')
  console.log('G마켓 크롤러 워커 시작')
  console.log('=================================')

  // 환경변수 확인
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[에러] SUPABASE_URL과 SUPABASE_SERVICE_KEY 환경변수가 필요합니다.')
    process.exit(1)
  }

  // 브라우저 시작
  const browser = new BrowserManager(true)
  await browser.start()
  const searcher = new GmarketSearcher(browser)

  console.log('[준비] 브라우저 시작 완료')
  console.log(`[설정] 동시처리: ${CONCURRENCY}개, 딜레이: ${MIN_DELAY/1000}-${MAX_DELAY/1000}초`)
  console.log(`[대기] ${POLL_INTERVAL / 1000}초마다 작업 확인 중...\n`)

  // 종료 시그널 핸들링
  let running = true
  process.on('SIGINT', async () => {
    console.log('\n[종료] 워커 종료 중...')
    running = false
    await browser.stop()
    process.exit(0)
  })

  // 메인 루프
  while (running) {
    await pollForJobs(searcher)
    await delay(POLL_INTERVAL)
  }
}

main().catch((e) => {
  console.error('[치명적 에러]', e)
  process.exit(1)
})
