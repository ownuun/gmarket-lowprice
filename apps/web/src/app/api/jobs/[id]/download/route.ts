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

  // Define columns (CLI 형식과 동일)
  worksheet.columns = [
    { header: '순위', key: 'rank', width: 6 },
    { header: '모델명', key: 'model_name', width: 15 },
    { header: '상품명', key: 'product_name', width: 50 },
    { header: '판매자', key: 'seller', width: 15 },
    { header: '정가', key: 'original_price', width: 12 },
    { header: '할인가', key: 'discount_price', width: 12 },
    { header: '할인율', key: 'discount_percent', width: 8 },
    { header: '배송비', key: 'shipping_fee', width: 10 },
    { header: '총가격', key: 'total_price', width: 12 },
    { header: '상품URL', key: 'url', width: 40 },
    { header: '검색URL', key: 'search_url', width: 60 },
    { header: '수집시간', key: 'crawled_at', width: 20 },
  ]

  // Style header row
  worksheet.getRow(1).font = { bold: true }
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' },
  }

  // Helper function for price formatting
  const formatPrice = (price: number | null | undefined): string => {
    if (price === null || price === undefined) return '-'
    return `${price.toLocaleString()}원`
  }

  const formatShipping = (fee: number | null | undefined): string => {
    if (fee === null || fee === undefined) return '-'
    if (fee === 0) return '무료'
    return `${fee.toLocaleString()}원`
  }

  const formatPercent = (percent: number | null | undefined): string => {
    if (percent === null || percent === undefined) return '-'
    return `${percent}%`
  }

  const formatDateTime = (isoString: string | null | undefined): string => {
    if (!isoString) return '-'
    return isoString.slice(0, 19).replace('T', ' ')
  }

  // Sort job_items by sequence
  const sortedItems = [...(job.job_items || [])].sort(
    (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence
  )

  // Add data rows
  for (let i = 0; i < sortedItems.length; i++) {
    const item = sortedItems[i]
    const nextItem = sortedItems[i + 1]
    const isLastOfModel = !nextItem || nextItem.model_name !== item.model_name

    const result = item.result as {
      products?: Array<{
        rank: number
        name: string
        originalPrice: number
        discountPrice: number
        discountPercent: number
        shippingFee: number
        totalPrice: number
        seller: string
        url: string
        searchUrl: string
        crawledAt: string
      }>
    } | null

    if (result?.products && result.products.length > 0) {
      for (let j = 0; j < result.products.length; j++) {
        const product = result.products[j]
        const isLastProduct = j === result.products.length - 1

        worksheet.addRow({
          rank: product.rank ?? '-',
          model_name: item.model_name,
          product_name: product.name,
          seller: product.seller,
          original_price: formatPrice(product.originalPrice),
          discount_price: formatPrice(product.discountPrice),
          discount_percent: formatPercent(product.discountPercent),
          shipping_fee: formatShipping(product.shippingFee),
          total_price: formatPrice(product.totalPrice),
          url: product.url,
          search_url: product.searchUrl || '-',
          crawled_at: formatDateTime(product.crawledAt),
        })

        // Add thick border at the end of each model group
        if (isLastOfModel && isLastProduct) {
          const lastRow = worksheet.getRow(worksheet.rowCount)
          lastRow.eachCell((cell) => {
            cell.border = {
              ...cell.border,
              bottom: { style: 'thick' },
            }
          })
        }
      }
    } else {
      // No results for this model
      worksheet.addRow({
        rank: '-',
        model_name: item.model_name,
        product_name: item.status === 'failed' ? item.error_message || '실패' : '결과 없음',
        seller: '-',
        original_price: '-',
        discount_price: '-',
        discount_percent: '-',
        shipping_fee: '-',
        total_price: '-',
        url: '-',
        search_url: '-',
        crawled_at: '-',
      })

      // Add thick border at the end of each model group
      if (isLastOfModel) {
        const lastRow = worksheet.getRow(worksheet.rowCount)
        lastRow.eachCell((cell) => {
          cell.border = {
            ...cell.border,
            bottom: { style: 'thick' },
          }
        })
      }
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
