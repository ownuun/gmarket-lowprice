import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(jobs)
}

export async function POST(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { models } = body as { models: string[] }

  if (!models || !Array.isArray(models) || models.length === 0) {
    return NextResponse.json(
      { error: 'Models array is required' },
      { status: 400 }
    )
  }

  // Create job
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      user_id: user.id,
      status: 'pending',
      total_models: models.length,
      completed_models: 0,
      failed_models: 0,
    })
    .select()
    .single()

  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 })
  }

  // Create job items
  const jobItems = models.map((model, index) => ({
    job_id: job.id,
    model_name: model.trim(),
    status: 'pending',
    sequence: index + 1,
  }))

  const { error: itemsError } = await supabase
    .from('job_items')
    .insert(jobItems)

  if (itemsError) {
    // Rollback job creation
    await supabase.from('jobs').delete().eq('id', job.id)
    return NextResponse.json({ error: itemsError.message }, { status: 500 })
  }

  return NextResponse.json(job, { status: 201 })
}
