import JSZip from 'jszip'
import {
  parsePlayautoExcel,
  parseTemplateExcel,
  parseGmarketExcel,
  generateOutputExcel,
  generateEmpMatchedVps,
} from '../../excel-parser'
import {
  type GmarketIndex,
  type GmarketJobItem,
  type OutputRow,
  buildGmarketIndexFromJobItems,
  buildOutputRows,
} from '../../price-calculator'
import {
  type PriceCalcContext,
  type PriceCalcFiles,
  type PriceCalcHistoryInsert,
  type PriceCalcMetrics,
  type PriceCalcResult,
  type PriceCalcVersion,
  PriceCalcRequestError,
} from '../types'

export interface RequiredCompatibleFiles {
  playautoFile: File
  templateFile: File
  jobId: string | null
  gmarketFile: File | null
}

interface JobStatusRow {
  id: string
  user_id: string
  status: string
}

interface GmarketInputResult {
  index: GmarketIndex
  source: string
}

interface CompatibleCalculationInput {
  version: PriceCalcVersion
  userId: string
  playautoFile: File
  templateFile: File
  gmarketIndex: GmarketIndex
  gmarketSource: string
  requestedAt: Date
}

export const COMPATIBLE_INPUT_POLICY = {
  requiresPlayauto: true,
  requiresTemplate: true,
  gmarketSource: 'job-or-file' as const,
}

export function validateCompatibleInput(files: PriceCalcFiles): string | null {
  if (!files.playautoFile) {
    return '플레이오토 엑셀 파일이 필요합니다.'
  }

  if (!files.templateFile) {
    return '템플릿 엑셀 파일이 필요합니다.'
  }

  if (!files.jobId && !files.gmarketFile) {
    return 'G마켓 데이터가 필요합니다. (크롤링 작업 선택 또는 G마켓 엑셀 업로드)'
  }

  return null
}

export function getRequiredCompatibleFiles(files: PriceCalcFiles): RequiredCompatibleFiles {
  const error = validateCompatibleInput(files)
  if (error) {
    throw new PriceCalcRequestError(error, 400)
  }

  if (!files.playautoFile || !files.templateFile) {
    throw new PriceCalcRequestError('가격 계산에 필요한 파일이 누락되었습니다.', 400)
  }

  return {
    playautoFile: files.playautoFile,
    templateFile: files.templateFile,
    jobId: files.jobId,
    gmarketFile: files.gmarketFile,
  }
}

export async function loadGmarketIndexFromCompletedJob(
  context: PriceCalcContext,
  jobId: string
): Promise<GmarketInputResult> {
  const { data: jobData, error: jobError } = await context.supabase
    .from('jobs')
    .select('id, user_id, status')
    .eq('id', jobId)
    .eq('user_id', context.userId)
    .single()

  const job = jobData as JobStatusRow | null

  if (jobError || !job) {
    throw new PriceCalcRequestError('크롤링 작업을 찾을 수 없습니다.', 404)
  }

  if (job.status !== 'completed') {
    throw new PriceCalcRequestError('크롤링이 완료된 작업만 사용할 수 있습니다.', 400)
  }

  const { data: jobItemsData, error: itemsError } = await context.supabase
    .from('job_items')
    .select('model_name, result')
    .eq('job_id', jobId)

  if (itemsError || !jobItemsData) {
    throw new PriceCalcRequestError('크롤링 결과를 불러올 수 없습니다.', 500)
  }

  const jobItems = jobItemsData as GmarketJobItem[]

  return {
    index: buildGmarketIndexFromJobItems(jobItems),
    source: `job:${jobId}`,
  }
}

export async function loadGmarketIndexFromExcelFile(file: File): Promise<GmarketInputResult> {
  const gmarketBuffer = await file.arrayBuffer()

  return {
    index: await parseGmarketExcel(gmarketBuffer),
    source: `file:${file.name || 'unknown'}`,
  }
}

export async function buildCompatiblePriceCalcResult(
  input: CompatibleCalculationInput
): Promise<PriceCalcResult> {
  const playautoBuffer = await input.playautoFile.arrayBuffer()
  const playautoProducts = await parsePlayautoExcel(playautoBuffer)

  if (playautoProducts.length === 0) {
    throw new PriceCalcRequestError('플레이오토 엑셀에 상품이 없습니다.', 400)
  }

  const templateBuffer = await input.templateFile.arrayBuffer()
  const { rows: templateRows } = await parseTemplateExcel(templateBuffer)

  if (templateRows.length === 0) {
    throw new PriceCalcRequestError('템플릿 엑셀에 쇼핑몰 행이 없습니다.', 400)
  }

  const allOutputRows: OutputRow[] = []
  const matchedMasterCodes = new Set<string>()
  let matchedCount = 0
  let unmatchedCount = 0

  for (const emp of playautoProducts) {
    const recs = input.gmarketIndex[emp.modelNorm]
    if (recs && recs.length > 0) {
      const rows = buildOutputRows(emp, recs, templateRows)
      allOutputRows.push(...rows)
      matchedMasterCodes.add(emp.master)
      matchedCount++
    } else {
      unmatchedCount++
    }
  }

  if (allOutputRows.length === 0) {
    throw new PriceCalcRequestError('G마켓 가격 매칭 결과가 없습니다. 모델명을 확인해주세요.', 400)
  }

  const outputBuffer = await generateOutputExcel(templateBuffer, allOutputRows)
  const vpsResult = await generateEmpMatchedVps(playautoBuffer, matchedMasterCodes)

  const dateStr = input.requestedAt.toISOString().split('T')[0]
  const zip = new JSZip()
  zip.file(`옥지11SSG_자동채움_${dateStr}.xlsx`, outputBuffer)
  zip.file(`EMP_매칭된것만(VPS)_${dateStr}.xlsx`, vpsResult.buffer)

  const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' })
  const metrics: PriceCalcMetrics = {
    matchedCount,
    unmatchedCount,
    vpsKeptRows: vpsResult.keptRows,
    vpsRemovedRows: vpsResult.removedRows,
  }
  const history: PriceCalcHistoryInsert = {
    user_id: input.userId,
    playauto_filename: input.playautoFile.name,
    template_filename: input.templateFile.name,
    gmarket_source: input.gmarketSource,
    matched_count: metrics.matchedCount,
    unmatched_count: metrics.unmatchedCount,
    vps_kept_rows: metrics.vpsKeptRows,
    vps_removed_rows: metrics.vpsRemovedRows,
  }

  return {
    version: input.version,
    zipBuffer,
    zipFileName: `가격계산_${dateStr}.zip`,
    history,
    ...metrics,
  }
}
