'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'

interface Job {
  id: string
  status: string
  total_models: number
  completed_models: number
  failed_models: number
  created_at: string
  completed_at: string | null
  archived: boolean
}

type TabType = 'active' | 'archived'

export default function DashboardPage() {
  const [models, setModels] = useState('')
  const [loading, setLoading] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [archivedJobs, setArchivedJobs] = useState<Job[]>([])
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabType>('active')
  const supabase = createClient()

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setUserEmail(user.email ?? null)
      }
    }
    getUser()
    fetchJobs()
    fetchArchivedJobs()

    // 5초마다 작업 상태 갱신
    const interval = setInterval(() => {
      fetchJobs()
      if (activeTab === 'archived') {
        fetchArchivedJobs()
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [activeTab])

  const fetchJobs = async () => {
    const res = await fetch('/api/jobs?archived=false')
    if (res.ok) {
      const data = await res.json()
      setJobs(Array.isArray(data) ? data : [])
    }
  }

  const fetchArchivedJobs = async () => {
    const res = await fetch('/api/jobs?archived=true')
    if (res.ok) {
      const data = await res.json()
      setArchivedJobs(Array.isArray(data) ? data : [])
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!models.trim()) return

    setLoading(true)

    // 모델명 파싱 (줄바꿈, 쉼표로 구분)
    const modelList = models
      .split(/[\n,]/)
      .map(m => m.trim())
      .filter(m => m.length > 0)

    if (modelList.length === 0) {
      setLoading(false)
      return
    }

    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: modelList }),
    })

    if (res.ok) {
      setModels('')
      fetchJobs()
    }

    setLoading(false)
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending': return '대기중'
      case 'running': return '진행중'
      case 'completed': return '완료'
      case 'failed': return '실패'
      default: return status
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'text-yellow-600'
      case 'running': return 'text-blue-600'
      case 'completed': return 'text-green-600'
      case 'failed': return 'text-red-600'
      default: return ''
    }
  }

  const handleDelete = async (jobId: string) => {
    if (!confirm('이 작업을 삭제하시겠습니까?')) return

    // Optimistic update - 즉시 UI에서 제거
    setJobs((prev) => prev.filter((j) => j.id !== jobId))
    setArchivedJobs((prev) => prev.filter((j) => j.id !== jobId))

    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'DELETE',
    })

    if (!res.ok) {
      // 실패시 다시 가져오기
      fetchJobs()
      fetchArchivedJobs()
    }
  }

  const handleArchive = async (jobId: string, archive: boolean) => {
    // Optimistic update - 즉시 UI 업데이트
    if (archive) {
      const job = jobs.find((j) => j.id === jobId)
      if (job) {
        setJobs((prev) => prev.filter((j) => j.id !== jobId))
        setArchivedJobs((prev) => [{ ...job, archived: true }, ...prev])
      }
    } else {
      const job = archivedJobs.find((j) => j.id === jobId)
      if (job) {
        setArchivedJobs((prev) => prev.filter((j) => j.id !== jobId))
        setJobs((prev) => [{ ...job, archived: false }, ...prev])
      }
    }

    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: archive }),
    })

    if (!res.ok) {
      // 실패시 다시 가져오기
      fetchJobs()
      fetchArchivedJobs()
    }
  }

  const currentJobs = activeTab === 'active' ? jobs : archivedJobs

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-2xl font-bold">G마켓 최저가 크롤러</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{userEmail}</span>
            <form action={signOut}>
              <Button variant="outline" size="sm" type="submit">
                로그아웃
              </Button>
            </form>
          </div>
        </div>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>새 작업 생성</CardTitle>
            <CardDescription>
              검색할 모델명을 입력하세요 (줄바꿈 또는 쉼표로 구분)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="models">모델명</Label>
                <Textarea
                  id="models"
                  value={models}
                  onChange={(e) => setModels(e.target.value)}
                  placeholder="CM-608M2&#10;IS-415M&#10;IS-425M"
                  className="min-h-[150px] font-mono"
                />
              </div>
              <Button type="submit" disabled={loading || !models.trim()}>
                {loading ? '작업 생성 중...' : '크롤링 시작'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>작업 목록</CardTitle>
              <div className="flex gap-1 bg-muted p-1 rounded-lg">
                <button
                  onClick={() => setActiveTab('active')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    activeTab === 'active'
                      ? 'bg-background shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  활성 ({jobs.length})
                </button>
                <button
                  onClick={() => {
                    setActiveTab('archived')
                    fetchArchivedJobs()
                  }}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    activeTab === 'archived'
                      ? 'bg-background shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  보관함 ({archivedJobs.length})
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {currentJobs.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                {activeTab === 'active' ? '작업이 없습니다' : '보관된 작업이 없습니다'}
              </p>
            ) : (
              <div className="space-y-4">
                {currentJobs.map((job) => (
                  <div key={job.id} className="border rounded-lg p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <span className={`font-medium ${getStatusColor(job.status)}`}>
                          {getStatusText(job.status)}
                        </span>
                        <span className="text-sm text-muted-foreground ml-2">
                          {job.completed_models}/{job.total_models}개 완료
                          {job.failed_models > 0 && (
                            <span className="text-red-500 ml-1">
                              ({job.failed_models}개 실패)
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {new Date(job.created_at).toLocaleString('ko-KR')}
                      </div>
                    </div>
                    <Progress
                      value={((job.completed_models + job.failed_models) / job.total_models) * 100}
                      className="h-2 mb-3"
                    />
                    <div className="flex gap-2">
                      {job.status === 'completed' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`/api/jobs/${job.id}/download`, '_blank')}
                        >
                          엑셀 다운로드
                        </Button>
                      )}
                      {activeTab === 'active' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleArchive(job.id, true)}
                        >
                          보관
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleArchive(job.id, false)}
                        >
                          복원
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        onClick={() => handleDelete(job.id)}
                      >
                        삭제
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
