import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  type GmarketIndex,
  type GmarketRecord,
  normModel,
  buildOutputRows,
  buildGmarketIndexFromJobItems,
} from '@/lib/price-calculator'
import {
  parsePlayautoExcel,
  parseTemplateExcel,
  generateOutputExcel,
} from '@/lib/excel-parser'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await request.formData()
    const playautoFile = formData.get('playauto') as File | null
    const templateFile = formData.get('template') as File | null
    const jobId = formData.get('jobId') as string | null
    const gmarketFile = formData.get('gmarket') as File | null

    if (!playautoFile) {
      return NextResponse.json({ error: '플레이오토 엑셀 파일이 필요합니다.' }, { status: 400 })
    }

    if (!templateFile) {
      return NextResponse.json({ error: '템플릿 엑셀 파일이 필요합니다.' }, { status: 400 })
    }

    if (!jobId && !gmarketFile) {
      return NextResponse.json(
        { error: 'G마켓 데이터가 필요합니다. (크롤링 작업 선택 또는 G마켓 엑셀 업로드)' },
        { status: 400 }
      )
    }

    const playautoBuffer = await playautoFile.arrayBuffer()
    const playautoProducts = await parsePlayautoExcel(playautoBuffer)

    if (playautoProducts.length === 0) {
      return NextResponse.json({ error: '플레이오토 엑셀에 상품이 없습니다.' }, { status: 400 })
    }

    let gmarketIndex: GmarketIndex

    if (jobId) {
      const { data: job, error: jobError } = await supabase
        .from('jobs')
        .select('id, user_id, status')
        .eq('id', jobId)
        .eq('user_id', user.id)
        .single()

      if (jobError || !job) {
        return NextResponse.json({ error: '크롤링 작업을 찾을 수 없습니다.' }, { status: 404 })
      }

      if (job.status !== 'completed') {
        return NextResponse.json({ error: '크롤링이 완료된 작업만 사용할 수 있습니다.' }, { status: 400 })
      }

      const { data: jobItems, error: itemsError } = await supabase
        .from('job_items')
        .select('model_name, result')
        .eq('job_id', jobId)

      if (itemsError || !jobItems) {
        return NextResponse.json({ error: '크롤링 결과를 불러올 수 없습니다.' }, { status: 500 })
      }

      gmarketIndex = buildGmarketIndexFromJobItems(jobItems)
    } else if (gmarketFile) {
      const gmarketBuffer = await gmarketFile.arrayBuffer()
      gmarketIndex = await parseGmarketExcel(gmarketBuffer)
    } else {
      return NextResponse.json({ error: 'G마켓 데이터가 필요합니다.' }, { status: 400 })
    }

    const templateBuffer = await templateFile.arrayBuffer()
    const { rows: templateRows } = await parseTemplateExcel(templateBuffer)

    if (templateRows.length === 0) {
      return NextResponse.json({ error: '템플릿 엑셀에 쇼핑몰 행이 없습니다.' }, { status: 400 })
    }

    const allOutputRows: import('@/lib/price-calculator').OutputRow[] = []
    let matchedCount = 0
    let unmatchedCount = 0

    for (const emp of playautoProducts) {
      const recs = gmarketIndex[emp.modelNorm]
      if (recs && recs.length > 0) {
        const rows = buildOutputRows(emp, recs, templateRows)
        allOutputRows.push(...rows)
        matchedCount++
      } else {
        unmatchedCount++
      }
    }

    if (allOutputRows.length === 0) {
      return NextResponse.json(
        { error: 'G마켓 가격 매칭 결과가 없습니다. 모델명을 확인해주세요.' },
        { status: 400 }
      )
    }

    const outputBuffer = await generateOutputExcel(templateBuffer, allOutputRows)

    const filename = `가격계산_${new Date().toISOString().split('T')[0]}.xlsx`

    return new NextResponse(new Uint8Array(outputBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'X-Matched-Count': matchedCount.toString(),
        'X-Unmatched-Count': unmatchedCount.toString(),
      },
    })
  } catch (error) {
    console.error('가격 계산 오류:', error)
    const message = error instanceof Error ? error.message : '알 수 없는 오류'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function parseGmarketExcel(buffer: ArrayBuffer): Promise<GmarketIndex> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const ws = workbook.worksheets[0]

  const headerMap: Record<string, number> = {}
  const headerRow = ws.getRow(1)
  headerRow.eachCell((cell, colNumber) => {
    const val = cell.value?.toString().trim()
    if (val && !headerMap[val]) {
      headerMap[val] = colNumber
    }
  })

  const required = ['모델명', '판매자', '정가', '할인율']
  const missing = required.filter((k) => !headerMap[k])
  if (missing.length > 0) {
    throw new Error(`G마켓 엑셀에 필수 컬럼 누락: ${missing.join(', ')}`)
  }

  const index: GmarketIndex = {}

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return

    const modelRaw = row.getCell(headerMap['모델명']).value?.toString() || ''
    const modelNorm = normModel(modelRaw)
    if (!modelNorm) return

    const priceRaw = row.getCell(headerMap['정가']).value
    let price: number | null = null
    if (typeof priceRaw === 'number') {
      price = Math.round(priceRaw)
    } else if (priceRaw) {
      const s = priceRaw.toString().replace(/[^0-9]/g, '')
      price = s ? parseInt(s, 10) : null
    }
    if (price === null) return

    const seller = row.getCell(headerMap['판매자']).value?.toString().trim() || ''

    const discRaw = row.getCell(headerMap['할인율']).value
    let discount: number | null = null
    if (typeof discRaw === 'number') {
      discount = Math.round(discRaw)
    } else if (discRaw) {
      const s = discRaw.toString().replace(/[^0-9]/g, '')
      discount = s ? parseInt(s, 10) : null
    }

    const rec: GmarketRecord = { seller, price, discount }
    if (!index[modelNorm]) {
      index[modelNorm] = []
    }
    index[modelNorm].push(rec)
  })

  return index
}
