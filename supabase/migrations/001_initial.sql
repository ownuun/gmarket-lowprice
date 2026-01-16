-- =============================================
-- G마켓 크롤러 웹 서비스 - 초기 스키마
-- =============================================

-- 사용자 프로필 (Supabase Auth 연동)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 크롤링 작업
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  total_models INTEGER NOT NULL,
  completed_models INTEGER DEFAULT 0,
  failed_models INTEGER DEFAULT 0,
  result_file_path TEXT,
  result_format TEXT DEFAULT 'excel',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

-- 작업 아이템 (개별 모델 검색)
CREATE TABLE job_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  error_message TEXT,
  sequence INTEGER NOT NULL,
  processed_at TIMESTAMPTZ
);

-- 인덱스
CREATE INDEX idx_jobs_user_status ON jobs(user_id, status);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_job_items_job ON job_items(job_id, sequence);

-- =============================================
-- RLS (Row Level Security) 정책
-- =============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_items ENABLE ROW LEVEL SECURITY;

-- 프로필: 자신만 접근
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- 작업: 자신만 접근
CREATE POLICY "Users can view own jobs" ON jobs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own jobs" ON jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own jobs" ON jobs
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own jobs" ON jobs
  FOR DELETE USING (auth.uid() = user_id);

-- 작업 아이템: 자신의 작업만 접근
CREATE POLICY "Users can view own job items" ON job_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_items.job_id AND jobs.user_id = auth.uid())
  );

-- =============================================
-- 서비스 역할용 정책 (크롤러 Worker)
-- =============================================

-- 크롤러 Worker는 service_role 키를 사용하므로 RLS 우회

-- =============================================
-- 트리거: 프로필 자동 생성
-- =============================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================
-- Storage 버킷 (결과 파일용)
-- =============================================

-- Storage 버킷은 Supabase 대시보드에서 생성:
-- 1. 버킷 이름: results
-- 2. Public: false
-- 3. File size limit: 50MB
-- 4. Allowed MIME types: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, text/csv
