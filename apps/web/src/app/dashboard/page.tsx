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

interface PriceCalcJob {
  id: string
  playauto_filename: string
  template_filename: string
  gmarket_source: string
  matched_count: number
  unmatched_count: number
  vps_kept_rows: number
  vps_removed_rows: number
  archived: boolean
  created_at: string
}

interface WorkerLog {
  id: string
  job_id: string | null
  model_name: string | null
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
  created_at: string
}

type MainTab = 'crawling' | 'price-calc'
type JobListTab = 'active' | 'archived'
type PriceCalcVersion = 'v1' | 'v2'

const LOG_LEVEL_STYLES: Record<
  WorkerLog['level'],
  { pill: string; border: string; label: string }
> = {
  info: { pill: 'bg-blue-100 text-blue-700', border: 'border-blue-300', label: '정보' },
  success: { pill: 'bg-green-100 text-green-700', border: 'border-green-300', label: '완료' },
  warn: { pill: 'bg-amber-100 text-amber-700', border: 'border-amber-300', label: '주의' },
  error: { pill: 'bg-red-100 text-red-700', border: 'border-red-300', label: '오류' },
}

const formatLogTime = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('ko-KR', { hour12: false })
}

const getDownloadFileName = (response: Response, isV2: boolean) => {
  const fallback = `가격계산${isV2 ? '_v2' : ''}_${new Date().toISOString().split('T')[0]}.zip`
  const disposition = response.headers.get('Content-Disposition')
  const match = disposition?.match(/filename="?([^";]+)"?/)
  if (!match?.[1]) return fallback

  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

export default function DashboardPage() {
  const [mainTab, setMainTab] = useState<MainTab>('crawling')
  const [models, setModels] = useState('')
  const [marketplace, setMarketplace] = useState<'gmarket' | 'coupang'>('gmarket')
  const [loading, setLoading] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [archivedJobs, setArchivedJobs] = useState<Job[]>([])
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [jobListTab, setJobListTab] = useState<JobListTab>('active')
  const [actionLoading, setActionLoading] = useState<{ [key: string]: 'archive' | 'delete' | null }>({})

  const [playautoFile, setPlayautoFile] = useState<File | null>(null)
  const [templateFile, setTemplateFile] = useState<File | null>(null)
  const [gmarketFile, setGmarketFile] = useState<File | null>(null)
  const [slaveFile, setSlaveFile] = useState<File | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string>('')
  const [gmarketSource, setGmarketSource] = useState<'job' | 'file'>('file')
  const [priceCalcVersion, setPriceCalcVersion] = useState<PriceCalcVersion>('v2')
  const [calcLoading, setCalcLoading] = useState(false)
  const [calcResult, setCalcResult] = useState<{ matched: number; unmatched: number; vpsKept: number; vpsRemoved: number } | null>(null)
  const [calcError, setCalcError] = useState<string | null>(null)

  const [priceCalcJobs, setPriceCalcJobs] = useState<PriceCalcJob[]>([])
  const [archivedPriceCalcJobs, setArchivedPriceCalcJobs] = useState<PriceCalcJob[]>([])
  const [priceCalcJobListTab, setPriceCalcJobListTab] = useState<JobListTab>('active')
  const [priceCalcActionLoading, setPriceCalcActionLoading] = useState<{ [key: string]: 'archive' | 'delete' | null }>({})

  const [workerLogs, setWorkerLogs] = useState<WorkerLog[]>([])

  const playautoInputRef = useRef<HTMLInputElement>(null)
  const templateInputRef = useRef<HTMLInputElement>(null)
  const gmarketInputRef = useRef<HTMLInputElement>(null)
  const slaveInputRef = useRef<HTMLInputElement>(null)

  // 드래그앤드롭으로 강조 중인 박스 키 (박스별로 구분)
  const [dragActiveKey, setDragActiveKey] = useState<string | null>(null)

  const supabase = createClient()
  const isV2PriceCalc = priceCalcVersion === 'v2'
  const primaryFileLabel = isV2PriceCalc ? '플토 엑셀' : '플레이오토 엑셀'
  const primaryFileHelp = isV2PriceCalc
    ? '쇼핑몰상품 시트를 포함한 플토 양식 (모델명, 판매가, 바코드)'
    : '상품 목록 (업체상품코드, 모델명, 상품명, 한줄메모)'
  const gmarketFileLabel = isV2PriceCalc ? '올윈크롤 엑셀' : 'G마켓 가격 데이터'
  const gmarketFileHelp = isV2PriceCalc
    ? '올윈크롤 결과 (필수 컬럼: 모델명, 판매자, 정가, 할인율). 각 모델 최저가-10원으로 플토 판매가를 세팅합니다.'
    : '필수 컬럼: 모델명, 판매자, 정가, 할인율'

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
    fetchPriceCalcJobs()
    fetchArchivedPriceCalcJobs()
    fetchWorkerLogs()

    const interval = setInterval(() => {
      fetchJobs()
      fetchWorkerLogs()
      if (jobListTab === 'archived') {
        fetchArchivedJobs()
      }
      if (mainTab === 'price-calc') {
        fetchPriceCalcJobs()
        if (priceCalcJobListTab === 'archived') {
          fetchArchivedPriceCalcJobs()
        }
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [jobListTab, mainTab, priceCalcJobListTab])

  useEffect(() => {
    if (mainTab === 'crawling') {
      setPlayautoFile(null)
      setTemplateFile(null)
      setGmarketFile(null)
      setSlaveFile(null)
      setSelectedJobId('')
      setPriceCalcVersion('v2')
      setCalcResult(null)
      setCalcError(null)
      if (playautoInputRef.current) playautoInputRef.current.value = ''
      if (templateInputRef.current) templateInputRef.current.value = ''
      if (gmarketInputRef.current) gmarketInputRef.current.value = ''
      if (slaveInputRef.current) slaveInputRef.current.value = ''
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

  const fetchPriceCalcJobs = async () => {
    const res = await fetch('/api/price-calc-jobs?archived=false')
    if (res.ok) {
      const data = await res.json()
      setPriceCalcJobs(Array.isArray(data) ? data : [])
    }
  }

  const fetchArchivedPriceCalcJobs = async () => {
    const res = await fetch('/api/price-calc-jobs?archived=true')
    if (res.ok) {
      const data = await res.json()
      setArchivedPriceCalcJobs(Array.isArray(data) ? data : [])
    }
  }

  const fetchWorkerLogs = async () => {
    try {
      const res = await fetch('/api/worker-logs')
      if (!res.ok) return
      const data = await res.json()
      const logs = Array.isArray(data?.logs) ? (data.logs as WorkerLog[]) : []
      setWorkerLogs(logs)
    } catch {
      setWorkerLogs((prev) => prev)
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
      body: JSON.stringify({ models: modelList, marketplace }),
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

  const isValidExcelFile = (file: File) => /\.(xlsx|xls)$/i.test(file.name)

  // 드롭존 핸들러 팩토리: 4개 업로드 박스에서 재사용한다.
  // key=박스 식별자, setFile=해당 set함수, inputRef=동기화할 hidden input ref(있으면)
  const createDropHandlers = (
    key: string,
    setFile: (file: File | null) => void,
    inputRef?: React.RefObject<HTMLInputElement>
  ) => ({
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      if (dragActiveKey !== key) setDragActiveKey(key)
    },
    onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      // 자식 요소로 이동할 때의 깜빡임 방지: 박스 밖으로 나갈 때만 해제
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setDragActiveKey((prev) => (prev === key ? null : prev))
      }
    },
    onDrop: (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragActiveKey((prev) => (prev === key ? null : prev))
      const file = e.dataTransfer.files?.[0]
      if (!file) return
      if (!isValidExcelFile(file)) {
        setCalcError('엑셀 파일(.xlsx, .xls)만 첨부할 수 있습니다.')
        return
      }
      setCalcError(null)
      setFile(file)
      // hidden input과 상태 동기화 (드롭으로 받은 파일은 input.files에 직접 못 넣으므로 값만 비운다)
      if (inputRef?.current) inputRef.current.value = ''
    },
  })

  const handlePriceCalc = async (e: React.FormEvent) => {
    e.preventDefault()
    setCalcError(null)
    setCalcResult(null)

    if (!playautoFile) {
      setCalcError(isV2PriceCalc ? '플토 엑셀 파일을 선택해주세요.' : '플레이오토 엑셀 파일을 선택해주세요.')
      return
    }

    if (isV2PriceCalc && !gmarketFile) {
      setCalcError('올윈크롤 엑셀 파일을 업로드해주세요.')
      return
    }

    if (isV2PriceCalc && !slaveFile) {
      setCalcError('슬레이브 양식 엑셀 파일을 업로드해주세요.')
      return
    }

    if (!isV2PriceCalc && !templateFile) {
      setCalcError('템플릿 엑셀 파일을 선택해주세요.')
      return
    }

    if (!isV2PriceCalc && gmarketSource === 'job' && !selectedJobId) {
      setCalcError('크롤링 작업을 선택해주세요.')
      return
    }

    if (!isV2PriceCalc && gmarketSource === 'file' && !gmarketFile) {
      setCalcError('G마켓 엑셀 파일을 업로드해주세요.')
      return
    }

    setCalcLoading(true)

    try {
      const formData = new FormData()
      formData.append('version', priceCalcVersion)
      formData.append('playauto', playautoFile)
      if (isV2PriceCalc && gmarketFile) {
        formData.append('gmarket', gmarketFile)
      }
      if (isV2PriceCalc && slaveFile) {
        formData.append('slave', slaveFile)
      }
      if (!isV2PriceCalc && templateFile) {
        formData.append('template', templateFile)
      }
      if (!isV2PriceCalc && gmarketSource === 'job' && selectedJobId) {
        formData.append('jobId', selectedJobId)
      }
      if (!isV2PriceCalc && gmarketSource === 'file' && gmarketFile) {
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
      const vpsKept = parseInt(res.headers.get('X-VPS-Kept-Rows') || '0', 10)
      const vpsRemoved = parseInt(res.headers.get('X-VPS-Removed-Rows') || '0', 10)
      setCalcResult({ matched, unmatched, vpsKept, vpsRemoved })

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = getDownloadFileName(res, isV2PriceCalc)
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : '알 수 없는 오류')
    } finally {
      setCalcLoading(false)
      fetchPriceCalcJobs()
    }
  }

  const handleDeletePriceCalc = async (jobId: string) => {
    if (!confirm('이 계산 이력을 삭제하시겠습니까?')) return

    setPriceCalcActionLoading((prev) => ({ ...prev, [jobId]: 'delete' }))

    const res = await fetch(`/api/price-calc-jobs/${jobId}`, {
      method: 'DELETE',
    })

    if (res.ok) {
      setPriceCalcJobs((prev) => prev.filter((j) => j.id !== jobId))
      setArchivedPriceCalcJobs((prev) => prev.filter((j) => j.id !== jobId))
    } else {
      fetchPriceCalcJobs()
      fetchArchivedPriceCalcJobs()
    }

    setPriceCalcActionLoading((prev) => ({ ...prev, [jobId]: null }))
  }

  const handleArchivePriceCalc = async (jobId: string, archive: boolean) => {
    setPriceCalcActionLoading((prev) => ({ ...prev, [jobId]: 'archive' }))

    const res = await fetch(`/api/price-calc-jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: archive }),
    })

    if (res.ok) {
      if (archive) {
        const job = priceCalcJobs.find((j) => j.id === jobId)
        if (job) {
          setPriceCalcJobs((prev) => prev.filter((j) => j.id !== jobId))
          setArchivedPriceCalcJobs((prev) => [{ ...job, archived: true }, ...prev])
        }
      } else {
        const job = archivedPriceCalcJobs.find((j) => j.id === jobId)
        if (job) {
          setArchivedPriceCalcJobs((prev) => prev.filter((j) => j.id !== jobId))
          setPriceCalcJobs((prev) => [{ ...job, archived: false }, ...prev])
        }
      }
    } else {
      fetchPriceCalcJobs()
      fetchArchivedPriceCalcJobs()
    }

    setPriceCalcActionLoading((prev) => ({ ...prev, [jobId]: null }))
  }

  const completedJobs = jobs.filter((j) => j.status === 'completed')
  const currentJobs = jobListTab === 'active' ? jobs : archivedJobs
  const currentPriceCalcJobs = priceCalcJobListTab === 'active' ? priceCalcJobs : archivedPriceCalcJobs

  const queueJobs = jobs
    .filter((j) => ['pending', 'running'].includes(j.status))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-6">
          <div className="min-w-0">
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
                  <div className="space-y-2">
                    <Label>마켓 선택</Label>
                    <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit">
                      <button
                        type="button"
                        onClick={() => setMarketplace('gmarket')}
                        className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                          marketplace === 'gmarket'
                            ? 'bg-background shadow-sm font-medium'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        G마켓
                      </button>
                      <button
                        type="button"
                        disabled
                        title="쿠팡은 준비중입니다"
                        className="px-4 py-1.5 text-sm rounded-md flex items-center gap-1.5 text-muted-foreground/50 cursor-not-allowed"
                      >
                        쿠팡
                        <span className="text-[10px] leading-none px-1.5 py-0.5 rounded bg-muted-foreground/10 text-muted-foreground/70">
                          준비중
                        </span>
                      </button>
                    </div>
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
          <>
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>가격 계산</CardTitle>
              <CardDescription>
                플레이오토 상품 목록과 G마켓 가격을 기반으로 멀티채널 판매가를 자동 계산합니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handlePriceCalc} className="space-y-4">
                <div className="p-4 rounded-lg border bg-muted/20">
                  <Label className="text-base font-semibold">계산 엔진</Label>
                  <p className="text-xs text-muted-foreground mt-1 mb-3">
                    기존 호환이 필요한 경우 v1을 사용하세요. v2는 플토 + 올윈크롤 엑셀을 받아 각 모델의 크롤 최저가-10원으로 플토 판매가를 세팅하고 바코드를 VPS 형식으로 보정합니다.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPriceCalcVersion('v1')
                        setSlaveFile(null)
                        if (slaveInputRef.current) slaveInputRef.current.value = ''
                      }}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        priceCalcVersion === 'v1'
                          ? 'border-primary bg-background shadow-sm'
                          : 'bg-background/60 hover:bg-background'
                      }`}
                    >
                      <div className="font-medium">v1</div>
                      <div className="text-xs text-muted-foreground">기존 가격 계산</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPriceCalcVersion('v2')
                        setTemplateFile(null)
                        setSelectedJobId('')
                        setGmarketSource('file')
                        if (templateInputRef.current) templateInputRef.current.value = ''
                      }}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        priceCalcVersion === 'v2'
                          ? 'border-primary bg-background shadow-sm'
                          : 'bg-background/60 hover:bg-background'
                      }`}
                    >
                      <div className="font-medium">v2</div>
                      <div className="text-xs text-muted-foreground">플토 판매가를 올윈크롤 최저가로 세팅</div>
                    </button>
                  </div>
                </div>

                <div
                  {...createDropHandlers('playauto', setPlayautoFile, playautoInputRef)}
                  className={`p-4 rounded-lg border-2 transition-colors ${dragActiveKey === 'playauto' ? 'border-primary bg-primary/5 ring-2 ring-primary/30' : playautoFile ? 'border-green-500 bg-green-50/50' : 'border-dashed border-muted-foreground/25 bg-muted/30'}`}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${playautoFile ? 'bg-green-500 text-white' : 'bg-muted-foreground/20 text-muted-foreground'}`}>1</div>
                    <Label className="text-base font-semibold">{primaryFileLabel}</Label>
                    {playautoFile && <span className="text-green-600 text-sm">✓</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">{primaryFileHelp}</p>
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

                {isV2PriceCalc && (
                <div
                  {...createDropHandlers('gmarketV2', setGmarketFile, gmarketInputRef)}
                  className={`p-4 rounded-lg border-2 transition-colors ${dragActiveKey === 'gmarketV2' ? 'border-primary bg-primary/5 ring-2 ring-primary/30' : gmarketFile ? 'border-green-500 bg-green-50/50' : 'border-dashed border-muted-foreground/25 bg-muted/30'}`}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${gmarketFile ? 'bg-green-500 text-white' : 'bg-muted-foreground/20 text-muted-foreground'}`}>2</div>
                    <Label className="text-base font-semibold">{gmarketFileLabel}</Label>
                    {gmarketFile && <span className="text-green-600 text-sm">✓</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">{gmarketFileHelp}</p>
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
                )}

                {isV2PriceCalc && (
                <div
                  {...createDropHandlers('slave', setSlaveFile, slaveInputRef)}
                  className={`p-4 rounded-lg border-2 transition-colors ${dragActiveKey === 'slave' ? 'border-primary bg-primary/5 ring-2 ring-primary/30' : slaveFile ? 'border-green-500 bg-green-50/50' : 'border-dashed border-muted-foreground/25 bg-muted/30'}`}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${slaveFile ? 'bg-green-500 text-white' : 'bg-muted-foreground/20 text-muted-foreground'}`}>3</div>
                    <Label className="text-base font-semibold">슬레이브 양식 엑셀</Label>
                    {slaveFile && <span className="text-green-600 text-sm">✓</span>}
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">쇼핑몰계정 업로드 양식 (판매자관리코드, 쇼핑몰(계정), 온라인 상품명, 판매가, 바코드). 상품마다 계정 블록을 반복 채워 결과 ZIP에 포함됩니다.</p>
                  <input
                    ref={slaveInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => setSlaveFile(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 justify-start font-normal"
                      onClick={() => slaveInputRef.current?.click()}
                    >
                      {slaveFile ? slaveFile.name : '파일 선택...'}
                    </Button>
                    {slaveFile && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSlaveFile(null)
                          if (slaveInputRef.current) slaveInputRef.current.value = ''
                        }}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                </div>
                )}

                {!isV2PriceCalc && (
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
                    <div
                      {...createDropHandlers('gmarketV1', setGmarketFile, gmarketInputRef)}
                      className={`space-y-2 rounded-md p-2 -m-2 transition-colors ${dragActiveKey === 'gmarketV1' ? 'ring-2 ring-primary/40 bg-primary/5' : ''}`}
                    >
                      <p className="text-xs text-muted-foreground mb-2">
                        {gmarketFileHelp}
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
                )}

                {!isV2PriceCalc && (
                  <div
                    {...createDropHandlers('template', setTemplateFile, templateInputRef)}
                    className={`p-4 rounded-lg border-2 transition-colors ${dragActiveKey === 'template' ? 'border-primary bg-primary/5 ring-2 ring-primary/30' : templateFile ? 'border-green-500 bg-green-50/50' : 'border-dashed border-muted-foreground/25 bg-muted/30'}`}
                  >
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
                )}

                {calcError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                    {calcError}
                  </div>
                )}

                {calcResult && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-md text-green-700 text-sm space-y-1">
                    <div>ZIP 파일 다운로드 완료!</div>
                    <div>
                      {isV2PriceCalc
                        ? `- 판매가 갱신: ${calcResult.matched}개 / 미매칭: ${calcResult.unmatched}개`
                        : `- 가격 매칭: 매칭 ${calcResult.matched}개 / 미매칭 ${calcResult.unmatched}개`}
                    </div>
                    {isV2PriceCalc ? (
                      <div>- ZIP: 쇼핑몰상품 + 슬레이브양식 ({calcResult.vpsKept}개 상품)</div>
                    ) : (
                      <div>- VPS: {calcResult.vpsKept}행 유지 / {calcResult.vpsRemoved}행 제거</div>
                    )}
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={
                    calcLoading ||
                    !playautoFile ||
                    (isV2PriceCalc && !gmarketFile) ||
                    (isV2PriceCalc && !slaveFile) ||
                    (!isV2PriceCalc && !templateFile) ||
                    (!isV2PriceCalc && gmarketSource === 'job' && !selectedJobId) ||
                    (!isV2PriceCalc && gmarketSource === 'file' && !gmarketFile)
                  }
                  className="w-full"
                >
                  {calcLoading ? '계산 중...' : '가격 계산 및 다운로드'}
                </Button>
              </form>
            </CardContent>
          </Card>
          </>
        )}
          </div>

          <aside className="mt-6 lg:mt-0">
            <div className="lg:sticky lg:top-8 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">전체 큐 ({queueJobs.length})</CardTitle>
                  <CardDescription>워커 처리 순서</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 max-h-[600px] overflow-y-auto">
                  {queueJobs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">큐가 비어있습니다</p>
                  ) : (
                    queueJobs.map((job, idx) => {
                      const total = job.total_models || 0
                      const done = (job.completed_models || 0) + (job.failed_models || 0)
                      const progress = total > 0 ? Math.round((done / total) * 100) : 0
                      const isRunning = job.status === 'running'
                      return (
                        <div key={job.id} className="border rounded-lg p-3 text-sm">
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-semibold">#{idx + 1}</span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded ${
                                isRunning
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-gray-100 text-gray-600'
                              }`}
                            >
                              {isRunning ? '처리 중' : '대기'}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground mb-2 font-mono truncate">
                            {job.id.slice(0, 8)}
                          </div>
                          <Progress value={progress} className="mb-1 h-1.5" />
                          <div className="text-xs text-muted-foreground flex justify-between">
                            <span>
                              {done} / {total} ({progress}%)
                            </span>
                            {job.failed_models > 0 && (
                              <span className="text-red-500">실패 {job.failed_models}</span>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">워커 로그 ({workerLogs.length})</CardTitle>
                  <CardDescription>최근 활동</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 max-h-[320px] overflow-y-auto">
                  {workerLogs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">로그가 없습니다</p>
                  ) : (
                    workerLogs.map((log) => {
                      const style = LOG_LEVEL_STYLES[log.level] ?? LOG_LEVEL_STYLES.info
                      return (
                        <div
                          key={log.id}
                          className={`border-l-2 ${style.border} pl-2.5 py-1`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <span
                              className={`text-xs px-2 py-0.5 rounded font-medium ${style.pill}`}
                            >
                              {style.label}
                            </span>
                            <span className="text-xs text-muted-foreground font-mono shrink-0">
                              {formatLogTime(log.created_at)}
                            </span>
                          </div>
                          {log.model_name && (
                            <div className="text-xs text-muted-foreground font-mono truncate">
                              {log.model_name}
                            </div>
                          )}
                          <p className="text-xs leading-snug break-words line-clamp-2">
                            {log.message}
                          </p>
                        </div>
                      )
                    })
                  )}
                </CardContent>
              </Card>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}
