-- =============================================
-- 가격 계산 작업 이력 테이블
-- =============================================

-- 가격 계산 작업 이력
CREATE TABLE price_calc_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  
  -- 입력 파일 정보
  playauto_filename TEXT NOT NULL,
  template_filename TEXT NOT NULL,
  gmarket_source TEXT NOT NULL, -- 'job:{job_id}' 또는 'file:{filename}'
  
  -- 계산 결과 통계
  matched_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  vps_kept_rows INTEGER NOT NULL DEFAULT 0,
  vps_removed_rows INTEGER NOT NULL DEFAULT 0,
  
  -- 상태
  archived BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 인덱스
CREATE INDEX idx_price_calc_jobs_user ON price_calc_jobs(user_id, archived, created_at DESC);

-- =============================================
-- RLS (Row Level Security) 정책
-- =============================================

ALTER TABLE price_calc_jobs ENABLE ROW LEVEL SECURITY;

-- 가격 계산 작업: 자신만 접근
CREATE POLICY "Users can view own price_calc_jobs" ON price_calc_jobs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own price_calc_jobs" ON price_calc_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own price_calc_jobs" ON price_calc_jobs
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own price_calc_jobs" ON price_calc_jobs
  FOR DELETE USING (auth.uid() = user_id);
