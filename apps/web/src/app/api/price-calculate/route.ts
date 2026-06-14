import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getPriceCalcPlugin, parsePriceCalcVersion } from '@/lib/price-calc/registry'
import { PriceCalcRequestError } from '@/lib/price-calc/types'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: '인증이 필요합니다.' }, { status: 401 })
    }

    const formData = await request.formData()
    const version = parsePriceCalcVersion(formData.get('version') ?? formData.get('plugin'))

    if (!version) {
      return NextResponse.json({ error: '지원하지 않는 가격 계산 버전입니다.' }, { status: 400 })
    }

    const plugin = getPriceCalcPlugin(version)
    const files = {
      playautoFile: getFile(formData, 'playauto'),
      templateFile: getFile(formData, 'template'),
      jobId: getString(formData, 'jobId'),
      gmarketFile: getFile(formData, 'gmarket'),
    }

    const validationError = plugin.validate(files)
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const result = await plugin.calculate({
      userId: user.id,
      supabase,
      files,
      requestedAt: new Date(),
    })

    await supabase.from('price_calc_jobs').insert(result.history)

    return new Response(result.bodyBuffer, {
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(result.downloadFileName)}"`,
        'X-Matched-Count': result.matchedCount.toString(),
        'X-Unmatched-Count': result.unmatchedCount.toString(),
        'X-VPS-Kept-Rows': result.vpsKeptRows.toString(),
        'X-VPS-Removed-Rows': result.vpsRemovedRows.toString(),
      },
    })
  } catch (error) {
    console.error('가격 계산 오류:', error)
    const message = error instanceof Error ? error.message : '알 수 없는 오류'
    const status = error instanceof PriceCalcRequestError ? error.status : 500
    return NextResponse.json({ error: message }, { status })
  }
}

function getFile(formData: FormData, key: string): File | null {
  const value = formData.get(key)
  return value instanceof File ? value : null
}

function getString(formData: FormData, key: string): string | null {
  const value = formData.get(key)
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
