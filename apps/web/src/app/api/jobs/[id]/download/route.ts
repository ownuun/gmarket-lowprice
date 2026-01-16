import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get job with items
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select(
      `
      *,
      job_items (*)
    `
    )
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  // Create Excel workbook
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('크롤링 결과')

  // Define columns
  worksheet.columns = [
    { header: '모델명', key: 'model_name', width: 30 },
    { header: '상품명', key: 'product_name', width: 50 },
    { header: '정가', key: 'original_price', width: 15 },
    { header: '할인가', key: 'discount_price', width: 15 },
    { header: '배송비', key: 'shipping_fee', width: 12 },
    { header: '총 가격', key: 'total_price', width: 15 },
    { header: '판매자', key: 'seller', width: 20 },
    { header: '링크', key: 'url', width: 60 },
    { header: '상태', key: 'status', width: 10 },
  ]

  // Style header row
  worksheet.getRow(1).font = { bold: true }
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' },
  }

  // Add data rows
  for (const item of job.job_items || []) {
    const result = item.result as {
      products?: Array<{
        name: string
        originalPrice: number
        discountPrice: number
        shippingFee: number
        totalPrice: number
        seller: string
        url: string
      }>
    } | null

    if (result?.products && result.products.length > 0) {
      for (const product of result.products) {
        worksheet.addRow({
          model_name: item.model_name,
          product_name: product.name,
          original_price: product.originalPrice,
          discount_price: product.discountPrice,
          shipping_fee: product.shippingFee,
          total_price: product.totalPrice,
          seller: product.seller,
          url: product.url,
          status: item.status,
        })
      }
    } else {
      // No results for this model
      worksheet.addRow({
        model_name: item.model_name,
        product_name: '-',
        original_price: '-',
        discount_price: '-',
        shipping_fee: '-',
        total_price: '-',
        seller: '-',
        url: '-',
        status: item.status === 'completed' ? '결과 없음' : item.status,
      })
    }
  }

  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer()

  // Return as downloadable file
  const filename = `gmarket_results_${new Date().toISOString().split('T')[0]}.xlsx`

  return new NextResponse(buffer, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
