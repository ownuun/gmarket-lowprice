-- =============================================
-- job_items INSERT 정책 추가 (누락 수정)
-- =============================================

-- 사용자가 자신의 job에 속한 job_items를 생성할 수 있도록 허용
CREATE POLICY "Users can insert own job items" ON job_items
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_items.job_id AND jobs.user_id = auth.uid())
  );

-- 사용자가 자신의 job에 속한 job_items를 업데이트할 수 있도록 허용
CREATE POLICY "Users can update own job items" ON job_items
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_items.job_id AND jobs.user_id = auth.uid())
  );

-- 사용자가 자신의 job에 속한 job_items를 삭제할 수 있도록 허용
CREATE POLICY "Users can delete own job items" ON job_items
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_items.job_id AND jobs.user_id = auth.uid())
  );
