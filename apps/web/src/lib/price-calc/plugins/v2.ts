import { type PriceCalcContext, type PriceCalcFiles, type PriceCalcPlugin, PriceCalcRequestError } from '../types'
import {
  COMPATIBLE_INPUT_POLICY,
  buildCompatiblePriceCalcResult,
  getRequiredCompatibleFiles,
  loadGmarketIndexFromCompletedJob,
  loadGmarketIndexFromExcelFile,
  validateCompatibleInput,
} from './shared'

export const v2PriceCalcPlugin: PriceCalcPlugin = {
  version: 'v2',
  label: 'v2',
  description: '크롤링 결과 기반 신규 계산(초기 버전)',
  inputPolicy: COMPATIBLE_INPUT_POLICY,
  validate: validateV2Input,
  async calculate(context) {
    const files = getRequiredCompatibleFiles(context.files)
    const gmarketInput = await resolveCrawlingFirstGmarketInput(context, files.jobId, files.gmarketFile)

    return buildCompatiblePriceCalcResult({
      version: 'v2',
      userId: context.userId,
      playautoFile: files.playautoFile,
      templateFile: files.templateFile,
      gmarketIndex: gmarketInput.index,
      gmarketSource: gmarketInput.source,
      requestedAt: context.requestedAt,
    })
  },
}

function validateV2Input(files: PriceCalcFiles): string | null {
  // 초기 v2는 v1과 같은 안전한 필수 입력을 유지한다.
  // 이후 v2 전용 입력 요구사항이 생기면 이 함수와 inputPolicy만 확장한다.
  return validateCompatibleInput(files)
}

async function resolveCrawlingFirstGmarketInput(
  context: PriceCalcContext,
  jobId: string | null,
  gmarketFile: File | null
) {
  if (jobId) {
    return loadJobBackedGmarketIndexForV2(context, jobId)
  }

  if (gmarketFile) {
    return loadGmarketIndexFromExcelFile(gmarketFile)
  }

  throw new PriceCalcRequestError('G마켓 데이터가 필요합니다.', 400)
}

async function loadJobBackedGmarketIndexForV2(context: PriceCalcContext, jobId: string) {
  // v2 확장 지점: 상세페이지 방문 없이 DB job_items.result.products 기반 품질/우선순위 로직을 여기에 추가한다.
  return loadGmarketIndexFromCompletedJob(context, jobId)
}
