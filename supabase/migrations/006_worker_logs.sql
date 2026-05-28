-- =============================================
-- 워커 로그 저장 테이블
-- =============================================

CREATE TABLE worker_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_item_id UUID REFERENCES job_items(id) ON DELETE SET NULL,
  model_name TEXT,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warn', 'error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_worker_logs_job_created ON worker_logs(job_id, created_at DESC);
CREATE INDEX idx_worker_logs_created ON worker_logs(created_at DESC);

ALTER TABLE worker_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own worker logs" ON worker_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM jobs
      WHERE jobs.id = worker_logs.job_id
        AND jobs.user_id = auth.uid()
    )
  );
