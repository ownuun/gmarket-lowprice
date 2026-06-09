import { type PriceCalcPlugin, type PriceCalcVersion } from './types'
import { v1PriceCalcPlugin } from './plugins/v1'
import { v2PriceCalcPlugin } from './plugins/v2'

const PRICE_CALC_PLUGINS = {
  v1: v1PriceCalcPlugin,
  v2: v2PriceCalcPlugin,
} satisfies Record<PriceCalcVersion, PriceCalcPlugin>

export function getPriceCalcPlugin(version: PriceCalcVersion): PriceCalcPlugin {
  return PRICE_CALC_PLUGINS[version]
}

export function parsePriceCalcVersion(value: FormDataEntryValue | null): PriceCalcVersion | null {
  if (value === null) return 'v1'
  if (typeof value !== 'string') return null

  const normalized = value.trim().toLowerCase()
  if (!normalized) return 'v1'
  if (normalized === 'v1' || normalized === 'v2') return normalized

  return null
}
