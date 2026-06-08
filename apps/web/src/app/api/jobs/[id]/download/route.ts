import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'

const GMARKET_CATEGORY_NAMES: Record<string, string> = {
  '100000076': '공구/안전/산업용품',
  '200000588': '수공구',
  '200001935': '절삭공구',
  '200002888': '철물용품',
  '300009571': '그라인더',
  '300020909': '샌더기',
  '300021319': '기타 철물용품',
  '300025517': '기타 전동공구',
  '300026388': '기타절삭공구',
  '300005952': '렌치/복스/몽키',
  '300027199': '기타수공구',
  '300027200': '에어랜치',
  '300027201': '기타에어/유압공구',
  '300028828': '전동공구 세트',
}

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
    { header: '상품번호', key: 'product_no', width: 14 },
    { header: '모델명', key: 'model_name', width: 15 },
    { header: '구분', key: 'result_type', width: 12 },
    { header: '상품명', key: 'product_name', width: 50 },
    { header: '판매자', key: 'seller', width: 15 },
    { header: '카테고리', key: 'category', width: 55 },
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
  worksheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }

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

  const formatCategoryPart = (name?: string | null, code?: string | null): string | null => {
    const mappedName = code ? GMARKET_CATEGORY_NAMES[code] : null
    if (mappedName) return mappedName
    if (name) return name
    if (code) return code
    return null
  }

  const formatCategory = (product: {
    largeCategoryCode?: string | null
    mediumCategoryCode?: string | null
    smallCategoryCode?: string | null
    largeCategoryName?: string | null
    mediumCategoryName?: string | null
    smallCategoryName?: string | null
  }): string => {
    const parts = [
      formatCategoryPart(product.largeCategoryName, product.largeCategoryCode),
      formatCategoryPart(product.mediumCategoryName, product.mediumCategoryCode),
      formatCategoryPart(product.smallCategoryName, product.smallCategoryCode),
    ].filter((part): part is string => Boolean(part))

    return parts.length > 0 ? parts.join(' > ') : '-'
  }

  const categoryColumn = worksheet.getColumn('category')
  categoryColumn.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }

  const productNameColumn = worksheet.getColumn('product_name')
  productNameColumn.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }

  const urlColumn = worksheet.getColumn('url')
  urlColumn.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }

  const searchUrlColumn = worksheet.getColumn('search_url')
  searchUrlColumn.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }

  // Sort job_items by sequence
  const sortedItems = [...(job.job_items || [])].sort(
    (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence
  )

  type ExportProduct = {
    rank: number
    name: string
    productNo?: string | null
    priceGroupLabel?: string | null
    clusterSourceSeller?: boolean | null
    strategyLabel?: string | null
    originalPrice: number
    discountPrice: number
    discountPercent: number
    shippingFee: number
    totalPrice: number
    seller: string
    largeCategoryCode?: string | null
    mediumCategoryCode?: string | null
    smallCategoryCode?: string | null
    largeCategoryName?: string | null
    mediumCategoryName?: string | null
    smallCategoryName?: string | null
    url: string
    searchUrl: string
    crawledAt: string
  }

  const addProductRow = (item: { model_name: string }, product: ExportProduct, resultType: string) => {
    const category = formatCategory(product)
    maxCategoryLength = Math.max(maxCategoryLength, category.length)

    worksheet.addRow({
      rank: product.rank ?? '-',
      model_name: item.model_name,
      result_type: resultType,
      product_name: product.name,
      product_no: product.productNo || '-',
      seller: product.seller,
      category,
      original_price: formatPrice(product.originalPrice),
      discount_price: formatPrice(product.discountPrice),
      discount_percent: formatPercent(product.discountPercent),
      shipping_fee: formatShipping(product.shippingFee),
      total_price: formatPrice(product.totalPrice),
      url: product.url,
      search_url: product.searchUrl || '-',
      crawled_at: formatDateTime(product.crawledAt),
    })
  }

  const addHorizontalBorder = (weight: 'thin' | 'thick') => {
    const row = worksheet.getRow(worksheet.rowCount)
    row.eachCell((cell) => {
      cell.border = {
        ...cell.border,
        bottom: { style: weight === 'thick' ? 'thick' : 'medium' },
      }
    })
  }

  const applyTableStyle = () => {
    worksheet.eachRow((row) => {
      row.eachCell((cell, columnNumber) => {
        const columnKey = worksheet.getColumn(columnNumber).key
        const isUrlColumn = columnKey === 'url' || columnKey === 'search_url'
        cell.alignment = {
          horizontal: 'center',
          vertical: 'middle',
          wrapText: !isUrlColumn,
          ...cell.alignment,
          ...(isUrlColumn ? { wrapText: false } : {}),
        }
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: cell.border?.bottom ?? { style: 'thin' },
          right: { style: 'thin' },
        }
      })
    })
  }

  const getProductSortPrice = (product: ExportProduct): number => {
    return product.totalPrice ?? Number.MAX_SAFE_INTEGER
  }

  const getClusterSortNumber = (label: string | null | undefined): number => {
    const match = label?.match(/클러스터링(\d+)/)
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
  }

  // Add data rows
  let maxCategoryLength = '카테고리'.length
  for (let i = 0; i < sortedItems.length; i++) {
    const item = sortedItems[i]
    const nextItem = sortedItems[i + 1]
    const isLastOfModel = !nextItem || nextItem.model_name !== item.model_name

    const result = item.result as {
      products?: ExportProduct[]
      sellerClusterProducts?: ExportProduct[]
      strategyProducts?: ExportProduct[]
    } | null

    const baseProducts = result?.products?.length ? result.products : result?.strategyProducts ?? []
    const sellerClusterProducts = result?.sellerClusterProducts ?? []

    if (baseProducts.length > 0 || sellerClusterProducts.length > 0) {
      const sortedClusterProducts = [...sellerClusterProducts].sort((a, b) => {
        const clusterDiff = getClusterSortNumber(a.priceGroupLabel) - getClusterSortNumber(b.priceGroupLabel)
        if (clusterDiff !== 0) return clusterDiff
        if (Boolean(a.clusterSourceSeller) !== Boolean(b.clusterSourceSeller)) {
          return a.clusterSourceSeller ? 1 : -1
        }
        return getProductSortPrice(a) - getProductSortPrice(b)
      })

      const rows = [
        ...baseProducts.map((product) => ({ product, resultType: product.strategyLabel || '최저가' })),
        ...sortedClusterProducts.map((product) => ({
          product,
          resultType: product.priceGroupLabel || '클러스터링',
        })),
      ]

      for (let j = 0; j < rows.length; j++) {
        const row = rows[j]
        const isLastProduct = j === rows.length - 1
        const nextRow = rows[j + 1]
        const isLastOfResultType = !nextRow || nextRow.resultType !== row.resultType
        addProductRow(item, row.product, row.resultType)

        if (isLastOfModel && isLastProduct) {
          addHorizontalBorder('thick')
        } else if (isLastOfResultType) {
          addHorizontalBorder('thin')
        }
      }
    } else {
      // No results for this model
      worksheet.addRow({
        rank: '-',
        model_name: item.model_name,
        result_type: '-',
        product_name: item.status === 'failed' ? item.error_message || '실패' : '결과 없음',
        product_no: '-',
        seller: '-',
        category: '-',
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
        addHorizontalBorder('thick')
      }
    }
  }

  categoryColumn.width = Math.min(Math.max(maxCategoryLength + 4, 24), 80)
  worksheet.columns.forEach((column) => {
    column.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })
  urlColumn.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }
  searchUrlColumn.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }
  applyTableStyle()

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
