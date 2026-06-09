import { type PriceCalcContext, type PriceCalcPlugin, PriceCalcRequestError } from '../types'
import {
  COMPATIBLE_INPUT_POLICY,
  buildCompatiblePriceCalcResult,
  getRequiredCompatibleFiles,
  loadGmarketIndexFromCompletedJob,
  loadGmarketIndexFromExcelFile,
  validateCompatibleInput,
} from './shared'

export const v1PriceCalcPlugin: PriceCalcPlugin = {
  version: 'v1',
  label: 'v1',
  description: '기존 가격 계산',
  inputPolicy: COMPATIBLE_INPUT_POLICY,
  validate: validateCompatibleInput,
  async calculate(context) {
    const files = getRequiredCompatibleFiles(context.files)
    const gmarketInput = await resolveLegacyGmarketInput(context, files.jobId, files.gmarketFile)

    return buildCompatiblePriceCalcResult({
      version: 'v1',
      userId: context.userId,
      playautoFile: files.playautoFile,
      templateFile: files.templateFile,
      gmarketIndex: gmarketInput.index,
      gmarketSource: gmarketInput.source,
      requestedAt: context.requestedAt,
    })
  },
}

async function resolveLegacyGmarketInput(
  context: PriceCalcContext,
  jobId: string | null,
  gmarketFile: File | null
) {
  if (jobId) {
    return loadGmarketIndexFromCompletedJob(context, jobId)
  }

  if (gmarketFile) {
    return loadGmarketIndexFromExcelFile(gmarketFile)
  }

  throw new PriceCalcRequestError('G마켓 데이터가 필요합니다.', 400)
}
