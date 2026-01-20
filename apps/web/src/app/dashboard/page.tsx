'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
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

type MainTab = 'crawling' | 'price-calc'
type JobListTab = 'active' | 'archived'

export default function DashboardPage() {
  const [mainTab, setMainTab] = useState<MainTab>('crawling')
  const [models, setModels] = useState('')
  const [loading, setLoading] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [archivedJobs, setArchivedJobs] = useState<Job[]>([])
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [jobListTab, setJobListTab] = useState<JobListTab>('active')
  const [actionLoading, setActionLoading] = useState<{ [key: string]: 'archive' | 'delete' | null }>({})

  const [playautoFile, setPlayautoFile] = useState<File | null>(null)
  const [templateFile, setTemplateFile] = useState<File | null>(null)
  const [gmarketFile, setGmarketFile] = useState<File | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string>('')
  const [gmarketSource, setGmarketSource] = useState<'job' | 'file'>('file')
  const [calcLoading, setCalcLoading] = useState(false)
  const [calcResult, setCalcResult] = useState<{ matched: number; unmatched: number } | null>(null)
  const [calcError, setCalcError] = useState<string | null>(null)

  const playautoInputRef = useRef<HTMLInputElement>(null)
  const templateInputRef = useRef<HTMLInputElement>(null)
  const gmarketInputRef = useRef<HTMLInputElement>(null)

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

    const interval = setInterval(() => {
      fetchJobs()
      if (jobListTab === 'archived') {
        fetchArchivedJobs()
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [jobListTab])

  useEffect(() => {
    if (mainTab === 'crawling') {
      setPlayautoFile(null)
      setTemplateFile(null)
      setGmarketFile(null)
      setSelectedJobId('')
      setCalcResult(null)
      setCalcError(null)
      if (playautoInputRef.current) playautoInputRef.current.value = ''
      if (templateInputRef.current) templateInputRef.current.value = ''
      if (gmarketInputRef.current) gmarketInputRef.current.value = ''
    }
  }, [mainTab])

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
      case 'processing': return '진행중'
      case 'completed': return '완료'
      case 'failed': return '실패'
      default: return status
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'text-yellow-600'
      case 'processing': return 'text-blue-600'
      case 'completed': return 'text-green-600'
      case 'failed': return 'text-red-600'
      default: return ''
    }
  }

  const handleDelete = async (jobId: string) => {
    if (!confirm('이 작업을 삭제하시겠습니까?')) return

    setActionLoading((prev) => ({ ...prev, [jobId]: 'delete' }))

    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'DELETE',
    })

    if (res.ok) {
      setJobs((prev) => prev.filter((j) => j.id !== jobId))
      setArchivedJobs((prev) => prev.filter((j) => j.id !== jobId))
    } else {
      fetchJobs()
      fetchArchivedJobs()
    }

    setActionLoading((prev) => ({ ...prev, [jobId]: null }))
  }

  const handleArchive = async (jobId: string, archive: boolean) => {
    setActionLoading((prev) => ({ ...prev, [jobId]: 'archive' }))

    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: archive }),
    })

    if (res.ok) {
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
    } else {
      fetchJobs()
      fetchArchivedJobs()
    }

    setActionLoading((prev) => ({ ...prev, [jobId]: null }))
  }

  const handlePriceCalc = async (e: React.FormEvent) => {
    e.preventDefault()
    setCalcError(null)
    setCalcResult(null)

    if (!playautoFile) {
      setCalcError('플레이오토 엑셀 파일을 선택해주세요.')
      return
    }

    if (!templateFile) {
      setCalcError('템플릿 엑셀 파일을 선택해주세요.')
      return
    }

    if (gmarketSource === 'job' && !selectedJobId) {
      setCalcError('크롤링 작업을 선택해주세요.')
      return
    }

    if (gmarketSource === 'file' && !gmarketFile) {
      setCalcError('G마켓 엑셀 파일을 업로드해주세요.')
      return
    }

    setCalcLoading(true)

    try {
      const formData = new FormData()
      formData.append('playauto', playautoFile)
      formData.append('template', templateFile)
      if (gmarketSource === 'job' && selectedJobId) {
        formData.append('jobId', selectedJobId)
      }
      if (gmarketSource === 'file' && gmarketFile) {
        formData.append('gmarket', gmarketFile)
      }

      const res = await fetch('/api/price-calculate', {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || '가격 계산 실패')
      }

      const matched = parseInt(res.headers.get('X-Matched-Count') || '0', 10)
      const unmatched = parseInt(res.headers.get('X-Unmatched-Count') || '0', 10)
      setCalcResult({ matched, unmatched })

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `가격계산_${new Date().toISOString().split('T')[0]}.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : '알 수 없는 오류')
    } finally {
      setCalcLoading(false)
    }
  }

  const completedJobs = jobs.filter((j) => j.status === 'completed')
  const currentJobs = jobListTab === 'active' ? jobs : archivedJobs

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

        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setMainTab('crawling')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              mainTab === 'crawling'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted hover:bg-muted/80'
            }`}
          >
            크롤링
          </button>
          <button
            onClick={() => setMainTab('price-calc')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              mainTab === 'price-calc'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted hover:bg-muted/80'
            }`}
          >
            가격 계산
          </button>
        </div>

        {mainTab === 'crawling' && (
          <>
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
                      onClick={() => setJobListTab('active')}
                      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                        jobListTab === 'active'
                          ? 'bg-background shadow-sm font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      활성 ({jobs.length})
                    </button>
                    <button
                      onClick={() => {
                        setJobListTab('archived')
                        fetchArchivedJobs()
                      }}
                      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                        jobListTab === 'archived'
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
                    {jobListTab === 'active' ? '작업이 없습니다' : '보관된 작업이 없습니다'}
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
                          {jobListTab === 'active' ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!!actionLoading[job.id]}
                              onClick={() => handleArchive(job.id, true)}
                            >
                              {actionLoading[job.id] === 'archive' ? '보관중...' : '보관'}
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!!actionLoading[job.id]}
                              onClick={() => handleArchive(job.id, false)}
                            >
                              {actionLoading[job.id] === 'archive' ? '복원중...' : '복원'}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:text-red-700 hover:bg-red-50"
                            disabled={!!actionLoading[job.id]}
                            onClick={() => handleDelete(job.id)}
                          >
                            {actionLoading[job.id] === 'delete' ? '삭제중...' : '삭제'}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {mainTab === 'price-calc' && (
          <Card>
            <CardHeader>
              <CardTitle>가격 계산</CardTitle>
              <CardDescription>
                플레이오토 상품 목록과 G마켓 가격을 기반으로 멀티채널 판매가를 자동 계산합니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handlePriceCalc} className="space-y-4">
                <div className={`p-4 rounded-lg border-2 transition-colors ${playautoFile ? 'border-green-500 bg-green-50/50' : 'border-dashed border-muted-foreground/25 bg-muted/30'}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${playautoFile ? 'bg-green-500 text-white' : 'bg-muted-foreground/20 text-muted-foreground'}`}>1</div>
                    <Label className="text-base font-semibold">플레이오토 엑셀</Label>
                    {playautoFile && <span className="text-green-600 text-sm">✓</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">상품 목록 (업체상품코드, 모델명, 상품명, 한줄메모)</p>
                  <input
                    ref={playautoInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => setPlayautoFile(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 justify-start font-normal"
                      onClick={() => playautoInputRef.current?.click()}
                    >
                      {playautoFile ? playautoFile.name : '파일 선택...'}
                    </Button>
                    {playautoFile && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setPlayautoFile(null)
                          if (playautoInputRef.current) playautoInputRef.current.value = ''
                        }}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                </div>

                <div className={`p-4 rounded-lg border-2 transition-colors ${(gmarketSource === 'file' && gmarketFile) || (gmarketSource === 'job' && selectedJobId) ? 'border-green-500 bg-green-50/50' : 'border-dashed border-muted-foreground/25 bg-muted/30'}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${(gmarketSource === 'file' && gmarketFile) || (gmarketSource === 'job' && selectedJobId) ? 'bg-green-500 text-white' : 'bg-muted-foreground/20 text-muted-foreground'}`}>2</div>
                    <Label className="text-base font-semibold">G마켓 가격 데이터</Label>
                    {((gmarketSource === 'file' && gmarketFile) || (gmarketSource === 'job' && selectedJobId)) && <span className="text-green-600 text-sm">✓</span>}
                  </div>
                  <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit mb-3">
                    <button
                      type="button"
                      onClick={() => {
                        setGmarketSource('file')
                        setSelectedJobId('')
                      }}
                      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                        gmarketSource === 'file'
                          ? 'bg-background shadow-sm font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      엑셀 업로드
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGmarketSource('job')
                        setGmarketFile(null)
                        if (gmarketInputRef.current) gmarketInputRef.current.value = ''
                      }}
                      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                        gmarketSource === 'job'
                          ? 'bg-background shadow-sm font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      크롤링 결과
                    </button>
                  </div>

                  {gmarketSource === 'file' ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground mb-2">
                        필수 컬럼: 모델명, 판매자, 정가, 할인율
                      </p>
                      <input
                        ref={gmarketInputRef}
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={(e) => setGmarketFile(e.target.files?.[0] || null)}
                        className="hidden"
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="flex-1 justify-start font-normal"
                          onClick={() => gmarketInputRef.current?.click()}
                        >
                          {gmarketFile ? gmarketFile.name : '파일 선택...'}
                        </Button>
                        {gmarketFile && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setGmarketFile(null)
                              if (gmarketInputRef.current) gmarketInputRef.current.value = ''
                            }}
                          >
                            ✕
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {completedJobs.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-3 text-center border rounded-md bg-background">
                          완료된 크롤링 작업이 없습니다.
                        </p>
                      ) : (
                        <select
                          value={selectedJobId}
                          onChange={(e) => setSelectedJobId(e.target.value)}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">작업을 선택하세요</option>
                          {completedJobs.map((job) => (
                            <option key={job.id} value={job.id}>
                              {new Date(job.created_at).toLocaleString('ko-KR')} ({job.total_models}개 모델)
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>

                <div className={`p-4 rounded-lg border-2 transition-colors ${templateFile ? 'border-green-500 bg-green-50/50' : 'border-dashed border-muted-foreground/25 bg-muted/30'}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${templateFile ? 'bg-green-500 text-white' : 'bg-muted-foreground/20 text-muted-foreground'}`}>3</div>
                    <Label className="text-base font-semibold">템플릿 엑셀</Label>
                    {templateFile && <span className="text-green-600 text-sm">✓</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">쇼핑몰별 양식 (마스터상품코드, 쇼핑몰코드, 쇼핑몰ID, 판매가)</p>
                  <input
                    ref={templateInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => setTemplateFile(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 justify-start font-normal"
                      onClick={() => templateInputRef.current?.click()}
                    >
                      {templateFile ? templateFile.name : '파일 선택...'}
                    </Button>
                    {templateFile && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTemplateFile(null)
                          if (templateInputRef.current) templateInputRef.current.value = ''
                        }}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                </div>

                {calcError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                    {calcError}
                  </div>
                )}

                {calcResult && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-md text-green-700 text-sm">
                    가격 계산 완료! 매칭: {calcResult.matched}개, 미매칭: {calcResult.unmatched}개
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={
                    calcLoading ||
                    !playautoFile ||
                    !templateFile ||
                    (gmarketSource === 'job' && !selectedJobId) ||
                    (gmarketSource === 'file' && !gmarketFile)
                  }
                  className="w-full"
                >
                  {calcLoading ? '계산 중...' : '가격 계산 및 다운로드'}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  )
}
