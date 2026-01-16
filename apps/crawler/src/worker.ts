import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { BrowserManager } from './browser.js'
import { GmarketSearcher } from './searcher.js'
import { ExcelExporter } from './exporters.js'
import { getLowestPriceProduct, type SearchResult } from './types.js'
import * as fs from 'fs'
import * as path from 'path'

// 환경변수 확인
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('환경변수 설정 필요: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// Supabase 클라이언트 (service role - RLS 우회)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// 설정
const POLL_INTERVAL = 5000 // 5초마다 폴링

interface Job {
  id: string
  user_id: string
  status: string
  total_models: number
  completed_models: number
  failed_models: number
  result_format: 'excel' | 'csv'
}

interface JobItem {
  id: string
  job_id: string
  model_name: string
  status: string
  sequence: number
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function processJob(job: Job): Promise<void> {
  console.log(`\n========== 작업 시작: ${job.id} (${job.total_models}개 모델) ==========\n`)

  // 작업 상태 업데이트
  await supabase
    .from('jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', job.id)

  // 작업 아이템 조회
  const { data: items, error: itemsError } = await supabase
    .from('job_items')
    .select('*')
    .eq('job_id', job.id)
    .order('sequence')

  if (itemsError || !items) {
    console.error('작업 아이템 조회 실패:', itemsError)
    await supabase
      .from('jobs')
      .update({ status: 'failed', error_message: '작업 아이템 조회 실패' })
      .eq('id', job.id)
    return
  }

  // 브라우저 시작
  const browserManager = new BrowserManager(true, '/tmp/screenshots')

  try {
    await browserManager.start()
  } catch (err) {
    console.error('브라우저 시작 실패:', err)
    await supabase
      .from('jobs')
      .update({ status: 'failed', error_message: '브라우저 시작 실패' })
      .eq('id', job.id)
    return
  }

  const searcher = new GmarketSearcher(browserManager)
  const results: SearchResult[] = []
  let completedCount = 0
  let failedCount = 0

  // 각 모델 크롤링
  for (const item of items as JobItem[]) {
    console.log(`[${completedCount + failedCount + 1}/${items.length}] 검색: ${item.model_name}`)

    // 아이템 상태 업데이트
    await supabase
      .from('job_items')
      .update({ status: 'processing' })
      .eq('id', item.id)

    try {
      // 검색 수행 (스크린샷 비활성화)
      const result = await searcher.search(item.model_name, false)
      results.push(result)

      if (result.error) {
        throw new Error(result.error)
      }

      // 최저가 선택
      const lowestPrice = getLowestPriceProduct(result.products)

      // 아이템 완료
      await supabase
        .from('job_items')
        .update({
          status: 'completed',
          result: result.products,
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      completedCount++
      console.log(`  ✓ ${result.products.length}개 상품 파싱 완료`)

      if (lowestPrice) {
        const total = (lowestPrice.couponPrice ?? lowestPrice.regularPrice ?? 0) + (lowestPrice.shippingFee ?? 0)
        console.log(`  최저가: ${total.toLocaleString()}원 (신뢰도: ${lowestPrice.clusterSize}/5)`)
      }

    } catch (err: any) {
      console.error(`  ✗ 오류: ${err.message}`)

      // 아이템 실패
      await supabase
        .from('job_items')
        .update({
          status: 'failed',
          error_message: err.message,
          processed_at: new Date().toISOString(),
        })
        .eq('id', item.id)

      results.push({
        modelName: item.model_name,
        products: [],
        error: err.message,
      })

      failedCount++
    }

    // 작업 진행상황 업데이트
    await supabase
      .from('jobs')
      .update({
        completed_models: completedCount,
        failed_models: failedCount,
      })
      .eq('id', job.id)
  }

  // 브라우저 종료
  await browserManager.stop()

  // Excel 생성 및 업로드
  console.log('\nExcel 파일 생성 중...')

  try {
    const exporter = new ExcelExporter()
    const tempDir = '/tmp/gmarket-results'
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    const filename = `gmarket_${job.id}_${Date.now()}.xlsx`
    const filepath = path.join(tempDir, filename)

    // SearchResult에서 Product[] 추출
    const allProducts = results.flatMap(r => r.products)
    await exporter.export(allProducts, filepath)

    // Supabase Storage 업로드
    const fileBuffer = fs.readFileSync(filepath)
    const storagePath = `${job.user_id}/${filename}`

    const { error: uploadError } = await supabase.storage
      .from('results')
      .upload(storagePath, fileBuffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })

    if (uploadError) {
      throw new Error(`업로드 실패: ${uploadError.message}`)
    }

    // 임시 파일 삭제
    fs.unlinkSync(filepath)

    // 작업 완료
    await supabase
      .from('jobs')
      .update({
        status: 'completed',
        result_file_path: storagePath,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id)

    console.log(`✓ 작업 완료: ${completedCount}개 성공, ${failedCount}개 실패`)
    console.log(`  파일: ${storagePath}`)

  } catch (err: any) {
    console.error('Excel 생성/업로드 실패:', err.message)
    await supabase
      .from('jobs')
      .update({
        status: 'failed',
        error_message: `Excel 생성 실패: ${err.message}`,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  }
}

async function pollForJobs(): Promise<void> {
  console.log('G마켓 크롤러 Worker 시작...')
  console.log(`폴링 간격: ${POLL_INTERVAL}ms`)
  console.log('대기중인 작업을 찾는 중...\n')

  while (true) {
    try {
      // pending 상태의 가장 오래된 작업 찾기
      const { data: jobs, error } = await supabase
        .from('jobs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)

      if (error) {
        console.error('작업 조회 오류:', error.message)
      } else if (jobs && jobs.length > 0) {
        await processJob(jobs[0] as Job)
      }
    } catch (err: any) {
      console.error('Worker 오류:', err.message)
    }

    await sleep(POLL_INTERVAL)
  }
}

// Worker 시작
pollForJobs().catch(console.error)
