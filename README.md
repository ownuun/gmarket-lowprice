# G마켓 최저가 크롤러

삼촌을 위한 G마켓 최저가 검색 웹 서비스

## 아키텍처

```
[웹앱 (Vercel)] → [Supabase DB] ← [크롤러 워커 (iwinv VPS)]
                       ↓
                [엑셀 다운로드]
```

## 사용 방법

1. 웹앱 접속 → Google 로그인
2. 모델명 입력 (줄바꿈으로 구분)
3. "크롤링 시작" 클릭
4. 진행률 확인
5. 완료 후 엑셀 다운로드

---

## VPS 워커 관리 가이드

### 서버 접속

```bash
ssh -i ~/.ssh/iwinv_ed25519 root@115.68.231.137

# 또는 ~/.ssh/config 에 등록 시
ssh iwinv-gmarket
```

`~/.ssh/config` 등록 예시:

```sshconfig
Host iwinv-gmarket
    HostName 115.68.231.137
    User root
    IdentityFile ~/.ssh/iwinv_ed25519
    StrictHostKeyChecking no
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

### 워커 상태 확인

```bash
sudo systemctl status gmarket-worker
```

### 로그 확인

```bash
# 실시간 로그
sudo journalctl -u gmarket-worker -f

# 최근 100줄
sudo journalctl -u gmarket-worker -n 100
```

### 워커 제어

```bash
# 재시작
sudo systemctl restart gmarket-worker

# 중지
sudo systemctl stop gmarket-worker

# 시작
sudo systemctl start gmarket-worker
```

### 코드 업데이트

```bash
cd /root/gmarket-lowprice
git pull
pnpm build:worker
sudo systemctl restart gmarket-worker
```

---

## systemd 서비스 등록 (최초 1회)

```bash
sudo tee /etc/systemd/system/gmarket-worker.service << 'EOF'
[Unit]
Description=Gmarket Crawler Worker
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/gmarket-lowprice
ExecStart=/usr/bin/node /root/gmarket-lowprice/dist/worker.js
Restart=always
RestartSec=10
Environment=PATH=/usr/bin:/usr/local/bin
EnvironmentFile=/root/gmarket-lowprice/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable gmarket-worker
sudo systemctl start gmarket-worker
```

---

## 서버 정보

- **IP**: 115.68.231.137
- **User**: root
- **SSH Key**: `~/.ssh/iwinv_ed25519`
- **Provider**: iwinv (스마일서브)
- **Region**: KR1-Z02
- **사양**: vgna_2_n (2 vCPU / 2GB RAM / 50GB NVMe SSD)
- **비용**: 월 13,100원 (부가세 별도)
- **OS**: Ubuntu 24.04 LTS

> root 비밀번호는 SSH 키 인증으로 대체. `sshd_config` 에서 `PasswordAuthentication no` 권장.

### 마이그레이션 히스토리

- **2026-05-27**: Oracle Cloud (`158.179.163.193`, ap-chuncheon-1) → iwinv (`115.68.231.137`, KR1-Z02)
  - 원인: Oracle Cloud 콘솔 로그인 차단 + SSH 키 분실로 운영 접근 불가
  - 옛 서버 워커 상태 불명. Supabase 옛 service_role 키도 무효화하여 격리 예정

## 서비스 정보

- **웹앱**: Vercel
- **DB**: Supabase
- **크롤러(G마켓)**: iwinv VPS (Node 워커, Playwright)
- **쿠팡 검색**: CloakBrowser 사이드카 (같은 VPS, `127.0.0.1:8917`)

---

## 쿠팡 사이드카 서비스 (CloakBrowser)

쿠팡은 Akamai Bot Manager로 보호돼 일반 크롤(Playwright stealth / curl_cffi)이 전부 차단된다. 그래서 쿠팡 검색은 **CloakBrowser**(소스레벨 C++ 지문패치 스텔스 Chromium)를 구동하는 Python 사이드카가 담당한다. Node 워커는 `job.marketplace === 'coupang'`일 때만 이 로컬 HTTP 서비스(`GET /search?q=`)를 호출하고, G마켓 경로는 기존 그대로다.

> DB: 이 기능은 마이그레이션 `supabase/migrations/007_add_marketplace.sql`(jobs.marketplace 컬럼) 적용이 선행돼야 한다.

### 최초 설치 (VPS)

```bash
cd /root/gmarket-lowprice/coupang-service

# Python 3.11+ 가상환경 + 의존성
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt

# CloakBrowser 스텔스 Chromium 바이너리 다운로드 (최초 1회, 수백 MB)
.venv/bin/python -c "import cloakbrowser; cloakbrowser.ensure_binary()"

# 동작 점검 (root 헤드리스. '계양 그라인더' 검색)
COUPANG_HEADLESS=true COUPANG_NO_SANDBOX=true .venv/bin/python coupang_service.py &
sleep 15
curl -s "http://127.0.0.1:8917/search?q=%EA%B3%84%EC%96%91%20%EA%B7%B8%EB%9D%BC%EC%9D%B8%EB%8D%94" | head -c 300
# kill %1
```

### systemd 등록

```bash
cp /root/gmarket-lowprice/coupang-service/coupang-service.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable coupang-service
sudo systemctl start coupang-service
sudo systemctl status coupang-service
sudo journalctl -u coupang-service -f
```

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `COUPANG_HEADLESS` | `true` | 헤드리스 실행 (VPS 필수, headless로도 Akamai 통과 확인됨) |
| `COUPANG_NO_SANDBOX` | (off) | **root로 실행 시 `true` 필수** (Chromium은 root에서 샌드박스 불가) |
| `COUPANG_SERVICE_PORT` | `8917` | 서비스 포트 |
| `COUPANG_SERVICE_URL` (워커) | `http://127.0.0.1:8917` | 워커가 사이드카를 호출하는 주소 |

### 코드 업데이트

```bash
cd /root/gmarket-lowprice && git pull
pnpm build:worker && sudo systemctl restart gmarket-worker   # 워커
sudo systemctl restart coupang-service                       # 쿠팡 서비스 (의존성 변동 시 pip install 선행)
```

> ⚠️ CloakBrowser는 Python 래퍼(MIT) + 별도 라이선스의 Chromium 바이너리로 구성된다. 본 프로젝트는 **비상업적 사용** 기준으로 도입했다. 상업적/지속 사용 시 CloakBrowser 라이선스(github.com/CloakHQ/CloakBrowser) 확인 필요.
