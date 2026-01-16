-- =============================================
-- 크롤러 워커용 RPC 함수
-- =============================================

-- completed_models 증가 함수
CREATE OR REPLACE FUNCTION increment_job_completed(job_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE jobs
  SET completed_models = completed_models + 1
  WHERE id = job_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- failed_models 증가 함수
CREATE OR REPLACE FUNCTION increment_job_failed(job_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE jobs
  SET failed_models = failed_models + 1
  WHERE id = job_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
