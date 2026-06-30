-- =============================================
-- jobs에 marketplace 컬럼 추가 (멀티 마켓 플러그인 지원)
-- 'gmarket' (기본) | 'coupang'
-- 워커가 job.marketplace로 검색 플러그인을 선택한다.
-- =============================================

ALTER TABLE jobs
  ADD COLUMN marketplace TEXT NOT NULL DEFAULT 'gmarket';

-- pending job을 마켓별로 폴링할 때 사용.
CREATE INDEX idx_jobs_marketplace_status ON jobs(marketplace, status);
