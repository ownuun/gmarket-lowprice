import type { SupabaseClient } from '@supabase/supabase-js'

export type PriceCalcVersion = 'v1' | 'v2'

export interface PriceCalcFiles {
  playautoFile: File | null
  templateFile: File | null
  jobId: string | null
  gmarketFile: File | null
  slaveFile: File | null
}

export interface PriceCalcContext {
  userId: string
  supabase: SupabaseClient
  files: PriceCalcFiles
  requestedAt: Date
}

export interface PriceCalcMetrics {
  matchedCount: number
  unmatchedCount: number
  vpsKeptRows: number
  vpsRemovedRows: number
}

export interface PriceCalcHistoryInsert {
  user_id: string
  playauto_filename: string
  template_filename: string
  gmarket_source: string
  matched_count: number
  unmatched_count: number
  vps_kept_rows: number
  vps_removed_rows: number
}

export interface PriceCalcResult extends PriceCalcMetrics {
  version: PriceCalcVersion
  bodyBuffer: ArrayBuffer
  downloadFileName: string
  contentType: string
  history: PriceCalcHistoryInsert
}

export interface PriceCalcInputPolicy {
  requiresPlayauto: boolean
  requiresTemplate: boolean
  requiresSlave: boolean
  gmarketSource: 'job-or-file' | 'file' | 'none'
}

export interface PriceCalcPlugin {
  version: PriceCalcVersion
  label: string
  description: string
  inputPolicy: PriceCalcInputPolicy
  validate(files: PriceCalcFiles): string | null
  calculate(context: PriceCalcContext): Promise<PriceCalcResult>
}

export class PriceCalcRequestError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'PriceCalcRequestError'
    this.status = status
  }
}
