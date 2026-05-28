import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const MAX_LIMIT = 300

export async function GET(request: Request) {
  const supabase = await createClient()
  const { searchParams } = new URL(request.url)
  const limitParam = Number(searchParams.get('limit') ?? '120')
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.floor(limitParam), 1), MAX_LIMIT)
    : 120

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: logs, error } = await supabase
    .from('worker_logs')
    .select('id, job_id, job_item_id, model_name, level, message, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ logs: logs ?? [] })
}
