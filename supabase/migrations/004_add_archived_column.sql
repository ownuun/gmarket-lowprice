-- jobs 테이블에 archived 컬럼 추가
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

-- 인덱스 추가 (archived 상태로 필터링 성능 향상)
CREATE INDEX IF NOT EXISTS idx_jobs_archived ON jobs(user_id, archived);
